import type pg from 'pg';

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

export interface DrainOptions {
  readonly worker: PgUnitOfWorkRunner;
  readonly admin: pg.Client;
  readonly label: string;
  readonly timeoutMs?: number;
}

/**
 * Empties the queue and returns how many jobs it held. Throws rather than
 * returning if it cannot — an unestablished precondition must be loud.
 */
export async function drainQueue(options: DrainOptions): Promise<number> {
  const { worker, admin, label } = options;
  const timeoutMs = options.timeoutMs ?? 45_000;

  const before = await queuedJobCount(admin);
  if (before === 0) return 0;

  const drainer = await startOutboxRunner({
    worker,
    sink: new DatabaseOutboxSink(worker),
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
      if ((await queuedJobCount(admin)) === 0) break;
      if (Date.now() > deadline) {
        throw new Error(
          `${label}: the queue still holds ${String(await queuedJobCount(admin))} job(s) after ` +
            `${String(timeoutMs)} ms — the precondition could not be established`,
        );
      }
      await new Promise((resolveTimer) => setTimeout(resolveTimer, 50));
    }
  } finally {
    await drainer.stop();
  }
  return before;
}
