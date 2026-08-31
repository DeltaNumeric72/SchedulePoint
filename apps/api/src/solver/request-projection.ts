import {
  PROJECTION_RULE,
  datesInRange,
  isCalendarDate,
  vacationWeekDates,
  type RequestProjection,
  type RequestPreferenceStrength,
  type UnitOfWork,
} from '@schedulepoint/domain';
import { sql, type Kysely } from 'kysely';

import type { Database } from '../db/schema.js';

import { calendarText } from './calendar-text.js';

/**
 * **SPEC-08 §6's projection, assembled** (OPUS-M5-004, doc 42 §5h).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## The split: the RULE is in the domain, the READS are here
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `packages/domain/src/requests/solver-projection.ts` decides which
 * *(subtype, status)* pairs produce which row kind, and it is pure — a reviewer
 * can lay it beside §6 and check it by eye, and the cross-product test walks it
 * without a database. This module does the two things that need one: it READS,
 * and it EXPANDS a request into the dates it covers.
 *
 * The status filters below are not a second copy of that rule. They are built
 * FROM `PROJECTION_RULE` at query time, so a change to §6's table changes the
 * SQL rather than leaving it stale — the S-01 scanner class doc 35 §6a names,
 * avoided by construction rather than by care.
 *
 * ## Everything runs inside the caller's unit of work
 *
 * SPEC-04 §3.4 calls `solver_inputs` "a complete immutable snapshot", and §6's
 * closing line puts the projection inside it. A projection read in a second
 * transaction would be a projection of a different world than the participants
 * and the demand were read from — two half-worlds stapled together, with the
 * seam invisible in the document.
 *
 * ## The read plane, and why it exists (migration 0027 §5)
 *
 * Migration 0023 narrowed the request tables to `SENSITIVE-PII`: a caller sees
 * their OWN requests, and the group's only with `requests.read_any` or
 * `requests.administer`. A build assembled on the builder's visibility would
 * carry the builder's absences and NOBODY ELSE'S — and the solver would then
 * schedule every other member on their approved day off, with §6 (the only gate)
 * silent, because the row it would have refused was never visible to be
 * projected. FAD-23's warning, in the dangerous direction.
 *
 * So the purpose-scoped plane 0012 built for the publication gate's
 * qualification reads is opened here, with a token of its own, immediately
 * before the reads and cleared in a `finally` — `set_config(name, value, true)`,
 * the sole permitted spelling (non-bypass rule 2), transaction-local. Migration
 * 0027 §5 carries the confinement argument in full; the short form is that the
 * tenant predicate does not move, RLS stays ENABLED and FORCEd, and what leaves
 * this computation is the projection — ids and dates — never a status, a
 * subtype, a reason code or an `override_reason`.
 *
 * ## I-07
 *
 * Nothing this module selects is free text. `override_reason`, the comment
 * bodies and the reason codes are not in a single query below, and §6's rows
 * have nowhere to put one.
 */

type Uow = UnitOfWork<Kysely<Database>>;

/** Migration 0027 §5's purpose token. One literal, one meaning. */
const PROJECTION_READ_TOKEN = 'solver_projection';

/* ────────────────────────────────────────────────────────────────────────────
 * 1. The rows as they come off the database
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * What the five reads produce, before §6's expansion.
 *
 * A named intermediate rather than a chain of maps, because it is the seam the
 * pure builder is tested across: {@link buildRequestProjection} takes exactly
 * this and returns the projection, so every §6 rule below can be exercised —
 * including both branches of the binding gate — without a cluster.
 */
export interface RequestProjectionSources {
  /** `time-off`: exactly one of `targetDate` / (`rangeStart`, `rangeEnd`) — D-19. */
  readonly timeOff: readonly {
    readonly membershipId: string;
    readonly targetDate: string | null;
    readonly rangeStart: string | null;
    readonly rangeEnd: string | null;
  }[];
  readonly noCall: readonly { readonly membershipId: string; readonly targetDate: string }[];
  readonly availability: readonly { readonly membershipId: string; readonly targetDate: string }[];
  readonly shiftPreference: readonly {
    readonly membershipId: string;
    readonly targetDate: string;
    readonly shiftTypeId: string;
    readonly strength: RequestPreferenceStrength;
  }[];
  readonly shiftGroupOff: readonly {
    readonly membershipId: string;
    readonly targetDate: string;
    readonly shiftGroupId: string;
  }[];
  /** Committed vacation: one row per selection, expanded by `vacationWeekDates`. */
  readonly committedVacation: readonly {
    readonly membershipId: string;
    readonly weekStart: string;
  }[];
}

export interface RequestProjectionOptions {
  /** The snapshot's window. Rows outside it are dropped; see the builder. */
  readonly startDate: string;
  readonly endDate: string;
  /**
   * **§6's `HardOn` qualifier: "where group policy makes it binding".**
   *
   * A parameter rather than a read, because **no such group policy exists in
   * this schema.** Verified against the files rather than assumed: `groups`
   * carries `request_until_mode` / `request_until_date` /
   * `request_until_lead_days` (migration 0010), `deadline_rolls` and
   * `late_submission_policy` (0023), `picklist_access_mode`, and nothing that
   * says whether an approved availability BINDS the solver.
   *
   * Inventing the column would be a schema change doc 42 §5h does not carry, and
   * defaulting to `true` would be the wider reading of a qualifier whose whole
   * point is that it narrows — a `HardOn` row forces a person ONTO a date, which
   * is the more consequential of the two directions to get wrong. So the gate is
   * named, total, and answered `false` by its only caller until the policy
   * exists, and BOTH branches are exercised by test through this parameter.
   *
   * When the policy lands, its reader goes in {@link assembleRequestProjection}
   * and this parameter is where it arrives. Nothing else changes.
   */
  readonly availabilityIsBinding: boolean;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. The pure half — §6's expansion and its window
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * **The projection, from rows to §6's four arrays.** Pure.
 *
 * Three things happen here and each is a §6 rule rather than a convenience:
 *
 *  1. **Expansion.** A time-off RANGE is a row per date (D-19's
 *     `(range_start, range_end)` half); a committed vacation WEEK is a row per
 *     working day, through `vacationWeekDates` — the same function §5.6's commit
 *     uses to decide which OFF snapshots to create, so the schedule and the
 *     projection cannot disagree about which days a week is.
 *  2. **The window.** Dates outside `[startDate, endDate]` are dropped. The
 *     snapshot is a problem about one period, and a `HardOff` row for a date the
 *     model has no variables on constrains nothing while enlarging the hash.
 *  3. **Determinism.** Every array is deduplicated and sorted. `input_hash`
 *     covers the whole document, so two assemblies of one world that differed
 *     only in row order would be two different problems by the hash's account —
 *     and SPEC-04 §4's reproducibility promise is over the document.
 */
export function buildRequestProjection(
  sources: RequestProjectionSources,
  options: RequestProjectionOptions,
): RequestProjection {
  const inWindow = (date: string): boolean =>
    date >= options.startDate && date <= options.endDate;

  const hardOff = new Set<string>();
  for (const row of sources.timeOff) {
    for (const date of timeOffDates(row)) {
      if (inWindow(date)) hardOff.add(`${row.membershipId}|${date}`);
    }
  }
  for (const row of sources.noCall) {
    if (inWindow(row.targetDate)) hardOff.add(`${row.membershipId}|${row.targetDate}`);
  }
  for (const row of sources.committedVacation) {
    if (!isCalendarDate(row.weekStart)) continue;
    for (const date of vacationWeekDates(row.weekStart)) {
      if (inWindow(date)) hardOff.add(`${row.membershipId}|${date}`);
    }
  }

  const hardOn = new Set<string>();
  /* §6's qualifier. `false` produces no rows at all — an availability the policy
   * does not make binding is ABSENT from the projection, not a softer version of
   * a `HardOn`. §6 offers no third row kind for it and inventing one would be a
   * projection row §6 does not have. */
  if (options.availabilityIsBinding) {
    for (const row of sources.availability) {
      if (inWindow(row.targetDate)) hardOn.add(`${row.membershipId}|${row.targetDate}`);
    }
  }

  const softPreference = new Map<string, RequestPreferenceStrength>();
  for (const row of sources.shiftPreference) {
    if (!inWindow(row.targetDate)) continue;
    const key = `${row.membershipId}|${row.targetDate}|${row.shiftTypeId}`;
    /* Two preferences for one (person, date, shift type) is possible — one
     * request may be `accepted_as_input` and an older one `reflected_in_version`
     * — and the STRONGER one is kept. Dropping one silently would make the
     * projection depend on read order, and keeping both would put two weights on
     * one cell, which is not a row shape §6 has. */
    const existing = softPreference.get(key);
    if (existing === undefined || strengthRank(row.strength) > strengthRank(existing)) {
      softPreference.set(key, row.strength);
    }
  }

  const shiftGroupOff = new Set<string>();
  for (const row of sources.shiftGroupOff) {
    if (inWindow(row.targetDate)) {
      shiftGroupOff.add(`${row.membershipId}|${row.targetDate}|${row.shiftGroupId}`);
    }
  }

  return {
    hardOff: [...hardOff].sort().map((key) => {
      const [membershipId = '', date = ''] = key.split('|');
      return { membershipId, date };
    }),
    hardOn: [...hardOn].sort().map((key) => {
      const [membershipId = '', date = ''] = key.split('|');
      return { membershipId, date };
    }),
    softPreference: [...softPreference.keys()].sort().map((key) => {
      const [membershipId = '', date = '', shiftTypeId = ''] = key.split('|');
      /* Non-null by construction: the key came out of the map's own keys. */
      return { membershipId, date, shiftTypeId, strength: softPreference.get(key) ?? 'low' };
    }),
    shiftGroupOff: [...shiftGroupOff].sort().map((key) => {
      const [membershipId = '', date = '', shiftGroupId = ''] = key.split('|');
      return { membershipId, date, shiftGroupId };
    }),
  };
}

/** D-19's exactly-one-of, expanded. A malformed row contributes nothing. */
function timeOffDates(row: {
  readonly targetDate: string | null;
  readonly rangeStart: string | null;
  readonly rangeEnd: string | null;
}): readonly string[] {
  if (row.targetDate !== null) return isCalendarDate(row.targetDate) ? [row.targetDate] : [];
  if (row.rangeStart === null || row.rangeEnd === null) return [];
  if (!isCalendarDate(row.rangeStart) || !isCalendarDate(row.rangeEnd)) return [];
  return datesInRange(row.rangeStart, row.rangeEnd);
}

/** `low < medium < high`, for the strongest-wins rule above. */
function strengthRank(strength: RequestPreferenceStrength): number {
  return strength === 'high' ? 3 : strength === 'medium' ? 2 : 1;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. The reads
 * ──────────────────────────────────────────────────────────────────────────── */

/** §6's status filter for a subtype, taken from the domain rule, never restated. */
function statusesFor(subtype: keyof typeof PROJECTION_RULE): readonly string[] {
  return PROJECTION_RULE[subtype].statuses;
}

/**
 * **Read the five sources and project.** Runs inside the caller's unit of work.
 *
 * The read plane is opened once around all of them and cleared in a `finally`
 * whatever happens — the shape `canonical-input.ts`'s
 * `loadHoldingsForEnforcement` already uses, and for the same reason: a plane
 * left open by an early return is a plane open for the rest of the transaction.
 */
export async function assembleRequestProjection(
  uow: Uow,
  options: RequestProjectionOptions,
): Promise<RequestProjection> {
  await sql`select set_config('app.solver_projection_read', ${PROJECTION_READ_TOKEN}, true)`.execute(
    uow.query,
  );
  try {
    const sources = await readSources(uow);
    return buildRequestProjection(sources, options);
  } finally {
    await sql`select set_config('app.solver_projection_read', '', true)`.execute(uow.query);
  }
}

async function readSources(uow: Uow): Promise<RequestProjectionSources> {
  const timeOff = await uow.query
    .selectFrom('request_time_off as sub')
    .innerJoin('requests as r', (join) =>
      join.onRef('r.id', '=', 'sub.request_id').onRef('r.organization_id', '=', 'sub.organization_id'),
    )
    .where('r.subtype', '=', 'time-off')
    .where('r.status', 'in', statusesFor('time-off') as never)
    .select([
      'r.membership_id as membershipId',
      'sub.target_date as targetDate',
      'sub.range_start as rangeStart',
      'sub.range_end as rangeEnd',
    ])
    .execute();

  const noCall = await uow.query
    .selectFrom('request_no_call as sub')
    .innerJoin('requests as r', (join) =>
      join.onRef('r.id', '=', 'sub.request_id').onRef('r.organization_id', '=', 'sub.organization_id'),
    )
    .where('r.subtype', '=', 'no-call')
    .where('r.status', 'in', statusesFor('no-call') as never)
    .select(['r.membership_id as membershipId', 'sub.target_date as targetDate'])
    .execute();

  const availability = await uow.query
    .selectFrom('request_availability as sub')
    .innerJoin('requests as r', (join) =>
      join.onRef('r.id', '=', 'sub.request_id').onRef('r.organization_id', '=', 'sub.organization_id'),
    )
    .where('r.subtype', '=', 'availability')
    .where('r.status', 'in', statusesFor('availability') as never)
    .select(['r.membership_id as membershipId', 'sub.target_date as targetDate'])
    .execute();

  const shiftPreference = await uow.query
    .selectFrom('request_shift_preference as sub')
    .innerJoin('requests as r', (join) =>
      join.onRef('r.id', '=', 'sub.request_id').onRef('r.organization_id', '=', 'sub.organization_id'),
    )
    .where('r.subtype', '=', 'shift-preference')
    .where('r.status', 'in', statusesFor('shift-preference') as never)
    .select([
      'r.membership_id as membershipId',
      'sub.target_date as targetDate',
      'sub.shift_type_id as shiftTypeId',
      'sub.preference_strength as strength',
    ])
    .execute();

  const shiftGroupOff = await uow.query
    .selectFrom('request_shift_group_off as sub')
    .innerJoin('requests as r', (join) =>
      join.onRef('r.id', '=', 'sub.request_id').onRef('r.organization_id', '=', 'sub.organization_id'),
    )
    .where('r.subtype', '=', 'shift-group-off')
    .where('r.status', 'in', statusesFor('shift-group-off') as never)
    .select([
      'r.membership_id as membershipId',
      'sub.target_date as targetDate',
      'sub.shift_group_id as shiftGroupId',
    ])
    .execute();

  /* "Committed vacation" (§6's `HardOff` cell), in §5.3's root vocabulary: the
   * selection status is `committed` and its derived root status is
   * `reflected_in_version`. Both are asserted here rather than one — D-27 makes
   * them agree, and a projection that trusted one alone would be a fourth place
   * the mapping has to hold. */
  const committedVacation = await uow.query
    .selectFrom('vacation_selections as vs')
    .innerJoin('requests as r', (join) =>
      join.onRef('r.id', '=', 'vs.request_id').onRef('r.organization_id', '=', 'vs.organization_id'),
    )
    .where('vs.status', '=', 'committed')
    .where('r.subtype', '=', 'vacation-selection')
    .where('r.status', 'in', statusesFor('vacation-selection') as never)
    .select(['vs.membership_id as membershipId', 'vs.week_start as weekStart'])
    .execute();

  return {
    timeOff: timeOff.map((row) => ({
      membershipId: row.membershipId,
      targetDate: row.targetDate === null ? null : calendarText(row.targetDate),
      rangeStart: row.rangeStart === null ? null : calendarText(row.rangeStart),
      rangeEnd: row.rangeEnd === null ? null : calendarText(row.rangeEnd),
    })),
    noCall: noCall.map((row) => ({
      membershipId: row.membershipId,
      targetDate: calendarText(row.targetDate),
    })),
    availability: availability.map((row) => ({
      membershipId: row.membershipId,
      targetDate: calendarText(row.targetDate),
    })),
    shiftPreference: shiftPreference.map((row) => ({
      membershipId: row.membershipId,
      targetDate: calendarText(row.targetDate),
      shiftTypeId: row.shiftTypeId,
      strength: row.strength as RequestPreferenceStrength,
    })),
    shiftGroupOff: shiftGroupOff.map((row) => ({
      membershipId: row.membershipId,
      targetDate: calendarText(row.targetDate),
      shiftGroupId: row.shiftGroupId,
    })),
    committedVacation: committedVacation.map((row) => ({
      membershipId: row.membershipId,
      weekStart: calendarText(row.weekStart),
    })),
  };
}
