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
 * ## OPUS-M4-002: six kinds became twenty-two, and why that is not a rewrite
 *
 * The eleven RK-RULINGs (doc 35 §6d, ratified as FAD-38's context) pinned the
 * semantics that were open at M3 — the coverage grouping unit, the two
 * identifier domains, the NULL pick position, the weekday-FTE accounting period,
 * adjacency, sequence, linkage, the fixed-assignment key. **Nothing here got
 * cleverer; the questions got answered.** Each new function names its ruling.
 *
 * Three kinds — `PatternRule`, `AlternatingWeek`, `ProtectedRange` — arrive by a
 * different route, and the distinction matters (FAD-38(5)). Their M3 reason
 * *stands, unmodified*: against **finished content** a pattern really does
 * prescribe what a build assigns and a protected range really does bound what a
 * build may change, and checking either against a version in isolation would
 * still either always pass or invent a meaning. What M4-002 asks is a **different
 * question** — is this *candidate* consistent with the *fixed inputs the build
 * was given*? — and that one is answerable, as an implication rather than a
 * prescription. The registry has assigned these kinds the `solver-and-validator`
 * owner since M4-000C, whose documented meaning is "M4-002 compiles it as a
 * constraint AND an independent validator re-checks it — never one without the
 * other". This file is that second half.
 *
 * ## The checker shares no line with the solver
 *
 * SPEC-04 §3.3 requires re-validation by an **independent** checker, and
 * independence here is structural rather than promised: this is TypeScript over
 * finished content in a dependency-free package; the model is Python over the
 * request. The only artefacts in common are the AST node types and the ruling
 * text. A translation bug in the model therefore cannot hide behind a matching
 * bug here, because there is nothing for it to match.
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
import type { DateRange, RuleNodeKind, RuleWeekday } from './ast.js';

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
  /**
   * `assignment_snapshots.pick_position`, when the caller carries it
   * (OPUS-M4-002, RK-RULING-04).
   *
   * Three states, and they are three: a **number** is a real draft position;
   * **`null`** is the position every manual assignment and every solver-produced
   * assignment carries, and RK-RULING-04 rules it out of scope of the
   * restriction — it satisfies vacuously, because a restriction *about* pick
   * positions makes no statement about an assignment that has none, and breaching
   * on absence would manufacture a violation out of nothing (the FAD-23 class);
   * **absent** (`undefined`) means the caller did not carry the column at all,
   * which is not the same as carrying it as null, and makes
   * `PickPositionRestriction` `not-evaluable` rather than vacuously satisfied.
   *
   * Optional so the shipped publication caller compiles unchanged (FAD-38(6)).
   */
  readonly pickPosition?: number | null;
}

/**
 * One assignment as it stood BEFORE the candidate — the fixed input a build was
 * given (OPUS-M4-002).
 *
 * `FixedAssignment` and `ProtectedRange` are the two kinds that are statements
 * about a *change*, so they cannot be decided from the candidate alone: "this
 * identity is pinned" and "nothing in this range moved" both need to know what
 * was there. The snapshot's `fixedAssignments` is exactly that record —
 * SPEC-04 §6's "a later build's fixed inputs are **recorded rather than
 * inferred**".
 */
export interface CandidatePriorAssignment {
  readonly assignmentIdentityId: string;
  readonly membershipId: string;
  /** `YYYY-MM-DD`, the same start-date attribution the rest of this module uses. */
  readonly date: string;
  readonly shiftTypeCode: string;
  readonly isPinned: boolean;
}

/**
 * The extra facts the rulings need, supplied by a caller that has them
 * (OPUS-M4-002; accepted as the `candidateFacts` seam, FAD-38(6)).
 *
 * ## Why this is ONE optional field rather than eight
 *
 * The shipped publication caller (`apps/api/src/schedule/hard-rule-revalidation.ts`)
 * knows a version's assignment rows and its qualification holdings and nothing
 * else — it has no demand horizon, no staff-group edges, no work profiles. Making
 * the new inputs individually optional would let a caller supply four of eight
 * and get a confident answer computed from half a world.
 *
 * One field, all-or-nothing: a caller either speaks the candidate vocabulary or
 * it does not. When it does not, the eight kinds that need it report
 * `not-evaluable` — which **blocks** (FAD-27) — so the publication path's
 * behaviour is preserved exactly and a caller with less information gets less
 * certainty rather than a false pass.
 *
 * Everything here is a **function or a set**, never a nested map with a composite
 * key: the caller decides how to index its own data and this module never has to
 * agree with it about a separator (the same lesson `QualificationFacts` records
 * one interface up).
 */
export interface CandidateFacts {
  /**
   * The build horizon — the period's inclusive date range.
   *
   * Coverage and weekday-FTE accounting need to know which dates EXIST, not just
   * which ones happen to carry an assignment: "exactly two people every day" is
   * breached by a day with nobody on it, and a checker that only walked the rows
   * it was given could never see an empty day.
   */
  readonly horizon: DateRange;
  /** `staff_groups.id` — the domain RK-RULING-02 pins. */
  readonly knownStaffGroupIds: ReadonlySet<string>;
  /** The memberships in a staff group, or `null` when the id is unknown. */
  staffGroupMembers(staffGroupId: string): ReadonlySet<string> | null;
  /** `valid_groups.id` — the domain RK-RULING-03 pins. */
  readonly knownValidGroupIds: ReadonlySet<string>;
  /** The shift-type CODES a valid group admits, or `null` when the id is unknown. */
  validGroupShiftTypes(validGroupId: string): ReadonlySet<string> | null;
  /**
   * The in-force weekday target for a membership, from the snapshot's work
   * profile (S-03). `null` when the membership has no profile or no target for
   * that weekday — an absence, never a zero.
   */
  weekdayTarget(
    membershipId: string,
    weekday: RuleWeekday,
  ): { readonly fteFraction: number; readonly maxAssignments: number | null } | null;
  /** The in-force `work_percentage`, or `null` when no profile is in force. */
  workPercentage(membershipId: string): number | null;
  /** What the build was given. See {@link CandidatePriorAssignment}. */
  readonly priorAssignments: readonly CandidatePriorAssignment[];
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
  /**
   * The OPUS-M4-002 seam (FAD-38(6)). Absent for a caller that has only a
   * version's rows; present for the solver candidate validator.
   *
   * Absent is not a degraded mode that guesses — it makes the eight kinds that
   * need it `not-evaluable`, which blocks.
   */
  readonly candidateFacts?: CandidateFacts;
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
  /* ── M3-008: decidable from the version's own rows ─────────────────────────*/
  'RequiresQualification',
  'MinimumRestBetween',
  'MaxConsecutive',
  'MaxAssignmentsInWindow',
  'CallSpacing',
  'AvoidDate',
  /* ── OPUS-M4-002: the rulings (doc 35 §6d), sixteen more ───────────────────
   * Each one is here because a ruling pinned the semantics that were open at
   * M3 — never because the checker got cleverer. The eight that need input
   * beyond the assignment rows take it from {@link CandidateFacts}, and report
   * `not-evaluable` when a caller does not supply it, so a caller with less
   * information gets less certainty rather than a false pass. */
  'RequiredCount', // RK-RULING-01
  'MinCoverage', // RK-RULING-01
  'MaxCoverage', // RK-RULING-01
  'MemberOfStaffGroup', // RK-RULING-02
  'ValidGroupRestriction', // RK-RULING-03
  'PickPositionRestriction', // RK-RULING-04
  'WeekdayFteLimit', // RK-RULING-05 (authored here)
  'NoAdjacent', // RK-RULING-07
  'ForbiddenSequence', // RK-RULING-08
  'LinkedShifts', // RK-RULING-09
  'ImpliesAssignment', // RK-RULING-09
  'MutuallyExclusive', // RK-RULING-09
  'FixedAssignment', // RK-RULING-10
  /* The `solver-and-validator` owner, EXECUTED (FAD-38(5)). See the module
   * docblock: their M3 reason — that they constrain the SEARCH — stands
   * unmodified. What is answered here is a different question. */
  'PatternRule',
  'AlternatingWeek',
  'ProtectedRange',
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
  /* ── The four the packet names FAIL CLOSED, each with its named owner ──────
   * Non-bypass rule 11: none of these is dropped, narrowed or deferred without
   * a name. Each blocks, each says whose input it is waiting for, and each is
   * carried in the generated registry with that owner beside it. */
  TemplateAdherence:
    'data-not-modelled-at-m3: `assignment_templates` does not exist yet (doc 06 §3.2). ' +
    'OWNER: templates-slice',
  RequestHonoured:
    'data-not-modelled-at-m3: the request lifecycle is M5 (SPEC-08). OWNER: M5-requests',
  StaffOverLocumPriority:
    'data-not-modelled-at-m3: no membership attribute distinguishes a locum for PRIORITY ' +
    'purposes — `memberships.staffing_kind` says what somebody IS, not the window a priority ' +
    'rule ranks over (doc 06 §3.2). OWNER: locum-slice',
  LocumRestriction: 'data-not-modelled-at-m3: as StaffOverLocumPriority. OWNER: locum-slice',

  /* ── The four SOFT-natural objective kinds ─────────────────────────────────
   * These compile to E1 objective terms (SPEC-04 §3.3: SOFT → objective term).
   * A HARD authoring of one of them is a contradiction rather than a gap, and
   * the class name says so: there is no content a candidate could contain that
   * would make "the preference was not honoured strongly enough" a BREACH, so
   * nothing can be asserted about it and the rule blocks. That is fail-closed,
   * not silence — the alternative would be inventing a threshold. */
  WorkPercentageTarget:
    'classification-contradiction: RK-RULING-06 rules a WorkPercentageTarget a TARGET and never ' +
    'a bound — it compiles to a SOFT objective term penalising |achieved − target|. A HARD ' +
    'authoring has no defined breach, so nothing may be asserted about it',
  ShiftPreference:
    'classification-contradiction: a preference is a ranking, not a bound; it compiles to a ' +
    'SOFT objective term. A HARD authoring has no defined breach',
  FairnessBalance:
    'classification-contradiction: a balance metric has no pinned threshold to breach; it ' +
    'compiles to a SOFT objective term. A HARD authoring has no defined breach',
  CreditDistribution: 'classification-contradiction: as FairnessBalance',
};

/* ────────────────────────────────────────────────────────────────────────────
 * Scope resolution
 * ──────────────────────────────────────────────────────────────────────────── */

/** `null` means the scope resolved; a string is the reason it did not. */
function scopeUnresolvable(rule: CompiledRule, version: CheckedVersion): string | null {
  /* RK-RULING-02 pinned the domain to `staff_groups.id`, so this filter is now
   * resolvable — but only for a caller that carries the vocabulary. Before the
   * ruling this arm refused EVERY rule of EVERY kind whose scope named a staff
   * group, which is what made `B-ruleheavy` unbuildable. It still refuses when
   * the id is unknown or the vocabulary is absent: a scope that cannot be
   * resolved narrows to something unknown, and a rule evaluated over an unknown
   * subset is a rule evaluated over the wrong one. */
  if (rule.scope.staffGroups.length > 0) {
    const facts = version.candidateFacts;
    if (facts === undefined) {
      return `scope.staffGroups is not resolvable: ${MISSING_CANDIDATE_FACTS}`;
    }
    for (const staffGroupId of rule.scope.staffGroups) {
      if (facts.knownStaffGroupIds.has(staffGroupId)) continue;
      return (
        `scope.staffGroups names ${staffGroupId}, which is not a staff-group id in this group ` +
        '(RK-RULING-02 pins the domain to staff_groups.id)'
      );
    }
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
  version: CheckedVersion,
): readonly CheckedAssignment[] {
  const shiftTypes = new Set(rule.scope.shiftTypes);
  const memberships = new Set(rule.scope.memberships);
  const range = rule.scope.dateRange;

  /* RK-RULING-02: `scope.staffGroups` is a real filter now that the domain is
   * pinned. The UNION across the named groups, because naming two groups scopes
   * a rule to both — an intersection would make a two-group scope narrower than
   * either one alone, which is the opposite of what naming another group reads
   * as. `scopeUnresolvable` has already refused an unknown id, so every lookup
   * here resolves. */
  let staffGroupMembers: Set<string> | null = null;
  if (rule.scope.staffGroups.length > 0 && version.candidateFacts !== undefined) {
    staffGroupMembers = new Set<string>();
    for (const staffGroupId of rule.scope.staffGroups) {
      for (const id of version.candidateFacts.staffGroupMembers(staffGroupId) ?? []) {
        staffGroupMembers.add(id);
      }
    }
  }

  return assignments.filter((assignment) => {
    if (range !== null && (assignment.date < range.from || assignment.date > range.to)) return false;
    if (shiftTypes.size > 0 && !shiftTypes.has(assignment.shiftTypeCode)) return false;
    if (memberships.size > 0 && !memberships.has(assignment.membershipId)) return false;
    if (staffGroupMembers !== null && !staffGroupMembers.has(assignment.membershipId)) return false;
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

/* ────────────────────────────────────────────────────────────────────────────
 * OPUS-M4-002 — the ruled kinds
 *
 * Every function below implements exactly one RK-RULING and cites it. None of
 * them shares a line with the solver: the model is Python over the request, this
 * is TypeScript over finished content, and the only things the two have in
 * common are the AST types and the ruling text. That is the independence
 * SPEC-04 §3.3 requires — "trusting the solver to have honoured what we asked
 * would make a translation bug indistinguishable from a correct schedule".
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * `1970-01-01` was a **Thursday**, so epoch day 0 is Thursday.
 *
 * Written as a rotated table rather than as `(dayNumber + 4) % 7` because the
 * `+ 4` is the whole content of the rule and an unexplained constant in a
 * weekday computation is where off-by-one lives.
 */
const WEEKDAY_OF_EPOCH_DAY: readonly RuleWeekday[] = [
  'thu',
  'fri',
  'sat',
  'sun',
  'mon',
  'tue',
  'wed',
];

/** The `RuleWeekday` a real calendar date falls on. Never `'holiday'` — see below. */
export function weekdayOfDate(date: string): RuleWeekday {
  const index = ((dayNumber(date) % 7) + 7) % 7;
  return WEEKDAY_OF_EPOCH_DAY[index] as RuleWeekday;
}

/** Every date in an inclusive range, ascending. Bounded by the caller's horizon. */
function datesInRange(range: DateRange): string[] {
  const from = dayNumber(range.from);
  const to = dayNumber(range.to);
  const dates: string[] = [];
  for (let day = from; day <= to; day += 1) dates.push(isoOfDayNumber(day));
  return dates;
}

/**
 * The window a rule accounts OVER: its scope's date range intersected with the
 * build horizon, or the horizon when the scope names none.
 *
 * The intersection is a refinement of RK-RULING-05's "over the PERIOD" and it is
 * necessary rather than decorative: a rule scoped to one fortnight of a
 * two-month period that counted the whole period's Mondays would permit roughly
 * four times the assignments it was authored to permit. `null` when the two do
 * not overlap at all, which makes the rule vacuous rather than breached.
 */
function accountingWindow(rule: CompiledRule, horizon: DateRange): DateRange | null {
  const scope = rule.scope.dateRange;
  if (scope === null) return horizon;
  const from = scope.from > horizon.from ? scope.from : horizon.from;
  const to = scope.to < horizon.to ? scope.to : horizon.to;
  return from > to ? null : { from, to };
}

/**
 * **RK-RULING-01 — the coverage grouping unit is date × shift type.**
 *
 * The demand model's own unit (FAD-16 weekday defaults; period requirements per
 * shift type). Location is deliberately NOT a coverage dimension in M4: R-B6
 * makes location display metadata and a shift without one is legal, so a
 * per-location count would be counting over a dimension the demand model does
 * not have. That is recorded as a future owner question, not dropped.
 *
 * The count is taken over **every (date, shift type) pair the scope admits**,
 * including pairs with no assignment at all — which is the case that matters.
 * A `RequiredCount(2)` is breached by a day with nobody on it, and a checker
 * that walked only the rows it was handed could not see an empty day. That is
 * why coverage needs {@link CandidateFacts.horizon} and reports `not-evaluable`
 * without it.
 *
 * The shift types counted over are the scope's when it names any, and the
 * group's whole vocabulary otherwise — the same widening the scope filter
 * already performs on assignments.
 */
function checkCoverage(
  rule: CompiledRule,
  scoped: readonly CheckedAssignment[],
  version: CheckedVersion,
  bound: { readonly kind: 'exact' | 'min' | 'max'; readonly value: number },
): HardRuleFinding[] {
  const facts = version.candidateFacts;
  if (facts === undefined) return [notEvaluable(rule, MISSING_CANDIDATE_FACTS)];
  if (!Number.isFinite(bound.value)) {
    return [notEvaluable(rule, 'the compiled coverage bound is not a number')];
  }
  const window = accountingWindow(rule, facts.horizon);
  if (window === null) return [];

  const codes =
    rule.scope.shiftTypes.length > 0
      ? [...rule.scope.shiftTypes].sort()
      : [...version.knownShiftTypeCodes].sort();

  const counts = new Map<string, number>();
  for (const assignment of scoped) {
    const key = `${assignment.date}\x00${assignment.shiftTypeCode}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const findings: HardRuleFinding[] = [];
  for (const date of datesInRange(window)) {
    for (const code of codes) {
      const count = counts.get(`${date}\x00${code}`) ?? 0;
      const breached =
        bound.kind === 'exact'
          ? count !== bound.value
          : bound.kind === 'min'
            ? count < bound.value
            : count > bound.value;
      if (!breached) continue;
      findings.push({
        finding: 'breach',
        ruleKey: rule.ruleKey,
        nodeKind: rule.kind,
        field: `${date}/${code}`,
        explanation:
          `${date} (${code}) carries ${String(count)} scoped assignments; this rule requires ` +
          `${bound.kind === 'exact' ? 'exactly' : bound.kind === 'min' ? 'at least' : 'at most'} ` +
          String(bound.value),
      });
    }
  }
  return findings;
}

/**
 * **RK-RULING-02 — `staffGroup` is `staff_groups.id`, never a name.**
 *
 * A name is mutable display; a rename must not change what a rule historically
 * meant (non-bypass rule 13's spirit). Authoring resolves the name to the id at
 * save, so the stored AST is already in the stable domain.
 *
 * Every scoped assignment's assignee must be a member of the named group. An
 * unknown id is `not-evaluable`, never "nobody is in it" — the second reading
 * would turn a typo into a breach of every row.
 */
function checkMemberOfStaffGroup(
  rule: CompiledRule,
  scoped: readonly CheckedAssignment[],
  version: CheckedVersion,
): HardRuleFinding[] {
  const facts = version.candidateFacts;
  if (facts === undefined) return [notEvaluable(rule, MISSING_CANDIDATE_FACTS)];
  const params = rule.params as { staffGroup?: unknown };
  const staffGroupId = typeof params.staffGroup === 'string' ? params.staffGroup : null;
  if (staffGroupId === null) {
    return [notEvaluable(rule, 'the compiled `staffGroup` parameter is not a string')];
  }
  const members = facts.staffGroupMembers(staffGroupId);
  if (members === null) {
    return [
      notEvaluable(
        rule,
        `it names staff group ${staffGroupId}, which is not a staff-group id in this group ` +
          '(RK-RULING-02 pins the domain to staff_groups.id)',
      ),
    ];
  }

  return chronological(scoped)
    .filter((assignment) => !members.has(assignment.membershipId))
    .map((assignment) => ({
      finding: 'breach' as const,
      ruleKey: rule.ruleKey,
      nodeKind: rule.kind,
      field: assignment.snapshotId,
      explanation:
        `membership ${assignment.membershipId} is assigned on ${assignment.date} ` +
        `(${assignment.shiftTypeCode}) and is not a member of staff group ${staffGroupId}`,
    }));
}

/**
 * **RK-RULING-03 — `validGroup` is `valid_groups.id`, never a name.** Same
 * reasoning as RK-RULING-02.
 *
 * A valid group names the shift types it admits (`valid_group_shift_types`), so
 * the content statement is: no scoped assignment is on a shift type the named
 * valid group does not admit.
 */
function checkValidGroupRestriction(
  rule: CompiledRule,
  scoped: readonly CheckedAssignment[],
  version: CheckedVersion,
): HardRuleFinding[] {
  const facts = version.candidateFacts;
  if (facts === undefined) return [notEvaluable(rule, MISSING_CANDIDATE_FACTS)];
  const params = rule.params as { validGroup?: unknown };
  const validGroupId = typeof params.validGroup === 'string' ? params.validGroup : null;
  if (validGroupId === null) {
    return [notEvaluable(rule, 'the compiled `validGroup` parameter is not a string')];
  }
  const admitted = facts.validGroupShiftTypes(validGroupId);
  if (admitted === null) {
    return [
      notEvaluable(
        rule,
        `it names valid group ${validGroupId}, which is not a valid-group id in this group ` +
          '(RK-RULING-03 pins the domain to valid_groups.id)',
      ),
    ];
  }

  return chronological(scoped)
    .filter((assignment) => !admitted.has(assignment.shiftTypeCode))
    .map((assignment) => ({
      finding: 'breach' as const,
      ruleKey: rule.ruleKey,
      nodeKind: rule.kind,
      field: assignment.snapshotId,
      explanation:
        `the assignment on ${assignment.date} is on shift type ${assignment.shiftTypeCode}, ` +
        `which valid group ${validGroupId} does not admit`,
    }));
}

/**
 * **RK-RULING-04 — a NULL pick position is OUT OF SCOPE of the restriction and
 * satisfies vacuously.**
 *
 * The restriction speaks *about* pick positions. A manual assignment — and every
 * solver-produced assignment — carries none, and makes no statement about one.
 * Breaching on NULL would make every manual override a violation and would
 * manufacture a breach out of an absence, which is the FAD-23 class of defect
 * (an artefact of a missing value presented as a finding).
 *
 * Both arms are pinned by test: a real out-of-range position breaches, and NULL
 * never does.
 *
 * An assignment whose `pickPosition` is **absent** (the column was not carried)
 * is different again, and makes the whole rule `not-evaluable`: not carrying a
 * column is not the same as carrying it empty.
 */
function checkPickPositionRestriction(
  rule: CompiledRule,
  scoped: readonly CheckedAssignment[],
): HardRuleFinding[] {
  const params = rule.params as { allowedPickPositions?: unknown };
  const allowed = Array.isArray(params.allowedPickPositions)
    ? new Set(params.allowedPickPositions.filter((v): v is number => typeof v === 'number'))
    : null;
  if (allowed === null) {
    return [notEvaluable(rule, 'the compiled `allowedPickPositions` parameter is not an array')];
  }

  const findings: HardRuleFinding[] = [];
  for (const assignment of chronological(scoped)) {
    if (!('pickPosition' in assignment)) {
      return [
        notEvaluable(
          rule,
          'the caller did not carry assignment_snapshots.pick_position, so nothing can be ' +
            'asserted about a pick-position restriction (an absent column is not a NULL one)',
        ),
      ];
    }
    const position = assignment.pickPosition;
    /* RK-RULING-04's vacuous arm. `undefined` cannot reach here — the `in` check
     * above returns for the whole rule — so this is the genuine NULL. */
    if (position === null || position === undefined) continue;
    if (allowed.has(position)) continue;
    findings.push({
      finding: 'breach',
      ruleKey: rule.ruleKey,
      nodeKind: rule.kind,
      field: assignment.snapshotId,
      explanation:
        `the assignment on ${assignment.date} holds pick position ${String(position)}, which ` +
        `this rule does not allow`,
    });
  }
  return findings;
}

/**
 * **RK-RULING-05 — WeekdayFteLimit, AUTHORED here for FAD ratification.**
 *
 * > Per weekday, over the accounting window: a membership's scoped assignments
 * > falling on weekday *w* may not exceed
 * > **`min(⌈node.fteFraction × N(w)⌉, ⌈profile.fteFraction(w) × N(w)⌉, profile.maxAssignments(w))`**,
 * > over whichever of those three terms are present, where `N(w)` is the number
 * > of dates in the accounting window that fall on weekday *w*, and the
 * > accounting window is the rule's `scope.dateRange` intersected with the build
 * > horizon (the period when the scope names no range). The work profile is the
 * > one in force at the build instant — the snapshot's, per S-03.
 *
 * Three choices are made and each is stated because each is a boundary:
 *
 *  - **The period, not the week.** The node carries no anchor date and no
 *    alignment field, so a weekly window would have to invent one — the same
 *    reasoning `MaxAssignmentsInWindow` already records for choosing a rolling
 *    window over a calendar-aligned one.
 *  - **`min`, not "the profile overrides".** The packet's default proposal reads
 *    `max_assignments` as "an absolute per-weekday override". Taken literally an
 *    override could RAISE the limit a HARD rule sets, and SPEC-04 §3.3 is
 *    absolute that a HARD rule can never be relaxed by any code path. So every
 *    present term binds and the tightest wins. **This is the one place this
 *    ruling departs from the packet's proposed wording, and it departs in the
 *    only direction §3.3 permits.**
 *  - **Ceiling, not floor.** ⌈⌉ is the packet's own operator and it is the right
 *    one: rounding down would forbid a 0.5-FTE member from working a fair half
 *    of an odd number of Mondays.
 *
 * `weekday: 'holiday'` is `not-evaluable`: the day vocabulary carries a holiday
 * arm (FAD-16/17) but no holiday calendar is a snapshot constituent, so which
 * dates ARE holidays is not knowable here. Named rather than silently treated as
 * "no dates".
 */
function checkWeekdayFteLimit(
  rule: CompiledRule,
  scoped: readonly CheckedAssignment[],
  version: CheckedVersion,
): HardRuleFinding[] {
  const facts = version.candidateFacts;
  if (facts === undefined) return [notEvaluable(rule, MISSING_CANDIDATE_FACTS)];
  const params = rule.params as { weekday?: unknown; fteFraction?: unknown };
  const weekday = typeof params.weekday === 'string' ? (params.weekday as RuleWeekday) : null;
  const fraction = typeof params.fteFraction === 'number' ? params.fteFraction : null;
  if (weekday === null || fraction === null) {
    return [notEvaluable(rule, 'the compiled `weekday`/`fteFraction` parameters are not usable')];
  }
  if (weekday === 'holiday') {
    return [
      notEvaluable(
        rule,
        'the rule limits the `holiday` day-arm, and no holiday calendar is a constituent of the ' +
          'canonical input, so which dates are holidays is not knowable here (RK-RULING-05)',
      ),
    ];
  }
  const window = accountingWindow(rule, facts.horizon);
  if (window === null) return [];

  const weekdayDateCount = datesInRange(window).filter(
    (date) => weekdayOfDate(date) === weekday,
  ).length;

  const perMembership = new Map<string, number>();
  for (const assignment of scoped) {
    if (weekdayOfDate(assignment.date) !== weekday) continue;
    perMembership.set(
      assignment.membershipId,
      (perMembership.get(assignment.membershipId) ?? 0) + 1,
    );
  }

  const findings: HardRuleFinding[] = [];
  for (const membershipId of [...perMembership.keys()].sort()) {
    const count = perMembership.get(membershipId) ?? 0;
    const target = facts.weekdayTarget(membershipId, weekday);
    const terms: number[] = [Math.ceil(fraction * weekdayDateCount)];
    if (target !== null) {
      terms.push(Math.ceil(target.fteFraction * weekdayDateCount));
      if (target.maxAssignments !== null) terms.push(target.maxAssignments);
    }
    const limit = Math.min(...terms);
    if (count <= limit) continue;
    findings.push({
      finding: 'breach',
      ruleKey: rule.ruleKey,
      nodeKind: rule.kind,
      field: membershipId,
      explanation:
        `membership ${membershipId} has ${String(count)} scoped assignments on ${weekday} ` +
        `across ${String(weekdayDateCount)} such dates in ${window.from}..${window.to}; the ` +
        `binding limit is ${String(limit)} (RK-RULING-05, the tightest of the present terms)`,
    });
  }
  return findings;
}

/**
 * **RK-RULING-07 — `NoAdjacent` means CONSECUTIVE CALENDAR DATES.**
 *
 * Instant-gap semantics ("an end instant meeting a start instant") belong to
 * `MinimumRestBetween` and to nothing else: one concern, one spelling. A group
 * that wants both expresses both, and the two rules then say different things
 * rather than one rule saying an ambiguous thing.
 *
 * The statement is symmetric — the pair `{A, B}` may not fall on consecutive
 * dates for one membership in EITHER order — because "not adjacent" is a
 * statement about a pair, and an asymmetric reading would let a group forbid
 * A-then-B while permitting B-then-A from the same rule.
 */
function checkNoAdjacent(
  rule: CompiledRule,
  scoped: readonly CheckedAssignment[],
): HardRuleFinding[] {
  const params = rule.params as { shiftTypeA?: unknown; shiftTypeB?: unknown };
  const a = typeof params.shiftTypeA === 'string' ? params.shiftTypeA : null;
  const b = typeof params.shiftTypeB === 'string' ? params.shiftTypeB : null;
  if (a === null || b === null) {
    return [notEvaluable(rule, 'the compiled `shiftTypeA`/`shiftTypeB` parameters are not strings')];
  }

  const findings: HardRuleFinding[] = [];
  for (const [membershipId, list] of byMembership(scoped)) {
    const onDay = new Map<number, Set<string>>();
    for (const assignment of list) {
      const day = dayNumber(assignment.date);
      const codes = onDay.get(day);
      if (codes === undefined) onDay.set(day, new Set([assignment.shiftTypeCode]));
      else codes.add(assignment.shiftTypeCode);
    }
    for (const day of [...onDay.keys()].sort((x, y) => x - y)) {
      const today = onDay.get(day) ?? new Set<string>();
      const tomorrow = onDay.get(day + 1) ?? new Set<string>();
      const forward = today.has(a) && tomorrow.has(b);
      const backward = today.has(b) && tomorrow.has(a);
      if (!forward && !backward) continue;
      findings.push({
        finding: 'breach',
        ruleKey: rule.ruleKey,
        nodeKind: rule.kind,
        field: membershipId,
        explanation:
          `membership ${membershipId} works ${forward ? a : b} on ${isoOfDayNumber(day)} and ` +
          `${forward ? b : a} on ${isoOfDayNumber(day + 1)}; this rule forbids the two on ` +
          'consecutive dates (RK-RULING-07)',
      });
    }
  }
  return findings;
}

/**
 * **RK-RULING-08 — `ForbiddenSequence` is the named shift-type sequence matched
 * over CONSECUTIVE CALENDAR DATES, in order; an intervening different scoped
 * assignment on a date between them BREAKS the run.**
 *
 * The M3 note recorded two readings that disagree on real rosters — consecutive
 * assignments versus assignments-in-order — and this picks the first, over
 * dates rather than over rows, so that a gap day also breaks the run. Both the
 * intervening-type arm and the gap arm are pinned by test.
 *
 * A date carrying more than one scoped shift type matches the sequence position
 * if ANY of them does, and breaks the run only if none does — a person who works
 * two things in a day has still worked the one the sequence names.
 */
function checkForbiddenSequence(
  rule: CompiledRule,
  scoped: readonly CheckedAssignment[],
): HardRuleFinding[] {
  const params = rule.params as { sequence?: unknown };
  const sequence = Array.isArray(params.sequence)
    ? params.sequence.filter((v): v is string => typeof v === 'string')
    : null;
  if (sequence === null) return [notEvaluable(rule, 'the compiled `sequence` is not an array')];
  if (sequence.length === 0) return [];

  const findings: HardRuleFinding[] = [];
  for (const [membershipId, list] of byMembership(scoped)) {
    const onDay = new Map<number, Set<string>>();
    for (const assignment of list) {
      const day = dayNumber(assignment.date);
      const codes = onDay.get(day);
      if (codes === undefined) onDay.set(day, new Set([assignment.shiftTypeCode]));
      else codes.add(assignment.shiftTypeCode);
    }
    for (const start of [...onDay.keys()].sort((x, y) => x - y)) {
      let matched = true;
      for (let step = 0; step < sequence.length; step += 1) {
        const codes = onDay.get(start + step);
        const wanted = sequence[step];
        if (codes === undefined || wanted === undefined || !codes.has(wanted)) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      findings.push({
        finding: 'breach',
        ruleKey: rule.ruleKey,
        nodeKind: rule.kind,
        field: membershipId,
        explanation:
          `membership ${membershipId} works the forbidden sequence ${sequence.join('→')} on ` +
          `consecutive dates from ${isoOfDayNumber(start)} (RK-RULING-08)`,
      });
    }
  }
  return findings;
}

/**
 * **RK-RULING-09 — linkage binds the SAME MEMBERSHIP and the SAME CALENDAR
 * DATE.**
 *
 * Wider windows are expressed through `scope.dateRange`, never invented per
 * node: a node that quietly meant "within three days" would be a second,
 * undeclared window mechanism beside the one the scope already provides.
 *
 *  - `LinkedShifts([A, B, …])` — on any date where a membership has ANY of the
 *    named types, it must have ALL of them. "Linked" is an all-or-nothing bundle;
 *    a reading where one implies only the next would be `ImpliesAssignment`.
 *  - `ImpliesAssignment(if → then)` — the one-directional arm, same date.
 *  - `MutuallyExclusive([A, B, …])` — at most one of the named types per
 *    membership per date. Exclusive over a single date, exactly as ruled.
 */
function checkLinkage(
  rule: CompiledRule,
  scoped: readonly CheckedAssignment[],
  mode: 'all-or-none' | 'implies' | 'at-most-one',
): HardRuleFinding[] {
  const params = rule.params as {
    shiftTypes?: unknown;
    ifShiftType?: unknown;
    thenShiftType?: unknown;
  };

  let names: string[];
  if (mode === 'implies') {
    const from = typeof params.ifShiftType === 'string' ? params.ifShiftType : null;
    const to = typeof params.thenShiftType === 'string' ? params.thenShiftType : null;
    if (from === null || to === null) {
      return [notEvaluable(rule, 'the compiled `ifShiftType`/`thenShiftType` are not strings')];
    }
    names = [from, to];
  } else {
    if (!Array.isArray(params.shiftTypes)) {
      return [notEvaluable(rule, 'the compiled `shiftTypes` parameter is not an array')];
    }
    names = params.shiftTypes.filter((v): v is string => typeof v === 'string');
  }
  if (names.length === 0) return [];

  const findings: HardRuleFinding[] = [];
  for (const [membershipId, list] of byMembership(scoped)) {
    const onDate = new Map<string, Set<string>>();
    for (const assignment of list) {
      const codes = onDate.get(assignment.date);
      if (codes === undefined) onDate.set(assignment.date, new Set([assignment.shiftTypeCode]));
      else codes.add(assignment.shiftTypeCode);
    }
    for (const date of [...onDate.keys()].sort()) {
      const codes = onDate.get(date) ?? new Set<string>();
      const present = names.filter((name) => codes.has(name));
      let breached = false;
      let detail = '';
      if (mode === 'all-or-none') {
        breached = present.length > 0 && present.length < names.length;
        detail = `has ${present.join(', ')} but not every linked type (${names.join(', ')})`;
      } else if (mode === 'implies') {
        const from = names[0] as string;
        const to = names[1] as string;
        breached = codes.has(from) && !codes.has(to);
        detail = `works ${from} without the implied ${to}`;
      } else {
        breached = present.length > 1;
        detail = `works ${present.join(' and ')}, which this rule makes mutually exclusive`;
      }
      if (!breached) continue;
      findings.push({
        finding: 'breach',
        ruleKey: rule.ruleKey,
        nodeKind: rule.kind,
        field: membershipId,
        explanation: `membership ${membershipId} ${detail} on ${date} (RK-RULING-09)`,
      });
    }
  }
  return findings;
}

/**
 * **RK-RULING-10 — `FixedAssignment.assignmentIdentity` is
 * `assignment_identities.id`: a uuid, opaque, UI-selected.**
 *
 * Confirmed against the v2 snapshot rather than assumed: `fixedAssignments[]`
 * carries `assignmentIdentityId`, so the domain resolves with **no schema
 * change**. A human-meaningful cross-period key remains a recorded future owner
 * question — it is not dropped, and it is not invented here.
 *
 * The content statement: the named identity must appear in the candidate with
 * the same membership, date and shift type it was fixed at. An identity the
 * build was never given is `not-evaluable` — a rule pinning something that does
 * not exist cannot be decided, and calling it a breach would blame the schedule
 * for a mis-authored rule.
 */
function checkFixedAssignment(
  rule: CompiledRule,
  version: CheckedVersion,
): HardRuleFinding[] {
  const facts = version.candidateFacts;
  if (facts === undefined) return [notEvaluable(rule, MISSING_CANDIDATE_FACTS)];
  const params = rule.params as { assignmentIdentity?: unknown };
  const identityId =
    typeof params.assignmentIdentity === 'string' ? params.assignmentIdentity : null;
  if (identityId === null) {
    return [notEvaluable(rule, 'the compiled `assignmentIdentity` parameter is not a string')];
  }
  const prior = facts.priorAssignments.find(
    (candidate) => candidate.assignmentIdentityId === identityId,
  );
  if (prior === undefined) {
    return [
      notEvaluable(
        rule,
        `it pins assignment identity ${identityId}, which is not among the build's fixed ` +
          'inputs (RK-RULING-10 pins the domain to assignment_identities.id)',
      ),
    ];
  }
  return preservedFinding(rule, version, prior, 'pinned by this rule');
}

/**
 * **`ProtectedRange(from, to)` — the `solver-and-validator` owner, EXECUTED.**
 *
 * Its M3 reason stands: a protected range bounds what a BUILD may change, which
 * finished content on its own cannot violate. Against a *candidate* the question
 * is different and answerable, because the fixed inputs say what was there:
 * **every prior assignment dated inside the range appears in the candidate
 * unchanged.**
 *
 * This is not a re-reading of the M3 ruling. It is the second half of the owner
 * the registry has assigned this kind since M4-000C — "M4-002 compiles it as a
 * constraint AND an independent validator re-checks it, never one without the
 * other".
 */
function checkProtectedRange(
  rule: CompiledRule,
  version: CheckedVersion,
): HardRuleFinding[] {
  const facts = version.candidateFacts;
  if (facts === undefined) return [notEvaluable(rule, MISSING_CANDIDATE_FACTS)];
  const params = rule.params as { from?: unknown; to?: unknown };
  const from = typeof params.from === 'string' ? params.from : null;
  const to = typeof params.to === 'string' ? params.to : null;
  if (from === null || to === null) {
    return [notEvaluable(rule, 'the compiled `from`/`to` parameters are not strings')];
  }

  const findings: HardRuleFinding[] = [];
  for (const prior of [...facts.priorAssignments].sort((a, b) =>
    a.assignmentIdentityId < b.assignmentIdentityId ? -1 : 1,
  )) {
    if (prior.date < from || prior.date > to) continue;
    findings.push(...preservedFinding(rule, version, prior, `inside the protected range ${from}..${to}`));
  }
  return findings;
}

/** Shared by `FixedAssignment` and `ProtectedRange`: did the candidate keep it? */
function preservedFinding(
  rule: CompiledRule,
  version: CheckedVersion,
  prior: CandidatePriorAssignment,
  why: string,
): HardRuleFinding[] {
  const present = version.assignments.find(
    (assignment) => assignment.assignmentIdentityId === prior.assignmentIdentityId,
  );
  if (present === undefined) {
    return [
      {
        finding: 'breach',
        ruleKey: rule.ruleKey,
        nodeKind: rule.kind,
        field: prior.assignmentIdentityId,
        explanation:
          `the assignment ${why} (${prior.membershipId} on ${prior.date}, ` +
          `${prior.shiftTypeCode}) is absent from the candidate`,
      },
    ];
  }
  if (
    present.membershipId === prior.membershipId &&
    present.date === prior.date &&
    present.shiftTypeCode === prior.shiftTypeCode
  ) {
    return [];
  }
  return [
    {
      finding: 'breach',
      ruleKey: rule.ruleKey,
      nodeKind: rule.kind,
      field: prior.assignmentIdentityId,
      explanation:
        `the assignment ${why} moved: it was ${prior.membershipId} on ${prior.date} ` +
        `(${prior.shiftTypeCode}) and the candidate has ${present.membershipId} on ` +
        `${present.date} (${present.shiftTypeCode})`,
    },
  ];
}

/**
 * **`PatternRule(trigger, daysOfWeek, segments)` — the `solver-and-validator`
 * owner, EXECUTED.** Its M3 reason stands unmodified; the candidate question is
 * a different one, and it is an implication rather than a prescription:
 *
 * > If a membership is assigned `trigger` on a date whose weekday is in
 * > `daysOfWeek`, then for every segment it is also assigned `segment.shiftType`
 * > on `date + segment.offsetDays`.
 *
 * **A segment falling outside the build horizon is not required.** The build
 * cannot assign outside its own period, so demanding it would make every pattern
 * triggered near a period edge unsatisfiable — a rule that is impossible to obey
 * at the boundary is a rule that stops being enforced everywhere, because
 * somebody disables it. The horizon is therefore load-bearing and this kind
 * needs {@link CandidateFacts}.
 */
function checkPatternRule(
  rule: CompiledRule,
  scoped: readonly CheckedAssignment[],
  version: CheckedVersion,
): HardRuleFinding[] {
  const facts = version.candidateFacts;
  if (facts === undefined) return [notEvaluable(rule, MISSING_CANDIDATE_FACTS)];
  const params = rule.params as {
    trigger?: unknown;
    daysOfWeek?: unknown;
    segments?: unknown;
  };
  const trigger = typeof params.trigger === 'string' ? params.trigger : null;
  if (trigger === null) return [notEvaluable(rule, 'the compiled `trigger` is not a string')];
  const days = Array.isArray(params.daysOfWeek)
    ? new Set(params.daysOfWeek.filter((v): v is string => typeof v === 'string'))
    : null;
  if (days === null) return [notEvaluable(rule, 'the compiled `daysOfWeek` is not an array')];
  if (days.has('holiday')) {
    return [
      notEvaluable(
        rule,
        'the pattern triggers on the `holiday` day-arm, and no holiday calendar is a constituent ' +
          'of the canonical input',
      ),
    ];
  }
  const segments = Array.isArray(params.segments)
    ? (params.segments as { offsetDays?: unknown; shiftType?: unknown }[])
    : null;
  if (segments === null) return [notEvaluable(rule, 'the compiled `segments` is not an array')];

  const findings: HardRuleFinding[] = [];
  for (const [membershipId, list] of byMembership(scoped)) {
    const held = new Set(list.map((a) => `${a.date}\x00${a.shiftTypeCode}`));
    for (const assignment of chronological(list)) {
      if (assignment.shiftTypeCode !== trigger) continue;
      if (!days.has(weekdayOfDate(assignment.date))) continue;
      for (const segment of segments) {
        const offset = typeof segment.offsetDays === 'number' ? segment.offsetDays : null;
        const code = typeof segment.shiftType === 'string' ? segment.shiftType : null;
        if (offset === null || code === null) continue;
        const date = isoOfDayNumber(dayNumber(assignment.date) + offset);
        /* Outside the horizon the build could not have assigned it. */
        if (date < facts.horizon.from || date > facts.horizon.to) continue;
        if (held.has(`${date}\x00${code}`)) continue;
        findings.push({
          finding: 'breach',
          ruleKey: rule.ruleKey,
          nodeKind: rule.kind,
          field: assignment.snapshotId,
          explanation:
            `membership ${membershipId} works the pattern trigger ${trigger} on ` +
            `${assignment.date} but not the required ${code} on ${date}`,
        });
      }
    }
  }
  return findings;
}

/**
 * **`AlternatingWeek(onShiftType, cycleWeeks)` — the `solver-and-validator`
 * owner, EXECUTED.** M3 reason stands; the candidate question:
 *
 * > Within the accounting window, a membership's `onShiftType` assignments fall
 * > in weeks of one parity class modulo `cycleWeeks` — never in two.
 *
 * Weeks are counted from the window's first date, not from an absolute calendar
 * epoch, because the node carries no anchor and an absolute epoch would make the
 * same roster legal or illegal depending on which Thursday the epoch fell on.
 * Which class is the "on" class is not stated by the node and is deliberately
 * not chosen here: the rule constrains the assignments to ONE class, and every
 * class is as good as another.
 */
function checkAlternatingWeek(
  rule: CompiledRule,
  scoped: readonly CheckedAssignment[],
  version: CheckedVersion,
): HardRuleFinding[] {
  const facts = version.candidateFacts;
  if (facts === undefined) return [notEvaluable(rule, MISSING_CANDIDATE_FACTS)];
  const params = rule.params as { onShiftType?: unknown; cycleWeeks?: unknown };
  const code = typeof params.onShiftType === 'string' ? params.onShiftType : null;
  const cycleWeeks = typeof params.cycleWeeks === 'number' ? params.cycleWeeks : null;
  if (code === null || cycleWeeks === null || cycleWeeks < 1) {
    return [notEvaluable(rule, 'the compiled `onShiftType`/`cycleWeeks` parameters are not usable')];
  }
  const window = accountingWindow(rule, facts.horizon);
  if (window === null) return [];
  const origin = dayNumber(window.from);

  const findings: HardRuleFinding[] = [];
  for (const [membershipId, list] of byMembership(scoped)) {
    const classes = new Set<number>();
    for (const assignment of list) {
      if (assignment.shiftTypeCode !== code) continue;
      const week = Math.floor((dayNumber(assignment.date) - origin) / 7);
      classes.add(((week % cycleWeeks) + cycleWeeks) % cycleWeeks);
    }
    if (classes.size <= 1) continue;
    findings.push({
      finding: 'breach',
      ruleKey: rule.ruleKey,
      nodeKind: rule.kind,
      field: membershipId,
      explanation:
        `membership ${membershipId} works ${code} in ${String(classes.size)} distinct week ` +
        `classes of a ${String(cycleWeeks)}-week cycle over ${window.from}..${window.to}; an ` +
        'alternating-week rule admits exactly one',
    });
  }
  return findings;
}

/* The three coverage bounds, read out of the compiled params. Separate helpers
 * rather than one with a mode string because each node carries a DIFFERENT field
 * name, and a shared reader would have to guess which. */
function exactBound(
  rule: CompiledRule,
  field: string,
): { kind: 'exact'; value: number } {
  const params = rule.params as Record<string, unknown>;
  const raw = params[field];
  return { kind: 'exact', value: typeof raw === 'number' ? raw : Number.NaN };
}
function minBound(rule: CompiledRule): { kind: 'min'; value: number } {
  const params = rule.params as { min?: unknown };
  return { kind: 'min', value: typeof params.min === 'number' ? params.min : Number.NaN };
}
function maxBound(rule: CompiledRule): { kind: 'max'; value: number } {
  const params = rule.params as { max?: unknown };
  return { kind: 'max', value: typeof params.max === 'number' ? params.max : Number.NaN };
}

/** The one reason text for "this caller does not speak the candidate vocabulary". */
const MISSING_CANDIDATE_FACTS =
  'this caller supplied no candidateFacts, so the build horizon, the staff-group and ' +
  'valid-group vocabularies, the in-force work profiles and the fixed inputs this kind needs ' +
  'are all absent. Nothing may be asserted about it (FAD-27 fail-closed)';

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

    const scoped = scopedAssignments(rule, version.assignments, version);
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
      /* ── OPUS-M4-002, one case per ruling ─────────────────────────────────*/
      case 'RequiredCount':
        findings.push(
          ...capped(rule, checkCoverage(rule, scoped, version, exactBound(rule, 'count'))),
        );
        break;
      case 'MinCoverage':
        findings.push(...capped(rule, checkCoverage(rule, scoped, version, minBound(rule))));
        break;
      case 'MaxCoverage':
        findings.push(...capped(rule, checkCoverage(rule, scoped, version, maxBound(rule))));
        break;
      case 'MemberOfStaffGroup':
        findings.push(...capped(rule, checkMemberOfStaffGroup(rule, scoped, version)));
        break;
      case 'ValidGroupRestriction':
        findings.push(...capped(rule, checkValidGroupRestriction(rule, scoped, version)));
        break;
      case 'PickPositionRestriction':
        findings.push(...capped(rule, checkPickPositionRestriction(rule, scoped)));
        break;
      case 'WeekdayFteLimit':
        findings.push(...capped(rule, checkWeekdayFteLimit(rule, scoped, version)));
        break;
      case 'NoAdjacent':
        findings.push(...capped(rule, checkNoAdjacent(rule, scoped)));
        break;
      case 'ForbiddenSequence':
        findings.push(...capped(rule, checkForbiddenSequence(rule, scoped)));
        break;
      case 'LinkedShifts':
        findings.push(...capped(rule, checkLinkage(rule, scoped, 'all-or-none')));
        break;
      case 'ImpliesAssignment':
        findings.push(...capped(rule, checkLinkage(rule, scoped, 'implies')));
        break;
      case 'MutuallyExclusive':
        findings.push(...capped(rule, checkLinkage(rule, scoped, 'at-most-one')));
        break;
      case 'FixedAssignment':
        findings.push(...capped(rule, checkFixedAssignment(rule, version)));
        break;
      case 'ProtectedRange':
        findings.push(...capped(rule, checkProtectedRange(rule, version)));
        break;
      case 'PatternRule':
        findings.push(...capped(rule, checkPatternRule(rule, scoped, version)));
        break;
      case 'AlternatingWeek':
        findings.push(...capped(rule, checkAlternatingWeek(rule, scoped, version)));
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
