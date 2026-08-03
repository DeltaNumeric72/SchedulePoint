import { type ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';

import { sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { recordAuditEvent } from '../../src/audit/recorder.js';
import { verifyAuditChain } from '../../src/audit/verification.js';
import { publishOutboxEvent } from '../../src/outbox/publisher.js';
import { startOutboxRunner } from '../../src/outbox/runner.js';
import { DatabaseOutboxSink } from '../../src/outbox/sink.js';
import { adminClient } from '../support/admin-client.js';
import { API_ROOT } from '../support/env.js';
import { FIXTURE, groupContext, organizationContext } from '../support/fixtures.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';

/**
 * **Chain integrity and lease recovery across a real crash.**
 *
 * The packet asks for the chain to be verified "across a crash/restart (kill the
 * process mid-batch; verify chain integrity + lease recovery on restart)". Both
 * halves are here, and both use a real child process and a real `SIGKILL` —
 * an in-process test would only ever prove that a promise was abandoned.
 *
 * ## What each half is actually asking
 *
 * **A. Chain integrity.** A process killed between two commits must leave a
 * chain that is intact and gapless up to the last commit it reported — no
 * half-written row, no consumed-but-unused sequence, no dangling head. The
 * interesting failure would be a chain head maintained outside the transaction:
 * it would advance for the interrupted append and never come back, and every
 * later verification would alarm.
 *
 * **B. Lease recovery.** SP-D measured graphile-worker's lease at **four hours**,
 * hard-coded (E-2.3), and measured that a *graceful* shutdown does not release
 * the in-flight job either (E-2.4). Condition C-2 is the mitigation. This test
 * is the mitigation working on the production path, with **no clock
 * manipulation**: a real worker dies holding a real job, and a replacement
 * recovers it in seconds by way of `queue_pools`.
 */

const alpha = FIXTURE.alpha;
const CHILD = resolve(API_ROOT, 'test/support/audit-crash-child.ts');

let runtime: Runtime;
let worker: Runtime;
let admin: pg.Client;
const children: ChildProcess[] = [];

beforeAll(async () => {
  runtime = createRuntime('app_runtime');
  worker = createRuntime('app_worker');
  admin = adminClient();
  await admin.connect();
});

afterAll(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await runtime.destroy();
  await worker.destroy();
  await admin.end();
});

interface ChildHandle {
  readonly proc: ChildProcess;
  readonly lines: Record<string, unknown>[];
  readonly stderr: () => string;
  waitFor(event: string, count?: number, timeoutMs?: number): Promise<Record<string, unknown>[]>;
  kill(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function startChild(mode: 'append' | 'hold', env: Record<string, string>): ChildHandle {
  const proc = spawn(process.execPath, ['--import', 'tsx', CHILD], {
    cwd: API_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SPIKE_MODE: mode, ...env },
  });
  children.push(proc);

  const lines: Record<string, unknown>[] = [];
  const errors: string[] = [];
  let buffer = '';
  proc.stdout?.setEncoding('utf8');
  proc.stdout?.on('data', (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      try {
        lines.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        errors.push(raw);
      }
    }
  });
  proc.stderr?.setEncoding('utf8');
  proc.stderr?.on('data', (chunk: string) => errors.push(chunk));

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => {
    proc.on('exit', (code, signal) => { res({ code, signal }); });
  });

  return {
    proc,
    lines,
    stderr: () => errors.join(''),
    async waitFor(event, count = 1, timeoutMs = 45_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const matched = lines.filter((l) => l['event'] === event);
        if (matched.length >= count) return matched;
        if (proc.exitCode !== null || proc.signalCode !== null) {
          throw new Error(
            `child exited before ${String(count)}×"${event}": ` +
              `code=${String(proc.exitCode)} signal=${String(proc.signalCode)}\n${errors.join('')}`,
          );
        }
        if (Date.now() > deadline) {
          throw new Error(
            `timed out waiting for ${String(count)}×"${event}"; saw ` +
              `${String(lines.length)} line(s)\n${errors.join('')}`,
          );
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    async kill() {
      proc.kill('SIGKILL');
      return exit;
    },
  };
}

describe('A — the chain survives a process killed mid-batch', () => {
  it('is intact and gapless up to the last commit the dying process reported', async () => {
    const correlationId = 'crash-append';
    const child = startChild('append', {
      SPIKE_ORGANIZATION_ID: alpha.organizationId,
      SPIKE_GROUP_ID: alpha.groupOne.id,
      SPIKE_MEMBERSHIP_ID: alpha.users.scheduler.membershipId,
      SPIKE_CORRELATION_ID: correlationId,
    });

    await child.waitFor('ready');
    const committed = await child.waitFor('committed', 8);
    const exit = await child.kill();
    expect(exit.signal, 'the process must have died by signal, not gracefully').toBe('SIGKILL');

    const lastReported = Number(committed.at(-1)?.['sequence']);
    expect(Number.isFinite(lastReported)).toBe(true);

    const verification = await runtime.runner.run(
      organizationContext(alpha.organizationId, 'crash-verify-a'),
      (uow) => verifyAuditChain(uow),
    );
    expect(verification.intact, JSON.stringify(verification.problems)).toBe(true);

    // Every sequence the child REPORTED is durably present. Anything after it
    // may or may not have committed before the kill — that race is real and the
    // assertion does not pretend otherwise; what matters is that the chain has
    // no gap and no dangling head either way.
    const head = Number(verification.headSequence);
    expect(head).toBeGreaterThanOrEqual(lastReported);
    expect(head - lastReported, 'at most the one append that was in flight').toBeLessThanOrEqual(1);

    const rows = await admin.query<{ n: string; distinct: string; max: string; min: string }>(
      `select count(*)::text as n, count(distinct sequence)::text as distinct,
              max(sequence)::text as max, min(sequence)::text as min
         from audit_events where organization_id = $1::uuid`,
      [alpha.organizationId],
    );
    const row = rows.rows[0];
    expect(row?.n, 'no duplicate sequence').toBe(row?.distinct);
    expect(
      Number(row?.max) - Number(row?.min) + 1,
      'gapless: the count equals the span',
    ).toBe(Number(row?.n));

    log(
      `A: killed after ${String(committed.length)} reported commits (last sequence ` +
        `${String(lastReported)}); chain intact, head ${String(head)}, ` +
        `${String(row?.n)} rows spanning ${String(row?.min)}..${String(row?.max)} with no gap`,
    );
  });

  it('the interrupted process left no half-written row and no consumed sequence', async () => {
    // Belt and braces on the head table: the tip must equal the highest row in
    // the chain. A head that ran ahead would mean the chain head was maintained
    // outside the transaction, and every later append would leave a permanent
    // gap.
    const { rows } = await admin.query<{ head: string; top: string }>(
      `select h.sequence::text as head,
              (select max(sequence)::text from audit_events e
                where e.organization_id = h.organization_id) as top
         from audit_chain_heads h where h.organization_id = $1::uuid`,
      [alpha.organizationId],
    );
    expect(rows[0]?.head).toBe(rows[0]?.top);
    log(`audit_chain_heads tip (${String(rows[0]?.head)}) equals the highest chain row`);
  });
});

/** Every job the queue is holding, pending or leased. */
async function queuedJobCount(): Promise<number> {
  const { rows } = await admin.query<{ n: string }>(
    'select count(*)::text as n from graphile_worker._private_jobs',
  );
  return Number(rows[0]?.n ?? '-1');
}

/**
 * Empties the queue, so block B starts from a queue it fully controls.
 *
 * ## Why this exists (OPUS-M1-004 — an order dependence, measured)
 *
 * Block B publishes one outbox event and then starts a real worker that takes
 * **whatever job is next** and dies holding it. Every assertion afterwards is
 * about `published.jobId`. That is only the job the worker took if the queue was
 * empty when it started — and the test never said so, never checked, and for a
 * long time was right by accident.
 *
 * It stopped being right by accident when OPUS-M1-004's fixture began seeding
 * `outbox_events` in both organizations (four jobs, needed so the wrong-tenant
 * probe over that table is not vacuous). In the FULL suite an earlier file's
 * dispatcher drained them first and the test passed; run alone, the crash worker
 * took a fixture job, `published.jobId` was never leased, and the assertion
 * reported `locked_by = null` — **the exact shape of the four-hour problem it
 * exists to disprove.** Measured 5/5 in isolation, 0/5 in the full suite.
 *
 * A proof that depends on an unstated precondition is not a proof of the
 * property. So the precondition is now stated, established here, and asserted:
 * the drain below is what an earlier file used to do by luck, and
 * `expect(delivering.outboxEventId).toBe(published.id)` is the assertion that
 * makes a future backlog fail loudly and specifically instead of silently
 * measuring the wrong job.
 *
 * Draining is done the way production does it — a real dispatcher with the real
 * `DatabaseOutboxSink` — not by deleting rows. A test that emptied the queue with
 * a DELETE would be asserting against a state the system cannot reach.
 */
async function drainQueue(label: string, timeoutMs = 45_000): Promise<number> {
  const before = await queuedJobCount();
  if (before === 0) return 0;

  const drainer = await startOutboxRunner({
    worker: worker.runner,
    sink: new DatabaseOutboxSink(worker.runner),
    label,
    pollIntervalMs: 50,
    // Long: the drainer must not reclaim anybody's pool. It is emptying a
    // backlog, not exercising C-2.
    staleAfterMs: 3_600_000,
    sweepIntervalMs: 3_600_000,
  });
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await queuedJobCount()) === 0) break;
      if (Date.now() > deadline) {
        throw new Error(
          `the queue still holds ${String(await queuedJobCount())} job(s) after ${String(timeoutMs)} ms; ` +
            'block B cannot establish its precondition',
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    await drainer.stop();
  }
  return before;
}

describe('B — lease recovery on restart (SP-D condition C-2, no clock manipulation)', () => {
  it('a replacement worker reclaims a dead pool\'s job and completes it in seconds', async () => {
    /* ── the precondition, established rather than assumed ────────────────── */
    const drained = await drainQueue('crash-lease-drain');
    expect(
      await queuedJobCount(),
      'the queue must be empty before the crash worker starts, or it takes the wrong job',
    ).toBe(0);
    log(
      `B precondition: drained ${String(drained)} pre-existing job(s); the queue is empty and ` +
        'the crash worker can only take the job this test publishes',
    );

    /* ── publish something for the dead worker to pick up ─────────────────── */
    const published = await runtime.runner.run(
      groupContext(
        alpha.organizationId,
        alpha.groupOne.id,
        alpha.users.scheduler.membershipId,
        'crash-lease',
      ),
      async (uow) => {
        await sql`
          update memberships set last_active_at = now()
           where id = ${alpha.users.scheduler.membershipId}::uuid
        `.execute(uow.query);
        const audit = await recordAuditEvent(uow, {
          eventName: 'membership.activity_touched',
          subjectType: 'membership',
          subjectId: alpha.users.scheduler.membershipId,
        });
        return publishOutboxEvent(uow, audit, {
          kind: 'membership.activity_touched',
          idempotencyKey: 'crash-lease-key',
        });
      },
    );

    /* ── a real worker takes it and dies holding it ───────────────────────── */
    const child = startChild('hold', {});
    const [ready] = await child.waitFor('ready');
    const deadPoolId = String(ready?.['poolId']);
    expect(deadPoolId).toMatch(/^pool-/);
    const [delivering] = await child.waitFor('delivering');
    expect(
      delivering?.['outboxEventId'],
      'the crash worker took a DIFFERENT outbox event than the one this test published — the ' +
        'queue was not empty when it started, and every assertion below would be about the ' +
        'wrong job. This is the order dependence, not the four-hour problem',
    ).toBe(published.id);

    const exit = await child.kill();
    expect(exit.signal).toBe('SIGKILL');

    const stranded = await admin.query<{ locked_by: string | null }>(
      'select locked_by from graphile_worker._private_jobs where id = $1::bigint',
      [published.jobId],
    );
    expect(
      stranded.rows[0]?.locked_by,
      'the dead worker left its lease on the job — this is the four-hour problem',
    ).toBe(deadPoolId);

    const registered = await admin.query<{ released_at: Date | null }>(
      'select released_at from queue_pools where pool_id = $1',
      [deadPoolId],
    );
    expect(registered.rows[0], 'the registry saw the pool').toBeDefined();
    expect(registered.rows[0]?.released_at, 'and it never released').toBeNull();

    /* ── the replacement, with a short staleness window ───────────────────── */
    const sink = new DatabaseOutboxSink(worker.runner);
    const t0 = Date.now();
    const replacement = await startOutboxRunner({
      worker: worker.runner,
      sink,
      label: 'replacement',
      pollIntervalMs: 100,
      staleAfterMs: 500,
      sweepIntervalMs: 250,
    });
    try {
      const deadline = Date.now() + 45_000;
      while (sink.deliveries.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const elapsed = Date.now() - t0;
      expect(sink.deliveries, 'the stranded job was re-executed').toHaveLength(1);
      expect(sink.deliveries[0]?.idempotencyKey).toBe('crash-lease-key');

      const released = await admin.query<{ released_at: Date | null }>(
        'select released_at from queue_pools where pool_id = $1',
        [deadPoolId],
      );
      expect(released.rows[0]?.released_at, 'the reclaim marks the dead pool released').not.toBeNull();

      log(
        `B: a worker killed while holding job ${String(published.jobId)} (pool ${deadPoolId}); ` +
          `a replacement reclaimed and completed it in ${String(elapsed)} ms of real time, ` +
          'against an unmitigated 4-hour lease. No clock was manipulated',
      );

      /* ── and the chain is still intact across the whole episode ─────────── */
      const verification = await worker.runner.run(
        organizationContext(alpha.organizationId, 'crash-verify-b'),
        (uow) => verifyAuditChain(uow),
      );
      expect(verification.intact, JSON.stringify(verification.problems)).toBe(true);
      log(
        `chain verified across the crash and the restart: ${String(verification.entries)} ` +
          `entries, head ${String(verification.headSequence)}, 0 problems`,
      );
    } finally {
      await replacement.stop();
    }
  });

  it('the effect was applied EXACTLY ONCE despite the crash and the re-execution', async () => {
    const { rows } = await admin.query<{ state: string; attempts: number }>(
      'select state, attempts from outbox_events where idempotency_key = $1',
      ['crash-lease-key'],
    );
    expect(rows[0]?.state).toBe('dispatched');
    // TWO claims: the first worker claimed the row and died holding it, and the
    // replacement claimed it again. The attempt counter says so honestly rather
    // than pretending the crash did not happen — and `outbox_effects` still
    // holds exactly one row. At-least-once at the queue, exactly-once at the
    // effect, which is the only combination available (SP-D C-4).
    expect(rows[0]?.attempts, 'the crashed claim is counted, not hidden').toBe(2);

    const effects = await admin.query<{ n: string; attempt: number }>(
      'select count(*)::text as n, min(attempt) as attempt from outbox_effects where idempotency_key = $1',
      ['crash-lease-key'],
    );
    expect(Number(effects.rows[0]?.n), 'exactly one durable effect row').toBe(1);
    log(
      'the effect was applied exactly once: outbox state=dispatched, attempts=2 (one crashed ' +
        `claim + one that finished), and 1 row in outbox_effects from attempt ` +
        `${String(effects.rows[0]?.attempt)}`,
    );
  });
});
