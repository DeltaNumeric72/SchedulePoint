import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LocalCheckpointSigner } from '../../src/audit/checkpoint-signer.js';
import { recordAuditEvent } from '../../src/audit/recorder.js';
import { dispatchOutboxEvent } from '../../src/outbox/dispatcher.js';
import { publishOutboxEvent } from '../../src/outbox/publisher.js';
import {
  AlwaysFailingSink,
  DatabaseOutboxSink,
  type OutboxSink,
} from '../../src/outbox/sink.js';
import { adminClient } from '../support/admin-client.js';
import { groupContext } from '../support/fixtures.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { drainableJobCount, drainQueue } from '../support/queue.js';

/**
 * FAD-15 Layer 2 — this file owns its tenant.
 *
 * It used to write to the shared MULTI baseline, which every other file also read.
 * NR-13 measured what that cost: six order-dependent tests across five files, and
 * eleven of twenty-four files modifying rows the shared seed created. The fixture
 * below has the same shape and fresh identifiers, and RLS — not agreement — is what
 * keeps it out of everybody else's queries.
 */
const multi = ownedMulti('audit-outbox-dispatch');


/**
 * The outbox: atomic with the domain change, at-least-once out of it, and
 * **I-11 — a delivery failure never rolls back the domain change.**
 *
 * ## The property SP-D measured, re-measured on the PRODUCTION path
 *
 * SP-D E-1 proved graphile-worker's `add_job` participates in the caller's
 * transaction, on a standalone harness with its own tables. That is evidence
 * about the library. These tests are evidence about **this system**: the same
 * property, through `publishOutboxEvent`, `app_enqueue_job`, the real unit of
 * work, real RLS, and the real audit chain. A spike verdict that is never
 * re-checked against the shipped wiring is a verdict about a different program.
 *
 * ## Nothing leaves the machine
 *
 * The sink is `DatabaseOutboxSink`: the effect is a row in `outbox_effects` and
 * nothing else. The last test asserts, by reading the source of every module the
 * dispatcher reaches, that there is no HTTP, SMTP or socket client anywhere in
 * that graph.
 *
 * The sink used to be an in-process array that also did the deduplication, and
 * that arrangement **was** the R-02 defect: a `Map` survives neither a restart
 * nor a second worker. Deduplication is now the effect table's primary key; the
 * arrays that remain on the sink are observation for tests and are never
 * consulted by `deliver`.
 */

/** Lazy: the owned fixture does not exist until `beforeAll` has run. */
const alpha = () => multi().alpha;
let runtime: Runtime;
let worker: Runtime;
let admin: pg.Client;

beforeAll(async () => {
  runtime = createRuntime('app_runtime');
  worker = createRuntime('app_worker');
  admin = adminClient();
  await admin.connect();
});

/**
 * FAD-40 — this file finalizes every job it enqueued, and says so.
 *
 * ## What it used to leave behind, and what that cost
 *
 * Every `mutateAndPublish` below enqueues a real `outbox.dispatch` job in the
 * same transaction — that is the property the first test measures. But the
 * dispatch tests then call `dispatchOutboxEvent` **directly**, so the queue rows
 * those publications created were never taken by any worker and never finalized.
 * Measured standalone: twenty rows left in `graphile_worker._private_jobs` at the
 * end of this file (eleven from the owned fixture's seeded events, nine from the
 * tests), including the I-11 arm's, whose sink is `AlwaysFailingSink`.
 *
 * The queue is not a tenant table (FAD-15 Layer 3), so that backlog is not this
 * file's private business: any later file that starts a worker inherits it.
 * `crash-restart.test.ts`'s block B has to empty the queue before it can start a
 * crash worker at all, and it pays for every job this file left behind.
 *
 * **What this hook does NOT fix, said plainly so nobody re-derives it:** the C-2
 * starvation at shuffle seed 123456 is *not* caused by these rows. It was
 * measured — an external poller on the harness cluster caught the surviving job
 * in the act — and it is an `audit.checkpoint` job left locked by a dead pool,
 * which `crash-restart`'s signer-less drainer can neither execute (the task is
 * not in its task list) nor reclaim (`staleAfterMs` is an hour). See
 * EV-M4-002 §21. This hook is worth doing on its own terms; it is not that cure.
 *
 * **What it DOES fix since FAD-53 R-6:** the first of those two reasons, for
 * THIS hook's own drain. It now carries a signer, so an unlocked `audit.*` job
 * in the shared backlog is executed rather than waited on for 45 seconds
 * (REV-B-002). The second reason — a job locked by a dead pool — is untouched
 * here and still belongs to `queue-pools.ts`'s release path (NR-19).
 *
 * ## Why a drain rather than a DELETE
 *
 * `global-setup.ts` already does exactly this for the baseline fixture, for
 * exactly this reason, and states the rule: *"no file inherits a backlog it did
 * not create"*. The same rule applies to a file that publishes twenty more.
 *
 * The finalization runs the **production** path — `startOutboxRunner` with the
 * real `DatabaseOutboxSink`, via `support/queue.ts`'s `drainQueue` — not a
 * `DELETE`. A test that empties a queue with a statement the system cannot issue
 * leaves the database in a state the system cannot reach, and the I-11 arm's job
 * in particular deserves the honest ending: production retries a failed delivery
 * against a working sink, and that is what happens here.
 *
 * **It takes nothing away from I-11.** That arm's assertions all run inside the
 * test, against the failing sink, before this hook exists: the domain row, the
 * audit row, the chain and `last_error_code=sink_unavailable` are measured there
 * and are untouched. This hook only finishes the delivery afterwards, which is
 * what the queue would have done anyway.
 */
afterAll(async () => {
  let failure: unknown;
  try {
    /* FAD-53 R-6 (REV-B-002). This hook establishes its own precondition: it
     * plants one `audit.checkpoint` job through the PRODUCTION producer and
     * then requires itself to drain it.
     *
     * ## Why the hook plants rather than a test
     *
     * Without an `audit.*` job in the backlog the drain below is never asked the
     * question REV-B-002 found it answering wrongly — a run whose queue happens
     * to hold only `outbox.*` jobs drains fine on either form of the call, which
     * is exactly why the seam appeared in ONE of the reviewers' five valid
     * composed runs and hid in the other four (REV-C t12's tabulation).
     *
     * The first shape of this repair had the last test in the file do the
     * planting. **The R-6 review reproduced what was wrong with that:** a
     * name-filtered run (`vitest run … -t "COMMIT"`) skips the planting test,
     * so the pre-assert failed, the drain never ran, and ~20 `outbox.*` jobs
     * leaked to the next file — a teardown failure that reads exactly like an
     * NR-15 regression and was caused by the regression itself. A teardown must
     * not depend on which tests a run selected. It plants for itself now, so
     * every run of this file — filtered, shuffled or whole — exercises the
     * drain against the shape the SHARED queue can present (FAD-15 Layer 3).
     *
     * Never an INSERT into graphile-worker's tables: `app_enqueue_job` under
     * real tenant context is the only producer this system has, and a fixture
     * the system could not have created is a fixture that proves nothing. */
    await runtime.runner.run(context('nr15-finalize-plant'), async ({ query }) => {
      await sql`select app_enqueue_job('audit.checkpoint', '{}'::json)`.execute(query);
    });
    const auditBacklog = await auditJobCount();
    expect(
      auditBacklog,
      'this hook must plant its own audit.* job — otherwise the drain below is never ' +
        'asked the question REV-B-002 found it answering wrongly',
    ).toBeGreaterThan(0);

    const drained = await drainQueue({
      worker: worker.runner,
      admin,
      label: 'outbox-dispatch-finalize',
      /* FAD-53 R-6 (REV-B-002) — the repair, taken from `DrainOptions.signer`'s
       * own R-10 docblock: "A signer, when the backlog may contain `audit.*`
       * jobs. … a signer-less drainer has no handler for an `audit.checkpoint`
       * job and therefore cannot empty a queue holding one."
       *
       * This drain waits on `drainableJobCount`, which counts `outbox.%` AND
       * `audit.%`, so its backlog MAY contain `audit.*` jobs — the queue is not
       * a tenant table (FAD-15 Layer 3) and any file's leftovers are in it. The
       * signer-less form was therefore asking for a state it had disabled its
       * own ability to reach, and the 45-second timeout was the only possible
       * outcome for a backlog holding one such job.
       *
       * Its own key id, not the default: `LocalCheckpointSigner` mints ephemeral
       * key material per instance, and two instances sharing the id
       * `local-dev-stub` would produce checkpoints that LOOK verifiable by each
       * other's key and are not. A distinct id makes a later verification sweep
       * decline on the honest ground (`chain.test.ts` measures that difference
       * deliberately).
       *
       * The sweep this enables runs on the DEFAULT thresholds — 100 entries,
       * 24 hours — because `drainQueue` passes no overrides. Those are the
       * production thresholds, so the executed job checkpoints only what is
       * genuinely due and stays a no-op for every other file's tenant, which is
       * the same argument `periodic.test.ts`'s finalization hook makes. Cron is
       * OFF inside `drainQueue`, so nothing new is scheduled. */
      signer: new LocalCheckpointSigner({ keyId: 'outbox-dispatch-finalize-key' }),
    });
    expect(
      await queuedJobs(),
      'this file must leave the queue empty — every job it enqueued is finalized',
    ).toBe(0);
    log(
      `finalized ${String(drained)} queued job(s) through the production dispatcher; ` +
        'the queue this file hands on is EMPTY',
    );
  } catch (error) {
    failure = error;
  }

  if (failure !== undefined) {
    // Name what survived. A drain that cannot finish is a diagnosis, and the
    // next reader should not have to reproduce it to get one.
    const stuck = await admin.query(
      `select j.id::text as id, t.identifier, j.attempts, j.max_attempts,
              j.run_at, j.locked_at, j.locked_by, j.last_error
         from graphile_worker._private_jobs j
         join graphile_worker._private_tasks t on t.id = j.task_id
        order by j.id`,
    );
    log(`UNFINALIZED JOBS (${String(stuck.rowCount ?? 0)}): ${JSON.stringify(stuck.rows)}`);
  }

  await runtime.destroy();
  await worker.destroy();
  await admin.end();

  if (failure !== undefined) throw failure;
});

function context(correlationId: string) {
  return groupContext(
    alpha().organizationId,
    alpha().groupOne.id,
    alpha().users.scheduler.membershipId,
    correlationId,
  );
}

/** The whole shape of a mutation: domain write → audit → outbox → enqueue. */
async function mutateAndPublish(correlationId: string, idempotencyKey: string) {
  return runtime.runner.run(context(correlationId), async (uow) => {
    await sql`
      update memberships set last_active_at = now()
       where id = ${alpha().users.scheduler.membershipId}::uuid
    `.execute(uow.query);
    const audit = await recordAuditEvent(uow, {
      eventName: 'membership.activity_touched',
      subjectType: 'membership',
      subjectId: alpha().users.scheduler.membershipId,
    });
    return publishOutboxEvent(uow, audit, {
      kind: 'membership.activity_touched',
      idempotencyKey,
    });
  });
}

async function outboxRow(id: string) {
  const { rows } = await admin.query<{
    state: string;
    attempts: number;
    job_id: string | null;
    audit_sequence: string;
    dispatched_at: Date | null;
    last_error_code: string | null;
  }>(
    `select state, attempts, job_id::text as job_id, audit_sequence::text as audit_sequence,
            dispatched_at, last_error_code
       from outbox_events where id = $1::uuid`,
    [id],
  );
  return rows[0];
}

/**
 * The jobs THIS FILE's drain can actually consume — not every job in the queue.
 *
 * ## NR-15's residual, diagnosed and repaired at the seam that produced it
 *
 * The drain was repaired (§14b) so that it waits on the namespaces it registered
 * a handler for — `outbox.*` and `audit.*` — because a `build.solve` job it has
 * no handler for made the loop unsatisfiable, a deadlock by construction.
 * **The assertion that follows the drain was NOT repaired with it**, and it
 * counted every row in `graphile_worker._private_jobs`. So under a shuffled file
 * order the drain correctly ignored a foreign job and the assertion correctly
 * counted it, and the file failed. Measured across the full seed set: five of
 * eight seeds, with `expected 23 to be 0` on seed 31337 — twenty-three foreign
 * jobs, none of them this file's.
 *
 * A drain and the assertion that it worked MUST use the same predicate. They now
 * do: `drainableJobCount` is the one definition, in `support/queue.ts`, and a
 * task added inside the namespace joins it automatically.
 *
 * `queuedJobCount` in `support/queue.ts` still counts EVERYTHING and is
 * deliberately left alone — "how many jobs exist" is a real question, it is just
 * not the question a drain's postcondition asks.
 */
async function queuedJobs(): Promise<number> {
  return drainableJobCount(admin);
}

/**
 * The `audit.*` half of that same predicate, counted on its own.
 *
 * `drainableJobCount` counts `outbox.%` OR `audit.%` in one number, and one
 * number cannot say which half is present. REV-B-002 is a defect about the
 * `audit.%` half specifically, so the regression below and the `afterAll`
 * precondition both need to see it separately.
 */
async function auditJobCount(): Promise<number> {
  const { rows } = await admin.query<{ n: string }>(
    `select count(*)::text as n
       from graphile_worker._private_jobs j
       join graphile_worker._private_tasks t on t.id = j.task_id
      where t.identifier like 'audit.%'`,
  );
  return Number(rows[0]?.n ?? '-1');
}

describe('the outbox write is atomic with the domain change', () => {
  it('COMMIT → domain row, audit row, outbox row and queue job all exist', async () => {
    const before = await queuedJobs();
    const published = await mutateAndPublish('outbox-commit', 'outbox-commit-key');

    const row = await outboxRow(published.id);
    expect(row?.state).toBe('pending');
    expect(row?.job_id, 'the queue job id is captured in the same transaction').not.toBeNull();
    expect(row?.audit_sequence).toBe(published.auditSequence);
    expect(await queuedJobs()).toBe(before + 1);
    log(
      `commit → outbox ${published.id} linked to audit sequence ${published.auditSequence}, ` +
        `queue job ${String(published.jobId)}`,
    );
  });

  it('ROLLBACK → no domain change, no audit row, no outbox row and NO QUEUE JOB', async () => {
    const before = await queuedJobs();
    const correlationId = 'outbox-rollback';

    await expect(
      runtime.runner.run(context(correlationId), async (uow) => {
        const audit = await recordAuditEvent(uow, {
          eventName: 'membership.activity_touched',
          subjectType: 'membership',
          subjectId: alpha().users.scheduler.membershipId,
        });
        const published = await publishOutboxEvent(uow, audit, {
          kind: 'membership.activity_touched',
          idempotencyKey: 'outbox-rollback-key',
        });
        // A real job id, allocated on THIS connection — so the rollback below is
        // undoing a real row rather than congratulating itself on a no-op.
        //
        // The id is the only available proof from inside this transaction, and
        // that is SP-D condition C-1 working rather than a gap in the test:
        // `app_runtime` holds no grant and no policy on the queue tables, so it
        // CANNOT read `_private_jobs` even to count. Reading it here would
        // require widening exactly the grant the design withholds. The
        // out-of-band count before and after this transaction is the other half.
        expect(published.jobId).toMatch(/^\d+$/);

        throw new Error('the mutation turned out to be invalid (synthetic)');
      }),
    ).rejects.toThrow('synthetic');

    expect(await queuedJobs(), 'the enqueue rolled back with the transaction').toBe(before);
    const audits = await admin.query<{ n: string }>(
      'select count(*)::text as n from audit_events where correlation_id = $1',
      [correlationId],
    );
    expect(Number(audits.rows[0]?.n)).toBe(0);
    const outbox = await admin.query<{ n: string }>(
      'select count(*)::text as n from outbox_events where idempotency_key = $1',
      ['outbox-rollback-key'],
    );
    expect(Number(outbox.rows[0]?.n)).toBe(0);
    log('rollback → 0 audit rows, 0 outbox rows, 0 queue jobs (the outbox property, in situ)');
  });

  it('a duplicate idempotency key is refused at the database', async () => {
    await mutateAndPublish('outbox-dupe-1', 'outbox-dupe-key');
    await expect(mutateAndPublish('outbox-dupe-2', 'outbox-dupe-key')).rejects.toMatchObject({
      code: '23505',
    });
    log('a repeated idempotency key raises 23505 — a duplicate publication is impossible');
  });
});

describe('dispatch', () => {
  it('delivers once, marks the row, and audits the dispatch', async () => {
    const sink = new DatabaseOutboxSink(worker.runner);
    const published = await mutateAndPublish('outbox-dispatch-1', 'outbox-dispatch-key-1');

    const outcome = await dispatchOutboxEvent(worker.runner, sink, {
      organizationId: alpha().organizationId,
      outboxEventId: published.id,
    });
    expect(outcome.status).toBe('delivered');
    expect(sink.deliveries).toHaveLength(1);

    const row = await outboxRow(published.id);
    expect(row?.state).toBe('dispatched');
    expect(row?.dispatched_at).not.toBeNull();
    expect(row?.attempts).toBe(1);

    const audited = await admin.query<{ n: string }>(
      `select count(*)::text as n from audit_events
        where event_name = 'outbox.dispatched' and subject_id = $1::uuid`,
      [published.id],
    );
    expect(Number(audited.rows[0]?.n)).toBe(1);
    log('dispatch → delivered once, row marked, one outbox.dispatched audit event');
  });

  it('AT-LEAST-ONCE: a redelivery is suppressed by the idempotency key, not by luck', async () => {
    const sink = new DatabaseOutboxSink(worker.runner);
    const published = await mutateAndPublish('outbox-dispatch-2', 'outbox-dispatch-key-2');
    const job = {
      organizationId: alpha().organizationId,
      outboxEventId: published.id,
    };

    const first = await dispatchOutboxEvent(worker.runner, sink, job);
    // The second call is what a lease expiry produces (SP-D E-3.2 measured a
    // crashed job re-running and applying its effect a second time). Here the
    // row is already `dispatched`, so the dispatcher short-circuits — and the
    // third call below bypasses that short-circuit to prove the SINK also holds.
    const second = await dispatchOutboxEvent(worker.runner, sink, job);

    expect(first.status).toBe('delivered');
    expect(second.status).toBe('already_dispatched');
    expect(sink.deliveries, 'the sink saw exactly one delivery').toHaveLength(1);

    // Belt and braces: hand the sink the same key again, bypassing the outbox
    // state entirely. The DURABLE primary key must refuse it — the short-circuit
    // above is only as good as the transaction that wrote the state.
    const accepted = await sink.deliver({
      organizationId: alpha().organizationId,
      groupId: alpha().groupOne.id,
      outboxEventId: published.id,
      kind: 'membership.activity_touched',
      idempotencyKey: 'outbox-dispatch-key-2',
      correlationId: 'outbox-dispatch-2',
      attempt: 3,
    });
    expect(accepted, 'the sink deduplicates independently of the outbox state').toBe(false);
    expect(sink.suppressed).toHaveLength(1);

    const effects = await admin.query<{ n: string }>(
      'select count(*)::text as n from outbox_effects where idempotency_key = $1',
      ['outbox-dispatch-key-2'],
    );
    expect(Number(effects.rows[0]?.n), 'exactly one durable effect row').toBe(1);
    log(
      'redelivery: outbox CAS (already_dispatched) AND a durable primary-key refusal, ' +
        'independently — one row in outbox_effects',
    );
  });

  it('a job for an outbox row that does not exist delivers nothing', async () => {
    const sink = new DatabaseOutboxSink(worker.runner);
    const outcome = await dispatchOutboxEvent(worker.runner, sink, {
      organizationId: alpha().organizationId,
      outboxEventId: '00000000-0000-4000-8000-000000000000',
    });
    expect(outcome.status).toBe('missing');
    expect(sink.deliveries).toHaveLength(0);
  });
});

describe('I-11 — a delivery failure NEVER rolls back the domain change', () => {
  it('the domain row, the audit row and the outbox row all survive a failing sink', async () => {
    const sink = new AlwaysFailingSink();
    const correlationId = 'outbox-i11';
    const published = await mutateAndPublish(correlationId, 'outbox-i11-key');

    const beforeTouch = await admin.query<{ last_active_at: Date | null }>(
      'select last_active_at from memberships where id = $1::uuid',
      [alpha().users.scheduler.membershipId],
    );
    const committedTouch = beforeTouch.rows[0]?.last_active_at;
    expect(committedTouch, 'the domain change committed').not.toBeNull();

    const outcome = await dispatchOutboxEvent(worker.runner, sink, {
      organizationId: alpha().organizationId,
      outboxEventId: published.id,
    });
    expect(outcome.status).toBe('failed');
    expect(sink.attempts).toHaveLength(1);

    /* ── the domain change is untouched ─────────────────────────────────────── */
    const afterTouch = await admin.query<{ last_active_at: Date | null }>(
      'select last_active_at from memberships where id = $1::uuid',
      [alpha().users.scheduler.membershipId],
    );
    expect(afterTouch.rows[0]?.last_active_at?.toISOString()).toBe(
      committedTouch?.toISOString(),
    );

    /* ── the audit row is untouched, and the failure is itself audited ──────── */
    const original = await admin.query<{ n: string }>(
      'select count(*)::text as n from audit_events where correlation_id = $1',
      [correlationId],
    );
    expect(
      Number(original.rows[0]?.n),
      'the original audit event plus the audited failure',
    ).toBe(2);

    /* ── the outbox row records the failure, as a CODE ──────────────────────── */
    const row = await outboxRow(published.id);
    expect(row?.state).toBe('failed');
    expect(row?.attempts).toBe(1);
    expect(row?.last_error_code).toBe('sink_unavailable');
    expect(row?.dispatched_at).toBeNull();
    log(
      'I-11: a failing sink left the domain row, the audit row and the chain intact; ' +
        `the outbox row records last_error_code=${String(row?.last_error_code)}`,
    );

    // The queue job this publication created is still outstanding, and it is
    // this file's to finish (FAD-40). It is finalized in `afterAll`, through the
    // production dispatcher against a working sink — after every assertion above
    // has been made against the failing one.
  });

  it('the recorded failure is a CODE and cannot be an exception message', async () => {
    // The column CHECK is the control, not the discipline of whoever writes the
    // next dispatcher. Rule 9: an exception message is the commonest way a
    // payload body or a recipient address reaches a database column.
    //
    // FAD-15 Layer 4 — this test owns its subject, and the reason is sharper than
    // order-independence. It used to UPDATE the row the PRECEDING test published.
    // Run first, that UPDATE matched ZERO rows and therefore SUCCEEDED, so the
    // `.rejects` assertion failed for a reason unrelated to the CHECK — and in the
    // mirror case an absent row would have made it unable to fail at all. This is
    // the reference instance of the vacuity class (EV-M2-NR13).
    const key = 'outbox-i11-code-check-key';
    await mutateAndPublish('outbox-i11-code-check', key);

    // The positive control comes FIRST and asserts the row exists. Without it the
    // rejection below is indistinguishable from an UPDATE that matched nothing.
    const accepted = await admin.query(
      'update outbox_events set last_error_code = $1 where idempotency_key = $2',
      ['sink_unavailable', key],
    );
    expect(
      accepted.rowCount,
      'the subject row does not exist, so the CHECK is never reached and this test is vacuous',
    ).toBe(1);

    await expect(
      admin.query(
        `update outbox_events set last_error_code = $1 where idempotency_key = $2`,
        ['Error: connect ECONNREFUSED 10.0.0.1:587', key],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    log('last_error_code accepts a code and rejects an exception message (SQLSTATE 23514)');
  });
});

describe('nothing leaves the machine', () => {
  it('no module the dispatcher reaches imports an outbound-network client', () => {
    // A static read of the source, rather than a runtime assertion, because the
    // absence of a network call is not observable at runtime without making one.
    const here = dirname(fileURLToPath(import.meta.url));
    const modules = [
      'outbox/dispatcher.ts',
      'outbox/publisher.ts',
      'outbox/sink.ts',
      'audit/recorder.ts',
    ].map((file) => resolve(here, '../../src', file));

    const forbidden =
      /\b(?:from\s+['"](?:node:)?(?:https?|net|tls|dgram|nodemailer|undici|axios|got|node-fetch)['"]|\bfetch\s*\(|XMLHttpRequest|WebSocket)/;

    for (const path of modules) {
      const source = readFileSync(path, 'utf8');
      // Strip comments, so a doc block that *mentions* SMTP does not fail the
      // gate it is describing.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//'))
        .join('\n');
      expect(forbidden.test(code), `${path} reaches an outbound-network client`).toBe(false);
    }
    log(`${String(modules.length)} dispatch-path modules: no outbound-network import`);
  });
});

describe('R-02 — the two windows in which the same event was delivered twice', () => {
  it('TWO CONCURRENT DISPATCHERS: one effect, one audit event, one delivery', async () => {
    // The reviewer's scenario. Two dispatchers, same event, started together —
    // no sleeps, no staggering, so the interleaving is whatever the database
    // gives us rather than one this test arranged to be safe.
    const sinkA = new DatabaseOutboxSink(worker.runner);
    const sinkB = new DatabaseOutboxSink(worker.runner);
    const published = await mutateAndPublish('outbox-race', 'outbox-race-key');
    const job = { organizationId: alpha().organizationId, outboxEventId: published.id };

    const [a, b] = await Promise.all([
      dispatchOutboxEvent(worker.runner, sinkA, job),
      dispatchOutboxEvent(worker.runner, sinkB, job),
    ]);

    const outcomes = [a.status, b.status].sort();
    // Whichever way the race lands, exactly one of them delivered. The loser
    // either never claimed the row (`already_dispatched`) or claimed it and
    // found the effect already applied (`suppressed_duplicate`).
    expect(
      outcomes.filter((s) => s === 'delivered'),
      `outcomes were ${outcomes.join(' + ')}`,
    ).toHaveLength(1);

    const effects = await admin.query<{ n: string }>(
      'select count(*)::text as n from outbox_effects where idempotency_key = $1',
      ['outbox-race-key'],
    );
    expect(Number(effects.rows[0]?.n), 'EXACTLY ONE durable effect').toBe(1);

    const audited = await admin.query<{ n: string }>(
      `select count(*)::text as n from audit_events
        where event_name = 'outbox.dispatched' and subject_id = $1::uuid`,
      [published.id],
    );
    expect(Number(audited.rows[0]?.n), 'the mark CAS means only one dispatcher audits').toBe(1);

    const row = await outboxRow(published.id);
    expect(row?.state).toBe('dispatched');
    log(
      `R-02(a): two concurrent dispatchers → outcomes [${outcomes.join(', ')}], ` +
        '1 effect row, 1 outbox.dispatched audit event',
    );
  });

  it('CRASH AFTER THE EFFECT, before the dispatched mark: the replacement does NOT re-apply', async () => {
    // The second measured window. A dispatcher applies its effect and then dies
    // before marking the outbox row — so the row is left claimed, the queue will
    // retry, and nothing in the outbox state says the effect already happened.
    // The in-process Map could not survive this; the primary key does.
    const published = await mutateAndPublish('outbox-crash-after', 'outbox-crash-after-key');
    const job = { organizationId: alpha().organizationId, outboxEventId: published.id };

    // A sink that applies the real effect and then throws, standing in for a
    // process that dies at exactly that point. The effect is committed in the
    // sink's own transaction, so it survives; the mark never happens.
    const realSink = new DatabaseOutboxSink(worker.runner);
    const crashingSink: OutboxSink = {
      deliver: async (delivery) => {
        await realSink.deliver(delivery);
        throw new Error('SINK_UNAVAILABLE: killed after the effect, before the mark (synthetic)');
      },
    };

    const first = await dispatchOutboxEvent(worker.runner, crashingSink, job);
    expect(first.status).toBe('failed');

    const applied = await admin.query<{ n: string; attempt: number }>(
      'select count(*)::text as n, min(attempt) as attempt from outbox_effects where idempotency_key = $1',
      ['outbox-crash-after-key'],
    );
    expect(Number(applied.rows[0]?.n), 'the effect DID happen before the crash').toBe(1);
    const firstAttempt = applied.rows[0]?.attempt;

    /* ── the replacement, exactly as graphile-worker's retry would run it ──── */
    const replacementSink = new DatabaseOutboxSink(worker.runner);
    const second = await dispatchOutboxEvent(worker.runner, replacementSink, job);

    expect(second.status, 'it re-ran, and the effect was already there').toBe(
      'suppressed_duplicate',
    );
    expect(replacementSink.deliveries, 'the replacement applied nothing').toHaveLength(0);
    expect(replacementSink.suppressed).toHaveLength(1);

    const afterEffects = await admin.query<{ n: string; attempt: number }>(
      'select count(*)::text as n, min(attempt) as attempt from outbox_effects where idempotency_key = $1',
      ['outbox-crash-after-key'],
    );
    expect(Number(afterEffects.rows[0]?.n), 'still EXACTLY ONE effect').toBe(1);
    expect(
      afterEffects.rows[0]?.attempt,
      'and it is the original one — the row was not rewritten by the retry',
    ).toBe(firstAttempt);

    const row = await outboxRow(published.id);
    expect(row?.state, 'the retry finished the bookkeeping the crash left undone').toBe(
      'dispatched',
    );
    expect(row?.attempts, 'two claims: the one that died and the one that finished').toBe(2);
    log(
      `R-02(b): effect applied on attempt ${String(firstAttempt)}, dispatcher died before the ` +
        'mark; the replacement re-ran, was suppressed by the primary key, applied nothing, and ' +
        'completed the bookkeeping',
    );
  });

  it('the effect row itself is append-only — a suppressed duplicate cannot overwrite it', async () => {
    // The suppression is only as good as the row's permanence.
    //
    // FAD-15 Layer 4 — this test owns its subject. It used to target the effect
    // row the PRECEDING test produced; run first, both statements matched zero
    // rows and SUCCEEDED, so the `.rejects` assertions failed for a reason that
    // had nothing to do with the append-only rule.
    const key = 'outbox-append-only-key';
    const published = await mutateAndPublish('outbox-append-only', key);
    const outcome = await dispatchOutboxEvent(worker.runner, new DatabaseOutboxSink(worker.runner), {
      organizationId: alpha().organizationId,
      outboxEventId: published.id,
    });
    expect(outcome.status, 'the effect was never applied, so there is nothing to protect').toBe(
      'delivered',
    );

    const present = await admin.query<{ n: string }>(
      'select count(*)::text as n from outbox_effects where idempotency_key = $1',
      [key],
    );
    expect(
      present.rows[0]?.n,
      'no effect row exists, so UPDATE and DELETE would match nothing and pass vacuously',
    ).toBe('1');

    await expect(
      admin.query('update outbox_effects set attempt = attempt + 1 where idempotency_key = $1', [
        key,
      ]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      admin.query('delete from outbox_effects where idempotency_key = $1', [key]),
    ).rejects.toMatchObject({ code: '23001' });
    log('outbox_effects: UPDATE and DELETE both refused (23001)');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * REV-B-002 / FAD-53 R-6 — the finalization hook must drain the whole predicate
 * it asserts against, `audit.%` included.
 *
 * ## The defect, as measured rather than reasoned about
 *
 * The 2026-08-23 internal review ran `corepack pnpm check` on the baseline tree
 * and this file's `afterAll` failed with the NR-15 message verbatim:
 *
 * ```
 * Error: outbox-dispatch-finalize: the queue still holds 336 drainable job(s)
 *        after 45000 ms — the precondition could not be established
 * ```
 *
 * All twelve tests passed; the hook is what failed. The seam ITSELF is neither
 * timing nor machine speed. `drainableJobCount` counts `outbox.%` **and** `audit.%`,
 * and `startOutboxRunner` registers the `audit.*` tasks **only when it is given
 * a signer** — `support/queue.ts`'s R-10 docblock states it and states why: "a
 * signer-less drainer has no handler for an `audit.checkpoint` job and therefore
 * cannot empty a queue holding one". The call in the hook above passed no
 * signer, so ONE `audit.*` job anywhere in the shared backlog made that loop
 * unsatisfiable for its full 45 seconds, whatever the hardware.
 *
 * **What is NOT settled, so nobody reads more into this than it proves:** that
 * the missing handler is what ended REV-B's particular run. The mechanism above
 * predicts a remainder equal to the number of UNHANDLEABLE jobs — this repair's
 * own reproduction left exactly 1 — and REV-B's remainder was 336. Nor does
 * throughput fit: the two measurements are 629 jobs in 23.5 s (R-6's composed
 * run, ~27/s) and 257 jobs inside a file whose whole duration was 5,675 ms
 * (the R-6 review's, ≥45/s), and at EITHER rate 45 s clears far more than 336,
 * so a 336 remainder would need a starting backlog of roughly 1,550–2,700 —
 * several times the largest backlog anyone has measured. A third shape fits the
 * arithmetic better and is not repaired here: jobs LOCKED by dead worker pools.
 * `drainableJobCount` counts locked rows, and `drainQueue` sets `staleAfterMs`
 * to an hour precisely so it never reclaims them — the EV-M4-002 §21 / NR-19
 * shape named further up this file. The missing handler is proven to be *a*
 * cause, on demand, and is repaired; the cause of REV-B's 336 is UNESTABLISHED,
 * and the candidates are carried in RISK-REGISTER's NR-15 re-opening. Whatever
 * settles it, the answer is never a longer cap.
 *
 * ## Where the regression lives, and the division of labour with the hook
 *
 * The queue is not a tenant table (FAD-15 Layer 3), so whether the backlog holds
 * an `audit.*` job at this file's teardown is decided by the file order — which
 * is why the failure showed up once in the reviewers' five valid composed runs
 * and why runs on the same tree disagreed. A regression that waits for that
 * coincidence is a regression that measures the shuffle.
 *
 * So the coincidence is removed, and it is removed **in the `afterAll` hook
 * itself** rather than here (R-6 review condition C-4). The hook plants its own
 * `audit.checkpoint` job through the production producer immediately before it
 * drains, so it is self-sufficient: a run that selects no test in this file —
 * `vitest run … -t "COMMIT"` is the case the reviewer reproduced — still
 * exercises the drain against an `audit.*` backlog, still finalizes the
 * `outbox.*` jobs its selected tests published, and still leaves the queue
 * empty. Deleting this test therefore cannot make the hook's proof vacuous; it
 * cannot even make the hook quiet.
 *
 * What THIS test is for is the other half — that the producer path used by the
 * hook is real: `app_enqueue_job`, under real tenant context, never a
 * hand-written INSERT into graphile-worker's tables, and that the job it creates
 * joins BOTH `auditJobCount` and `drainableJobCount`. If that stopped being
 * true the hook would be planting nothing and asserting against a number that
 * never moved. It plants its own job for that measurement, which the hook then
 * finalizes along with its own.
 *
 * On the signer-less form of the drain either plant is enough to time the hook
 * out and fail this FILE; with the signer both are executed.
 *
 * **It weakens nothing.** No timeout is raised, no predicate narrowed, no
 * assertion softened, and the jobs are EXECUTED by a real runner rather than
 * deleted — the drain stays the production path (§20b's standing rule). It is
 * strictly more for the hook to finalize and one more thing it is required to
 * prove it can do.
 * ──────────────────────────────────────────────────────────────────────────── */
describe('REV-B-002 — the finalization hook can drain an audit.* job, not only outbox.*', () => {
  it('an audit.checkpoint job enqueued through app_enqueue_job joins the DRAINABLE count', async () => {
    const auditBefore = await auditJobCount();
    const drainableBefore = await queuedJobs();

    await runtime.runner.run(context('nr15-audit-backlog'), async ({ query }) => {
      await sql`select app_enqueue_job('audit.checkpoint', '{}'::json)`.execute(query);
    });

    expect(
      await auditJobCount(),
      'the production producer enqueued exactly one audit.checkpoint job',
    ).toBe(auditBefore + 1);
    expect(
      await queuedJobs(),
      "and `drainableJobCount` counts it — the drain's postcondition includes audit.%, " +
        'so the drain itself must be able to execute it',
    ).toBe(drainableBefore + 1);

    log(
      'REV-B-002: the production producer enqueues an audit.checkpoint job that joins both ' +
        'counts — the shape the finalization hook plants for itself and must execute',
    );
  });
});
