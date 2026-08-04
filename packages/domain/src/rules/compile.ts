/**
 * The rule compiler: `RuleAST → canonical solver-input form` (OPUS-M3-002,
 * SPEC-04 §3.2 / §3.3).
 *
 * This translates a validated rule into a **canonical, versioned, declarative**
 * description of the model element it becomes. It is a total, deterministic data
 * transformation: the same AST plus the same `compilerVersion` yields the same
 * output, byte for byte (proven by {@link canonicalStringify} equality).
 *
 * **This module contains no solver, no optimization, and no assignment
 * generation.** Building the model and solving it is M4 and is prohibited here
 * (non-bypass rule 7, the M4 boundary). The output is the *input contract* the
 * M4 worker will consume — a description, not a search.
 *
 * ## The hard/soft invariant (SPEC-04 §3.3), structural
 *
 * `compileRule` branches on `classification` and there is **no code path from a
 * `HARD` rule to an objective term**: a `HARD` rule always produces
 * `role: 'constraint'` with `weight: null`; a `SOFT` rule always produces
 * `role: 'objective'` with its weight. A property test asserts no `HARD` input
 * ever yields `role: 'objective'`.
 *
 * ## The closed-node CI gate
 *
 * The `rule-node-mapping` gate (`scripts/gates/rule-node-mapping-check.mjs`)
 * reads the `case` labels between the sentinels below and the declared
 * {@link RULE_NODE_KINDS}, and fails the build if they diverge. That is what makes
 * "an AST node type without a compiler mapping fails CI" (SPEC-04 §3.2) a
 * build-time guarantee rather than a runtime surprise — proven by its red case.
 */

import { canonicalStringify, type Json } from './serialize.js';
import type { Rule, RuleNode, RuleNodeKind, RuleScope } from './ast.js';

/** The compiler version. A change to any mapping below bumps this. */
export const COMPILER_VERSION = 1;

/** A compiled rule: one canonical model element. */
export interface CompiledRule {
  readonly ruleKey: string;
  readonly ruleSchemaVersion: number;
  /** `HARD` rules are constraints; `SOFT` rules are objective terms. Never crossed. */
  readonly role: 'constraint' | 'objective';
  readonly kind: RuleNodeKind;
  /** The canonical model-element name the M4 worker maps to a solver construct. */
  readonly modelElement: string;
  /** `null` for a `HARD` constraint; the weight for a `SOFT` objective term. */
  readonly weight: number | null;
  readonly scope: CompiledScope;
  readonly params: Json;
}

/** A rule set compiled to its canonical solver-input form. */
export interface CompiledRuleSet {
  readonly compilerVersion: number;
  readonly ruleSchemaVersion: number;
  readonly elements: readonly CompiledRule[];
}

interface CompiledScope {
  readonly dateRange: { readonly from: string; readonly to: string } | null;
  readonly shiftTypes: readonly string[];
  readonly staffGroups: readonly string[];
  readonly memberships: readonly string[];
}

function compileScope(scope: RuleScope): CompiledScope {
  return {
    dateRange:
      scope.dateRange === undefined ? null : { from: scope.dateRange.from, to: scope.dateRange.to },
    shiftTypes: scope.shiftTypes ?? [],
    staffGroups: scope.staffGroups ?? [],
    memberships: scope.memberships ?? [],
  };
}

/** The declarative element a node compiles to: a stable name plus normalized params. */
interface NodeMapping {
  readonly modelElement: string;
  readonly params: Json;
}

/**
 * Map one node to its canonical model element. Exhaustive over the closed node
 * set; the `default` is unreachable by type and rejected at runtime so a rule
 * the AST somehow smuggled past validation still cannot compile to nothing.
 */
export function compileNode(node: RuleNode): NodeMapping {
  switch (node.kind) {
    /* rule-node-mapping:begin — the gate reads the case labels below */
    case 'RequiredCount':
      return { modelElement: 'coverage.required_count', params: { count: node.count } };
    case 'MinCoverage':
      return { modelElement: 'coverage.min', params: { min: node.min } };
    case 'MaxCoverage':
      return { modelElement: 'coverage.max', params: { max: node.max } };
    case 'RequiresQualification':
      return {
        modelElement: 'eligibility.requires_qualification',
        params: { qualification: node.qualification, validAt: node.validAt },
      };
    case 'MemberOfStaffGroup':
      return {
        modelElement: 'eligibility.member_of_staff_group',
        params: { staffGroup: node.staffGroup },
      };
    case 'ValidGroupRestriction':
      return {
        modelElement: 'eligibility.valid_group_restriction',
        params: { validGroup: node.validGroup },
      };
    case 'PickPositionRestriction':
      return {
        modelElement: 'eligibility.pick_position_restriction',
        params: { allowedPickPositions: [...node.allowedPickPositions] },
      };
    case 'MaxAssignmentsInWindow':
      return {
        modelElement: 'capacity.max_assignments_in_window',
        params: { max: node.max, windowDays: node.windowDays },
      };
    case 'WeekdayFteLimit':
      return {
        modelElement: 'capacity.weekday_fte_limit',
        params: { weekday: node.weekday, fteFraction: node.fteFraction },
      };
    case 'WorkPercentageTarget':
      return {
        modelElement: 'capacity.work_percentage_target',
        params: { targetPercentage: node.targetPercentage },
      };
    case 'MaxConsecutive':
      return { modelElement: 'capacity.max_consecutive', params: { maxDays: node.maxDays } };
    case 'MinimumRestBetween':
      return { modelElement: 'spacing.minimum_rest_between', params: { minHours: node.minHours } };
    case 'CallSpacing':
      return {
        modelElement: 'spacing.call_spacing',
        params: { minDaysBetweenCalls: node.minDaysBetweenCalls },
      };
    case 'NoAdjacent':
      return {
        modelElement: 'spacing.no_adjacent',
        params: { shiftTypeA: node.shiftTypeA, shiftTypeB: node.shiftTypeB },
      };
    case 'ForbiddenSequence':
      return {
        modelElement: 'spacing.forbidden_sequence',
        params: { sequence: [...node.sequence] },
      };
    case 'PatternRule':
      return {
        modelElement: 'pattern.pattern_rule',
        params: {
          trigger: node.trigger,
          daysOfWeek: [...node.daysOfWeek],
          segments: node.segments.map((segment) => ({
            offsetDays: segment.offsetDays,
            shiftType: segment.shiftType,
          })),
        },
      };
    case 'AlternatingWeek':
      return {
        modelElement: 'pattern.alternating_week',
        params: { onShiftType: node.onShiftType, cycleWeeks: node.cycleWeeks },
      };
    case 'TemplateAdherence':
      return {
        modelElement: 'pattern.template_adherence',
        params: { template: node.template, cycleWeeks: node.cycleWeeks },
      };
    case 'LinkedShifts':
      return {
        modelElement: 'linkage.linked_shifts',
        params: { shiftTypes: [...node.shiftTypes] },
      };
    case 'ImpliesAssignment':
      return {
        modelElement: 'linkage.implies_assignment',
        params: { ifShiftType: node.ifShiftType, thenShiftType: node.thenShiftType },
      };
    case 'MutuallyExclusive':
      return {
        modelElement: 'linkage.mutually_exclusive',
        params: { shiftTypes: [...node.shiftTypes] },
      };
    case 'RequestHonoured':
      return {
        modelElement: 'preference.request_honoured',
        params: { requestType: node.requestType },
      };
    case 'ShiftPreference':
      return {
        modelElement: 'preference.shift_preference',
        params: { shiftType: node.shiftType, strength: node.strength },
      };
    case 'AvoidDate':
      return { modelElement: 'preference.avoid_date', params: { date: node.date } };
    case 'FairnessBalance':
      return {
        modelElement: 'fairness.balance',
        params: { metric: node.metric, normalisation: node.normalisation },
      };
    case 'CreditDistribution':
      return { modelElement: 'fairness.credit_distribution', params: { metric: node.metric } };
    case 'StaffOverLocumPriority':
      return {
        modelElement: 'locum.staff_over_locum_priority',
        params: { windowDays: node.windowDays },
      };
    case 'LocumRestriction':
      return { modelElement: 'locum.restriction', params: { restriction: node.restriction } };
    case 'FixedAssignment':
      return {
        modelElement: 'fixed.assignment',
        params: { assignmentIdentity: node.assignmentIdentity },
      };
    case 'ProtectedRange':
      return { modelElement: 'fixed.protected_range', params: { from: node.from, to: node.to } };
    /* rule-node-mapping:end */
    default:
      return assertNever(node);
  }
}

/**
 * Compile one rule. The `role`/`weight` branch is the structural hard/soft
 * invariant: a `HARD` rule cannot reach the objective branch.
 */
export function compileRule(rule: Rule): CompiledRule {
  const mapping = compileNode(rule.predicate);
  const base = {
    ruleKey: rule.ruleKey,
    ruleSchemaVersion: rule.ruleSchemaVersion,
    kind: rule.predicate.kind,
    modelElement: mapping.modelElement,
    scope: compileScope(rule.scope),
    params: mapping.params,
  } as const;

  if (rule.classification === 'HARD') {
    return { ...base, role: 'constraint', weight: null };
  }
  return { ...base, role: 'objective', weight: rule.weight };
}

/** Compile a set of rules into the canonical solver-input form. Order preserved. */
export function compileRuleSet(rules: readonly Rule[], ruleSchemaVersion: number): CompiledRuleSet {
  return {
    compilerVersion: COMPILER_VERSION,
    ruleSchemaVersion,
    elements: rules.map((rule) => compileRule(rule)),
  };
}

/** The canonical, byte-stable string a build hashes and the M4 worker consumes. */
export function compileRuleSetToCanonicalString(
  rules: readonly Rule[],
  ruleSchemaVersion: number,
): string {
  return canonicalStringify(compileRuleSet(rules, ruleSchemaVersion));
}

function assertNever(value: never): never {
  throw new Error(`No compiler mapping for rule node: ${JSON.stringify(value)}`);
}
