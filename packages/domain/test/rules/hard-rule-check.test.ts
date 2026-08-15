import { describe, expect, it } from 'vitest';

import {
  EVALUATED_HARD_RULE_KINDS,
  NOT_EVALUABLE_REASONS,
  RULE_NODE_KINDS,
  compileRule,
  evaluateHardRules,
  isEvaluatedHardRuleKind,
  type CandidateFacts,
  type CandidatePriorAssignment,
  type CheckedAssignment,
  type CheckedVersion,
  type DateRange,
  type Rule,
  type RuleNode,
  type RuleNodeKind,
  type RuleScope,
} from '../../src/index.js';

/**
 * The step-06 HARD-rule checker (OPUS-M3-008; SPEC-05 §6 step 06, SPEC-04 §3.3).
 *
 * Every claim here is paired with the arrangement in which it does NOT fire, for
 * the reason packet 32 §11 gives: a passing assertion whose subject could be
 * absent proves nothing. Each evaluated kind therefore has a satisfied case AND
 * a breaching case built from the same fixture with one fact moved.
 */

const MEMBER_A = 'm-aaaa';
const MEMBER_B = 'm-bbbb';

function assignment(
  overrides: Partial<CheckedAssignment> & Pick<CheckedAssignment, 'snapshotId' | 'date'>,
): CheckedAssignment {
  const hours = (h: number): number => new Date(`${overrides.date}T${String(h).padStart(2, '0')}:00:00.000Z`).getTime();
  return {
    assignmentIdentityId: `id-${overrides.snapshotId}`,
    membershipId: MEMBER_A,
    startsAtMs: hours(8),
    endsAtMs: hours(16),
    shiftTypeCode: 'DAY',
    isOnCall: false,
    ...overrides,
  };
}

interface VersionOptions {
  readonly assignments: readonly CheckedAssignment[];
  /** `membership|qualification|date` triples the fixture says were held. */
  readonly held?: readonly string[];
  readonly knownQualificationKeys?: readonly string[];
  readonly knownShiftTypeCodes?: readonly string[];
  readonly knownMembershipIds?: readonly string[];
  /**
   * The OPUS-M4-002 seam. **Absent by default**, and that default is the
   * load-bearing part of this helper: every M3 fixture below keeps the exact
   * shape it had, so the publication caller's behaviour is asserted unchanged
   * rather than assumed (FAD-38(6)).
   */
  readonly facts?: FactsOptions;
}

interface FactsOptions {
  readonly horizon?: DateRange;
  readonly staffGroups?: Readonly<Record<string, readonly string[]>>;
  readonly validGroups?: Readonly<Record<string, readonly string[]>>;
  readonly weekdayTargets?: Readonly<
    Record<string, Readonly<Record<string, { fteFraction: number; maxAssignments: number | null }>>>
  >;
  readonly workPercentages?: Readonly<Record<string, number>>;
  readonly prior?: readonly CandidatePriorAssignment[];
}

export function candidateFacts(options: FactsOptions): CandidateFacts {
  const staffGroups = options.staffGroups ?? {};
  const validGroups = options.validGroups ?? {};
  return {
    horizon: options.horizon ?? { from: '2031-01-01', to: '2031-12-31' },
    knownStaffGroupIds: new Set(Object.keys(staffGroups)),
    staffGroupMembers: (id) =>
      id in staffGroups ? new Set(staffGroups[id] ?? []) : null,
    knownValidGroupIds: new Set(Object.keys(validGroups)),
    validGroupShiftTypes: (id) =>
      id in validGroups ? new Set(validGroups[id] ?? []) : null,
    weekdayTarget: (membershipId, weekday) =>
      options.weekdayTargets?.[membershipId]?.[weekday] ?? null,
    workPercentage: (membershipId) => options.workPercentages?.[membershipId] ?? null,
    priorAssignments: options.prior ?? [],
  };
}

function version(options: VersionOptions): CheckedVersion {
  const held = new Set(options.held ?? []);
  return {
    assignments: options.assignments,
    knownShiftTypeCodes: new Set(options.knownShiftTypeCodes ?? ['DAY', 'NIGHT']),
    knownMembershipIds: new Set(options.knownMembershipIds ?? [MEMBER_A, MEMBER_B]),
    qualifications: {
      knownQualificationKeys: new Set(options.knownQualificationKeys ?? ['acls']),
      heldOn: (membershipId, key, date) => held.has(`${membershipId}|${key}|${date}`),
    },
    ...(options.facts === undefined ? {} : { candidateFacts: candidateFacts(options.facts) }),
  };
}

function hard(ruleKey: string, predicate: RuleNode, scope: RuleScope = {}): Rule {
  return {
    ruleKey,
    name: `check ${ruleKey}`,
    ruleSchemaVersion: 1,
    classification: 'HARD',
    scope,
    predicate,
  };
}

function evaluate(rules: readonly Rule[], subject: CheckedVersion): readonly string[] {
  return evaluateHardRules(rules.map(compileRule), subject).map(
    (finding) => `${finding.finding}:${finding.ruleKey}:${finding.field}`,
  );
}

describe('the evaluated/not-evaluable partition is total and disjoint', () => {
  it('every one of the 30 closed node kinds is either evaluated or has a stated reason', () => {
    const unaccounted = (RULE_NODE_KINDS as readonly RuleNodeKind[]).filter(
      (kind) => !isEvaluatedHardRuleKind(kind) && NOT_EVALUABLE_REASONS[kind] === undefined,
    );
    // A kind added to the AST without a decision here would otherwise fall
    // through to a generic "no declared semantics" message, which is a silent
    // gap wearing an explanation.
    expect(unaccounted, 'node kinds with neither an evaluator nor a stated reason').toEqual([]);
    expect(
      EVALUATED_HARD_RULE_KINDS.length + Object.keys(NOT_EVALUABLE_REASONS).length,
    ).toBe(RULE_NODE_KINDS.length);
  });

  it('no kind is both evaluated and excused', () => {
    const both = EVALUATED_HARD_RULE_KINDS.filter(
      (kind) => NOT_EVALUABLE_REASONS[kind] !== undefined,
    );
    expect(both).toEqual([]);
  });
});

describe('SOFT rules are not publication prerequisites', () => {
  it('a SOFT rule whose content would breach it produces no finding', () => {
    const soft: Rule = {
      ruleKey: 'soft_avoid',
      name: 'soft',
      ruleSchemaVersion: 1,
      classification: 'SOFT',
      weight: 5,
      scope: {},
      predicate: { kind: 'AvoidDate', date: '2031-05-01' },
    };
    const subject = version({ assignments: [assignment({ snapshotId: 's1', date: '2031-05-01' })] });
    expect(evaluate([soft], subject)).toEqual([]);

    // The control: the SAME predicate as HARD does fire, so the empty result
    // above is the classification doing the work rather than the content.
    expect(evaluate([hard('hard_avoid', { kind: 'AvoidDate', date: '2031-05-01' })], subject)).toEqual(
      ['breach:hard_avoid:s1'],
    );
  });
});

describe('RequiresQualification — expiry is evaluated at the SHIFT date', () => {
  const rule = hard('needs_acls', { kind: 'RequiresQualification', qualification: 'acls', validAt: 'shift_date' });

  it('a holding covering every assigned date satisfies it', () => {
    const subject = version({
      assignments: [
        assignment({ snapshotId: 's1', date: '2031-03-10' }),
        assignment({ snapshotId: 's2', date: '2031-03-20' }),
      ],
      held: [`${MEMBER_A}|acls|2031-03-10`, `${MEMBER_A}|acls|2031-03-20`],
    });
    expect(evaluate([rule], subject)).toEqual([]);
  });

  it('a holding expiring MID-PERIOD blocks exactly the assignments after expiry', () => {
    const subject = version({
      assignments: [
        assignment({ snapshotId: 'before-1', date: '2031-03-10' }),
        assignment({ snapshotId: 'before-2', date: '2031-03-14' }),
        assignment({ snapshotId: 'after-1', date: '2031-03-16' }),
        assignment({ snapshotId: 'after-2', date: '2031-03-20' }),
      ],
      // Held through the 14th and not after — the shape of a credential that
      // expires in the middle of the period being published.
      held: [`${MEMBER_A}|acls|2031-03-10`, `${MEMBER_A}|acls|2031-03-14`],
    });
    expect(evaluate([rule], subject)).toEqual([
      'breach:needs_acls:after-1',
      'breach:needs_acls:after-2',
    ]);
  });

  it('a qualification key the group does not define is NOT-EVALUABLE, never a pass', () => {
    const subject = version({
      assignments: [assignment({ snapshotId: 's1', date: '2031-03-10' })],
      knownQualificationKeys: [],
    });
    expect(evaluate([rule], subject)).toEqual(['not-evaluable:needs_acls:rule']);
  });
});

describe('MinimumRestBetween', () => {
  const rule = hard('rest_10', { kind: 'MinimumRestBetween', minHours: 10 });

  it('passes when the gap is exactly the minimum', () => {
    const subject = version({
      assignments: [
        assignment({ snapshotId: 's1', date: '2031-04-01' }),
        // ends 16:00 on the 1st, starts 02:00 on the 2nd — exactly 10 hours.
        assignment({
          snapshotId: 's2',
          date: '2031-04-02',
          startsAtMs: Date.parse('2031-04-02T02:00:00.000Z'),
          endsAtMs: Date.parse('2031-04-02T08:00:00.000Z'),
        }),
      ],
    });
    expect(evaluate([rule], subject)).toEqual([]);
  });

  it('breaches one minute under, and names the SECOND assignment', () => {
    const subject = version({
      assignments: [
        assignment({ snapshotId: 's1', date: '2031-04-01' }),
        assignment({
          snapshotId: 's2',
          date: '2031-04-02',
          startsAtMs: Date.parse('2031-04-02T01:59:00.000Z'),
          endsAtMs: Date.parse('2031-04-02T08:00:00.000Z'),
        }),
      ],
    });
    expect(evaluate([rule], subject)).toEqual(['breach:rest_10:s2']);
  });

  it('is per membership: two people back to back do not breach', () => {
    const subject = version({
      assignments: [
        assignment({ snapshotId: 's1', date: '2031-04-01', membershipId: MEMBER_A }),
        assignment({
          snapshotId: 's2',
          date: '2031-04-01',
          membershipId: MEMBER_B,
          startsAtMs: Date.parse('2031-04-01T16:00:00.000Z'),
          endsAtMs: Date.parse('2031-04-01T22:00:00.000Z'),
        }),
      ],
    });
    expect(evaluate([rule], subject)).toEqual([]);
  });
});

describe('MaxConsecutive', () => {
  const rule = hard('max_3_consecutive', { kind: 'MaxConsecutive', maxDays: 3 });

  const run = (dates: readonly string[]): readonly string[] =>
    evaluate([rule], version({ assignments: dates.map((date, i) => assignment({ snapshotId: `s${String(i)}`, date })) }));

  it('three consecutive days pass', () => {
    expect(run(['2031-06-01', '2031-06-02', '2031-06-03'])).toEqual([]);
  });

  it('four consecutive days breach exactly once', () => {
    expect(run(['2031-06-01', '2031-06-02', '2031-06-03', '2031-06-04'])).toEqual([
      `breach:max_3_consecutive:${MEMBER_A}`,
    ]);
  });

  it('a gap resets the run', () => {
    expect(run(['2031-06-01', '2031-06-02', '2031-06-03', '2031-06-05', '2031-06-06'])).toEqual([]);
  });

  it('the run is computed over DAYS, so two assignments on one day are one day', () => {
    expect(run(['2031-06-01', '2031-06-01', '2031-06-02', '2031-06-03'])).toEqual([]);
  });
});

describe('MaxAssignmentsInWindow', () => {
  const rule = hard('max_2_in_7', { kind: 'MaxAssignmentsInWindow', max: 2, windowDays: 7 });

  const run = (dates: readonly string[]): readonly string[] =>
    evaluate([rule], version({ assignments: dates.map((date, i) => assignment({ snapshotId: `s${String(i)}`, date })) }));

  it('two in the window pass', () => {
    expect(run(['2031-07-01', '2031-07-07'])).toEqual([]);
  });

  it('three inside one rolling window breach', () => {
    expect(run(['2031-07-01', '2031-07-04', '2031-07-07'])).toEqual([
      `breach:max_2_in_7:${MEMBER_A}`,
    ]);
  });

  it('the window is ROLLING, not calendar-aligned: 3 spanning a week boundary still breach', () => {
    // 2031-07-06 is a Sunday; a calendar-week reading would split these.
    expect(run(['2031-07-05', '2031-07-06', '2031-07-08'])).toEqual([
      `breach:max_2_in_7:${MEMBER_A}`,
    ]);
  });

  it('three spread beyond the window pass', () => {
    expect(run(['2031-07-01', '2031-07-09', '2031-07-17'])).toEqual([]);
  });
});

describe('CallSpacing — B-2, the kind whose NOT-EVALUABLE reason was false', () => {
  const rule = hard('call_spacing_3', { kind: 'CallSpacing', minDaysBetweenCalls: 3 });

  /** On-call assignments on the given dates, for one membership. */
  const calls = (dates: readonly string[], membershipId = MEMBER_A): CheckedAssignment[] =>
    dates.map((date, i) =>
      assignment({ snapshotId: `c${String(i)}`, date, membershipId, isOnCall: true, shiftTypeCode: 'CALL' }),
    );

  it('exactly the minimum apart passes; one day closer breaches', () => {
    // Mon 6th and Thu 9th: a difference of 3.
    expect(evaluate([rule], version({ assignments: calls(['2032-09-06', '2032-09-09']) }))).toEqual(
      [],
    );
    // Mon 6th and Wed 8th: a difference of 2.
    expect(evaluate([rule], version({ assignments: calls(['2032-09-06', '2032-09-08']) }))).toEqual([
      'breach:call_spacing_3:c1',
    ]);
  });

  it('two calls on ONE day breach — a difference of zero', () => {
    expect(evaluate([rule], version({ assignments: calls(['2032-09-06', '2032-09-06']) }))).toEqual([
      'breach:call_spacing_3:c1',
    ]);
  });

  it('NON-CALL shifts are ignored entirely — the fact that makes this evaluable', () => {
    // Three assignments on consecutive days, none of them a call.
    const notCalls = ['2032-09-06', '2032-09-07', '2032-09-08'].map((date, i) =>
      assignment({ snapshotId: `n${String(i)}`, date }),
    );
    expect(evaluate([rule], version({ assignments: notCalls }))).toEqual([]);

    /* The CONTROL, and it is the whole point of the arm: the same three dates
     * with `isOnCall` true DO breach. Without it, "ignored" and "the checker
     * never fires" are the same observation. */
    expect(
      evaluate([rule], version({ assignments: calls(['2032-09-06', '2032-09-07', '2032-09-08']) })),
    ).toEqual(['breach:call_spacing_3:c1', 'breach:call_spacing_3:c2']);
  });

  it('a non-call shift BETWEEN two calls does not change the spacing', () => {
    // Calls on the 6th and the 9th (legal), with a day shift on the 7th.
    const mixed = [
      ...calls(['2032-09-06', '2032-09-09']),
      assignment({ snapshotId: 'day', date: '2032-09-07' }),
    ];
    expect(evaluate([rule], version({ assignments: mixed }))).toEqual([]);
  });

  it('spacing is measured across a MONTH boundary, not within a month', () => {
    // 30 Sep and 1 Oct: a difference of 1, and a naive day-of-month subtraction
    // would compute -29 and pass.
    expect(evaluate([rule], version({ assignments: calls(['2032-09-30', '2032-10-01']) }))).toEqual([
      'breach:call_spacing_3:c1',
    ]);
    // …and 30 Sep to 3 Oct is exactly 3, so it passes.
    expect(evaluate([rule], version({ assignments: calls(['2032-09-30', '2032-10-03']) }))).toEqual(
      [],
    );
  });

  it('spacing is measured across a YEAR boundary', () => {
    expect(evaluate([rule], version({ assignments: calls(['2032-12-31', '2033-01-01']) }))).toEqual([
      'breach:call_spacing_3:c1',
    ]);
  });

  it('a LEAP day counts as a day', () => {
    // 2032 is a leap year: 28 Feb -> 29 Feb -> 1 Mar is two steps, not one.
    expect(evaluate([rule], version({ assignments: calls(['2032-02-28', '2032-03-01']) }))).toEqual([
      'breach:call_spacing_3:c1',
    ]);
    expect(evaluate([rule], version({ assignments: calls(['2032-02-27', '2032-03-01']) }))).toEqual(
      [],
    );
  });

  it('a DST transition does not move a date — the measure is calendar days', () => {
    /* 2032-03-28 is a European DST spring-forward and 2032-11-07 a US fall-back.
     * The dates are strings and `dayNumber` is UTC epoch-day arithmetic, so a
     * 23- or 25-hour civil day cannot shift the difference by one — which is the
     * defect an hours-based implementation would have. */
    expect(evaluate([rule], version({ assignments: calls(['2032-03-27', '2032-03-30']) }))).toEqual(
      [],
    );
    expect(evaluate([rule], version({ assignments: calls(['2032-11-06', '2032-11-08']) }))).toEqual([
      'breach:call_spacing_3:c1',
    ]);
  });

  it('is per membership: two people on call on consecutive days do not breach', () => {
    const twoPeople = [
      ...calls(['2032-09-06'], MEMBER_A),
      ...calls(['2032-09-07'], MEMBER_B).map((a) => ({ ...a, snapshotId: 'b0' })),
    ];
    expect(evaluate([rule], version({ assignments: twoPeople }))).toEqual([]);
  });

  it('a run of three too-close calls reports on each SECOND, not on every pair', () => {
    // 6th, 7th, 8th: two consecutive breaches, not three pairwise ones.
    expect(
      evaluate([rule], version({ assignments: calls(['2032-09-06', '2032-09-07', '2032-09-08']) })),
    ).toHaveLength(2);
  });

  it('the ORDER of the input does not change the findings', () => {
    const forward = calls(['2032-09-06', '2032-09-08']);
    const reversed = [...forward].reverse();
    expect(evaluate([rule], version({ assignments: reversed }))).toEqual(
      evaluate([rule], version({ assignments: forward })),
    );
  });
});

describe('AvoidDate attributes an assignment to its START date (N-3)', () => {
  const rule = hard('avoid_2032_12_25', { kind: 'AvoidDate', date: '2032-12-25' });

  it('an overnight shift running INTO the avoided date does NOT breach', () => {
    /* 22:00 on the 24th to 06:00 on the 25th. `assignment_snapshots.date` is the
     * START date, which is how this whole system attributes an assignment (the
     * daily sheet, the grid, D-1a) — so it is attributed to the 24th.
     *
     * This is a CHOICE about a boundary, not an accident, and it is pinned here
     * so that changing it is a ruling rather than a silent behaviour change. The
     * competing reading — "no working minute falls on the 25th" — is carried to
     * the owner in step-06-node-kinds.md §5. */
    const overnight = assignment({
      snapshotId: 'overnight',
      date: '2032-12-24',
      startsAtMs: Date.parse('2032-12-24T22:00:00.000Z'),
      endsAtMs: Date.parse('2032-12-25T06:00:00.000Z'),
    });
    expect(evaluate([rule], version({ assignments: [overnight] }))).toEqual([]);
  });

  it('…and a shift STARTING on the avoided date does breach — the control', () => {
    const onTheDay = assignment({ snapshotId: 'on-the-day', date: '2032-12-25' });
    expect(evaluate([rule], version({ assignments: [onTheDay] }))).toEqual([
      'breach:avoid_2032_12_25:on-the-day',
    ]);
  });
});

describe('scope resolution is fail-closed', () => {
  it('a date-range scope narrows what is checked', () => {
    const rule = hard(
      'avoid_scoped',
      { kind: 'AvoidDate', date: '2031-08-10' },
      { dateRange: { from: '2031-08-01', to: '2031-08-05' } },
    );
    const subject = version({ assignments: [assignment({ snapshotId: 's1', date: '2031-08-10' })] });
    expect(evaluate([rule], subject)).toEqual([]);

    // Control: the same rule with a range that contains the date does fire.
    const widened = hard(
      'avoid_wide',
      { kind: 'AvoidDate', date: '2031-08-10' },
      { dateRange: { from: '2031-08-01', to: '2031-08-31' } },
    );
    expect(evaluate([widened], subject)).toEqual(['breach:avoid_wide:s1']);
  });

  it('an unresolvable shift-type code is NOT-EVALUABLE rather than an empty scope', () => {
    const rule = hard(
      'avoid_unknown_type',
      { kind: 'AvoidDate', date: '2031-08-10' },
      { shiftTypes: ['NOT_A_CODE'] },
    );
    const subject = version({ assignments: [assignment({ snapshotId: 's1', date: '2031-08-10' })] });
    // The dangerous alternative is an empty scope, which passes vacuously and
    // reports nothing — a HARD rule skipped by an unresolved identifier.
    expect(evaluate([rule], subject)).toEqual(['not-evaluable:avoid_unknown_type:rule']);
  });

  /* REWRITTEN under RK-RULING-02 (authorized, FAD-38(7)). The assertion CLASS is
   * unchanged and is the one that matters: an unresolved identifier must never
   * silently narrow the scope to nothing, because a vacuous scope passes and a
   * HARD rule would have been skipped by a typo. What changed is WHY it can be
   * unresolved — the domain is now pinned to `staff_groups.id`, so there are
   * three arms rather than one blanket refusal, and all three are asserted. */
  it('a staffGroups scope with NO vocabulary is NOT-EVALUABLE (RK-RULING-02)', () => {
    const rule = hard(
      'avoid_staff_group',
      { kind: 'AvoidDate', date: '2031-08-10' },
      { staffGroups: ['sg-1'] },
    );
    const subject = version({ assignments: [assignment({ snapshotId: 's1', date: '2031-08-10' })] });
    expect(evaluate([rule], subject)).toEqual(['not-evaluable:avoid_staff_group:rule']);
  });

  it('a staffGroups scope naming an UNKNOWN id is NOT-EVALUABLE, never an empty scope', () => {
    const rule = hard(
      'avoid_staff_group',
      { kind: 'AvoidDate', date: '2031-08-10' },
      { staffGroups: ['sg-nope'] },
    );
    const subject = version({
      assignments: [assignment({ snapshotId: 's1', date: '2031-08-10' })],
      facts: { staffGroups: { 'sg-1': [MEMBER_A] } },
    });
    expect(evaluate([rule], subject)).toEqual(['not-evaluable:avoid_staff_group:rule']);
  });

  it('a staffGroups scope that RESOLVES narrows to its members — the other direction', () => {
    const rule = hard(
      'avoid_staff_group',
      { kind: 'AvoidDate', date: '2031-08-10' },
      { staffGroups: ['sg-1'] },
    );
    const subject = version({
      assignments: [
        assignment({ snapshotId: 'a', date: '2031-08-10', membershipId: MEMBER_A }),
        assignment({ snapshotId: 'b', date: '2031-08-10', membershipId: MEMBER_B }),
      ],
      facts: { staffGroups: { 'sg-1': [MEMBER_B] } },
    });
    expect(evaluate([rule], subject)).toEqual(['breach:avoid_staff_group:b']);
  });

  it('a membership scope that resolves narrows to that person', () => {
    const rule = hard(
      'avoid_for_b',
      { kind: 'AvoidDate', date: '2031-08-10' },
      { memberships: [MEMBER_B] },
    );
    const subject = version({
      assignments: [
        assignment({ snapshotId: 'a', date: '2031-08-10', membershipId: MEMBER_A }),
        assignment({ snapshotId: 'b', date: '2031-08-10', membershipId: MEMBER_B }),
      ],
    });
    expect(evaluate([rule], subject)).toEqual(['breach:avoid_for_b:b']);
  });
});

describe('an unevaluable HARD kind blocks rather than passing', () => {
  /* REWRITTEN under RK-RULING-01 (authorized, FAD-38(7)). The assertion class is
   * the same one: a kind this caller cannot decide BLOCKS with a stated reason
   * rather than passing silently. What changed is the reason — the grouping unit
   * is pinned now, and what a publication caller lacks is the build horizon. The
   * OTHER direction is asserted immediately below, which the original pin could
   * not do at all because the kind was undecidable for everyone. */
  it('RequiredCount without candidate facts BLOCKS, naming what is missing', () => {
    const rule = hard('coverage', { kind: 'RequiredCount', count: 2 });
    const subject = version({ assignments: [assignment({ snapshotId: 's1', date: '2031-09-01' })] });
    const findings = evaluateHardRules([compileRule(rule)], subject);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.finding).toBe('not-evaluable');
    expect(findings[0]?.ruleKey).toBe('coverage');
    expect(findings[0]?.explanation).toContain('candidateFacts');
  });

  it('…and WITH candidate facts it decides — the arm the old pin could not have', () => {
    const rule = hard('coverage', { kind: 'RequiredCount', count: 1 }, { shiftTypes: ['DAY'] });
    const satisfied = version({
      assignments: [assignment({ snapshotId: 's1', date: '2031-09-01' })],
      facts: { horizon: { from: '2031-09-01', to: '2031-09-01' } },
    });
    expect(evaluate([rule], satisfied)).toEqual([]);
    const breached = version({
      assignments: [assignment({ snapshotId: 's1', date: '2031-09-01' })],
      facts: { horizon: { from: '2031-09-01', to: '2031-09-02' } },
    });
    // The empty second day is the case a row-walking checker cannot see.
    expect(evaluate([rule], breached)).toEqual(['breach:coverage:2031-09-02/DAY']);
  });

  it('every unevaluable kind reports itself rather than passing silently', () => {
    // Built from the AST's own samples so the list cannot drift from the union.
    const unevaluable = (RULE_NODE_KINDS as readonly RuleNodeKind[]).filter(
      (kind) => !isEvaluatedHardRuleKind(kind),
    );
    /* 22 evaluated + 8 unevaluable = 30 (OPUS-M4-002; was 6 + 24 at M3-008).
     * The sixteen that moved did so because the eleven RK-RULINGs answered the
     * questions their reasons named — nothing here got cleverer. The remaining
     * eight are four kinds whose input a NAMED later milestone owns and four
     * SOFT-natural kinds whose HARD authoring is a classification contradiction.
     * The ASSERTION CLASS is unchanged: the two sets partition the union, and
     * both numbers are pinned so neither can drift alone. */
    expect(unevaluable.length).toBe(8);
    expect(EVALUATED_HARD_RULE_KINDS.length).toBe(22);
  });
});

describe('determinism', () => {
  it('findings are ordered by rule key, and the order does not depend on input order', () => {
    const subject = version({
      assignments: [
        assignment({ snapshotId: 's2', date: '2031-10-02' }),
        assignment({ snapshotId: 's1', date: '2031-10-01' }),
      ],
    });
    const rules = [
      hard('zzz_avoid', { kind: 'AvoidDate', date: '2031-10-01' }),
      hard('aaa_avoid', { kind: 'AvoidDate', date: '2031-10-02' }),
    ];
    expect(evaluate(rules, subject)).toEqual(['breach:aaa_avoid:s2', 'breach:zzz_avoid:s1']);
    expect(evaluate([...rules].reverse(), subject)).toEqual([
      'breach:aaa_avoid:s2',
      'breach:zzz_avoid:s1',
    ]);
  });
});
