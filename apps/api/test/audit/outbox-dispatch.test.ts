import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

afterAll(async () => {
  await runtime.destroy();
  await worker.destroy();
  await admin.end();
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

async function queuedJobs(): Promise<number> {
  const { rows } = await admin.query<{ n: string }>(
    'select count(*)::text as n from graphile_worker._private_jobs',
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
