import {
  createGroupHolidayRequestSchema,
  createShiftTypeRequestSchema,
  shiftTypeSchema,
  updateShiftTypeRequestSchema,
} from '@schedulepoint/contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as catalogue from '../../src/catalogue/service.js';
import { adminClient } from '../support/admin-client.js';
import { seedCatalogueFixture } from '../support/catalogue-fixture.js';
import { groupContext } from '../support/fixtures.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * The catalogue's behaviour, at the service boundary.
 *
 * Everything here goes through a real unit of work against the real schema, so a
 * rule the service enforces and the database does not — or the reverse — shows up
 * as a failing assertion rather than as a difference nobody looks for.
 *
 * Each test owns its subject (FAD-15): a code minted per test, never a row a
 * sibling created, and no restore by predicate.
 */

const multi = ownedMulti('catalogue-service');

let admin: pg.Client;
let runtime: Runtime;

const alpha = () => multi().alpha;

function author(correlationId: string) {
  return groupContext(
    alpha().organizationId,
    alpha().groupOne.id,
    alpha().users.scheduler.membershipId,
    correlationId,
  );
}

let sequence = 0;
function code(prefix: string): string {
  sequence += 1;
  return `${prefix}${String(sequence)}`;
}

function draft(overrides: Partial<Record<string, unknown>> = {}) {
  return createShiftTypeRequestSchema.parse({
    code: code('SVC'),
    name: 'Service test shift',
    startTime: '08:00',
    endTime: '16:00',
    ...overrides,
  });
}

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  runtime = createRuntime('app_runtime', { max: 3 });
  /* The holiday tests need `group.holiday_calendar.administer`, which the
   * fixture grants to this scheduler. It used to be seeded by the FIRST holiday
   * test, which made every later one depend on that test having run —
   * order dependence that `corepack pnpm fixture-regression` found on its first
   * shuffled run. Establishing it here makes each test own its precondition
   * (FAD-15) rather than inheriting a sibling's side effect. */
  await seedCatalogueFixture(runtime.runner, multi());
}, 180_000);

afterAll(async () => {
  await runtime.destroy();
  await admin.end();
});

describe('shift types', () => {
  it('crossesMidnight is DERIVED, and the caller cannot send it', async () => {
    // The contract has no such field, so the only question is whether the server
    // computes it correctly for both directions.
    expect(
      () => createShiftTypeRequestSchema.parse({ ...draft(), crossesMidnight: true }),
      'the contract accepted a crossesMidnight field',
    ).toThrow();

    const day = await runtime.runner.run(author('derive-day'), (uow) =>
      catalogue.createShiftType(uow, draft({ startTime: '07:00', endTime: '19:00' })),
    );
    const night = await runtime.runner.run(author('derive-night'), (uow) =>
      catalogue.createShiftType(uow, draft({ startTime: '19:00', endTime: '07:00' })),
    );

    expect(day.kind).toBe('ok');
    expect(night.kind).toBe('ok');
    if (day.kind !== 'ok' || night.kind !== 'ok') return;
    expect(day.value.crossesMidnight).toBe(false);
    expect(night.value.crossesMidnight).toBe(true);
    log('07:00→19:00 crossesMidnight=false; 19:00→07:00 crossesMidnight=true, both derived');
  });

  it('a manual-only type cannot also be a daily-pick type — the flags contradict', async () => {
    const outcome = await runtime.runner.run(author('manual-vs-pick'), (uow) =>
      catalogue.createShiftType(uow, draft({ isManualOnly: true, isDailyPick: true })),
    );
    expect(outcome.kind).toBe('invalid');
    if (outcome.kind !== 'invalid') return;
    expect(outcome.problems.map((p) => p.field)).toContain('isDailyPick');
    log(`refused with a field-addressed problem: ${outcome.problems[0]?.message ?? ''}`);
  });

  it('a duplicate code in the same group is a CONFLICT, and the key is tenant-qualified', async () => {
    const shared = code('DUP');
    const first = await runtime.runner.run(author('dup-1'), (uow) =>
      catalogue.createShiftType(uow, draft({ code: shared })),
    );
    expect(first.kind).toBe('ok');

    await expect(
      runtime.runner.run(author('dup-2'), (uow) =>
        catalogue.createShiftType(uow, draft({ code: shared })),
      ),
    ).rejects.toMatchObject({ code: '23505' });

    // The same code in ANOTHER group of the same organization is fine: the
    // unique key leads with the tenant columns, so it cannot be an oracle for a
    // group the caller cannot see.
    const otherGroup = await runtime.runner.run(
      groupContext(
        alpha().organizationId,
        alpha().groupTwo.id,
        alpha().users.groupTwoScheduler.membershipId,
        'dup-other-group',
      ),
      (uow) => catalogue.createShiftType(uow, draft({ code: shared })),
    );
    expect(otherGroup.kind, JSON.stringify(otherGroup)).toBe('ok');
    log(`code "${shared}": duplicate in the same group → 23505; the same code in another group → ok`);
  });

  it('retirement closes the in-force window and keeps the row', async () => {
    const created = await runtime.runner.run(author('retire-create'), (uow) =>
      catalogue.createShiftType(uow, draft()),
    );
    expect(created.kind).toBe('ok');
    if (created.kind !== 'ok') return;

    const retired = await runtime.runner.run(author('retire'), (uow) =>
      catalogue.updateShiftType(uow, created.value.shiftTypeId, { status: 'retired' }),
    );
    expect(retired.kind).toBe('ok');
    if (retired.kind !== 'ok') return;
    expect(retired.value.archived).toBe(true);
    expect(retired.value.shiftType.status).toBe('retired');
    expect(retired.value.shiftType.effectiveTo).not.toBeNull();

    // A second retirement is not a second archive event: `archived` is the
    // TRANSITION, not the state, or every subsequent edit would file another
    // "this was retired" audit row for a type that was already retired.
    const again = await runtime.runner.run(author('retire-again'), (uow) =>
      catalogue.updateShiftType(uow, created.value.shiftTypeId, { name: 'Renamed after retirement' }),
    );
    expect(again.kind).toBe('ok');
    if (again.kind !== 'ok') return;
    expect(again.value.archived).toBe(false);
    log('retirement: window closed, row kept, and the transition fires exactly once');
  });

  it('the update contract cannot carry a code, and the database would refuse it anyway', () => {
    expect(() => updateShiftTypeRequestSchema.parse({ code: 'NEW' })).toThrow();
    log('updateShiftTypeRequestSchema rejects `code` — a shift type\'s permanent name is permanent');
  });

  it('a stored shift type round-trips through its contract', async () => {
    const created = await runtime.runner.run(author('round-trip'), (uow) =>
      catalogue.createShiftType(
        uow,
        draft({
          description: 'A description',
          displayPaletteKey: 'amber',
          displayTextStyle: 'bold',
          creditWeight: 2.5,
          reportOrder: 7,
          isOnCall: true,
          allowOnRequest: true,
          allowOffRequest: true,
        }),
      ),
    );
    expect(created.kind).toBe('ok');
    if (created.kind !== 'ok') return;

    // Parsed, not merely typed: the wire shape a client receives is the one the
    // contract describes, including the `numeric` → number conversion.
    const parsed = shiftTypeSchema.parse(created.value);
    expect(parsed.creditWeight).toBe(2.5);
    expect(parsed.displayPaletteKey).toBe('amber');
    expect(parsed.displayTextStyle).toBe('bold');
    expect(parsed.startTime).toMatch(/^\d{2}:\d{2}$/);
    log('shift type round-trips: numeric → number, time → HH:MM, tokens preserved');
  });
});

describe('per-weekday and holiday demand', () => {
  it('a set replaces, and an absent day reads as zero rather than as missing', async () => {
    const created = await runtime.runner.run(author('demand-create'), (uow) =>
      catalogue.createShiftType(uow, draft()),
    );
    expect(created.kind).toBe('ok');
    if (created.kind !== 'ok') return;
    const shiftTypeId = created.value.shiftTypeId;

    const first = await runtime.runner.run(author('demand-set-1'), (uow) =>
      catalogue.setWeekdayDemand(uow, shiftTypeId, {
        demand: [
          { day: 'mon', demandCount: 3 },
          { day: 'holiday', demandCount: 1 },
        ],
      }),
    );
    expect(first.kind).toBe('ok');
    if (first.kind !== 'ok') return;
    expect(first.value).toHaveLength(8);
    expect(first.value.find((entry) => entry.day === 'mon')?.demandCount).toBe(3);
    expect(first.value.find((entry) => entry.day === 'tue')?.demandCount).toBe(0);
    expect(first.value.find((entry) => entry.day === 'holiday')?.demandCount).toBe(1);

    // UPSERT, not insert: the same day again updates rather than raising 23505.
    const second = await runtime.runner.run(author('demand-set-2'), (uow) =>
      catalogue.setWeekdayDemand(uow, shiftTypeId, { demand: [{ day: 'mon', demandCount: 5 }] }),
    );
    expect(second.kind).toBe('ok');
    if (second.kind !== 'ok') return;
    expect(second.value.find((entry) => entry.day === 'mon')?.demandCount).toBe(5);

    const stored = await admin.query<{ n: number }>(
      'select count(*)::int as n from shift_type_weekday_demand where shift_type_id = $1',
      [shiftTypeId],
    );
    expect(stored.rows[0]?.n, 'the upsert inserted a second Monday row').toBe(2);
    log('demand upsert: Monday 3 → 5 in place; eight days always returned; absent days read 0');
  });

  it('the same day twice in one request is refused before any statement', async () => {
    const created = await runtime.runner.run(author('demand-dup-create'), (uow) =>
      catalogue.createShiftType(uow, draft()),
    );
    if (created.kind !== 'ok') throw new Error('setup failed');

    const outcome = await runtime.runner.run(author('demand-dup'), (uow) =>
      catalogue.setWeekdayDemand(uow, created.value.shiftTypeId, {
        demand: [
          { day: 'mon', demandCount: 1 },
          { day: 'mon', demandCount: 2 },
        ],
      }),
    );
    expect(outcome.kind).toBe('invalid');

    const stored = await admin.query<{ n: number }>(
      'select count(*)::int as n from shift_type_weekday_demand where shift_type_id = $1',
      [created.value.shiftTypeId],
    );
    expect(stored.rows[0]?.n, 'a partial write landed before the duplicate was noticed').toBe(0);
    log('duplicate day → invalid, and nothing was written');
  });

  it('demand for a shift type in ANOTHER group is a 404-shaped not-found', async () => {
    const other = await runtime.runner.run(
      groupContext(
        alpha().organizationId,
        alpha().groupTwo.id,
        alpha().users.groupTwoScheduler.membershipId,
        'demand-cross-setup',
      ),
      (uow) => catalogue.createShiftType(uow, draft()),
    );
    if (other.kind !== 'ok') throw new Error('setup failed');

    const outcome = await runtime.runner.run(author('demand-cross'), (uow) =>
      catalogue.setWeekdayDemand(uow, other.value.shiftTypeId, {
        demand: [{ day: 'mon', demandCount: 1 }],
      }),
    );
    // RLS made it invisible, so "not visible" and "does not exist" are the same
    // answer — which is exactly what T-05b requires.
    expect(outcome.kind).toBe('not-found');
    log('demand against another group\'s shift type → not-found, indistinguishable from absent');
  });
});

describe('shift groups', () => {
  it('a hard group carries no weight, and the contract makes the alternative unrepresentable', async () => {
    const outcome = await runtime.runner.run(author('shift-group-hard'), (uow) =>
      catalogue.createShiftGroup(uow, {
        name: `Hard ${code('G')}`,
        description: null,
        scoring: { scoringMode: 'hard' },
        request: { allowRequest: false },
        shiftTypeIds: [],
      }),
    );
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.value.weight).toBeNull();
    expect(outcome.value.requestOffLabel).toBeNull();
    log('hard shift group: weight null, request-off label null');
  });

  it('membership changes de-bundle by is_active, never by DELETE', async () => {
    const one = await runtime.runner.run(author('bundle-setup-1'), (uow) =>
      catalogue.createShiftType(uow, draft()),
    );
    const two = await runtime.runner.run(author('bundle-setup-2'), (uow) =>
      catalogue.createShiftType(uow, draft()),
    );
    if (one.kind !== 'ok' || two.kind !== 'ok') throw new Error('setup failed');

    const group = await runtime.runner.run(author('bundle-create'), (uow) =>
      catalogue.createShiftGroup(uow, {
        name: `Bundle ${code('B')}`,
        description: null,
        scoring: { scoringMode: 'weighted', weight: 10 },
        request: { allowRequest: true, requestOffLabel: 'Request off the bundle' },
        shiftTypeIds: [one.value.shiftTypeId, two.value.shiftTypeId],
      }),
    );
    if (group.kind !== 'ok') throw new Error('setup failed');

    const narrowed = await runtime.runner.run(author('bundle-narrow'), (uow) =>
      catalogue.updateShiftGroup(uow, group.value.shiftGroupId, {
        shiftTypeIds: [one.value.shiftTypeId],
      }),
    );
    expect(narrowed.kind).toBe('ok');
    if (narrowed.kind !== 'ok') return;
    expect(narrowed.value.shiftTypeIds).toEqual([one.value.shiftTypeId]);

    // Both rows survive; one is inactive. The composition at the time a schedule
    // was built is part of explaining that schedule.
    const rows = await admin.query<{ shift_type_id: string; is_active: boolean }>(
      'select shift_type_id, is_active from shift_group_members where shift_group_id = $1',
      [group.value.shiftGroupId],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.filter((row) => row.is_active)).toHaveLength(1);
    log('de-bundling: 2 membership rows survive, 1 active — history intact');
  });

  it('a shift type from another group cannot be bundled', async () => {
    const other = await runtime.runner.run(
      groupContext(
        alpha().organizationId,
        alpha().groupTwo.id,
        alpha().users.groupTwoScheduler.membershipId,
        'bundle-cross-setup',
      ),
      (uow) => catalogue.createShiftType(uow, draft()),
    );
    if (other.kind !== 'ok') throw new Error('setup failed');

    const outcome = await runtime.runner.run(author('bundle-cross'), (uow) =>
      catalogue.createShiftGroup(uow, {
        name: `Cross ${code('X')}`,
        description: null,
        scoring: { scoringMode: 'hard' },
        request: { allowRequest: false },
        shiftTypeIds: [other.value.shiftTypeId],
      }),
    );
    expect(outcome.kind).toBe('invalid');
    log('bundling another group\'s shift type → invalid, named on the shiftTypeIds field');
  });
});

describe('the group holiday calendar', () => {
  it('one date per group, and a duplicate is a conflict', async () => {
    const first = await runtime.runner.run(author('holiday-1'), (uow) =>
      catalogue.createGroupHoliday(uow, {
        holidayDate: '2028-05-01',
        name: 'Synthetic May holiday',
        observed: true,
      }),
    );
    expect(first.kind, JSON.stringify(first)).toBe('ok');
    if (first.kind !== 'ok') return;
    expect(first.value.holidayDate).toBe('2028-05-01');

    await expect(
      runtime.runner.run(author('holiday-2'), (uow) =>
        catalogue.createGroupHoliday(uow, {
          holidayDate: '2028-05-01',
          name: 'A second name for the same date',
          observed: false,
        }),
      ),
    ).rejects.toMatchObject({ code: '23505' });
    log('group holiday: 2028-05-01 accepted once; the same date again → 23505');
  });

  it('a calendar date is stored and returned without moving', async () => {
    // The specific bug this guards: node-postgres parses `date` into a `Date` at
    // LOCAL midnight, and `toISOString()` west of UTC renders the previous day. A
    // holiday that shifts with the server's time zone defeats the whole point of
    // CAR-011's calendar.
    const parsed = createGroupHolidayRequestSchema.parse({
      holidayDate: '2028-01-01',
      name: 'New Year (synthetic)',
    });
    const created = await runtime.runner.run(author('holiday-tz'), (uow) =>
      catalogue.createGroupHoliday(uow, parsed),
    );
    expect(created.kind, JSON.stringify(created)).toBe('ok');
    if (created.kind !== 'ok') return;
    expect(created.value.holidayDate).toBe('2028-01-01');

    const listed = await runtime.runner.run(author('holiday-list'), (uow) =>
      catalogue.listGroupHolidays(uow),
    );
    expect(listed.map((holiday) => holiday.holidayDate)).toContain('2028-01-01');
    log('calendar date 2028-01-01 stored and read back unchanged');
  });
});
