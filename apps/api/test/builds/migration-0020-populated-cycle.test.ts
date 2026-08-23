import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { claimQueuedBuild } from '../../src/builds/claim.js';
import {
  createConfiguration,
  createRun,
  loadRun,
  transitionRun,
} from '../../src/builds/service.js';
import { migrate } from '../../src/db/migrate.js';
import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import { seedBuildFixture, type BuildFixture } from '../support/builds.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { scheduleActor } from '../support/schedule.js';

/**
 * **Migration 0020, up → down → up, over a POPULATED database** (R-5; review
 * finding REV-A-004; FAD-53).
 *
 * ## What is different about this one
 *
 * 0020 creates no table, no policy, no grant and no trigger. It replaces ONE
 * function body — `app_guard_build_run_transition` — and its down migration
 * restores 0018's body verbatim rather than dropping the function, because
 * dropping it would take `build_runs_guard_transition` with it and leave the
 * whole transition machine unenforced.
 *
 * So there is no row census to take and no `DROP TABLE` whose destruction has
 * to be excused. What CAN silently fail to come back is **behaviour**, and a
 * catalogue check cannot see it: `pg_proc` would report a function of the right
 * name, language, volatility and search path whichever of the two bodies were
 * installed. The cycle is therefore asserted by DRIVING the guard:
 *
 *  * BEFORE — a settled run's termination facts are frozen;
 *  * MIDWAY, with 0020 reversed — the rewrite is ACCEPTED again, which is what
 *    reversing this migration MEANS. An assertion that skipped this would let a
 *    down migration that silently did nothing pass as reversible;
 *  * AFTER — frozen again, on a run populated BEFORE the cycle began, so the
 *    re-up is proven against data that predates it rather than against a fresh
 *    row that could have been created under either body.
 *
 * The disagreement the midway leg creates is REPAIRED before the re-up, in the
 * same window where the guard admits it. Leaving it would poison every later
 * assertion in the run with a row whose two records disagree — and this file
 * would have manufactured exactly the state the migration exists to prevent.
 *
 * ## BY NAME, never by position — FAD-33(4)
 *
 * The loop's termination condition is the migration's NAME, so there is no count
 * to go stale when 0021 lands above it. The re-up sits in a `finally` and the
 * loop's own "ran out of migrations" throw sits INSIDE the `try`, because an
 * abort with migrations already reversed is exactly the cluster poisoning the
 * idiom exists to prevent.
 */

const multi = ownedMulti('builds-migration-0020-cycle', {
  profile: 'core',
  seed: { catalogue: ['alpha'], scheduleCredentials: true },
});

let runtime: Runtime;
let fixture: BuildFixture;
/** Settled BEFORE the cycle, so the re-up is proven against pre-existing data. */
let settledRunId = '';

const run = async <T>(fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> =>
  runtime.runner.run(fixture.context, fn);

/**
 * A run driven to `failed` through the production transitions, carrying the REV-A
 * facts: `rejected` / `FEASIBLE`.
 *
 * The configuration is created per call rather than taken from the fixture for
 * the reason the 0018 cycle file records: `build_configurations` is one of the
 * tables 0018 creates, and a helper that reused an id across a deeper reversal
 * would fail for a reason that has nothing to do with the property under test.
 */
async function settleOne(label: string): Promise<string> {
  const actor = scheduleActor(multi().alpha.users.scheduler.id);
  const buildRunId = await run(async (uow) => {
    const configurationId = await createConfiguration(uow, actor, {
      periodId: fixture.periodId,
      name: `Cycle ${label} ${randomUUID().slice(0, 8)}`,
      maxTimeSeconds: 5,
    });
    const created = await createRun(uow, actor, {
      configurationId,
      sourceVersionId: fixture.versionId,
      candidateLabel: label,
      idempotencyKey: `cycle0020.${label}.${randomUUID().slice(0, 10)}`,
    });
    return created.buildRunId;
  });

  await run(async (uow) => {
    const created = await loadRun(uow, buildRunId);
    if (created === null) throw new Error('the build run vanished');
    const validating = await transitionRun(uow, created, 'validating', { reason: 'submitted' });
    const checking = await transitionRun(uow, validating, 'readiness_check', {
      reason: 'configuration_consistent',
    });
    await transitionRun(uow, checking, 'queued', { reason: 'ready' });
  });

  await run(async (uow) => {
    const claim = await claimQueuedBuild(uow, buildRunId, `cycle0020.${process.pid}`);
    if (claim === null) throw new Error('the build run could not be claimed');
    await transitionRun(uow, claim.run, 'failed', {
      terminationReason: 'rejected',
      solverStatus: 'FEASIBLE',
      reason: 'settled_for_the_cycle',
    });
  });

  return buildRunId;
}

/** The REV-A/H statement, run as `app_runtime` through a unit of work. */
async function attemptRewrite(buildRunId: string): Promise<'ACCEPTED' | string> {
  try {
    await run(async ({ query }) => {
      await sql`UPDATE build_runs
                   SET termination_reason = 'completed', solver_status = 'OPTIMAL'
                 WHERE id = ${buildRunId}::uuid`.execute(query);
    });
    return 'ACCEPTED';
  } catch (error) {
    return (error as Error).message;
  }
}

/** The two frozen columns as they currently stand. */
async function factsOf(buildRunId: string): Promise<{
  termination_reason: string | null;
  solver_status: string | null;
} | null> {
  const row = await run(async (uow) => loadRun(uow, buildRunId));
  if (row === null) return null;
  return { termination_reason: row.termination_reason, solver_status: row.solver_status };
}

beforeAll(async () => {
  runtime = createRuntime('app_runtime', { max: 4 });
  const alpha = multi().alpha;
  const shiftTypeId = multi.catalogue('alpha').shiftTypeIds[1];
  if (shiftTypeId === undefined) throw new Error('the alpha catalogue seed produced no shift type');

  fixture = await seedBuildFixture(runtime.runner, {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    membershipId: alpha.users.scheduler.membershipId,
    userId: alpha.users.scheduler.id,
    shiftTypeId,
    label: 'cycle-0020',
    startDate: '2047-04-01',
    endDate: '2047-04-07',
  });
  settledRunId = await settleOne('before');
}, 240_000);

afterAll(async () => {
  await runtime?.destroy();
});

describe('migration 0020 over a populated database', () => {
  it('up → down → up, resolved and asserted BY NAME, and asserted by BEHAVIOUR', async () => {
    /* ── 1. Populated, and the guard is enforcing on that data ───────────── */
    const runsBefore = await run(
      async ({ query }) =>
        await sql<{ n: string }>`SELECT count(*)::text AS n FROM build_runs`.execute(query),
    );
    expect(
      Number(runsBefore.rows[0]?.n),
      'the database must be populated before the cycle — else this is vacuous',
    ).toBeGreaterThan(0);

    const factsBefore = await factsOf(settledRunId);
    expect(factsBefore).toEqual({ termination_reason: 'rejected', solver_status: 'FEASIBLE' });
    expect(await attemptRewrite(settledRunId)).toContain('BUILD_TERMINATION_FACTS_FROZEN');

    /* ── 2. DOWN to a NAMED TARGET, and back UP unconditionally ──────────── */
    let up: readonly string[] = [];
    let midway = '';
    const down: string[] = [];
    try {
      while (!down.some((name) => name.includes('0020'))) {
        const step = await migrate('down', { count: 1 });
        if (step.applied.length === 0) {
          throw new Error('ran out of migrations before reaching 0020 — the ledger is empty');
        }
        down.push(...step.applied);
      }

      /* The down migration really restored 0018's body. A `CREATE OR REPLACE`
       * that named the wrong signature, or a down leg that did nothing at all,
       * would leave the freeze in place and every assertion after the re-up
       * would pass without the cycle having tested anything. */
      midway = await attemptRewrite(settledRunId);

      /* …and the disagreement is put back before anything else sees it. The
       * window admits it; that does not make it something to leave lying about
       * in a shared cluster. */
      if (midway === 'ACCEPTED') {
        await run(async ({ query }) => {
          await sql`UPDATE build_runs
                       SET termination_reason = 'rejected', solver_status = 'FEASIBLE'
                     WHERE id = ${settledRunId}::uuid`.execute(query);
        });
      }
    } finally {
      up = (await migrate('up', { count: down.length })).applied;
    }

    expect(midway, 'the down migration left the 0020 freeze in place').toBe('ACCEPTED');

    expect(up).toHaveLength(down.length);
    expect(up.some((name) => name.includes('0020'))).toBe(true);

    /* ── 3. The row survived, and the guard is enforcing again ───────────── */
    /* 0020 creates no table, so unlike the 0018 cycle there is no named
     * exception to state: the row that existed before the cycle is the same row
     * afterwards, with the same two facts on it. */
    expect(await factsOf(settledRunId)).toEqual(factsBefore);
    expect(await attemptRewrite(settledRunId)).toContain('BUILD_TERMINATION_FACTS_FROZEN');
    expect(await factsOf(settledRunId)).toEqual(factsBefore);
  }, 240_000);

  it('MUTATION CONTROL: the rest of the guard is enforcing again after the cycle', async () => {
    /* The re-up installs one function body carrying SIX independent guards. An
     * assertion that only checked the freeze would be green for a re-up that had
     * restored the freeze onto an otherwise-empty body — so the transition
     * legality check and the terminating-reason requirement are driven too, and
     * a legal edge is driven beside them so the arm cannot be passing because
     * everything is refused. */
    const buildRunId = await settleOne('after');

    await expect(
      run(
        async ({ query }) =>
          await sql`UPDATE build_runs SET state = 'running'
                    WHERE id = ${buildRunId}::uuid`.execute(query),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('BUILD_TRANSITION_ILLEGAL') });

    const fresh = await run(async (uow) => {
      const actor = scheduleActor(multi().alpha.users.scheduler.id);
      const configurationId = await createConfiguration(uow, actor, {
        periodId: fixture.periodId,
        name: `Cycle control ${randomUUID().slice(0, 8)}`,
        maxTimeSeconds: 5,
      });
      const created = await createRun(uow, actor, {
        configurationId,
        sourceVersionId: fixture.versionId,
        candidateLabel: 'cycle-control',
        idempotencyKey: `cycle0020.control.${randomUUID().slice(0, 10)}`,
      });
      return created.buildRunId;
    });

    /* The legal edge still works. */
    await run(async (uow) => {
      const row = await loadRun(uow, fresh);
      if (row === null) throw new Error('vanished');
      await transitionRun(uow, row, 'validating', { reason: 'submitted' });
    });
    expect((await run(async (uow) => loadRun(uow, fresh)))?.state).toBe('validating');

    /* …and a terminating edge that names no reason is still refused, which is
     * the guard clause immediately BELOW the early return the freeze sits above.
     * If the re-up had installed a body truncated at the freeze, this is the
     * assertion that would notice. */
    await run(async (uow) => {
      const row = await loadRun(uow, fresh);
      if (row === null) throw new Error('vanished');
      const checking = await transitionRun(uow, row, 'readiness_check', {
        reason: 'configuration_consistent',
      });
      await transitionRun(uow, checking, 'queued', { reason: 'ready' });
    });
    await run(async (uow) => {
      const claim = await claimQueuedBuild(uow, fresh, `cycle0020.control.${process.pid}`);
      if (claim === null) throw new Error('the control run could not be claimed');
    });

    await expect(
      run(
        async ({ query }) =>
          await sql`UPDATE build_runs SET state = 'failed' WHERE id = ${fresh}::uuid`.execute(
            query,
          ),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('BUILD_TERMINATION_REASON_REQUIRED'),
    });
    expect((await run(async (uow) => loadRun(uow, fresh)))?.state).toBe('running');
  }, 240_000);
});
