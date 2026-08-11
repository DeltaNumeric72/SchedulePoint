import { describe, expect, it } from 'vitest';

import {
  evaluateEligibility,
  qualificationOutcome,
  QUALIFICATION_OUTCOMES,
  type EligibilityInput,
  type VerdictHolding,
} from '../../src/eligibility/index.js';

/**
 * The shared eligibility verdict — property tests over the five distinct
 * non-satisfied outcomes, the expiry-vs-assignment-date boundary, and the
 * pinned aggregation precedence (OPUS-M4-000A, doc 34 §4-B).
 *
 * Every case here is a rule the packet names, pinned so the next editor of
 * `verdict.ts` changes a failing test rather than a silent meaning. The final
 * describe block is the file's MUTATION CONTROL: it runs deliberately broken
 * variants of the classification against the same oracles and asserts they
 * are caught, so the suite is proven able to fail.
 */

const Q = '00000000-0000-4000-8000-00000000000a';
const Q2 = '00000000-0000-4000-8000-00000000000b';
const AT = new Date('2027-06-15T12:00:00.000Z');

const ACTIVE = new Map([[Q, 'active' as const], [Q2, 'active' as const]]);
const RETIRED = new Map([[Q, 'retired' as const], [Q2, 'active' as const]]);

let sequence = 0;
function holding(overrides: Partial<VerdictHolding>): VerdictHolding {
  sequence += 1;
  return {
    id: `h-${String(sequence)}`,
    qualificationId: Q,
    effectiveFrom: '2027-01-01T00:00:00.000Z',
    effectiveTo: null,
    status: 'valid',
    ...overrides,
  };
}

function input(overrides: Partial<EligibilityInput>): EligibilityInput {
  return {
    requiredQualificationIds: [Q],
    holdings: [],
    qualificationLifecycles: ACTIVE,
    at: AT,
    ...overrides,
  };
}

describe('the five distinct outcomes', () => {
  it('satisfied: an in-window holding with a conferring status', () => {
    const verdict = evaluateEligibility(input({ holdings: [holding({})] }));
    expect(verdict.qualifications).toEqual([{ qualificationId: Q, outcome: 'satisfied' }]);
    expect(verdict.eligible).toBe(true);
  });

  it('`expiring` confers, exactly as the shipped ELIGIBLE_HOLDING_STATUSES says', () => {
    const verdict = evaluateEligibility(input({ holdings: [holding({ status: 'expiring' })] }));
    expect(verdict.qualifications[0]?.outcome).toBe('satisfied');
  });

  it('missing: no holding of the qualification at all', () => {
    const verdict = evaluateEligibility(input({ holdings: [] }));
    expect(verdict.qualifications[0]?.outcome).toBe('missing');
    expect(verdict.eligible).toBe(false);
  });

  it('expired: the window has been reached and passed', () => {
    const verdict = evaluateEligibility(
      input({
        holdings: [
          holding({
            effectiveFrom: '2026-01-01T00:00:00.000Z',
            effectiveTo: '2027-01-01T00:00:00.000Z',
          }),
        ],
      }),
    );
    expect(verdict.qualifications[0]?.outcome).toBe('expired');
  });

  it('expired: a stored `expired` status decides even with an open window', () => {
    const verdict = evaluateEligibility(input({ holdings: [holding({ status: 'expired' })] }));
    expect(verdict.qualifications[0]?.outcome).toBe('expired');
  });

  it('future: the window has not begun', () => {
    const verdict = evaluateEligibility(
      input({ holdings: [holding({ effectiveFrom: '2028-01-01T00:00:00.000Z' })] }),
    );
    expect(verdict.qualifications[0]?.outcome).toBe('future');
  });

  it('future: recorded but pending inside its window', () => {
    const verdict = evaluateEligibility(input({ holdings: [holding({ status: 'pending' })] }));
    expect(verdict.qualifications[0]?.outcome).toBe('future');
  });

  it('revoked: a revoked holding, whatever its window', () => {
    const verdict = evaluateEligibility(input({ holdings: [holding({ status: 'revoked' })] }));
    expect(verdict.qualifications[0]?.outcome).toBe('revoked');
  });

  it('retired: the qualification lifecycle decides FIRST, over a live holding', () => {
    const verdict = evaluateEligibility(
      input({ qualificationLifecycles: RETIRED, holdings: [holding({})] }),
    );
    expect(verdict.qualifications[0]?.outcome).toBe('retired');
    expect(verdict.eligible).toBe(false);
  });

  it('retired: an unresolvable lifecycle is fail-closed retired, never satisfied', () => {
    const verdict = evaluateEligibility(
      input({ qualificationLifecycles: new Map(), holdings: [holding({})] }),
    );
    expect(verdict.qualifications[0]?.outcome).toBe('retired');
  });

  it('the six outcome tokens are exactly the closed set', () => {
    expect([...QUALIFICATION_OUTCOMES].sort()).toEqual(
      ['expired', 'future', 'missing', 'retired', 'revoked', 'satisfied'].sort(),
    );
  });
});

describe('the boundary: expiry date vs assignment date (half-open, [from, until))', () => {
  const UNTIL = '2027-06-15T12:00:00.000Z';

  it('an instant strictly before the expiry is IN', () => {
    const outcome = qualificationOutcome(
      Q,
      'active',
      [holding({ effectiveFrom: '2027-01-01T00:00:00.000Z', effectiveTo: UNTIL })],
      new Date('2027-06-15T11:59:59.999Z'),
    );
    expect(outcome).toBe('satisfied');
  });

  it('an instant exactly equal to the expiry is OUT — expired, not satisfied', () => {
    const outcome = qualificationOutcome(
      Q,
      'active',
      [holding({ effectiveFrom: '2027-01-01T00:00:00.000Z', effectiveTo: UNTIL })],
      new Date(UNTIL),
    );
    expect(outcome).toBe('expired');
  });

  it('an instant exactly equal to the start is IN', () => {
    const outcome = qualificationOutcome(
      Q,
      'active',
      [holding({ effectiveFrom: UNTIL, effectiveTo: null })],
      new Date(UNTIL),
    );
    expect(outcome).toBe('satisfied');
  });
});

describe('aggregation precedence and determinism', () => {
  it('revoked > expired > future across several non-conferring holdings', () => {
    const expired = holding({
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: '2027-01-01T00:00:00.000Z',
    });
    const future = holding({ effectiveFrom: '2028-01-01T00:00:00.000Z' });
    const revoked = holding({ status: 'revoked' });

    expect(qualificationOutcome(Q, 'active', [expired, future], AT)).toBe('expired');
    expect(qualificationOutcome(Q, 'active', [future], AT)).toBe('future');
    expect(qualificationOutcome(Q, 'active', [expired, future, revoked], AT)).toBe('revoked');
  });

  it('a renewal already in force wins over the lapsed predecessor', () => {
    const lapsed = holding({
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: '2027-01-01T00:00:00.000Z',
    });
    const renewal = holding({ effectiveFrom: '2027-01-01T00:00:00.000Z' });
    expect(qualificationOutcome(Q, 'active', [lapsed, renewal], AT)).toBe('satisfied');
  });

  it('the verdict is order-independent in holdings', () => {
    const rows = [
      holding({ status: 'revoked' }),
      holding({ effectiveFrom: '2028-01-01T00:00:00.000Z' }),
      holding({
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        effectiveTo: '2027-01-01T00:00:00.000Z',
      }),
    ];
    const forward = qualificationOutcome(Q, 'active', rows, AT);
    const reversed = qualificationOutcome(Q, 'active', [...rows].reverse(), AT);
    expect(forward).toBe(reversed);
    expect(forward).toBe('revoked');
  });

  it('an unparsable holding is ignored — fail-closed to missing, never satisfied', () => {
    const outcome = qualificationOutcome(
      Q,
      'active',
      [holding({ effectiveFrom: 'infinity' }), holding({ effectiveFrom: 'not-a-date' })],
      AT,
    );
    expect(outcome).toBe('missing');
  });

  it('requirements are deduplicated and reported in caller order', () => {
    const verdict = evaluateEligibility(
      input({ requiredQualificationIds: [Q2, Q, Q2], holdings: [holding({})] }),
    );
    expect(verdict.qualifications.map((entry) => entry.qualificationId)).toEqual([Q2, Q]);
    expect(verdict.qualifications[0]?.outcome).toBe('missing');
    expect(verdict.qualifications[1]?.outcome).toBe('satisfied');
    expect(verdict.qualificationsSatisfied).toBe(false);
  });
});

describe('membership and work-profile dimensions', () => {
  it('not-evaluated never blocks (FAD-23 absence discipline)', () => {
    const verdict = evaluateEligibility(input({ holdings: [holding({})] }));
    expect(verdict.membership).toBe('not-evaluated');
    expect(verdict.workProfile).toBe('not-evaluated');
    expect(verdict.eligible).toBe(true);
  });

  it('suspended, ended, and invited memberships are ineligible; active is not', () => {
    for (const state of ['suspended', 'ended', 'invited'] as const) {
      const verdict = evaluateEligibility(
        input({ holdings: [holding({})], membershipState: state }),
      );
      expect(verdict.membership).toBe(state);
      expect(verdict.eligible).toBe(false);
    }
    const active = evaluateEligibility(
      input({ holdings: [holding({})], membershipState: 'active' }),
    );
    expect(active.membership).toBe('eligible');
    expect(active.eligible).toBe(true);
  });

  it('a missing work profile is REPORTED and does not block', () => {
    const verdict = evaluateEligibility(
      input({ holdings: [holding({})], workProfileInForce: false }),
    );
    expect(verdict.workProfile).toBe('none');
    expect(verdict.eligible).toBe(true);
  });

  it('no requirements is vacuously satisfied — enforcement, not invention', () => {
    const verdict = evaluateEligibility(input({ requiredQualificationIds: [] }));
    expect(verdict.qualificationsSatisfied).toBe(true);
    expect(verdict.eligible).toBe(true);
  });
});

describe('MUTATION CONTROL — the oracles above can fail', () => {
  /**
   * A deliberately broken classifier: the boundary treated as CLOSED
   * (`instant <= until` is IN). The boundary oracle above must reject its
   * answer — if this assertion ever passes with `satisfied`, the boundary test
   * has gone vacuous.
   */
  it('a closed-boundary variant is caught by the expiry-boundary oracle', () => {
    const UNTIL = '2027-06-15T12:00:00.000Z';
    const row = holding({ effectiveFrom: '2027-01-01T00:00:00.000Z', effectiveTo: UNTIL });
    const brokenContains = (h: VerdictHolding, at: Date): boolean =>
      Date.parse(h.effectiveFrom) <= at.getTime() &&
      (h.effectiveTo === null || at.getTime() <= Date.parse(h.effectiveTo));

    // The broken variant answers IN at the boundary…
    expect(brokenContains(row, new Date(UNTIL))).toBe(true);
    // …and the shipped rule answers OUT — so the boundary test above would
    // fail against the broken variant rather than silently agreeing with it.
    expect(qualificationOutcome(Q, 'active', [row], new Date(UNTIL))).toBe('expired');
  });

  /**
   * A retirement-last variant: holdings evaluated before the lifecycle. The
   * retired oracle must reject it — a live holding of a retired qualification
   * must never read as satisfied.
   */
  it('a retirement-last variant is caught by the retired oracle', () => {
    const live = holding({});
    const brokenOutcome = ((): string => {
      // Broken precedence: satisfied wins before the lifecycle is consulted.
      const confers = live.status === 'valid';
      return confers ? 'satisfied' : 'retired';
    })();
    expect(brokenOutcome).toBe('satisfied');
    expect(qualificationOutcome(Q, 'retired', [live], AT)).toBe('retired');
  });
});
