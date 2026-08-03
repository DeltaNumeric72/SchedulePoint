/**
 * A worker in its own OS process, so the harness can kill it for real.
 *
 * The crash question cannot be answered in-process. `SIGKILL` to the test
 * runner ends the test runner, and anything softer than `SIGKILL` gives
 * graphile-worker a chance to release its locks — which is the very thing the
 * experiment must NOT allow it to do. So the worker is a child process, the
 * harness holds its PID, and E-2/E-3 send a real signal 9 to a real process.
 *
 * Protocol: one JSON object per stdout line. `{"event":"ready", ...}` once the
 * pool is up; everything else is diagnostics. The harness never *depends* on a
 * stdout line for a timing assertion — timings come from rows the task itself
 * wrote, because a killed process cannot flush its stdout.
 */
import { EventEmitter } from 'node:events';

import { run, type Runner, type TaskList, type WorkerEvents } from 'graphile-worker';
import pg from 'pg';

interface TaskHelpers {
  readonly job: { readonly id: string; readonly attempts: number };
  readonly abortSignal: AbortSignal;
  withPgClient<T>(cb: (client: { query: (q: string, v?: unknown[]) => Promise<unknown> }) => Promise<T>): Promise<T>;
}

const DB_URL = required('SPIKE_DB_URL');
const RESET_MS = Number(process.env.SPIKE_RESET_MS ?? 0);
const HOLD_MODE = process.env.SPIKE_HOLD_MODE ?? 'hold';
const SUICIDE_UNTIL_ATTEMPT = Number(process.env.SPIKE_SUICIDE_UNTIL_ATTEMPT ?? 1);
const LABEL = process.env.SPIKE_WORKER_LABEL ?? 'worker';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
}

function emit(event: string, detail: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ event, label: LABEL, pid: process.pid, ...detail })}\n`);
}

async function mark(
  helpers: TaskHelpers,
  task: string,
  phase: string,
): Promise<void> {
  await helpers.withPgClient(async (client) => {
    await client.query(
      'INSERT INTO spike_runs (task, job_id, attempt, worker_pid, phase) VALUES ($1, $2, $3, $4, $5)',
      [task, helpers.job.id, helpers.job.attempts, process.pid, phase],
    );
  });
}

async function applyEffect(
  helpers: TaskHelpers,
  key: string,
): Promise<void> {
  await helpers.withPgClient(async (client) => {
    await client.query(
      'INSERT INTO spike_effects (idempotency_key, job_id, attempt) VALUES ($1, $2, $3) ' +
        'ON CONFLICT (idempotency_key) DO NOTHING',
      [key, helpers.job.id, helpers.job.attempts],
    );
  });
}

function keyOf(payload: unknown, fallback: string): string {
  if (typeof payload === 'object' && payload !== null && 'key' in payload) {
    const k = (payload as { key: unknown }).key;
    if (typeof k === 'string' && k !== '') return k;
  }
  return fallback;
}

const taskList: TaskList = {
  /** Runs, applies its effect once, completes. The baseline. */
  'spike.complete': (async (payload: unknown, helpers: TaskHelpers) => {
    await mark(helpers, 'spike.complete', 'started');
    await applyEffect(helpers, keyOf(payload, `complete:${helpers.job.id}`));
    await mark(helpers, 'spike.complete', 'completed');
  }) as TaskList[string],

  /**
   * Holds the job open until the process dies. `SPIKE_HOLD_MODE=complete`
   * turns the same task into a completing one, which is how the second worker
   * in E-2 can finish a job the first worker was killed while holding.
   */
  'spike.hold': (async (payload: unknown, helpers: TaskHelpers) => {
    await mark(helpers, 'spike.hold', 'started');
    if (HOLD_MODE === 'complete') {
      await applyEffect(helpers, keyOf(payload, `hold:${helpers.job.id}`));
      await mark(helpers, 'spike.hold', 'completed');
      return;
    }
    await new Promise(() => {
      /* never resolves — the harness kills this process */
    });
  }) as TaskList[string],

  /**
   * Kills its OWN process mid-job, after the run marker is committed and
   * before the effect is applied. That ordering is the point: the job is
   * observably in flight, and the effect observably is not yet done.
   */
  'spike.suicide': (async (payload: unknown, helpers: TaskHelpers) => {
    await mark(helpers, 'spike.suicide', 'started');
    if (helpers.job.attempts <= SUICIDE_UNTIL_ATTEMPT) {
      emit('suiciding', { jobId: helpers.job.id, attempt: helpers.job.attempts });
      process.kill(process.pid, 'SIGKILL');
      // Unreachable in practice; a hard block so a missed signal cannot make
      // the task fall through and complete, which would silently pass E-3.
      await new Promise(() => {});
    }
    await applyEffect(helpers, keyOf(payload, `suicide:${helpers.job.id}`));
    await mark(helpers, 'spike.suicide', 'completed');
  }) as TaskList[string],

  /**
   * A WELL-BEHAVED long-running task: it watches `helpers.abortSignal` and
   * gives the job up when graceful shutdown asks it to. E-2.4 measures this
   * path; E-2.4b measures `spike.hold`, which ignores the signal, and the
   * difference between the two is the whole point.
   */
  'spike.abortable': (async (_payload: unknown, helpers: TaskHelpers) => {
    await mark(helpers, 'spike.abortable', 'started');
    await new Promise<void>((resolve) => {
      if (helpers.abortSignal.aborted) {
        resolve();
        return;
      }
      helpers.abortSignal.addEventListener('abort', () => { resolve(); }, { once: true });
    });
    await mark(helpers, 'spike.abortable', 'aborted');
    throw new Error('spike.abortable: gave the job up on abortSignal (synthetic)');
  }) as TaskList[string],

  /** Always throws. The I-11 contrast: a job failure that must change nothing. */
  'spike.always_fails': (async (_payload: unknown, helpers: TaskHelpers) => {
    await mark(helpers, 'spike.always_fails', 'started');
    throw new Error('spike.always_fails: deliberate failure (synthetic)');
  }) as TaskList[string],
};

/**
 * The candidate mitigation for the four-hour lease, in the shape production
 * would use it: **on startup, before serving, force-unlock the pools this
 * deployment previously registered and never released.**
 *
 * graphile-worker writes its randomly generated pool id into `jobs.locked_by`
 * and offers `force_unlock_workers(text[])`, but keeps no registry of live
 * pools — so the registry has to be ours. `spike_pools` is that registry: a row
 * per pool at startup, `released_at` set on a clean shutdown. Anything still
 * null is a pool that died without releasing, and its jobs are the ones stranded
 * for four hours. E-2.6 measures whether this actually recovers them.
 *
 * The narrow reading matters: this reclaims pools **this registry knows about**.
 * A cold, empty registry cannot reclaim a pool it never saw.
 */
async function reclaimStalePools(myPoolId: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ pool_id: string }>(
      'SELECT pool_id FROM spike_pools WHERE released_at IS NULL AND pool_id <> $1',
      [myPoolId],
    );
    const stale = rows.map((r) => r.pool_id);
    if (stale.length > 0) {
      await client.query('SELECT graphile_worker.force_unlock_workers($1::text[])', [stale]);
      await client.query(
        'UPDATE spike_pools SET released_at = now() WHERE pool_id = ANY($1::text[])',
        [stale],
      );
    }
    return stale;
  } finally {
    await client.end();
  }
}

async function registerPool(poolId: string): Promise<void> {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    await client.query(
      'INSERT INTO spike_pools (pool_id, label, worker_pid) VALUES ($1, $2, $3) ' +
        'ON CONFLICT (pool_id) DO NOTHING',
      [poolId, LABEL, process.pid],
    );
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const resetOptions =
    RESET_MS > 0 ? { minResetLockedInterval: RESET_MS, maxResetLockedInterval: RESET_MS * 2 } : {};

  // The pool id is generated inside `run()` and is not on the returned `Runner`,
  // so it is captured from the `pool:create` event — the only public route to it.
  const events = new EventEmitter() as WorkerEvents;
  let poolId: string | undefined;
  events.on('pool:create', ({ workerPool }) => {
    poolId = workerPool.id;
  });

  const runner: Runner = await run({
    events,
    connectionString: DB_URL,
    concurrency: Number(process.env.SPIKE_CONCURRENCY ?? 1),
    pollInterval: Number(process.env.SPIKE_POLL_MS ?? 200),
    // graphile-worker's own signal handling stays ON: the SIGTERM contrast in
    // E-2.4 measures exactly that path.
    noHandleSignals: false,
    gracefulShutdownAbortTimeout: Number(process.env.SPIKE_ABORT_MS ?? 5000),
    taskList,
    ...resetOptions,
  });

  if (poolId === undefined) throw new Error('pool:create never fired — cannot register the pool');
  await registerPool(poolId);

  const reclaimed = process.env.SPIKE_RECLAIM === '1' ? await reclaimStalePools(poolId) : [];

  emit('ready', { resetMs: RESET_MS, poolId, reclaimed });
  await runner.promise;
  emit('stopped');
}

main().catch((error: unknown) => {
  emit('crashed', { message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
