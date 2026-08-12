import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate } from '../../src/db/migrate.js';
import type { TenantContext } from '@schedulepoint/domain';
import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import { publishVersion } from '../../src/schedule/publication.js';
import {
  addManualAssignment,
  createDraftVersion,
  createPeriod,
  moveCredit,
  setRequirement,
  transitionVersion,
} from '../../src/schedule/service.js';
import { createLocation } from '../../src/settings/service.js';
import { digestRows } from '../../src/schedule/render.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { fixtureInstant, publicationKey, scheduleActor } from '../support/schedule.js';
import { grantStaffingCapabilities } from '../support/staffing.js';

/**
 * **Migration 0014, up → down → up, over a POPULATED database** (OPUS-M4-000B;
 * doc 35 §4 "migration cycle with populated fixtures (up/down/up preserving
 * data)").
 *
 * ## Why the standing cycle is not enough
 *
 * `globalSetup` already runs the whole stack up → down → up before every test
 * run, and `migrate:cycle:embedded` does it against a throwaway cluster. Both
 * run on an EMPTY database. That proves the SQL is executable in both
 * directions; it does not prove that reversing 0014 over real rows leaves the
 * rows intact — and 0014 is the first migration in this repository to add
 * eleven foreign keys and six triggers to tables that already hold a published
 * schedule history. A down migration that drops a constraint is trivially
 * reversible on an empty table and can still be a data-loss event on a full
 * one.
 *
 * ## What "preserving data" means here, stated exactly
 *
 * **Every ROW survives, byte for byte, with two named exceptions that are what
 * dropping a column means.** `timezone_basis` and `tzdb_version` are columns
 * 0014 ADDS; its down migration drops them, and a dropped column takes its
 * values with it. On the way back up they return as NULL, which
 * `classifyTimezoneBasis` reports as `unrecorded` — an explicitly permitted
 * state that publishes rather than a state that breaks. That is asserted below
 * rather than glossed: a cycle report that claimed "all data preserved" while
 * silently emptying two columns would be the kind of claim this repository
 * treats as worse than a failure.
 *
 * ## This file deliberately runs the REAL migration runner
 *
 * Not a copy of the SQL, not a scratch schema. `migrate('down', { count: 1 })`
 * is the same call the deployment path makes, so a `down` block that is a
 * comment rather than a rollback path fails here.
 */

const multi = ownedMulti('migration-0014-cycle', {
  profile: 'core',
  seed: { catalogue: ['alpha'], scheduleCredentials: true },
});

let runtime: Runtime;
let context: TenantContext;
let actor: ReturnType<typeof scheduleActor>;
let shiftTypeId: string;
let assigneeA: string;

const run = async <T>(fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> =>
  runtime.runner.run(context, fn);

/** The tables 0014 touches, and the columns that must survive it unchanged. */
const CENSUS: readonly { table: string; columns: readonly string[] }[] = [
  { table: 'schedule_periods', columns: ['id', 'name', 'start_date', 'end_date', 'status'] },
  {
    table: 'schedule_versions',
    columns: ['id', 'period_id', 'version_number', 'state', 'is_current', 'published_at'],
  },
  { table: 'schedule_requirements', columns: ['id', 'period_id', 'date', 'required_count'] },
  { table: 'shifts', columns: ['id', 'version_id', 'date', 'shift_type_id', 'location_id'] },
  { table: 'assignment_identities', columns: ['id', 'period_id', 'origin'] },
  {
    table: 'assignment_snapshots',
    columns: ['id', 'assignment_identity_id', 'version_id', 'membership_id', 'shift_id', 'status'],
  },
  {
    table: 'credits',
    columns: ['id', 'assignment_identity_id', 'source_version_id', 'source_snapshot_id', 'status'],
  },
  {
    table: 'current_published_assignments',
    columns: ['id', 'membership_id', 'period_id', 'source_version_id', 'assignment_identity_id'],
  },
  {
    table: 'publication_records',
    columns: ['id', 'period_id', 'version_id', 'publication_idempotency_key', 'outcome'],
  },
  { table: 'version_supersessions', columns: ['id', 'superseded_version_id', 'superseding_version_id'] },
  { table: 'locations', columns: ['id', 'name', 'status', 'timezone'] },
];

/**
 * A content digest per table, over the whole tenant.
 *
 * `digestRows` sorts keys within a row and rows as whole strings, so the digest
 * depends on CONTENT and not on the order the plan happened to return. Comparing
 * digests rather than eyeballing counts is what makes "the rows are the same
 * rows" a real assertion: a cycle that dropped one row and inserted another
 * would keep the count and move the digest.
 */
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
  runtime = createRuntime('app_runtime', { max: 6 });
  const fixture = multi();
  const catalogue = fixture.catalogue?.alpha;
  if (catalogue === undefined) throw new Error('needs the alpha catalogue seed');
  const type = catalogue.shiftTypeIds[1];
  if (type === undefined) throw new Error('no shift type');
  shiftTypeId = type;

  context = {
    organizationId: fixture.alpha.organizationId,
    groupId: fixture.alpha.groupOne.id,
    membershipId: fixture.alpha.users.scheduler.membershipId,
    correlationId: 'migration-0014-cycle',
  };
  actor = scheduleActor(fixture.alpha.users.scheduler.id);
  assigneeA = fixture.alpha.users.scheduler.membershipId;

  await grantStaffingCapabilities(runtime.runner, fixture, {
    organizationId: fixture.alpha.organizationId,
    groupId: fixture.alpha.groupOne.id,
    membershipId: fixture.alpha.users.scheduler.membershipId,
    capabilities: ['group.location.administer'],
  });
});

afterAll(async () => {
  await runtime?.destroy();
});

describe('migration 0014 over a populated database', () => {
  it('up → down → up preserves every row 0014 touches', async () => {
    /* ── 1. Populate, through the production write path ─────────────────────
     *
     * Every table 0014 constrains gets at least one row, and the history is a
     * REAL one: a published V1, a superseding V2, reality rows, a supersession
     * record, two publication records, a credit, a requirement, and a shift
     * that names a location. A cycle proven over an empty table proves nothing
     * about the constraints this migration adds. */
    const locationOutcome = await run(async (uow) =>
      createLocation(uow, {
        name: 'Cycle Ward',
        siteLabel: 'Cycle Site',
        address: null,
        timezone: 'America/Toronto',
      }),
    );
    if (locationOutcome.kind !== 'ok') throw new Error('location seed failed');
    const locationId = locationOutcome.value.locationId;

    const date = '2038-01-12';
    const periodId = await run(async (uow) =>
      createPeriod(uow, actor, { name: 'cycle period', startDate: date, endDate: date }),
    );
    await run(async (uow) =>
      setRequirement(uow, actor, { periodId, date, shiftTypeId, requiredCount: 2 }),
    );

    const v1 = await run(async (uow) => {
      const draft = await createDraftVersion(uow, actor, periodId);
      const added = await addManualAssignment(uow, actor, {
        versionId: draft,
        membershipId: assigneeA,
        shiftTypeId,
        date,
        startsAt: fixtureInstant(date, 8),
        endsAt: fixtureInstant(date, 16),
        locationId,
      });
      await moveCredit(uow, actor, {
        versionId: draft,
        assignmentIdentityId: added.assignmentIdentityId,
        snapshotId: added.snapshotId,
        creditedMembershipId: assigneeA,
        reason: 'cycle credit',
      });
      await transitionVersion(uow, actor, draft, 'in_review');
      await transitionVersion(uow, actor, draft, 'approved');
      await publishVersion(uow, actor, {
        periodId,
        versionId: draft,
        idempotencyKey: publicationKey('cycle-v1'),
        expectedPriorCurrentVersionId: null,
      });
      return draft;
    });

    const v2 = await run(async (uow) => {
      const draft = await createDraftVersion(uow, actor, periodId);
      await addManualAssignment(uow, actor, {
        versionId: draft,
        membershipId: assigneeA,
        shiftTypeId,
        date,
        startsAt: fixtureInstant(date, 8),
        endsAt: fixtureInstant(date, 16),
        locationId,
      });
      await transitionVersion(uow, actor, draft, 'in_review');
      await transitionVersion(uow, actor, draft, 'approved');
      await publishVersion(uow, actor, {
        periodId,
        versionId: draft,
        idempotencyKey: publicationKey('cycle-v2'),
        expectedPriorCurrentVersionId: v1,
      });
      return draft;
    });

    const before = await census();
    for (const entry of CENSUS) {
      expect(
        before[entry.table]?.count,
        `${entry.table} must hold rows for the cycle to mean anything`,
      ).toBeGreaterThan(0);
    }
    const basisBefore = await run(async (uow) =>
      uow.query
        .selectFrom('schedule_versions')
        .select(['timezone_basis', 'tzdb_version'])
        .where('id', '=', v2)
        .executeTakeFirstOrThrow(),
    );
    expect(basisBefore.timezone_basis).not.toBeNull();

    log(
      `populated: ${CENSUS.map((entry) => `${entry.table}=${String(before[entry.table]?.count)}`).join(' ')}`,
    );

    /* ── 2. DOWN, as far as 0014 — the real runner ───────────────────────────
     *
     * COMPOSED at the 000C integration. As authored this was `count: 1`,
     * because 0014 was then the last migration on disk. 0015 now follows it, so
     * `count: 1` reversed 0015 and the assertion below failed — and the failure
     * was worse than cosmetic: it threw BEFORE step 3 re-applied anything, so
     * every later test in the run met a schema without 0015 and died on
     * `column "operation_type" does not exist`. One stale assumption, four
     * downstream failures.
     *
     * `count: 2` reverses 0015 then 0014, which is what "reverse 0014 over a
     * populated database" actually requires — a migration cannot be rolled back
     * out from under the one above it. The assertion names 0014 explicitly
     * rather than trusting a position, so the next migration to land cannot
     * repeat this. Reversing 0015 over the same populated rows is extra
     * evidence, not a cost. */
    const down = await migrate('down', { count: 2 });
    expect(down.applied, 'both migrations above and including 0014 must come down').toHaveLength(2);
    expect(down.applied.some((name) => /0014/.test(name)), '0014 must be among them').toBe(true);

    // The rows are still there with the migration reversed: this is the moment a
    // cascade or a rewrite would already have destroyed them.
    const midway = await census();
    for (const entry of CENSUS) {
      expect(midway[entry.table]?.count, `${entry.table} after down`).toBe(
        before[entry.table]?.count,
      );
    }

    /* ── 3. UP again ──────────────────────────────────────────────────────── */
    const up = await migrate('up', { count: 2 });
    expect(up.applied, 'the same migrations must go back up').toHaveLength(2);
    expect(up.applied.some((name) => /0014/.test(name)), '0014 must be among them').toBe(true);

    /* ── 4. Every row 0014 touches is byte-identical ───────────────────────── */
    const after = await census();
    for (const entry of CENSUS) {
      expect(after[entry.table]?.count, `${entry.table} row count`).toBe(before[entry.table]?.count);
      expect(after[entry.table]?.digest, `${entry.table} content digest`).toBe(
        before[entry.table]?.digest,
      );
    }
    log(`cycle: ${String(down.applied[0])} down and up; every census digest identical`);

    /* ── 5. The two NAMED exceptions, asserted rather than glossed ─────────── */
    const basisAfter = await run(async (uow) =>
      uow.query
        .selectFrom('schedule_versions')
        .select(['timezone_basis', 'tzdb_version'])
        .where('id', '=', v2)
        .executeTakeFirstOrThrow(),
    );
    expect(
      basisAfter.timezone_basis,
      'the down migration DROPS this column, so its values do not survive — stated, not hidden',
    ).toBeNull();
    expect(basisAfter.tzdb_version).toBeNull();

    /* ── 6. The constraints are back, and enforcing ────────────────────────── */
    await expect(
      run(async (uow) =>
        setRequirement(uow, actor, {
          periodId,
          date: '2038-06-01',
          shiftTypeId,
          requiredCount: 1,
        }),
      ),
      'the range trigger must be enforcing again after the cycle',
    ).rejects.toThrow(/SCHEDULE_REQUIREMENT_OUT_OF_PERIOD/);

    /* And a version with no recorded basis still publishes — the `unrecorded`
     * state the cycle just produced is the permitted one, not a broken one. */
    const afterCycleDate = '2038-01-13';
    const afterPeriod = await run(async (uow) =>
      createPeriod(uow, actor, {
        name: 'cycle after period',
        startDate: afterCycleDate,
        endDate: afterCycleDate,
      }),
    );
    await expect(
      run(async (uow) => {
        const draft = await createDraftVersion(uow, actor, afterPeriod);
        await addManualAssignment(uow, actor, {
          versionId: draft,
          membershipId: assigneeA,
          shiftTypeId,
          date: afterCycleDate,
          startsAt: fixtureInstant(afterCycleDate, 8),
          endsAt: fixtureInstant(afterCycleDate, 16),
        });
        await transitionVersion(uow, actor, draft, 'in_review');
        await transitionVersion(uow, actor, draft, 'approved');
        return publishVersion(uow, actor, {
          periodId: afterPeriod,
          versionId: draft,
          idempotencyKey: publicationKey('cycle-after'),
          expectedPriorCurrentVersionId: null,
        });
      }),
      'the schema must be fully usable after the cycle',
    ).resolves.toBeDefined();

    expect(v2).toBeTypeOf('string');
  });
});
