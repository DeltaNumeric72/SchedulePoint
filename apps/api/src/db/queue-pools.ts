import { hostname } from 'node:os';

import pg from 'pg';

import { connectionConfig } from './config.js';

/**
 * The worker-pool registry and the stale-lease reclaim — **SP-D condition C-2**.
 *
 * ## Why it lives in `src/db/`
 *
 * Because it owns a connection, and
 * `apps/api/test/architecture/no-tenant-access-outside-unit-of-work.test.ts`
 * requires connection ownership to sit in the `db/` layer. Satisfying that rule
 * is the right response to it; adding an allow-list entry would have been the
 * quiet form of weakening it (non-bypass rule 10).
 *
 * **Nothing here touches a tenant table.** `queue_pools` records the lifecycle
 * of an OS process and `graphile_worker` is the queue's own schema; neither is
 * tenant-scoped, and `apps/api/test/audit/architecture.test.ts` asserts that
 * this file never names one.
 *
 * ## The measurement this exists because of
 *
 * | SP-D | Measured |
 * |---|---|
 * | E-2.1 | a `SIGKILL`ed worker leaves its job locked |
 * | E-2.3 | the lease is **4 hours**, hard-coded; only the sweep interval is configurable |
 * | E-2.4 | a **graceful** shutdown does not release the in-flight job either, and does not persist its failure — so an ordinary rolling deploy strands every in-flight job for the same 4 hours |
 * | E-2.5 | `force_unlock_workers([poolId])` clears it in ~1 ms — but needs the id, and graphile-worker keeps no registry of pools |
 * | E-2.6 | a registry of our own + reclaim at startup recovered a stranded job in **316 ms** |
 *
 * ## Why the heartbeat, rather than E-2.6's "reclaim everything unreleased"
 *
 * E-2.6 reclaimed at startup on the assumption that any unreleased pool was
 * dead. That is true for a single worker restarting and **false during a rolling
 * deploy**, where the old pool is unreleased and very much alive — reclaiming its
 * lease would hand its in-flight job to a second worker and run the effect twice.
 * At-least-once tolerates that only because of idempotency keys, and relying on
 * them to paper over a lock we broke on purpose is not a design.
 *
 * So a pool heartbeats while it lives, and only a pool that is **unreleased and
 * has stopped heartbeating for `staleAfterMs`** is reclaimed. The recovery bound
 * becomes `staleAfterMs + sweepIntervalMs` — seconds, not hours, and honest
 * about which seconds.
 *
 * **The four-hour lease remains the backstop**, and that is not a weakness to
 * hide: a pool killed between `run()` and its registration insert is not in the
 * registry, and nothing here can reclaim what it never saw.
 */

export interface PoolRegistryOptions {
  /** graphile-worker's pool id, captured from its `pool:create` event. */
  readonly poolId: string;
  /** A short name for this worker's role in the deployment. */
  readonly label: string;
  /** How long without a heartbeat before a pool is presumed dead. Default 30 s. */
  readonly staleAfterMs?: number;
}

export interface ReclaimResult {
  readonly reclaimedPoolIds: readonly string[];
}

const DEFAULT_STALE_AFTER_MS = 30_000;

/**
 * Hostnames can contain characters the table's CHECK rejects, and a startup that
 * fails on `os.hostname()` is a bad trade. Anything unexpected becomes
 * `unknown-host`: the field is a diagnostic, not an identifier.
 */
function safeHostname(): string {
  const raw = hostname();
  return /^[A-Za-z0-9_.-]{1,253}$/.test(raw) ? raw : 'unknown-host';
}

/**
 * Opens a registry with a connection of its own.
 *
 * The connection belongs here rather than to the caller, so that
 * `outbox/runner.ts` — which orchestrates the worker but is not a `db/` module —
 * never imports `pg`, never calls `connect()`, and never appears in the
 * connection-owner allow-list.
 */
export async function openQueuePoolRegistry(
  options: PoolRegistryOptions,
): Promise<QueuePoolRegistry> {
  const client = new pg.Client(connectionConfig('app_worker'));
  await client.connect();
  return new QueuePoolRegistry(client, options);
}

export class QueuePoolRegistry {
  readonly #client: pg.ClientBase;
  readonly #options: Required<PoolRegistryOptions>;

  constructor(client: pg.ClientBase, options: PoolRegistryOptions) {
    this.#client = client;
    this.#options = {
      staleAfterMs: options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
      ...options,
    };
  }

  /** Records this pool as live. Must happen before the first job is claimed. */
  async register(): Promise<void> {
    await this.#client.query(
      `insert into queue_pools (pool_id, label, hostname, process_id)
       values ($1, $2, $3, $4)
       on conflict (pool_id) do update
          set heartbeat_at = now(), released_at = null`,
      [this.#options.poolId, this.#options.label, safeHostname(), process.pid],
    );
  }

  async heartbeat(): Promise<void> {
    await this.#client.query(
      'update queue_pools set heartbeat_at = now() where pool_id = $1 and released_at is null',
      [this.#options.poolId],
    );
  }

  /**
   * Marks this pool cleanly stopped, so nobody reclaims a lease it never held.
   *
   * Best-effort by nature: the failure mode this whole module addresses is a
   * process that does not get to run its shutdown path.
   */
  async release(): Promise<void> {
    await this.#client.query(
      'update queue_pools set released_at = now() where pool_id = $1 and released_at is null',
      [this.#options.poolId],
    );
  }

  /**
   * Unlocks the jobs held by pools that are unreleased and no longer
   * heartbeating.
   *
   * `force_unlock_workers` is graphile-worker's own function, so the unlock uses
   * the library's semantics rather than an `UPDATE` of our own against its
   * tables — the difference matters the first time its locking model changes.
   */
  /** Closes the connection this registry owns. */
  async close(): Promise<void> {
    await (this.#client as unknown as { end: () => Promise<void> }).end();
  }

  async reclaimStalePools(): Promise<ReclaimResult> {
    const stale = await this.#client.query<{ pool_id: string }>(
      `select pool_id
         from queue_pools
        where released_at is null
          and pool_id <> $1
          and heartbeat_at < now() - make_interval(secs => $2::double precision)`,
      [this.#options.poolId, this.#options.staleAfterMs / 1000],
    );
    const poolIds = stale.rows.map((r) => r.pool_id);
    if (poolIds.length === 0) return { reclaimedPoolIds: [] };

    // No count of the jobs about to be unlocked. `_private_jobs` is exactly what
    // its name says, and a diagnostic that reads it would return a silent `0`
    // the first time graphile-worker renames it — a number that looks like "the
    // reclaim found nothing" and means "the query stopped working" (R-10). The
    // public API is `force_unlock_workers`; the count is not worth a private
    // dependency that fails quietly.
    await this.#client.query('select graphile_worker.force_unlock_workers($1::text[])', [poolIds]);
    await this.#client.query(
      'update queue_pools set released_at = now() where pool_id = any($1::text[])',
      [poolIds],
    );

    return { reclaimedPoolIds: poolIds };
  }
}
