import { randomUUID } from 'node:crypto';

import type { PgUnitOfWorkRunner } from '../../src/db/unit-of-work.js';
import * as catalogue from '../../src/catalogue/service.js';
import { groupContext } from './fixtures.js';
import type { MultiFixture } from './multi.js';

/* ────────────────────────────────────────────────────────────────────────────
 * Catalogue rows for an owned MULTI fixture (OPUS-M2-002).
 *
 * ## Why this module exists at all
 *
 * Migration 0005 adds nine tenant tables, and packet 30 §7.2 requires them to be
 * registered in `TENANT_TABLES` in the same change. Three existing assertions
 * then apply to them immediately, and all three demand **visible rows**:
 *
 *   * `apps/api/test/tenancy/unit-of-work.test.ts` — the T-15 storm asserts every
 *     registered table was observed with at least one visible row, because a
 *     probe over an empty table reports "0 wrong" for the boring reason;
 *   * `apps/api/test/red-cases/probe-is-not-vacuous.test.ts` — the same rule, as
 *     a red case;
 *   * SBX-004 — the same rule again, and §7.2 names it explicitly.
 *
 * ## Why it is NOT in `multi.ts`
 *
 * Packet 30 §5 and §7.6: "MULTI is read-only shared substrate — neither task
 * mutates the MULTI provisioning script (changes = escalation)." OPUS-M2-003 is
 * running in parallel with four tenant tables of its own and the identical
 * problem, and both agents editing `provisionMulti` is precisely the collision
 * that clause exists to prevent.
 *
 * So the seeding is an ADDITIVE, per-file call: a test file that needs catalogue
 * rows in its own owned tenant calls `seedCatalogueFixture` after `ownedMulti`
 * has provisioned it. The shared provisioning script is untouched, nothing is
 * weakened, and the tension between §7.2 and §5 is disclosed in the return
 * report rather than resolved by editing a file the packet protects.
 *
 * **This is a disclosed deviation, not a preference.** The structurally correct
 * home for this is `provisionMulti`, and the return report says so and
 * recommends it be moved there under a ruling at the integration packet.
 *
 * ## Every row is written by the production path
 *
 * `apps/api/src/catalogue/service.ts`, through a real unit of work, under a
 * group-scoped context whose acting membership holds
 * `schedule.catalogue.administer` by role. A fixture that hand-wrote these would
 * seed rows the application could not have produced, and every isolation claim
 * about them would be a claim about rows nothing writes.
 *
 * The holiday and pick-position rows need the two group-ADMINISTRATOR keys, and
 * the sibling group's author may hold no catalogue key by role, so both are
 * reached through `capability_grants` written by the organization administrator
 * — the production mechanism for exactly this (SPEC-06 L4.2), not a shortcut
 * around it.
 *
 * ## TWO groups, and why that is the whole point
 *
 * A catalogue seeded into one group makes the cross-GROUP isolation arm vacuous:
 * "zero rows from the other group" is what an empty table reports. An
 * independent review proved the consequence by mutating every catalogue policy
 * to drop its `group_id` clause — the CAR-001 defect class — and watching the
 * sweep stay green. Both groups are seeded now, and the sweep asserts that the
 * cross-group measurement is capable of being non-zero before it asserts that it
 * is zero.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface SeededCatalogue {
  readonly shiftTypeIds: readonly string[];
  readonly shiftGroupId: string;
  readonly staffGroupId: string;
  readonly validGroupId: string;
  readonly holidaySeeded: boolean;
  /**
   * The SIBLING group in the same organization, and what was seeded into it.
   *
   * This exists because of a blocking review finding. The fixture seeded ONE
   * group, so the cross-tenant sweep's cross-GROUP arm — "Alpha Group One sees
   * zero rows from Alpha Group Two" — was measuring an empty table. The reviewer
   * proved it: dropping the `group_id` clause from every catalogue policy while
   * keeping the `organization_id` clause (the CAR-001 defect class exactly) left
   * all six sweep tests **green**.
   *
   * Both groups now hold catalogue rows, so `wrongGroup` is measurable and the
   * arm can fail. The sweep asserts that measurability directly rather than
   * trusting this comment.
   */
  readonly sibling: {
    readonly groupId: string;
    readonly shiftTypeIds: readonly string[];
    readonly holidaySeeded: boolean;
  };
}

/** Synthetic, and deliberately generic: no organization, site or person name. */
const SHIFT_TYPES = [
  {
    code: 'DAY',
    name: 'Day shift',
    startTime: '07:00',
    endTime: '19:00',
    palette: 'indigo' as const,
    onCall: false,
    dailyPick: true,
  },
  {
    code: 'NIGHT',
    name: 'Night shift',
    startTime: '19:00',
    endTime: '07:00',
    palette: 'violet' as const,
    onCall: true,
    dailyPick: true,
  },
];

/**
 * Seeds one of every catalogue row into one group of an owned fixture.
 *
 * Returns what it wrote so a caller can assert against ids rather than by
 * predicate — FAD-15's E-01 finding: a restore by predicate can match a row it
 * did not create.
 */
export async function seedCatalogueFixture(
  runtime: PgUnitOfWorkRunner,
  fixture: MultiFixture,
  which: 'alpha' | 'beta' = 'alpha',
): Promise<SeededCatalogue> {
  // Beta has the same shape for everything this seeder needs — an organization
  // administrator and a Group One scheduler — which is what lets the isolation
  // sweep populate BOTH tenants and mean something. A sweep over a tenant whose
  // neighbour has no catalogue rows proves nothing about catalogue isolation.
  const alpha =
    which === 'alpha'
      ? fixture.alpha
      : {
          organizationId: fixture.beta.organizationId,
          groupOne: fixture.beta.groupOne,
          users: {
            scheduler: fixture.beta.users.scheduler,
            organizationAdmin: fixture.beta.users.organizationAdmin,
          },
        };

  /* The SIBLING group in the same organization, and a membership inside it.
   *
   * Alpha's is `groupTwoScheduler`, whose group role already carries the
   * catalogue key. Beta's Group Two membership holds the `member` role, which
   * carries nothing — so it is granted the key below, by the organization
   * administrator, exactly as production would. The administrator and the target
   * are different USERS, so `app_guard_capability_grant_administration`'s
   * two-person rule is satisfied rather than worked around. */
  const sibling =
    which === 'alpha'
      ? {
          groupId: fixture.alpha.groupTwo.id,
          membershipId: fixture.alpha.users.groupTwoScheduler.membershipId,
        }
      : {
          groupId: fixture.beta.groupTwo.id,
          membershipId: fixture.beta.users.scheduler.groupTwoMembershipId,
        };
  // `scheduler` in Group One holds `schedule.catalogue.administer` by role
  // (doc 08 §6 "Author catalogue & rules"). Every MULTI profile has one.
  const authorContext = groupContext(
    alpha.organizationId,
    alpha.groupOne.id,
    alpha.users.scheduler.membershipId,
    `catalogue-fixture-${fixture.slug}`,
  );

  const shiftTypeIds: string[] = [];
  let shiftGroupId = '';
  let staffGroupId = '';
  let validGroupId = '';

  await runtime.run(authorContext, async (uow) => {
    for (const definition of SHIFT_TYPES) {
      const created = await catalogue.createShiftType(uow, {
        code: definition.code,
        name: definition.name,
        description: null,
        displayPaletteKey: definition.palette,
        displayTextStyle: 'regular',
        startTime: definition.startTime,
        endTime: definition.endTime,
        isOnCall: definition.onCall,
        attractsStipend: definition.onCall,
        isManualOnly: false,
        isDailyPick: definition.dailyPick,
        includeInStatistics: true,
        isLeaveOfAbsence: false,
        allowOnRequest: true,
        allowOffRequest: true,
        reportOrder: shiftTypeIds.length,
        creditWeight: 1,
      });
      if (created.kind !== 'ok') {
        throw new Error(
          `catalogue fixture: creating shift type ${definition.code} reported ${created.kind}`,
        );
      }
      shiftTypeIds.push(created.value.shiftTypeId);

      // `shift_type_weekday_demand` needs rows of its own, or the probe over it
      // is the vacuous one this module exists to prevent.
      const demand = await catalogue.setWeekdayDemand(uow, created.value.shiftTypeId, {
        demand: [
          { day: 'mon', demandCount: 2 },
          { day: 'sat', demandCount: 1 },
          { day: 'holiday', demandCount: 1 },
        ],
      });
      if (demand.kind !== 'ok') {
        throw new Error(`catalogue fixture: setting demand reported ${demand.kind}`);
      }
    }

    const shiftGroup = await catalogue.createShiftGroup(uow, {
      name: 'On-call bundle',
      description: null,
      scoring: { scoringMode: 'weighted', weight: 1000 },
      request: { allowRequest: true, requestOffLabel: 'Request off all on-call shifts' },
      shiftTypeIds,
    });
    if (shiftGroup.kind !== 'ok') {
      throw new Error(`catalogue fixture: creating a shift group reported ${shiftGroup.kind}`);
    }
    shiftGroupId = shiftGroup.value.shiftGroupId;

    const staffGroup = await catalogue.createStaffGroup(uow, {
      name: 'Theatre-eligible pool',
      description: null,
      // The acting scheduler's own membership: visible in this group by
      // construction, so the visibility check has something real to pass.
      membershipIds: [alpha.users.scheduler.membershipId],
    });
    if (staffGroup.kind !== 'ok') {
      throw new Error(`catalogue fixture: creating a staff group reported ${staffGroup.kind}`);
    }
    staffGroupId = staffGroup.value.staffGroupId;
  });

  /* ── the two group-SETTINGS keys, reached the way production reaches them ───
   *
   * `group.holiday_calendar.administer` and `group.pick_positions.administer`
   * are group-administrator keys (doc 08 §6 "Group settings"), and the `core`
   * MULTI profile provisions no group administrator. Rather than seed only on
   * the `full` profile — which would leave `group_holidays` with no rows and the
   * non-vacuity assertions failing on every other file — the fixture GRANTS the
   * two keys to the scheduler's membership through `capability_grants`, which is
   * the production mechanism for exactly this (SPEC-06 L4.2).
   *
   * It is written under an ORGANIZATION-scoped context by the organization
   * administrator, because `capability_grants_organization_administration`
   * requires both. The administrator and the scheduler are different USERS, so
   * `app_guard_capability_grant_administration`'s two-person rule is satisfied
   * rather than worked around. */
  await runtime.run(
    {
      organizationId: alpha.organizationId,
      groupId: null,
      membershipId: alpha.users.organizationAdmin.membershipId,
      correlationId: `catalogue-fixture-grant-${fixture.slug}`,
    },
    async ({ query }) => {
      await query
        .insertInto('capability_grants')
        .values([
          ...['group.holiday_calendar.administer', 'group.pick_positions.administer'].map(
            (key) => ({
              id: randomUUID(),
              organization_id: alpha.organizationId,
              group_id: alpha.groupOne.id,
              membership_id: alpha.users.scheduler.membershipId,
              capability_key: key,
              granted: true,
              granted_by_membership_id: alpha.users.organizationAdmin.membershipId,
            }),
          ),
          // The SIBLING group's author. Granted rather than assumed: Beta's
          // Group Two membership holds `member`, which carries nothing, and a
          // fixture that only worked on Alpha would leave Beta's cross-group arm
          // as vacuous as Alpha's used to be.
          ...['schedule.catalogue.administer', 'group.holiday_calendar.administer'].map((key) => ({
            id: randomUUID(),
            organization_id: alpha.organizationId,
            group_id: sibling.groupId,
            membership_id: sibling.membershipId,
            capability_key: key,
            granted: true,
            granted_by_membership_id: alpha.users.organizationAdmin.membershipId,
          })),
        ])
        .execute();
    },
  );

  let holidaySeeded = false;

  await runtime.run(authorContext, async (uow) => {
    const raised = await catalogue.setPickPositionCount(uow, 4);
    if (raised.kind !== 'ok') {
      throw new Error(`catalogue fixture: raising pick positions reported ${raised.kind}`);
    }

    const holiday = await catalogue.createGroupHoliday(uow, {
      // A fixed, obviously synthetic date. No real calendar is implied.
      holidayDate: '2027-01-01',
      name: 'Synthetic public holiday',
      observed: true,
    });
    if (holiday.kind !== 'ok') {
      throw new Error(`catalogue fixture: creating a holiday reported ${holiday.kind}`);
    }
    holidaySeeded = true;
  });

  // `valid_groups` and `valid_group_shift_types` come last: the trigger checks
  // each position against the group's ceiling, so the ceiling has to be raised
  // before positions above zero are legal.
  await runtime.run(authorContext, async (uow) => {
    const validGroup = await catalogue.createValidGroup(uow, {
      name: 'Call with picks',
      shiftTypeIds,
      allowedPickPositions: [1, 2, 3],
    });
    if (validGroup.kind !== 'ok') {
      throw new Error(`catalogue fixture: creating a valid group reported ${validGroup.kind}`);
    }
    validGroupId = validGroup.value.validGroupId;
  });

  /* ── the SIBLING group ───────────────────────────────────────────────────
   *
   * Enough of a catalogue for the cross-GROUP arm of the isolation sweep to have
   * something it could see if the group predicate were broken. Every one of the
   * nine tables gets a row here too, so the arm is non-vacuous per table rather
   * than only in aggregate. */
  const siblingContext = groupContext(
    alpha.organizationId,
    sibling.groupId,
    sibling.membershipId,
    `catalogue-fixture-sibling-${fixture.slug}`,
  );

  const siblingShiftTypeIds: string[] = [];
  let siblingHolidaySeeded = false;

  await runtime.run(siblingContext, async (uow) => {
    for (const definition of SHIFT_TYPES) {
      const created = await catalogue.createShiftType(uow, {
        code: definition.code,
        name: `${definition.name} (sibling group)`,
        description: null,
        displayPaletteKey: definition.palette,
        displayTextStyle: 'regular',
        startTime: definition.startTime,
        endTime: definition.endTime,
        isOnCall: definition.onCall,
        attractsStipend: false,
        isManualOnly: false,
        isDailyPick: definition.dailyPick,
        includeInStatistics: true,
        isLeaveOfAbsence: false,
        allowOnRequest: false,
        allowOffRequest: false,
        reportOrder: siblingShiftTypeIds.length,
        creditWeight: 1,
      });
      if (created.kind !== 'ok') {
        throw new Error(`catalogue fixture (sibling): shift type reported ${created.kind}`);
      }
      siblingShiftTypeIds.push(created.value.shiftTypeId);

      const demand = await catalogue.setWeekdayDemand(uow, created.value.shiftTypeId, {
        demand: [
          { day: 'tue', demandCount: 1 },
          { day: 'holiday', demandCount: 2 },
        ],
      });
      if (demand.kind !== 'ok') {
        throw new Error(`catalogue fixture (sibling): demand reported ${demand.kind}`);
      }
    }

    const siblingShiftGroup = await catalogue.createShiftGroup(uow, {
      name: 'Sibling-group bundle',
      description: null,
      scoring: { scoringMode: 'hard' },
      request: { allowRequest: false },
      shiftTypeIds: siblingShiftTypeIds,
    });
    if (siblingShiftGroup.kind !== 'ok') {
      throw new Error(`catalogue fixture (sibling): shift group reported ${siblingShiftGroup.kind}`);
    }

    const siblingStaffGroup = await catalogue.createStaffGroup(uow, {
      name: 'Sibling-group pool',
      description: null,
      membershipIds: [sibling.membershipId],
    });
    if (siblingStaffGroup.kind !== 'ok') {
      throw new Error(`catalogue fixture (sibling): staff group reported ${siblingStaffGroup.kind}`);
    }

    // The sibling group's own ceiling is 0, so an empty position set is the only
    // legal one — which is still a row, which is all the sweep needs.
    const siblingValidGroup = await catalogue.createValidGroup(uow, {
      name: 'Sibling-group combination',
      shiftTypeIds: siblingShiftTypeIds,
      allowedPickPositions: [],
    });
    if (siblingValidGroup.kind !== 'ok') {
      throw new Error(`catalogue fixture (sibling): valid group reported ${siblingValidGroup.kind}`);
    }

    const siblingHoliday = await catalogue.createGroupHoliday(uow, {
      holidayDate: '2027-02-02',
      name: 'Synthetic sibling-group holiday',
      observed: false,
    });
    if (siblingHoliday.kind !== 'ok') {
      throw new Error(`catalogue fixture (sibling): holiday reported ${siblingHoliday.kind}`);
    }
    siblingHolidaySeeded = true;
  });

  if (shiftGroupId === '' || staffGroupId === '' || validGroupId === '') {
    throw new Error('catalogue fixture: a seeded id was never assigned');
  }
  if (siblingShiftTypeIds.length === 0) {
    throw new Error(
      'catalogue fixture: the sibling group received no rows — the cross-group isolation arm ' +
        'would be vacuous, which is the finding this seeding exists to close',
    );
  }

  return {
    shiftTypeIds,
    shiftGroupId,
    staffGroupId,
    validGroupId,
    holidaySeeded,
    sibling: {
      groupId: sibling.groupId,
      shiftTypeIds: siblingShiftTypeIds,
      holidaySeeded: siblingHolidaySeeded,
    },
  };
}

/** A slug component no other fixture in this process will collide with. */
export function catalogueSlug(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}
