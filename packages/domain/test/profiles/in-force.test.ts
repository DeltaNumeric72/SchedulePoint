import { describe, expect, it } from 'vitest';

import {
  AmbiguousInForceError,
  containsInstant,
  filterInForce,
  isEligibleAt,
  parseInstant,
  requireInForce,
  selectInForce,
  type EffectiveDated,
} from '../../src/profiles/in-force.js';
import { BOUNDARY_CASES } from './boundary-battery.js';

/**
 * The in-force boundary battery — the packet's named condition (1).
 *
 * Every case comes from `boundary-battery.ts`, which is shared with the S-01 red
 * case rather than copied into it. That sharing is the point: the red case proves
 * that **this** battery catches an arbitrary-row loader, not that some private
 * copy of it does.
 *
 * Nothing here touches a database or a clock. The SQL half — the same rule
 * against real rows, real windows and the real EXCLUDE constraint — is
 * `apps/api/test/profiles/in-force-determinism.test.ts`.
 */

const row = (id: string, from: string, to: string | null): EffectiveDated => ({
  id,
  effectiveFrom: from,
  effectiveTo: to,
});

describe('the boundary battery', () => {
  it('has cases for every boundary class the packet names', () => {
    // A battery that lost its gap cases would still pass every test below, and
    // the red case that depends on it would go quietly green. This is the floor.
    const names = BOUNDARY_CASES.map((testCase) => testCase.name).join(' | ');
    for (const required of [
      'instant of change',
      'future-dated row present',
      'gap',
      'first row',
      'last row',
      'timezone-explicit instant',
    ]) {
      expect(names, `the battery has no case for "${required}"`).toContain(required);
    }
    expect(BOUNDARY_CASES.length).toBeGreaterThanOrEqual(15);
  });

  for (const testCase of BOUNDARY_CASES) {
    it(testCase.name, () => {
      const selection = selectInForce(testCase.rows, new Date(testCase.at));

      if (testCase.expectedId === null) {
        expect(selection.kind, testCase.why).toBe('none');
        if (selection.kind === 'none') {
          expect(selection.reason, `${testCase.name}: wrong reason. ${testCase.why}`).toBe(
            testCase.expectedReason,
          );
        }
        return;
      }

      expect(selection.kind, testCase.why).toBe('in-force');
      if (selection.kind === 'in-force') {
        expect(selection.row.id, testCase.why).toBe(testCase.expectedId);
      }
    });
  }

  it('order independence: every case gives the same answer under a reversed input', () => {
    // The SQL loader does `ORDER BY effective_from, id`, and that ordering is
    // there so a FAILURE is reproducible — not so the rule works. If the rule
    // depended on it, a plan change would be a correctness change.
    for (const testCase of BOUNDARY_CASES) {
      const forward = selectInForce(testCase.rows, new Date(testCase.at));
      const reversed = selectInForce([...testCase.rows].reverse(), new Date(testCase.at));
      expect(JSON.stringify(reversed), `${testCase.name}: the answer depends on row order`).toBe(
        JSON.stringify(forward),
      );
    }
  });
});

describe('ambiguity is reported, never resolved', () => {
  const overlapping = [
    row('a', '2026-01-01T00:00:00.000Z', null),
    row('b', '2026-02-01T00:00:00.000Z', null),
  ];

  it('two rows in force is `ambiguous`, and names both', () => {
    const selection = selectInForce(overlapping, new Date('2026-08-03T00:00:00.000Z'));
    expect(selection.kind).toBe('ambiguous');
    if (selection.kind === 'ambiguous') {
      expect(selection.rows.map((r) => r.id).sort()).toEqual(['a', 'b']);
    }
  });

  it('`requireInForce` THROWS rather than picking one', () => {
    // This is the S-01 lesson in one assertion. A tie-break here — "the
    // latest-starting row wins" — is exactly what an arbitrary-row loader looks
    // like once someone has tidied it up, and it would make a dropped EXCLUDE
    // constraint invisible forever.
    expect(() => requireInForce(overlapping, new Date('2026-08-03T00:00:00.000Z'))).toThrow(
      AmbiguousInForceError,
    );
  });

  it('the error names the rows, so an operator can find them', () => {
    try {
      requireInForce(overlapping, new Date('2026-08-03T00:00:00.000Z'));
      expect.unreachable('requireInForce returned for an ambiguous set');
    } catch (error) {
      expect(error).toBeInstanceOf(AmbiguousInForceError);
      expect([...(error as AmbiguousInForceError).rowIds].sort()).toEqual(['a', 'b']);
    }
  });

  it('a single in-force row is returned normally', () => {
    // The green control. Without it, a `requireInForce` that always threw would
    // pass the three tests above.
    expect(requireInForce([row('a', '2020-01-01T00:00:00.000Z', null)], new Date())?.id).toBe('a');
  });
});

describe('unusable instants fail CLOSED', () => {
  it('`infinity` is not a usable instant in either direction', () => {
    expect(parseInstant('infinity')).toBeNull();
    expect(parseInstant('-infinity')).toBeNull();
  });

  it('an unparsable UPPER bound is not open-ended', () => {
    // The fail-open reading would be "we could not read the end, so it never
    // ends", which turns one corrupt row into permanent validity. A CHECK
    // constraint refuses infinite bounds in the database; this is what survives a
    // row written before that constraint existed.
    const corrupt = row('c', '2020-01-01T00:00:00.000Z', 'unparsable-instant');
    expect(containsInstant(corrupt, new Date('2026-08-03T00:00:00.000Z'))).toBe(false);
  });

  it('an unparsable LOWER bound is never in force', () => {
    expect(
      containsInstant(row('c', 'not-a-date', null), new Date('2026-08-03T00:00:00.000Z')),
    ).toBe(false);
  });

  it('an unparsable instant to ask ABOUT selects nothing', () => {
    const selection = selectInForce([row('a', '2020-01-01T00:00:00.000Z', null)], new Date('nope'));
    expect(selection.kind).toBe('none');
  });

  it('a row with an unusable lower bound cannot make the answer `before-first`', () => {
    const selection = selectInForce(
      [row('bad', 'not-a-date', null), row('good', '2030-01-01T00:00:00.000Z', null)],
      new Date('2026-08-03T00:00:00.000Z'),
    );
    expect(selection.kind).toBe('none');
    if (selection.kind === 'none') expect(selection.reason).toBe('before-first');
  });
});

describe('`nearest` is a diagnostic and never a verdict', () => {
  it('names the most recently ended row after the last window closes', () => {
    const selection = selectInForce(
      [
        row('old', '2020-01-01T00:00:00.000Z', '2021-01-01T00:00:00.000Z'),
        row('newer', '2022-01-01T00:00:00.000Z', '2023-01-01T00:00:00.000Z'),
      ],
      new Date('2026-08-03T00:00:00.000Z'),
    );
    expect(selection.kind).toBe('none');
    if (selection.kind === 'none') expect(selection.nearest?.id).toBe('newer');
  });

  it('names the earliest FUTURE row when nothing has started', () => {
    const selection = selectInForce(
      [row('later', '2030-01-01T00:00:00.000Z', null), row('sooner', '2028-01-01T00:00:00.000Z', null)],
      new Date('2026-08-03T00:00:00.000Z'),
    );
    if (selection.kind === 'none') expect(selection.nearest?.id).toBe('sooner');
  });

  it('is null when there are no rows', () => {
    const selection = selectInForce([], new Date());
    if (selection.kind === 'none') expect(selection.nearest).toBeNull();
  });
});

describe('holdings: a filter, not a selection', () => {
  const holding = (
    id: string,
    from: string,
    to: string | null,
    status: string,
  ): { id: string; effectiveFrom: string; effectiveTo: string | null; status: string } => ({
    id,
    effectiveFrom: from,
    effectiveTo: to,
    status,
  });

  const at = new Date('2026-08-03T00:00:00.000Z');

  it('overlapping holdings of one credential are BOTH returned', () => {
    // A renewal issued before the previous certificate expires. This is correct
    // data, which is why holdings carry no EXCLUDE constraint and why the
    // single-row rule would be the wrong tool.
    const inForce = filterInForce(
      [
        holding('old', '2024-01-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z', 'valid'),
        holding('renewal', '2026-06-01T00:00:00.000Z', '2028-01-01T00:00:00.000Z', 'valid'),
      ],
      at,
    );
    expect(inForce.map((h) => h.id)).toEqual(['old', 'renewal']);
  });

  it('the window rule is literally the same function', () => {
    // Not "the same behaviour" — the same call. `filterInForce` and
    // `selectInForce` both go through `containsInstant`, so a boundary fix in one
    // cannot fail to apply to the other.
    const boundary = holding('h', '2026-08-03T00:00:00.000Z', '2026-08-04T00:00:00.000Z', 'valid');
    expect(containsInstant(boundary, at)).toBe(true);
    expect(filterInForce([boundary], at)).toHaveLength(1);
    expect(containsInstant(boundary, new Date('2026-08-04T00:00:00.000Z'))).toBe(false);
  });

  it('eligibility needs BOTH an in-force window and an eligible status', () => {
    const window = ['2024-01-01T00:00:00.000Z', '2028-01-01T00:00:00.000Z'] as const;
    expect(isEligibleAt([holding('v', window[0], window[1], 'valid')], at)).toBe(true);
    expect(isEligibleAt([holding('e', window[0], window[1], 'expiring')], at)).toBe(true);
    // A revoked holding keeps its window exactly as issued — revocation moves
    // `status` and nothing else — so the STATUS check is what stops it conferring
    // eligibility. If it were the window that moved, this would pass for the
    // wrong reason.
    expect(isEligibleAt([holding('r', window[0], window[1], 'revoked')], at)).toBe(false);
    expect(isEligibleAt([holding('p', window[0], window[1], 'pending')], at)).toBe(false);
    expect(isEligibleAt([holding('x', window[0], window[1], 'expired')], at)).toBe(false);
  });

  it('an eligible status outside its window confers nothing', () => {
    expect(
      isEligibleAt(
        [holding('v', '2020-01-01T00:00:00.000Z', '2021-01-01T00:00:00.000Z', 'valid')],
        at,
      ),
    ).toBe(false);
  });

  it('eligibility is evaluated AT THE INSTANT ASKED ABOUT, never at "now"', () => {
    // CAP-058's recorded open question: "eligibility must be evaluated at the
    // shift date, not at request time". `at` is a required parameter and this
    // module reads no clock — so a caller cannot get "now" by accident.
    const holdings = [holding('v', '2027-01-01T00:00:00.000Z', '2028-01-01T00:00:00.000Z', 'valid')];
    expect(isEligibleAt(holdings, at)).toBe(false);
    expect(isEligibleAt(holdings, new Date('2027-06-01T00:00:00.000Z'))).toBe(true);
  });
});
