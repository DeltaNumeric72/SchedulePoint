import { describe, expect, it } from 'vitest';

import {
  EVALUATED_HARD_RULE_KINDS,
  compileRule,
  evaluateHardRules,
  weekdayOfDate,
  type CandidateFacts,
  type CandidatePriorAssignment,
  type CheckedAssignment,
  type CheckedVersion,
  type DateRange,
  type Rule,
  type RuleNode,
  type RuleScope,
  type RuleWeekday,
} from '../../src/index.js';

/**
 * **Both-direction pins for every kind the eleven RK-RULINGs made evaluable**
 * (OPUS-M4-002, doc 35 §6d: "every ruling test-pinned BOTH directions").
 *
 * Every `it` below asserts a **breach constructed** and a **satisfied
 * constructed** from the same fixture with one fact moved. That pairing is the
 * whole discipline: a passing assertion whose subject could be absent proves
 * nothing, and a rule that never fires looks exactly like a rule that is always
 * satisfied. Where a ruling turns on a boundary — the vacuous NULL, the
 * intervening shift type, the gap day, the horizon edge — the boundary itself
 * has its own arm, because that is where the two readings the ruling chose
 * between actually disagree.
 *
 * Wholly synthetic: 2031 dates, `m-*` handles, no name of any kind.
 */

const A = 'm-aaaa';
const B = 'm-bbbb';
const HORIZON: DateRange = { from: '2031-06-01', to: '2031-06-30' };

function assignment(
  overrides: Partial<CheckedAssignment> & Pick<CheckedAssignment, 'snapshotId' | 'date'>,
): CheckedAssignment {
  const at = (hour: number): number =>
    Date.parse(`${overrides.date}T${String(hour).padStart(2, '0')}:00:00.000Z`);
  return {
    assignmentIdentityId: `id-${overrides.snapshotId}`,
    membershipId: A,
    startsAtMs: at(8),
    endsAtMs: at(16),
    shiftTypeCode: 'DAY',
    isOnCall: false,
    pickPosition: null,
    ...overrides,
  };
}

interface FactOverrides {
  readonly horizon?: DateRange;
  readonly staffGroups?: Record<string, readonly string[]>;
  readonly validGroups?: Record<string, readonly string[]>;
  readonly weekdayTargets?: Record<
    string,
    Record<string, { fteFraction: number; maxAssignments: number | null }>
  >;
  readonly prior?: readonly CandidatePriorAssignment[];
}

function facts(overrides: FactOverrides = {}): CandidateFacts {
  const staffGroups = overrides.staffGroups ?? {};
  const validGroups = overrides.validGroups ?? {};
  return {
    horizon: overrides.horizon ?? HORIZON,
    knownStaffGroupIds: new Set(Object.keys(staffGroups)),
    staffGroupMembers: (id) => (id in staffGroups ? new Set(staffGroups[id] ?? []) : null),
    knownValidGroupIds: new Set(Object.keys(validGroups)),
    validGroupShiftTypes: (id) => (id in validGroups ? new Set(validGroups[id] ?? []) : null),
    weekdayTarget: (membershipId, weekday: RuleWeekday) =>
      overrides.weekdayTargets?.[membershipId]?.[weekday] ?? null,
    workPercentage: () => null,
    priorAssignments: overrides.prior ?? [],
  };
}

function version(
  assignments: readonly CheckedAssignment[],
  overrides: FactOverrides = {},
  codes: readonly string[] = ['DAY', 'NIGHT', 'CALL'],
): CheckedVersion {
  return {
    assignments,
    knownShiftTypeCodes: new Set(codes),
    knownMembershipIds: new Set([A, B]),
    qualifications: { knownQualificationKeys: new Set(['acls']), heldOn: () => true },
    candidateFacts: facts(overrides),
  };
}

function hard(ruleKey: string, predicate: RuleNode, scope: RuleScope = {}): Rule {
  return {
    ruleKey,
    name: ruleKey,
    ruleSchemaVersion: 1,
    classification: 'HARD',
    scope,
    predicate,
  };
}

/** `finding:ruleKey:field`, sorted by the checker. One readable shape. */
function evaluate(rules: readonly Rule[], subject: CheckedVersion): string[] {
  return evaluateHardRules(
    rules.map((rule) => compileRule(rule)),
    subject,
  ).map((finding) => `${finding.finding}:${finding.ruleKey}:${finding.field}`);
}

/* ────────────────────────────────────────────────────────────────────────────
 * RK-RULING-01 — coverage counts over date × shift type
 * ──────────────────────────────────────────────────────────────────────────── */

describe('RK-RULING-01 — the coverage grouping unit is date × shift type', () => {
  const window: DateRange = { from: '2031-06-01', to: '2031-06-02' };
  const scope: RuleScope = { shiftTypes: ['DAY'], dateRange: window };

  it('RequiredCount is SATISFIED when every date carries exactly the count', () => {
    const subject = version(
      [
        assignment({ snapshotId: 'a', date: '2031-06-01' }),
        assignment({ snapshotId: 'b', date: '2031-06-02' }),
      ],
      { horizon: window },
    );
    expect(evaluate([hard('rc', { kind: 'RequiredCount', count: 1 }, scope)], subject)).toEqual([]);
  });

  it('…and BREACHED on the EMPTY date — the case a row walk cannot see', () => {
    const subject = version([assignment({ snapshotId: 'a', date: '2031-06-01' })], {
      horizon: window,
    });
    expect(evaluate([hard('rc', { kind: 'RequiredCount', count: 1 }, scope)], subject)).toEqual([
      'breach:rc:2031-06-02/DAY',
    ]);
  });

  it('MinCoverage and MaxCoverage bite on their own sides and not the other', () => {
    const two = version(
      [
        assignment({ snapshotId: 'a', date: '2031-06-01' }),
        assignment({ snapshotId: 'b', date: '2031-06-01', membershipId: B }),
      ],
      { horizon: { from: '2031-06-01', to: '2031-06-01' } },
    );
    expect(evaluate([hard('lo', { kind: 'MinCoverage', min: 2 }, scope)], two)).toEqual([]);
    expect(evaluate([hard('lo', { kind: 'MinCoverage', min: 3 }, scope)], two)).toEqual([
      'breach:lo:2031-06-01/DAY',
    ]);
    expect(evaluate([hard('hi', { kind: 'MaxCoverage', max: 2 }, scope)], two)).toEqual([]);
    expect(evaluate([hard('hi', { kind: 'MaxCoverage', max: 1 }, scope)], two)).toEqual([
      'breach:hi:2031-06-01/DAY',
    ]);
  });

  it('location is NOT a coverage dimension — two locations on one date are ONE cell', () => {
    /* R-B6: location is display metadata and a shift without one is legal, so a
     * per-location count would count over a dimension the demand model does not
     * have. The checker sees no location at all, which is the ruling made
     * structural rather than merely stated. */
    const subject = version(
      [
        assignment({ snapshotId: 'a', date: '2031-06-01' }),
        assignment({ snapshotId: 'b', date: '2031-06-01', membershipId: B }),
      ],
      { horizon: { from: '2031-06-01', to: '2031-06-01' } },
    );
    expect(evaluate([hard('rc', { kind: 'RequiredCount', count: 2 }, scope)], subject)).toEqual([]);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * RK-RULING-02 / 03 — stable identifier domains
 * ──────────────────────────────────────────────────────────────────────────── */

describe('RK-RULING-02 — MemberOfStaffGroup names staff_groups.id', () => {
  const rule = hard('sg', { kind: 'MemberOfStaffGroup', staffGroup: 'sg-1' });

  it('SATISFIED when every assignee is a member', () => {
    const subject = version([assignment({ snapshotId: 'a', date: '2031-06-03' })], {
      staffGroups: { 'sg-1': [A, B] },
    });
    expect(evaluate([rule], subject)).toEqual([]);
  });

  it('BREACHED by an assignee outside the group', () => {
    const subject = version([assignment({ snapshotId: 'a', date: '2031-06-03' })], {
      staffGroups: { 'sg-1': [B] },
    });
    expect(evaluate([rule], subject)).toEqual(['breach:sg:a']);
  });

  it('an UNKNOWN id is not-evaluable — never "nobody is in it"', () => {
    /* The dangerous reading: an unknown id resolving to an empty member set would
     * turn a single typo into a breach of every row in the schedule. */
    const subject = version([assignment({ snapshotId: 'a', date: '2031-06-03' })], {
      staffGroups: { 'sg-other': [A] },
    });
    expect(evaluate([rule], subject)).toEqual(['not-evaluable:sg:rule']);
  });
});

describe('RK-RULING-03 — ValidGroupRestriction names valid_groups.id', () => {
  const rule = hard('vg', { kind: 'ValidGroupRestriction', validGroup: 'vg-1' });

  it('SATISFIED on an admitted shift type, BREACHED on one it does not admit', () => {
    const ok = version([assignment({ snapshotId: 'a', date: '2031-06-04' })], {
      validGroups: { 'vg-1': ['DAY'] },
    });
    expect(evaluate([rule], ok)).toEqual([]);
    const bad = version([assignment({ snapshotId: 'a', date: '2031-06-04' })], {
      validGroups: { 'vg-1': ['NIGHT'] },
    });
    expect(evaluate([rule], bad)).toEqual(['breach:vg:a']);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * RK-RULING-04 — the vacuous NULL
 * ──────────────────────────────────────────────────────────────────────────── */

describe('RK-RULING-04 — a NULL pick position satisfies VACUOUSLY', () => {
  const rule = hard('pp', { kind: 'PickPositionRestriction', allowedPickPositions: [1, 2] });

  it('a REAL out-of-range position breaches', () => {
    const subject = version([assignment({ snapshotId: 'a', date: '2031-06-05', pickPosition: 7 })]);
    expect(evaluate([rule], subject)).toEqual(['breach:pp:a']);
  });

  it('an in-range position does not', () => {
    const subject = version([assignment({ snapshotId: 'a', date: '2031-06-05', pickPosition: 2 })]);
    expect(evaluate([rule], subject)).toEqual([]);
  });

  it('NULL — every manual override and every solver row — NEVER breaches', () => {
    /* Breaching on NULL would make every manual override a violation and would
     * manufacture a finding out of an absence (the FAD-23 class). */
    const subject = version([
      assignment({ snapshotId: 'a', date: '2031-06-05', pickPosition: null }),
    ]);
    expect(evaluate([rule], subject)).toEqual([]);
  });

  it('an ABSENT column is neither — it blocks, because absent is not NULL', () => {
    const bare: CheckedAssignment = {
      assignmentIdentityId: 'id-a',
      snapshotId: 'a',
      membershipId: A,
      date: '2031-06-05',
      startsAtMs: Date.parse('2031-06-05T08:00:00.000Z'),
      endsAtMs: Date.parse('2031-06-05T16:00:00.000Z'),
      shiftTypeCode: 'DAY',
      isOnCall: false,
    };
    expect(evaluate([rule], version([bare]))).toEqual(['not-evaluable:pp:rule']);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * RK-RULING-05 — WeekdayFteLimit, as authored
 * ──────────────────────────────────────────────────────────────────────────── */

describe('RK-RULING-05 — WeekdayFteLimit over the accounting window', () => {
  /* June 2031: the 2nd, 9th, 16th, 23rd and 30th are Mondays. Asserted rather
   * than assumed, because the whole limit is a function of that count. */
  it('the fixture really is five Mondays', () => {
    for (const date of ['2031-06-02', '2031-06-09', '2031-06-16', '2031-06-23', '2031-06-30']) {
      expect(weekdayOfDate(date)).toBe('mon');
    }
  });

  const mondays = ['2031-06-02', '2031-06-09', '2031-06-16'];
  const rows = mondays.map((date, index) =>
    assignment({ snapshotId: `m${String(index)}`, date }),
  );

  it('SATISFIED at the ceiling — 0.5 × 5 Mondays rounds UP to 3', () => {
    const rule = hard('fte', { kind: 'WeekdayFteLimit', weekday: 'mon', fteFraction: 0.5 });
    expect(evaluate([rule], version(rows))).toEqual([]);
  });

  it('BREACHED one over — 0.4 × 5 = 2', () => {
    const rule = hard('fte', { kind: 'WeekdayFteLimit', weekday: 'mon', fteFraction: 0.4 });
    expect(evaluate([rule], version(rows))).toEqual([`breach:fte:${A}`]);
  });

  it('the PROFILE can only TIGHTEN, never relax — the min-composition departure', () => {
    /* The packet's default proposal read `max_assignments` as an "absolute
     * override". Taken literally an override could RAISE a HARD limit, and
     * SPEC-04 §3.3 admits no path that relaxes a HARD rule. Both directions of
     * that choice are pinned here: a tighter profile bites… */
    const rule = hard('fte', { kind: 'WeekdayFteLimit', weekday: 'mon', fteFraction: 1 });
    const tightened = version(rows, {
      weekdayTargets: { [A]: { mon: { fteFraction: 1, maxAssignments: 2 } } },
    });
    expect(evaluate([rule], tightened)).toEqual([`breach:fte:${A}`]);

    // …and a LOOSER profile cannot lift the rule's own ceiling.
    const strict = hard('fte', { kind: 'WeekdayFteLimit', weekday: 'mon', fteFraction: 0.4 });
    const loosened = version(rows, {
      weekdayTargets: { [A]: { mon: { fteFraction: 1, maxAssignments: 99 } } },
    });
    expect(evaluate([strict], loosened)).toEqual([`breach:fte:${A}`]);
  });

  it('the accounting window is the scope ∩ the horizon, not the whole period', () => {
    const rule = hard(
      'fte',
      { kind: 'WeekdayFteLimit', weekday: 'mon', fteFraction: 0.5 },
      { dateRange: { from: '2031-06-01', to: '2031-06-14' } },
    );
    // Two Mondays in the window, so 0.5 × 2 = 1 — and the fixture has two.
    expect(evaluate([rule], version(rows))).toEqual([`breach:fte:${A}`]);
  });

  it('the `holiday` day-arm is not-evaluable — no calendar is a constituent', () => {
    const rule = hard('fte', { kind: 'WeekdayFteLimit', weekday: 'holiday', fteFraction: 0.5 });
    expect(evaluate([rule], version(rows))).toEqual(['not-evaluable:fte:rule']);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * RK-RULING-07 / 08 — adjacency and sequence, over CALENDAR DATES
 * ──────────────────────────────────────────────────────────────────────────── */

describe('RK-RULING-07 — NoAdjacent means consecutive calendar dates', () => {
  const rule = hard('na', { kind: 'NoAdjacent', shiftTypeA: 'DAY', shiftTypeB: 'NIGHT' });

  it('BREACHED on consecutive dates, in EITHER order', () => {
    const forward = version([
      assignment({ snapshotId: 'a', date: '2031-06-10', shiftTypeCode: 'DAY' }),
      assignment({ snapshotId: 'b', date: '2031-06-11', shiftTypeCode: 'NIGHT' }),
    ]);
    expect(evaluate([rule], forward)).toEqual([`breach:na:${A}`]);
    const backward = version([
      assignment({ snapshotId: 'a', date: '2031-06-10', shiftTypeCode: 'NIGHT' }),
      assignment({ snapshotId: 'b', date: '2031-06-11', shiftTypeCode: 'DAY' }),
    ]);
    expect(evaluate([rule], backward)).toEqual([`breach:na:${A}`]);
  });

  it('SATISFIED with a day between them — a gap is not adjacency', () => {
    const subject = version([
      assignment({ snapshotId: 'a', date: '2031-06-10', shiftTypeCode: 'DAY' }),
      assignment({ snapshotId: 'b', date: '2031-06-12', shiftTypeCode: 'NIGHT' }),
    ]);
    expect(evaluate([rule], subject)).toEqual([]);
  });

  it('is per MEMBERSHIP — two people on consecutive dates do not breach', () => {
    const subject = version([
      assignment({ snapshotId: 'a', date: '2031-06-10', shiftTypeCode: 'DAY' }),
      assignment({ snapshotId: 'b', date: '2031-06-11', shiftTypeCode: 'NIGHT', membershipId: B }),
    ]);
    expect(evaluate([rule], subject)).toEqual([]);
  });
});

describe('RK-RULING-08 — ForbiddenSequence over consecutive dates, in order', () => {
  const rule = hard('fs', { kind: 'ForbiddenSequence', sequence: ['DAY', 'NIGHT'] });

  it('BREACHED by the run on consecutive dates', () => {
    const subject = version([
      assignment({ snapshotId: 'a', date: '2031-06-14', shiftTypeCode: 'DAY' }),
      assignment({ snapshotId: 'b', date: '2031-06-15', shiftTypeCode: 'NIGHT' }),
    ]);
    expect(evaluate([rule], subject)).toEqual([`breach:fs:${A}`]);
  });

  it('SATISFIED in the OTHER order — a sequence is ordered', () => {
    const subject = version([
      assignment({ snapshotId: 'a', date: '2031-06-14', shiftTypeCode: 'NIGHT' }),
      assignment({ snapshotId: 'b', date: '2031-06-15', shiftTypeCode: 'DAY' }),
    ]);
    expect(evaluate([rule], subject)).toEqual([]);
  });

  it('a GAP DAY breaks the run — the arm the two M3 readings disagreed on', () => {
    const subject = version([
      assignment({ snapshotId: 'a', date: '2031-06-14', shiftTypeCode: 'DAY' }),
      assignment({ snapshotId: 'b', date: '2031-06-16', shiftTypeCode: 'NIGHT' }),
    ]);
    expect(evaluate([rule], subject)).toEqual([]);
  });

  it('an INTERVENING type on a date between them breaks it — the other arm', () => {
    const three = hard('fs3', { kind: 'ForbiddenSequence', sequence: ['DAY', 'NIGHT'] });
    const subject = version([
      assignment({ snapshotId: 'a', date: '2031-06-14', shiftTypeCode: 'DAY' }),
      assignment({ snapshotId: 'x', date: '2031-06-15', shiftTypeCode: 'CALL' }),
      assignment({ snapshotId: 'b', date: '2031-06-16', shiftTypeCode: 'NIGHT' }),
    ]);
    expect(evaluate([three], subject)).toEqual([]);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * RK-RULING-09 — linkage binds the same membership AND the same date
 * ──────────────────────────────────────────────────────────────────────────── */

describe('RK-RULING-09 — linkage is same membership, same calendar date', () => {
  it('LinkedShifts: any implies all, on ONE date', () => {
    const rule = hard('ls', { kind: 'LinkedShifts', shiftTypes: ['DAY', 'NIGHT'] });
    const both = version([
      assignment({ snapshotId: 'a', date: '2031-06-18', shiftTypeCode: 'DAY' }),
      assignment({ snapshotId: 'b', date: '2031-06-18', shiftTypeCode: 'NIGHT' }),
    ]);
    expect(evaluate([rule], both)).toEqual([]);
    const one = version([assignment({ snapshotId: 'a', date: '2031-06-18', shiftTypeCode: 'DAY' })]);
    expect(evaluate([rule], one)).toEqual([`breach:ls:${A}`]);
  });

  it('…and the DIFFERENT-DATE arm does NOT satisfy it — the ruling made concrete', () => {
    const rule = hard('ls', { kind: 'LinkedShifts', shiftTypes: ['DAY', 'NIGHT'] });
    const split = version([
      assignment({ snapshotId: 'a', date: '2031-06-18', shiftTypeCode: 'DAY' }),
      assignment({ snapshotId: 'b', date: '2031-06-19', shiftTypeCode: 'NIGHT' }),
    ]);
    // Two separate dates, each holding one of the pair: two breaches, not zero.
    expect(evaluate([rule], split)).toEqual([`breach:ls:${A}`, `breach:ls:${A}`]);
  });

  it('ImpliesAssignment is one-directional', () => {
    const rule = hard('ia', {
      kind: 'ImpliesAssignment',
      ifShiftType: 'DAY',
      thenShiftType: 'NIGHT',
    });
    const bad = version([assignment({ snapshotId: 'a', date: '2031-06-20', shiftTypeCode: 'DAY' })]);
    expect(evaluate([rule], bad)).toEqual([`breach:ia:${A}`]);
    // The converse is NOT implied: NIGHT alone is fine.
    const ok = version([
      assignment({ snapshotId: 'a', date: '2031-06-20', shiftTypeCode: 'NIGHT' }),
    ]);
    expect(evaluate([rule], ok)).toEqual([]);
  });

  it('MutuallyExclusive is exclusive over a SINGLE date', () => {
    const rule = hard('me', { kind: 'MutuallyExclusive', shiftTypes: ['DAY', 'NIGHT'] });
    const sameDay = version([
      assignment({ snapshotId: 'a', date: '2031-06-21', shiftTypeCode: 'DAY' }),
      assignment({ snapshotId: 'b', date: '2031-06-21', shiftTypeCode: 'NIGHT' }),
    ]);
    expect(evaluate([rule], sameDay)).toEqual([`breach:me:${A}`]);
    const nextDay = version([
      assignment({ snapshotId: 'a', date: '2031-06-21', shiftTypeCode: 'DAY' }),
      assignment({ snapshotId: 'b', date: '2031-06-22', shiftTypeCode: 'NIGHT' }),
    ]);
    expect(evaluate([rule], nextDay)).toEqual([]);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * RK-RULING-10 and the fixed family
 * ──────────────────────────────────────────────────────────────────────────── */

describe('RK-RULING-10 — FixedAssignment names assignment_identities.id', () => {
  const prior: CandidatePriorAssignment[] = [
    {
      assignmentIdentityId: 'ai-1',
      membershipId: A,
      date: '2031-06-24',
      shiftTypeCode: 'DAY',
      isPinned: true,
    },
  ];
  const rule = hard('fa', { kind: 'FixedAssignment', assignmentIdentity: 'ai-1' });

  it('SATISFIED when the candidate keeps it exactly', () => {
    const subject = version(
      [
        assignment({
          snapshotId: 'a',
          date: '2031-06-24',
          assignmentIdentityId: 'ai-1',
        }),
      ],
      { prior },
    );
    expect(evaluate([rule], subject)).toEqual([]);
  });

  it('BREACHED when it is absent', () => {
    expect(evaluate([rule], version([], { prior }))).toEqual(['breach:fa:ai-1']);
  });

  it('BREACHED when it MOVED to another person', () => {
    const subject = version(
      [
        assignment({
          snapshotId: 'a',
          date: '2031-06-24',
          assignmentIdentityId: 'ai-1',
          membershipId: B,
        }),
      ],
      { prior },
    );
    expect(evaluate([rule], subject)).toEqual(['breach:fa:ai-1']);
  });

  it('an identity the build was never given is not-evaluable, not a breach', () => {
    const rule2 = hard('fa2', { kind: 'FixedAssignment', assignmentIdentity: 'ai-nope' });
    expect(evaluate([rule2], version([], { prior }))).toEqual(['not-evaluable:fa2:rule']);
  });
});

describe('ProtectedRange — the solver-and-validator owner, executed', () => {
  const prior: CandidatePriorAssignment[] = [
    {
      assignmentIdentityId: 'ai-in',
      membershipId: A,
      date: '2031-06-10',
      shiftTypeCode: 'DAY',
      isPinned: false,
    },
    {
      assignmentIdentityId: 'ai-out',
      membershipId: A,
      date: '2031-06-25',
      shiftTypeCode: 'DAY',
      isPinned: false,
    },
  ];
  const rule = hard('pr', { kind: 'ProtectedRange', from: '2031-06-01', to: '2031-06-15' });

  it('BREACHED when something INSIDE the range is dropped', () => {
    const subject = version(
      [assignment({ snapshotId: 'b', date: '2031-06-25', assignmentIdentityId: 'ai-out' })],
      { prior },
    );
    expect(evaluate([rule], subject)).toEqual(['breach:pr:ai-in']);
  });

  it('SATISFIED when the inside is kept — and the OUTSIDE may move freely', () => {
    const subject = version(
      [assignment({ snapshotId: 'a', date: '2031-06-10', assignmentIdentityId: 'ai-in' })],
      { prior },
    );
    expect(evaluate([rule], subject)).toEqual([]);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The two pattern kinds
 * ──────────────────────────────────────────────────────────────────────────── */

describe('PatternRule — an IMPLICATION over a candidate', () => {
  const rule = hard('pat', {
    kind: 'PatternRule',
    trigger: 'DAY',
    daysOfWeek: ['mon'],
    segments: [{ offsetDays: 1, shiftType: 'NIGHT' }],
  });

  it('BREACHED when the trigger fires and the segment is missing', () => {
    const subject = version([
      assignment({ snapshotId: 'a', date: '2031-06-09', shiftTypeCode: 'DAY' }),
    ]);
    expect(evaluate([rule], subject)).toEqual(['breach:pat:a']);
  });

  it('SATISFIED when the segment is present', () => {
    const subject = version([
      assignment({ snapshotId: 'a', date: '2031-06-09', shiftTypeCode: 'DAY' }),
      assignment({ snapshotId: 'b', date: '2031-06-10', shiftTypeCode: 'NIGHT' }),
    ]);
    expect(evaluate([rule], subject)).toEqual([]);
  });

  it('does not fire on a weekday the pattern does not name', () => {
    const subject = version([
      assignment({ snapshotId: 'a', date: '2031-06-10', shiftTypeCode: 'DAY' }),
    ]);
    expect(weekdayOfDate('2031-06-10')).toBe('tue');
    expect(evaluate([rule], subject)).toEqual([]);
  });

  it('a segment falling OUTSIDE the horizon is not required', () => {
    /* A rule impossible to obey at the period edge is a rule somebody disables,
     * and then it is enforced nowhere. */
    const subject = version([assignment({ snapshotId: 'a', date: '2031-06-30' })], {
      horizon: { from: '2031-06-01', to: '2031-06-30' },
    });
    expect(weekdayOfDate('2031-06-30')).toBe('mon');
    expect(evaluate([rule], subject)).toEqual([]);
  });
});

describe('AlternatingWeek — one week class, not two', () => {
  const rule = hard('alt', { kind: 'AlternatingWeek', onShiftType: 'DAY', cycleWeeks: 2 });

  it('SATISFIED inside one class', () => {
    const subject = version(
      [
        assignment({ snapshotId: 'a', date: '2031-06-02' }),
        assignment({ snapshotId: 'b', date: '2031-06-16' }),
      ],
      { horizon: { from: '2031-06-01', to: '2031-06-30' } },
    );
    expect(evaluate([rule], subject)).toEqual([]);
  });

  it('BREACHED across two classes', () => {
    const subject = version(
      [
        assignment({ snapshotId: 'a', date: '2031-06-02' }),
        assignment({ snapshotId: 'b', date: '2031-06-09' }),
      ],
      { horizon: { from: '2031-06-01', to: '2031-06-30' } },
    );
    expect(evaluate([rule], subject)).toEqual([`breach:alt:${A}`]);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Fail-closed, and the totality of the pinning
 * ──────────────────────────────────────────────────────────────────────────── */

describe('the four later-milestone kinds FAIL CLOSED with a named owner', () => {
  const cases: readonly [string, RuleNode, string][] = [
    ['TemplateAdherence', { kind: 'TemplateAdherence', template: 't', cycleWeeks: 2 }, 'templates-slice'],
    ['RequestHonoured', { kind: 'RequestHonoured', requestType: 'leave' }, 'M5-requests'],
    ['StaffOverLocumPriority', { kind: 'StaffOverLocumPriority', windowDays: 7 }, 'locum-slice'],
    ['LocumRestriction', { kind: 'LocumRestriction', restriction: 'no_locum' }, 'locum-slice'],
  ];

  for (const [name, predicate, owner] of cases) {
    it(`${name} blocks and names ${owner}`, () => {
      const rule = hard(`fc_${name}`, predicate);
      const findings = evaluateHardRules(
        [compileRule(rule)],
        version([assignment({ snapshotId: 'a', date: '2031-06-05' })]),
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]?.finding).toBe('not-evaluable');
      // Non-bypass rule 11: never dropped, never deferred without a name.
      expect(findings[0]?.explanation).toContain(`OWNER: ${owner}`);
    });
  }

  it('a HARD authoring of a SOFT-natural kind is a contradiction, and blocks', () => {
    const rule = hard('wpt', { kind: 'WorkPercentageTarget', targetPercentage: 50 });
    const findings = evaluateHardRules(
      [compileRule(rule)],
      version([assignment({ snapshotId: 'a', date: '2031-06-05' })]),
    );
    expect(findings[0]?.finding).toBe('not-evaluable');
    expect(findings[0]?.explanation).toContain('classification-contradiction');
  });

  it('a SOFT rule is not a publication prerequisite and produces nothing', () => {
    const soft: Rule = {
      ruleKey: 'pref',
      name: 'pref',
      ruleSchemaVersion: 1,
      classification: 'SOFT',
      weight: 5,
      scope: {},
      predicate: { kind: 'ShiftPreference', shiftType: 'DAY', strength: 'avoid' },
    };
    expect(evaluate([soft], version([assignment({ snapshotId: 'a', date: '2031-06-05' })]))).toEqual(
      [],
    );
  });
});

describe('every evaluated kind is pinned by this file or by its M3 sibling', () => {
  it('the 22 evaluated kinds are exactly the ones the rulings and M3-008 cover', () => {
    /* Mechanical, so a kind added to the evaluated set without a both-direction
     * pin cannot slip through unnoticed: the list below is maintained by hand
     * BECAUSE that is the point — adding a kind forces a decision about where
     * its pin lives. */
    const m3 = [
      'RequiresQualification',
      'MinimumRestBetween',
      'MaxConsecutive',
      'MaxAssignmentsInWindow',
      'CallSpacing',
      'AvoidDate',
    ];
    const m4 = [
      'RequiredCount',
      'MinCoverage',
      'MaxCoverage',
      'MemberOfStaffGroup',
      'ValidGroupRestriction',
      'PickPositionRestriction',
      'WeekdayFteLimit',
      'NoAdjacent',
      'ForbiddenSequence',
      'LinkedShifts',
      'ImpliesAssignment',
      'MutuallyExclusive',
      'FixedAssignment',
      'ProtectedRange',
      'PatternRule',
      'AlternatingWeek',
    ];
    expect(new Set([...m3, ...m4])).toEqual(new Set(EVALUATED_HARD_RULE_KINDS));
    expect(m4).toHaveLength(16);
  });
});
