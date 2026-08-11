import { describe, expect, it } from 'vitest';

import {
  cellKey,
  cellRevision,
  zonedInstant,
  zonedResolution,
} from '../../src/http/routes/schedule-authoring.route.js';

/**
 * The authoring surface's two pure functions (OPUS-M3-004).
 *
 * Both are load-bearing and neither needs a database, so they are proven here
 * rather than inside the HTTP suite — a property that can be falsified in
 * milliseconds should not be observable only through a transaction.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * zonedInstant — the server owns the instant
 * ──────────────────────────────────────────────────────────────────────────── */

describe('zonedInstant resolves a wall-clock time in the GROUP timezone', () => {
  it('is the identity in UTC', () => {
    expect(zonedInstant('2027-03-02', '08:00', 'UTC').toISOString()).toBe(
      '2027-03-02T08:00:00.000Z',
    );
  });

  it('applies a fixed offset zone', () => {
    // Asia/Kolkata is UTC+05:30 all year — no transition to reason about, so a
    // failure here is arithmetic rather than a boundary case.
    expect(zonedInstant('2027-03-02', '08:00', 'Asia/Kolkata').toISOString()).toBe(
      '2027-03-02T02:30:00.000Z',
    );
  });

  it('uses the offset in force on each side of a NORTHERN spring transition', () => {
    // America/New_York moves UTC-5 → UTC-4 on 2027-03-14.
    expect(zonedInstant('2027-03-13', '08:00', 'America/New_York').toISOString()).toBe(
      '2027-03-13T13:00:00.000Z',
    );
    expect(zonedInstant('2027-03-15', '08:00', 'America/New_York').toISOString()).toBe(
      '2027-03-15T12:00:00.000Z',
    );
  });

  it('uses the offset in force on each side of a SOUTHERN transition', () => {
    // Australia/Sydney moves UTC+11 → UTC+10 on 2027-04-04.
    expect(zonedInstant('2027-04-03', '08:00', 'Australia/Sydney').toISOString()).toBe(
      '2027-04-02T21:00:00.000Z',
    );
    expect(zonedInstant('2027-04-05', '08:00', 'Australia/Sydney').toISOString()).toBe(
      '2027-04-04T22:00:00.000Z',
    );
  });

  /**
   * The reason the conversion is two passes.
   *
   * A single-pass conversion reads the offset at the NAIVE instant — the wall
   * clock interpreted as if it were UTC — which on a transition day is the
   * offset from the wrong side. 01:30 on the northern spring-forward date is the
   * sharpest case: the naive instant sits before the change and the real one
   * sits after it.
   *
   * This assertion fails if the second pass is deleted, which is what makes the
   * second pass evidence rather than decoration.
   */
  it('a transition-day early-morning time lands on the correct side', () => {
    // 2027-03-14 01:30 New York is still UTC-5 (the change happens at 02:00).
    expect(zonedInstant('2027-03-14', '01:30', 'America/New_York').toISOString()).toBe(
      '2027-03-14T06:30:00.000Z',
    );
    // 2027-03-14 03:30 is already UTC-4.
    expect(zonedInstant('2027-03-14', '03:30', 'America/New_York').toISOString()).toBe(
      '2027-03-14T07:30:00.000Z',
    );
  });

  /**
   * R-B4, on the real authoring surface (OPUS-M4-000B; doc 34 §4-F).
   *
   * This assertion used to say "*Any answer is a choice*" and check only that
   * the result was not NaN. That is exactly the unstated rule doc 34 §4-F names:
   * a behaviour nobody reviewed and the next editor could change without any
   * test noticing. The rule is now stated — **a gap resolves FORWARD by the
   * transition's own gap duration** — so the test asserts the rule.
   */
  it('R-B4: a nonexistent wall-clock time resolves FORWARD by the gap', () => {
    // 02:30 on the spring-forward date does not exist in New York; 03:30 does.
    const resolved = zonedInstant('2027-03-14', '02:30', 'America/New_York');
    expect(Number.isNaN(resolved.getTime())).toBe(false);
    expect(resolved.toISOString()).toBe('2027-03-14T07:30:00.000Z');

    const named = zonedResolution('2027-03-14', '02:30', 'America/New_York');
    expect(named.kind).toBe('gap');
    if (named.kind !== 'gap') return;
    expect(named.normalization).toBe('gap-forward');
    expect(named.shiftedByMillis).toBe(60 * 60 * 1000);
    expect(named.resolvedLocalTime).toBe('03:30');

    // Deterministic: the same input gives the same instant, every time.
    expect(zonedInstant('2027-03-14', '02:30', 'America/New_York').toISOString()).toBe(
      resolved.toISOString(),
    );
  });

  /**
   * R-B5, on the real authoring surface.
   *
   * The implementation this route used before OPUS-M4-000B could not represent
   * this case at all: both of its probes landed on the same offset, so the
   * second occurrence of the repeated hour was invisible and "ambiguous" and
   * "unique" were the same answer. The two occurrences are asserted to be
   * distinct here, which is what makes the fix observable from this surface
   * rather than only inside the domain package.
   */
  it('R-B5: an ambiguous wall-clock time has TWO occurrences, and the role picks one', () => {
    // 2027-11-07 01:30 happens twice in New York (the change is at 02:00).
    const earliest = zonedInstant('2027-11-07', '01:30', 'America/New_York', 'earliest');
    const latest = zonedInstant('2027-11-07', '01:30', 'America/New_York', 'latest');

    expect(earliest.toISOString()).toBe('2027-11-07T05:30:00.000Z');
    expect(latest.toISOString()).toBe('2027-11-07T06:30:00.000Z');
    expect(latest.getTime() - earliest.getTime()).toBe(60 * 60 * 1000);

    // The default is `earliest`, so a bare call never silently delays a START.
    expect(zonedInstant('2027-11-07', '01:30', 'America/New_York').toISOString()).toBe(
      earliest.toISOString(),
    );

    const named = zonedResolution('2027-11-07', '01:30', 'America/New_York');
    expect(named.kind).toBe('fold');
  });

  /**
   * The rolled-over date, refused rather than laundered.
   *
   * `nextDay` and `zonedInstant` both went through `Date.UTC` before
   * OPUS-M4-000B, and `Date.UTC(2027, 1, 29)` is `2027-03-01` — a shift authored
   * for a day that does not exist was filed on the next one with nothing
   * failing. Asserted here because this is the surface that used to do it.
   */
  it('a shape-valid, calendar-invalid date is refused, not rolled over', () => {
    expect(new Date(Date.parse('2027-02-29')).toISOString().slice(0, 10)).toBe('2027-03-01');
    expect(() => zonedInstant('2027-02-29', '08:00', 'America/New_York')).toThrow(
      /INVALID_CALENDAR_DATE/,
    );
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * cellRevision — the compare-and-set token
 * ──────────────────────────────────────────────────────────────────────────── */

function assignment() {
  return {
    assignmentIdentityId: '11111111-1111-4111-8111-111111111111',
    snapshotId: '22222222-2222-4222-8222-222222222222',
    membershipId: '33333333-3333-4333-8333-333333333333',
    startsAt: '2027-03-02T08:00:00.000Z',
    endsAt: '2027-03-02T16:00:00.000Z',
    status: 'active' as const,
    origin: 'manual' as const,
    isPinned: false,
    overrideReasonGiven: false,
    pickPosition: null,
    creditId: null,
    creditedMembershipId: null,
    creditStatus: null,
    locationId: null,
    locationName: null,
    locationArchived: false,
  };
}

function withField(field: string, value: unknown) {
  return [{ ...assignment(), [field]: value }];
}

describe('cellRevision is a content digest, and every mutable field is in it', () => {
  it('an empty cell has one constant revision', () => {
    expect(cellRevision([])).toBe(cellRevision([]));
    expect(cellRevision([])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('an occupied cell differs from an empty one', () => {
    expect(cellRevision([assignment()])).not.toBe(cellRevision([]));
  });

  it('is stable across repeated computation of the same content', () => {
    expect(cellRevision([assignment()])).toBe(cellRevision([assignment()]));
  });

  /**
   * The falsifiability that matters.
   *
   * A digest that ignored one of these fields would let the corresponding
   * concurrent edit pass the compare-and-set and overwrite silently. Each field
   * below is one a cell mutation can change, and each must move the token.
   */
  it.each([
    ['membershipId', '44444444-4444-4444-8444-444444444444'],
    ['isPinned', true],
    ['status', 'cancelled'],
    ['pickPosition', 3],
    ['overrideReasonGiven', true],
    ['creditId', '55555555-5555-4555-8555-555555555555'],
    ['creditedMembershipId', '66666666-6666-4666-8666-666666666666'],
    ['creditStatus', 'voided'],
    ['snapshotId', '77777777-7777-4777-8777-777777777777'],
    ['assignmentIdentityId', '88888888-8888-4888-8888-888888888888'],
    ['startsAt', '2027-03-02T09:00:00.000Z'],
    ['endsAt', '2027-03-02T17:00:00.000Z'],
  ])('changing %s changes the revision', (field, value) => {
    expect(cellRevision(withField(field, value) as never)).not.toBe(
      cellRevision([assignment()]),
    );
  });

  it('a second assignment in the cell changes the revision', () => {
    const second = { ...assignment(), assignmentIdentityId: '99999999-9999-4999-8999-999999999999' };
    expect(cellRevision([assignment(), second as never])).not.toBe(cellRevision([assignment()]));
  });
});

describe('cellKey', () => {
  it('separates the date from the shift type unambiguously', () => {
    expect(cellKey('2027-03-02', 'abc')).toBe('2027-03-02|abc');
    // A `|` cannot appear in either half — a date matches YYYY-MM-DD and a shift
    // type id is a uuid — so the key cannot be forged by content.
    expect(cellKey('2027-03-02', 'abc').split('|')).toHaveLength(2);
  });
});
