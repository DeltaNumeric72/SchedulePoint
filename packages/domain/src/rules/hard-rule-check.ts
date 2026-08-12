/**
 * HARD-rule re-validation — SPEC-05 §6 **step 06**, SPEC-04 §3.3 (OPUS-M3-008).
 *
 * ## What this is, and the line it does not cross
 *
 * This is a **checker**: given a version's existing content and the group's
 * active compiled HARD rules, it answers "does this content breach any of them?"
 * It is bounded, deterministic, and total — one pass per rule over a list of
 * assignments that already exist.
 *
 * **There is no search, no optimization, and no assignment generation here.**
 * Producing assignments is the M4 solver and is prohibited (non-bypass rule 7,
 * the M4 boundary). SPEC-04 §3.3 names this component explicitly and separately:
 * "Every returned solution is re-validated against every `HARD` rule by an
 * **independent checker** before it can become a schedule version." The checker
 * is not the solver, and writing it here is what lets M4's output be distrusted
 * later.
 *
 * ## Fail-closed on a kind this checker cannot evaluate
 *
 * SPEC-04 §3.3's first sentence is absolute: "A `HARD` rule can never be
 * relaxed, downgraded, weighted, or **skipped by any code path**." An active
 * HARD rule of a kind whose semantics SPEC-04 §3.1 does not pin therefore cannot
 * be passed over silently — that would be exactly the "silently softened" outcome
 * §3.2 forbids for the compiler's sibling case.
 *
 * So an unevaluable HARD rule produces a {@link HardRuleFinding} of kind
 * `not-evaluable`, which the publication transaction treats as blocking. The
 * finding names the rule key, the node kind, and *why* it could not be
 * evaluated, so the answer to an operator is "this HARD rule cannot be checked,
 * so this version cannot be asserted to satisfy it" rather than silence.
 * {@link EVALUATED_HARD_RULE_KINDS} is the closed list of what this checker does
 * evaluate; every other kind is reported honestly.
 *
 * ## Identifier domains, and why an unresolvable one is not a guess
 *
 * SPEC-04 §3.1 pins some identifier domains and leaves others open. The AST's own
 * documentation pins `RequiresQualification.qualification` ("the qualification
 * key, doc 06 `qualifications.key`") and shift types ("shift-type **codes**",
 * `ForbiddenSequenceNode.sequence`). It pins nothing for `RuleScope.staffGroups`,
 * and `FixedAssignmentNode.assignmentIdentity` names an "assignment-identity key"
 * that no column carries. Rather than pick a reading, a rule whose scope or
 * parameters cannot be resolved against the group's real vocabulary is reported
 * `not-evaluable` with the unresolved identifier named.
 *
 * ## Pure
 *
 * No clock, no database, no I/O — `@schedulepoint/domain` imports nothing. Dates
 * arrive as `YYYY-MM-DD` strings and instants as epoch milliseconds, both
 * supplied by the caller, so two rows in one publication are never evaluated
 * against two clock readings.
 */

import { AST_BOUNDS } from './bounds.js';
import type { CompiledRule } from './compile.js';
import type { RuleNodeKind } from './ast.js';

/* ────────────────────────────────────────────────────────────────────────────
 * The content under test
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * One active assignment in the version being published, flattened to exactly the
 * facts the evaluated kinds need. Everything is already resolved by the caller —
 * this module never looks anything up.
 */
export interface CheckedAssignment {
  /** `assignment_snapshots.id`, so a finding can address one row. */
  readonly snapshotId: string;
  readonly assignmentIdentityId: string;
  readonly membershipId: string;
  /** `YYYY-MM-DD` in the group's timezone — `assignment_snapshots.date`. */
  readonly date: string;
  /** Epoch milliseconds, from `assignment_snapshots.starts_at`. */
  readonly startsAtMs: number;
  /** Epoch milliseconds, from `assignment_snapshots.ends_at`. */
  readonly endsAtMs: number;
  /** `shift_types.code` for the shift this assignment hangs on. */
  readonly shiftTypeCode: string;
  /**
   * `shift_types.is_on_call` for that shift type (migration 0005).
   *
   * The one attribute in the system that says a shift IS a call, which is what
   * makes `CallSpacing` evaluable. An earlier version of this file recorded
   * "no shift-type attribute distinguishes a call from any other shift" as the
   * reason `CallSpacing` could not be checked. **That was factually false** — the
   * column shipped at M2, is typed as `isOnCall` in the domain and the contracts,
   * and the revalidation loader already joins `shift_types`. The falsehood had
   * propagated into the owner-ruling document, asking for a decision about
   * building something that already existed.
   */
  readonly isOnCall: boolean;
}

/**
 * The qualification facts the caller resolved for this version.
 *
 * A **function**, not a keyed map, and deliberately: the caller decides how to
 * index its own holdings, and this module never has to agree with it about a
 * composite-key spelling. (The first version of this docblock described a map
 * keyed on `membershipId + separator + qualificationKey` — a shape that never
 * existed here, and whose separator was written as a **literal NUL byte**, which
 * made this file binary to `git diff` and invisible to every diff-based review
 * tool. The identical mistake is recorded one function over in
 * `scripts/sbx/test-port.mjs`. Describing the interface that exists removes both
 * the falsehood and any need for a separator at all.)
 *
 * `heldOn` answers whether the holding was honoured on a date — computed by the
 * caller through the one in-force loader and `isEligibleAt`, so this module never
 * re-implements the window rule that `packages/domain/src/profiles/in-force.ts`
 * already owns (the S-01 lesson: a second spelling of a boundary rule is a second
 * answer waiting to happen).
 */
export interface QualificationFacts {
  /** `true` when the membership held the qualification, valid, on that date. */
  heldOn(membershipId: string, qualificationKey: string, date: string): boolean;
  /** Every qualification key the group's vocabulary defines. */
  readonly knownQualificationKeys: ReadonlySet<string>;
}

/** Everything the checker is given about the group's real vocabulary. */
export interface CheckedVersion {
  /** Every ACTIVE assignment snapshot in the version. Cancelled rows are excluded by the caller. */
  readonly assignments: readonly CheckedAssignment[];
  /** Every `shift_types.code` defined in the group, for scope resolution. */
  readonly knownShiftTypeCodes: ReadonlySet<string>;
  /** Every `memberships.id` in the group, for scope resolution. */
  readonly knownMembershipIds: ReadonlySet<string>;
  readonly qualifications: QualificationFacts;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Findings
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * One reason a version cannot be asserted to satisfy the group's HARD rules.
 *
 * `breach` — the content violates the rule, and `explanation` says how.
 * `not-evaluable` — the rule is active and HARD and this checker cannot decide
 * it, so nothing may be asserted about it.
 *
 * Both are blocking at publication. Distinguishing them matters to the person
 * reading the refusal: one is "fix the schedule", the other is "this rule cannot
 * be enforced by the system yet — the M4 milestone owns the remaining kinds".
 */
export type HardRuleFindingKind = 'breach' | 'not-evaluable';

export interface HardRuleFinding {
  readonly finding: HardRuleFindingKind;
  /** The STABLE rule identifier (non-bypass rule 13). Always present. */
  readonly ruleKey: string;
  readonly nodeKind: RuleNodeKind;
  /**
   * The addressed field: the snapshot id for a per-assignment breach, the
   * membership id for a per-membership one, `'rule'` when the finding is about
   * the rule rather than about any one row.
   */
  readonly field: string;
  /** Non-clinical, identifier-bearing text. Never free text from a user (I-07). */
  readonly explanation: string;
}

/**
 * The node kinds this checker evaluates, and nothing else.
 *
 * Each one is here because SPEC-04 §3.1 (or the AST's own field documentation,
 * which is the same authority under FAD-21) pins its semantics without a choice
 * being made here. The other twenty-four kinds are listed with their reasons in
 * {@link NOT_EVALUABLE_REASONS}, reported per rule, and carried to M4.
 */
export const EVALUATED_HARD_RULE_KINDS = [
  'RequiresQualification',
  'MinimumRestBetween',
  'MaxConsecutive',
  'MaxAssignmentsInWindow',
  'CallSpacing',
  'AvoidDate',
] as const satisfies readonly RuleNodeKind[];

export type EvaluatedHardRuleKind = (typeof EVALUATED_HARD_RULE_KINDS)[number];

const EVALUATED = new Set<string>(EVALUATED_HARD_RULE_KINDS);

export function isEvaluatedHardRuleKind(kind: string): kind is EvaluatedHardRuleKind {
  return EVALUATED.has(kind);
}

/**
 * Why each unevaluated kind is unevaluated — stated per kind, never as a blanket
 * "not implemented".
 *
 * Three classes, and the distinction is the point:
 *
 *  - `grouping-unit-not-pinned` — the predicate is a count, and SPEC-04 §3.1
 *    does not say what it counts over (a shift row? a date? a date × shift
 *    type?). Any answer is a business rule this packet has no authority to make.
 *  - `constrains-the-search-not-the-content` — the node describes what a BUILD
 *    may do, not a property existing content can violate. Checking it against
 *    finished content would either always pass or invent a meaning.
 *  - `identifier-domain-not-pinned` / `data-not-modelled-at-m3` — the parameter
 *    names something the group's vocabulary cannot resolve today.
 */
export const NOT_EVALUABLE_REASONS: Readonly<Record<string, string>> = {
  RequiredCount:
    'grouping-unit-not-pinned: SPEC-04 §3.1 does not state whether the count is per shift row, ' +
    'per date, or per date × shift type',
  MinCoverage: 'grouping-unit-not-pinned: as RequiredCount',
  MaxCoverage: 'grouping-unit-not-pinned: as RequiredCount',
  MemberOfStaffGroup:
    'identifier-domain-not-pinned: `staffGroup` is neither a declared name nor a declared id',
  ValidGroupRestriction:
    'identifier-domain-not-pinned: `validGroup` is neither a declared name nor a declared id',
  PickPositionRestriction:
    'semantics-not-pinned: whether a NULL pick position (every manual assignment) satisfies or ' +
    'breaches the restriction is not stated',
  WeekdayFteLimit:
    'semantics-not-pinned: the accounting period the fraction is a limit OVER is not stated',
  WorkPercentageTarget: 'semantics-not-pinned: as WeekdayFteLimit; and a target is not a bound',
  NoAdjacent:
    'semantics-not-pinned: `adjacent` is not stated as consecutive calendar days or as ' +
    'back-to-back in time',
  ForbiddenSequence:
    'semantics-not-pinned: the sequence is a per-membership run of shift types, but nothing ' +
    'states whether the run must be the membership\'s CONSECUTIVE assignments (so an ' +
    'intervening third shift type breaks it) or merely its assignments in order (so an ' +
    'intervening shift type does not) — two readings that disagree on real rosters',
  PatternRule: 'constrains-the-search-not-the-content: a pattern prescribes what a build assigns',
  AlternatingWeek: 'constrains-the-search-not-the-content: as PatternRule',
  TemplateAdherence:
    'data-not-modelled-at-m3: `assignment_templates` does not exist yet (doc 06 §3.2)',
  LinkedShifts:
    'semantics-not-pinned: whether linkage binds the same membership, the same date, or both ' +
    'is not stated',
  ImpliesAssignment: 'semantics-not-pinned: as LinkedShifts',
  MutuallyExclusive: 'semantics-not-pinned: as LinkedShifts (exclusive over what window?)',
  RequestHonoured: 'data-not-modelled-at-m3: the request lifecycle is M5 (SPEC-08)',
  ShiftPreference: 'constrains-the-search-not-the-content: a preference is a ranking, not a bound',
  FairnessBalance:
    'constrains-the-search-not-the-content: a balance metric has no pinned threshold to breach',
  CreditDistribution: 'constrains-the-search-not-the-content: as FairnessBalance',
  StaffOverLocumPriority:
    'data-not-modelled-at-m3: no membership attribute distinguishes a locum (doc 06 §3.2)',
  LocumRestriction: 'data-not-modelled-at-m3: as StaffOverLocumPriority',
  FixedAssignment:
    'identifier-domain-not-pinned: `assignmentIdentity` is documented as a KEY, and ' +
    '`assignment_identities` carries no key column',
  ProtectedRange:
    'constrains-the-search-not-the-content: a protected range bounds what a build may CHANGE',
};

/* ────────────────────────────────────────────────────────────────────────────
 * Scope resolution
 * ──────────────────────────────────────────────────────────────────────────── */

/** `null` means the scope resolved; a string is the reason it did not. */
function scopeUnresolvable(rule: CompiledRule, version: CheckedVersion): string | null {
  if (rule.scope.staffGroups.length > 0) {
    return 'scope.staffGroups is not resolvable: the identifier domain is not pinned by SPEC-04 §3.1';
  }
  for (const code of rule.scope.shiftTypes) {
    if (!version.knownShiftTypeCodes.has(code)) {
      return `scope.shiftTypes names ${code}, which is not a shift-type code in this group`;
    }
  }
  for (const membershipId of rule.scope.memberships) {
    if (!version.knownMembershipIds.has(membershipId)) {
      return `scope.memberships names ${membershipId}, which is not a membership in this group`;
    }
  }
  return null;
}

/** The assignments a rule applies to, after its scope filter. Order preserved. */
function scopedAssignments(
  rule: CompiledRule,
  assignments: readonly CheckedAssignment[],
): readonly CheckedAssignment[] {
  const shiftTypes = new Set(rule.scope.shiftTypes);
  const memberships = new Set(rule.scope.memberships);
  const range = rule.scope.dateRange;
  return assignments.filter((assignment) => {
    if (range !== null && (assignment.date < range.from || assignment.date > range.to)) return false;
    if (shiftTypes.size > 0 && !shiftTypes.has(assignment.shiftTypeCode)) return false;
    if (memberships.size > 0 && !memberships.has(assignment.membershipId)) return false;
    return true;
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Small date helpers — string arithmetic only, no `Date` and no timezone
 * ──────────────────────────────────────────────────────────────────────────── */

const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` to a day number, by UTC epoch days. Total on a validated date. */
export function dayNumber(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  return Math.floor(Date.UTC(year, month - 1, day) / MS_PER_DAY);
}

/* ────────────────────────────────────────────────────────────────────────────
 * The evaluated kinds
 * ──────────────────────────────────────────────────────────────────────────── */

function byMembership(
  assignments: readonly CheckedAssignment[],
): ReadonlyMap<string, CheckedAssignment[]> {
  const out = new Map<string, CheckedAssignment[]>();
  for (const assignment of assignments) {
    const list = out.get(assignment.membershipId);
    if (list === undefined) out.set(assignment.membershipId, [assignment]);
    else list.push(assignment);
  }
  return out;
}

/**
 * Deterministic order for every per-membership walk: by start instant, then by
 * snapshot id so equal instants never depend on the database's row order. A
 * checker whose findings depend on read order is a checker whose red case passes
 * on Tuesday.
 */
function chronological(assignments: readonly CheckedAssignment[]): CheckedAssignment[] {
  return [...assignments].sort(
    (a, b) => a.startsAtMs - b.startsAtMs || (a.snapshotId < b.snapshotId ? -1 : 1),
  );
}

function checkRequiresQualification(
  rule: CompiledRule,
  scoped: readonly CheckedAssignment[],
  version: CheckedVersion,
): HardRuleFinding[] {
  const params = rule.params as { qualification?: unknown };
  const key = typeof params.qualification === 'string' ? params.qualification : null;
  if (key === null) {
    return [notEvaluable(rule, 'the compiled `qualification` parameter is not a string')];
  }
  if (!version.qualifications.knownQualificationKeys.has(key)) {
    return [
      notEvaluable(
        rule,
        `it requires qualification ${key}, which is not in this group's qualification vocabulary`,
      ),
    ];
  }

  const findings: HardRuleFinding[] = [];
  for (const assignment of chronological(scoped)) {
    if (version.qualifications.heldOn(assignment.membershipId, key, assignment.date)) continue;
    findings.push({
      finding: 'breach',
      ruleKey: rule.ruleKey,
      nodeKind: rule.kind,
      field: assignment.snapshotId,
      explanation:
        `membership ${assignment.membershipId} is assigned on ${assignment.date} ` +
        `(${assignment.shiftTypeCode}) without a valid ${key} holding on that date`,
    });
  }
  return findings;
}

function checkMinimumRestBetween(
  rule: CompiledRule,
  scoped: readonly CheckedAssignment[],
): HardRuleFinding[] {
  const params = rule.params as { minHours?: unknown };
  const minHours = typeof params.minHours === 'number' ? params.minHours : null;
  if (minHours === null) {
    return [notEvaluable(rule, 'the compiled `minHours` parameter is not a number')];
  }
  const minMs = minHours * 3_600_000;

  const findings: HardRuleFinding[] = [];
  for (const [membershipId, list] of byMembership(scoped)) {
    const ordered = chronological(list);
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      if (previous === undefined || current === undefined) continue;
      const rest = current.startsAtMs - previous.endsAtMs;
      if (rest >= minMs) continue;
      findings.push({
        finding: 'breach',
        ruleKey: rule.ruleKey,
        nodeKind: rule.kind,
        field: current.snapshotId,
        explanation:
          `membership ${membershipId} has ${(rest / 3_600_000).toFixed(2)} hours of rest before ` +
          `the assignment on ${current.date}, and this rule requires ${String(minHours)}`,
      });
    }
  }
  return findings;
}

function checkMaxConsecutive(
  rule: CompiledRule,
  scoped: readonly CheckedAssignment[],
): HardRuleFinding[] {
  const params = rule.params as { maxDays?: unknown };
  const maxDays = typeof params.maxDays === 'number' ? params.maxDays : null;
  if (maxDays === null) {
    return [notEvaluable(rule, 'the compiled `maxDays` parameter is not a number')];
  }

  const findings: HardRuleFinding[] = [];
  for (const [membershipId, list] of byMembership(scoped)) {
    const days = [...new Set(list.map((assignment) => dayNumber(assignment.date)))].sort(
      (a, b) => a - b,
    );
    let runStart = 0;
    let run = 0;
    for (let index = 0; index < days.length; index += 1) {
      const day = days[index];
      const previous = days[index - 1];
      if (day === undefined) continue;
      if (index === 0 || previous === undefined || day !== previous + 1) {
        runStart = day;
        run = 1;
      } else {
        run += 1;
      }
      if (run === maxDays + 1) {
        findings.push({
          finding: 'breach',
          ruleKey: rule.ruleKey,
          nodeKind: rule.kind,
          field: membershipId,
          explanation:
            `membership ${membershipId} works ${String(run)} consecutive days from ` +
            `${isoOfDayNumber(runStart)}, and this rule permits ${String(maxDays)}`,
        });
      }
    }
  }
  return findings;
}

function checkMaxAssignmentsInWindow(
  rule: CompiledRule,
  scoped: readonly CheckedAssignment[],
): HardRuleFinding[] {
  const params = rule.params as { max?: unknown; windowDays?: unknown };
  const max = typeof params.max === 'number' ? params.max : null;
  const windowDays = typeof params.windowDays === 'number' ? params.windowDays : null;
  if (max === null || windowDays === null) {
    return [notEvaluable(rule, 'the compiled `max`/`windowDays` parameters are not numbers')];
  }

  /* A ROLLING window, and that is a reading rather than a choice: the node
   * carries no anchor date and no alignment field, so a calendar-aligned window
   * would have to invent one. Every window that could contain a breach starts on
   * a day that has an assignment, so the walk below is exhaustive without being a
   * search. */
  const findings: HardRuleFinding[] = [];
  for (const [membershipId, list] of byMembership(scoped)) {
    const days = list.map((assignment) => dayNumber(assignment.date)).sort((a, b) => a - b);
    const starts = [...new Set(days)];
    for (const start of starts) {
      const end = start + windowDays - 1;
      const count = days.filter((day) => day >= start && day <= end).length;
      if (count <= max) continue;
      findings.push({
        finding: 'breach',
        ruleKey: rule.ruleKey,
        nodeKind: rule.kind,
        field: membershipId,
        explanation:
          `membership ${membershipId} has ${String(count)} assignments in the ` +
          `${String(windowDays)}-day window from ${isoOfDayNumber(start)}, and this rule ` +
          `permits ${String(max)}`,
      });
      // One finding per membership: the remaining overlapping windows describe
      // the same breach, and repeating them would bury it.
      break;
    }
  }
  return findings;
}

/**
 * `CallSpacing(minDaysBetweenCalls)` — B-2.
 *
 * ## What is pinned, and by what
 *
 * SPEC-04 §3.1 files this node under **"Rest and call spacing"**, and the field
 * is `minDaysBetweenCalls`. Three things follow without a choice being made here:
 *
 *  - **the subject is a CALL** — `shift_types.is_on_call`, the one attribute in
 *    the system that says a shift is one (migration 0005). A shift that is not a
 *    call is not a call and is ignored entirely, which is why the non-call arm has
 *    its own test;
 *  - **the unit is DAYS**, from the field name, so the measure is the difference
 *    between two calendar day numbers — not hours, and not "nights between";
 *  - **the scope is one membership**, as for every other spacing kind. Spacing
 *    between two different people's calls is not a statement about anything.
 *
 * The comparison is `>=`, the same reading `MinimumRestBetween` uses for its own
 * minimum: `minDaysBetweenCalls = 3` means Monday and Thursday are legal (a
 * difference of 3) and Monday and Wednesday are not (2). Two calls on one day are
 * a difference of 0 and breach under any reading.
 *
 * **Only consecutive calls are compared.** A run of three where the first and
 * second are too close reports once, on the second; reporting every later pair
 * against every earlier one would bury the fix under arithmetic.
 */
function checkCallSpacing(
  rule: CompiledRule,
  scoped: readonly CheckedAssignment[],
): HardRuleFinding[] {
  const params = rule.params as { minDaysBetweenCalls?: unknown };
  const minDays =
    typeof params.minDaysBetweenCalls === 'number' ? params.minDaysBetweenCalls : null;
  if (minDays === null) {
    return [notEvaluable(rule, 'the compiled `minDaysBetweenCalls` parameter is not a number')];
  }

  const findings: HardRuleFinding[] = [];
  for (const [membershipId, list] of byMembership(scoped)) {
    const calls = chronological(list.filter((assignment) => assignment.isOnCall));
    for (let index = 1; index < calls.length; index += 1) {
      const previous = calls[index - 1];
      const current = calls[index];
      if (previous === undefined || current === undefined) continue;
      const gap = dayNumber(current.date) - dayNumber(previous.date);
      if (gap >= minDays) continue;
      findings.push({
        finding: 'breach',
        ruleKey: rule.ruleKey,
        nodeKind: rule.kind,
        field: current.snapshotId,
        explanation:
          `membership ${membershipId} is on call on ${current.date}, ${String(gap)} day(s) after ` +
          `the call on ${previous.date}; this rule requires ${String(minDays)}`,
      });
    }
  }
  return findings;
}

/**
 * `AvoidDate(date)` — no scoped assignment falls ON that date.
 *
 * ## The attribution this uses, stated because it is a choice about a boundary
 *
 * "On that date" means `assignment_snapshots.date` — the shift's **start** date,
 * the single canonical date the schema anchors an assignment to. So a 22:00→06:00
 * shift starting the day BEFORE an avoided date, and running into it, does **not**
 * breach: it is attributed to its start date, as it is everywhere else in this
 * system (the daily sheet, the grid, D-1a).
 *
 * That is a defensible reading and it is not the only one. "Nobody works on the
 * 25th" could reasonably mean "no working minute falls on the 25th", which the
 * overnight shift does violate. The two readings disagree on exactly the rosters
 * where the answer matters most, and SPEC-04 §3.1 does not choose between them.
 *
 * **So the shipped semantics is start-date equality, it is pinned by a test
 * (`an overnight shift running INTO the avoided date does not breach`), and the
 * attribution question is carried to the owner in
 * `docs/evidence/EV-M3-INTEGRATION/step-06-node-kinds.md` §5 rather than being
 * changed silently.** Changing it later is a ruling, not a bug fix.
 */
function checkAvoidDate(
  rule: CompiledRule,
  scoped: readonly CheckedAssignment[],
): HardRuleFinding[] {
  const params = rule.params as { date?: unknown };
  const date = typeof params.date === 'string' ? params.date : null;
  if (date === null) {
    return [notEvaluable(rule, 'the compiled `date` parameter is not a string')];
  }
  return chronological(scoped)
    .filter((assignment) => assignment.date === date)
    .map((assignment) => ({
      finding: 'breach' as const,
      ruleKey: rule.ruleKey,
      nodeKind: rule.kind,
      field: assignment.snapshotId,
      explanation:
        `membership ${assignment.membershipId} is assigned on ${date}, which this rule forbids`,
    }));
}

function isoOfDayNumber(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

function notEvaluable(rule: CompiledRule, reason: string): HardRuleFinding {
  return {
    finding: 'not-evaluable',
    ruleKey: rule.ruleKey,
    nodeKind: rule.kind,
    field: 'rule',
    explanation: reason,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * The entry point
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Evaluate every compiled rule against the version's content and return every
 * finding, in a deterministic order.
 *
 * **Only `role: 'constraint'` elements are considered.** A `SOFT` rule compiles
 * to `role: 'objective'` and is not a publication prerequisite — SPEC-04 §3.3's
 * hard/soft split is structural in the compiler, and this function honours the
 * same side of it rather than re-deriving the classification.
 */
export function evaluateHardRules(
  compiled: readonly CompiledRule[],
  version: CheckedVersion,
): readonly HardRuleFinding[] {
  const findings: HardRuleFinding[] = [];

  /**
   * OPUS-M4-000C (doc 34 §4-D): the checker's MEMORY bound, per rule.
   *
   * A HARD rule that breaches on every one of ten thousand assignments produces
   * one refusal either way — the publication is blocked by the first finding.
   * The ten-thousandth explanation adds nothing a scheduler will read and the
   * allocation is real, so the list is capped and the cap is DECLARED in the
   * findings rather than silently applied: a truncated list that looked complete
   * would be a worse answer than a long one.
   */
  const capped = (rule: CompiledRule, produced: readonly HardRuleFinding[]): HardRuleFinding[] => {
    if (produced.length <= AST_BOUNDS.maxFindingsPerRule) return [...produced];
    return [
      ...produced.slice(0, AST_BOUNDS.maxFindingsPerRule),
      {
        finding: 'breach',
        ruleKey: rule.ruleKey,
        nodeKind: rule.kind,
        field: 'rule',
        explanation:
          `this rule produced ${String(produced.length)} findings; the first ` +
          `${String(AST_BOUNDS.maxFindingsPerRule)} are listed and the rest are not enumerated ` +
          '(the evaluation memory bound). Publication is blocked either way.',
      },
    ];
  };

  for (const rule of [...compiled].sort((a, b) => (a.ruleKey < b.ruleKey ? -1 : 1))) {
    if (rule.role !== 'constraint') continue;

    if (!isEvaluatedHardRuleKind(rule.kind)) {
      findings.push(
        notEvaluable(
          rule,
          NOT_EVALUABLE_REASONS[rule.kind] ?? 'this node kind has no declared evaluation semantics',
        ),
      );
      continue;
    }

    const unresolvable = scopeUnresolvable(rule, version);
    if (unresolvable !== null) {
      findings.push(notEvaluable(rule, unresolvable));
      continue;
    }

    const scoped = scopedAssignments(rule, version.assignments);
    switch (rule.kind) {
      case 'RequiresQualification':
        findings.push(...capped(rule, checkRequiresQualification(rule, scoped, version)));
        break;
      case 'MinimumRestBetween':
        findings.push(...capped(rule, checkMinimumRestBetween(rule, scoped)));
        break;
      case 'MaxConsecutive':
        findings.push(...capped(rule, checkMaxConsecutive(rule, scoped)));
        break;
      case 'MaxAssignmentsInWindow':
        findings.push(...capped(rule, checkMaxAssignmentsInWindow(rule, scoped)));
        break;
      case 'CallSpacing':
        findings.push(...capped(rule, checkCallSpacing(rule, scoped)));
        break;
      case 'AvoidDate':
        findings.push(...capped(rule, checkAvoidDate(rule, scoped)));
        break;
      /* No `default`: `isEvaluatedHardRuleKind` narrowed the kind to the closed
       * evaluated set above, so adding a kind to that set without adding a case
       * here fails to compile. That is the same discipline the compiler's own
       * `assertNever` provides, expressed where it belongs. */
    }
  }

  return findings;
}

/** Convenience: does this set of findings block a publication? */
export function blocksPublication(findings: readonly HardRuleFinding[]): boolean {
  return findings.length > 0;
}
