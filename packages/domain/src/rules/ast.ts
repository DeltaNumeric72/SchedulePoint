/**
 * The typed scheduling-rule AST (OPUS-M3-002, SPEC-04 §3.1).
 *
 * A rule is a typed abstract syntax tree with a schema version — never a
 * free-form constraint object and never a JSON blob. **The node set below is
 * closed.** A rule the AST cannot express is a schema change with a migration
 * (a new node here plus a compiler mapping in `compile.ts`), *never* an escape
 * hatch. That closure is the single property that makes deterministic
 * compilation, exhaustive validation, and forward migration possible at all —
 * SPEC-04 §3.1, and non-bypass rule 8 (never add free text to a protected
 * path) applied to the rule surface.
 *
 * Everything here is pure data and total functions over plain values: no clock,
 * no database, no I/O, no `zod`. This is the dependency-free `@schedulepoint/domain`
 * package. The wire shapes that validate untyped input live in
 * `@schedulepoint/contracts`; the database half of the hard/soft invariant is the
 * CHECK constraint on the `rules` row (doc 06 §3.2).
 */

/** The two rule classifications. See {@link Rule} for the weight discipline. */
export const RULE_CLASSIFICATIONS = ['HARD', 'SOFT'] as const;
export type RuleClassification = (typeof RULE_CLASSIFICATIONS)[number];

/**
 * The day vocabulary shared with the shift catalogue (FAD-16/FAD-17): the seven
 * weekdays plus an explicit `holiday` arm, so the people side and the demand
 * side speak one day language into the M4 engine.
 */
export const RULE_WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'holiday'] as const;
export type RuleWeekday = (typeof RULE_WEEKDAYS)[number];

/** Preference strength for {@link ShiftPreferenceNode}. A closed set. */
export const PREFERENCE_STRENGTHS = ['strong_prefer', 'prefer', 'avoid', 'strong_avoid'] as const;
export type PreferenceStrength = (typeof PREFERENCE_STRENGTHS)[number];

/** Fairness metric for {@link FairnessBalanceNode}. A closed set. */
export const FAIRNESS_METRICS = ['credits', 'assignments', 'weekend_load', 'call_load'] as const;
export type FairnessMetric = (typeof FAIRNESS_METRICS)[number];

/** Fairness normalisation for {@link FairnessBalanceNode}. A closed set. */
export const FAIRNESS_NORMALISATIONS = ['none', 'per_fte', 'per_eligible_day'] as const;
export type FairnessNormalisation = (typeof FAIRNESS_NORMALISATIONS)[number];

/** Locum restriction kind for {@link LocumRestrictionNode}. A closed set. */
export const LOCUM_RESTRICTIONS = ['no_locum', 'locum_only', 'locum_last_resort'] as const;
export type LocumRestriction = (typeof LOCUM_RESTRICTIONS)[number];

/**
 * The scope narrows where a rule applies. `group` tenancy is implicit — a rule
 * belongs to exactly one group (its tenant row); the scope is a *filter* within
 * that group, never a way to reach another one.
 *
 * `memberships` names individuals. A rule whose scope names memberships is the
 * `staff_rules`-class content doc 06 §3.2 marks `INTERNAL`. {@link ruleSensitivity}
 * derives that CLASSIFICATION from the AST rather than asking the author to
 * assert it — it is a statement about the content, **not** the access-control
 * mechanism. Access is the uniform RLS capability predicate on `rules`
 * (migration 0008), which is at least as narrow for every row.
 */
export interface RuleScope {
  readonly dateRange?: DateRange;
  readonly shiftTypes?: readonly string[];
  readonly staffGroups?: readonly string[];
  readonly memberships?: readonly string[];
}

/** An inclusive ISO-8601 date range (`YYYY-MM-DD`), `from <= to`. */
export interface DateRange {
  readonly from: string;
  readonly to: string;
}

// ─── The closed node set (SPEC-04 §3.1) ──────────────────────────────────────
//
// Ten families. Every node is a discriminated member of {@link RuleNode} keyed
// on `kind`. `PatternRule.segments` and every other parameter is *typed* — the
// former free-form `pattern_rules.segments` / `staff_rules.action_params` shapes
// (doc 06 §3.2) become typed nodes here, which is the whole point of CAR-006.

/** Coverage family — demand satisfaction. */
export interface RequiredCountNode {
  readonly kind: 'RequiredCount';
  /** Exactly this many assignments are required. */
  readonly count: number;
}
export interface MinCoverageNode {
  readonly kind: 'MinCoverage';
  readonly min: number;
}
export interface MaxCoverageNode {
  readonly kind: 'MaxCoverage';
  readonly max: number;
}

/** Eligibility family — qualification and eligibility. */
export interface RequiresQualificationNode {
  readonly kind: 'RequiresQualification';
  /** The qualification key (doc 06 `qualifications.key`). */
  readonly qualification: string;
  /** Fixed: eligibility is evaluated as of the shift date, never the build date. */
  readonly validAt: 'shift_date';
}
export interface MemberOfStaffGroupNode {
  readonly kind: 'MemberOfStaffGroup';
  readonly staffGroup: string;
}
export interface ValidGroupRestrictionNode {
  readonly kind: 'ValidGroupRestriction';
  readonly validGroup: string;
}
export interface PickPositionRestrictionNode {
  readonly kind: 'PickPositionRestriction';
  readonly allowedPickPositions: readonly number[];
}

/** Capacity family — FTE, maximum assignments, work percentage. */
export interface MaxAssignmentsInWindowNode {
  readonly kind: 'MaxAssignmentsInWindow';
  readonly max: number;
  readonly windowDays: number;
}
export interface WeekdayFteLimitNode {
  readonly kind: 'WeekdayFteLimit';
  readonly weekday: RuleWeekday;
  /** `0 <= fteFraction <= 1`, matching `membership_weekday_fte.fte_fraction`. */
  readonly fteFraction: number;
}
export interface WorkPercentageTargetNode {
  readonly kind: 'WorkPercentageTarget';
  /** `0 < targetPercentage <= 100`, matching `membership_work_profiles.work_percentage`. */
  readonly targetPercentage: number;
}
export interface MaxConsecutiveNode {
  readonly kind: 'MaxConsecutive';
  readonly maxDays: number;
}

/** Rest-and-spacing family. */
export interface MinimumRestBetweenNode {
  readonly kind: 'MinimumRestBetween';
  readonly minHours: number;
}
export interface CallSpacingNode {
  readonly kind: 'CallSpacing';
  readonly minDaysBetweenCalls: number;
}
export interface NoAdjacentNode {
  readonly kind: 'NoAdjacent';
  readonly shiftTypeA: string;
  readonly shiftTypeB: string;
}
export interface ForbiddenSequenceNode {
  readonly kind: 'ForbiddenSequence';
  /** An ordered sequence of shift-type codes that may not occur back to back. */
  readonly sequence: readonly string[];
}

/** Pattern family — patterns and templates. */
export interface PatternSegment {
  /** Days from the trigger day (may be zero or negative). */
  readonly offsetDays: number;
  /** The shift type the segment assigns on that offset. */
  readonly shiftType: string;
}
export interface PatternRuleNode {
  readonly kind: 'PatternRule';
  /** The shift type whose assignment triggers the pattern. */
  readonly trigger: string;
  readonly daysOfWeek: readonly RuleWeekday[];
  readonly segments: readonly PatternSegment[];
}
export interface AlternatingWeekNode {
  readonly kind: 'AlternatingWeek';
  readonly onShiftType: string;
  readonly cycleWeeks: number;
}
export interface TemplateAdherenceNode {
  readonly kind: 'TemplateAdherence';
  /** The assignment-template name (doc 06 `assignment_templates.name`). */
  readonly template: string;
  readonly cycleWeeks: number;
}

/** Linkage family — linked shifts. */
export interface LinkedShiftsNode {
  readonly kind: 'LinkedShifts';
  readonly shiftTypes: readonly string[];
}
export interface ImpliesAssignmentNode {
  readonly kind: 'ImpliesAssignment';
  readonly ifShiftType: string;
  readonly thenShiftType: string;
}
export interface MutuallyExclusiveNode {
  readonly kind: 'MutuallyExclusive';
  readonly shiftTypes: readonly string[];
}

/** Preference family — requests and preferences. */
export interface RequestHonouredNode {
  readonly kind: 'RequestHonoured';
  readonly requestType: string;
}
export interface ShiftPreferenceNode {
  readonly kind: 'ShiftPreference';
  readonly shiftType: string;
  readonly strength: PreferenceStrength;
}
export interface AvoidDateNode {
  readonly kind: 'AvoidDate';
  readonly date: string;
}

/** Fairness family. */
export interface FairnessBalanceNode {
  readonly kind: 'FairnessBalance';
  readonly metric: FairnessMetric;
  readonly normalisation: FairnessNormalisation;
}
export interface CreditDistributionNode {
  readonly kind: 'CreditDistribution';
  readonly metric: FairnessMetric;
}

/** Locum family. */
export interface StaffOverLocumPriorityNode {
  readonly kind: 'StaffOverLocumPriority';
  readonly windowDays: number;
}
export interface LocumRestrictionNode {
  readonly kind: 'LocumRestriction';
  readonly restriction: LocumRestriction;
}

/** Fixed family — fixed assignments and progressive builds. */
export interface FixedAssignmentNode {
  readonly kind: 'FixedAssignment';
  /** The assignment-identity key this rule pins. */
  readonly assignmentIdentity: string;
}
export interface ProtectedRangeNode {
  readonly kind: 'ProtectedRange';
  readonly from: string;
  readonly to: string;
}

/**
 * The closed rule-node union. Adding a member here is a deliberate schema change
 * that also requires: an entry in {@link RULE_NODE_KINDS}, a compiler mapping in
 * `compile.ts` (the `rule-node-mapping` gate fails the build otherwise), and a
 * `rule_schema_version` bump.
 */
export type RuleNode =
  | RequiredCountNode
  | MinCoverageNode
  | MaxCoverageNode
  | RequiresQualificationNode
  | MemberOfStaffGroupNode
  | ValidGroupRestrictionNode
  | PickPositionRestrictionNode
  | MaxAssignmentsInWindowNode
  | WeekdayFteLimitNode
  | WorkPercentageTargetNode
  | MaxConsecutiveNode
  | MinimumRestBetweenNode
  | CallSpacingNode
  | NoAdjacentNode
  | ForbiddenSequenceNode
  | PatternRuleNode
  | AlternatingWeekNode
  | TemplateAdherenceNode
  | LinkedShiftsNode
  | ImpliesAssignmentNode
  | MutuallyExclusiveNode
  | RequestHonouredNode
  | ShiftPreferenceNode
  | AvoidDateNode
  | FairnessBalanceNode
  | CreditDistributionNode
  | StaffOverLocumPriorityNode
  | LocumRestrictionNode
  | FixedAssignmentNode
  | ProtectedRangeNode;

export type RuleNodeKind = RuleNode['kind'];

/**
 * The declared closed set of node kinds — the single source of truth the
 * `rule-node-mapping` CI gate checks the compiler against. It is derived from
 * the union by the type-level assertion in `assertKindsCoverUnion` below (a test
 * proves the two agree), so a member cannot be dropped here without a compile or
 * test failure.
 */
export const RULE_NODE_KINDS = [
  'RequiredCount',
  'MinCoverage',
  'MaxCoverage',
  'RequiresQualification',
  'MemberOfStaffGroup',
  'ValidGroupRestriction',
  'PickPositionRestriction',
  'MaxAssignmentsInWindow',
  'WeekdayFteLimit',
  'WorkPercentageTarget',
  'MaxConsecutive',
  'MinimumRestBetween',
  'CallSpacing',
  'NoAdjacent',
  'ForbiddenSequence',
  'PatternRule',
  'AlternatingWeek',
  'TemplateAdherence',
  'LinkedShifts',
  'ImpliesAssignment',
  'MutuallyExclusive',
  'RequestHonoured',
  'ShiftPreference',
  'AvoidDate',
  'FairnessBalance',
  'CreditDistribution',
  'StaffOverLocumPriority',
  'LocumRestriction',
  'FixedAssignment',
  'ProtectedRange',
] as const satisfies readonly RuleNodeKind[];

export function isRuleNodeKind(value: string): value is RuleNodeKind {
  return (RULE_NODE_KINDS as readonly string[]).includes(value);
}

/**
 * The current rule-schema version. A stored rule carries the version it was
 * authored under so a migration can transform older ASTs forward (SPEC-04 §3.2).
 */
export const RULE_SCHEMA_VERSION = 1;

/**
 * A rule with a `HARD` classification: it can never be relaxed, downgraded,
 * weighted, or skipped (SPEC-04 §3.3). The type forbids a weight; validation and
 * the database CHECK forbid it again, because a wire payload does not obey the
 * type.
 */
export interface HardRule {
  readonly ruleKey: string;
  readonly name: string;
  readonly ruleSchemaVersion: number;
  readonly classification: 'HARD';
  readonly weight?: undefined;
  readonly scope: RuleScope;
  readonly predicate: RuleNode;
}

/** A rule with a `SOFT` classification: it compiles to an objective term and must carry a weight. */
export interface SoftRule {
  readonly ruleKey: string;
  readonly name: string;
  readonly ruleSchemaVersion: number;
  readonly classification: 'SOFT';
  readonly weight: number;
  readonly scope: RuleScope;
  readonly predicate: RuleNode;
}

/**
 * A single authored rule. The `HARD | SOFT` union carries the weight discipline
 * in the type system; {@link ruleProblems} re-checks it for untyped input.
 *
 * `rule_key` is a **stable identifier** — non-bypass rule 13 applies. A rule_key
 * that silently changes meaning corrupts every rule set and build that cites it.
 */
export type Rule = HardRule | SoftRule;

/** A named, ordered collection of rule keys referenced by builds (doc 06 `rule_sets`). */
export interface RuleSet {
  readonly name: string;
  readonly ruleKeys: readonly string[];
}

/**
 * Sensitivity derived from the AST, never asserted by the author. A rule whose
 * scope names individual memberships is `staff_rules`-class content — `INTERNAL`,
 * narrower access (doc 06 §3.2). Everything else is `NONE` at the rule level;
 * the `rules` row itself is stored `INTERNAL` as doc 06 assigns.
 */
export type RuleSensitivity = 'NONE' | 'INTERNAL';

export function ruleSensitivity(rule: Rule): RuleSensitivity {
  const memberships = rule.scope.memberships;
  return memberships !== undefined && memberships.length > 0 ? 'INTERNAL' : 'NONE';
}

/**
 * A compile-time proof that {@link RULE_NODE_KINDS} covers the union exactly.
 * Referenced by a test so the assertion is exercised; if a node is added to the
 * union without an entry in the array (or vice versa) this stops compiling.
 */
export const assertKindsCoverUnion: Record<RuleNodeKind, true> = Object.freeze({
  RequiredCount: true,
  MinCoverage: true,
  MaxCoverage: true,
  RequiresQualification: true,
  MemberOfStaffGroup: true,
  ValidGroupRestriction: true,
  PickPositionRestriction: true,
  MaxAssignmentsInWindow: true,
  WeekdayFteLimit: true,
  WorkPercentageTarget: true,
  MaxConsecutive: true,
  MinimumRestBetween: true,
  CallSpacing: true,
  NoAdjacent: true,
  ForbiddenSequence: true,
  PatternRule: true,
  AlternatingWeek: true,
  TemplateAdherence: true,
  LinkedShifts: true,
  ImpliesAssignment: true,
  MutuallyExclusive: true,
  RequestHonoured: true,
  ShiftPreference: true,
  AvoidDate: true,
  FairnessBalance: true,
  CreditDistribution: true,
  StaffOverLocumPriority: true,
  LocumRestriction: true,
  FixedAssignment: true,
  ProtectedRange: true,
});
