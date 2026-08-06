import { describe, expect, it } from 'vitest';

import { daysCovered, localPartsIn } from '../../src/http/routes/schedule-views.route.js';

/**
 * The staff view's two pure time functions (OPUS-M3-006).
 *
 * These are unit tests with no database, and they exist because the failures
 * they catch are invisible in an integration test that happens to run in one
 * zone in one season: a shift on the wrong DAY, and a phantom entry on the
 * morning after an evening shift.
 *
 * **Two DST transitions**, each driven from BOTH sides — the US spring-forward
 * and the New Zealand end-of-daylight-time. Counted precisely because an earlier
 * version of this docblock called it "four transitions", which is four
 * assertions over two transitions.
 *
 * Every case below is stated as an instant and an expected LOCAL rendering, so a
 * regression cannot be argued away as "the machine's zone" — none of these
 * assertions depends on where the test runs.
 */

describe('localPartsIn — the group zone decides the day, not the server', () => {
  it('a large positive offset moves an assignment to the NEXT local day', () => {
    // 20:00Z on 3 June is 08:00 on 4 June in Auckland (NZST, +12). A renderer
    // that used the UTC date would put this shift on the wrong day, and the
    // person would arrive twenty-four hours late.
    expect(localPartsIn(new Date('2029-06-03T20:00:00.000Z'), 'Pacific/Auckland')).toEqual({
      date: '2029-06-04',
      time: '08:00',
    });
  });

  it('a negative offset moves an assignment to the PREVIOUS local day', () => {
    // 02:00Z on 5 June is 22:00 on 4 June in New York (EDT, -4).
    expect(localPartsIn(new Date('2029-06-05T02:00:00.000Z'), 'America/New_York')).toEqual({
      date: '2029-06-04',
      time: '22:00',
    });
  });

  it('midnight renders as 00:00, never 24:00', () => {
    // The exclusive-end rule in `daysCovered` tests for the literal string
    // `00:00`, so a formatter that produced `24:00` would silently put a
    // phantom entry on the following morning for every evening shift.
    expect(localPartsIn(new Date('2029-06-03T12:00:00.000Z'), 'Pacific/Auckland')).toEqual({
      date: '2029-06-04',
      time: '00:00',
    });
    expect(localPartsIn(new Date('2029-01-01T00:00:00.000Z'), 'UTC').time).toBe('00:00');
  });

  it('resolves either side of a northern-hemisphere DST transition', () => {
    // The US spring-forward is 2029-03-11 at 02:00 local. One hour before the
    // transition is EST (-5); one hour after is EDT (-4).
    expect(localPartsIn(new Date('2029-03-11T06:30:00.000Z'), 'America/New_York')).toEqual({
      date: '2029-03-11',
      time: '01:30',
    });
    expect(localPartsIn(new Date('2029-03-11T07:30:00.000Z'), 'America/New_York')).toEqual({
      date: '2029-03-11',
      time: '03:30',
    });
  });

  it('resolves either side of a southern-hemisphere DST transition', () => {
    // New Zealand ends daylight time on 2029-04-01 at 03:00 NZDT (+13 → +12).
    expect(localPartsIn(new Date('2029-03-31T13:30:00.000Z'), 'Pacific/Auckland')).toEqual({
      date: '2029-04-01',
      time: '02:30',
    });
    expect(localPartsIn(new Date('2029-03-31T14:30:00.000Z'), 'Pacific/Auckland')).toEqual({
      date: '2029-04-01',
      time: '02:30',
    });
    // Same wall clock, one hour apart — which is the whole reason a rendering
    // carries the instants as well as the local time.
  });
});

describe('daysCovered — an overnight shift occupies both days, an evening shift does not', () => {
  it('a same-day shift covers exactly one day', () => {
    expect(daysCovered('2029-06-04', '2029-06-04', '16:00')).toEqual(['2029-06-04']);
  });

  it('a 22:00 → 06:00 shift covers BOTH days', () => {
    expect(daysCovered('2029-06-06', '2029-06-07', '06:00')).toEqual(['2029-06-06', '2029-06-07']);
  });

  it('a shift ending exactly at midnight does NOT occupy the next day', () => {
    // 16:00 → 00:00. Nobody is at work at any point during 7 June, and an
    // inclusive end date would put an entry on every following morning's sheet
    // for every evening shift in the system.
    expect(daysCovered('2029-06-06', '2029-06-07', '00:00')).toEqual(['2029-06-06']);
  });

  it('a full 24-hour on-call that does NOT start at midnight covers both days', () => {
    // 08:00 → 08:00. Distinct from the case above at this interface, which the
    // previous version of this test was not: it asserted the identical call
    // (`'2029-06-06', '2029-06-07', '00:00'`) under a different name, so it
    // measured nothing the line before it had not already measured.
    expect(daysCovered('2029-06-06', '2029-06-07', '08:00')).toEqual(['2029-06-06', '2029-06-07']);
  });

  it('a multi-day assignment covers every day between its endpoints', () => {
    expect(daysCovered('2029-06-06', '2029-06-09', '06:00')).toEqual([
      '2029-06-06',
      '2029-06-07',
      '2029-06-08',
      '2029-06-09',
    ]);
  });

  it('a month boundary is calendar arithmetic, not a day counter', () => {
    expect(daysCovered('2029-06-30', '2029-07-01', '06:00')).toEqual(['2029-06-30', '2029-07-01']);
  });
});
