/**
 * Pure validation of a typed rule (OPUS-M3-002, SPEC-04 §3.1–3.3).
 *
 * A rule is validated against the AST schema on authoring; an invalid rule
 * **cannot be stored** (SPEC-04 §3.2). The result is a list of field-addressed
 * problems — `{ path, message }`, not a sentence — so the authoring form can
 * link its `role="alert"` summary to the exact control that is wrong (SP-E brief;
 * the same discipline as `catalogue/shift-type.ts`). A summary that links to
 * fields cannot be built from a string.
 *
 * This is the domain (compile-time-safe) half. `@schedulepoint/contracts` validates
 * the untyped wire shape with `zod`; the database CHECK enforces the hard/soft
 * invariant a third time. The three are asserted to agree rather than trusted to.
 */

import {
  FAIRNESS_METRICS,
  FAIRNESS_NORMALISATIONS,
  LOCUM_RESTRICTIONS,
  PREFERENCE_STRENGTHS,
  RULE_WEEKDAYS,
  isRuleNodeKind,
  type Rule,
  type RuleNode,
} from './ast.js';

/** A single validation failure, addressed to the authoring control that caused it. */
export interface RuleProblem {
  /** A dotted path into the rule, e.g. `predicate.count` or `scope.dateRange.to`. */
  readonly path: string;
  /** Rendered verbatim. No identifiers, no values the user did not type. */
  readonly message: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const RULE_KEY = /^[a-z][a-z0-9_]*$/;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveInt(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value > 0;
}

function isNonNegativeInt(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

/**
 * A real calendar date in `YYYY-MM-DD`.
 *
 * **`Date.parse` alone is not enough**, which is the review finding this closes:
 * `Date.parse('2026-02-30T00:00:00Z')` succeeds — JavaScript rolls the overflow
 * forward to 2 March — so `2026-02-30` and `2026-13-01` both validated and were
 * stored verbatim. A rule scoped to a date that does not exist is a rule whose
 * window silently means a different day than it says.
 *
 * The round-trip comparison is the check: parse, then re-render the UTC parts and
 * require them to equal the input. A rolled-over date renders as the day it
 * rolled to and fails.
 */
function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time)) return false;
  const parsed = new Date(time);
  const rendered = `${String(parsed.getUTCFullYear()).padStart(4, '0')}-${String(
    parsed.getUTCMonth() + 1,
  ).padStart(2, '0')}-${String(parsed.getUTCDate()).padStart(2, '0')}`;
  return rendered === value;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The complete set of keys each node kind may carry, `kind` included.
 *
 * ## Why an allowlist and not "ignore what you do not recognise"
 *
 * The independent review smuggled `customExpression` and `customPayload` in
 * beside otherwise-valid fields. Validation passed: nothing looked at keys it did
 * not expect. The contract's `.strict()` rejects them at the HTTP boundary, but
 * the *domain* validator is what a background job, a migration, or a future
 * non-HTTP writer would call, and it was the layer claiming "no escape hatch"
 * while carrying one.
 *
 * `RULE_NODE_KEYS` closes it. It is kept honest by
 * `packages/domain/test/rules/ast-validate.test.ts`, which asserts that for every
 * sample node the declared key set equals the node's own keys — so a field added
 * to an interface without an entry here fails a test rather than silently
 * becoming unvalidated.
 */
export const RULE_NODE_KEYS: Readonly<Record<string, readonly string[]>> = {
  RequiredCount: ['kind', 'count'],
  MinCoverage: ['kind', 'min'],
  MaxCoverage: ['kind', 'max'],
  RequiresQualification: ['kind', 'qualification', 'validAt'],
  MemberOfStaffGroup: ['kind', 'staffGroup'],
  ValidGroupRestriction: ['kind', 'validGroup'],
  PickPositionRestriction: ['kind', 'allowedPickPositions'],
  MaxAssignmentsInWindow: ['kind', 'max', 'windowDays'],
  WeekdayFteLimit: ['kind', 'weekday', 'fteFraction'],
  WorkPercentageTarget: ['kind', 'targetPercentage'],
  MaxConsecutive: ['kind', 'maxDays'],
  MinimumRestBetween: ['kind', 'minHours'],
  CallSpacing: ['kind', 'minDaysBetweenCalls'],
  NoAdjacent: ['kind', 'shiftTypeA', 'shiftTypeB'],
  ForbiddenSequence: ['kind', 'sequence'],
  PatternRule: ['kind', 'trigger', 'daysOfWeek', 'segments'],
  AlternatingWeek: ['kind', 'onShiftType', 'cycleWeeks'],
  TemplateAdherence: ['kind', 'template', 'cycleWeeks'],
  LinkedShifts: ['kind', 'shiftTypes'],
  ImpliesAssignment: ['kind', 'ifShiftType', 'thenShiftType'],
  MutuallyExclusive: ['kind', 'shiftTypes'],
  RequestHonoured: ['kind', 'requestType'],
  ShiftPreference: ['kind', 'shiftType', 'strength'],
  AvoidDate: ['kind', 'date'],
  FairnessBalance: ['kind', 'metric', 'normalisation'],
  CreditDistribution: ['kind', 'metric'],
  StaffOverLocumPriority: ['kind', 'windowDays'],
  LocumRestriction: ['kind', 'restriction'],
  FixedAssignment: ['kind', 'assignmentIdentity'],
  ProtectedRange: ['kind', 'from', 'to'],
};

/** The keys a `PatternRule` segment may carry. Same discipline, one level down. */
const PATTERN_SEGMENT_KEYS: readonly string[] = ['offsetDays', 'shiftType'];

/** The keys a scope may carry. */
const SCOPE_KEYS: readonly string[] = ['dateRange', 'shiftTypes', 'staffGroups', 'memberships'];
const DATE_RANGE_KEYS: readonly string[] = ['from', 'to'];

/**
 * Reports every key present on `value` that `allowed` does not list.
 *
 * The unexpected key is named in the PATH, never interpolated into the message:
 * the path is what the authoring form addresses, and a message echoing an
 * attacker-chosen key would put unvetted text into a rendered string.
 */
function unexpectedKeyProblems(
  value: unknown,
  allowed: readonly string[],
  base: string,
): RuleProblem[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>)
    .filter((key) => !allowed.includes(key))
    .map((key) => ({
      path: base === '' ? key : `${base}.${key}`,
      message: 'This field is not part of the rule language.',
    }));
}

/**
 * Validates the predicate node. Every branch is exhaustive over the closed node
 * set; an unknown `kind` is rejected as an escape-hatch attempt (there is no
 * free-expression node — SPEC-04 §3.1), and so is an unknown SIBLING KEY beside
 * a valid one (see {@link RULE_NODE_KEYS}).
 */
export function nodeProblems(node: RuleNode, base: string): RuleProblem[] {
  const problems: RuleProblem[] = [
    ...unexpectedKeyProblems(node, RULE_NODE_KEYS[node.kind] ?? ['kind'], base),
  ];
  const at = (suffix: string): string => (suffix === '' ? base : `${base}.${suffix}`);
  const requirePositive = (field: string, value: unknown, label: string): void => {
    if (!isPositiveInt(value))
      problems.push({ path: at(field), message: `${label} must be a positive whole number.` });
  };
  const requireShiftType = (field: string, value: unknown): void => {
    if (!isNonEmptyString(value))
      problems.push({ path: at(field), message: 'A shift type is required.' });
  };

  switch (node.kind) {
    case 'RequiredCount':
      requirePositive('count', node.count, 'The required count');
      break;
    case 'MinCoverage':
      requirePositive('min', node.min, 'The minimum coverage');
      break;
    case 'MaxCoverage':
      requirePositive('max', node.max, 'The maximum coverage');
      break;
    case 'RequiresQualification':
      if (!isNonEmptyString(node.qualification))
        problems.push({ path: at('qualification'), message: 'A qualification is required.' });
      if (node.validAt !== 'shift_date')
        problems.push({
          path: at('validAt'),
          message: 'Eligibility is evaluated as of the shift date.',
        });
      break;
    case 'MemberOfStaffGroup':
      if (!isNonEmptyString(node.staffGroup))
        problems.push({ path: at('staffGroup'), message: 'A staff group is required.' });
      break;
    case 'ValidGroupRestriction':
      if (!isNonEmptyString(node.validGroup))
        problems.push({ path: at('validGroup'), message: 'A valid group is required.' });
      break;
    case 'PickPositionRestriction':
      if (node.allowedPickPositions.length === 0)
        problems.push({
          path: at('allowedPickPositions'),
          message: 'At least one pick position is required.',
        });
      node.allowedPickPositions.forEach((position, i) => {
        if (!isNonNegativeInt(position))
          problems.push({
            path: at(`allowedPickPositions.${String(i)}`),
            message: 'A pick position must be a whole number of zero or more.',
          });
      });
      break;
    case 'MaxAssignmentsInWindow':
      requirePositive('max', node.max, 'The maximum');
      requirePositive('windowDays', node.windowDays, 'The window length in days');
      break;
    case 'WeekdayFteLimit':
      if (!(RULE_WEEKDAYS as readonly string[]).includes(node.weekday))
        problems.push({ path: at('weekday'), message: 'A weekday (or holiday) is required.' });
      if (!isFiniteNumber(node.fteFraction) || node.fteFraction < 0 || node.fteFraction > 1)
        problems.push({
          path: at('fteFraction'),
          message: 'The FTE fraction must be between 0 and 1.',
        });
      break;
    case 'WorkPercentageTarget':
      if (
        !isFiniteNumber(node.targetPercentage) ||
        node.targetPercentage <= 0 ||
        node.targetPercentage > 100
      )
        problems.push({
          path: at('targetPercentage'),
          message: 'The work percentage must be greater than 0 and at most 100.',
        });
      break;
    case 'MaxConsecutive':
      requirePositive('maxDays', node.maxDays, 'The maximum consecutive days');
      break;
    case 'MinimumRestBetween':
      requirePositive('minHours', node.minHours, 'The minimum rest in hours');
      break;
    case 'CallSpacing':
      requirePositive(
        'minDaysBetweenCalls',
        node.minDaysBetweenCalls,
        'The minimum days between calls',
      );
      break;
    case 'NoAdjacent':
      requireShiftType('shiftTypeA', node.shiftTypeA);
      requireShiftType('shiftTypeB', node.shiftTypeB);
      break;
    case 'ForbiddenSequence':
      if (node.sequence.length < 2)
        problems.push({
          path: at('sequence'),
          message: 'A forbidden sequence needs at least two shift types.',
        });
      node.sequence.forEach((shiftType, i) => {
        if (!isNonEmptyString(shiftType))
          problems.push({
            path: at(`sequence.${String(i)}`),
            message: 'A shift type is required.',
          });
      });
      break;
    case 'PatternRule':
      requireShiftType('trigger', node.trigger);
      if (node.daysOfWeek.length === 0)
        problems.push({
          path: at('daysOfWeek'),
          message: 'At least one day of the week is required.',
        });
      node.daysOfWeek.forEach((day, i) => {
        if (!(RULE_WEEKDAYS as readonly string[]).includes(day))
          problems.push({
            path: at(`daysOfWeek.${String(i)}`),
            message: 'A weekday (or holiday) is required.',
          });
      });
      if (node.segments.length === 0)
        problems.push({ path: at('segments'), message: 'A pattern needs at least one segment.' });
      node.segments.forEach((segment, i) => {
        problems.push(
          ...unexpectedKeyProblems(segment, PATTERN_SEGMENT_KEYS, at(`segments.${String(i)}`)),
        );
        if (!isFiniteNumber(segment.offsetDays) || !Number.isInteger(segment.offsetDays))
          problems.push({
            path: at(`segments.${String(i)}.offsetDays`),
            message: 'A segment offset must be a whole number of days.',
          });
        if (!isNonEmptyString(segment.shiftType))
          problems.push({
            path: at(`segments.${String(i)}.shiftType`),
            message: 'A shift type is required.',
          });
      });
      break;
    case 'AlternatingWeek':
      requireShiftType('onShiftType', node.onShiftType);
      requirePositive('cycleWeeks', node.cycleWeeks, 'The cycle length in weeks');
      break;
    case 'TemplateAdherence':
      if (!isNonEmptyString(node.template))
        problems.push({ path: at('template'), message: 'A template is required.' });
      requirePositive('cycleWeeks', node.cycleWeeks, 'The cycle length in weeks');
      break;
    case 'LinkedShifts':
      if (node.shiftTypes.length < 2)
        problems.push({
          path: at('shiftTypes'),
          message: 'Linked shifts need at least two shift types.',
        });
      node.shiftTypes.forEach((shiftType, i) => {
        if (!isNonEmptyString(shiftType))
          problems.push({
            path: at(`shiftTypes.${String(i)}`),
            message: 'A shift type is required.',
          });
      });
      break;
    case 'ImpliesAssignment':
      requireShiftType('ifShiftType', node.ifShiftType);
      requireShiftType('thenShiftType', node.thenShiftType);
      break;
    case 'MutuallyExclusive':
      if (node.shiftTypes.length < 2)
        problems.push({
          path: at('shiftTypes'),
          message: 'Mutual exclusion needs at least two shift types.',
        });
      node.shiftTypes.forEach((shiftType, i) => {
        if (!isNonEmptyString(shiftType))
          problems.push({
            path: at(`shiftTypes.${String(i)}`),
            message: 'A shift type is required.',
          });
      });
      break;
    case 'RequestHonoured':
      if (!isNonEmptyString(node.requestType))
        problems.push({ path: at('requestType'), message: 'A request type is required.' });
      break;
    case 'ShiftPreference':
      requireShiftType('shiftType', node.shiftType);
      if (!(PREFERENCE_STRENGTHS as readonly string[]).includes(node.strength))
        problems.push({ path: at('strength'), message: 'A preference strength is required.' });
      break;
    case 'AvoidDate':
      if (!isValidDate(node.date))
        problems.push({ path: at('date'), message: 'A valid calendar date is required.' });
      break;
    case 'FairnessBalance':
      if (!(FAIRNESS_METRICS as readonly string[]).includes(node.metric))
        problems.push({ path: at('metric'), message: 'A fairness metric is required.' });
      if (!(FAIRNESS_NORMALISATIONS as readonly string[]).includes(node.normalisation))
        problems.push({ path: at('normalisation'), message: 'A normalisation is required.' });
      break;
    case 'CreditDistribution':
      if (!(FAIRNESS_METRICS as readonly string[]).includes(node.metric))
        problems.push({ path: at('metric'), message: 'A fairness metric is required.' });
      break;
    case 'StaffOverLocumPriority':
      requirePositive('windowDays', node.windowDays, 'The window length in days');
      break;
    case 'LocumRestriction':
      if (!(LOCUM_RESTRICTIONS as readonly string[]).includes(node.restriction))
        problems.push({ path: at('restriction'), message: 'A locum restriction is required.' });
      break;
    case 'FixedAssignment':
      if (!isNonEmptyString(node.assignmentIdentity))
        problems.push({
          path: at('assignmentIdentity'),
          message: 'An assignment identity is required.',
        });
      break;
    case 'ProtectedRange':
      if (!isValidDate(node.from))
        problems.push({ path: at('from'), message: 'A valid start date is required.' });
      if (!isValidDate(node.to))
        problems.push({ path: at('to'), message: 'A valid end date is required.' });
      if (isValidDate(node.from) && isValidDate(node.to) && node.from > node.to)
        problems.push({
          path: at('to'),
          message: 'The end date must not be before the start date.',
        });
      break;
    default:
      // Exhaustiveness: the closed node set has no other member. An unknown kind
      // reaching here is an escape-hatch attempt and is rejected, never stored.
      problems.push({ path: base, message: 'Unknown rule node.' });
      assertNever(node);
  }

  return problems;
}

/** The scope filter, when present, must be internally consistent. */
export function scopeProblems(rule: Rule): RuleProblem[] {
  const problems: RuleProblem[] = [...unexpectedKeyProblems(rule.scope, SCOPE_KEYS, 'scope')];
  const range = rule.scope.dateRange;
  if (range !== undefined) {
    problems.push(...unexpectedKeyProblems(range, DATE_RANGE_KEYS, 'scope.dateRange'));
    if (!isValidDate(range.from))
      problems.push({ path: 'scope.dateRange.from', message: 'A valid start date is required.' });
    if (!isValidDate(range.to))
      problems.push({ path: 'scope.dateRange.to', message: 'A valid end date is required.' });
    if (isValidDate(range.from) && isValidDate(range.to) && range.from > range.to)
      problems.push({
        path: 'scope.dateRange.to',
        message: 'The end date must not be before the start date.',
      });
  }
  for (const [field, values] of [
    ['shiftTypes', rule.scope.shiftTypes],
    ['staffGroups', rule.scope.staffGroups],
    ['memberships', rule.scope.memberships],
  ] as const) {
    if (values === undefined) continue;
    values.forEach((value, i) => {
      if (!isNonEmptyString(value))
        problems.push({
          path: `scope.${field}.${String(i)}`,
          message: 'This value must not be blank.',
        });
    });
  }
  return problems;
}

/**
 * The whole-rule validation the authoring API runs before a save. Field-addressed
 * so the form can point at the wrong control. The hard/soft weight discipline is
 * checked here as well as in the type and the database CHECK.
 */
export function ruleProblems(rule: Rule): RuleProblem[] {
  const problems: RuleProblem[] = [];

  if (!isNonEmptyString(rule.ruleKey) || !RULE_KEY.test(rule.ruleKey)) {
    problems.push({
      path: 'ruleKey',
      message: 'A rule key is lowercase letters, digits, and underscores, starting with a letter.',
    });
  }
  if (!isNonEmptyString(rule.name)) {
    problems.push({ path: 'name', message: 'A name is required.' });
  }

  if (rule.classification === 'HARD') {
    if (rule.weight !== undefined)
      problems.push({ path: 'weight', message: 'A hard rule must not carry a weight.' });
  } else if (rule.classification === 'SOFT') {
    if (!isFiniteNumber(rule.weight) || rule.weight <= 0)
      problems.push({
        path: 'weight',
        message: 'A soft rule must carry a weight greater than zero.',
      });
  } else {
    problems.push({ path: 'classification', message: 'A rule is either HARD or SOFT.' });
  }

  problems.push(...scopeProblems(rule));

  if (
    rule.predicate === null ||
    typeof rule.predicate !== 'object' ||
    !('kind' in rule.predicate) ||
    typeof rule.predicate.kind !== 'string' ||
    !isRuleNodeKind(rule.predicate.kind)
  ) {
    problems.push({ path: 'predicate', message: 'A recognised rule node is required.' });
  } else {
    problems.push(...nodeProblems(rule.predicate, 'predicate'));
  }

  return problems;
}

export function isValidRule(rule: Rule): boolean {
  return ruleProblems(rule).length === 0;
}

/** Exhaustiveness helper — a compile error if a node kind is left unhandled above. */
function assertNever(value: never): never {
  throw new Error(`Unexpected rule node: ${JSON.stringify(value)}`);
}
