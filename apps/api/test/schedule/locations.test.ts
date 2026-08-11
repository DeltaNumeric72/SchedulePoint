import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';

import type { TenantContext } from '@schedulepoint/domain';
import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import {
  addManualAssignment,
  createDraftVersion,
  createPeriod,
} from '../../src/schedule/service.js';
import { createLocation, updateLocation } from '../../src/settings/service.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { fixtureInstant, scheduleActor } from '../support/schedule.js';
import { grantStaffingCapabilities } from '../support/staffing.js';

/**
 * Shifts ↔ locations (OPUS-M4-000B; doc 34 §4-F; migration 0014).
 *
 * ## The three rules this file pins
 *
 *  1. **A shift may name a location, and NULL stays legal.** Migration 0009
 *     created `shifts.location_id` with no foreign key because `locations` did
 *     not exist yet. 0014 adds the group-qualified composite FK. A shift with no
 *     location is a stated allowed state — a single-site group schedules that
 *     way and every pre-existing row is one — so the FK is MATCH SIMPLE and the
 *     null case is asserted rather than assumed.
 *  2. **The relationship is GROUP-QUALIFIED.** Another group's location is
 *     unreachable, and that is proven in raw SQL as `app_runtime`, not by
 *     trusting a query filter.
 *  3. **Archiving refuses NEW references and RETAINS existing ones.** Any other
 *     rule either breaks published history (delete/cascade) or lets a
 *     decommissioned place accumulate new rota (accept silently).
 */

const multi = ownedMulti('schedule-locations', {
  profile: 'core',
  seed: { catalogue: ['alpha'], scheduleCredentials: true },
});

let runtime: Runtime;
let context: TenantContext;
let actor: ReturnType<typeof scheduleActor>;
let shiftTypeId: string;
let assigneeA: string;
let siblingGroupId: string;
let siblingLocationId: string;

const run = async <T>(fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> =>
  runtime.runner.run(context, fn);

async function newLocation(name: string, ctx: TenantContext = context): Promise<string> {
  const outcome = await runtime.runner.run(ctx, async (uow) =>
    createLocation(uow, { name, siteLabel: null, address: null, timezone: null }),
  );
  if (outcome.kind !== 'ok') throw new Error(`location create failed: ${outcome.kind}`);
  return outcome.value.locationId;
}

beforeAll(async () => {
  runtime = createRuntime('app_runtime', { max: 6 });
  const fixture = multi();
  const catalogue = fixture.catalogue?.alpha;
  if (catalogue === undefined) throw new Error('needs the alpha catalogue seed');
  const type = catalogue.shiftTypeIds[1];
  if (type === undefined) throw new Error('no shift type');
  shiftTypeId = type;
  siblingGroupId = catalogue.sibling.groupId;

  context = {
    organizationId: fixture.alpha.organizationId,
    groupId: fixture.alpha.groupOne.id,
    membershipId: fixture.alpha.users.scheduler.membershipId,
    correlationId: 'schedule-locations',
  };
  actor = scheduleActor(fixture.alpha.users.scheduler.id);
  assigneeA = fixture.alpha.users.scheduler.membershipId;

  /* `group.location.administer` is what migration 0010's trigger demands on
   * every write to `locations`, and the fixture scheduler does not hold it by
   * role. Granted through the production grant path, exactly as a real
   * administrator would be. */
  for (const [groupId, membershipId] of [
    [fixture.alpha.groupOne.id, fixture.alpha.users.scheduler.membershipId],
    [catalogue.sibling.groupId, fixture.alpha.users.groupTwoScheduler.membershipId],
  ] as const) {
    await grantStaffingCapabilities(runtime.runner, fixture, {
      organizationId: fixture.alpha.organizationId,
      groupId,
      membershipId,
      capabilities: ['group.location.administer'],
    });
  }

  siblingLocationId = await newLocation('Sibling Ward', {
    ...context,
    groupId: catalogue.sibling.groupId,
    membershipId: fixture.alpha.users.groupTwoScheduler.membershipId,
  });
});

afterAll(async () => {
  await runtime?.destroy();
});

async function draftAt(label: string, date: string): Promise<string> {
  const periodId = await run(async (uow) =>
    createPeriod(uow, actor, { name: `${label} period`, startDate: date, endDate: date }),
  );
  return run(async (uow) => createDraftVersion(uow, actor, periodId));
}

describe('a shift can name a location, and NULL stays legal', () => {
  it('an assignment WITHOUT a location produces a shift with location_id NULL', async () => {
    const versionId = await draftAt('location-null', '2035-01-05');
    await run(async (uow) =>
      addManualAssignment(uow, actor, {
        versionId,
        membershipId: assigneeA,
        shiftTypeId,
        date: '2035-01-05',
        startsAt: fixtureInstant('2035-01-05', 8),
        endsAt: fixtureInstant('2035-01-05', 16),
      }),
    );
    const shift = await run(async (uow) =>
      uow.query
        .selectFrom('shifts')
        .select('location_id')
        .where('version_id', '=', versionId)
        .executeTakeFirstOrThrow(),
    );
    expect(shift.location_id).toBeNull();
  });

  it('an assignment WITH a location stores it, and the two are DIFFERENT shifts', async () => {
    const locationId = await newLocation('Ward Alpha');
    const versionId = await draftAt('location-set', '2035-01-06');

    await run(async (uow) =>
      addManualAssignment(uow, actor, {
        versionId,
        membershipId: assigneeA,
        shiftTypeId,
        date: '2035-01-06',
        startsAt: fixtureInstant('2035-01-06', 8),
        endsAt: fixtureInstant('2035-01-06', 12),
        locationId,
      }),
    );
    await run(async (uow) =>
      addManualAssignment(uow, actor, {
        versionId,
        membershipId: assigneeA,
        shiftTypeId,
        date: '2035-01-06',
        startsAt: fixtureInstant('2035-01-06', 13),
        endsAt: fixtureInstant('2035-01-06', 18),
        locationId: null,
      }),
    );

    /* TWO shift rows for the same (version, date, shift type): the located one
     * and the un-located one. `shifts_unique_in_version` COALESCEs the NULL into
     * a stable key, so this is the designed behaviour rather than a duplicate. */
    const shifts = await run(async (uow) =>
      uow.query
        .selectFrom('shifts')
        .select(['id', 'location_id'])
        .where('version_id', '=', versionId)
        .orderBy('location_id')
        .execute(),
    );
    expect(shifts).toHaveLength(2);
    expect(shifts.map((row) => row.location_id).sort()).toEqual([locationId, null].sort());
  });
});

describe('the relationship is GROUP-QUALIFIED, proven at the database', () => {
  it('a shift naming ANOTHER group’s location is refused, as app_runtime, in raw SQL', async () => {
    const versionId = await draftAt('location-crossgroup', '2035-02-01');
    let error: string | null = null;
    try {
      await run(async ({ query }) => {
        await sql
          .raw(
            `INSERT INTO shifts (id, organization_id, group_id, version_id, date, shift_type_id, location_id)
             VALUES ('${randomUUID()}', '${context.organizationId}', '${context.groupId as string}',
                     '${versionId}', '2035-02-01', '${shiftTypeId}', '${siblingLocationId}')`,
          )
          .execute(query);
      });
    } catch (caught) {
      error = (caught as Error).message;
    }
    expect(error, 'a cross-group location must be unreachable').not.toBeNull();
    expect(siblingGroupId).not.toBe(context.groupId);
  });
});

describe('archiving refuses NEW references and RETAINS existing ones', () => {
  it('an existing shift keeps its reference and stays editable after archiving', async () => {
    const locationId = await newLocation('Ward To Archive');
    const versionId = await draftAt('location-archive', '2035-03-01');

    await run(async (uow) =>
      addManualAssignment(uow, actor, {
        versionId,
        membershipId: assigneeA,
        shiftTypeId,
        date: '2035-03-01',
        startsAt: fixtureInstant('2035-03-01', 8),
        endsAt: fixtureInstant('2035-03-01', 16),
        locationId,
      }),
    );

    const before = await run(async (uow) =>
      uow.query
        .selectFrom('locations')
        .select('version')
        .where('id', '=', locationId)
        .executeTakeFirstOrThrow(),
    );
    const archived = await run(async (uow) =>
      updateLocation(uow, locationId, { status: 'archived', expectedVersion: before.version }),
    );
    expect(archived.kind).toBe('ok');

    // RETAINED: the row still points at the archived location.
    const shift = await run(async (uow) =>
      uow.query
        .selectFrom('shifts')
        .select(['id', 'location_id', 'required_count'])
        .where('version_id', '=', versionId)
        .executeTakeFirstOrThrow(),
    );
    expect(shift.location_id).toBe(locationId);

    /* And still EDITABLE. The guard fires on a CHANGE of `location_id`, not on
     * its value, so an unrelated edit to a shift that already points at an
     * archived place is not refused — a guard written on the value alone would
     * make those shifts permanently uneditable, which is a different bug wearing
     * the same name. */
    await expect(
      run(async ({ query }) => {
        await sql
          .raw(`UPDATE shifts SET required_count = 3 WHERE id = '${shift.id}'`)
          .execute(query);
      }),
    ).resolves.toBeUndefined();
  });

  it('a NEW reference to an archived location is refused, at the database', async () => {
    const locationId = await newLocation('Ward Already Archived');
    const version = await run(async (uow) =>
      uow.query
        .selectFrom('locations')
        .select('version')
        .where('id', '=', locationId)
        .executeTakeFirstOrThrow(),
    );
    await run(async (uow) =>
      updateLocation(uow, locationId, { status: 'archived', expectedVersion: version.version }),
    );

    const versionId = await draftAt('location-archived-new', '2035-03-05');
    await expect(
      run(async (uow) =>
        addManualAssignment(uow, actor, {
          versionId,
          membershipId: assigneeA,
          shiftTypeId,
          date: '2035-03-05',
          startsAt: fixtureInstant('2035-03-05', 8),
          endsAt: fixtureInstant('2035-03-05', 16),
          locationId,
        }),
      ),
      'a new assignment at an archived location must be refused',
    ).rejects.toThrow(/SCHEDULE_SHIFT_LOCATION_ARCHIVED/);
  });

  it('MOVING an existing shift ONTO an archived location is refused too', async () => {
    /* The escape the INSERT-only version of this guard would leave open: create
     * the shift at an active location, then UPDATE it onto the archived one. */
    const active = await newLocation('Ward Move Source');
    const archivedId = await newLocation('Ward Move Target');
    const version = await run(async (uow) =>
      uow.query
        .selectFrom('locations')
        .select('version')
        .where('id', '=', archivedId)
        .executeTakeFirstOrThrow(),
    );
    await run(async (uow) =>
      updateLocation(uow, archivedId, { status: 'archived', expectedVersion: version.version }),
    );

    const versionId = await draftAt('location-move', '2035-03-09');
    await run(async (uow) =>
      addManualAssignment(uow, actor, {
        versionId,
        membershipId: assigneeA,
        shiftTypeId,
        date: '2035-03-09',
        startsAt: fixtureInstant('2035-03-09', 8),
        endsAt: fixtureInstant('2035-03-09', 16),
        locationId: active,
      }),
    );
    const shift = await run(async (uow) =>
      uow.query
        .selectFrom('shifts')
        .select('id')
        .where('version_id', '=', versionId)
        .executeTakeFirstOrThrow(),
    );

    let error: string | null = null;
    try {
      await run(async ({ query }) => {
        await sql
          .raw(`UPDATE shifts SET location_id = '${archivedId}' WHERE id = '${shift.id}'`)
          .execute(query);
      });
    } catch (caught) {
      error = (caught as Error).message;
    }
    expect(error).not.toBeNull();
    expect(error).toMatch(/SCHEDULE_SHIFT_LOCATION_ARCHIVED/);
  });
});
