import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openQueuePoolRegistry } from '../../src/db/queue-pools.js';
import { adminClient } from '../support/admin-client.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * **NAMED PROOF — NR-19: a pool that stops CLEANLY strands nothing**
 * (FAD-50 C-1; `QueuePoolRegistry.release()`).
 *
 * ## Why this file exists
 *
 * NR-19 was recorded CLOSED in EV-M4-005 §4d and §9, and the independent
 * reviewer found **no test that exercised the repair**. They deleted the
 * `force_unlock_workers` call from `release()` and the entire shipped suite
 * still passed — the concurrency matrix's forty proofs included. A repair whose
 * removal kills nothing is a repair nobody can rely on, and the packet's own
 * rule that "each hardening item lands with its own proof" had not been met for
 * this one.
 *
 * The reviewer's RP-5 established the shape; this is the permanent,
 * implementer-authored proof of it.
 *
 * ## The property, and why it cannot be proven through the sweep
 *
 * `reclaimStalePools` only considers pools `where released_at is null`. A pool
 * that releases cleanly is therefore **invisible to the sweep for ever**,
 * however stale its heartbeat becomes. So a lease still held at the moment of a
 * clean release is not "reclaimed late" — it is never reclaimed at all, and the
 * job sits locked until somebody notices by hand. That is why the close had to
 * be at `release()` rather than in the sweep, and it is why the second arm below
 * asserts the sweep's blindness rather than assuming it.
 *
 * ## Mutation-checked
 *
 * Verified by deleting the `force_unlock_workers(...)` call from `release()`:
 * the first arm fails with the lease still on the job, and passes with the call
 * present. Both directions are recorded in EV-M4-005 §22.
 */

const multi = ownedMulti('m4-005-nr19-release', { profile: 'core' });

let runtime: Runtime;
let admin: ReturnType<typeof adminClient> | undefined;

beforeAll(async () => {
  runtime = createRuntime('app_runtime', { max: 4 });
  admin = adminClient();
  await admin.connect();
  multi();
}, 240_000);

afterAll(async () => {
  await runtime?.destroy();
  await admin?.end();
});

/** A real queued job, through the production enqueue path. */
async function enqueueJob(): Promise<string> {
  const alpha = multi().alpha;
  return runtime.runner.run(
    {
      organizationId: alpha.organizationId,
      groupId: null,
      membershipId: null,
      correlationId: 'nr19-release',
    },
    async (uow) => {
      const { rows } = await sql<{ job_id: string }>`
        select app_enqueue_job('nr19.release.probe', '{"probe":"nr19"}'::json)::text as job_id
      `.execute(uow.query);
      const id = rows[0]?.job_id;
      if (id === undefined) throw new Error('the probe job was not enqueued');
      return id;
    },
  );
}

async function lockedBy(jobId: string): Promise<string | null> {
  const { rows } = await admin!.query<{ locked_by: string | null }>(
    'select locked_by from graphile_worker._private_jobs where id = $1::bigint',
    [jobId],
  );
  return rows[0]?.locked_by ?? null;
}

describe('NR-19: release() unlocks the pool’s OWN jobs before it records the release', () => {
  it('a pool holding a lease releases cleanly and leaves the job reclaimable', async () => {
    const jobId = await enqueueJob();
    const poolId = `pool-nr19-${randomUUID().slice(0, 8)}`;

    const registry = await openQueuePoolRegistry({ poolId, label: 'nr19-release' });
    try {
      await registry.register();

      /* The lease, in the shape graphile-worker writes it: `locked_by` is the
       * POOL id — `crash-restart.test.ts` asserts exactly that against a real
       * SIGKILLed worker, so this is the observed shape and not an invention.
       * Written directly because the case needs a pool that HOLDS a lease and
       * then stops CLEANLY, which is the one path a real worker will not take on
       * demand: it either finishes the job or dies without releasing. */
      await admin!.query(
        'update graphile_worker._private_jobs set locked_by = $1, locked_at = now() where id = $2::bigint',
        [poolId, jobId],
      );
      expect(await lockedBy(jobId), 'the fixture failed to place the lease').toBe(poolId);

      await registry.release();
    } finally {
      await registry.close();
    }

    /* THE PROPERTY. Delete the `force_unlock_workers` call from `release()` and
     * this is the assertion that fails — the reviewer's mutation, pinned. */
    expect(
      await lockedBy(jobId),
      'the released pool left its lease on the job: NR-19 is not closed, and no sweep will ever take it',
    ).toBeNull();

    const { rows } = await admin!.query<{ released_at: Date | null }>(
      'select released_at from queue_pools where pool_id = $1',
      [poolId],
    );
    /* and the release is still RECORDED — the unlock must not have replaced it */
    expect(rows[0]?.released_at, 'the release must still be recorded').not.toBeNull();

    log(
      `      · NR-19: pool ${poolId} released; lease cleared and released_at written`,
    );
  }, 240_000);

  it('and the sweep could never have done it — a released pool is invisible to it', async () => {
    /* The reason the close lives at `release()`. Without this arm, a reader
     * could reasonably ask why the stale sweep was not simply widened, and the
     * answer — it cannot see this pool AT ALL once `released_at` is set, however
     * old its heartbeat gets — would be an assertion in a docblock rather than a
     * measured fact. */
    const jobId = await enqueueJob();
    const poolId = `pool-nr19-sweep-${randomUUID().slice(0, 8)}`;

    const registry = await openQueuePoolRegistry({ poolId, label: 'nr19-sweep' });
    try {
      await registry.register();
      await registry.release();

      /* A lease placed AFTER the release, so the release's own unlock cannot be
       * what clears it, and a heartbeat old enough that staleness is not the
       * reason the sweep declines. */
      await admin!.query(
        'update graphile_worker._private_jobs set locked_by = $1, locked_at = now() where id = $2::bigint',
        [poolId, jobId],
      );
      await admin!.query(
        "update queue_pools set heartbeat_at = now() - interval '1 hour' where pool_id = $1",
        [poolId],
      );

      const reclaimed = await registry.reclaimStalePools();
      expect(await lockedBy(jobId), 'the sweep reached a RELEASED pool').toBe(poolId);
      log(
        `      · NR-19: the sweep reclaimed ${String(reclaimed.reclaimedPoolIds.length)} pool(s), ` +
          'none of them the released one — which is why the unlock has to happen at release()',
      );
      expect(reclaimed.reclaimedPoolIds).not.toContain(poolId);
    } finally {
      /* Left clean for the next file: this arm deliberately created the orphan
       * the first arm exists to prevent. */
      await admin!.query(
        'update graphile_worker._private_jobs set locked_by = null, locked_at = null where id = $1::bigint',
        [jobId],
      );
      await registry.close();
    }
  }, 240_000);
});
