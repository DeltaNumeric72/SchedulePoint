import {
  RULE_NODE_KINDS,
  RULE_SCHEMA_VERSION,
  type Rule,
  type RuleNode,
  type RuleNodeKind,
} from '../../src/rules/index.js';

/**
 * One valid instance of every node in the closed set. Keyed by kind so a test
 * can assert coverage: if a node is added to {@link RULE_NODE_KINDS} without an
 * entry here, `everyNodeSample()` throws — the samples cannot silently miss one.
 */
const SAMPLES: Record<RuleNodeKind, RuleNode> = {
  RequiredCount: { kind: 'RequiredCount', count: 2 },
  MinCoverage: { kind: 'MinCoverage', min: 1 },
  MaxCoverage: { kind: 'MaxCoverage', max: 3 },
  RequiresQualification: {
    kind: 'RequiresQualification',
    qualification: 'acls',
    validAt: 'shift_date',
  },
  MemberOfStaffGroup: { kind: 'MemberOfStaffGroup', staffGroup: 'senior' },
  ValidGroupRestriction: { kind: 'ValidGroupRestriction', validGroup: 'icu_pool' },
  PickPositionRestriction: { kind: 'PickPositionRestriction', allowedPickPositions: [0, 1, 2] },
  MaxAssignmentsInWindow: { kind: 'MaxAssignmentsInWindow', max: 5, windowDays: 7 },
  WeekdayFteLimit: { kind: 'WeekdayFteLimit', weekday: 'mon', fteFraction: 0.5 },
  WorkPercentageTarget: { kind: 'WorkPercentageTarget', targetPercentage: 80 },
  MaxConsecutive: { kind: 'MaxConsecutive', maxDays: 4 },
  MinimumRestBetween: { kind: 'MinimumRestBetween', minHours: 11 },
  CallSpacing: { kind: 'CallSpacing', minDaysBetweenCalls: 3 },
  NoAdjacent: { kind: 'NoAdjacent', shiftTypeA: 'night', shiftTypeB: 'day' },
  ForbiddenSequence: { kind: 'ForbiddenSequence', sequence: ['night', 'day'] },
  PatternRule: {
    kind: 'PatternRule',
    trigger: 'call',
    daysOfWeek: ['fri', 'sat'],
    segments: [
      { offsetDays: 0, shiftType: 'call' },
      { offsetDays: 1, shiftType: 'post_call' },
    ],
  },
  AlternatingWeek: { kind: 'AlternatingWeek', onShiftType: 'clinic', cycleWeeks: 2 },
  TemplateAdherence: { kind: 'TemplateAdherence', template: 'four_week_block', cycleWeeks: 4 },
  LinkedShifts: { kind: 'LinkedShifts', shiftTypes: ['am', 'pm'] },
  ImpliesAssignment: { kind: 'ImpliesAssignment', ifShiftType: 'day', thenShiftType: 'evening' },
  MutuallyExclusive: { kind: 'MutuallyExclusive', shiftTypes: ['day', 'night'] },
  RequestHonoured: { kind: 'RequestHonoured', requestType: 'day_off' },
  ShiftPreference: { kind: 'ShiftPreference', shiftType: 'clinic', strength: 'prefer' },
  AvoidDate: { kind: 'AvoidDate', date: '2026-12-25' },
  FairnessBalance: { kind: 'FairnessBalance', metric: 'weekend_load', normalisation: 'per_fte' },
  CreditDistribution: { kind: 'CreditDistribution', metric: 'credits' },
  StaffOverLocumPriority: { kind: 'StaffOverLocumPriority', windowDays: 30 },
  LocumRestriction: { kind: 'LocumRestriction', restriction: 'locum_last_resort' },
  FixedAssignment: { kind: 'FixedAssignment', assignmentIdentity: 'period-01-day-m01' },
  ProtectedRange: { kind: 'ProtectedRange', from: '2026-01-01', to: '2026-01-14' },
};

export function nodeSample(kind: RuleNodeKind): RuleNode {
  return SAMPLES[kind];
}

/** Every node in {@link RULE_NODE_KINDS}, in declared order. */
export function everyNodeSample(): RuleNode[] {
  return RULE_NODE_KINDS.map((kind) => {
    const sample = SAMPLES[kind];
    if (sample === undefined) throw new Error(`No sample node for kind '${kind}'`);
    return sample;
  });
}

/** Wrap a node into a valid HARD rule with a synthetic key. */
export function hardRuleFor(kind: RuleNodeKind): Rule {
  return {
    ruleKey: `hard_${kind.toLowerCase()}`,
    name: `Hard ${kind}`,
    ruleSchemaVersion: RULE_SCHEMA_VERSION,
    classification: 'HARD',
    scope: {},
    predicate: nodeSample(kind),
  };
}

/** Wrap a node into a valid SOFT rule with a synthetic key and weight. */
export function softRuleFor(kind: RuleNodeKind, weight = 10): Rule {
  return {
    ruleKey: `soft_${kind.toLowerCase()}`,
    name: `Soft ${kind}`,
    ruleSchemaVersion: RULE_SCHEMA_VERSION,
    classification: 'SOFT',
    weight,
    scope: {},
    predicate: nodeSample(kind),
  };
}
