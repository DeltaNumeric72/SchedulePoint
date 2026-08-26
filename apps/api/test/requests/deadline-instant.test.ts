import { describe, expect, it } from 'vitest';

import { deadlineInstant, localDate } from '../../src/requests/deadlines.js';

/**
 * §3's deadline INSTANT, across DST transitions and non-UTC zones
 * (OPUS-M5-001, doc 42 §5c Part B; R-09's zone half).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## Why this file exists, stated as the gap it closes
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `packages/domain/test/requests/deadlines.test.ts` covers §3's arithmetic —
 * the roll, the boundary, the late policy — and it is deliberately zone-free,
 * because `packages/domain` has no clock and no zone. `lifecycle-service.test.ts`
 * drives the whole computation through the service against the real fixture.
 *
 * **But every fixture group's `timezone` is `UTC`** (migration 0009:
 * `ALTER TABLE groups ADD COLUMN timezone text NOT NULL DEFAULT 'UTC'`), so the
 * one part of §3 that is genuinely hard — turning a calendar DEADLINE into a
 * stored `timestamptz` in the group's own zone — was exercised only in the zone
 * where it cannot go wrong. A test suite that covers the hard code path with its
 * easiest input is a suite that reports the coverage without the assurance.
 *
 * So this file drives `deadlineInstant` and `localDate` directly, in real zones,
 * across real transitions. No cluster and no fixture: these are pure functions
 * over `Intl`, and giving them a database would only make them slower to falsify.
 *
 * ## What the instant MEANS, and why the naive answer is wrong twice a year
 *
 * `requests.expires_at` is a `timestamptz` and the policy is a calendar date. The
 * instant stored is the **END of the effective deadline day in the group's
 * zone** — the first instant of the following day — so a request submitted at
 * 23:59 local on the deadline is inside it. Computing it by adding a fixed number
 * of hours to a UTC midnight is wrong in every zone that observes DST, on the two
 * days a year when the offset changes; and taking midnight at the START of the
 * day would silently make the deadline the day before, which is the ambiguity
 * §3's roll policy exists to remove rather than to introduce.
 *
 * ## The transition dates are a TRIPWIRE, not a derivation
 *
 * The first case MEASURES where the 2046 transitions actually fall in
 * `America/New_York` — and then compares the measurement against two pinned
 * literals, `2046-03-11` and `2046-11-04`. So it is not deriving the dates the
 * later cases use; those dates are written into them. What it is doing is
 * failing loudly if this runtime's **tz database** ever disagrees with the
 * literals the rest of the file rests on — a jurisdiction moving its clocks, or
 * an ICU update landing under the suite.
 *
 * That is deliberately the weaker-sounding claim and the more useful control.
 * A genuinely derived test would silently re-aim itself at whatever the tz
 * database said and could no longer notice the change; this one stops.
 */

/** The zone's UTC offset at `instant`, as `GMT±H[:MM]`. */
function offsetAt(zone: string, instant: Date): string {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' })
    .formatToParts(instant)
    .find((candidate) => candidate.type === 'timeZoneName');
  return part?.value ?? '';
}

/** The day in `month` whose following day has a different offset, or null. */
function transitionDay(zone: string, year: number, month: number): string | null {
  for (let day = 1; day <= 28; day += 1) {
    const before = new Date(Date.UTC(year, month - 1, day));
    const after = new Date(Date.UTC(year, month - 1, day + 1));
    if (offsetAt(zone, before) !== offsetAt(zone, after)) {
      return `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  return null;
}

const NEW_YORK = 'America/New_York';
/** A half-hour-offset zone. Whole-hour arithmetic passes UTC and fails here. */
const KOLKATA = 'Asia/Kolkata';
/** A zone whose DST shift is THIRTY minutes, not sixty. */
const LORD_HOWE = 'Australia/Lord_Howe';

/** `expires_at` must be exactly the first instant of the day AFTER `deadline`. */
function expectEndOfDay(zone: string, deadline: string, nextDay: string): void {
  const instant = deadlineInstant(deadline, zone);

  /* The instant falls on the FOLLOWING day, locally. */
  expect(localDate(instant, zone), `${zone} ${deadline}: local date of the instant`).toBe(nextDay);

  /* It is local MIDNIGHT — the first instant of that day. */
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  }).formatToParts(instant);
  const field = (type: string): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  expect(`${field('hour')}:${field('minute')}`, `${zone} ${deadline}: local time`).toBe('00:00');

  /* One minute EARLIER is still the deadline day — which is the property that
   * matters to a requester submitting at 23:59 local. Asserting only the two
   * above would pass for an instant a whole day late. */
  const oneMinuteBefore = new Date(instant.getTime() - 60_000);
  expect(localDate(oneMinuteBefore, zone), `${zone} ${deadline}: the minute before`).toBe(deadline);
}

describe('the DST premises these cases rest on are MEASURED, not assumed', () => {
  it('America/New_York changes offset twice in 2046, in March and November', () => {
    const spring = transitionDay(NEW_YORK, 2046, 3);
    const autumn = transitionDay(NEW_YORK, 2046, 11);
    expect(spring, 'a spring transition must exist').not.toBeNull();
    expect(autumn, 'an autumn transition must exist').not.toBeNull();
    /* Measured on this runtime's tz database rather than looked up. */
    expect(spring).toBe('2046-03-11');
    expect(autumn).toBe('2046-11-04');
  });

  it('the fixture zone is UTC — zero offset, year-round, which is why this file exists', () => {
    /* Migration 0009 defaults `groups.timezone` to 'UTC'. Stated as an assertion
     * so that the day a fixture starts seeding a real zone, this file's premise
     * is re-examined rather than silently outdated.
     *
     * **Asserted as a PROPERTY, not as a format string.** The first spelling of
     * this case compared `shortOffset` against `'GMT'` and failed on
     * `'GMT+0'` — a difference in how this runtime's ICU renders a zero offset,
     * not a difference in any fact about UTC. A premise-check that can fail on an
     * ICU version bump is a premise-check that will eventually cry wolf about
     * something it was never asking. So it asks the real question instead: does
     * UTC shift at all across the year, and is the end of a UTC day exactly the
     * next UTC midnight. */
    const january = deadlineInstant('2046-01-15', 'UTC');
    const july = deadlineInstant('2046-07-15', 'UTC');
    expect(january.toISOString(), 'a UTC deadline day ends at the next UTC midnight').toBe(
      '2046-01-16T00:00:00.000Z',
    );
    expect(july.toISOString(), 'and does so in July too — UTC never shifts').toBe(
      '2046-07-16T00:00:00.000Z',
    );
    /* And the offset spelling is STABLE within this runtime, whatever it is —
     * which is the only thing about the rendering that matters here. */
    expect(offsetAt('UTC', january)).toBe(offsetAt('UTC', july));
  });
});

describe('§3 — `expires_at` is the END of the deadline day, in the GROUP\'s zone', () => {
  it('an ordinary day in a whole-hour negative-offset zone', () => {
    expectEndOfDay(NEW_YORK, '2046-06-18', '2046-06-19');
  });

  it('an ordinary day in a HALF-hour positive-offset zone', () => {
    /* Asia/Kolkata is UTC+05:30. Any implementation that added a whole number of
     * hours to a UTC midnight passes every New York case above and fails here. */
    expectEndOfDay(KOLKATA, '2046-06-18', '2046-06-19');
  });

  it('UTC itself — the fixture\'s zone, so the easy case is still asserted', () => {
    expectEndOfDay('UTC', '2046-06-18', '2046-06-19');
  });
});

describe('R-09\'s zone half — the two days a year a fixed offset is wrong', () => {
  it('the SPRING-FORWARD day: the deadline day is 23 hours long', () => {
    /* 2046-03-11 in New York loses an hour at 02:00 local. A deadline ON that
     * day still expires at the first instant of the 12th, and the instant is
     * 23 hours after the day's start, not 24. */
    expectEndOfDay(NEW_YORK, '2046-03-11', '2046-03-12');
  });

  it('the day BEFORE the spring transition, whose end IS the short day\'s start', () => {
    expectEndOfDay(NEW_YORK, '2046-03-10', '2046-03-11');
  });

  it('the FALL-BACK day: the deadline day is 25 hours long', () => {
    /* 2046-11-04 repeats an hour. The end of the day is unambiguous even though
     * 01:30 local occurs twice — which is why the search takes the FIRST instant
     * whose local time is midnight on the following day. */
    expectEndOfDay(NEW_YORK, '2046-11-04', '2046-11-05');
  });

  it('the day BEFORE the fall-back transition', () => {
    expectEndOfDay(NEW_YORK, '2046-11-03', '2046-11-04');
  });

  it('a THIRTY-MINUTE DST shift (Australia/Lord_Howe) across its transition', () => {
    /* Lord Howe's DST shift is half an hour, not a whole one — the case that
     * breaks an implementation which special-cased "DST means one hour". */
    const springAu = transitionDay(LORD_HOWE, 2046, 10);
    expect(springAu, 'Lord Howe must have an October transition').not.toBeNull();
    if (springAu !== null) {
      const next = new Date(`${springAu}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      expectEndOfDay(LORD_HOWE, springAu, next.toISOString().slice(0, 10));
    }
  });
});

describe('a month of consecutive days, every one internally consistent', () => {
  it('spans both New York transitions without a single off-by-one', () => {
    /* The sweep is the assertion that matters most: any single case can be made
     * to pass by hand, and an off-by-one that only bites on a transition
     * boundary is exactly what a hand-picked set of dates misses. Every day of
     * March and November 2046 — the two transition months — is checked for the
     * same three properties. */
    for (const month of [3, 11] as const) {
      for (let day = 1; day <= 28; day += 1) {
        const deadline = `2046-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const next = new Date(`${deadline}T00:00:00Z`);
        next.setUTCDate(next.getUTCDate() + 1);
        expectEndOfDay(NEW_YORK, deadline, next.toISOString().slice(0, 10));
      }
    }
  });
});
