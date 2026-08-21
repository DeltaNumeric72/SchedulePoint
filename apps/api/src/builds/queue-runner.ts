import { EventEmitter } from 'node:events';

import { run, type Runner, type TaskList, type WorkerEvents } from 'graphile-worker';

import type { TenantContext, UnitOfWorkRunner } from '@schedulepoint/domain';
import type { Kysely } from 'kysely';

import { connectionConfig } from '../db/config.js';
import { openQueuePoolRegistry } from '../db/queue-pools.js';
import type { Database } from '../db/schema.js';
import { BUILD_SOLVE_TASK, parseBuildSolvePayload, type BuildSolvePayload } from './queue.js';
import { runQueuedBuild, type RunBuildDispatch, type RunBuildOptions } from './runner.js';

/**
 * **D-4b's queue binding, the consumer half** (doc 35 §6g ruling 2; SPEC-04
 * §1.1). `builds/queue.ts` is the producer half and carries the design note.
 *
 * ## The four SP-D conditions, on this queue too
 *
 * | Condition | Where |
 * |---|---|
 * | **C-1** consumer policies + `SECURITY DEFINER` producer wrapper | `db/queue-schema.ts`; the enqueue goes through `app_enqueue_job` and holds no grant of its own |
 * | **C-2** pool registry + stale-lease reclaim | the registry below: register -> reclaim -> heartbeat -> release, exactly as `outbox/runner.ts` does |
 * | **C-3** every handler honours `helpers.abortSignal` | the task checks it BEFORE claiming, so a worker being shut down never starts a solve it cannot finish |
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
 * still sitting in `queued`. `requeueOrphanedQueuedBuilds` is the recovery for
 * exactly that, and it is why the reap route calls it.
 */

/**
 * Thrown when the organization is at its D-4b cap.
 *
 * A distinct class so the task's own logging — and a test — can tell "queue
 * pressure, come back" apart from "this job is broken", which graphile-worker
 * cannot distinguish on its own.
 */
export class BuildCapacitySaturatedError extends Error {
  readonly runningCount: number;
  readonly cap: number;

  constructor(runningCount: number, cap: number) {
    super(
      `BUILD_CAPACITY_SATURATED: ${String(runningCount)} of ${String(cap)} solver slots are in ` +
        'use for this organization; the build stays queued and the job retries',
    );
    this.name = 'BuildCapacitySaturatedError';
    this.runningCount = runningCount;
    this.cap = cap;
  }
}

export interface BuildSolveJobOptions extends RunBuildOptions {
  readonly abortSignal?: AbortSignal;
}

/**
 * Execute one `build.solve` job.
 *
 * Exported separately from the task registration so that a test can drive the
 * REGISTERED behaviour without a worker pool — the same reason
 * `outbox/runner.ts` exports its task names.
 */
export async function runBuildSolveJob(
  runner: UnitOfWorkRunner<Kysely<Database>>,
  payload: BuildSolvePayload,
  options: BuildSolveJobOptions = {},
): Promise<RunBuildDispatch> {
  if (options.abortSignal?.aborted === true) {
    /* C-3. A worker being shut down must not START a solve it cannot finish:
     * the claim would be taken, the subprocess killed with the process, and the
     * build would sit `running` until the reaper noticed. Answering
     * `not-claimable` leaves it `queued` and the job undelivered. */
    return { kind: 'not-claimable' };
  }

  const context: TenantContext = {
    organizationId: payload.organizationId,
    groupId: payload.groupId,
    membershipId: null,
    correlationId: payload.correlationId,
  };

  const { abortSignal: _abortSignal, ...dispatchOptions } = options;
  const dispatch = await runQueuedBuild(runner, context, payload.buildRunId, dispatchOptions);

  if (dispatch.kind === 'deferred') {
    throw new BuildCapacitySaturatedError(dispatch.runningCount, dispatch.cap);
  }
  return dispatch;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The runner
 * ──────────────────────────────────────────────────────────────────────────── */

export interface BuildQueueRunnerOptions {
  readonly worker: UnitOfWorkRunner<Kysely<Database>>;
  /** A short name for this worker's role, recorded in `queue_pools`. */
  readonly label?: string;
  readonly concurrency?: number;
  readonly pollIntervalMs?: number;
  readonly staleAfterMs?: number;
  readonly sweepIntervalMs?: number;
  /** Passed to every solve. Tests use it; a deployment does not set it. */
  readonly runOptions?: RunBuildOptions;
}

export interface BuildQueueRunner {
  readonly poolId: string;
  readonly reclaimedAtStartup: readonly string[];
  stop(): Promise<void>;
}

const DEFAULT_SWEEP_MS = 5_000;

/**
 * Start a graphile-worker pool that consumes `build.solve`.
 *
 * A pool of its own rather than an extra task on the outbox runner's, and the
 * reason is resource isolation rather than tidiness: an outbox dispatch is
 * milliseconds and a solve is minutes, and sharing one concurrency budget
 * between them means a saturated solver stops every notification in the system.
 * SPEC-10 §2 already puts the solver in its own process class; this is the
 * queue-side half of the same separation.
 */
export async function startBuildQueueRunner(
  options: BuildQueueRunnerOptions,
): Promise<BuildQueueRunner> {
  const label = options.label ?? 'builds';
  const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_MS;
  const config = connectionConfig('app_worker');
  const connectionString =
    `postgres://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}` +
    `@${config.host}:${String(config.port)}/${encodeURIComponent(config.database)}`;

  const events = new EventEmitter() as WorkerEvents;
  let poolId: string | undefined;
  events.on('pool:create', ({ workerPool }) => {
    poolId = workerPool.id;
  });

  const taskList: TaskList = {
    [BUILD_SOLVE_TASK]: (async (rawPayload: unknown, helpers: unknown) => {
      const payload = parseBuildSolvePayload(rawPayload);
      if (payload === undefined) {
        // A malformed payload cannot be retried into correctness. Throwing lets
        // graphile-worker record it and back off rather than loop instantly.
        throw new Error('BUILD_SOLVE_PAYLOAD_INVALID');
      }
      const h = helpers as { abortSignal: AbortSignal };
      await runBuildSolveJob(options.worker, payload, {
        ...(options.runOptions ?? {}),
        abortSignal: h.abortSignal,
      });
    }) as TaskList[string],
  };

  const runner: Runner = await run({
    events,
    connectionString,
    concurrency: options.concurrency ?? 1,
    pollInterval: options.pollIntervalMs ?? 200,
    noHandleSignals: true,
    taskList,
  });

  if (poolId === undefined) {
    await runner.stop();
    throw new Error('BUILD_QUEUE_RUNNER_POOL_ID_UNKNOWN: pool:create did not fire');
  }

  const registry = await openQueuePoolRegistry({
    poolId,
    label,
    ...(options.staleAfterMs === undefined ? {} : { staleAfterMs: options.staleAfterMs }),
  });

  await registry.register();
  const startup = await registry.reclaimStalePools();

  const timer = setInterval(() => {
    void (async () => {
      try {
        await registry.heartbeat();
        await registry.reclaimStalePools();
      } catch {
        // A failed sweep is not fatal; the next one runs in `sweepIntervalMs`.
      }
    })();
  }, sweepIntervalMs);
  timer.unref();

  return {
    poolId,
    reclaimedAtStartup: startup.reclaimedPoolIds,
    stop: async () => {
      clearInterval(timer);
      await runner.stop();
      try {
        await registry.release();
      } finally {
        await registry.close();
      }
    },
  };
}
