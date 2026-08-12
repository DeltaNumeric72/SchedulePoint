/**
 * AST bounds and the checker's evaluation-cost bound (OPUS-M4-000C; doc 34 §4-D:
 * *"AST depth, list sizes, numeric ranges, scope cardinality, evaluation time
 * and memory bounded"*).
 *
 * ## Why an unbounded AST is a liability even though the node set is closed
 *
 * `ast.ts` closes the *shape*: there is no free-expression node and no escape
 * hatch. It says nothing about SIZE. A `ForbiddenSequence` with fifty thousand
 * entries, a `PatternRule` with a hundred thousand segments, a scope naming
 * every membership twice — each is a perfectly valid instance of the closed set,
 * each is storable, and each is then loaded, compiled, canonicalised and
 * evaluated on every publication of every version in the group, forever. The
 * cost is paid by a transaction holding a period lock.
 *
 * That is not a hypothetical shape of attack; it is the ordinary consequence of
 * an authoring surface that accepts an array. So the bounds are enforced at
 * authoring (here and in `@schedulepoint/contracts`), which is the only place a
 * refusal is cheap and the only place the author can be told which field is too
 * large.
 *
 * ## The bound argument for the checker, stated rather than assumed
 *
 * `hard-rule-check.ts` is a CHECKER, not a search: one bounded pass per active
 * HARD rule over the version's existing assignments. With the bounds below in
 * force, the work for one rule is bounded by
 *
 *     O(A log A + A · S)
 *
 * where `A` is the number of active assignments in the version and `S` is the
 * rule's scope cardinality (itself bounded by {@link AST_BOUNDS}). The `log A`
 * is the per-membership chronological sort the rest/spacing kinds need; the
 * `A · S` is scope filtering. **No kind's cost depends on a node's own list
 * lengths multiplicatively** — the evaluated six read scalars and dates, not
 * lists — which is why bounding the lists is enough and there is no recursion to
 * bound. Memory is `O(A)`: the checker builds one per-membership index and holds
 * findings, and {@link AST_BOUNDS.maxFindingsPerRule} caps the second so a rule
 * that breaches on every row cannot turn a check into an allocation.
 *
 * {@link evaluationCostBound} computes that number, so the argument is a value a
 * test can assert against a pathological-but-legal AST rather than a paragraph
 * nobody re-derives.
 *
 * Pure and dependency-free.
 */

import type { Rule, RuleNode } from './ast.js';

/**
 * The bounds. Each is a product decision expressed as a number, so each carries
 * the reason it is that number rather than another one.
 */
export const AST_BOUNDS = {
  /**
   * Maximum structural depth of a predicate.
   *
   * The closed node set is FLAT — no node contains another node — so the deepest
   * legal predicate is `node → array → object` (a `PatternRule` and its
   * segments), which is depth 3. The bound exists anyway, and is checked, so
   * that adding a nesting node later cannot silently make an unbounded tree
   * legal: the day a composite node appears, this refuses it until somebody
   * chooses a real depth for it.
   */
  maxNodeDepth: 3,

  /** `ForbiddenSequence.sequence` — a run of shift types a person may not work. */
  maxSequenceLength: 32,
  /** `LinkedShifts.shiftTypes`, `MutuallyExclusive.shiftTypes`. */
  maxShiftTypesInNode: 64,
  /** `PatternRule.segments`. A cycle longer than a year is a different rule. */
  maxPatternSegments: 64,
  /** `PatternRule.daysOfWeek` — the seven weekdays plus `holiday`, so eight. */
  maxDaysOfWeek: 8,
  /** `PickPositionRestriction.allowedPickPositions`. */
  maxPickPositions: 64,

  /** `RequiredCount.count`, `MinCoverage.min`, `MaxCoverage.max`, `MaxAssignmentsInWindow.max`. */
  maxCount: 10_000,
  /** `MaxAssignmentsInWindow.windowDays`, `StaffOverLocumPriority.windowDays`. */
  maxWindowDays: 366,
  /** `MaxConsecutive.maxDays`, `CallSpacing.minDaysBetweenCalls`. */
  maxDays: 366,
  /** `MinimumRestBetween.minHours`. A year of rest is not a rest rule. */
  maxRestHours: 8_760,
  /** `AlternatingWeek.cycleWeeks`, `TemplateAdherence.cycleWeeks` — five years. */
  maxCycleWeeks: 260,
  /** `PatternSegment.offsetDays`, in either direction. */
  maxSegmentOffsetDays: 366,

  /** `scope.shiftTypes`. A group with more than this many shift types is not a group. */
  maxScopeShiftTypes: 200,
  /** `scope.staffGroups`. */
  maxScopeStaffGroups: 200,
  /**
   * `scope.memberships`.
   *
   * The largest of the three because naming individuals is the legitimate case
   * for a large scope — a rule for every physician in a large department. It is
   * still bounded: a scope naming ten thousand memberships is a rule that should
   * have been written against a staff group.
   */
  maxScopeMemberships: 1_000,

  /** Any identifier the AST carries (a key, a code, a template name). */
  maxIdentifierLength: 64,

  /**
   * Findings one rule may report before the checker stops adding them.
   *
   * Not a validation bound — a memory bound on evaluation. A HARD rule that
   * breaches on every one of ten thousand assignments produces one refusal
   * either way; the ten-thousandth explanation adds nothing and the allocation
   * is real.
   */
  maxFindingsPerRule: 100,
} as const;

/** A bound violation, addressed to the control that caused it (as `RuleProblem`). */
export interface BoundProblem {
  readonly path: string;
  readonly message: string;
}

/** Structural depth of a JSON-shaped value. Arrays and objects each count one. */
export function valueDepth(value: unknown): number {
  if (Array.isArray(value)) {
    let deepest = 0;
    for (const element of value) deepest = Math.max(deepest, valueDepth(element));
    return 1 + deepest;
  }
  if (value !== null && typeof value === 'object') {
    let deepest = 0;
    for (const member of Object.values(value as Record<string, unknown>)) {
      deepest = Math.max(deepest, valueDepth(member));
    }
    return 1 + deepest;
  }
  return 0;
}

function tooLong(
  problems: BoundProblem[],
  path: string,
  value: unknown,
  limit: number,
  label: string,
): void {
  if (Array.isArray(value) && value.length > limit) {
    problems.push({
      path,
      message: `${label} may not have more than ${String(limit)} entries.`,
    });
  }
}

function tooLarge(
  problems: BoundProblem[],
  path: string,
  value: unknown,
  limit: number,
  label: string,
): void {
  if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) > limit) {
    problems.push({ path, message: `${label} may not exceed ${String(limit)}.` });
  }
}

function tooLongIdentifier(problems: BoundProblem[], path: string, value: unknown): void {
  if (typeof value === 'string' && value.length > AST_BOUNDS.maxIdentifierLength) {
    problems.push({
      path,
      message: `This identifier may not be longer than ${String(AST_BOUNDS.maxIdentifierLength)} characters.`,
    });
  }
}

/**
 * Every bound a predicate node violates.
 *
 * Deliberately separate from `nodeProblems`' correctness checks: a bound is a
 * capacity decision and a correctness check is a meaning decision, and a reader
 * looking for "how big may this be" should find one list rather than thirty
 * scattered comparisons.
 */
export function nodeBoundProblems(node: RuleNode, base: string): BoundProblem[] {
  const problems: BoundProblem[] = [];
  const at = (suffix: string): string => `${base}.${suffix}`;

  const depth = valueDepth(node);
  if (depth > AST_BOUNDS.maxNodeDepth) {
    problems.push({
      path: base,
      message: `A rule predicate may not nest more than ${String(AST_BOUNDS.maxNodeDepth)} levels deep.`,
    });
  }

  switch (node.kind) {
    case 'RequiredCount':
      tooLarge(problems, at('count'), node.count, AST_BOUNDS.maxCount, 'The required count');
      break;
    case 'MinCoverage':
      tooLarge(problems, at('min'), node.min, AST_BOUNDS.maxCount, 'The minimum coverage');
      break;
    case 'MaxCoverage':
      tooLarge(problems, at('max'), node.max, AST_BOUNDS.maxCount, 'The maximum coverage');
      break;
    case 'RequiresQualification':
      tooLongIdentifier(problems, at('qualification'), node.qualification);
      break;
    case 'MemberOfStaffGroup':
      tooLongIdentifier(problems, at('staffGroup'), node.staffGroup);
      break;
    case 'ValidGroupRestriction':
      tooLongIdentifier(problems, at('validGroup'), node.validGroup);
      break;
    case 'PickPositionRestriction':
      tooLong(
        problems,
        at('allowedPickPositions'),
        node.allowedPickPositions,
        AST_BOUNDS.maxPickPositions,
        'The pick-position list',
      );
      node.allowedPickPositions.forEach((position, i) => {
        tooLarge(
          problems,
          at(`allowedPickPositions.${String(i)}`),
          position,
          AST_BOUNDS.maxCount,
          'A pick position',
        );
      });
      break;
    case 'MaxAssignmentsInWindow':
      tooLarge(problems, at('max'), node.max, AST_BOUNDS.maxCount, 'The maximum');
      tooLarge(
        problems,
        at('windowDays'),
        node.windowDays,
        AST_BOUNDS.maxWindowDays,
        'The window length in days',
      );
      break;
    case 'WeekdayFteLimit':
    case 'WorkPercentageTarget':
      // Both are already range-bounded by their meaning (0..1, 0..100) in
      // `nodeProblems`; there is no separate capacity bound to add.
      break;
    case 'MaxConsecutive':
      tooLarge(
        problems,
        at('maxDays'),
        node.maxDays,
        AST_BOUNDS.maxDays,
        'The maximum consecutive days',
      );
      break;
    case 'MinimumRestBetween':
      tooLarge(
        problems,
        at('minHours'),
        node.minHours,
        AST_BOUNDS.maxRestHours,
        'The minimum rest in hours',
      );
      break;
    case 'CallSpacing':
      tooLarge(
        problems,
        at('minDaysBetweenCalls'),
        node.minDaysBetweenCalls,
        AST_BOUNDS.maxDays,
        'The minimum days between calls',
      );
      break;
    case 'NoAdjacent':
      tooLongIdentifier(problems, at('shiftTypeA'), node.shiftTypeA);
      tooLongIdentifier(problems, at('shiftTypeB'), node.shiftTypeB);
      break;
    case 'ForbiddenSequence':
      tooLong(
        problems,
        at('sequence'),
        node.sequence,
        AST_BOUNDS.maxSequenceLength,
        'A forbidden sequence',
      );
      node.sequence.forEach((code, i) => {
        tooLongIdentifier(problems, at(`sequence.${String(i)}`), code);
      });
      break;
    case 'PatternRule':
      tooLongIdentifier(problems, at('trigger'), node.trigger);
      tooLong(
        problems,
        at('daysOfWeek'),
        node.daysOfWeek,
        AST_BOUNDS.maxDaysOfWeek,
        'The days-of-week list',
      );
      tooLong(
        problems,
        at('segments'),
        node.segments,
        AST_BOUNDS.maxPatternSegments,
        'A pattern',
      );
      node.segments.forEach((segment, i) => {
        tooLarge(
          problems,
          at(`segments.${String(i)}.offsetDays`),
          segment.offsetDays,
          AST_BOUNDS.maxSegmentOffsetDays,
          'A segment offset in days',
        );
        tooLongIdentifier(problems, at(`segments.${String(i)}.shiftType`), segment.shiftType);
      });
      break;
    case 'AlternatingWeek':
      tooLongIdentifier(problems, at('onShiftType'), node.onShiftType);
      tooLarge(
        problems,
        at('cycleWeeks'),
        node.cycleWeeks,
        AST_BOUNDS.maxCycleWeeks,
        'The cycle length in weeks',
      );
      break;
    case 'TemplateAdherence':
      tooLongIdentifier(problems, at('template'), node.template);
      tooLarge(
        problems,
        at('cycleWeeks'),
        node.cycleWeeks,
        AST_BOUNDS.maxCycleWeeks,
        'The cycle length in weeks',
      );
      break;
    case 'LinkedShifts':
    case 'MutuallyExclusive':
      tooLong(
        problems,
        at('shiftTypes'),
        node.shiftTypes,
        AST_BOUNDS.maxShiftTypesInNode,
        'The shift-type list',
      );
      node.shiftTypes.forEach((code, i) => {
        tooLongIdentifier(problems, at(`shiftTypes.${String(i)}`), code);
      });
      break;
    case 'ImpliesAssignment':
      tooLongIdentifier(problems, at('ifShiftType'), node.ifShiftType);
      tooLongIdentifier(problems, at('thenShiftType'), node.thenShiftType);
      break;
    case 'RequestHonoured':
      tooLongIdentifier(problems, at('requestType'), node.requestType);
      break;
    case 'ShiftPreference':
      tooLongIdentifier(problems, at('shiftType'), node.shiftType);
      break;
    case 'AvoidDate':
    case 'ProtectedRange':
    case 'FairnessBalance':
    case 'CreditDistribution':
      // Dates and closed enums. Nothing size-bearing.
      break;
    case 'StaffOverLocumPriority':
      tooLarge(
        problems,
        at('windowDays'),
        node.windowDays,
        AST_BOUNDS.maxWindowDays,
        'The window length in days',
      );
      break;
    case 'LocumRestriction':
      break;
    case 'FixedAssignment':
      tooLongIdentifier(problems, at('assignmentIdentity'), node.assignmentIdentity);
      break;
    default:
      assertNever(node);
  }

  return problems;
}

/** Scope cardinality. The three arrays are bounded separately; see the constants. */
export function scopeBoundProblems(rule: Rule): BoundProblem[] {
  const problems: BoundProblem[] = [];
  tooLong(
    problems,
    'scope.shiftTypes',
    rule.scope.shiftTypes,
    AST_BOUNDS.maxScopeShiftTypes,
    'The shift-type scope',
  );
  tooLong(
    problems,
    'scope.staffGroups',
    rule.scope.staffGroups,
    AST_BOUNDS.maxScopeStaffGroups,
    'The staff-group scope',
  );
  tooLong(
    problems,
    'scope.memberships',
    rule.scope.memberships,
    AST_BOUNDS.maxScopeMemberships,
    'The membership scope',
  );
  for (const [field, values] of [
    ['shiftTypes', rule.scope.shiftTypes],
    ['staffGroups', rule.scope.staffGroups],
    ['memberships', rule.scope.memberships],
  ] as const) {
    if (values === undefined) continue;
    values.forEach((value, i) => {
      tooLongIdentifier(problems, `scope.${field}.${String(i)}`, value);
    });
  }
  return problems;
}

/** Total scope cardinality, as the bound argument's `S`. */
export function scopeCardinality(rule: Rule): number {
  return (
    (rule.scope.shiftTypes?.length ?? 0) +
    (rule.scope.staffGroups?.length ?? 0) +
    (rule.scope.memberships?.length ?? 0)
  );
}

/**
 * The upper bound on the work one rule's evaluation may cost, in abstract steps,
 * over a version with `assignmentCount` active assignments.
 *
 * `A log2 A + A · (S + 1)`, with `S` the scope cardinality. Exposed as a number
 * so the bound argument in this file's header is a value a test asserts against
 * a pathological-but-legal AST, rather than a paragraph nobody re-derives.
 *
 * It is deliberately an over-estimate: the point is a ceiling that holds, not a
 * prediction.
 */
export function evaluationCostBound(rule: Rule, assignmentCount: number): number {
  const a = Math.max(assignmentCount, 1);
  return Math.ceil(a * Math.log2(a + 1)) + a * (scopeCardinality(rule) + 1);
}

/**
 * The largest cost any LEGAL rule can reach at a given assignment count.
 *
 * The scope bounds cap `S`, so this is a closed-form ceiling over every rule the
 * validator will admit. A checker whose observed work exceeds it has a bug, and
 * the test says so in those terms.
 */
export function maximumEvaluationCostBound(assignmentCount: number): number {
  const a = Math.max(assignmentCount, 1);
  const maxScope =
    AST_BOUNDS.maxScopeShiftTypes + AST_BOUNDS.maxScopeStaffGroups + AST_BOUNDS.maxScopeMemberships;
  return Math.ceil(a * Math.log2(a + 1)) + a * (maxScope + 1);
}

function assertNever(value: never): never {
  throw new Error(`Unexpected rule node: ${JSON.stringify(value)}`);
}
