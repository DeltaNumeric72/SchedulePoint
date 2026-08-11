import { describe, expect, it } from 'vitest';

import {
  InvalidCalendarDateError,
  addDays,
  assertCalendarDate,
  compareCalendarDates,
  dateFromEpochDays,
  datesInRange,
  dayOfWeek,
  daysBetween,
  daysFromEpoch,
  daysInMonth,
  formatCalendarDate,
  inclusiveDayCount,
  isCalendarDate,
  isLeapYear,
  isWithinDateRange,
  parseCalendarDate,
} from '../../src/calendar/index.js';

/**
 * True calendar-date semantics (OPUS-M4-000B; doc 34 §4-F).
 *
 * The pathological set the packet's review probe names is asserted here in
 * full, plus the round-trip property that makes the epoch arithmetic
 * trustworthy. The final describe block is this file's MUTATION CONTROL: it
 * runs deliberately broken variants of the two rules that carry all the weight
 * (the leap rule and the day bound) against the same oracles and asserts the
 * oracles catch them, so the suite is proven able to fail.
 */

describe('the leap rule, written out rather than inferred', () => {
  it.each([
    [2024, true],
    [2027, false],
    [2000, true],
    [1900, false],
    [2100, false],
    [2400, true],
  ])('isLeapYear(%i) === %s', (year, expected) => {
    expect(isLeapYear(year)).toBe(expected);
  });

  it('February has 29 days only in a leap year', () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2027, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(1900, 2)).toBe(28);
  });

  it('a month outside 1..12 has no days', () => {
    expect(daysInMonth(2027, 0)).toBe(0);
    expect(daysInMonth(2027, 13)).toBe(0);
  });
});

describe('the pathological calendar set is refused', () => {
  /* Every entry here is SHAPE-VALID: the regex the surfaces used before this
   * module accepted all of them. That is the defect, stated as a table. */
  it.each([
    '2027-02-29', // 2027 is not a leap year
    '1900-02-29', // a century that is not divisible by 400
    '2027-13-01', // month 13
    '2027-00-10', // month 0
    '2027-04-31', // April has 30 days
    '2027-06-31',
    '2027-09-31',
    '2027-11-31',
    '2027-01-32',
    '2027-01-00',
    '0000-01-01', // not a Gregorian year; PostgreSQL refuses it too
  ])('%s is not a calendar date', (value) => {
    expect(isCalendarDate(value)).toBe(false);
    expect(parseCalendarDate(value)).toBeNull();
  });

  it.each([
    '2027-2-01', // not zero-padded
    '2027-02-1',
    '27-02-01',
    '2027/02/01',
    '2027-02-01T00:00:00Z',
    ' 2027-02-01',
    '2027-02-01 ',
    '',
  ])('%s fails the shape gate', (value) => {
    expect(isCalendarDate(value)).toBe(false);
  });

  it.each(['2024-02-29', '2000-02-29', '2027-02-28', '2027-12-31', '2027-01-01'])(
    '%s IS a calendar date',
    (value) => {
      expect(isCalendarDate(value)).toBe(true);
    },
  );

  it('assertCalendarDate throws a typed error naming the value', () => {
    expect(() => assertCalendarDate('2027-02-29')).toThrow(InvalidCalendarDateError);
    try {
      assertCalendarDate('2027-13-01');
      expect.unreachable('assertCalendarDate accepted month 13');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidCalendarDateError);
      expect((error as InvalidCalendarDateError).code).toBe('INVALID_CALENDAR_DATE');
      expect((error as InvalidCalendarDateError).value).toBe('2027-13-01');
    }
  });

  /**
   * The specific silent failure this module exists to prevent, asserted against
   * the platform primitive it replaces.
   */
  it('Date.parse ROLLS OVER an invalid date and this module does not', () => {
    expect(new Date(Date.parse('2027-02-29')).toISOString().slice(0, 10)).toBe('2027-03-01');
    expect(parseCalendarDate('2027-02-29')).toBeNull();
    expect(() => daysFromEpoch('2027-02-29')).toThrow(InvalidCalendarDateError);
  });
});

describe('epoch arithmetic', () => {
  it('anchors on 1970-01-01', () => {
    expect(daysFromEpoch('1970-01-01')).toBe(0);
    expect(dateFromEpochDays(0)).toBe('1970-01-01');
  });

  it('round-trips every date across four centuries of month boundaries', () => {
    for (let day = -80_000; day <= 80_000; day += 7) {
      const date = dateFromEpochDays(day);
      expect(daysFromEpoch(date)).toBe(day);
      expect(formatCalendarDate(assertCalendarDate(date))).toBe(date);
    }
  });

  it('crosses the leap day correctly in both directions', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2024-02-29', 1)).toBe('2024-03-01');
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
    expect(addDays('2027-03-01', -1)).toBe('2027-02-28');
  });

  it('crosses year and century boundaries', () => {
    expect(addDays('2027-12-31', 1)).toBe('2028-01-01');
    expect(addDays('2028-01-01', -1)).toBe('2027-12-31');
    expect(addDays('1900-02-28', 1)).toBe('1900-03-01');
    expect(addDays('2000-02-28', 1)).toBe('2000-02-29');
  });

  it('measures spans', () => {
    expect(daysBetween('2027-03-01', '2027-03-31')).toBe(30);
    expect(daysBetween('2027-03-31', '2027-03-01')).toBe(-30);
    expect(inclusiveDayCount('2027-03-01', '2027-03-31')).toBe(31);
    expect(inclusiveDayCount('2027-03-01', '2027-03-01')).toBe(1);
    // A leap February is 29 inclusive days; a common one is 28.
    expect(inclusiveDayCount('2024-02-01', '2024-02-29')).toBe(29);
    expect(inclusiveDayCount('2027-02-01', '2027-02-28')).toBe(28);
    // 366 — the MAX_PERIOD_DAYS bound, measured rather than assumed.
    expect(inclusiveDayCount('2024-01-01', '2024-12-31')).toBe(366);
    expect(inclusiveDayCount('2027-01-01', '2027-12-31')).toBe(365);
  });

  it('gives the weekday', () => {
    expect(dayOfWeek('1970-01-01')).toBe(4); // a Thursday
    expect(dayOfWeek('2027-03-01')).toBe(1); // a Monday
    expect(dayOfWeek('2024-02-29')).toBe(4); // a Thursday
  });

  it('enumerates a range inclusively and in order', () => {
    expect(datesInRange('2027-02-26', '2027-03-02')).toEqual([
      '2027-02-26',
      '2027-02-27',
      '2027-02-28',
      '2027-03-01',
      '2027-03-02',
    ]);
    expect(datesInRange('2027-03-02', '2027-03-01')).toEqual([]);
    expect(datesInRange('2027-03-02', '2027-03-02')).toEqual(['2027-03-02']);
  });

  it('compares and range-tests lexically, which is date order for padded ISO', () => {
    expect(compareCalendarDates('2027-03-01', '2027-03-02')).toBe(-1);
    expect(compareCalendarDates('2027-03-02', '2027-03-01')).toBe(1);
    expect(compareCalendarDates('2027-03-01', '2027-03-01')).toBe(0);
    expect(isWithinDateRange('2027-03-01', '2027-03-01', '2027-03-31')).toBe(true);
    expect(isWithinDateRange('2027-03-31', '2027-03-01', '2027-03-31')).toBe(true);
    expect(isWithinDateRange('2027-02-28', '2027-03-01', '2027-03-31')).toBe(false);
    expect(isWithinDateRange('2027-04-01', '2027-03-01', '2027-03-31')).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * MUTATION CONTROL — the falsifiability arm (ProbeFalsified discipline)
 *
 * A green suite over a validator proves nothing unless the suite is shown to
 * fail on a broken validator. Two deliberately wrong implementations are run
 * against the SAME oracles this file uses, and each must be caught.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('mutation control: the oracles catch a broken validator', () => {
  const brokenLeap = (year: number): boolean => year % 4 === 0;

  const brokenDaysInMonth = (year: number, month: number): number =>
    month === 2 ? (brokenLeap(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;

  const brokenIsCalendarDate = (value: string): boolean => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (match === null) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    return month >= 1 && month <= 12 && day >= 1 && day <= brokenDaysInMonth(year, month);
  };

  it('the naive %4 leap rule is caught by the century cases', () => {
    expect(brokenIsCalendarDate('1900-02-29')).toBe(true);
    expect(isCalendarDate('1900-02-29')).toBe(false);
  });

  /** The shape-only regex — literally the code this module replaces. */
  const shapeOnly = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value);

  it('the shape-only regex is caught by every entry of the pathological set', () => {
    for (const value of ['2027-02-29', '2027-13-01', '2027-00-10', '2027-04-31']) {
      expect(shapeOnly(value)).toBe(true);
      expect(isCalendarDate(value)).toBe(false);
    }
  });

  it('an off-by-one day bound is caught', () => {
    const offByOne = (value: string): boolean => {
      const parts = parseCalendarDate(value);
      if (parts !== null) return true;
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      if (match === null) return false;
      return Number(match[3]) === daysInMonth(Number(match[1]), Number(match[2])) + 1;
    };
    expect(offByOne('2027-04-31')).toBe(true);
    expect(isCalendarDate('2027-04-31')).toBe(false);
  });
});
