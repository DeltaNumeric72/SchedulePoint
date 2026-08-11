/**
 * `packages/domain/src/calendar` — true calendar-date semantics (OPUS-M4-000B;
 * doc 34 §4-F).
 *
 * ## Why this module exists
 *
 * Every date-carrying surface in this repository validated dates with the same
 * regex — `/^\d{4}-\d{2}-\d{2}$/` — which is a **shape** check and not a date
 * check. It accepts `2027-02-29` (2027 is not a leap year), `2027-13-01`,
 * `2027-00-10` and `2027-04-31`. Doc 34 §4-F names that explicitly: "date
 * validation is shape-only in places".
 *
 * The consequence is not cosmetic. A shape-valid, calendar-invalid date reaches
 * PostgreSQL and raises `22008 datetime field overflow` from the middle of a
 * transaction — a 500-shaped failure for what is a 422-shaped mistake — and, on
 * a surface that computes an instant from the date BEFORE writing it, it reaches
 * `Date.parse` first and silently ROLLS OVER: `Date.parse('2027-02-29')` is
 * `2027-03-01`. A rota authored for a day that does not exist and silently
 * filed on the next one is the worst available outcome, because nothing fails.
 *
 * ## Everything here is pure
 *
 * No clock, no zone, no `Date` construction that depends on the host's zone, no
 * I/O. A calendar date is a `(year, month, day)` triple that either exists or
 * does not; the zone question is `../time`'s and is deliberately separate — the
 * two were conflated on the surfaces this module replaces, which is how a date
 * ended up meaning "midnight somewhere".
 */

/** The wire and storage form: `YYYY-MM-DD`, zero-padded, proleptic Gregorian. */
export type CalendarDate = string;

/** The shape gate. Shape is necessary and, on its own, worthless — see below. */
const SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The year bounds this product accepts on any authored date.
 *
 * `0001`..`9999` is the range `YYYY-MM-DD` can express at all; the narrower
 * product bound belongs to the surfaces (a schedule period is bounded by
 * `MAX_PERIOD_DAYS`, not by this). What this rejects is `0000-01-01`, which is
 * shape-valid, is not a Gregorian year, and which PostgreSQL also refuses.
 */
export const MIN_CALENDAR_YEAR = 1;
export const MAX_CALENDAR_YEAR = 9999;

/**
 * Proleptic Gregorian leap year: divisible by 4, except centuries, except
 * centuries divisible by 400.
 *
 * Written out rather than inferred from `new Date(y, 1, 29)`, because that
 * construction reads the host's zone and this module may not.
 */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Days in `month` (1..12) of `year`. `0` for a month outside 1..12. */
export function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      return 0;
  }
}

/** The parsed triple, or `null` when the input is not a real calendar date. */
export interface CalendarParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/**
 * Parse `YYYY-MM-DD` into its parts, returning `null` for anything that is not
 * a **real** date.
 *
 * Rejected, each with a test pinning it: a wrong shape; a month outside 1..12;
 * a day outside 1..`daysInMonth`; `2027-02-29` (2027 is not a leap year);
 * `2000-02-29` is ACCEPTED (2000 is divisible by 400); `1900-02-29` is rejected
 * (1900 is a century that is not divisible by 400 — the case a naive `% 4` gets
 * wrong, and the one every leap-year bug is made of).
 */
export function parseCalendarDate(value: string): CalendarParts | null {
  const match = SHAPE.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < MIN_CALENDAR_YEAR || year > MAX_CALENDAR_YEAR) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

/** `true` iff `value` is a real calendar date in `YYYY-MM-DD` form. */
export function isCalendarDate(value: string): boolean {
  return parseCalendarDate(value) !== null;
}

/** Format a triple back to `YYYY-MM-DD`. The inverse of `parseCalendarDate`. */
export function formatCalendarDate(parts: CalendarParts): CalendarDate {
  return (
    `${String(parts.year).padStart(4, '0')}-` +
    `${String(parts.month).padStart(2, '0')}-` +
    `${String(parts.day).padStart(2, '0')}`
  );
}

/** Thrown by `assertCalendarDate`. Carries the offending value, never a guess. */
export class InvalidCalendarDateError extends Error {
  readonly code = 'INVALID_CALENDAR_DATE';
  readonly value: string;

  constructor(value: string) {
    super(`INVALID_CALENDAR_DATE: ${JSON.stringify(value)} is not a real calendar date`);
    this.name = 'InvalidCalendarDateError';
    this.value = value;
  }
}

/** `parseCalendarDate` or throw. Used where a caller has already validated. */
export function assertCalendarDate(value: string): CalendarParts {
  const parts = parseCalendarDate(value);
  if (parts === null) throw new InvalidCalendarDateError(value);
  return parts;
}

/**
 * Days since the epoch date `1970-01-01`, by pure arithmetic.
 *
 * `Date.UTC` would also work and is deliberately not used: it accepts rolled-over
 * inputs silently (`Date.UTC(2027, 1, 29)` is `2027-03-01`), which is the exact
 * defect this module exists to close, and a helper that launders an invalid date
 * into a valid one is worse than no helper. Every caller here has already been
 * through `assertCalendarDate`, and the arithmetic below cannot roll over
 * because it never constructs an intermediate date.
 *
 * Howard Hinnant's civil-from-days algorithm, era-based, exact for the whole
 * proleptic Gregorian range.
 */
export function daysFromEpoch(date: CalendarDate): number {
  const { year, month, day } = assertCalendarDate(date);
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400; // [0, 399]
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1; // [0, 365]
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy; // [0, 146096]
  return era * 146_097 + doe - 719_468;
}

/** The inverse of `daysFromEpoch`. */
export function dateFromEpochDays(days: number): CalendarDate {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097; // [0, 146096]
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  return formatCalendarDate({ year: month <= 2 ? y + 1 : y, month, day });
}

/** `date` shifted by `delta` whole days. Never rolls over an invalid input. */
export function addDays(date: CalendarDate, delta: number): CalendarDate {
  return dateFromEpochDays(daysFromEpoch(date) + delta);
}

/** Whole days from `from` to `to`. Negative when `to` precedes `from`. */
export function daysBetween(from: CalendarDate, to: CalendarDate): number {
  return daysFromEpoch(to) - daysFromEpoch(from);
}

/**
 * Whole days from `start` to `end`, both included — the length of a schedule
 * period. `0` is impossible: a one-day period is `1`.
 */
export function inclusiveDayCount(start: CalendarDate, end: CalendarDate): number {
  return daysBetween(start, end) + 1;
}

/** Lexical comparison is date comparison for zero-padded ISO dates. */
export function compareCalendarDates(a: CalendarDate, b: CalendarDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `true` iff `date` lies within `[start, end]` inclusive. */
export function isWithinDateRange(date: CalendarDate, start: CalendarDate, end: CalendarDate): boolean {
  return date >= start && date <= end;
}

/**
 * Day of week, `0` = Sunday .. `6` = Saturday.
 *
 * `1970-01-01` was a Thursday (`4`), and the modulo is written to stay
 * non-negative for dates before the epoch.
 */
export function dayOfWeek(date: CalendarDate): number {
  return (((daysFromEpoch(date) + 4) % 7) + 7) % 7;
}

/** Every date in `[start, end]` inclusive, ascending. Empty when `end < start`. */
export function datesInRange(start: CalendarDate, end: CalendarDate): CalendarDate[] {
  const first = daysFromEpoch(start);
  const last = daysFromEpoch(end);
  const out: CalendarDate[] = [];
  for (let day = first; day <= last; day += 1) out.push(dateFromEpochDays(day));
  return out;
}
