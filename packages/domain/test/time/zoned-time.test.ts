import { describe, expect, it } from 'vitest';

import {
  isKnownTimeZone,
  isWallClockTime,
  localDayLengthHours,
  minutesOfDay,
  offsetMinutesAt,
  resolveLocalTime,
  resolveShiftInterval,
  zonedDayWindow,
  zonedParts,
} from '../../src/time/index.js';

/**
 * Zone semantics — the DST gap ruling (R-B4), the DST fold ruling (R-B5), the
 * overnight derivation, and the extreme offsets (OPUS-M4-000B; doc 34 §4-F).
 *
 * ## The fixtures are far-future and are chosen for what they prove
 *
 * | zone                  | why it is here                                  |
 * |-----------------------|--------------------------------------------------|
 * | `America/Toronto`     | a 1-hour gap and a 1-hour fold, the ordinary case |
 * | `Europe/London`       | the transitions fall on different dates — a rule
 *                           that hard-coded a US date would pass Toronto and
 *                           fail here                                          |
 * | `Australia/Lord_Howe` | a **30-minute** gap: any rule written as "add an
 *                           hour" is caught by this row and by nothing else    |
 * | `Antarctica/Troll`    | a **2-hour** gap, the other end of the same axis   |
 * | `Pacific/Kiritimati`  | UTC+14, the maximum offset in the tz database      |
 * | `Etc/GMT+12`          | UTC−12, the minimum                               |
 *
 * 2027 is used everywhere, matching the repository's synthetic far-future
 * fixture convention. The transition INSTANTS are never hard-coded: every
 * assertion either reads the offset from the same tz database the code reads,
 * or pins a LOCAL reading, so a tzdb update that moves a rule changes the
 * measured gap and not the meaning of the test.
 */

const TORONTO = 'America/Toronto';
const LONDON = 'Europe/London';
const LORD_HOWE = 'Australia/Lord_Howe';
const TROLL = 'Antarctica/Troll';
const KIRITIMATI = 'Pacific/Kiritimati';
const GMT_MINUS_12 = 'Etc/GMT+12';

/** The 2027 transition dates, stated as LOCAL dates rather than instants. */
const TORONTO_SPRING = '2027-03-14';
const TORONTO_FALL = '2027-11-07';
const LONDON_SPRING = '2027-03-28';
const LONDON_FALL = '2027-10-31';

describe('shape helpers', () => {
  it.each(['00:00', '09:30', '23:59', '12:00'])('%s is a wall-clock time', (value) => {
    expect(isWallClockTime(value)).toBe(true);
  });

  it.each(['24:00', '9:30', '09:5', '23:60', '', '0930', '09:30:00'])(
    '%s is not a wall-clock time',
    (value) => {
      expect(isWallClockTime(value)).toBe(false);
      expect(minutesOfDay(value)).toBeNull();
    },
  );

  it('counts minutes of day', () => {
    expect(minutesOfDay('00:00')).toBe(0);
    expect(minutesOfDay('08:30')).toBe(510);
    expect(minutesOfDay('23:59')).toBe(1439);
  });

  it('knows which zones the tz database has', () => {
    for (const zone of [TORONTO, LONDON, LORD_HOWE, TROLL, KIRITIMATI, GMT_MINUS_12, 'UTC']) {
      expect(isKnownTimeZone(zone)).toBe(true);
    }
    expect(isKnownTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isKnownTimeZone('America/Not_A_City')).toBe(false);
    expect(isKnownTimeZone('')).toBe(false);
  });
});

describe('the ordinary case: one local time, one instant', () => {
  it('resolves a mid-year local time in Toronto', () => {
    const resolved = resolveLocalTime(TORONTO, '2027-07-15', '08:00');
    expect(resolved.kind).toBe('unique');
    expect(resolved.instant.toISOString()).toBe('2027-07-15T12:00:00.000Z');
    expect(zonedParts(TORONTO, resolved.instant).time).toBe('08:00');
  });

  it('resolves midnight, which is the boundary the day window uses', () => {
    const resolved = resolveLocalTime(LONDON, '2027-01-10', '00:00');
    expect(resolved.kind).toBe('unique');
    expect(zonedParts(LONDON, resolved.instant)).toMatchObject({
      date: '2027-01-10',
      time: '00:00',
    });
  });
});

describe('R-B4 — a DST gap resolves FORWARD by the gap duration', () => {
  it('Toronto 02:30 on the spring-forward day becomes 03:30 local (1-hour gap)', () => {
    const resolved = resolveLocalTime(TORONTO, TORONTO_SPRING, '02:30');
    expect(resolved.kind).toBe('gap');
    if (resolved.kind !== 'gap') return;
    expect(resolved.normalization).toBe('gap-forward');
    expect(resolved.shiftedByMillis).toBe(60 * 60 * 1000);
    expect(resolved.resolvedLocalTime).toBe('03:30');
    expect(zonedParts(TORONTO, resolved.instant).date).toBe(TORONTO_SPRING);
  });

  it('London 01:30 on ITS spring-forward day is the gap, and Toronto is not', () => {
    expect(resolveLocalTime(LONDON, LONDON_SPRING, '01:30').kind).toBe('gap');
    // The same local date in Toronto is an ordinary day — the rule is not
    // hard-coded to one hemisphere's calendar.
    expect(resolveLocalTime(TORONTO, LONDON_SPRING, '01:30').kind).toBe('unique');
  });

  it('Lord Howe has a THIRTY-minute gap, which catches any "add an hour" rule', () => {
    const resolved = resolveLocalTime(LORD_HOWE, '2027-10-03', '02:15');
    expect(resolved.kind).toBe('gap');
    if (resolved.kind !== 'gap') return;
    expect(resolved.shiftedByMillis).toBe(30 * 60 * 1000);
    expect(resolved.resolvedLocalTime).toBe('02:45');
  });

  it('Troll has a TWO-hour gap, the other end of the same axis', () => {
    const resolved = resolveLocalTime(TROLL, '2027-03-28', '02:00');
    expect(resolved.kind).toBe('gap');
    if (resolved.kind !== 'gap') return;
    expect(resolved.shiftedByMillis).toBe(2 * 60 * 60 * 1000);
    expect(resolved.resolvedLocalTime).toBe('04:00');
  });

  it('the instant a gap resolves to reads back as a REAL local time', () => {
    /* The property that makes the ruling safe: whatever we produce, reading it
     * back in the zone gives a wall-clock time that exists. A rule that simply
     * returned the nominal instant would fail this. */
    for (const [zone, date, time] of [
      [TORONTO, TORONTO_SPRING, '02:30'],
      [LONDON, LONDON_SPRING, '01:00'],
      [LORD_HOWE, '2027-10-03', '02:15'],
      [TROLL, '2027-03-28', '02:59'],
    ] as const) {
      const resolved = resolveLocalTime(zone, date, time);
      expect(resolved.kind).toBe('gap');
      const back = zonedParts(zone, resolved.instant);
      expect(isWallClockTime(back.time)).toBe(true);
      expect(resolveLocalTime(zone, back.date, back.time).kind).not.toBe('gap');
    }
  });

  it('the boundary minute either side of a gap is NOT a gap', () => {
    expect(resolveLocalTime(TORONTO, TORONTO_SPRING, '01:59').kind).toBe('unique');
    expect(resolveLocalTime(TORONTO, TORONTO_SPRING, '03:00').kind).toBe('unique');
  });
});

describe('R-B5 — a DST fold resolves by ROLE: start earliest, end latest', () => {
  it('Toronto 01:30 on the fall-back day happens twice and both are named', () => {
    const earliest = resolveLocalTime(TORONTO, TORONTO_FALL, '01:30', 'earliest');
    const latest = resolveLocalTime(TORONTO, TORONTO_FALL, '01:30', 'latest');
    expect(earliest.kind).toBe('fold');
    expect(latest.kind).toBe('fold');
    if (earliest.kind !== 'fold' || latest.kind !== 'fold') return;

    expect(earliest.disambiguation).toBe('earliest');
    expect(latest.disambiguation).toBe('latest');
    expect(earliest.instant.getTime()).toBe(earliest.earliestInstant.getTime());
    expect(latest.instant.getTime()).toBe(latest.latestInstant.getTime());
    // The two occurrences are exactly the transition apart, and both read as 01:30.
    expect(latest.instant.getTime() - earliest.instant.getTime()).toBe(60 * 60 * 1000);
    expect(zonedParts(TORONTO, earliest.instant).time).toBe('01:30');
    expect(zonedParts(TORONTO, latest.instant).time).toBe('01:30');
    // Different offsets — that is what "twice" means.
    expect(offsetMinutesAt(TORONTO, earliest.instant)).toBe(-240);
    expect(offsetMinutesAt(TORONTO, latest.instant)).toBe(-300);
  });

  it('the default policy is earliest, so a bare call never silently delays a start', () => {
    const bare = resolveLocalTime(TORONTO, TORONTO_FALL, '01:30');
    const explicit = resolveLocalTime(TORONTO, TORONTO_FALL, '01:30', 'earliest');
    expect(bare.instant.getTime()).toBe(explicit.instant.getTime());
  });

  it('London folds on its own date and Toronto does not', () => {
    expect(resolveLocalTime(LONDON, LONDON_FALL, '01:30').kind).toBe('fold');
    expect(resolveLocalTime(TORONTO, LONDON_FALL, '01:30').kind).toBe('unique');
  });

  it('the boundary minute either side of a fold is NOT a fold', () => {
    expect(resolveLocalTime(TORONTO, TORONTO_FALL, '00:59').kind).toBe('unique');
    expect(resolveLocalTime(TORONTO, TORONTO_FALL, '02:00').kind).toBe('unique');
  });
});

describe('overnight shifts and the DST-day durations', () => {
  it('an overnight shift ends on the NEXT calendar day', () => {
    const interval = resolveShiftInterval(TORONTO, '2027-07-15', '22:00', '06:00');
    expect(interval.crossesMidnight).toBe(true);
    expect(interval.endDate).toBe('2027-07-16');
    expect(interval.nominalDurationMinutes).toBe(480);
    expect(interval.elapsedMinutes).toBe(480);
    expect(interval.endsAt.getTime()).toBeGreaterThan(interval.startsAt.getTime());
  });

  it('a same-day shift does not', () => {
    const interval = resolveShiftInterval(TORONTO, '2027-07-15', '08:00', '16:00');
    expect(interval.crossesMidnight).toBe(false);
    expect(interval.endDate).toBe('2027-07-15');
    expect(interval.elapsedMinutes).toBe(480);
  });

  it('a 24-hour shift is treated as overnight, not as zero length', () => {
    const interval = resolveShiftInterval(TORONTO, '2027-07-15', '08:00', '08:00');
    expect(interval.crossesMidnight).toBe(true);
    expect(interval.nominalDurationMinutes).toBe(1440);
    expect(interval.endsAt.getTime()).toBeGreaterThan(interval.startsAt.getTime());
  });

  it('a shift spanning the SPRING transition elapses one hour LESS than the wall clock', () => {
    const interval = resolveShiftInterval(TORONTO, '2027-03-13', '22:00', '06:00');
    expect(interval.nominalDurationMinutes).toBe(480);
    expect(interval.elapsedMinutes).toBe(420);
    expect(interval.endsAt.getTime()).toBeGreaterThan(interval.startsAt.getTime());
  });

  it('a shift spanning the FALL transition elapses one hour MORE', () => {
    const interval = resolveShiftInterval(TORONTO, '2027-11-06', '22:00', '06:00');
    expect(interval.nominalDurationMinutes).toBe(480);
    expect(interval.elapsedMinutes).toBe(540);
  });

  /**
   * The reason R-B5 is one rule and not two, asserted as the degenerate case it
   * prevents. A shift starting inside the repeated hour and ending inside it
   * would, under "earliest for both", produce `endsAt <= startsAt` — which
   * `assignment_snapshots_interval` refuses, as a 500 rather than a schedule.
   */
  it('a short shift INSIDE the repeated hour is never degenerate', () => {
    const interval = resolveShiftInterval(TORONTO, TORONTO_FALL, '01:15', '01:45');
    expect(interval.crossesMidnight).toBe(false);
    expect(interval.endsAt.getTime()).toBeGreaterThan(interval.startsAt.getTime());
    // Start on the FIRST 01:15, end on the SECOND 01:45 — the repeated hour is
    // covered once, and the elapsed time is the nominal 30 minutes plus the
    // repeated hour.
    expect(interval.nominalDurationMinutes).toBe(30);
    expect(interval.elapsedMinutes).toBe(90);
    expect(interval.start.kind).toBe('fold');
    expect(interval.end.kind).toBe('fold');
  });

  /* ────────────────────────────────────────────────────────────────────────
   * R-B4a — the joint-resolution repair (review finding B-1)
   *
   * The original fixture used 02:30→10:00: seven and a half hours, long enough
   * that pushing only the START forward still left the end well ahead of it. It
   * passed, and it proved nothing about the case that was broken. A shift
   * SHORTER than the gap is the case that inverts, and it is now pinned in all
   * three zones — 1 h, 30 min and 2 h gaps — because a rule written as "add an
   * hour" and a rule written as "add the gap" are indistinguishable until the
   * gap is not an hour.
   * ──────────────────────────────────────────────────────────────────────── */

  it.each([
    // zone, date, start, end, gap minutes, authored duration (< gap)
    [TORONTO, TORONTO_SPRING, '02:30', '03:00', 60, 30],
    [LORD_HOWE, '2027-10-03', '02:10', '02:25', 30, 15],
    [TROLL, '2027-03-28', '01:30', '02:30', 120, 60],
  ] as const)(
    'R-B4a: in %s a shift SHORTER than the gap keeps its authored duration and stays ordered',
    (zone, date, start, end, gapMinutes, authored) => {
      const interval = resolveShiftInterval(zone, date, start, end);

      // The defect: this was NEGATIVE (New York gave elapsed = −30).
      expect(interval.endsAt.getTime()).toBeGreaterThan(interval.startsAt.getTime());
      expect(interval.elapsedMinutes).toBe(authored);
      expect(interval.nominalDurationMinutes).toBe(authored);
      expect(authored).toBeLessThan(gapMinutes);

      // The whole interval moved forward by the gap, not just its start.
      expect(interval.start.kind).toBe('gap');
      if (interval.start.kind !== 'gap') return;
      expect(interval.start.shiftedByMillis).toBe(gapMinutes * 60 * 1000);

      // Both endpoints read back as REAL local times.
      for (const instant of [interval.startsAt, interval.endsAt]) {
        const back = zonedParts(zone, instant);
        expect(resolveLocalTime(zone, back.date, back.time).kind).not.toBe('gap');
      }
    },
  );

  /* The explicit timeout: thousands of `Intl.DateTimeFormat` resolutions make
   * this the one test in the file whose cost is bounded by raw machine speed
   * rather than by logic, and the spread across machines is wide. Measured at
   * 6.3 s in a container and 7.4 s on a loaded shared CI runner — both past
   * vitest's 5 s default, failing the gate for a reason that has nothing to do
   * with the code under test. The generous ceiling is the one
   * `apps/api/vitest.config.ts` uses for its storm tests, and for the same
   * reason: a timeout should catch a hang, not a slow box. The sweep's ranges,
   * step and assertion below are unchanged — this bounds only how long it is
   * allowed to take. */
  it('R-B4a: NO (start, end) pair in any gap zone resolves to a non-positive interval', () => {
    /* The exhaustive form of the finding. Before the repair this enumeration
     * produced 399 degenerate pairs — 78 in New York, 21 in Lord Howe, 300 in
     * Troll. Sampling three of them would have left the other 396 unguarded. */
    let degenerate = 0;
    for (const [zone, date] of [
      [TORONTO, TORONTO_SPRING],
      [LORD_HOWE, '2027-10-03'],
      [TROLL, '2027-03-28'],
    ] as const) {
      for (let startMinute = 0; startMinute < 300; startMinute += 5) {
        for (let endMinute = startMinute + 5; endMinute < 420; endMinute += 5) {
          const at = (m: number): string =>
            `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
          const interval = resolveShiftInterval(zone, date, at(startMinute), at(endMinute));
          if (interval.elapsedMinutes <= 0) degenerate += 1;
        }
      }
    }
    expect(degenerate).toBe(0);
  }, 120_000);

  it('a shift starting inside a GAP is normalized forward and stays positive', () => {
    const interval = resolveShiftInterval(TORONTO, TORONTO_SPRING, '02:30', '10:00');
    expect(interval.start.kind).toBe('gap');
    expect(interval.endsAt.getTime()).toBeGreaterThan(interval.startsAt.getTime());
    expect(zonedParts(TORONTO, interval.startsAt).time).toBe('03:30');
  });

  it('a local day is 23, 24 or 25 hours long', () => {
    expect(localDayLengthHours(TORONTO, '2027-07-15')).toBe(24);
    expect(localDayLengthHours(TORONTO, TORONTO_SPRING)).toBe(23);
    expect(localDayLengthHours(TORONTO, TORONTO_FALL)).toBe(25);
    expect(localDayLengthHours(LORD_HOWE, '2027-10-03')).toBe(23.5);
    expect(localDayLengthHours(TROLL, '2027-03-28')).toBe(22);
  });

  it('the day window is half-open, so a shift ending at local midnight belongs to one day', () => {
    const window = zonedDayWindow(TORONTO, '2027-07-15', '2027-07-15');
    expect(window.start.toISOString()).toBe('2027-07-15T04:00:00.000Z');
    expect(window.end.toISOString()).toBe('2027-07-16T04:00:00.000Z');
    expect((window.end.getTime() - window.start.getTime()) / 3_600_000).toBe(24);
  });

  it('the day window over a DST day is 23 or 25 hours, not 24', () => {
    const spring = zonedDayWindow(TORONTO, TORONTO_SPRING, TORONTO_SPRING);
    const fall = zonedDayWindow(TORONTO, TORONTO_FALL, TORONTO_FALL);
    expect((spring.end.getTime() - spring.start.getTime()) / 3_600_000).toBe(23);
    expect((fall.end.getTime() - fall.start.getTime()) / 3_600_000).toBe(25);
  });
});

describe('the extreme offsets: UTC+14 and UTC−12', () => {
  it('UTC+14 is a full calendar day ahead of UTC−12', () => {
    const instant = new Date('2027-06-15T12:00:00.000Z');
    expect(offsetMinutesAt(KIRITIMATI, instant)).toBe(14 * 60);
    expect(offsetMinutesAt(GMT_MINUS_12, instant)).toBe(-12 * 60);
    expect(zonedParts(KIRITIMATI, instant).date).toBe('2027-06-16');
    expect(zonedParts(GMT_MINUS_12, instant).date).toBe('2027-06-15');
    // 26 hours apart — the widest spread the tz database can produce.
    const east = resolveLocalTime(KIRITIMATI, '2027-06-15', '00:00').instant;
    const west = resolveLocalTime(GMT_MINUS_12, '2027-06-15', '00:00').instant;
    expect((west.getTime() - east.getTime()) / 3_600_000).toBe(26);
  });

  it('neither extreme zone has a gap or a fold', () => {
    for (const zone of [KIRITIMATI, GMT_MINUS_12, 'UTC']) {
      for (const date of ['2027-03-14', '2027-03-28', '2027-10-31', '2027-11-07']) {
        for (const time of ['00:00', '01:30', '02:30', '23:59']) {
          expect(resolveLocalTime(zone, date, time).kind).toBe('unique');
        }
      }
    }
  });

  it('an overnight shift in UTC+14 still lands on the right local days', () => {
    const interval = resolveShiftInterval(KIRITIMATI, '2027-02-28', '20:00', '04:00');
    expect(interval.endDate).toBe('2027-03-01'); // 2027 is not a leap year
    expect(zonedParts(KIRITIMATI, interval.startsAt).date).toBe('2027-02-28');
    expect(zonedParts(KIRITIMATI, interval.endsAt).date).toBe('2027-03-01');
  });

  it('an overnight shift across a LEAP day lands on 29 February', () => {
    const interval = resolveShiftInterval(TORONTO, '2028-02-28', '20:00', '04:00');
    expect(interval.endDate).toBe('2028-02-29');
    expect(zonedParts(TORONTO, interval.endsAt).date).toBe('2028-02-29');
  });
});

describe('the rolled-over date is refused rather than laundered into an instant', () => {
  it('a shape-valid, calendar-invalid date throws', () => {
    expect(() => resolveShiftInterval(TORONTO, '2027-02-29', '08:00', '16:00')).toThrow(
      /INVALID_CALENDAR_DATE|ZONED_TIME_BAD_DATE/,
    );
  });

  it('a bad time shape throws', () => {
    expect(() => resolveLocalTime(TORONTO, '2027-07-15', '24:00')).toThrow(/ZONED_TIME_BAD_TIME/);
    expect(() => resolveLocalTime(TORONTO, '2027/07/15', '08:00')).toThrow(/ZONED_TIME_BAD_DATE/);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * MUTATION CONTROL — the falsifiability arm
 *
 * The single-probe resolution is the implementation everybody writes first. It
 * is wrong in exactly one way — it cannot see the second occurrence of a fold —
 * and the fold assertions above are what catch it. Proven here rather than
 * asserted in a comment.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('mutation control: the naive single-probe resolution is caught', () => {
  const naive = (zone: string, date: string, time: string): { instants: number[] } => {
    const nominal = Date.UTC(
      Number(date.slice(0, 4)),
      Number(date.slice(5, 7)) - 1,
      Number(date.slice(8, 10)),
      Number(time.slice(0, 2)),
      Number(time.slice(3, 5)),
    );
    const first = nominal - offsetMinutesAt(zone, new Date(nominal)) * 60_000;
    const second = nominal - offsetMinutesAt(zone, new Date(first)) * 60_000;
    return { instants: [...new Set([first, second])] };
  };

  it('the naive probe finds only ONE occurrence of the Toronto fold', () => {
    expect(naive(TORONTO, TORONTO_FALL, '01:30').instants).toHaveLength(1);

    const earliest = resolveLocalTime(TORONTO, TORONTO_FALL, '01:30', 'earliest');
    const latest = resolveLocalTime(TORONTO, TORONTO_FALL, '01:30', 'latest');
    expect(earliest.kind).toBe('fold');
    expect(latest.instant.getTime()).not.toBe(earliest.instant.getTime());
  });

  it('a fixed one-hour gap rule is caught by Lord Howe and Troll', () => {
    const fixedHour = 60 * 60 * 1000;
    for (const [zone, date, time, realGap] of [
      [LORD_HOWE, '2027-10-03', '02:15', 30 * 60 * 1000],
      [TROLL, '2027-03-28', '02:00', 2 * 60 * 60 * 1000],
    ] as const) {
      const resolved = resolveLocalTime(zone, date, time);
      expect(resolved.kind).toBe('gap');
      if (resolved.kind !== 'gap') continue;
      expect(resolved.shiftedByMillis).toBe(realGap);
      expect(resolved.shiftedByMillis).not.toBe(fixedHour);
    }
  });
});
