import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createConfiguration,
  createRun,
  loadRun,
  transitionRun,
} from '../../src/builds/service.js';
import { migrate } from '../../src/db/migrate.js';
import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import { digestRows } from '../../src/schedule/render.js';
import { seedBuildFixture, type BuildFixture } from '../support/builds.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { scheduleActor } from '../support/schedule.js';

/**
 * **Migration 0018, up → down → up, over a POPULATED database** (OPUS-M4-003;
 * doc 35 §6e Acceptance, "migration cycle 0001–0018 clean").
 *
 * ## BY NAME, never by position — FAD-33(4), and the third file to obey it
 *
 * The loop's termination condition IS the migration's name, so there is no count
 * to go stale when 0019 lands above it. The re-up sits in a `finally` and the
 * loop's own "ran out of migrations" throw sits INSIDE the `try`, because the
 * one failure mode the loop introduces is a target that never comes down — and
 * an abort there with migrations already reversed is exactly the cluster
 * poisoning the idiom exists to prevent. FAD-34(5) ratified this spelling
 * repo-wide; this file is a straight application of it.
 *
 * ## Mutation control (FAD-15)
 *
 * The final case proves the constraints are ENFORCING again after the cycle — an
 * illegal transition is still refused by the restored trigger. Without it, a
 * down migration that dropped the guard and an up migration that forgot to
 * restore it would leave every census digest identical and this file green,
 * which is the failure mode a cycle test is most likely to have.
 */

const multi = ownedMulti('builds-migration-0018-cycle', {
  profile: 'core',
  seed: { catalogue: ['alpha'], scheduleCredentials: true },
});

let runtime: Runtime;
let fixture: BuildFixture;

const run = async <T>(fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> =>
  runtime.runner.run(fixture.context, fn);

/** The tables the cycle must leave untouched, and the columns that must survive. */
const CENSUS: readonly { table: string; columns: readonly string[] }[] = [
  { table: 'schedule_periods', columns: ['id', 'name', 'start_date', 'end_date', 'status'] },
  { table: 'schedule_versions', columns: ['id', 'period_id', 'state', 'timezone_basis'] },
  { table: 'schedule_requirements', columns: ['id', 'period_id', 'date', 'required_count'] },
  { table: 'solver_input_snapshots', columns: ['id', 'period_id', 'canonical_input_hash'] },
  { table: 'rules', columns: ['id', 'rule_key', 'version', 'status'] },
];

async function census(): Promise<Record<string, { count: number; digest: string }>> {
  const result: Record<string, { count: number; digest: string }> = {};
  for (const entry of CENSUS) {
    const rows = (await run(async (uow) =>
      uow.query
        .selectFrom(entry.table as never)
        .select(entry.columns as never)
        .execute(),
    )) as unknown as Record<string, unknown>[];
    result[entry.table] = { count: rows.length, digest: digestRows(rows) };
  }
  return result;
}

beforeAll(async () => {
  runtime = createRuntime('app_runtime', { max: 4 });
  const alpha = multi().alpha;
  const shiftTypeId = multi.catalogue('alpha').shiftTypeIds[1];
  if (shiftTypeId === undefined) throw new Error('no shift type');

  fixture = await seedBuildFixture(runtime.runner, {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    membershipId: alpha.users.scheduler.membershipId,
    userId: alpha.users.scheduler.id,
    shiftTypeId,
    label: 'cycle',
    startDate: '2045-03-06',
    endDate: '2045-03-12',
  });
}, 180_000);

afterAll(async () => {
  await runtime?.destroy();
});

/**
 * A configuration and a run, through the production path.
 *
 * The configuration is created per call rather than taken from the fixture,
 * because `build_configurations` is one of the six tables 0018 creates and the
 * down migration drops it with the rest. A helper that reused the fixture's id
 * would fail after the cycle for a reason that has nothing to do with the
 * property under test — and would look like a cycle defect.
 */
async function createOne(label: string): Promise<string> {
  return run(async (uow) => {
    const actor = scheduleActor(multi().alpha.users.scheduler.id);
    const configurationId = await createConfiguration(uow, actor, {
      periodId: fixture.periodId,
      name: `Cycle ${label} ${randomUUID().slice(0, 8)}`,
      maxTimeSeconds: 5,
    });
    const created = await createRun(uow, actor, {
      configurationId,
      sourceVersionId: fixture.versionId,
      candidateLabel: label,
      idempotencyKey: `cycle.${label}.${randomUUID().slice(0, 12)}`,
    });
    return created.buildRunId;
  });
}

describe('migration 0018 over a populated database', () => {
  it('up → down → up, resolved and asserted BY NAME', async () => {
    /* ── 1. Populate, through the production path ────────────────────────── */
    await createOne('before');
    const censusBefore = await census();
    const runsBefore = await run(
      async ({ query }) =>
        await sql<{ n: string }>`SELECT count(*)::text AS n FROM build_runs`.execute(query),
    );
    expect(Number(runsBefore.rows[0]?.n)).toBeGreaterThan(0);

    /* ── 2. DOWN to a NAMED TARGET, and back UP unconditionally ──────────── */
    let up: readonly string[] = [];
    let midway: Record<string, { count: number; digest: string }> | undefined;
    const down: string[] = [];
    try {
      while (!down.some((name) => name.includes('0018'))) {
        const step = await migrate('down', { count: 1 });
        if (step.applied.length === 0) {
          throw new Error('ran out of migrations before reaching 0018 — the ledger is empty');
        }
        down.push(...step.applied);
      }
      expect(
        down.some((name) => name.includes('0018')),
        '0018 must be among the reversed migrations',
      ).toBe(true);

      /* The six tables are gone. Everything else is still here — the moment a
       * cascade or a rewrite would already have destroyed it. */
      midway = await census();
    } finally {
      up = (await migrate('up', { count: down.length })).applied;
    }

    expect(midway, 'the census must have been taken before the re-up').toBeDefined();
    expect(midway).toEqual(censusBefore);

    expect(up).toHaveLength(down.length);
    expect(up.some((name) => name.includes('0018'))).toBe(true);

    /* ── 3. The named exception, stated rather than glossed ───────────────── */
    const censusAfter = await census();
    expect(censusAfter).toEqual(censusBefore);

    /* Rows in the tables 0018 CREATES do not survive its own `DROP TABLE`, and
     * that is correct rather than a defect: a down migration that preserved them
     * would have to keep the table. Asserted explicitly so a reader does not
     * have to wonder whether it was checked. */
    const runsAfter = await run(
      async ({ query }) =>
        await sql<{ n: string }>`SELECT count(*)::text AS n FROM build_runs`.execute(query),
    );
    expect(runsAfter.rows[0]?.n).toBe('0');

    /* ── 4. The schema WORKS again, not merely exists ─────────────────────── */
    const rebuilt = await createOne('after');
    expect(rebuilt).toMatch(/^[0-9a-f-]{36}$/);
  }, 240_000);

  it('MUTATION CONTROL: the transition guard is enforcing again after the cycle', async () => {
    /* A down that dropped the trigger and an up that forgot to restore it would
     * leave every digest above identical and the case above green. This is the
     * only assertion in the file that would notice. */
    const buildRunId = await createOne('mutation-control');

    await expect(
      run(
        async ({ query }) =>
          await sql`UPDATE build_runs SET state = 'approved', termination_reason = 'completed'
                    WHERE id = ${buildRunId}::uuid`.execute(query),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('BUILD_TRANSITION_ILLEGAL') });

    /* …and the legal edge still works, so the arm above is not passing because
     * everything is refused. */
    await run(async (uow) => {
      const row = await loadRun(uow, buildRunId);
      if (row === null) throw new Error('vanished');
      await transitionRun(uow, row, 'validating', { reason: 'submitted' });
    });
    const after = await run(async (uow) => loadRun(uow, buildRunId));
    expect(after?.state).toBe('validating');
  }, 180_000);
});
