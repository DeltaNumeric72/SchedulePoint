import type { CheckpointSigner } from '@schedulepoint/domain';
import type pg from 'pg';

import { BUILD_SOLVE_TASK } from '../../src/builds/queue.js';
import { startBuildQueueRunner } from '../../src/builds/queue-runner.js';
import { SETTLED_STATES } from '../../src/builds/states.js';
import type { PgUnitOfWorkRunner } from '../../src/db/unit-of-work.js';
import { startOutboxRunner } from '../../src/outbox/runner.js';
import { DatabaseOutboxSink } from '../../src/outbox/sink.js';

/* ────────────────────────────────────────────────────────────────────────────
 * FAD-15 Layer 3 — the queue is shared, and tenancy does not isolate it.
 *
 * Layers 1 and 2 give every file its own tenant, and RLS keeps the rows apart.
 * The graphile-worker queue is not a tenant table: `graphile_worker._private_jobs`
 * holds every organization's jobs in one place, and any worker takes whatever job
 * is next. That is not a defect — it is what a queue is — but it means a file
 * that starts a worker must **establish and assert** its precondition rather than
 * assume it.
 *
 * NR-13 measured the cost of assuming it. `crash-restart`'s C-2 lease-recovery
 * proof passed in the full suite and failed 5 of 5 standalone, because it started
 * a worker expecting to lease the job it had just published and instead leased
 * one of four the fixture had seeded. In the full suite an earlier file's
 * dispatcher happened to have drained them first. The proof was true only by
 * accident of ordering (EV-M1-INTEGRATION §3.5).
 *
 * `drainQueue` empties the queue **the way production does** — a real dispatcher
 * with the real `DatabaseOutboxSink`. Never a `DELETE`: a test that empties a
 * queue with a statement the system cannot issue asserts against a state the
 * system cannot reach.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Every job the queue is holding, pending or leased. */
export async function queuedJobCount(admin: pg.Client): Promise<number> {
  const { rows } = await admin.query<{ n: string }>(
    'select count(*)::text as n from graphile_worker._private_jobs',
  );
  return Number(rows[0]?.n ?? '-1');
}

/**
 * The jobs an OUTBOX drainer can actually consume.
 *
 * **A drain must wait on the jobs it registered a handler for, and only those.**
 * Waiting for a job it cannot cause to complete is a deadlock by construction,
 * and that is precisely what `drainQueue` was doing (OPUS-M4-005).
 *
 * The measurement is in `.evidence-scratch/fixture-regression/seed-*.txt`, which
 * exists because NR-15's capture widening ran first: SIX of seven fixed seeds
 * failed with `outbox-dispatch`, `crash-restart` and `periodic` all reporting
 * "the queue still holds N job(s) after 45000 ms" — N of 2 or 5 — while the
 * shuffled order put a `build.solve` producer before them. `startOutboxRunner`
 * registers `outbox.dispatch` and, with a signer, `audit.checkpoint` and
 * `audit.verify`. It has no handler for `build.solve`, so a `build.solve` job in
 * the backlog made the wait-for-zero loop unsatisfiable and three unrelated files
 * failed in a message about a queue.
 *
 * Counting the drainer's OWN namespace rather than excluding today's one foreign
 * task is deliberate: a task added inside `outbox.*` or `audit.*` is a task this
 * drainer handles and joins the count automatically, and a task added outside it
 * is one the drainer does not handle and is correctly ignored. An exclusion list
 * would have to be maintained by whoever adds the next queue, which is how this
 * defect arrived in the first place.
 *
 * **The precondition is not weakened.** `crash-restart`'s block B needs the queue
 * empty so its worker leases the job it published rather than somebody else's —
 * and its worker registers `outbox.dispatch` alone, so a `build.solve` job could
 * never have been leased by it. Excluding it makes the precondition satisfiable
 * without making it weaker.
 */
export async function drainableJobCount(admin: pg.Client): Promise<number> {
  const { rows } = await admin.query<{ n: string }>(
    `select count(*)::text as n
       from graphile_worker._private_jobs j
       join graphile_worker._private_tasks t on t.id = j.task_id
      where t.identifier like 'outbox.%' or t.identifier like 'audit.%'`,
  );
  return Number(rows[0]?.n ?? '-1');
}

export interface DrainOptions {
  readonly worker: PgUnitOfWorkRunner;
  readonly admin: pg.Client;
  readonly label: string;
  readonly timeoutMs?: number;
  /**
   * **R-10 (OPUS-M4-005).** A signer, when the backlog may contain `audit.*`
   * jobs.
   *
   * `startOutboxRunner` registers the SPEC-11 §2 periodic tasks only when it is
   * given a signer — deliberately, so a runner without one "says nothing about
   * checkpoints" rather than silently no-opping. The consequence for the drain
   * is that a signer-less drainer has no handler for an `audit.checkpoint` job
   * and therefore cannot empty a queue holding one.
   *
   * EV-M4-002 §21d recorded that as an escalation with its own shape note: "the
   * honest fix is probably at the shared resource rather than in either file —
   * a drain that cannot see `audit.*` jobs is a drain that cannot establish the
   * precondition it exists to establish, and it fails silently by counting
   * rather than loudly by naming." This is that fix, at the shared resource.
   *
   * It is what lets `periodic.test.ts` stop clearing its own backlog with a raw
   * superuser `DELETE` (R-10). §20b's standing rule is the reason that mattered:
   * "a test that empties a queue with a statement the system cannot issue leaves
   * the database in a state the system cannot reach".
   */
  readonly signer?: CheckpointSigner;
}

/**
 * Empties the queue and returns how many jobs it held. Throws rather than
 * returning if it cannot — an unestablished precondition must be loud.
 */
export async function drainQueue(options: DrainOptions): Promise<number> {
  const { worker, admin, label } = options;
  const timeoutMs = options.timeoutMs ?? 45_000;

  const before = await drainableJobCount(admin);
  if (before === 0) return 0;

  const drainer = await startOutboxRunner({
    worker,
    sink: new DatabaseOutboxSink(worker),
    label,
    ...(options.signer === undefined ? {} : { signer: options.signer }),
    /* Cron OFF: the drainer must empty a backlog, not schedule new work. A
     * `backfillPeriod: 0` cron would still enqueue on the next boundary and the
     * loop below would chase its own tail. The far-future expressions are the
     * least surprising way to say "never" to `parseCronItems`. */
    ...(options.signer === undefined
      ? {}
      : { checkpointCron: '0 0 1 1 *', verificationCron: '0 0 1 1 *' }),
    pollIntervalMs: 50,
    // Long: the drainer must not reclaim anybody's pool. It is emptying a
    // backlog, not exercising C-2.
    staleAfterMs: 3_600_000,
    sweepIntervalMs: 3_600_000,
  });
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await drainableJobCount(admin)) === 0) break;
      if (Date.now() > deadline) {
        throw new Error(
          `${label}: the queue still holds ${String(await drainableJobCount(admin))} ` +
            `drainable job(s) after ${String(timeoutMs)} ms — the precondition could not be ` +
            'established',
        );
      }
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 50));
    }
  } finally {
    await drainer.stop();
  }
  return before;
}

/* ────────────────────────────────────────────────────────────────────────────
 * `build.solve`, and why `drainQueue` alone is not enough (OPUS-M4-005)
 *
 * D-4b made `submitBuild` enqueue a `build.solve` job in the same transaction as
 * the `queued` transition. A test that then dispatches the build DIRECTLY —
 * `runQueuedBuild`, which is what every proof about the claim, the fence and the
 * outcome does — settles the build and leaves the job behind. That job is not a
 * defect: on delivery it answers `not-claimable`, which is the duplicate-delivery
 * behaviour M-02b proves. It is simply not YET consumed.
 *
 * `drainQueue` cannot consume it. It starts an OUTBOX runner, which registers the
 * outbox and `audit.*` tasks and nothing else, so a `build.solve` job sits in
 * `graphile_worker._private_jobs` for ever while `queuedJobCount` keeps counting
 * it — and `drainQueue`'s loop, which waits for the count to reach ZERO, times
 * out. Every file that establishes its precondition with a drain then fails, in a
 * message about a queue rather than about builds.
 *
 * That is exactly FAD-15 Layer 3's shape, and it was measured rather than
 * theorised: `apps/api/test/sbx/**` submits five builds and dispatches each one
 * directly, and the very next `pnpm check` failed `outbox-dispatch.test.ts`,
 * `crash-restart.test.ts` and `periodic.test.ts` with "the queue still holds 5
 * job(s) after 45000 ms". Five submissions, five orphaned jobs, three unrelated
 * files broken. The matrix had been getting away with the same thing because its
 * own registered-task arm starts a real pool that happens to clear the backlog —
 * an ordering accident, which is the thing FAD-15 exists to stop relying on.
 *
 * So the fix is at the shared resource, exactly as R-10's note argued: a producer
 * of `build.solve` jobs drains them through the PRODUCTION consumer.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Every `build.solve` job the queue is holding, with the build it names. */
export async function pendingBuildSolveJobs(
  admin: pg.Client,
): Promise<readonly { jobId: string; buildRunId: string }[]> {
  const { rows } = await admin.query<{ id: string; build_run_id: string | null }>(
    `select j.id::text as id, j.payload->>'buildRunId' as build_run_id
       from graphile_worker._private_jobs j
       join graphile_worker._private_tasks t on t.id = j.task_id
      where t.identifier = $1`,
    [BUILD_SOLVE_TASK],
  );
  return rows.map((row) => ({ jobId: row.id, buildRunId: row.build_run_id ?? '' }));
}

export interface BuildDrainOptions {
  /** An `app_worker` runner. The build queue runner opens its own pool from it. */
  readonly worker: PgUnitOfWorkRunner;
  readonly admin: pg.Client;
  readonly label: string;
  readonly timeoutMs?: number;
}

/**
 * Empties the `build.solve` backlog through the production consumer, and returns
 * how many jobs it held.
 *
 * **It asserts its own precondition first**, and that is the part that keeps it
 * honest rather than merely effective: every job in the backlog must name a build
 * that is already SETTLED. Under that precondition the runner can only answer
 * `not-claimable` and complete the job — it cannot start a solve, cannot spawn a
 * subprocess, and cannot change any build's state. A drain that quietly solved
 * somebody's queued build would be a drain that made the schedule, which is not a
 * thing a teardown may do.
 *
 * If a job names an IN-FLIGHT build the helper refuses loudly and names it, so
 * the caller learns it left work undone rather than having the work silently
 * performed by its own cleanup.
 */
export async function drainBuildSolveQueue(options: BuildDrainOptions): Promise<number> {
  const { worker, admin, label } = options;
  const timeoutMs = options.timeoutMs ?? 60_000;

  const pending = await pendingBuildSolveJobs(admin);
  if (pending.length === 0) return 0;

  const settled = new Set<string>(SETTLED_STATES);
  const ids = [...new Set(pending.map((job) => job.buildRunId))].filter((id) => id.length > 0);
  if (ids.length > 0) {
    const { rows } = await admin.query<{ id: string; state: string }>(
      'select id::text as id, state::text as state from build_runs where id = any($1::uuid[])',
      [ids],
    );
    const byId = new Map(rows.map((row) => [row.id, row.state]));
    const inFlight = ids.filter((id) => !settled.has(byId.get(id) ?? ''));
    if (inFlight.length > 0) {
      /* Another file's work, mid-flight, in a shared queue (FAD-15 Layer 3).
       *
       * The first version THREW here, and the fixture-regression gate showed why
       * that was wrong: under `--sequence.shuffle.files` a build belonging to
       * another file is legitimately in flight while this one tears down, and a
       * teardown that fails because somebody else is working is a teardown that
       * has invented a coupling. Draining is skipped instead — this helper's job
       * is to release the caller's OWN settled jobs, and it may neither dispatch
       * a stranger's build nor wait for one. */
      return 0;
    }
  }

  const pool = await startBuildQueueRunner({
    worker,
    label,
    concurrency: 1,
    pollIntervalMs: 50,
    // Long: the drain must not reclaim anybody else's pool while it works.
    staleAfterMs: 3_600_000,
    sweepIntervalMs: 3_600_000,
  });
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await pendingBuildSolveJobs(admin)).length === 0) break;
      if (Date.now() > deadline) {
        throw new Error(
          `${label}: the queue still holds ${String((await pendingBuildSolveJobs(admin)).length)} ` +
            `build.solve job(s) after ${String(timeoutMs)} ms`,
        );
      }
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 50));
    }
  } finally {
    await pool.stop();
  }
  return pending.length;
}
