import type { ShiftPaletteKey, ShiftTextStyle } from './display.js';

/**
 * The pure rules of the shift-type catalogue.
 *
 * Everything here is a total function over plain values: no clock, no
 * database, no I/O. The database enforces the same rules with CHECK constraints
 * and triggers, and the two are asserted against each other rather than trusted
 * to agree — the database is the control, this is what lets an authoring form
 * say *which* field is wrong before a round trip, and the packet requires the
 * form to say so (SP-E brief §3, validation summary with field links).
 *
 * **This module is the reason the shape of a validation failure is a list of
 * `{ field, message }` rather than a string.** A summary that links to fields
 * cannot be built from a sentence.
 */

/** A single validation failure, addressed to the form control that caused it. */
export interface FieldProblem {
  /** The contract field name. The authoring form links its summary entry to it. */
  readonly field: string;
  /** Rendered verbatim. No identifiers, no values the user did not type. */
  readonly message: string;
}

export const CATALOGUE_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'holiday'] as const;
export type CatalogueDay = (typeof CATALOGUE_DAYS)[number];

export const CATALOGUE_DAY_LABELS: Readonly<Record<CatalogueDay, string>> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
  holiday: 'Holiday',
};

/** `HH:MM` in 24-hour form. Seconds are deliberately not accepted. */
const TIME_OF_DAY = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function isTimeOfDay(value: string): boolean {
  return TIME_OF_DAY.test(value);
}

/** Minutes since midnight, or `null` when the value is not a time of day. */
export function minutesSinceMidnight(value: string): number | null {
  if (!isTimeOfDay(value)) return null;
  const [hours, minutes] = value.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/**
 * Whether a shift running `start → end` ends on the following calendar day.
 *
 * **Derived, never asked.** The observed catalogue has a start time and an end
 * time and no day, and an administrator who has to tell the system something it
 * can work out will eventually tell it something false. The database CHECK
 * (`shift_types_overnight_shape`) refuses any row where the stored flag and this
 * function disagree, so the derivation is enforced rather than merely offered.
 *
 * `end == start` is a twenty-four-hour shift and therefore crosses midnight; a
 * zero-length shift is not a thing the catalogue can express.
 */
export function crossesMidnight(startTime: string, endTime: string): boolean | null {
  const start = minutesSinceMidnight(startTime);
  const end = minutesSinceMidnight(endTime);
  if (start === null || end === null) return null;
  return end <= start;
}

/** The shift's length in minutes, midnight crossing included. */
export function shiftLengthMinutes(startTime: string, endTime: string): number | null {
  const start = minutesSinceMidnight(startTime);
  const end = minutesSinceMidnight(endTime);
  if (start === null || end === null) return null;
  return end > start ? end - start : end + 24 * 60 - start;
}

export interface ShiftTypeDraft {
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly displayPaletteKey: ShiftPaletteKey;
  readonly displayTextStyle: ShiftTextStyle;
  readonly startTime: string;
  readonly endTime: string;
  readonly isOnCall: boolean;
  readonly attractsStipend: boolean;
  readonly isManualOnly: boolean;
  readonly isDailyPick: boolean;
  readonly includeInStatistics: boolean;
  readonly isLeaveOfAbsence: boolean;
  readonly allowOnRequest: boolean;
  readonly allowOffRequest: boolean;
  readonly reportOrder: number;
  readonly creditWeight: number;
}

/**
 * Every rule the database also enforces, evaluated here so the form can name the
 * field.
 *
 * Returns ALL problems, not the first: a form that reveals one mistake per
 * submission is a form that takes four submissions, and SPEC-14 AC-11 requires
 * the error **count** to be announced, which presupposes there is a count.
 */
export function shiftTypeProblems(draft: ShiftTypeDraft): readonly FieldProblem[] {
  const problems: FieldProblem[] = [];

  if (draft.code.trim().length === 0) {
    problems.push({ field: 'code', message: 'Enter a short code.' });
  } else if (draft.code.length > 24) {
    problems.push({ field: 'code', message: 'A short code may be at most 24 characters.' });
  }

  if (draft.name.trim().length === 0) {
    problems.push({ field: 'name', message: 'Enter a full name.' });
  } else if (draft.name.length > 120) {
    problems.push({ field: 'name', message: 'A full name may be at most 120 characters.' });
  }

  if (draft.description !== null && draft.description.trim().length === 0) {
    problems.push({
      field: 'description',
      message: 'Leave the description empty or enter some text — whitespace alone is not a description.',
    });
  }

  if (!isTimeOfDay(draft.startTime)) {
    problems.push({ field: 'startTime', message: 'Enter a start time as HH:MM, for example 07:30.' });
  }
  if (!isTimeOfDay(draft.endTime)) {
    problems.push({ field: 'endTime', message: 'Enter an end time as HH:MM, for example 19:30.' });
  }

  if (draft.isManualOnly && draft.isDailyPick) {
    problems.push({
      field: 'isDailyPick',
      message:
        'A manually assigned shift type is not offered in the daily pick. Turn one of the two off.',
    });
  }

  if (!Number.isInteger(draft.reportOrder) || draft.reportOrder < 0) {
    problems.push({ field: 'reportOrder', message: 'Report order is a whole number, 0 or greater.' });
  }

  if (!Number.isFinite(draft.creditWeight) || draft.creditWeight < 0 || draft.creditWeight > 1000) {
    problems.push({ field: 'creditWeight', message: 'Credit weight is between 0 and 1000.' });
  }

  return problems;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Effective dating
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The in-force window's rules, as a pure function.
 *
 * ## What effective dating IS in this slice, and what it is not
 *
 * It is **authorable**: an administrator may say when a definition comes into
 * force and when it stops. That is what lets a rota change be prepared ahead of
 * the date it takes effect, which is the case the concept exists for.
 *
 * It is **not** in-force READ FILTERING. Every catalogue read in this milestone
 * returns every definition, future-dated and expired alike, and that is
 * deliberate for an AUTHORING surface: an administrator preparing next quarter's
 * rota must be able to see and edit the definition that is not in force yet, and
 * a list that hid it would make it uneditable. In-force selection belongs where
 * the catalogue becomes ENGINE INPUT — M4 — and it will use the shared in-force
 * loader OPUS-M2-003 is building rather than a second implementation here.
 *
 * That split is a RULING, recorded in `docs/evidence/EV-M2-CATALOGUE/INDEX.md`
 * and in the field-mapping table, not an omission.
 *
 * ## The S-22 lesson, applied
 *
 * `null` is how a window is left open. An infinite bound is not: `timestamptz`
 * accepts `infinity`, every ordinary window comparison is satisfied by it, and
 * node-postgres returns it as the JavaScript number `Infinity`, on which
 * `.toISOString()` throws. The database refuses both bounds
 * (`shift_types_finite_window`); this refuses them earlier, with the field named.
 */
export function effectiveWindowProblems(
  effectiveFrom: string | undefined,
  effectiveTo: string | null | undefined,
): readonly FieldProblem[] {
  const problems: FieldProblem[] = [];

  const parse = (value: string, field: string): number | null => {
    const at = Date.parse(value);
    if (Number.isNaN(at)) {
      problems.push({ field, message: 'Enter a date and time this system can read.' });
      return null;
    }
    if (!Number.isFinite(at)) {
      problems.push({ field, message: 'Leave the field empty for an open window.' });
      return null;
    }
    return at;
  };

  const from = effectiveFrom === undefined ? null : parse(effectiveFrom, 'effectiveFrom');
  const to =
    effectiveTo === undefined || effectiveTo === null ? null : parse(effectiveTo, 'effectiveTo');

  if (from !== null && to !== null && to <= from) {
    problems.push({
      field: 'effectiveTo',
      message: 'The date this definition stops applying must be after the date it starts.',
    });
  }

  return problems;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Pick positions
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The canonical form of a pick-position set: ascending, no duplicates.
 *
 * The database refuses a non-canonical array rather than silently canonicalising
 * it (`app_guard_valid_group_positions`), for a reason worth repeating here: a
 * caller that sent `{3,1,1}` and got back `{1,3}` learned nothing about the two
 * different mistakes it made. This function exists so a client can produce the
 * canonical form deliberately, not so anything can hide a mistake.
 */
export function canonicalPickPositions(positions: readonly number[]): readonly number[] {
  return [...new Set(positions)].sort((a, b) => a - b);
}

export function pickPositionProblems(
  positions: readonly number[],
  ceiling: number,
): readonly FieldProblem[] {
  const problems: FieldProblem[] = [];
  if (positions.some((p) => !Number.isInteger(p))) {
    problems.push({ field: 'allowedPickPositions', message: 'Pick positions are whole numbers.' });
    return problems;
  }
  if (positions.some((p) => p < 1)) {
    problems.push({ field: 'allowedPickPositions', message: 'Pick positions are numbered from 1.' });
  }
  const above = positions.filter((p) => p > ceiling);
  if (above.length > 0) {
    problems.push({
      field: 'allowedPickPositions',
      message: `This group has ${String(ceiling)} pick position(s). Choose positions within that range.`,
    });
  }
  return problems;
}

/**
 * The monotonicity rule, as a pure predicate.
 *
 * Research 05 §ADM-07 records the constraint as OBSERVED and explicit: the count
 * "may only be increased… These may not be deleted in the future." The database
 * trigger `app_guard_group_pick_position_count` is the enforcement; this is what
 * lets the authoring form refuse before it asks.
 */
export function pickPositionIncreaseProblems(
  current: number,
  requested: number,
): readonly FieldProblem[] {
  if (!Number.isInteger(requested) || requested < 0) {
    return [{ field: 'pickPositionCount', message: 'Enter a whole number, 0 or greater.' }];
  }
  if (requested < current) {
    return [
      {
        field: 'pickPositionCount',
        message:
          `This group has ${String(current)} pick position(s). The count can only be increased — ` +
          'a position that has existed is referenced by published history and cannot be withdrawn.',
      },
    ];
  }
  return [];
}
