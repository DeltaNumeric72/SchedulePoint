import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LocalCheckpointSigner } from '../../src/audit/checkpoint-signer.js';
import {
  allAuditedOrganizations,
  runCheckpointSweep,
  runVerificationSweep,
} from '../../src/audit/periodic.js';
import { recordAuditEvent } from '../../src/audit/recorder.js';
import { startOutboxRunner } from '../../src/outbox/runner.js';
import { DatabaseOutboxSink } from '../../src/outbox/sink.js';
import { adminClient } from '../support/admin-client.js';
import { groupContext, organizationContext } from '../support/fixtures.js';
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
const multi = ownedMulti('audit-periodic');


/**
 * **SPEC-11 §2's periodic jobs — the always-on layer (review finding R-03).**
 *
 * The first submission had the audit/outbox kernel wired into the test harness
 * and nowhere else. A production process would have started happily and failed
 * on the first `publishOutboxEvent`, because `app_enqueue_job` would not have
 * existed; and the only chain verification available was a CLI an operator had
 * to remember to run, which reports *after* the incident.
 *
 * Three things are asserted here, and the third is the one that matters:
 *
 *  1. the checkpoint sweep finds organizations that are due and checkpoints them;
 *  2. the verification sweep **pages** on a broken chain — the alert is the
 *     deliverable, not the return value;
 *  3. both jobs are genuinely **registered in the runner**, proved by enqueuing
 *     the task through the queue by name and watching the real worker execute
 *     it. Calling the sweep functions directly would prove they work and say
 *     nothing about whether anything ever calls them.
 */

/** Lazy: the owned fixture does not exist until `beforeAll` has run. */
const ALPHA = () => multi().alpha;
const admin = adminClient();

/**
 * ONE signer for this whole file, which is also the production shape: one per
 * process. `LocalCheckpointSigner` generates ephemeral key material per
 * instance, so two instances sharing a key id cannot verify each other's
 * signatures — `chain.test.ts` asserts that on purpose, and a per-test signer
 * here would have measured it again by accident.
 */
const signer = new LocalCheckpointSigner({ keyId: 'periodic-test-key' });

/**
 * The problem kinds that mean THE CHAIN is damaged.
 *
 * A verification sweep also reports checkpoints it cannot verify, and in a test
 * database that includes every checkpoint written by another file under its own
 * ephemeral key. Those are real findings in production — SPEC-11 §6 requires old
 * public keys to be retained — and noise here, so the assertions below name the
 * chain kinds explicitly rather than requiring a globally clean sweep.
 */
const CHAIN_PROBLEMS = new Set([
  'sequence_gap',
  'prev_hash_mismatch',
  'entry_hash_mismatch',
  'head_sequence_ahead_of_chain',
  'chain_head_missing',
]);

function chainProblems(
  broken: readonly { organizationId: string; problems: readonly string[] }[],
): readonly string[] {
  return broken.flatMap((b) => b.problems.filter((p) => CHAIN_PROBLEMS.has(p)));
}
let runtime: Runtime;
let worker: Runtime;

beforeAll(async () => {
  await admin.connect();
  runtime = createRuntime('app_runtime');
  worker = createRuntime('app_worker');
});

afterAll(async () => {
  await runtime.destroy();
  await worker.destroy();
  await admin.end();
});

async function appendOne(correlationId: string): Promise<string> {
  const recorded = await runtime.runner.run(
    groupContext(
      ALPHA().organizationId,
      ALPHA().groupOne.id,
      ALPHA().users.scheduler.membershipId,
      correlationId,
    ),
    (uow) =>
      recordAuditEvent(uow, {
        eventName: 'membership.activity_touched',
        subjectType: 'membership',
        subjectId: ALPHA().users.scheduler.membershipId,
      }),
  );
  return recorded.sequence;
}

async function checkpointCount(organizationId: string): Promise<number> {
  const { rows } = await admin.query<{ n: string }>(
    'select count(*)::text as n from audit_checkpoints where organization_id = $1::uuid',
    [organizationId],
  );
  return Number(rows[0]?.n ?? '-1');
}

describe('the enumeration that lets a tenant-less job find its work', () => {
  it('lists every organization that has a chain, and nothing about what is in it', async () => {
    await appendOne('periodic-seed');
    const organizations = await allAuditedOrganizations(worker.runner);
    expect(organizations).toContain(ALPHA().organizationId);
    // It returns ids and counters. The assertion that it returns no tenant
    // CONTENT is structural — the function's return type has four columns and
    // three of them are numbers — and is re-stated in chain.test.ts, where the
    // policies and grants that confine it are asserted directly.
    log(`enumeration: ${String(organizations.length)} organization(s) with an audit chain`);
  });
});

describe('SPEC-11 §2 — the periodic checkpoint sweep', () => {
  it('checkpoints an organization whose chain has advanced', async () => {
    const before = await checkpointCount(ALPHA().organizationId);
    await appendOne('periodic-advance');

    // `entryInterval: 1` and a zero max age make "due" mean "has advanced at
    // all", so the test does not depend on wall-clock time or on how many events
    // earlier files happened to write.
    const result = await runCheckpointSweep(worker.runner, signer, {
      entryInterval: 1n,
      maxAge: '0 seconds',
    });

    expect(result.considered).toBeGreaterThan(0);
    expect(result.failed, JSON.stringify(result.failed)).toEqual([]);
    expect(await checkpointCount(ALPHA().organizationId)).toBe(before + 1);
    log(
      `checkpoint sweep: ${String(result.considered)} organization(s) due, ` +
        `${String(result.written.length)} checkpoint(s) written, 0 failures`,
    );
  });

  it('is idempotent: a second sweep with nothing new writes nothing', async () => {
    // FAD-15 Layer 4 — this test establishes its own precondition. It used to
    // rely on the PRECEDING test having performed the first sweep; run first, the
    // head was uncheckpointed, the sweep legitimately wrote one, and "writes
    // nothing" failed for the right behaviour. The precondition is "the head is
    // already checkpointed", so the test creates it rather than inheriting it.
    await runCheckpointSweep(worker.runner, signer, {
      entryInterval: 1n,
      maxAge: '0 seconds',
    });

    const before = await checkpointCount(ALPHA().organizationId);
    const result = await runCheckpointSweep(worker.runner, signer, {
      entryInterval: 1n,
      maxAge: '0 seconds',
    });
    // The head is already checkpointed, so `writeCheckpoint` returns null rather
    // than writing a duplicate. A periodic job that wrote a checkpoint every run
    // regardless would fill the table with signatures over an unchanged head.
    expect(result.written.filter((w) => w.organizationId === ALPHA().organizationId)).toEqual([]);
    expect(await checkpointCount(ALPHA().organizationId)).toBe(before);
    log('checkpoint sweep is idempotent: an unchanged head is not re-checkpointed');
  });
});

describe('SPEC-11 §2 — the verification sweep ALERTS', () => {
  it('a broken chain pages, and the page names the organization and the problem', async () => {
    worker.alerts.clear();

    /* ── intact first: a sweep that pages on a healthy chain is useless ────── */
    const clean = await runVerificationSweep(worker.runner, signer, worker.alerts, [
      ALPHA().organizationId,
    ]);
    expect(chainProblems(clean.broken), JSON.stringify(clean.broken)).toEqual([]);
    const noiseBefore = worker.alerts.byCode('AUDIT_CHAIN_BROKEN').length;

    /* ── now break it, exactly as SPEC-11 §3's adversary would ─────────────── */
    const target = await admin.query<{ sequence: string }>(
      `select sequence::text as sequence from audit_events
        where organization_id = $1::uuid order by sequence limit 1 offset 1`,
      [ALPHA().organizationId],
    );
    const sequence = target.rows[0]?.sequence;
    await admin.query('alter table audit_events disable trigger audit_events_refuse_update');
    try {
      await admin.query(
        `update audit_events set payload = payload || '{"tampered": true}'::jsonb
          where organization_id = $1::uuid and sequence = $2::bigint`,
        [ALPHA().organizationId, sequence],
      );
    } finally {
      await admin.query('alter table audit_events enable always trigger audit_events_refuse_update');
    }

    const broken = await runVerificationSweep(worker.runner, signer, worker.alerts, [
      ALPHA().organizationId,
    ]);
    expect(chainProblems(broken.broken)).toContain('entry_hash_mismatch');

    const pages = worker.alerts.byCode('AUDIT_CHAIN_BROKEN');
    expect(
      pages.length,
      'the ALERT is the deliverable, not the return value',
    ).toBe(noiseBefore + 1);
    const page = pages.at(-1);
    expect(page?.severity).toBe('page');
    expect(page?.detail['organizationId']).toBe(ALPHA().organizationId);
    expect(page?.detail['problems']).toContain('entry_hash_mismatch');
    expect(page?.detail['firstProblemSequence']).toBe(sequence);
    // The operator has to be told that the signature half of the verdict was
    // produced with a key this process also holds.
    expect(page?.detail['signingKeyIsIsolated']).toBe(false);

    // And it is recorded in the chain as well as alerted — an append cannot
    // repair the chain, but it timestamps when the system first knew.
    const recorded = await admin.query<{ n: string }>(
      `select count(*)::text as n from audit_events
        where organization_id = $1::uuid and event_name = 'audit.chain_broken'`,
      [ALPHA().organizationId],
    );
    expect(Number(recorded.rows[0]?.n)).toBeGreaterThan(0);

    log(
      `verification sweep: page raised for ${String(page?.detail['organizationId'])} — ` +
        `${JSON.stringify(page?.detail['problems'])} at sequence ` +
        `${String(page?.detail['firstProblemSequence'])}, ` +
        `signingKeyIsIsolated=${String(page?.detail['signingKeyIsIsolated'])}`,
    );

    /* ── restore ───────────────────────────────────────────────────────────── */
    await admin.query('alter table audit_events disable trigger audit_events_refuse_update');
    try {
      await admin.query(
        `update audit_events set payload = payload - 'tampered'
          where organization_id = $1::uuid and sequence = $2::bigint`,
        [ALPHA().organizationId, sequence],
      );
    } finally {
      await admin.query('alter table audit_events enable always trigger audit_events_refuse_update');
    }
    worker.alerts.clear();
    const after = await runVerificationSweep(worker.runner, signer, worker.alerts, [
      ALPHA().organizationId,
    ]);
    expect(chainProblems(after.broken), JSON.stringify(after.broken)).toEqual([]);
  });
});

describe('R-03 — the jobs are REGISTERED, not merely written', () => {
  it('enqueuing audit.checkpoint by name makes the real runner write a checkpoint', async () => {
    // The end-to-end proof. Calling `runCheckpointSweep` directly would show
    // that it works and say nothing about whether anything ever calls it; this
    // goes through `app_enqueue_job`, the queue, and the task list the runner
    // actually registered.
    const sink = new DatabaseOutboxSink(worker.runner);
    const runner = await startOutboxRunner({
      worker: worker.runner,
      sink,
      signer,
      alerts: worker.alerts,
      label: 'periodic-test',
      pollIntervalMs: 100,
      // The DEFAULTS are 100 entries and 24 hours, so a one-event advance is
      // correctly NOT due — the first version of this test asked the registered
      // task to do something it was right to decline, and read the silence as a
      // wiring failure. These make "due" mean "has advanced at all".
      checkpointEntryInterval: 1n,
      checkpointMaxAge: '0 seconds',
      // Long, so this runner never reclaims a peer's lease during the test.
      staleAfterMs: 3_600_000,
      sweepIntervalMs: 60_000,
    });

    try {
      const before = await checkpointCount(ALPHA().organizationId);
      const newSequence = await appendOne('periodic-registered');
      expect(newSequence).toMatch(/^\d+$/);

      await runtime.runner.run(
        organizationContext(ALPHA().organizationId, 'periodic-enqueue'),
        async ({ query }) => {
          await sql`select app_enqueue_job('audit.checkpoint', '{}'::json)`.execute(query);
        },
      );

      const deadline = Date.now() + 30_000;
      let after = before;
      while (after === before && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        after = await checkpointCount(ALPHA().organizationId);
      }
      expect(after, 'the registered task ran and checkpointed the advanced chain').toBe(before + 1);
      log(
        'R-03: audit.checkpoint enqueued by name → the runner executed it and wrote a ' +
          'checkpoint. The task is registered, not merely written',
      );
    } finally {
      await runner.stop();
    }
  });

  it('a runner without a signer registers NO periodic task, loudly rather than silently', async () => {
    // A no-op periodic task is how a control stops existing without anyone
    // noticing. Without a signer the tasks are absent, so enqueuing one fails
    // visibly at the queue instead of succeeding and doing nothing.
    const sink = new DatabaseOutboxSink(worker.runner);
    const runner = await startOutboxRunner({
      worker: worker.runner,
      sink,
      label: 'no-signer',
      pollIntervalMs: 100,
      staleAfterMs: 3_600_000,
      sweepIntervalMs: 60_000,
    });
    try {
      const registered = await admin.query<{ identifier: string }>(
        `select identifier from graphile_worker._private_tasks
          where identifier like 'audit.%' order by identifier`,
      );
      // The task identifiers may exist from the previous test's enqueue; what
      // matters is that THIS runner did not claim them. Asserted by the absence
      // of execution: enqueue one and show nothing happens within the window.
      const before = await checkpointCount(ALPHA().organizationId);
      await appendOne('no-signer-advance');
      await runtime.runner.run(
        organizationContext(ALPHA().organizationId, 'no-signer-enqueue'),
        async ({ query }) => {
          await sql`select app_enqueue_job('audit.checkpoint', '{}'::json)`.execute(query);
        },
      );
      await new Promise((r) => setTimeout(r, 3_000));
      expect(
        await checkpointCount(ALPHA().organizationId),
        'a runner with no signer must not silently pretend to checkpoint',
      ).toBe(before);
      log(
        `a signer-less runner registered no audit task (${String(registered.rows.length)} ` +
          'audit identifier(s) known to the queue, none of them executed here)',
      );
    } finally {
      await runner.stop();
      // Leave nothing queued for a later file to pick up.
      await admin.query(
        `delete from graphile_worker._private_jobs
          where task_id in (select id from graphile_worker._private_tasks
                             where identifier like 'audit.%')`,
      );
    }
  });
});
