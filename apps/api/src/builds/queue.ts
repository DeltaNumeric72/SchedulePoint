import type { UnitOfWork } from '@schedulepoint/domain';
import { sql, type Kysely } from 'kysely';

import type { Database } from '../db/schema.js';

/**
 * **D-4b's queue binding, the producer half** — build dispatch leaves the API
 * process (doc 35 §6g ruling 2; SPEC-04 §1.1).
 *
 * The consumer half is `builds/queue-runner.ts`. They are two files because the
 * consumer imports `runner.ts` and `runner.ts` imports this one: one module
 * would be an import cycle, and an import cycle between the thing that enqueues
 * a solve and the thing that performs it is the kind that survives review and
 * then breaks under a bundler.
 *
 * ## What moved, and what deliberately did not
 *
 * Before this module, `POST /builds/runs/:id/run` claimed the build, spawned the
 * solver subprocess, waited for it, and wrote the result — **inside the HTTP
 * request**. M4-003 recorded that honestly ("the dispatch runs in the API
 * process… binding the runner to a scheduling-worker queue is M4-005's"), and
 * it is exactly what SPEC-04 §1.1 means by "degrading the web tier": a ninety
 * second solve is a ninety second request, and a web process restarted during
 * one leaves a `running` build nobody is running.
 *
 * Now `submitBuild` enqueues a `build.solve` job in the same transaction that
 * moves the run to `queued`, and a worker process claims and solves it.
 *
 * **Nothing about the lifecycle changed.** The claim, the epoch, the fence, the
 * reaper, the validation gate, the honest outcome vocabulary — every one of them
 * is M4-003's code, called from a different process. That is the point, and it
 * is why `concurrency-recovery-matrix.test.ts` re-proves each of them against
 * the queued path rather than trusting that a change of caller changed nothing.
 *
 * ## The four SP-D conditions, on this queue too
 *
 * | Condition | Where |
 * |---|---|
 * | **C-1** consumer policies + `SECURITY DEFINER` producer wrapper | `db/queue-schema.ts`; the enqueue below goes through `app_enqueue_job` and holds no grant of its own |
 * | **C-2** pool registry + stale-lease reclaim | the registry below: register → reclaim → heartbeat → release, exactly as `outbox/runner.ts` does |
 * | **C-3** every handler honours `helpers.abortSignal` | the task checks it before claiming, and a solve already in flight is bounded by its own dispatch timeout and the cancellation file |
 * | **C-4** every effect carries an idempotency key | the effect here is a CLAIM, and the claim epoch is the idempotency: a second delivery of the same job finds the run no longer `queued` and answers `not-claimable` |
 *
 * ## Why saturation throws rather than sleeps
 *
 * A deferred job must come back later. Three shapes were available:
 *
 *  * **sleep in the task** — holds a worker slot for the duration, so a
 *    saturated tenant would consume the very concurrency it is waiting for;
 *  * **re-enqueue immediately** — a hot loop against the database, bounded only
 *    by the poll interval;
 *  * **throw** — graphile-worker records the attempt and re-runs the job on its
 *    own exponential backoff, which is a scheduler that already exists and is
 *    already durable.
 *
 * The third is used. Its cost is stated rather than hidden: attempts are bounded
 * (graphile-worker's default is 25), so an organization that stays at its cap
 * for the whole retry envelope ends with a permanently-failed job and a build
 * still sitting in `queued`. {@link requeueOrphanedQueuedBuilds} is the recovery
 * for exactly that, and it is why the reap route calls it.
 */

type Uow = UnitOfWork<Kysely<Database>>;

/**
 * The task name. Constrained by `app_enqueue_job`'s own regex
 * (`^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*){1,3}$`), which is checked in the
 * database rather than here — a name this file believed was legal and the
 * wrapper did not would fail at enqueue time, in a transaction that also
 * carries the state change.
 */
export const BUILD_SOLVE_TASK = 'build.solve';

export interface BuildSolvePayload {
  readonly organizationId: string;
  readonly groupId: string;
  readonly buildRunId: string;
  readonly correlationId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Identifiers only, and each one shape-checked.
 *
 * The queue tables are outside our RLS (`db/queue-schema.ts` says so plainly),
 * so a job payload is the one place in this system where a tenant identifier
 * travels without a policy underneath it. It therefore carries nothing but
 * identifiers — no snapshot, no findings, no names — and the tenant boundary is
 * re-established where SPEC-01 §6 puts it: the unit of work the task opens, and
 * the RLS that binds it (I-07, non-bypass rule 9).
 */
export function parseBuildSolvePayload(raw: unknown): BuildSolvePayload | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  const fields = ['organizationId', 'groupId', 'buildRunId', 'correlationId'] as const;
  for (const field of fields) {
    if (typeof value[field] !== 'string') return undefined;
  }
  const organizationId = value['organizationId'] as string;
  const groupId = value['groupId'] as string;
  const buildRunId = value['buildRunId'] as string;
  const correlationId = value['correlationId'] as string;
  if (!UUID.test(organizationId) || !UUID.test(groupId) || !UUID.test(buildRunId)) {
    return undefined;
  }
  if (correlationId.length === 0 || correlationId.length > 128) return undefined;
  return { organizationId, groupId, buildRunId, correlationId };
}

/**
 * Enqueue the solve **inside the caller's transaction**.
 *
 * SP-D E-1.1 is what makes this correct: `app_enqueue_job` is `SECURITY
 * DEFINER` and `SECURITY DEFINER` does not open a transaction of its own, so a
 * submission that rolls back enqueues nothing, and a job that exists is a job
 * whose build really did reach `queued`. The alternative — enqueue after the
 * commit — has a window in which the build is queued and no worker will ever
 * hear about it, recoverable only by the sweep below.
 */
export async function enqueueBuildSolve(uow: Uow, buildRunId: string): Promise<string | null> {
  const { organizationId, groupId, correlationId } = uow.context;
  if (groupId === null) {
    throw new Error('BUILD_SOLVE_ENQUEUE_NO_GROUP: a build belongs to a group');
  }
  const payload: BuildSolvePayload = {
    organizationId,
    groupId,
    buildRunId,
    correlationId,
  };
  const enqueued = await sql<{ job_id: string }>`
    select app_enqueue_job(${BUILD_SOLVE_TASK}, ${JSON.stringify(payload)}::json)::text as job_id
  `.execute(uow.query);
  return enqueued.rows[0]?.job_id ?? null;
}

/**
 * **The recovery for a build whose job is gone.**
 *
 * Three ways a `queued` build can end up with no live job: the enqueue's
 * transaction committed and the queue row was later deleted by an operator; the
 * job exhausted its attempts while the organization stayed saturated; or a
 * deployment lost the queue schema. In all three the build is correct and the
 * *delivery* is missing, so the repair is to deliver again rather than to fail
 * the build — a build failed for a queue problem would report a system fault as
 * a scheduling outcome, which FAD-34 exists to prevent.
 *
 * Re-enqueuing is safe to do more than once: a duplicate delivery of a
 * `build.solve` job finds the run no longer `queued` and answers
 * `not-claimable` (C-4, and the matrix proves it).
 */
export async function requeueOrphanedQueuedBuilds(
  uow: Uow,
  olderThanMs = 5 * 60_000,
  now: Date = new Date(),
): Promise<readonly string[]> {
  const threshold = new Date(now.getTime() - olderThanMs);
  const stale = await uow.query
    .selectFrom('build_runs')
    .select('id')
    .where('state', '=', 'queued')
    .where('updated_at', '<', threshold)
    .execute();

  const requeued: string[] = [];
  for (const row of stale) {
    await enqueueBuildSolve(uow, row.id);
    requeued.push(row.id);
  }
  return requeued;
}

