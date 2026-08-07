/**
 * `@schedulepoint/domain` rules — the typed scheduling-rule AST, its pure
 * validation, deterministic serialization, and the compiler to the canonical
 * solver-input form (OPUS-M3-002, SPEC-04 §3). Dependency-free: no `zod`, no I/O.
 * The wire shapes are in `@schedulepoint/contracts`; the database half of the
 * hard/soft invariant is the `rules` CHECK (doc 06 §3.2). No solver code — M4.
 */

export {
  FAIRNESS_METRICS,
  FAIRNESS_NORMALISATIONS,
  LOCUM_RESTRICTIONS,
  PREFERENCE_STRENGTHS,
  RULE_CLASSIFICATIONS,
  RULE_NODE_KINDS,
  RULE_SCHEMA_VERSION,
  RULE_WEEKDAYS,
  assertKindsCoverUnion,
  isRuleNodeKind,
  ruleSensitivity,
  type AlternatingWeekNode,
  type AvoidDateNode,
  type CallSpacingNode,
  type CreditDistributionNode,
  type DateRange,
  type FairnessBalanceNode,
  type FairnessMetric,
  type FairnessNormalisation,
  type FixedAssignmentNode,
  type ForbiddenSequenceNode,
  type HardRule,
  type ImpliesAssignmentNode,
  type LinkedShiftsNode,
  type LocumRestriction,
  type LocumRestrictionNode,
  type MaxAssignmentsInWindowNode,
  type MaxConsecutiveNode,
  type MaxCoverageNode,
  type MemberOfStaffGroupNode,
  type MinCoverageNode,
  type MinimumRestBetweenNode,
  type MutuallyExclusiveNode,
  type NoAdjacentNode,
  type PatternRuleNode,
  type PatternSegment,
  type PickPositionRestrictionNode,
  type PreferenceStrength,
  type ProtectedRangeNode,
  type RequestHonouredNode,
  type RequiredCountNode,
  type RequiresQualificationNode,
  type Rule,
  type RuleClassification,
  type RuleNode,
  type RuleNodeKind,
  type RuleScope,
  type RuleSensitivity,
  type RuleSet,
  type RuleWeekday,
  type ShiftPreferenceNode,
  type SoftRule,
  type StaffOverLocumPriorityNode,
  type TemplateAdherenceNode,
  type ValidGroupRestrictionNode,
  type WeekdayFteLimitNode,
  type WorkPercentageTargetNode,
} from './ast.js';

export {
  RULE_NODE_KEYS,
  isValidRule,
  nodeProblems,
  ruleProblems,
  scopeProblems,
  type RuleProblem,
} from './validate.js';

export { canonicalize, canonicalStringify, parseJson, type Json } from './serialize.js';

export {
  COMPILER_VERSION,
  compileNode,
  compileRule,
  compileRuleSet,
  compileRuleSetToCanonicalString,
  type CompiledRule,
  type CompiledRuleSet,
} from './compile.js';

export {
  EVALUATED_HARD_RULE_KINDS,
  NOT_EVALUABLE_REASONS,
  blocksPublication,
  dayNumber,
  evaluateHardRules,
  isEvaluatedHardRuleKind,
  type CheckedAssignment,
  type CheckedVersion,
  type EvaluatedHardRuleKind,
  type HardRuleFinding,
  type HardRuleFindingKind,
  type QualificationFacts,
} from './hard-rule-check.js';
