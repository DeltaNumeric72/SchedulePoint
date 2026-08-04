import { randomUUID } from 'node:crypto';

import type {
  CreateGroupHolidayRequest,
  CreateShiftGroupRequest,
  CreateShiftTypeRequest,
  CreateStaffGroupRequest,
  CreateValidGroupRequest,
  GroupHoliday,
  SetShiftTypeQualificationsRequest,
  SetWeekdayDemandRequest,
  ShiftGroup,
  ShiftType,
  ShiftTypeEligibility,
  ShiftTypeQualification,
  StaffGroup,
  UpdateShiftGroupRequest,
  UpdateShiftTypeRequest,
  ValidGroup,
} from '@schedulepoint/contracts';
import {
  CATALOGUE_DAYS,
  canonicalPickPositions,
  crossesMidnight,
  effectiveWindowProblems,
  isEligibleAt,
  pickPositionIncreaseProblems,
  pickPositionProblems,
  shiftTypeProblems,
  type CatalogueDay,
  type FieldProblem,
  type TenantContext,
  type UnitOfWork,
} from '@schedulepoint/domain';
import { sql, type Kysely } from 'kysely';

import type { Database } from '../db/schema.js';
import { loadHoldings } from '../profiles/in-force-loader.js';
import {
  shiftGroupToWire,
  shiftTypeToWire,
  staffGroupToWire,
  timeFromWire,
  validGroupToWire,
  type ShiftGroupRow,
  type ShiftTypeRow,
  type StaffGroupRow,
  type ValidGroupRow,
} from './mapping.js';

/**
 * The catalogue's domain services.
 *
 * ## Every function takes a unit of work, and none of them opens one
 *
 * I-15 and non-bypass rule 1: the transaction boundary belongs to
 * `PgUnitOfWorkRunner`, and a service that could start its own would be a second
 * place where "authorize, then mutate, then audit, all in one transaction"
 * (FAD-12) could be got wrong. The route opens exactly one unit of work per
 * request, evaluates inside it, and hands the same handle to whichever function
 * below it needs.
 *
 * ## Validation happens twice, and the second time is the one that counts
 *
 * These functions call the pure rules in `@schedulepoint/domain` so a bad
 * request produces a field-addressed `422` instead of a `500` with a SQLSTATE.
 * **The database enforces every one of the same rules independently** — CHECK
 * constraints, composite foreign keys, triggers — so a bug here produces a
 * refused statement rather than a bad row. The check in this file is a courtesy
 * to the authoring form; the check in the database is the control.
 *
 * ## Nothing here reads a tenant identifier from its arguments
 *
 * `organization_id` and `group_id` always come from `uow.context`, never from a
 * request body or a path parameter. A service that could be told which tenant to
 * write into is a service that can be told the wrong one, and RLS would only
 * catch it because the policy happens to pin both columns.
 */

export type CatalogueOutcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'invalid'; readonly problems: readonly FieldProblem[] }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'conflict' };

type Uow = UnitOfWork<Kysely<Database>>;

/** The tenant coordinates every statement below is pinned to. Never from a body. */
function tenantOf(context: TenantContext): { organization_id: string; group_id: string } {
  const { organizationId, groupId } = context;
  if (groupId === null) {
    // Unreachable through the routes: every catalogue route declares
    // `actionScope: 'group'`, and SPEC-01 §2.1's group branch refuses a request
    // with no group. Thrown rather than defaulted, because a catalogue write
    // with no group would be a row the group predicate can never see again.
    throw new Error(
      'CATALOGUE_REQUIRES_GROUP_CONTEXT: a catalogue statement was reached under an ' +
        'organization-scoped unit of work',
    );
  }
  return { organization_id: organizationId, group_id: groupId };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Shift types
 * ──────────────────────────────────────────────────────────────────────────── */

const SHIFT_TYPE_COLUMNS = [
  'id',
  'code',
  'name',
  'description',
  'display_palette_key',
  'display_text_style',
  'start_time',
  'end_time',
  'crosses_midnight',
  'is_on_call',
  'attracts_stipend',
  'is_manual_only',
  'is_daily_pick',
  'include_in_statistics',
  'is_leave_of_absence',
  'allow_on_request',
  'allow_off_request',
  'report_order',
  'credit_weight',
  'status',
  'effective_from',
  'effective_to',
  'version',
] as const;

export async function listShiftTypes(uow: Uow): Promise<readonly ShiftType[]> {
  const rows = (await uow.query
    .selectFrom('shift_types')
    .select(SHIFT_TYPE_COLUMNS)
    .orderBy('report_order')
    .orderBy('code')
    .execute()) as unknown as ShiftTypeRow[];
  return rows.map(shiftTypeToWire);
}

export async function createShiftType(
  uow: Uow,
  body: CreateShiftTypeRequest,
): Promise<CatalogueOutcome<ShiftType>> {
  const problems = shiftTypeProblems({
    code: body.code,
    name: body.name,
    description: body.description,
    displayPaletteKey: body.displayPaletteKey,
    displayTextStyle: body.displayTextStyle,
    startTime: body.startTime,
    endTime: body.endTime,
    isOnCall: body.isOnCall,
    attractsStipend: body.attractsStipend,
    isManualOnly: body.isManualOnly,
    isDailyPick: body.isDailyPick,
    includeInStatistics: body.includeInStatistics,
    isLeaveOfAbsence: body.isLeaveOfAbsence,
    allowOnRequest: body.allowOnRequest,
    allowOffRequest: body.allowOffRequest,
    reportOrder: body.reportOrder,
    creditWeight: body.creditWeight,
  });
  if (problems.length > 0) return { kind: 'invalid', problems };

  // DERIVED, never taken from the caller. The contract has no `crossesMidnight`
  // field to take it from, and the database CHECK refuses a row where the flag
  // and the two times disagree — so this is the only place the value is decided.
  const overnight = crossesMidnight(body.startTime, body.endTime);
  if (overnight === null) {
    return { kind: 'invalid', problems: [{ field: 'startTime', message: 'Enter a valid time.' }] };
  }

  const windowProblems = effectiveWindowProblems(body.effectiveFrom, body.effectiveTo);
  if (windowProblems.length > 0) return { kind: 'invalid', problems: windowProblems };

  // SERVER-GENERATED. A caller-chosen primary key is an existence oracle:
  // uniqueness is checked outside RLS (X-11), so a 23505 on an id that exists
  // only in another tenant would disclose that it exists.
  const id = randomUUID();

  const rows = (await uow.query
    .insertInto('shift_types')
    .values({
      id,
      ...tenantOf(uow.context),
      code: body.code,
      name: body.name,
      description: body.description,
      display_palette_key: body.displayPaletteKey,
      display_text_style: body.displayTextStyle,
      start_time: timeFromWire(body.startTime),
      end_time: timeFromWire(body.endTime),
      crosses_midnight: overnight,
      is_on_call: body.isOnCall,
      attracts_stipend: body.attractsStipend,
      is_manual_only: body.isManualOnly,
      is_daily_pick: body.isDailyPick,
      include_in_statistics: body.includeInStatistics,
      is_leave_of_absence: body.isLeaveOfAbsence,
      allow_on_request: body.allowOnRequest,
      allow_off_request: body.allowOffRequest,
      report_order: body.reportOrder,
      credit_weight: body.creditWeight.toFixed(3),
      // S-03: authorable. Absent means "in force from now", which is the column
      // default; a supplied instant means a definition authored ahead of a rota
      // change, which is the case effective dating exists for.
      ...(body.effectiveFrom === undefined ? {} : { effective_from: new Date(body.effectiveFrom) }),
      ...(body.effectiveTo === undefined || body.effectiveTo === null
        ? {}
        : { effective_to: new Date(body.effectiveTo) }),
    })
    .returning(SHIFT_TYPE_COLUMNS)
    .execute()) as unknown as ShiftTypeRow[];

  const row = rows[0];
  if (row === undefined) return { kind: 'not-found' };
  return { kind: 'ok', value: shiftTypeToWire(row) };
}

export async function updateShiftType(
  uow: Uow,
  shiftTypeId: string,
  body: UpdateShiftTypeRequest,
): Promise<CatalogueOutcome<{ shiftType: ShiftType; archived: boolean }>> {
  const existingRows = (await uow.query
    .selectFrom('shift_types')
    .select(SHIFT_TYPE_COLUMNS)
    .where('id', '=', shiftTypeId)
    .execute()) as unknown as ShiftTypeRow[];
  const existing = existingRows[0];
  // RLS already restricted this to the declared group, so "not visible" and "does
  // not exist" are the same answer and are given the same response (T-05b).
  if (existing === undefined) return { kind: 'not-found' };

  const merged = {
    code: existing.code,
    name: body.name ?? existing.name,
    description: body.description === undefined ? existing.description : body.description,
    displayPaletteKey: body.displayPaletteKey ?? existing.display_palette_key,
    displayTextStyle: body.displayTextStyle ?? existing.display_text_style,
    startTime: body.startTime ?? existing.start_time.slice(0, 5),
    endTime: body.endTime ?? existing.end_time.slice(0, 5),
    isOnCall: body.isOnCall ?? existing.is_on_call,
    attractsStipend: body.attractsStipend ?? existing.attracts_stipend,
    isManualOnly: body.isManualOnly ?? existing.is_manual_only,
    isDailyPick: body.isDailyPick ?? existing.is_daily_pick,
    includeInStatistics: body.includeInStatistics ?? existing.include_in_statistics,
    isLeaveOfAbsence: body.isLeaveOfAbsence ?? existing.is_leave_of_absence,
    allowOnRequest: body.allowOnRequest ?? existing.allow_on_request,
    allowOffRequest: body.allowOffRequest ?? existing.allow_off_request,
    reportOrder: body.reportOrder ?? existing.report_order,
    creditWeight: body.creditWeight ?? Number(existing.credit_weight),
  };

  const problems = shiftTypeProblems(merged);
  if (problems.length > 0) return { kind: 'invalid', problems };

  const overnight = crossesMidnight(merged.startTime, merged.endTime);
  if (overnight === null) {
    return { kind: 'invalid', problems: [{ field: 'startTime', message: 'Enter a valid time.' }] };
  }

  const status = body.status ?? existing.status;
  const archived = status === 'retired' && existing.status !== 'retired';
  const now = new Date();

  // S-03: the in-force window is AUTHORABLE. `undefined` leaves it alone;
  // `null` on `effectiveTo` opens the window deliberately. The two are different
  // requests and the contract keeps them distinguishable.
  const effectiveFrom =
    body.effectiveFrom === undefined ? existing.effective_from : new Date(body.effectiveFrom);
  const effectiveTo =
    body.effectiveTo === undefined
      ? existing.effective_to
      : body.effectiveTo === null
        ? null
        : new Date(body.effectiveTo);

  /* ── validate the CALLER'S window, never a rounded copy of the stored one ──
   *
   * This used to run on every update, merging stored values in. It produced an
   * intermittent, entirely spurious `invalid`: `timestamptz` has MICROSECOND
   * resolution and a JavaScript `Date` has MILLISECOND resolution, so a window
   * whose bounds are less than a millisecond apart — which is exactly what
   * retiring a just-created definition produces — reads back with
   * `effectiveTo === effectiveFrom` and fails a check it satisfies in the
   * database. The row was fine; the round trip was lossy.
   *
   * The check exists to give the caller field-addressed feedback about what THEY
   * sent, so it runs when they sent something and not otherwise. The database's
   * `shift_types_window` CHECK is the control either way, and it compares the
   * real microsecond values rather than a truncation of them. */
  if (body.effectiveFrom !== undefined || body.effectiveTo !== undefined) {
    const windowProblems = effectiveWindowProblems(
      effectiveFrom.toISOString(),
      effectiveTo === null ? null : effectiveTo.toISOString(),
    );
    if (windowProblems.length > 0) return { kind: 'invalid', problems: windowProblems };
  }

  const rows = (await uow.query
    .updateTable('shift_types')
    .set({
      name: merged.name,
      description: merged.description,
      display_palette_key: merged.displayPaletteKey,
      display_text_style: merged.displayTextStyle,
      start_time: timeFromWire(merged.startTime),
      end_time: timeFromWire(merged.endTime),
      crosses_midnight: overnight,
      is_on_call: merged.isOnCall,
      attracts_stipend: merged.attractsStipend,
      is_manual_only: merged.isManualOnly,
      is_daily_pick: merged.isDailyPick,
      include_in_statistics: merged.includeInStatistics,
      is_leave_of_absence: merged.isLeaveOfAbsence,
      allow_on_request: merged.allowOnRequest,
      allow_off_request: merged.allowOffRequest,
      report_order: merged.reportOrder,
      credit_weight: merged.creditWeight.toFixed(3),
      status,
      /* ── an UNTOUCHED window column is not written at all ─────────────────
       *
       * It used to be written back unconditionally, from the value this
       * transaction had just read. That is a lossy round trip: `timestamptz`
       * holds microseconds and a JavaScript `Date` holds milliseconds, so
       * rewriting an untouched `effective_to` TRUNCATED it — and a window
       * narrower than a millisecond (exactly what retiring a future-dated
       * definition produces) collapsed onto its own start and violated
       * `shift_types_window`. The row was valid until an edit that did not
       * mention it made it invalid.
       *
       * So the columns are in the SET only when something actually changes
       * them: the caller supplied a value, or this is the retirement that closes
       * the window. */
      ...(body.effectiveFrom === undefined ? {} : { effective_from: effectiveFrom }),
      ...(body.effectiveTo !== undefined
        ? { effective_to: effectiveTo }
        : archived
          ? {
              /* The retirement instant comes from the DATABASE, not from here.
               *
               * `effective_from` is `DEFAULT now()` — microsecond resolution —
               * and a JavaScript `Date` is millisecond resolution. Closing the
               * window with an application-supplied instant compared two clocks
               * at two resolutions against `effective_to > effective_from`, and
               * it failed twice over: intermittently, for a type created and
               * retired inside the same millisecond (which is what the shuffled
               * full-suite run caught); and deterministically, once S-03 made
               * windows authorable, for a definition that comes into force next
               * year — "now" is before it started, so retirement was impossible.
               *
               * `greatest(now(), effective_from + 1µs)` closes the window at the
               * current instant but never before it opened, which makes
               * retirement total. */
              effective_to: sql<Date>`greatest(now(), effective_from + interval '1 microsecond')`,
            }
          : {}),
      // `version` is DELIBERATELY absent: the database assigns it
      // (`app_maintain_catalogue_version`) and no runtime role holds a grant on
      // the column, so naming it here would raise 42501.
      updated_at: now,
    })
    .where('id', '=', shiftTypeId)
    /* ── S-05: optimistic concurrency, as a PREDICATE ──────────────────────
     *
     * The row was read at the top of this function, inside this same unit of
     * work. If another transaction has committed a change since, its trigger has
     * moved `version` and this predicate matches nothing — so the SELECT-merge-
     * UPDATE sequence cannot silently overwrite it.
     *
     * An independent review demonstrated exactly that lost update while the
     * counter was only being incremented rather than checked. */
    .where('version', '=', existing.version)
    .returning(SHIFT_TYPE_COLUMNS)
    .execute()) as unknown as ShiftTypeRow[];

  const row = rows[0];
  // Zero rows means the version moved: the row still exists, and this caller's
  // read of it is stale. That is a CONFLICT, not a not-found — telling the
  // caller "it is gone" when it is merely newer would send them to create a
  // duplicate.
  if (row === undefined) return { kind: 'conflict' };
  return { kind: 'ok', value: { shiftType: shiftTypeToWire(row), archived } };
}

export interface DemandEntry {
  readonly day: CatalogueDay;
  readonly demandCount: number;
}

/**
 * Replaces the whole demand set for one shift type, in one statement per day.
 *
 * One request, not eight (I-10): a demand form is one user action with eight
 * fields, and eight PATCHes would be request amplification in REST costume.
 */
export async function setWeekdayDemand(
  uow: Uow,
  shiftTypeId: string,
  body: SetWeekdayDemandRequest,
): Promise<CatalogueOutcome<readonly DemandEntry[]>> {
  const seen = new Set<string>();
  for (const entry of body.demand) {
    if (seen.has(entry.day)) {
      return {
        kind: 'invalid',
        problems: [{ field: `demand.${entry.day}`, message: 'Each day appears at most once.' }],
      };
    }
    seen.add(entry.day);
  }

  const owner = (await uow.query
    .selectFrom('shift_types')
    .select('id')
    .where('id', '=', shiftTypeId)
    .execute()) as unknown as { id: string }[];
  if (owner[0] === undefined) return { kind: 'not-found' };

  const tenant = tenantOf(uow.context);
  const now = new Date();

  for (const entry of body.demand) {
    await uow.query
      .insertInto('shift_type_weekday_demand')
      .values({
        id: randomUUID(),
        ...tenant,
        shift_type_id: shiftTypeId,
        day: entry.day,
        demand_count: entry.demandCount,
      })
      // The tenant-qualified unique key is the conflict target, so the upsert can
      // only ever match a row in the caller's own group. `(shift_type_id, day)`
      // alone would be a target the RLS predicate does not cover.
      .onConflict((oc) =>
        oc
          .columns(['organization_id', 'group_id', 'shift_type_id', 'day'])
          .doUpdateSet({ demand_count: entry.demandCount, updated_at: now }),
      )
      .execute();
  }

  return { kind: 'ok', value: await readWeekdayDemand(uow, shiftTypeId) };
}

export async function readWeekdayDemand(
  uow: Uow,
  shiftTypeId: string,
): Promise<readonly DemandEntry[]> {
  const rows = (await uow.query
    .selectFrom('shift_type_weekday_demand')
    .select(['day', 'demand_count'])
    .where('shift_type_id', '=', shiftTypeId)
    .execute()) as unknown as { day: CatalogueDay; demand_count: number }[];
  const byDay = new Map(rows.map((row) => [row.day, row.demand_count]));
  // Returned in CATALOGUE_DAYS order with absent days as zero, so the authoring
  // form renders eight controls whether or not eight rows exist. An absent row
  // means "no demand declared", which is zero demand.
  return CATALOGUE_DAYS.map((day) => ({ day, demandCount: byDay.get(day) ?? 0 }));
}

/* ────────────────────────────────────────────────────────────────────────────
 * Shift groups
 * ──────────────────────────────────────────────────────────────────────────── */

const SHIFT_GROUP_COLUMNS = [
  'id',
  'name',
  'description',
  'scoring_mode',
  'weight',
  'allow_request',
  'request_off_label',
  'status',
  'version',
] as const;

async function shiftGroupMemberIds(uow: Uow, shiftGroupIds: readonly string[]) {
  if (shiftGroupIds.length === 0) return new Map<string, string[]>();
  const rows = (await uow.query
    .selectFrom('shift_group_members')
    .select(['shift_group_id', 'shift_type_id'])
    .where('shift_group_id', 'in', shiftGroupIds)
    .where('is_active', '=', true)
    .execute()) as unknown as { shift_group_id: string; shift_type_id: string }[];
  const byGroup = new Map<string, string[]>();
  for (const row of rows) {
    const list = byGroup.get(row.shift_group_id) ?? [];
    list.push(row.shift_type_id);
    byGroup.set(row.shift_group_id, list);
  }
  return byGroup;
}

export async function listShiftGroups(uow: Uow): Promise<readonly ShiftGroup[]> {
  const rows = (await uow.query
    .selectFrom('shift_groups')
    .select(SHIFT_GROUP_COLUMNS)
    .orderBy('name')
    .execute()) as unknown as ShiftGroupRow[];
  const members = await shiftGroupMemberIds(uow, rows.map((row) => row.id));
  return rows.map((row) => shiftGroupToWire(row, members.get(row.id) ?? []));
}

/** Every shift type id that exists in the declared group. The membership check. */
async function visibleShiftTypeIds(uow: Uow, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = (await uow.query
    .selectFrom('shift_types')
    .select('id')
    .where('id', 'in', ids)
    .execute()) as unknown as { id: string }[];
  return new Set(rows.map((row) => row.id));
}

export async function createShiftGroup(
  uow: Uow,
  body: CreateShiftGroupRequest,
): Promise<CatalogueOutcome<ShiftGroup>> {
  const visible = await visibleShiftTypeIds(uow, body.shiftTypeIds);
  const missing = body.shiftTypeIds.filter((id) => !visible.has(id));
  if (missing.length > 0) {
    // Named as a validation problem rather than a 404: the caller holds the
    // catalogue capability in THIS group, so telling them a shift type they
    // named is not in this group discloses nothing they could not read directly.
    return {
      kind: 'invalid',
      problems: [
        { field: 'shiftTypeIds', message: 'One or more of the chosen shift types is not in this group.' },
      ],
    };
  }

  const tenant = tenantOf(uow.context);
  const id = randomUUID();

  const rows = (await uow.query
    .insertInto('shift_groups')
    .values({
      id,
      ...tenant,
      name: body.name,
      description: body.description,
      scoring_mode: body.scoring.scoringMode,
      weight: body.scoring.scoringMode === 'weighted' ? body.scoring.weight.toFixed(3) : null,
      allow_request: body.request.allowRequest,
      request_off_label: body.request.allowRequest ? body.request.requestOffLabel : null,
    })
    .returning(SHIFT_GROUP_COLUMNS)
    .execute()) as unknown as ShiftGroupRow[];

  const row = rows[0];
  if (row === undefined) return { kind: 'not-found' };

  for (const shiftTypeId of body.shiftTypeIds) {
    await uow.query
      .insertInto('shift_group_members')
      .values({ id: randomUUID(), ...tenant, shift_group_id: id, shift_type_id: shiftTypeId })
      .execute();
  }

  return { kind: 'ok', value: shiftGroupToWire(row, body.shiftTypeIds) };
}

export async function updateShiftGroup(
  uow: Uow,
  shiftGroupId: string,
  body: UpdateShiftGroupRequest,
): Promise<CatalogueOutcome<ShiftGroup>> {
  const existingRows = (await uow.query
    .selectFrom('shift_groups')
    .select(SHIFT_GROUP_COLUMNS)
    .where('id', '=', shiftGroupId)
    .execute()) as unknown as ShiftGroupRow[];
  const existing = existingRows[0];
  if (existing === undefined) return { kind: 'not-found' };

  if (body.shiftTypeIds !== undefined) {
    const visible = await visibleShiftTypeIds(uow, body.shiftTypeIds);
    if (body.shiftTypeIds.some((id) => !visible.has(id))) {
      return {
        kind: 'invalid',
        problems: [
          { field: 'shiftTypeIds', message: 'One or more of the chosen shift types is not in this group.' },
        ],
      };
    }
  }

  const now = new Date();
  const scoring = body.scoring;
  const request = body.request;

  const updated = (await uow.query
    .updateTable('shift_groups')
    .set({
      name: body.name ?? existing.name,
      description: body.description === undefined ? existing.description : body.description,
      ...(scoring === undefined
        ? {}
        : {
            scoring_mode: scoring.scoringMode,
            weight: scoring.scoringMode === 'weighted' ? scoring.weight.toFixed(3) : null,
          }),
      ...(request === undefined
        ? {}
        : {
            allow_request: request.allowRequest,
            request_off_label: request.allowRequest ? request.requestOffLabel : null,
          }),
      status: body.status ?? existing.status,
      // `version` is the database's (see `updateShiftType`).
      updated_at: now,
    })
    .where('id', '=', shiftGroupId)
    // S-05: the same optimistic-concurrency predicate, for the same reason.
    .where('version', '=', existing.version)
    .returning('id')
    .execute()) as unknown as { id: string }[];

  if (updated.length === 0) return { kind: 'conflict' };

  if (body.shiftTypeIds !== undefined) {
    const tenant = tenantOf(uow.context);
    const wanted = new Set(body.shiftTypeIds);

    const currentRows = (await uow.query
      .selectFrom('shift_group_members')
      .select(['id', 'shift_type_id', 'is_active'])
      .where('shift_group_id', '=', shiftGroupId)
      .execute()) as unknown as { id: string; shift_type_id: string; is_active: boolean }[];
    const currentByType = new Map(currentRows.map((row) => [row.shift_type_id, row]));

    for (const row of currentRows) {
      const shouldBeActive = wanted.has(row.shift_type_id);
      if (row.is_active !== shouldBeActive) {
        // De-bundling is `is_active = false`, never a DELETE. No runtime role
        // holds DELETE on any tenant table, and the composition of a bundle at
        // the time a schedule was built is part of explaining that schedule.
        await uow.query
          .updateTable('shift_group_members')
          .set({ is_active: shouldBeActive, updated_at: now })
          .where('id', '=', row.id)
          .execute();
      }
    }

    for (const shiftTypeId of wanted) {
      if (currentByType.has(shiftTypeId)) continue;
      await uow.query
        .insertInto('shift_group_members')
        .values({
          id: randomUUID(),
          ...tenant,
          shift_group_id: shiftGroupId,
          shift_type_id: shiftTypeId,
        })
        .execute();
    }
  }

  const finalRows = (await uow.query
    .selectFrom('shift_groups')
    .select(SHIFT_GROUP_COLUMNS)
    .where('id', '=', shiftGroupId)
    .execute()) as unknown as ShiftGroupRow[];
  const final = finalRows[0];
  if (final === undefined) return { kind: 'not-found' };
  const members = await shiftGroupMemberIds(uow, [shiftGroupId]);
  return { kind: 'ok', value: shiftGroupToWire(final, members.get(shiftGroupId) ?? []) };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Staff groups
 * ──────────────────────────────────────────────────────────────────────────── */

const STAFF_GROUP_COLUMNS = ['id', 'name', 'description', 'status', 'version'] as const;

export async function listStaffGroups(uow: Uow): Promise<readonly StaffGroup[]> {
  const rows = (await uow.query
    .selectFrom('staff_groups')
    .select(STAFF_GROUP_COLUMNS)
    .orderBy('name')
    .execute()) as unknown as StaffGroupRow[];
  if (rows.length === 0) return [];

  const memberRows = (await uow.query
    .selectFrom('staff_group_members')
    .select(['staff_group_id', 'membership_id'])
    .where(
      'staff_group_id',
      'in',
      rows.map((row) => row.id),
    )
    .where('is_active', '=', true)
    .execute()) as unknown as { staff_group_id: string; membership_id: string }[];

  const byGroup = new Map<string, string[]>();
  for (const row of memberRows) {
    const list = byGroup.get(row.staff_group_id) ?? [];
    list.push(row.membership_id);
    byGroup.set(row.staff_group_id, list);
  }
  return rows.map((row) => staffGroupToWire(row, byGroup.get(row.id) ?? []));
}

export async function createStaffGroup(
  uow: Uow,
  body: CreateStaffGroupRequest,
): Promise<CatalogueOutcome<StaffGroup>> {
  const tenant = tenantOf(uow.context);

  if (body.membershipIds.length > 0) {
    const visible = (await uow.query
      .selectFrom('memberships')
      .select('id')
      .where('id', 'in', body.membershipIds)
      .execute()) as unknown as { id: string }[];
    const visibleIds = new Set(visible.map((row) => row.id));
    if (body.membershipIds.some((id) => !visibleIds.has(id))) {
      return {
        kind: 'invalid',
        problems: [
          { field: 'membershipIds', message: 'One or more of the chosen people is not in this group.' },
        ],
      };
    }
  }

  const id = randomUUID();
  const rows = (await uow.query
    .insertInto('staff_groups')
    .values({ id, ...tenant, name: body.name, description: body.description })
    .returning(STAFF_GROUP_COLUMNS)
    .execute()) as unknown as StaffGroupRow[];

  const row = rows[0];
  if (row === undefined) return { kind: 'not-found' };

  for (const membershipId of body.membershipIds) {
    await uow.query
      .insertInto('staff_group_members')
      .values({ id: randomUUID(), ...tenant, staff_group_id: id, membership_id: membershipId })
      .execute();
  }

  return { kind: 'ok', value: staffGroupToWire(row, body.membershipIds) };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Valid combinations and pick positions
 * ──────────────────────────────────────────────────────────────────────────── */

const VALID_GROUP_COLUMNS = ['id', 'name', 'allowed_pick_positions', 'status', 'version'] as const;

/**
 * The declared group's pick-position count.
 *
 * ## Why the WHERE clause is not redundant
 *
 * It reads as though the RLS predicate already restricts this to one row, and
 * under a GROUP-scoped context it does. Under an ORGANIZATION-scoped context it
 * does **not**: `groups_organization_scope` admits every group in the
 * organization, so the unpinned version of this function returned **an arbitrary
 * group's count** — whichever the planner produced first. An independent review
 * demonstrated exactly that.
 *
 * This is the S-01 defect class from OPUS-M1-002, reached through a different
 * table: a read with no total order and no predicate, whose answer is *usually*
 * right. `tenantOf` throws under an organization-scoped context rather than
 * guessing, and the predicate pins the row for every context that survives it.
 */
export async function readPickPositionCount(uow: Uow): Promise<number> {
  const tenant = tenantOf(uow.context);
  const rows = (await uow.query
    .selectFrom('groups')
    .select('pick_position_count')
    .where('id', '=', tenant.group_id)
    .where('organization_id', '=', tenant.organization_id)
    .execute()) as unknown as { pick_position_count: number }[];
  if (rows.length > 1) {
    // Unreachable: `id` is the primary key. Kept because "more than one group
    // matched its own id" must never become "we used the first one".
    throw new Error('PICK_POSITION_READ_AMBIGUOUS: more than one group matched its own id');
  }
  return rows[0]?.pick_position_count ?? 0;
}

export async function listValidGroups(
  uow: Uow,
): Promise<{ validGroups: readonly ValidGroup[]; pickPositionCount: number }> {
  const rows = (await uow.query
    .selectFrom('valid_groups')
    .select(VALID_GROUP_COLUMNS)
    .orderBy('name')
    .execute()) as unknown as ValidGroupRow[];

  const byGroup = new Map<string, string[]>();
  if (rows.length > 0) {
    const memberRows = (await uow.query
      .selectFrom('valid_group_shift_types')
      .select(['valid_group_id', 'shift_type_id'])
      .where(
        'valid_group_id',
        'in',
        rows.map((row) => row.id),
      )
      .where('is_active', '=', true)
      .execute()) as unknown as { valid_group_id: string; shift_type_id: string }[];
    for (const row of memberRows) {
      const list = byGroup.get(row.valid_group_id) ?? [];
      list.push(row.shift_type_id);
      byGroup.set(row.valid_group_id, list);
    }
  }

  return {
    validGroups: rows.map((row) => validGroupToWire(row, byGroup.get(row.id) ?? [])),
    pickPositionCount: await readPickPositionCount(uow),
  };
}

export async function createValidGroup(
  uow: Uow,
  body: CreateValidGroupRequest,
): Promise<CatalogueOutcome<ValidGroup>> {
  const ceiling = await readPickPositionCount(uow);
  const positions = canonicalPickPositions(body.allowedPickPositions);
  const problems = pickPositionProblems(positions, ceiling);
  if (problems.length > 0) return { kind: 'invalid', problems };

  const visible = await visibleShiftTypeIds(uow, body.shiftTypeIds);
  if (body.shiftTypeIds.some((id) => !visible.has(id))) {
    return {
      kind: 'invalid',
      problems: [
        { field: 'shiftTypeIds', message: 'One or more of the chosen shift types is not in this group.' },
      ],
    };
  }

  const tenant = tenantOf(uow.context);
  const id = randomUUID();

  const rows = (await uow.query
    .insertInto('valid_groups')
    .values({ id, ...tenant, name: body.name, allowed_pick_positions: [...positions] })
    .returning(VALID_GROUP_COLUMNS)
    .execute()) as unknown as ValidGroupRow[];

  const row = rows[0];
  if (row === undefined) return { kind: 'not-found' };

  for (const shiftTypeId of body.shiftTypeIds) {
    await uow.query
      .insertInto('valid_group_shift_types')
      .values({ id: randomUUID(), ...tenant, valid_group_id: id, shift_type_id: shiftTypeId })
      .execute();
  }

  return { kind: 'ok', value: validGroupToWire(row, body.shiftTypeIds) };
}

/**
 * Raises the group's pick-position count.
 *
 * **The only irreversible action in this slice.** The database trigger
 * `app_guard_group_pick_position_count` refuses a decrease outright; this
 * function refuses it first so the form can say why, and the two are tested
 * against each other rather than one being trusted.
 */
export async function setPickPositionCount(
  uow: Uow,
  requested: number,
): Promise<CatalogueOutcome<number>> {
  const current = await readPickPositionCount(uow);
  const problems = pickPositionIncreaseProblems(current, requested);
  if (problems.length > 0) return { kind: 'invalid', problems };
  if (requested === current) return { kind: 'ok', value: current };

  const tenant = tenantOf(uow.context);
  const rows = (await uow.query
    .updateTable('groups')
    // Pinned for the same reason the read is: an unpinned UPDATE under an
    // organization-scoped context would raise the count on EVERY group in the
    // organization, and monotonicity would make all of it permanent.
    .set({ pick_position_count: requested, updated_at: new Date() })
    .where('id', '=', tenant.group_id)
    .where('organization_id', '=', tenant.organization_id)
    .returning('pick_position_count')
    .execute()) as unknown as { pick_position_count: number }[];

  const row = rows[0];
  if (row === undefined) return { kind: 'not-found' };
  return { kind: 'ok', value: row.pick_position_count };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Group holidays
 * ──────────────────────────────────────────────────────────────────────────── */

const HOLIDAY_COLUMNS = ['id', 'holiday_date', 'name', 'observed', 'version'] as const;

interface HolidayRow {
  id: string;
  /**
   * node-postgres parses `date` (OID 1082) into a **`Date`**, not a string —
   * measured, not assumed: the first version of this mapper typed it `string`
   * and every holiday response failed its own contract parse with a 500.
   *
   * The value is a calendar date with no time zone, so it is rendered back with
   * the LOCAL components rather than `toISOString()`: the driver builds the
   * `Date` at local midnight, and `toISOString()` west of UTC would shift it to
   * the previous day. A holiday that moves depending on where the server runs is
   * the specific bug CAR-011's calendar exists to prevent.
   */
  holiday_date: string | Date;
  name: string;
  observed: boolean;
  version: number;
}

function calendarDateOf(value: string | Date): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function holidayToWire(row: HolidayRow): GroupHoliday {
  return {
    groupHolidayId: row.id,
    holidayDate: calendarDateOf(row.holiday_date),
    name: row.name,
    observed: row.observed,
    version: row.version,
  };
}

export async function listGroupHolidays(uow: Uow): Promise<readonly GroupHoliday[]> {
  const rows = (await uow.query
    .selectFrom('group_holidays')
    .select(HOLIDAY_COLUMNS)
    .orderBy('holiday_date')
    .execute()) as unknown as HolidayRow[];
  return rows.map(holidayToWire);
}

export async function createGroupHoliday(
  uow: Uow,
  body: CreateGroupHolidayRequest,
): Promise<CatalogueOutcome<GroupHoliday>> {
  const parsed = Date.parse(`${body.holidayDate}T00:00:00Z`);
  if (Number.isNaN(parsed)) {
    return {
      kind: 'invalid',
      problems: [{ field: 'holidayDate', message: 'Enter a real date as YYYY-MM-DD.' }],
    };
  }

  const rows = (await uow.query
    .insertInto('group_holidays')
    .values({
      id: randomUUID(),
      ...tenantOf(uow.context),
      holiday_date: body.holidayDate,
      name: body.name,
      observed: body.observed,
    })
    .returning(HOLIDAY_COLUMNS)
    .execute()) as unknown as HolidayRow[];

  const row = rows[0];
  if (row === undefined) return { kind: 'not-found' };
  return { kind: 'ok', value: holidayToWire(row) };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Qualification requirements, and the two eligibility reads
 * (OPUS-M2-004; `shift_type_qualifications`, migration 0006)
 *
 * ## What this is for
 *
 * The M4 scheduling engine needs to know which credentials a shift type demands.
 * **Nothing here enforces it** — enforcement is the engine's, and this is its
 * input. What ships is the authoring surface, the tenancy, the authorization,
 * the audit trail, and the two reads:
 *
 *   * which qualifications does shift type X require?
 *   * which shift types is member M qualified for?
 *
 * ## Removal is archiving, and the server decides that
 *
 * The set is written as a SET, not row by row. An author changing three
 * requirements performs one action and issues one request (I-10), and expressing
 * removal as "this id is no longer in the set" keeps the retention rule on the
 * server — the database refuses a DELETE outright, for the table owner as well
 * as for the runtime roles, so a client asked to send one would be asking for a
 * statement that cannot succeed.
 * ──────────────────────────────────────────────────────────────────────────── */

interface RequirementRow {
  id: string;
  qualification_id: string;
  qualification_key: string;
  qualification_name: string;
  status: 'active' | 'archived';
}

function requirementToWire(row: RequirementRow): ShiftTypeQualification {
  return {
    shiftTypeQualificationId: row.id,
    qualificationId: row.qualification_id,
    qualificationKey: row.qualification_key,
    qualificationName: row.qualification_name,
    active: row.status === 'active',
  };
}

/**
 * Every requirement recorded for a shift type, archived ones included.
 *
 * Archived rows are returned with `active: false` rather than filtered out: the
 * reason they are retained is that they explain schedules built while they were
 * in force, and a read that hid them would make the retention pointless for
 * anybody but a forensic SQL query.
 *
 * The join to `qualifications` is inside the same group predicate on both sides,
 * so it can neither widen what the caller sees nor fail to resolve: the
 * composite foreign key guarantees the parent is in the same group.
 */
export async function listShiftTypeQualifications(
  uow: Uow,
  shiftTypeId: string,
): Promise<readonly ShiftTypeQualification[]> {
  const rows = (await uow.query
    .selectFrom('shift_type_qualifications as stq')
    .innerJoin('qualifications as q', (join) =>
      join
        .onRef('q.id', '=', 'stq.qualification_id')
        .onRef('q.organization_id', '=', 'stq.organization_id')
        .onRef('q.group_id', '=', 'stq.group_id'),
    )
    .where('stq.shift_type_id', '=', shiftTypeId)
    .select([
      'stq.id as id',
      'stq.qualification_id as qualification_id',
      'stq.status as status',
      'q.key as qualification_key',
      'q.name as qualification_name',
    ])
    // Qualified, and deliberately: an unqualified `order by key` would resolve to
    // an output column if one ever carried that name. The lesson is
    // OPUS-M2-004's own — see `src/audit/verification.ts`.
    .orderBy('q.key')
    .execute()) as unknown as RequirementRow[];

  return rows.map(requirementToWire);
}

/**
 * Replaces a shift type's requirement set.
 *
 * Three statements, all inside the caller's unit of work:
 *
 *   1. every id in the request that has no row yet is INSERTed;
 *   2. every existing row whose qualification is in the request is set active
 *      (this is how a previously archived requirement comes back — the unique
 *      key is on the PAIR, so re-adding reactivates rather than duplicating);
 *   3. every existing row whose qualification is NOT in the request is archived.
 *
 * A shift type or qualification that does not exist **in this group** produces a
 * foreign-key violation, which the route turns into a `404` — the same answer as
 * a row RLS hid, which is what T-05b requires.
 */
export interface RequirementSetResult {
  readonly requirements: readonly ShiftTypeQualification[];
  /**
   * The before/after summary the audit row carries.
   *
   * COUNTS rather than the two sets, and that is a constraint rather than a
   * choice: `app_audit_payload_is_closed` (migration 0003, I-07) admits at most
   * sixteen keys of scalar values, each string at most 64 printable characters.
   * A pair of id arrays cannot be expressed, and flattening them into a joined
   * string would be a 64-character truncation of the fact it claims to record.
   *
   * The row-level before state is not lost by this: requirements are archived,
   * never deleted, so `shift_type_qualifications` itself holds every requirement
   * that ever applied, with `version` and `updated_at` on each. Archive-not-
   * delete is what makes the audit summary sufficient rather than the only copy.
   */
  readonly beforeActiveCount: number;
  readonly addedCount: number;
  readonly reactivatedCount: number;
  readonly archivedCount: number;
}

export async function setShiftTypeQualifications(
  uow: Uow,
  shiftTypeId: string,
  body: SetShiftTypeQualificationsRequest,
): Promise<CatalogueOutcome<RequirementSetResult>> {
  const wanted = [...new Set(body.qualificationIds)];
  if (wanted.length !== body.qualificationIds.length) {
    return {
      kind: 'invalid',
      problems: [
        {
          field: 'qualificationIds',
          message: 'A qualification is listed more than once. Each may appear only once.',
        },
      ],
    };
  }

  // The subject has to exist in this group before anything is written about it,
  // and it is read inside the same unit of work as the write (FAD-12, and the
  // M1 S-01 lesson: the row the precondition saw is the row the write acts on).
  const subject = await uow.query
    .selectFrom('shift_types')
    .select('id')
    .where('id', '=', shiftTypeId)
    .executeTakeFirst();
  if (subject === undefined) return { kind: 'not-found' };

  const existing = (await uow.query
    .selectFrom('shift_type_qualifications')
    .select(['id', 'qualification_id', 'status'])
    .where('shift_type_id', '=', shiftTypeId)
    .execute()) as unknown as { id: string; qualification_id: string; status: string }[];

  const known = new Map(existing.map((row) => [row.qualification_id, row]));

  const toInsert = wanted.filter((qualificationId) => !known.has(qualificationId));
  const toActivate = existing
    .filter((row) => wanted.includes(row.qualification_id) && row.status !== 'active')
    .map((row) => row.id);
  const toArchive = existing
    .filter((row) => !wanted.includes(row.qualification_id) && row.status !== 'archived')
    .map((row) => row.id);

  if (toInsert.length > 0) {
    await uow.query
      .insertInto('shift_type_qualifications')
      .values(
        toInsert.map((qualificationId) => ({
          id: randomUUID(),
          ...tenantOf(uow.context),
          shift_type_id: shiftTypeId,
          qualification_id: qualificationId,
        })),
      )
      .execute();
  }

  // By ROW ID, both of them. A predicate over `qualification_id` would be
  // equivalent today and would silently start matching a row this transaction
  // did not read the moment anything about the key changed.
  if (toActivate.length > 0) {
    await uow.query
      .updateTable('shift_type_qualifications')
      .set({ status: 'active', updated_at: new Date() })
      .where('id', 'in', toActivate)
      .execute();
  }

  if (toArchive.length > 0) {
    await uow.query
      .updateTable('shift_type_qualifications')
      .set({ status: 'archived', updated_at: new Date() })
      .where('id', 'in', toArchive)
      .execute();
  }

  return {
    kind: 'ok',
    value: {
      requirements: await listShiftTypeQualifications(uow, shiftTypeId),
      beforeActiveCount: existing.filter((row) => row.status === 'active').length,
      addedCount: toInsert.length,
      reactivatedCount: toActivate.length,
      archivedCount: toArchive.length,
    },
  };
}

interface EligibilityShiftTypeRow {
  shift_type_id: string;
  code: string;
  qualification_id: string;
}

/**
 * Which shift types the named membership is qualified for, at `instant`.
 *
 * ## What decides what the caller sees
 *
 * Not this function. `qualification_holdings` is `SENSITIVE-PII` and its SELECT
 * policies carry a capability predicate: a caller reads their own holdings
 * always and somebody else's only with `staffing.qualification_holding.read_any`.
 * So a caller without that key asking about a colleague sees **no holdings** and
 * gets the same answer they would get for a colleague who holds none — which is
 * what P-3 requires, and what an application-layer 403 here would have
 * destroyed.
 *
 * That is worth stating plainly because it cuts both ways: a caller who cannot
 * see the holdings gets `eligible: false` with every requirement listed as
 * missing. **That is a report about what the caller can see, not a verdict about
 * the member**, which is exactly why the M4 engine will compute eligibility with
 * its own credential rather than trusting a client-visible answer.
 *
 * ## Expiry makes this time-dependent
 *
 * A holding is honoured only while `valid_from <= instant` and `valid_until` is
 * null or in the future, and only in status `valid`. The instant is a parameter,
 * never `now()` read inside the query: two rows evaluated against two different
 * clock readings inside one transaction is the class of defect the in-force
 * loader exists to prevent (CAP-058, and M2-003's `?at=` discipline).
 */
export async function listMembershipEligibility(
  uow: Uow,
  membershipId: string,
  instant: Date,
): Promise<readonly ShiftTypeEligibility[]> {
  const shiftTypes = (await uow.query
    .selectFrom('shift_types')
    .select(['id as id', 'code as code'])
    .orderBy('shift_types.code')
    .execute()) as unknown as { id: string; code: string }[];

  const requirements = (await uow.query
    .selectFrom('shift_type_qualifications')
    .select(['shift_type_id as shift_type_id', 'qualification_id as qualification_id'])
    .where('status', '=', 'active')
    .execute()) as unknown as Omit<EligibilityShiftTypeRow, 'code'>[];

  /* ── the holdings come through the ONE loader, and the rule from the domain ──
   *
   * `qualification_holdings` is effective-dated, and
   * `apps/api/test/profiles/loader-is-the-only-selector.test.ts` fails the build
   * if any module but `profiles/in-force-loader.ts` selects from it. That test is
   * the S-01 lesson made structural: S-01 was two selection rules that disagreed,
   * each written in good faith at its own call site, and the second query is
   * always the one nobody thought about.
   *
   * This was that second query. It was written here first — a hand-rolled
   * `status = 'valid' AND valid_from <= at AND (valid_until IS NULL OR
   * valid_until > at)` — and the control caught it. Two things were wrong with
   * it beyond the duplication: it treated `expiring` as ineligible, which
   * `ELIGIBLE_HOLDING_STATUSES` does not, and its window comparison was a third
   * spelling of a boundary rule that already has one.
   *
   * `loadHoldings` selects; `isEligibleAt` decides. Both are the shipped
   * implementations, so a change to either reaches this read too. */
  const holdings = await loadHoldings(uow.query, {
    organizationId: uow.context.organizationId,
    membershipId,
  });

  const heldIds = new Set(
    [...new Set(holdings.map((holding) => holding.qualificationId))].filter((qualificationId) =>
      isEligibleAt(
        holdings.filter((holding) => holding.qualificationId === qualificationId),
        instant,
      ),
    ),
  );

  const byShiftType = new Map<string, string[]>();
  for (const row of requirements) {
    const list = byShiftType.get(row.shift_type_id) ?? [];
    list.push(row.qualification_id);
    byShiftType.set(row.shift_type_id, list);
  }

  return shiftTypes.map((shiftType) => {
    const required = [...(byShiftType.get(shiftType.id) ?? [])].sort();
    const missing = required.filter((qualificationId) => !heldIds.has(qualificationId));
    return {
      shiftTypeId: shiftType.id,
      shiftTypeCode: shiftType.code,
      requiredQualificationIds: required,
      missingQualificationIds: missing,
      eligible: missing.length === 0,
    };
  });
}
