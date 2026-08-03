import { EventEmitter } from 'node:events';

import {
  parseCronItems,
  run,
  type ParsedCronItem,
  type Runner,
  type TaskList,
  type WorkerEvents,
} from 'graphile-worker';

import type { AlertSink, CheckpointSigner } from '@schedulepoint/domain';

import {
  allAuditedOrganizations,
  runCheckpointSweep,
  runVerificationSweep,
} from '../audit/periodic.js';
import { connectionConfig } from '../db/config.js';
import { openQueuePoolRegistry } from '../db/queue-pools.js';
import type { PgUnitOfWorkRunner } from '../db/unit-of-work.js';
import { dispatchOutboxEvent, parseDispatchPayload } from './dispatcher.js';
import { OUTBOX_DISPATCH_TASK } from './publisher.js';
import type { OutboxSink } from './sink.js';

/**
 * The worker process's queue runner — graphile-worker, wired under SP-D's four
 * conditions.
 *
 * | Condition | Where it is honoured |
 * |---|---|
 * | **C-1** consumer policies + `SECURITY DEFINER` producer wrapper | `queue-schema.ts`, applied at bootstrap |
 * | **C-2** pool registry + stale-lease reclaim | the registry below: register → reclaim → heartbeat → release |
 * | **C-3** every handler honours `helpers.abortSignal` | the task passes it to the dispatcher, which checks it before delivering |
 * | **C-4** every effect carries an idempotency key | `outbox_events.idempotency_key`, deduplicated **durably** by `outbox_effects`'s primary key (`outbox/sink.ts`) |
 *
 * It also carries SPEC-11 §2's two periodic jobs — the checkpoint sweep and the
 * verification sweep — as graphile-worker cron tasks, because a tamper-evidence
 * control that only runs when an operator remembers to run it reports after the
 * incident rather than during it.
 *
 * ## Two things this deliberately does not do
 *
 * **It installs no signal handlers** (`noHandleSignals: true`). The process that
 * owns the lifecycle installs them, and it must send `SIGTERM` twice or set a
 * kill deadline — SP-D E-2.4b measured a worker not exiting on the first signal
 * when a task ignores the abort. Hiding that inside this module would make the
 * deployment requirement invisible.
 *
 * **It runs the reclaim on a timer, not only at startup.** SP-D E-2.6 measured
 * the startup-only version; a long-running worker also has to notice a *peer*
 * dying, and a peer that dies an hour after this one started is exactly the case
 * the four-hour lease otherwise owns.
 */

export interface OutboxRunnerOptions {
  readonly worker: PgUnitOfWorkRunner;
  readonly sink: OutboxSink;
  /**
   * Signs periodic checkpoints and verifies them (SPEC-11 §2). Omit to run the
   * dispatcher alone — which is what the focused dispatch tests want, and which
   * a production process must NOT do.
   */
  readonly signer?: CheckpointSigner;
  readonly alerts?: AlertSink;
  /** Cron for the periodic checkpoint job. Default: every hour. */
  readonly checkpointCron?: string;
  /**
   * SPEC-11 §2's "every N entries". Default 100.
   *
   * A deployment knob rather than a test seam — but it is also what lets a test
   * ask the REGISTERED task to do something, which is the only way to prove the
   * task is registered rather than merely written.
   */
  readonly checkpointEntryInterval?: bigint;
  /** SPEC-11 §2's "and at least daily". Default `24 hours`. */
  readonly checkpointMaxAge?: string;
  /** Cron for the periodic verification job. Default: every six hours. */
  readonly verificationCron?: string;
  /** A short name for this worker's role, recorded in `queue_pools`. */
  readonly label?: string;
  readonly concurrency?: number;
  readonly pollIntervalMs?: number;
  /** How long without a heartbeat before a peer pool is presumed dead. */
  readonly staleAfterMs?: number;
  /** How often to heartbeat and sweep for stale peers. */
  readonly sweepIntervalMs?: number;
}

/** Task names, exported so a test can invoke a periodic job without waiting for cron. */
export const AUDIT_CHECKPOINT_TASK = 'audit.checkpoint';
export const AUDIT_VERIFY_TASK = 'audit.verify';

export interface OutboxRunner {
  readonly poolId: string;
  /** Pools reclaimed during startup, before the first job was claimed. */
  readonly reclaimedAtStartup: readonly string[];
  stop(): Promise<void>;
}

const DEFAULT_SWEEP_MS = 5_000;

export async function startOutboxRunner(options: OutboxRunnerOptions): Promise<OutboxRunner> {
  const label = options.label ?? 'outbox';
  const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_MS;
  const config = connectionConfig('app_worker');
  const connectionString =
    `postgres://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}` +
    `@${config.host}:${String(config.port)}/${encodeURIComponent(config.database)}`;

  // graphile-worker generates the pool id inside `run()` and does not put it on
  // the returned `Runner`. `pool:create` is the only public route to it, and the
  // registry is useless without it — so the emitter is passed in rather than
  // read off the runner afterwards.
  const events = new EventEmitter() as WorkerEvents;
  let poolId: string | undefined;
  events.on('pool:create', ({ workerPool }) => {
    poolId = workerPool.id;
  });

  /* ── SPEC-11 §2's periodic jobs, as recurring queue tasks ─────────────────
   *
   * Registered only when a signer is supplied. A runner without one still
   * dispatches, and says nothing about checkpoints — better than a task that
   * silently no-ops, which is how a periodic control stops existing without
   * anybody noticing.
   */
  const periodicTasks: TaskList =
    options.signer === undefined
      ? {}
      : {
          [AUDIT_CHECKPOINT_TASK]: (async () => {
            const result = await runCheckpointSweep(options.worker, options.signer!, {
              ...(options.checkpointEntryInterval === undefined
                ? {}
                : { entryInterval: options.checkpointEntryInterval }),
              ...(options.checkpointMaxAge === undefined
                ? {}
                : { maxAge: options.checkpointMaxAge }),
            });
            if (result.failed.length > 0) {
              options.alerts?.emit({
                severity: 'warn',
                code: 'AUDIT_CHECKPOINT_SWEEP_INCOMPLETE',
                message: 'One or more organizations could not be checkpointed this sweep.',
                detail: { considered: result.considered, failed: result.failed.length },
              });
            }
          }) as TaskList[string],

          [AUDIT_VERIFY_TASK]: (async () => {
            const organizations = await allAuditedOrganizations(options.worker);
            // The sweep alerts on every discrepancy itself; nothing here needs
            // to inspect the result, and a caller that forgot to would still get
            // the page.
            await runVerificationSweep(
              options.worker,
              options.signer!,
              options.alerts ?? { emit: () => {} },
              organizations,
            );
          }) as TaskList[string],
        };

  const taskList: TaskList = {
    ...periodicTasks,
    [OUTBOX_DISPATCH_TASK]: (async (rawPayload: unknown, helpers: unknown) => {
      const parsed = parseDispatchPayload(rawPayload);
      if (parsed === undefined) {
        // A malformed payload cannot be retried into correctness. Throwing lets
        // graphile-worker record it and back off rather than looping instantly.
        throw new Error('OUTBOX_DISPATCH_PAYLOAD_INVALID');
      }
      const h = helpers as { abortSignal: AbortSignal };
      // The attempt number now comes from the outbox row's own claim counter,
      // not from the queue's — they are different numbers, and the effect row
      // records the one that describes THIS dispatch.
      const outcome = await dispatchOutboxEvent(options.worker, options.sink, parsed, {
        abortSignal: h.abortSignal,
      });
      if (outcome.status === 'failed') {
        // The dispatcher already recorded the failure and audited it. Throwing
        // is what tells the QUEUE to retry; swallowing it here would mark the
        // job complete and lose the delivery.
        throw new Error(`OUTBOX_DISPATCH_FAILED:${outcome.errorCode}`);
      }
    }) as TaskList[string],
  };

  // Cron items are parsed here rather than read from a crontab file so that the
  // schedule is in the same review as the tasks it schedules.
  const cronItems: ParsedCronItem[] =
    options.signer === undefined
      ? []
      : parseCronItems([
          {
            task: AUDIT_CHECKPOINT_TASK,
            match: options.checkpointCron ?? '0 * * * *',
            options: { backfillPeriod: 0 },
          },
          {
            task: AUDIT_VERIFY_TASK,
            match: options.verificationCron ?? '30 */6 * * *',
            options: { backfillPeriod: 0 },
          },
        ]);

  const runner: Runner = await run({
    events,
    connectionString,
    concurrency: options.concurrency ?? 1,
    pollInterval: options.pollIntervalMs ?? 200,
    noHandleSignals: true,
    taskList,
    ...(cronItems.length > 0 ? { parsedCronItems: cronItems } : {}),
  });

  if (poolId === undefined) {
    await runner.stop();
    throw new Error('OUTBOX_RUNNER_POOL_ID_UNKNOWN: pool:create did not fire');
  }

  // The registry owns its own connection (see `db/queue-pools.ts`), so this
  // module imports no driver and checks out nothing — which is what keeps it out
  // of the connection-owner allow-list.
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
        // A failed sweep is not fatal: the next one runs in `sweepIntervalMs`,
        // and the four-hour lease is still underneath. Throwing out of a timer
        // callback would take the worker down for a transient database blip.
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
