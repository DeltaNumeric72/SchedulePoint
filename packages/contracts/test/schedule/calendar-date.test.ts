import { describe, expect, it } from 'vitest';

import {
  calendarDateSchema,
  isCalendarDate,
} from '../../src/schedule/calendar-date.js';

/**
 * The WIRE calendar validator, pinned in its own package (OPUS-M4-000B; doc 34
 * §4-F).
 *
 * ## Why this file exists separately from the agreement sweep
 *
 * `apps/api/test/schedule/calendar-agreement.test.ts` compares this validator
 * against `packages/domain/src/calendar` and is the right place for that
 * comparison — `apps/api` is the only workspace permitted to import both
 * packages. But it reaches this code through the package's `exports` entry,
 * which resolves to **`dist/`**, not to the source file.
 *
 * That was measured, not assumed, and it is why this file was added: the
 * `calendar-date-shape-only` red case patched
 * `packages/contracts/src/schedule/calendar-date.ts`, ran the api test, and the
 * api test PASSED — because nothing had rebuilt `dist`, so the violation never
 * reached the code under test. Rebuilding between the patch and the run turned
 * the same arm red immediately. The control was always load-bearing; the ARM was
 * pointed at a copy of the code that the patch could not reach, which is the
 * definition of a decorative red case.
 *
 * This file imports `../../src/schedule/calendar-date.js` — a **source-relative**
 * path inside its own package, exactly as `test/health.test.ts` does — so a
 * change to the source is a change to what runs here, with no build step in
 * between. It is the arm the red case now targets: one layer, the wire
 * validator, whose loss is precisely the defect the case exists to catch.
 */

describe('the wire validator refuses dates that do not exist', () => {
  /* Every entry is SHAPE-VALID: `/^\d{4}-\d{2}-\d{2}$/` — the regex this
   * validator replaced — accepts all of them. That is the defect, as a table. */
  it.each([
    '2027-02-29', // 2027 is not a leap year
    '1900-02-29', // a century not divisible by 400
    '2100-02-29',
    '2027-13-01', // month 13
    '2027-00-10', // month 0
    '2027-04-31', // April has 30 days
    '2027-06-31',
    '2027-09-31',
    '2027-11-31',
    '2027-01-32',
    '2027-01-00',
    '0000-01-01', // not a Gregorian year; PostgreSQL refuses it too
  ])('%s is refused', (value) => {
    expect(isCalendarDate(value)).toBe(false);
    expect(calendarDateSchema.safeParse(value).success).toBe(false);
  });

  it.each(['2024-02-29', '2000-02-29', '2027-02-28', '2027-12-31', '2027-01-01', '2028-02-29'])(
    '%s is accepted',
    (value) => {
      expect(isCalendarDate(value)).toBe(true);
      expect(calendarDateSchema.safeParse(value).success).toBe(true);
    },
  );

  it.each(['2027-2-01', '27-02-01', '2027/02/01', '2027-02-01T00:00:00Z', ' 2027-02-01', ''])(
    '%s fails the shape gate first',
    (value) => {
      expect(calendarDateSchema.safeParse(value).success).toBe(false);
    },
  );

  it('names the failure a human made, not the pattern they failed', () => {
    const parsed = calendarDateSchema.safeParse('2027-02-29');
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.message).toContain('does not exist');
  });

  /**
   * The exhaustive sweep, so no month length is taken on trust.
   *
   * 372 candidates per year (12 × 31). A leap year admits 366 of them and a
   * common year 365; the rest are dates that do not exist. Asserting the COUNT
   * is what makes this a real check — a validator that accepted everything, or
   * refused everything, would fail here rather than quietly passing the
   * individual cases above.
   */
  it.each([
    [2024, 366],
    [2027, 365],
    [1900, 365],
    [2000, 366],
    [2100, 365],
  ])('%i admits exactly %i real dates out of 372 candidates', (year, expected) => {
    let real = 0;
    for (let month = 1; month <= 12; month += 1) {
      for (let day = 1; day <= 31; day += 1) {
        const value =
          `${String(year).padStart(4, '0')}-` +
          `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (isCalendarDate(value)) real += 1;
      }
    }
    expect(real).toBe(expected);
  });

  /**
   * MUTATION CONTROL — the shape-only regex, run against the same table.
   *
   * It accepts every impossible date above. Demonstrated rather than asserted in
   * a comment, so this file is proven able to tell the two apart.
   */
  it('MUTATION CONTROL: the shape-only regex accepts every date this refuses', () => {
    const shapeOnly = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value);
    for (const value of ['2027-02-29', '1900-02-29', '2027-13-01', '2027-00-10', '2027-04-31']) {
      expect(shapeOnly(value), `${value}: the old regex`).toBe(true);
      expect(isCalendarDate(value), `${value}: this validator`).toBe(false);
    }
  });
});
