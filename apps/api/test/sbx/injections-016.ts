import {
  EVALUATED_HARD_RULE_KINDS,
  weekdayOfDate,
  type CandidateFacts,
  type CandidatePriorAssignment,
  type CheckedAssignment,
  type CheckedVersion,
  type DateRange,
  type EvaluatedHardRuleKind,
  type Rule,
  type RuleNode,
  type RuleScope,
  type RuleWeekday,
} from '@schedulepoint/domain';

/**
 * **SBX-016's injected defects — one per M4-evaluable HARD kind, all 22.**
 *
 * Report 24 §3.4 is the gate: *"100% of injected hard violations detected, each
 * with severity, explanation, and remediation"*, evidenced by "SBX-016 against a
 * fixture with deliberately injected defects". This module IS that fixture. It
 * is a table rather than 22 hand-written test bodies for one reason: the
 * scenario's oracle has to be able to say *"every kind in
 * `EVALUATED_HARD_RULE_KINDS` was injected"* mechanically, so a kind added to the
 * checker later cannot quietly leave the sweep at 21 of 22 while the percentage
 * still reads 100.
 *
 * ## Every entry carries BOTH directions
 *
 * `breached` is the world with the defect; `satisfied` is the same world with one
 * fact moved. Without the second, a checker that reported a breach for every rule
 * of every kind would score a perfect 100% detection rate, and the number would
 * be meaningless. The satisfied twin is what makes the detection rate a
 * measurement rather than a tautology, and the scenario asserts it produces
 * **zero** findings for the injected rule key.
 *
 * ## Wholly synthetic
 *
 * `m-sbx016-*` handles, June 2031 dates, `DAY`/`NIGHT`/`CALL` codes. No name of
 * any kind, nothing from the research corpus, no database. The dates are the same
 * month `packages/domain/test/rules/ruled-kinds.test.ts` uses because the weekday
 * arithmetic there is already pinned — and the scenario re-asserts the weekday
 * facts it depends on rather than trusting this comment.
 */

/** The two synthetic memberships every injection draws from. */
export const M_A = 'm-sbx016-a';
export const M_B = 'm-sbx016-b';

/** The horizon every injection is measured over unless it names its own. */
export const HORIZON: DateRange = { from: '2031-06-01', to: '2031-06-30' };

/** The weekday facts the pattern, alternating-week and FTE injections depend on. */
export const PINNED_WEEKDAYS: readonly (readonly [string, RuleWeekday])[] = [
  ['2031-06-02', 'mon'],
  ['2031-06-09', 'mon'],
  ['2031-06-16', 'mon'],
  ['2031-06-23', 'mon'],
  ['2031-06-30', 'mon'],
  ['2031-06-10', 'tue'],
];

/** `weekdayOfDate` re-exported so the scenario asserts the pins above itself. */
export { weekdayOfDate };

function at(date: string, hour: number): number {
  return Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00.000Z`);
}

interface RowOptions {
  readonly snapshotId: string;
  readonly date: string;
  readonly membershipId?: string;
  readonly shiftTypeCode?: string;
  readonly isOnCall?: boolean;
  readonly startHour?: number;
  readonly endHour?: number;
  readonly assignmentIdentityId?: string;
  readonly pickPosition?: number | null;
}

/** One checked assignment. Times default to 08:00–16:00 on the given date. */
function row(options: RowOptions): CheckedAssignment {
  const base: CheckedAssignment = {
    snapshotId: options.snapshotId,
    assignmentIdentityId: options.assignmentIdentityId ?? `ai-${options.snapshotId}`,
    membershipId: options.membershipId ?? M_A,
    date: options.date,
    startsAtMs: at(options.date, options.startHour ?? 8),
    endsAtMs: at(options.date, options.endHour ?? 16),
    shiftTypeCode: options.shiftTypeCode ?? 'DAY',
    isOnCall: options.isOnCall ?? false,
    pickPosition: options.pickPosition === undefined ? null : options.pickPosition,
  };
  return base;
}

interface WorldOptions {
  readonly horizon?: DateRange;
  readonly staffGroups?: Record<string, readonly string[]>;
  readonly validGroups?: Record<string, readonly string[]>;
  readonly weekdayTargets?: Record<
    string,
    Partial<Record<RuleWeekday, { fteFraction: number; maxAssignments: number | null }>>
  >;
  readonly prior?: readonly CandidatePriorAssignment[];
  readonly holds?: boolean;
}

function facts(options: WorldOptions): CandidateFacts {
  const staffGroups = options.staffGroups ?? {};
  const validGroups = options.validGroups ?? {};
  return {
    horizon: options.horizon ?? HORIZON,
    knownStaffGroupIds: new Set(Object.keys(staffGroups)),
    staffGroupMembers: (id) => (id in staffGroups ? new Set(staffGroups[id] ?? []) : null),
    knownValidGroupIds: new Set(Object.keys(validGroups)),
    validGroupShiftTypes: (id) => (id in validGroups ? new Set(validGroups[id] ?? []) : null),
    weekdayTarget: (membershipId, weekday) =>
      options.weekdayTargets?.[membershipId]?.[weekday] ?? null,
    workPercentage: () => null,
    priorAssignments: options.prior ?? [],
  };
}

/** One checked version: the candidate content plus the group's vocabulary. */
function world(
  assignments: readonly CheckedAssignment[],
  options: WorldOptions = {},
): CheckedVersion {
  return {
    assignments,
    knownShiftTypeCodes: new Set(['DAY', 'NIGHT', 'CALL']),
    knownMembershipIds: new Set([M_A, M_B]),
    qualifications: {
      knownQualificationKeys: new Set(['acls']),
      heldOn: () => options.holds ?? true,
    },
    candidateFacts: facts(options),
  };
}

function hard(ruleKey: string, predicate: RuleNode, scope: RuleScope = {}): Rule {
  return {
    ruleKey,
    name: `SBX-016 injection ${ruleKey}`,
    ruleSchemaVersion: 1,
    classification: 'HARD',
    scope,
    predicate,
  };
}

/**
 * One injected defect: the rule, the world that violates it, and the world that
 * does not.
 */
export interface HardKindInjection {
  readonly kind: EvaluatedHardRuleKind;
  readonly rule: Rule;
  /** What the defect IS, in one sentence, for the retained artifact. */
  readonly defect: string;
  readonly breached: CheckedVersion;
  readonly satisfied: CheckedVersion;
  /**
   * Domain identifiers the breach explanation MUST name.
   *
   * This is the "explained in domain terms" half of report 24 §3.4, made
   * mechanical: a detector that reported `violation of rule 7` would satisfy
   * "detected" and fail here, which is the whole distinction the gate draws.
   */
  readonly expectedTerms: readonly string[];
}

const COVERAGE_WINDOW: DateRange = { from: '2031-06-01', to: '2031-06-02' };
const COVERAGE_SCOPE: RuleScope = { shiftTypes: ['DAY'], dateRange: COVERAGE_WINDOW };

const FIXED_PRIOR: readonly CandidatePriorAssignment[] = [
  {
    assignmentIdentityId: 'ai-fixed',
    membershipId: M_A,
    date: '2031-06-24',
    shiftTypeCode: 'DAY',
    isPinned: true,
  },
];

const RANGE_PRIOR: readonly CandidatePriorAssignment[] = [
  {
    assignmentIdentityId: 'ai-inside',
    membershipId: M_A,
    date: '2031-06-10',
    shiftTypeCode: 'DAY',
    isPinned: false,
  },
  {
    assignmentIdentityId: 'ai-outside',
    membershipId: M_A,
    date: '2031-06-25',
    shiftTypeCode: 'DAY',
    isPinned: false,
  },
];

/** Every injection, one per evaluated kind. The scenario asserts the totality. */
export const HARD_KIND_INJECTIONS: readonly HardKindInjection[] = [
  {
    kind: 'RequiresQualification',
    rule: hard('inj_requires_qualification', {
      kind: 'RequiresQualification',
      qualification: 'acls',
      validAt: 'shift_date',
    }),
    defect: 'a participant is placed on a shift without holding the required credential that day',
    breached: world([row({ snapshotId: 'q1', date: '2031-06-05' })], { holds: false }),
    satisfied: world([row({ snapshotId: 'q1', date: '2031-06-05' })], { holds: true }),
    expectedTerms: [M_A, '2031-06-05', 'acls'],
  },
  {
    kind: 'MinimumRestBetween',
    rule: hard('inj_minimum_rest', { kind: 'MinimumRestBetween', minHours: 12 }),
    defect: 'two shifts for one participant separated by less rest than the rule requires',
    breached: world([
      row({ snapshotId: 'r1', date: '2031-06-05' }),
      row({ snapshotId: 'r2', date: '2031-06-06', startHour: 0, endHour: 8 }),
    ]),
    satisfied: world([
      row({ snapshotId: 'r1', date: '2031-06-05' }),
      row({ snapshotId: 'r2', date: '2031-06-06', startHour: 8, endHour: 16 }),
    ]),
    expectedTerms: [M_A, '2031-06-06'],
  },
  {
    kind: 'MaxConsecutive',
    rule: hard('inj_max_consecutive', { kind: 'MaxConsecutive', maxDays: 2 }),
    defect: 'a run of consecutive working days one longer than the rule permits',
    breached: world([
      row({ snapshotId: 'c1', date: '2031-06-03' }),
      row({ snapshotId: 'c2', date: '2031-06-04' }),
      row({ snapshotId: 'c3', date: '2031-06-05' }),
    ]),
    satisfied: world([
      row({ snapshotId: 'c1', date: '2031-06-03' }),
      row({ snapshotId: 'c2', date: '2031-06-04' }),
    ]),
    expectedTerms: [M_A, '2031-06-03'],
  },
  {
    kind: 'MaxAssignmentsInWindow',
    rule: hard('inj_max_in_window', { kind: 'MaxAssignmentsInWindow', max: 1, windowDays: 7 }),
    defect: 'two assignments inside one rolling window where the rule permits one',
    breached: world([
      row({ snapshotId: 'w1', date: '2031-06-03' }),
      row({ snapshotId: 'w2', date: '2031-06-07' }),
    ]),
    satisfied: world([
      row({ snapshotId: 'w1', date: '2031-06-03' }),
      row({ snapshotId: 'w2', date: '2031-06-14' }),
    ]),
    expectedTerms: [M_A, '2031-06-03'],
  },
  {
    kind: 'CallSpacing',
    rule: hard('inj_call_spacing', { kind: 'CallSpacing', minDaysBetweenCalls: 5 }),
    defect: 'two on-call shifts closer together than the rule allows',
    breached: world([
      row({ snapshotId: 'k1', date: '2031-06-03', shiftTypeCode: 'CALL', isOnCall: true }),
      row({ snapshotId: 'k2', date: '2031-06-05', shiftTypeCode: 'CALL', isOnCall: true }),
    ]),
    satisfied: world([
      row({ snapshotId: 'k1', date: '2031-06-03', shiftTypeCode: 'CALL', isOnCall: true }),
      row({ snapshotId: 'k2', date: '2031-06-12', shiftTypeCode: 'CALL', isOnCall: true }),
    ]),
    expectedTerms: [M_A, '2031-06-05', '2031-06-03'],
  },
  {
    kind: 'AvoidDate',
    rule: hard('inj_avoid_date', { kind: 'AvoidDate', date: '2031-06-05' }),
    defect: 'an assignment on a date the rule forbids outright',
    breached: world([row({ snapshotId: 'a1', date: '2031-06-05' })]),
    satisfied: world([row({ snapshotId: 'a1', date: '2031-06-06' })]),
    expectedTerms: [M_A, '2031-06-05'],
  },
  {
    kind: 'RequiredCount',
    rule: hard('inj_required_count', { kind: 'RequiredCount', count: 1 }, COVERAGE_SCOPE),
    defect: 'a required date × shift-type cell left entirely unstaffed',
    breached: world([row({ snapshotId: 'rc1', date: '2031-06-01' })], {
      horizon: COVERAGE_WINDOW,
    }),
    satisfied: world(
      [row({ snapshotId: 'rc1', date: '2031-06-01' }), row({ snapshotId: 'rc2', date: '2031-06-02' })],
      { horizon: COVERAGE_WINDOW },
    ),
    expectedTerms: ['2031-06-02', 'DAY'],
  },
  {
    kind: 'MinCoverage',
    rule: hard('inj_min_coverage', { kind: 'MinCoverage', min: 2 }, COVERAGE_SCOPE),
    defect: 'a cell staffed below the floor this rule sets',
    breached: world(
      [row({ snapshotId: 'mn1', date: '2031-06-01' }), row({ snapshotId: 'mn2', date: '2031-06-02' })],
      { horizon: COVERAGE_WINDOW },
    ),
    satisfied: world(
      [
        row({ snapshotId: 'mn1', date: '2031-06-01' }),
        row({ snapshotId: 'mn1b', date: '2031-06-01', membershipId: M_B }),
        row({ snapshotId: 'mn2', date: '2031-06-02' }),
        row({ snapshotId: 'mn2b', date: '2031-06-02', membershipId: M_B }),
      ],
      { horizon: COVERAGE_WINDOW },
    ),
    expectedTerms: ['2031-06-01', 'DAY'],
  },
  {
    kind: 'MaxCoverage',
    rule: hard('inj_max_coverage', { kind: 'MaxCoverage', max: 1 }, COVERAGE_SCOPE),
    defect: 'a cell staffed above the ceiling this rule sets',
    breached: world(
      [
        row({ snapshotId: 'mx1', date: '2031-06-01' }),
        row({ snapshotId: 'mx1b', date: '2031-06-01', membershipId: M_B }),
        row({ snapshotId: 'mx2', date: '2031-06-02' }),
      ],
      { horizon: COVERAGE_WINDOW },
    ),
    satisfied: world(
      [row({ snapshotId: 'mx1', date: '2031-06-01' }), row({ snapshotId: 'mx2', date: '2031-06-02' })],
      { horizon: COVERAGE_WINDOW },
    ),
    expectedTerms: ['2031-06-01', 'DAY'],
  },
  {
    kind: 'MemberOfStaffGroup',
    rule: hard('inj_member_of_staff_group', {
      kind: 'MemberOfStaffGroup',
      staffGroup: 'sg-injected',
    }),
    defect: 'an assignee who is not a member of the staff group the rule restricts to',
    breached: world([row({ snapshotId: 'sg1', date: '2031-06-05' })], {
      staffGroups: { 'sg-injected': [M_B] },
    }),
    satisfied: world([row({ snapshotId: 'sg1', date: '2031-06-05' })], {
      staffGroups: { 'sg-injected': [M_A, M_B] },
    }),
    expectedTerms: [M_A, 'sg-injected'],
  },
  {
    kind: 'ValidGroupRestriction',
    rule: hard('inj_valid_group', { kind: 'ValidGroupRestriction', validGroup: 'vg-injected' }),
    defect: 'an assignment on a shift type the valid group does not admit',
    breached: world([row({ snapshotId: 'vg1', date: '2031-06-05' })], {
      validGroups: { 'vg-injected': ['NIGHT'] },
    }),
    satisfied: world([row({ snapshotId: 'vg1', date: '2031-06-05' })], {
      validGroups: { 'vg-injected': ['DAY'] },
    }),
    expectedTerms: ['vg-injected', '2031-06-05'],
  },
  {
    kind: 'PickPositionRestriction',
    rule: hard('inj_pick_position', {
      kind: 'PickPositionRestriction',
      allowedPickPositions: [1, 2],
    }),
    defect: 'a draft pick taken at a position the rule does not allow',
    breached: world([row({ snapshotId: 'pp1', date: '2031-06-05', pickPosition: 7 })]),
    satisfied: world([row({ snapshotId: 'pp1', date: '2031-06-05', pickPosition: 2 })]),
    expectedTerms: ['2031-06-05', '7'],
  },
  {
    kind: 'WeekdayFteLimit',
    rule: hard('inj_weekday_fte', { kind: 'WeekdayFteLimit', weekday: 'mon', fteFraction: 0.4 }),
    defect: 'more Mondays worked than the weekday FTE fraction admits over the horizon',
    breached: world([
      row({ snapshotId: 'f1', date: '2031-06-02' }),
      row({ snapshotId: 'f2', date: '2031-06-09' }),
      row({ snapshotId: 'f3', date: '2031-06-16' }),
    ]),
    satisfied: world([
      row({ snapshotId: 'f1', date: '2031-06-02' }),
      row({ snapshotId: 'f2', date: '2031-06-09' }),
    ]),
    expectedTerms: [M_A, 'mon'],
  },
  {
    kind: 'NoAdjacent',
    rule: hard('inj_no_adjacent', { kind: 'NoAdjacent', shiftTypeA: 'DAY', shiftTypeB: 'NIGHT' }),
    defect: 'the forbidden pair worked on consecutive calendar dates',
    breached: world([
      row({ snapshotId: 'n1', date: '2031-06-10', shiftTypeCode: 'DAY' }),
      row({ snapshotId: 'n2', date: '2031-06-11', shiftTypeCode: 'NIGHT' }),
    ]),
    satisfied: world([
      row({ snapshotId: 'n1', date: '2031-06-10', shiftTypeCode: 'DAY' }),
      row({ snapshotId: 'n2', date: '2031-06-12', shiftTypeCode: 'NIGHT' }),
    ]),
    expectedTerms: [M_A, '2031-06-10'],
  },
  {
    kind: 'ForbiddenSequence',
    rule: hard('inj_forbidden_sequence', {
      kind: 'ForbiddenSequence',
      sequence: ['DAY', 'NIGHT'],
    }),
    defect: 'the forbidden ordered run worked on consecutive dates',
    breached: world([
      row({ snapshotId: 's1', date: '2031-06-14', shiftTypeCode: 'DAY' }),
      row({ snapshotId: 's2', date: '2031-06-15', shiftTypeCode: 'NIGHT' }),
    ]),
    satisfied: world([
      row({ snapshotId: 's1', date: '2031-06-14', shiftTypeCode: 'NIGHT' }),
      row({ snapshotId: 's2', date: '2031-06-15', shiftTypeCode: 'DAY' }),
    ]),
    expectedTerms: [M_A, '2031-06-14'],
  },
  {
    kind: 'LinkedShifts',
    rule: hard('inj_linked_shifts', { kind: 'LinkedShifts', shiftTypes: ['DAY', 'NIGHT'] }),
    defect: 'one half of a linked pair worked without the other, on the same date',
    breached: world([row({ snapshotId: 'l1', date: '2031-06-18', shiftTypeCode: 'DAY' })]),
    satisfied: world([
      row({ snapshotId: 'l1', date: '2031-06-18', shiftTypeCode: 'DAY' }),
      row({ snapshotId: 'l2', date: '2031-06-18', shiftTypeCode: 'NIGHT' }),
    ]),
    expectedTerms: [M_A, '2031-06-18'],
  },
  {
    kind: 'ImpliesAssignment',
    rule: hard('inj_implies_assignment', {
      kind: 'ImpliesAssignment',
      ifShiftType: 'DAY',
      thenShiftType: 'NIGHT',
    }),
    defect: 'the antecedent shift worked without the shift it implies',
    breached: world([row({ snapshotId: 'i1', date: '2031-06-20', shiftTypeCode: 'DAY' })]),
    satisfied: world([
      row({ snapshotId: 'i1', date: '2031-06-20', shiftTypeCode: 'DAY' }),
      row({ snapshotId: 'i2', date: '2031-06-20', shiftTypeCode: 'NIGHT' }),
    ]),
    expectedTerms: [M_A, '2031-06-20'],
  },
  {
    kind: 'MutuallyExclusive',
    rule: hard('inj_mutually_exclusive', {
      kind: 'MutuallyExclusive',
      shiftTypes: ['DAY', 'NIGHT'],
    }),
    defect: 'two mutually exclusive shift types held by one participant on one date',
    breached: world([
      row({ snapshotId: 'e1', date: '2031-06-21', shiftTypeCode: 'DAY' }),
      row({ snapshotId: 'e2', date: '2031-06-21', shiftTypeCode: 'NIGHT' }),
    ]),
    satisfied: world([
      row({ snapshotId: 'e1', date: '2031-06-21', shiftTypeCode: 'DAY' }),
      row({ snapshotId: 'e2', date: '2031-06-22', shiftTypeCode: 'NIGHT' }),
    ]),
    expectedTerms: [M_A, '2031-06-21'],
  },
  {
    kind: 'FixedAssignment',
    rule: hard('inj_fixed_assignment', {
      kind: 'FixedAssignment',
      assignmentIdentity: 'ai-fixed',
    }),
    defect: 'a pinned fixed input the candidate silently dropped',
    breached: world([], { prior: FIXED_PRIOR }),
    satisfied: world(
      [row({ snapshotId: 'x1', date: '2031-06-24', assignmentIdentityId: 'ai-fixed' })],
      { prior: FIXED_PRIOR },
    ),
    expectedTerms: [M_A, '2031-06-24'],
  },
  {
    kind: 'ProtectedRange',
    rule: hard('inj_protected_range', {
      kind: 'ProtectedRange',
      from: '2031-06-01',
      to: '2031-06-15',
    }),
    defect: 'an assignment inside a protected date range removed by the rebuild',
    breached: world(
      [row({ snapshotId: 'p1', date: '2031-06-25', assignmentIdentityId: 'ai-outside' })],
      { prior: RANGE_PRIOR },
    ),
    satisfied: world(
      [row({ snapshotId: 'p2', date: '2031-06-10', assignmentIdentityId: 'ai-inside' })],
      { prior: RANGE_PRIOR },
    ),
    expectedTerms: [M_A, '2031-06-10'],
  },
  {
    kind: 'PatternRule',
    rule: hard('inj_pattern_rule', {
      kind: 'PatternRule',
      trigger: 'DAY',
      daysOfWeek: ['mon'],
      segments: [{ offsetDays: 1, shiftType: 'NIGHT' }],
    }),
    defect: 'a pattern trigger worked without the segment the pattern requires',
    breached: world([row({ snapshotId: 't1', date: '2031-06-09', shiftTypeCode: 'DAY' })]),
    satisfied: world([
      row({ snapshotId: 't1', date: '2031-06-09', shiftTypeCode: 'DAY' }),
      row({ snapshotId: 't2', date: '2031-06-10', shiftTypeCode: 'NIGHT' }),
    ]),
    expectedTerms: [M_A, '2031-06-09', 'NIGHT'],
  },
  {
    kind: 'AlternatingWeek',
    rule: hard('inj_alternating_week', {
      kind: 'AlternatingWeek',
      onShiftType: 'DAY',
      cycleWeeks: 2,
    }),
    defect: 'the alternating shift worked in two distinct week classes of one cycle',
    breached: world([
      row({ snapshotId: 'y1', date: '2031-06-02' }),
      row({ snapshotId: 'y2', date: '2031-06-09' }),
    ]),
    satisfied: world([
      row({ snapshotId: 'y1', date: '2031-06-02' }),
      row({ snapshotId: 'y2', date: '2031-06-16' }),
    ]),
    expectedTerms: [M_A, 'DAY'],
  },
];

/**
 * The kinds this table injects, as a set — so the scenario can compare it
 * against `EVALUATED_HARD_RULE_KINDS` rather than against a hand-written number.
 */
export const INJECTED_KINDS: ReadonlySet<string> = new Set(
  HARD_KIND_INJECTIONS.map((injection) => injection.kind),
);

/** Every evaluated kind this table does NOT inject. Must be empty. */
export function uninjectedKinds(): readonly string[] {
  return EVALUATED_HARD_RULE_KINDS.filter((kind) => !INJECTED_KINDS.has(kind));
}
