import { describe, expect, it } from 'vitest';

import {
  CONFLICT_CLASSES,
  CONFLICT_TAXONOMY,
  E2_OBJECTIVE_PROFILE,
  FAIRNESS_NORMALISATION,
  OBJECTIVE_SCALE,
  canonicalStringify,
  compareConflictClasses,
  conflictClassOfDemandShortfall,
  conflictClassOfRejection,
  conflictClassOfStructuralFinding,
  conflictClassOfViolation,
  conflictClassSpec,
  demandCoverage,
  fairnessDispersion,
  fairnessExtremes,
  objectiveProfileCanonicalString,
  objectiveTierOf,
  resultsAreComparable,
  ruleProblems,
  scaleWeight,
  type Rule,
} from '../../src/rules/index.js';

/**
 * **NAMED PROOF — the E2 objective, the fairness measurement, and PO-DEC-13's
 * taxonomy** (OPUS-M4-004).
 *
 * Everything here is pure, so every claim the packet makes about *arithmetic and
 * classification* is falsifiable without a solver, a database, or a subprocess.
 * The properties that need a real solve — the objective moving, the T2 loop
 * earning its claim, bit-identity under the pinned set — live in
 * `apps/api/test/solver/`; this file is what makes those tests able to assume
 * the primitives are right.
 */

describe('the integer scaling factor is decided ONCE (doc 08 §3.4)', () => {
  it('is 10^4 and lives in exactly one constant', () => {
    expect(OBJECTIVE_SCALE).toBe(10_000);
    expect(E2_OBJECTIVE_PROFILE.scale).toBe(OBJECTIVE_SCALE);
  });

  it('ROUNDS a fractional weight — the E1 truncation is the defect it closes', () => {
    /* `int(float(0.5))` is 0. A SOFT rule authored at half weight contributed
     * NOTHING to the E1 objective — not less, nothing — and the schedule that
     * came back was indistinguishable from one where the rule had been honoured
     * and simply not bitten. */
    expect(scaleWeight(0.5)).toBe(5_000);
    expect(scaleWeight(0.5)).not.toBe(0);
    expect(scaleWeight(1)).toBe(10_000);
    expect(scaleWeight(2.25)).toBe(22_500);
    /* Half-way cases round UP, matching `Math.round`, which is what the worker's
     * `int(x + 0.5)` reproduces. Python's own `round` would go to EVEN here and
     * the two implementations would disagree at exactly one value in 20 000. */
    expect(scaleWeight(0.00005)).toBe(1);
  });

  /**
   * REPAIR F-05 (FAD-46). The worker's comment claimed the two scalers were
   * "arithmetically identical". They are not: on negative half-values
   * `Math.round(-0.5)` is `-0` while the worker's negative branch yields -1.
   *
   * The divergence is unreachable, and this is the contract that makes it so —
   * pinned, because an unreachable divergence documented in a comment beside a
   * contract nobody asserts is one refactor away from being reachable.
   */
  it('a SOFT weight must be greater than zero, which is why the negative branch is unreachable', () => {
    const soft = (weight: number): Rule =>
      ({
        key: 'k',
        classification: 'SOFT',
        weight,
        scope: { kind: 'group' },
        node: { kind: 'ShiftPreference', membershipId: 'm', shiftTypeId: 's', strength: 'prefer' },
      }) as unknown as Rule;
    const complains = (weight: number): boolean =>
      ruleProblems(soft(weight)).some((problem) => problem.path === 'weight');
    expect(complains(-0.00005)).toBe(true);
    expect(complains(-1)).toBe(true);
    expect(complains(0)).toBe(true);
    expect(complains(0.5)).toBe(false);
  });

  it('REFUSES a non-finite weight rather than coercing it to zero', () => {
    /* A `NaN` silently becoming `0` is the same failure mode as the truncation:
     * a rule present in every listing and absent from the objective. */
    expect(() => scaleWeight(Number.NaN)).toThrow(/non-finite/);
    expect(() => scaleWeight(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
  });
});

describe('the objective profile is recorded, ordered, and byte-stable', () => {
  it('names three tiers, ranked, with distinct multipliers', () => {
    const ranks = E2_OBJECTIVE_PROFILE.tiers.map((tier) => tier.rank);
    expect(ranks).toEqual([1, 2, 3]);
    const weights = E2_OBJECTIVE_PROFILE.tiers.map((tier) => tier.tierWeight);
    expect(new Set(weights).size).toBe(weights.length);
    /* Rank 1 carries the largest multiplier. A ranking whose numbers did not
     * order the same way would make the recorded rank decorative. */
    expect(weights[0]).toBeGreaterThan(weights[1] ?? 0);
    expect(weights[1]).toBeGreaterThan(weights[2] ?? 0);
  });

  it('maps every SOFT-natural kind to exactly one tier, and nothing else to any', () => {
    const seen = new Set<string>();
    for (const tier of E2_OBJECTIVE_PROFILE.tiers) {
      for (const kind of tier.kinds) {
        expect(seen.has(kind), `${kind} is in two tiers`).toBe(false);
        seen.add(kind);
        expect(objectiveTierOf(kind)?.rank).toBe(tier.rank);
      }
    }
    /* A HARD-natural kind has no tier. If it did, the compiler would have a path
     * from HARD to an objective term — the one thing SPEC-04 §3.3 forbids
     * absolutely. */
    expect(objectiveTierOf('RequiredCount')).toBeNull();
    expect(objectiveTierOf('MinimumRestBetween')).toBeNull();
    expect(objectiveTierOf('NotAKind')).toBeNull();
  });

  it('renders in the form the worker reproduces byte for byte', () => {
    const rendered = objectiveProfileCanonicalString();
    /* The hand-rolled renderer must agree with the generic canonicaliser. Both
     * sort keys; the hand-rolled one exists so the shape crossing the language
     * boundary is visible in one place, and this is what stops the two drifting.
     *
     * The bug this caught while it was being written: `"kinds"` was emitted
     * before `"key"`, which reads correctly and sorts wrongly — `'e' < 'i'`. */
    expect(rendered).toBe(canonicalStringify(E2_OBJECTIVE_PROFILE));
    expect(rendered).toContain('"key":"fairness","kinds":[');
    expect(rendered).not.toContain(' ');
    /* No float anywhere: `1.0` renders as `1.0` in Python and `1` in JavaScript,
     * and a single float in the profile would make the digests disagree for a
     * reason that has nothing to do with the objective. */
    expect(rendered).not.toMatch(/\d\.\d/);
  });
});

describe('comparability: same snapshot AND same weights, or nothing', () => {
  const hash = 'a'.repeat(64);
  const other = 'b'.repeat(64);
  const digest = 'c'.repeat(64);

  it('accepts two results that agree on both', () => {
    expect(
      resultsAreComparable([
        { canonicalInputHash: hash, objectiveWeightsDigest: digest },
        { canonicalInputHash: hash, objectiveWeightsDigest: digest },
      ]),
    ).toEqual({ comparable: true });
  });

  it('refuses a different snapshot, naming which half failed', () => {
    expect(
      resultsAreComparable([
        { canonicalInputHash: hash, objectiveWeightsDigest: digest },
        { canonicalInputHash: other, objectiveWeightsDigest: digest },
      ]),
    ).toEqual({ comparable: false, reason: 'cross-snapshot' });
  });

  it('refuses different weights even on ONE snapshot', () => {
    /* The half that is easiest to forget and hardest to notice: two candidates
     * for the same period, one tuned for fairness and one for preferences, with
     * their objective values in adjacent columns. */
    expect(
      resultsAreComparable([
        { canonicalInputHash: hash, objectiveWeightsDigest: digest },
        { canonicalInputHash: hash, objectiveWeightsDigest: 'd'.repeat(64) },
      ]),
    ).toEqual({ comparable: false, reason: 'weights-differ' });
  });

  it('treats an unrecorded hash or digest as NOT comparable, never as a wildcard', () => {
    /* "Cannot tell" must not render as "yes". */
    expect(
      resultsAreComparable([
        { canonicalInputHash: null, objectiveWeightsDigest: digest },
        { canonicalInputHash: hash, objectiveWeightsDigest: digest },
      ]).comparable,
    ).toBe(false);
    expect(
      resultsAreComparable([
        { canonicalInputHash: hash, objectiveWeightsDigest: null },
        { canonicalInputHash: hash, objectiveWeightsDigest: digest },
      ]).comparable,
    ).toBe(false);
  });

  it('a single result is trivially comparable — there is nothing to compare it with', () => {
    expect(resultsAreComparable([]).comparable).toBe(true);
    expect(
      resultsAreComparable([{ canonicalInputHash: null, objectiveWeightsDigest: null }]).comparable,
    ).toBe(true);
  });
});

describe('fairness dispersion (SPEC-04 §7), with its normalisation recorded', () => {
  const participants = [
    { membershipId: 'm-full', workPercentage: 100 },
    { membershipId: 'm-half', workPercentage: 50 },
  ];

  it('normalises by FTE — half the credits at half the FTE is the SAME burden', () => {
    const result = fairnessDispersion({
      participants,
      candidateCredits: [
        { membershipId: 'm-full', credit: 10 },
        { membershipId: 'm-half', credit: 5 },
      ],
      priorCredits: [],
    });
    expect(result.normalisation).toBe(FAIRNESS_NORMALISATION);
    expect(result.measuredParticipants).toBe(2);
    /* 10 ÷ 1.0 and 5 ÷ 0.5 are both 10. An un-normalised measure would report
     * this as a dispersion of 0.33 and invite somebody to "fix" it by loading
     * the half-time participant further. */
    expect(result.coefficientOfVariation).toBe(0);
    expect(fairnessExtremes(result)).toBeNull();
  });

  it('counts the credit the SNAPSHOT already carried — the adjudicated history', () => {
    /* doc 07: credits record human adjudication of burden. A fairness measure
     * that ignored them would call a schedule fair exactly when it had just
     * finished loading the same person twice. */
    const withoutHistory = fairnessDispersion({
      participants,
      candidateCredits: [
        { membershipId: 'm-full', credit: 10 },
        { membershipId: 'm-half', credit: 5 },
      ],
      priorCredits: [],
    });
    const withHistory = fairnessDispersion({
      participants,
      candidateCredits: [
        { membershipId: 'm-full', credit: 10 },
        { membershipId: 'm-half', credit: 5 },
      ],
      priorCredits: [{ membershipId: 'm-full', credit: 20 }],
    });
    expect(withoutHistory.coefficientOfVariation).toBe(0);
    expect(withHistory.coefficientOfVariation).toBeGreaterThan(0);
    expect(fairnessExtremes(withHistory)?.highest.membershipId).toBe('m-full');
    expect(fairnessExtremes(withHistory)?.lowest.membershipId).toBe('m-half');
  });

  it('EXCLUDES a participant with no in-force FTE, and says how many', () => {
    /* Treating an absent FTE as 100% would state a fact about a person the
     * snapshot does not carry one for — the FAD-23 class, applied to arithmetic. */
    const result = fairnessDispersion({
      participants: [...participants, { membershipId: 'm-none', workPercentage: null }],
      candidateCredits: [{ membershipId: 'm-none', credit: 40 }],
      priorCredits: [],
    });
    expect(result.measuredParticipants).toBe(2);
    expect(result.unmeasuredParticipants).toBe(1);
    expect(result.loads.map((load) => load.membershipId)).not.toContain('m-none');
  });

  it('is NULL, never zero, where it is undefined', () => {
    /* Zero reads as "perfectly fair", which is the opposite of "we could not
     * measure it". */
    const nobodyWorked = fairnessDispersion({
      participants,
      candidateCredits: [],
      priorCredits: [],
    });
    expect(nobodyWorked.mean).toBe(0);
    expect(nobodyWorked.coefficientOfVariation).toBeNull();

    const one = fairnessDispersion({
      participants: [participants[0]!],
      candidateCredits: [{ membershipId: 'm-full', credit: 3 }],
      priorCredits: [],
    });
    expect(one.coefficientOfVariation).toBeNull();
  });

  it('drops a credit naming somebody outside the participant set', () => {
    /* Adding them under a new key would make the dispersion a statement about a
     * person who is not in the group. */
    const result = fairnessDispersion({
      participants,
      candidateCredits: [{ membershipId: 'm-stranger', credit: 100 }],
      priorCredits: [],
    });
    expect(result.measuredParticipants).toBe(2);
    expect(result.coefficientOfVariation).toBeNull();
  });
});

describe("PO-DEC-13's conflict taxonomy, implemented exactly", () => {
  it('has FOUR classes, in the order the decision itself lists, each entered once', () => {
    expect(CONFLICT_CLASSES).toEqual([
      'hard-breach',
      'unmet-demand',
      'eligibility-failure',
      'fairness-outlier',
    ]);
    expect(CONFLICT_TAXONOMY.map((spec) => spec.conflictClass)).toEqual([...CONFLICT_CLASSES]);
    expect(CONFLICT_TAXONOMY.map((spec) => spec.severityRank)).toEqual([1, 2, 3, 4]);
  });

  it('blocks approval on the first three and NEVER on the fourth', () => {
    /* The load-bearing row. No band for `fairness_dispersion` exists (SPEC-04
     * §7; no band until the M6 benchmark), so a class that blocked approval on it would be
     * enforcing an invented standard. */
    expect(conflictClassSpec('hard-breach').blocksApproval).toBe(true);
    expect(conflictClassSpec('unmet-demand').blocksApproval).toBe(true);
    expect(conflictClassSpec('eligibility-failure').blocksApproval).toBe(true);
    expect(conflictClassSpec('fairness-outlier').blocksApproval).toBe(false);
    expect(conflictClassSpec('fairness-outlier').banded).toBe(false);
  });

  it('sorts by severity and not alphabetically', () => {
    const shuffled = [
      'fairness-outlier',
      'eligibility-failure',
      'hard-breach',
      'unmet-demand',
    ] as const;
    expect([...shuffled].sort(compareConflictClasses)).toEqual([...CONFLICT_CLASSES]);
  });

  it('files a coverage breach as unmet demand and an eligibility breach as eligibility', () => {
    expect(conflictClassOfViolation({ finding: 'breach', nodeKind: 'RequiredCount' })).toBe(
      'unmet-demand',
    );
    expect(conflictClassOfViolation({ finding: 'breach', nodeKind: 'MinCoverage' })).toBe(
      'unmet-demand',
    );
    expect(conflictClassOfViolation({ finding: 'breach', nodeKind: 'RequiresQualification' })).toBe(
      'eligibility-failure',
    );
    expect(conflictClassOfViolation({ finding: 'breach', nodeKind: 'MinimumRestBetween' })).toBe(
      'hard-breach',
    );
  });

  it('files EVERY not-evaluable finding as a hard breach, whatever its kind', () => {
    /* FAD-27: "this HARD rule cannot be checked, so this version cannot be
     * asserted to satisfy it". Filing an unchecked coverage rule under
     * `unmet-demand` would be a specific claim about demand that nobody
     * measured. */
    expect(conflictClassOfViolation({ finding: 'not-evaluable', nodeKind: 'RequiredCount' })).toBe(
      'hard-breach',
    );
    expect(
      conflictClassOfViolation({ finding: 'not-evaluable', nodeKind: 'RequiresQualification' }),
    ).toBe('hard-breach');
  });

  it('maps every rejection reason and every T0 code the pipeline can produce', () => {
    expect(conflictClassOfRejection('ineligible-assignment')).toBe('eligibility-failure');
    for (const reason of [
      'input-hash-mismatch',
      'unknown-reference',
      'duplicate-assignment',
      'protected-assignment-dropped',
      'hard-violation',
    ]) {
      expect(conflictClassOfRejection(reason)).toBe('hard-breach');
    }
    expect(conflictClassOfStructuralFinding('no_eligible_member')).toBe('eligibility-failure');
    expect(conflictClassOfStructuralFinding('eligible_capacity_below_demand')).toBe('unmet-demand');
    expect(conflictClassOfStructuralFinding('day_demand_exceeds_participants')).toBe(
      'unmet-demand',
    );
    expect(conflictClassOfStructuralFinding('conflicting_fixed_assignments')).toBe('hard-breach');
    /* An unrecognised code is still a finding. Losing it would be the silent
     * skip SPEC-04 §3.3 forbids, in a different domain. */
    expect(conflictClassOfStructuralFinding('something_new')).toBe('hard-breach');
  });

  it('raises a demand conflict only on a real shortfall', () => {
    expect(conflictClassOfDemandShortfall(0.5)).toBe('unmet-demand');
    expect(conflictClassOfDemandShortfall(1)).toBeNull();
    /* "Nothing was asked for" is a non-event, not a conflict. */
    expect(conflictClassOfDemandShortfall(null)).toBeNull();
  });
});

/**
 * **Repair F-03 — demand coverage counts CELLS, not bodies.**
 *
 * The shipped metric was `min(assignments.length, requiredSlots) / requiredSlots`.
 * Every assertion below fails against that arithmetic except the two trivial ones,
 * which is the point: the defect was invisible to any test that only ever handed
 * it a correct candidate.
 */
describe('demand coverage is measured per date × shift-type cell (SPEC-04 §7, RK-RULING-01)', () => {
  const cells = [
    { date: '2044-03-01', shiftTypeId: 'st-a', requiredCount: 2 },
    { date: '2044-03-02', shiftTypeId: 'st-a', requiredCount: 1 },
  ];

  it('an empty candidate fills nothing', () => {
    const coverage = demandCoverage(cells, []);
    expect(coverage.requiredSlots).toBe(3);
    expect(coverage.filledSlots).toBe(0);
    expect(coverage.satisfactionRate).toBe(0);
    expect(coverage.shortfalls).toHaveLength(2);
  });

  it('a candidate that fills every required cell scores exactly 1', () => {
    const coverage = demandCoverage(cells, [
      { date: '2044-03-01', shiftTypeId: 'st-a' },
      { date: '2044-03-01', shiftTypeId: 'st-a' },
      { date: '2044-03-02', shiftTypeId: 'st-a' },
    ]);
    expect(coverage.filledSlots).toBe(3);
    expect(coverage.satisfactionRate).toBe(1);
    expect(coverage.shortfalls).toHaveLength(0);
    expect(coverage.overfills).toHaveLength(0);
  });

  /**
   * THE FALSIFICATION, in the reviewer's probe-04 shape: the right NUMBER of
   * people, none of them on a cell that asked for anybody. The count-based
   * implementation scored this 1 — a flawless schedule that staffed nothing.
   */
  it('a candidate on a date carrying no requirement scores 0, not 1', () => {
    const coverage = demandCoverage(cells, [
      { date: '2099-12-31', shiftTypeId: 'st-a' },
      { date: '2099-12-31', shiftTypeId: 'st-a' },
      { date: '2099-12-31', shiftTypeId: 'st-a' },
    ]);
    expect(coverage.filledSlots).toBe(0);
    expect(coverage.satisfactionRate).toBe(0);
    expect(coverage.satisfactionRate).not.toBe(1);
    /* and the conflict that reads it is therefore RAISED, where the shipped
     * arithmetic suppressed it by handing the classifier a 1 */
    expect(conflictClassOfDemandShortfall(coverage.satisfactionRate)).toBe('unmet-demand');
    expect(coverage.overfills).toHaveLength(1);
  });

  it('an over-staffed cell may not pay for an unstaffed one', () => {
    /* Three bodies, all on the cell that wanted two. `length` says 3 of 3. */
    const coverage = demandCoverage(cells, [
      { date: '2044-03-01', shiftTypeId: 'st-a' },
      { date: '2044-03-01', shiftTypeId: 'st-a' },
      { date: '2044-03-01', shiftTypeId: 'st-a' },
    ]);
    expect(coverage.filledSlots).toBe(2);
    expect(coverage.satisfactionRate).toBeCloseTo(2 / 3, 10);
    expect(coverage.shortfalls).toHaveLength(1);
    expect(coverage.overfills).toHaveLength(1);
  });

  it('the right shift type on the right date is still the wrong cell', () => {
    const coverage = demandCoverage(cells, [
      { date: '2044-03-01', shiftTypeId: 'st-b' },
      { date: '2044-03-01', shiftTypeId: 'st-b' },
      { date: '2044-03-02', shiftTypeId: 'st-b' },
    ]);
    expect(coverage.satisfactionRate).toBe(0);
  });

  it('over-supply never reports above 1', () => {
    const coverage = demandCoverage(cells, [
      { date: '2044-03-01', shiftTypeId: 'st-a' },
      { date: '2044-03-01', shiftTypeId: 'st-a' },
      { date: '2044-03-02', shiftTypeId: 'st-a' },
      { date: '2099-12-31', shiftTypeId: 'st-a' },
    ]);
    expect(coverage.satisfactionRate).toBe(1);
  });

  it('a period that asked for nothing has NO rate, rather than a rate of zero', () => {
    const coverage = demandCoverage([], [{ date: '2044-03-01', shiftTypeId: 'st-a' }]);
    expect(coverage.requiredSlots).toBe(0);
    expect(coverage.satisfactionRate).toBeNull();
    expect(conflictClassOfDemandShortfall(coverage.satisfactionRate)).toBeNull();
  });

  it('a zero-count requirement row is not a requirement', () => {
    const coverage = demandCoverage(
      [{ date: '2044-03-01', shiftTypeId: 'st-a', requiredCount: 0 }],
      [],
    );
    expect(coverage.requiredSlots).toBe(0);
    expect(coverage.satisfactionRate).toBeNull();
  });
});
