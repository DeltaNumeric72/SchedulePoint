import { sql, type Kysely } from 'kysely';
import type { UnitOfWork } from '@schedulepoint/domain';

import type { Database } from '../db/schema.js';
import { recordBuildEvent, transitionRun, type BuildRunRow } from './service.js';

/**
 * **The reaper** — doc 08 §4.1 "Crash recovery: a reaper transitions stale
 * `running` builds (dead heartbeat) to `failed`".
 *
 * ## Why a dead build must be said to be dead
 *
 * A worker that is killed, whose host disappears, or whose process is OOM-ed
 * writes nothing. Without a reaper the build stays `running` for ever, D-4a
 * refuses every new build of that configuration because one is still in flight,
 * and the scheduler's only recourse is to ask an operator to edit a row. The
 * reaper is what makes "the build stopped" a state the system can reach on its
 * own.
 *
 * ## The honest reason is `crashed`, and it is attributed rather than reported
 *
 * FAD-34(2): a terminated worker writes nothing, so the parent attributes the
 * reason. A dead heartbeat means the worker stopped without saying why — which
 * is exactly `crashed`, and is deliberately NOT `deadline` (nothing timed out;
 * the wall clock may not even have been reached) and NOT `killed` (nobody is
 * known to have signalled it). Guessing the more specific word would be
 * inventing evidence.
 *
 * ## The reap advances the claim epoch, and that is the point
 *
 * The old worker may not be dead — it may be slow, or partitioned. Advancing the
 * epoch fences it: if it comes back with an answer, the fencing trigger refuses
 * the write and `assertClaimIsCurrent` records the refusal. Reaping without
 * advancing the epoch would leave the door open for exactly the stale overwrite
 * the epoch exists to prevent.
 */

type Uow = UnitOfWork<Kysely<Database>>;

export interface ReapedBuild {
  readonly buildRunId: string;
  readonly previousClaimEpoch: number;
  readonly claimEpoch: number;
}

/**
 * Reap every `running` build whose heartbeat is older than its own
 * configuration's window.
 *
 * The window is per configuration rather than global: a build configured for a
 * ten-second solve and one configured for ten minutes have different ideas of
 * what "silent for too long" means, and one global number would either reap
 * healthy long solves or leave dead short ones running for the length of the
 * longest configuration in the system.
 *
 * The rows are taken `FOR UPDATE SKIP LOCKED`, so two reapers running at once
 * divide the work instead of colliding — and neither waits on the other, which
 * matters because a reaper that blocks is a reaper that is not reaping.
 */
export async function reapStaleBuilds(uow: Uow, now: Date = new Date()): Promise<readonly ReapedBuild[]> {
  const stale = await uow.query
    .selectFrom('build_runs')
    .innerJoin(
      'build_configurations',
      'build_configurations.id',
      'build_runs.build_configuration_id',
    )
    .selectAll('build_runs')
    .where('build_runs.state', '=', 'running')
    .where('build_runs.heartbeat_at', 'is not', null)
    .where(
      /* `${now}::timestamptz` and not `${now}`: the parameter appears on the left
       * of a subtraction whose right operand is an `interval`, and PostgreSQL
       * infers the parameter's type from that context — as `interval`, which
       * then has no `<` against a `timestamptz`. The cast states the type the
       * value actually has instead of letting it be inferred from its
       * neighbour. */
      sql<boolean>`build_runs.heartbeat_at < ${now}::timestamptz - make_interval(secs => build_configurations.heartbeat_timeout_ms / 1000.0)`,
    )
    .forUpdate()
    .skipLocked()
    .execute();

  const reaped: ReapedBuild[] = [];

  for (const row of stale as unknown as BuildRunRow[]) {
    const previousClaimEpoch = row.claim_epoch;
    const nextEpoch = previousClaimEpoch + 1;

    /* The epoch advance and the release of the claim happen in the same
     * statement as nothing else, so a reader can never see a build that is
     * `failed` while still naming a live claimant. */
    const fenced = await uow.query
      .updateTable('build_runs')
      .set({
        claim_epoch: nextEpoch,
        claimed_by: null,
        claimed_at: null,
        heartbeat_at: null,
      })
      .where('id', '=', row.id)
      .where('claim_epoch', '=', previousClaimEpoch)
      .where('state', '=', 'running')
      .returningAll()
      .executeTakeFirst();

    if (fenced === undefined) continue;

    await recordBuildEvent(uow, {
      buildRunId: row.id,
      kind: 'heartbeat_reaped',
      claimEpoch: previousClaimEpoch,
      currentClaimEpoch: nextEpoch,
      reason: 'heartbeat_expired',
      actorMembershipId: null,
    });

    await transitionRun(uow, fenced as unknown as BuildRunRow, 'failed', {
      terminationReason: 'crashed',
      solverStatus: 'FAILED',
      reason: 'heartbeat_expired',
      finishedAt: now,
    });

    reaped.push({ buildRunId: row.id, previousClaimEpoch, claimEpoch: nextEpoch });
  }

  return reaped;
}
