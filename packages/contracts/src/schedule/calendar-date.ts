import { z } from 'zod';

/**
 * A **real** calendar date on the wire (OPUS-M4-000B; doc 34 §4-F).
 *
 * ## What this replaces, and what it was letting through
 *
 * Every date on every schedule contract was `z.string().regex(/^\d{4}-\d{2}-\d{2}$/)`
 * — repeated verbatim in `authoring.ts`, `views.ts` and `versions.ts`. That is a
 * SHAPE check. It accepts `2027-02-29` (2027 is not a leap year), `2027-13-01`,
 * `2027-00-10` and `2027-04-31`, and doc 34 §4-F names it: "date validation is
 * shape-only in places".
 *
 * The two ways it fails are both bad, and one of them is silent:
 *
 *  - a date that reaches PostgreSQL raises `22008` from inside a transaction —
 *    a 500-shaped failure for a 422-shaped mistake;
 *  - a date that is turned into an INSTANT first (`Date.parse`, `Date.UTC`)
 *    **rolls over**: `2027-02-29` becomes `2027-03-01`. A shift authored for a
 *    day that does not exist is then filed on the next one and nothing fails.
 *
 * ## Why the rule is duplicated here rather than imported
 *
 * `packages/contracts` may import zod **and nothing else** —
 * `.dependency-cruiser.cjs` rule `contracts-imports-only-zod`, proved by
 * `scripts/red-cases/import-boundary/`. `packages/domain/src/calendar` holds the
 * same rule for the server, and two copies of a rule are two truths that can
 * drift, so they are not left to agree by inspection:
 * `apps/api/test/schedule/calendar-agreement.test.ts` runs both over
 * an exhaustive date range and asserts they answer identically on every input,
 * including the century and leap cases. That is the same discipline the
 * catalogue's constants already use against migration 0005's CHECKs.
 */

/** Proleptic Gregorian leap year: /4, except /100, except /400. */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Days in `month` (1..12) of `year`; `0` for a month outside that range. */
function daysInMonth(year: number, month: number): number {
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

/** `true` iff `value` is `YYYY-MM-DD` **and** names a date that exists. */
export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || year > 9999) return false;
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

/**
 * The schema every date field on every schedule contract uses.
 *
 * The message names the failure a human made — "31 April" — rather than the
 * pattern it failed, because a caller who typed a real-looking date is not
 * helped by being shown a regex.
 */
export const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'a date is YYYY-MM-DD')
  .refine(isCalendarDate, 'that date does not exist in the calendar');

export type CalendarDate = z.infer<typeof calendarDateSchema>;
