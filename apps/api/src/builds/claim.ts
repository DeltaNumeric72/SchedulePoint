import type { UnitOfWork } from '@schedulepoint/domain';
import type { Kysely } from 'kysely';

import type { Database } from '../db/schema.js';
import { BuildPreconditionError, BuildResultFencedError } from './errors.js';
import { loadRun, loadRunForUpdate, recordBuildEvent, type BuildRunRow } from './service.js';

/**
 * **Claim ownership and fencing** (doc 35 §6e Required behaviour 3).
 *
 * ## What a claim is
 *
 * A worker takes a `queued` build, moves it to `running`, and receives a
 * **claim epoch** — a number that increments on every claim and on every reap
 * and is never reset. The worker must present that number with its result.
 *
 * ## What fencing is for
 *
 * A worker that stalls, is reaped, restarts, or is simply slower than its own
 * heartbeat window can come back with an answer minutes after the build was
 * given to somebody else. Its answer is to a question that has been re-asked.
 * Writing it would silently replace a current result with a stale one, and the
 * two are indistinguishable by content — both are valid-looking schedules.
 *
 * So the epoch is the fence, and it is enforced in two places:
 *
 *  * **the database** — `app_guard_build_result_fencing` (migration 0018) is a
 *    `BEFORE INSERT` trigger on all three result-bearing tables and refuses any
 *    row whose epoch is not the run's current one. It binds every writer,
 *    including a psql session and the table owner;
 *  * **this module** — which checks first so that the refusal is a typed error a
 *    route can map, and so that the refusal is **RECORDED**: a
 *    `build_run_events` row of kind `result_refused` carrying both the presented
 *    epoch and the current one. A denial that leaves no trace makes a fenced
 *    worker look like a worker that never ran. The record is written in its own
 *    transaction by `recordFencedResult` — see that function for why, because
 *    the obvious arrangement is wrong and was measured wrong.
 *
 * The service check is deliberately removable without changing the outcome, and
 * `lifecycle.test.ts` proves exactly that by bypassing it entirely and showing
 * the database still refuses — which is what makes the trigger evidence rather
 * than decoration.
 */

type Uow = UnitOfWork<Kysely<Database>>;

export interface ClaimedBuild {
  readonly run: BuildRunRow;
  /** The number this claimant must present with its result. */
  readonly claimEpoch: number;
}

/**
 * A worker identity token.
 *
 * Generated rather than taken from a hostname or a process argument: it is
 * written into a tenant table and read back by a scheduler's screen, and a
 * hostname there would be an infrastructure detail leaking into a tenant's view.
 * The shape matches the column's CHECK.
 */
export function workerToken(prefix = 'worker'): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${prefix}.${String(process.pid)}.${suffix}`;
}

/**
 * **Atomically claim a queued build.**
 *
 * One statement, conditional on the state it read. Two claimants racing produce
 * one winner and one `null` — not because a lock was taken and released, but
 * because the second `UPDATE … WHERE state = 'queued'` matches no row. The
 * epoch advance is asserted by the database's transition guard as well
 * (`BUILD_CLAIM_EPOCH_NOT_ADVANCED`), so a claim that somehow did not advance it
 * is refused rather than silently sharing an epoch with its predecessor.
 */
export async function claimQueuedBuild(
  uow: Uow,
  buildRunId: string,
  claimedBy: string,
  now: Date = new Date(),
): Promise<ClaimedBuild | null> {
  const before = await loadRun(uow, buildRunId);
  if (before === null) {
    throw new BuildPreconditionError(
      'BUILD_RUN_NOT_FOUND',
      `no build run ${buildRunId} is visible in this group`,
    );
  }

  const claimed = await uow.query
    .updateTable('build_runs')
    .set({
      state: 'running',
      claim_epoch: before.claim_epoch + 1,
      claimed_by: claimedBy,
      claimed_at: now,
      heartbeat_at: now,
      started_at: now,
    })
    .where('id', '=', buildRunId)
    .where('state', '=', 'queued')
    .returningAll()
    .executeTakeFirst();

  if (claimed === undefined) return null;

  const run = claimed as unknown as BuildRunRow;
  await recordBuildEvent(uow, {
    buildRunId,
    kind: 'claim',
    fromState: 'queued',
    toState: 'running',
    claimEpoch: run.claim_epoch,
    reason: 'claimed',
    detail: { claimedBy },
  });
  /* The state change gets its own timeline row too, so a reader following
   * `kind = 'transition'` sees an unbroken chain and does not have to know that
   * one edge is spelled differently from the other fifteen. */
  await recordBuildEvent(uow, {
    buildRunId,
    kind: 'transition',
    fromState: 'queued',
    toState: 'running',
    claimEpoch: run.claim_epoch,
    reason: 'worker_claimed',
  });

  return { run, claimEpoch: run.claim_epoch };
}

/**
 * Move the heartbeat forward for a claim that is still the current one.
 *
 * Returns `false` when the claim has been fenced — which is how a worker
 * discovers it was reaped without having to be told. It does not throw: a
 * heartbeat is a poll, and a fenced poll is an answer rather than an error.
 */
export async function heartbeat(
  uow: Uow,
  buildRunId: string,
  claimEpoch: number,
  now: Date = new Date(),
): Promise<boolean> {
  const updated = await uow.query
    .updateTable('build_runs')
    .set({ heartbeat_at: now })
    .where('id', '=', buildRunId)
    .where('state', '=', 'running')
    .where('claim_epoch', '=', claimEpoch)
    .returning('id')
    .executeTakeFirst();
  return updated !== undefined;
}

/**
 * **The fence.** Refuse a result presented at a stale epoch.
 *
 * Called before any result row is written, and it does **not** record the
 * refusal — `recordFencedResult` does, in a transaction of its own.
 *
 * ## Why the recording is not in here, which is where it started
 *
 * It was, and the arm that asserts "the refusal is a ROW, not an absence"
 * FAILED: writing the event and then throwing puts both in one transaction, and
 * the throw rolls the transaction back. The row was written and then unwritten,
 * so the mechanism documented as durable evidence produced exactly nothing —
 * and the only reason anybody found out is that the test asked the database
 * afterwards instead of trusting the code that had just run.
 *
 * The recording is therefore a SEPARATE transaction, opened after the refusing
 * one has rolled back. `recordSolveOutcome` in `runner.ts` is the single caller
 * that sequences the two, so no result-writing path can take the fence without
 * also taking the record.
 */
export async function assertClaimIsCurrent(
  uow: Uow,
  buildRunId: string,
  presentedEpoch: number,
): Promise<BuildRunRow> {
  const run = await loadRunForUpdate(uow, buildRunId);
  if (run === null) {
    throw new BuildPreconditionError(
      'BUILD_RUN_NOT_FOUND',
      `no build run ${buildRunId} is visible in this group`,
    );
  }
  if (run.claim_epoch !== presentedEpoch || run.state !== 'running') {
    throw new BuildResultFencedError(presentedEpoch, run.claim_epoch);
  }
  return run;
}

export interface FencedResultRecord {
  readonly buildRunId: string;
  readonly presentedEpoch: number;
  readonly currentEpoch: number;
  readonly state: string;
}

/**
 * Write the durable record of a refused result.
 *
 * Runs in its own unit of work, opened AFTER the refusing one rolled back —
 * which is the whole point (see {@link assertClaimIsCurrent}). A fenced worker
 * is a visible fact, and a denial that leaves no trace makes one look like a
 * worker that never ran.
 */
export async function recordFencedResult(uow: Uow, record: FencedResultRecord): Promise<void> {
  await recordBuildEvent(uow, {
    buildRunId: record.buildRunId,
    kind: 'result_refused',
    claimEpoch: record.presentedEpoch,
    currentClaimEpoch: record.currentEpoch,
    reason:
      record.presentedEpoch === record.currentEpoch ? 'run_not_running' : 'stale_claim_epoch',
    detail: { state: record.state },
    actorMembershipId: null,
  });
}
