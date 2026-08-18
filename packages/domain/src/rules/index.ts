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

/* OPUS-M4-000C — AST bounds (doc 34 §4-D). The closed node set bounds the SHAPE;
 * these bound the SIZE, and `evaluationCostBound` makes the checker's bound
 * argument a value a test can assert rather than a paragraph. */
export {
  AST_BOUNDS,
  evaluationCostBound,
  maximumEvaluationCostBound,
  nodeBoundProblems,
  scopeBoundProblems,
  scopeCardinality,
  valueDepth,
  type BoundProblem,
} from './bounds.js';

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

/* OPUS-M4-000C — the generated rule-kind registry (doc 34 §4-D). The counts come
 * from the four code sources it composes; the committed artifact
 * `rule-kind-registry.generated.md` is emitted from `renderRuleKindRegistry` and
 * a build-failing gate proves the bytes have not drifted. */
export {
  MILESTONE_OWNERS,
  NATURAL_CLASSIFICATIONS,
  RULE_KIND_FAMILIES,
  RULE_KIND_METADATA,
  RULE_KIND_PENDING_RULINGS,
  buildRuleKindRegistry,
  notEvaluableClassOf,
  renderRuleKindRegistry,
  type EvaluationOwner,
  type MilestoneOwner,
  type NaturalClassification,
  type NotEvaluableClass,
  type PendingRuling,
  type RegistryEntry,
  type RuleKindFamily,
  type RuleKindMetadata,
  type RuleKindRegistry,
} from './registry.js';

/* OPUS-M4-004 — E2. The ONE integer scale and the ONE objective profile (doc 08
 * §3.4, §3.3), the SPEC-04 §7 fairness measurement with its recorded
 * normalisation, and PO-DEC-13's four-class conflict taxonomy. Nothing here
 * carries a band: every band except `hard_violations = 0` is undefined until the
 * benchmark corpus is run at M6 (SPEC-04 §7). */
export {
  E2_OBJECTIVE_PROFILE,
  OBJECTIVE_SCALE,
  UNMAPPED_SOFT_TIER_KEY,
  UNMAPPED_SOFT_TIER_RANK,
  objectiveProfileCanonicalString,
  objectiveTierOf,
  resultsAreComparable,
  scaleWeight,
  type ComparabilityVerdict,
  type ComparableResultFacts,
  type ObjectiveComponentRecord,
  type ObjectiveProfile,
  type ObjectiveTierRecordShape,
  type ObjectiveTierSpec,
} from './objective.js';

export {
  FAIRNESS_NORMALISATION,
  fairnessDispersion,
  fairnessExtremes,
  type FairnessCreditInput,
  type FairnessDispersion,
  type FairnessDispersionInput,
  type FairnessExtremes,
  type FairnessLoad,
  type FairnessNormalisationBasis,
  type FairnessParticipantInput,
} from './quality.js';

/* OPUS-M4-004 repair F-03 — coverage over RK-RULING-01's date × shift-type cell,
 * read by BOTH the §7 metric and the independent checker. */
export {
  demandCoverage,
  type DemandCoverage,
  type DemandOverfill,
  type DemandPlacement,
  type DemandRequirementCell,
  type DemandShortfall,
} from './demand-coverage.js';

export {
  CONFLICT_CLASSES,
  CONFLICT_TAXONOMY,
  compareConflictClasses,
  conflictClassOfDemandShortfall,
  conflictClassOfRejection,
  conflictClassOfStructuralFinding,
  conflictClassOfViolation,
  conflictClassSpec,
  type ConflictClass,
  type ConflictClassSpec,
} from './conflict-taxonomy.js';

export {
  EVALUATED_HARD_RULE_KINDS,
  NOT_EVALUABLE_REASONS,
  blocksPublication,
  dayNumber,
  evaluateHardRules,
  isEvaluatedHardRuleKind,
  /* OPUS-M4-002 — the ruled kinds' seam and its date helper. */
  weekdayOfDate,
  type CandidateFacts,
  type CandidatePriorAssignment,
  type CheckedAssignment,
  type CheckedVersion,
  type EvaluatedHardRuleKind,
  type HardRuleFinding,
  type HardRuleFindingKind,
  type QualificationFacts,
} from './hard-rule-check.js';
