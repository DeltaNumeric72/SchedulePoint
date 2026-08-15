/**
 * The canonical solver input snapshot — its **shape**, and every refusal that can
 * be decided without a database (OPUS-M4-001; doc 35 §6a, SPEC-04 §3.4).
 *
 * ## One snapshot, immutable, versioned
 *
 * SPEC-04 §3.4: `solver_inputs` captures "a **complete immutable snapshot**" and
 * "`input_hash` covers all of it". Doc 35 §6a enumerates what "all of it" means
 * and the list is not decorative — every constituent is there because a build
 * that cannot name it cannot be reproduced or defended. Two properties follow,
 * and both are structural rather than procedural:
 *
 *  1. **The document is the whole problem.** The worker receives it and nothing
 *     else — no database handle, no credential (SPEC-04 §1.1, S-15t). Anything
 *     omitted here is something the solver cannot see, so the omission is a
 *     modelling decision and not an oversight to be patched later with a lookup.
 *  2. **The hash is over the canonical form of the document.** Not over a
 *     summary, not over the row set, not over "the interesting fields": over the
 *     bytes that were sent. `canonicalStringify` (the rule module's, reused
 *     rather than respelled) makes those bytes stable across machines, key
 *     insertion order, and absent-versus-`undefined` optionals.
 *
 * ## Why the refusal decision is pure
 *
 * Doc 35 §6a requires six refusal classes, "each … a typed refusal with a test".
 * A refusal that can only be provoked by constructing a corrupt database is a
 * refusal nobody will test at every boundary; a refusal expressed as a total
 * function over an assembled document is one where the reviewer's probes can
 * hand-build the pathological input directly. So the *reads* are in
 * `apps/api/src/solver/canonical-input.ts` and the *judgement* is here.
 *
 * The one refusal that is genuinely a read — "a constituent revision moved
 * between the caller's earlier read and this assembly" — is expressed here too,
 * as a comparison between an expectation the caller carries and the revisions
 * the assembly observed. That keeps the staleness rule in one place instead of
 * one place per constituent kind.
 *
 * Pure: no clock, no zone, no I/O, and nothing imported from outside this
 * package (`domain-imports-nothing`).
 */

import { compareCalendarDates, isCalendarDate } from '../calendar/calendar-date.js';

/* ────────────────────────────────────────────────────────────────────────────
 * 1. The document
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Every constituent whose revision the snapshot pins.
 *
 * SPEC-04 §4 records `rule_schema_versions[]` per build; doc 34 §4-D widened that
 * to "builds and publications identify exact rule revisions", and doc 35 §6a
 * widened it again to *every* constituent revision. The kinds below are exactly
 * the revisioned things this schema has: each carries a database-owned counter
 * (`version`, `revision`, or a `*_version` xid) that no application role can
 * write, which is what makes citing it meaningful rather than advisory.
 */
export const SNAPSHOT_CONSTITUENT_KINDS = [
  'rule',
  'shiftType',
  'location',
  'qualification',
  'shiftTypeQualification',
  'weekdayDemand',
  'requirement',
  'qualificationHolding',
  'timezoneBasis',
  'period',
  'version',
  /* ── snapshot v2 (OPUS-M4-002, FAD-38) ──────────────────────────────────────
   * Two kinds, APPENDED. Appended rather than inserted because the order of this
   * array is the order a reader meets the vocabulary in, and renumbering a list
   * that documents cite is the shape non-bypass rule 13 forbids. Nothing above
   * moved. */
  'staffGroup',
  'validGroup',
] as const;
export type SnapshotConstituentKind = (typeof SNAPSHOT_CONSTITUENT_KINDS)[number];

/**
 * One revisioned constituent.
 *
 * `key` is the STABLE identifier where one exists (`rule_key`, a qualification
 * `key`) and the surrogate id otherwise — non-bypass rule 13's discipline
 * applied to a citation: a build that cited only a uuid would still resolve
 * after a rename and would stop resolving after nothing at all.
 *
 * `revision` is a string because the counters are not all integers: `rules` and
 * the catalogue tables carry `integer`, while `schedule_requirements` and the
 * schedule spine carry PostgreSQL `xid8` values rendered as decimal strings. One
 * type, compared as text, avoids a silent numeric coercion of a 64-bit counter.
 */
export interface SnapshotConstituent {
  readonly kind: SnapshotConstituentKind;
  readonly key: string;
  readonly revision: string;
}

/** The group's timezone interpretation, from migration 0014's basis columns. */
export interface SnapshotTimezone {
  /** `schedule_versions.timezone_basis` — the IANA zone the instants were derived under. */
  readonly basis: string;
  /** `schedule_versions.tzdb_version` — the tz DATABASE rule set, or `'unknown'`. */
  readonly tzdbVersion: string;
  /** Where the basis came from. A fallback is visible, never disguised. */
  readonly source: 'version-snapshot' | 'group-current';
}

export interface SnapshotLocation {
  readonly locationId: string;
  readonly name: string;
  readonly status: 'active' | 'archived';
  /** Display metadata only — the GROUP zone governs (R-B3, FAD-31). */
  readonly timezone: string | null;
}

export interface SnapshotShiftType {
  readonly shiftTypeId: string;
  readonly code: string;
  /** `HH:MM:SS`, as PostgreSQL renders `time`. */
  readonly startTime: string;
  readonly endTime: string;
  readonly crossesMidnight: boolean;
  readonly isManualOnly: boolean;
  /**
   * `shift_types.is_on_call` (migration 0005) — snapshot v2, FAD-39.
   *
   * The ONE attribute in the system that says a shift IS a call, and therefore
   * the whole of what makes `CallSpacing` decidable. v2 originally omitted it and
   * the worker refused every `CallSpacing` rule rather than modelling one that
   * would have matched nothing; the refusal was right and it is kept as the
   * unknown-input backstop, but the input is here now so the refusal no longer
   * fires for this kind. Folded into the SAME v2 bump — v2 had not shipped.
   */
  readonly isOnCall: boolean;
  readonly creditWeight: string;
  readonly status: 'active' | 'retired';
  /** ACTIVE `shift_type_qualifications` edges. Archived edges are history. */
  readonly requiredQualificationIds: readonly string[];
}

/** A weekday demand default, or a dated period requirement. Both are demand. */
export interface SnapshotDemandCell {
  readonly source: 'weekday-default' | 'period-requirement';
  readonly shiftTypeId: string;
  /** `mon`..`sun`/`holiday` for a default; `YYYY-MM-DD` for a requirement. */
  readonly on: string;
  readonly requiredCount: number;
}

export interface SnapshotWeekdayTarget {
  readonly day: string;
  readonly fteFraction: number;
  readonly maxAssignments: number | null;
}

/** The in-force work profile, as the S-03 loader selected it. */
export interface SnapshotWorkProfile {
  readonly workProfileId: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly workPercentage: number;
  readonly maxAssignmentsPerWeek: number | null;
  readonly maxAssignmentsPerPeriod: number | null;
  readonly maxConsecutiveDays: number | null;
  readonly weekdayTargets: readonly SnapshotWeekdayTarget[];
}

export interface SnapshotHolding {
  readonly qualificationId: string;
  readonly validFrom: string;
  /**
   * `null` is open-ended.
   *
   * The `requires_expiry` contract, stated precisely (OPUS-M4-001S; FAD-28 R5,
   * FAD-36(2)): migration 0012 refuses the SEQUENTIAL violation — a holding
   * without `valid_until` for a requires-expiry qualification, and a flip of
   * `requires_expiry` over existing open-ended live holdings — and migration
   * **0017** serializes the two writers against each other so the concurrent
   * interleaving cannot slip between them (the holding guard reads the
   * qualification `FOR KEY SHARE`, the flip guard takes `FOR UPDATE` before it
   * looks). Together: no committed state has `requires_expiry = true` with an
   * open-ended live holding.
   *
   * The earlier wording here — "enforced at write time (0012)" — was true of the
   * sequential rule and false under concurrency, which the M4-001R review
   * measured (finding R-1). It is corrected rather than deleted because
   * `requires_expiry` is not an input to the eligibility verdict: nothing on the
   * READ side would catch a violation, so what this comment claims is the whole
   * of the guarantee a consumer has.
   */
  readonly validUntil: string | null;
  readonly status: string;
}

/** The verdict for one (participant, shift type) pair, from the FROZEN module. */
export interface SnapshotEligibility {
  readonly shiftTypeId: string;
  readonly eligible: boolean;
  /** `qualificationId:outcome`, ordered, so a refusal can be explained. */
  readonly outcomes: readonly string[];
}

export interface SnapshotParticipant {
  readonly membershipId: string;
  /** SPEC-04 §3.4's account type: an organization or a group membership. */
  readonly membershipKind: 'organization' | 'group';
  /** The participant type: staff or locum (`memberships.staffing_kind`). */
  readonly staffingKind: 'staff' | 'locum';
  readonly status: 'invited' | 'active' | 'suspended' | 'ended';
  readonly validFrom: string;
  readonly validTo: string | null;
  /** `null` when no profile is in force at the build instant. Reported, not blocking. */
  readonly workProfile: SnapshotWorkProfile | null;
  readonly holdings: readonly SnapshotHolding[];
  readonly eligibility: readonly SnapshotEligibility[];
}

/**
 * A fixed input: a pinned, protected or manual assignment the build must respect.
 *
 * SPEC-04 §6: "Progressive builds carry `parent_build_ids[]` and
 * `protected_assignment_identities[]`, so a later build's fixed inputs are
 * **recorded rather than inferred**." This is that record, at the granularity a
 * solver can consume.
 */
export interface SnapshotFixedAssignment {
  readonly assignmentIdentityId: string;
  readonly membershipId: string;
  readonly date: string;
  readonly shiftTypeId: string;
  readonly locationId: string | null;
  readonly isPinned: boolean;
  readonly origin: 'manual' | 'clone' | 'solver' | 'picklist';
  readonly creditedMembershipId: string | null;
  readonly creditWeight: string | null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Snapshot v2 — the three vocabularies the rulings need (OPUS-M4-002, FAD-38)
 *
 * ## Why these three, and why they were not here at v1
 *
 * M4-001 assembled everything a *stub* solve consumes. M4-002's rulings then
 * made three more kinds evaluable and the assembly could not reach their inputs:
 *
 *  - **RK-RULING-02** — `MemberOfStaffGroup(staffGroup = staff_groups.id)`, and
 *    `RuleScope.staffGroups`, which is a filter on **every** kind. Without the
 *    membership edges, any staff-group-scoped rule of any kind is unresolvable,
 *    which is what blocked the `B-ruleheavy` corpus class outright.
 *  - **RK-RULING-03** — `ValidGroupRestriction(validGroup = valid_groups.id)`.
 *  - `RequiresQualification(qualification = qualifications.key)` — already
 *    EVALUATED by the independent checker at M3, but the worker can only see
 *    qualification **ids** (`holdings[].qualificationId`,
 *    `shiftTypes[].requiredQualificationIds`), so it could not model a rule that
 *    names a **key**. The key appeared only inside a `constituents` citation,
 *    which carries no id.
 *
 * The tables all shipped at migration 0005 — **this is a document-shape gap, not
 * a schema gap, and v2 adds no migration.** The gap was escalated before any code
 * was written (EV-M4-002) and ruled FAD-38: additive-only, nothing removed or
 * reshaped, every v1 consumer compiles unchanged.
 *
 * ## The rule these three obey
 *
 * Each carries the **stable identifier the rulings name** plus exactly what an
 * evaluation needs, and nothing else. No display name is carried where an id
 * decides (`staff_groups.name` is mutable; a rename must not change a rule's
 * historical meaning), and no free text of any kind crosses (I-07).
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A staff group and the memberships in it (RK-RULING-02).
 *
 * `staffGroupId` is `staff_groups.id` — the STABLE identifier the ruling pins,
 * never `name`. Authoring resolves a name to this id at save, so a later rename
 * leaves every historical build meaning exactly what it meant.
 */
export interface SnapshotStaffGroup {
  readonly staffGroupId: string;
  /** `staff_group_members.membership_id`, ordered, group-scoped by the composite FK. */
  readonly memberMembershipIds: readonly string[];
}

/**
 * A valid group: which draft pick positions are legal for which shift types
 * (RK-RULING-03).
 *
 * `validGroupId` is `valid_groups.id`, on the same stable-id reasoning as
 * {@link SnapshotStaffGroup}. `allowedPickPositions` is carried because the row
 * owns it (migration 0005 keeps the positions as an array on the row rather than
 * as a child table) and a restriction that could not see them would be a
 * restriction about nothing.
 */
export interface SnapshotValidGroup {
  readonly validGroupId: string;
  /** Ascending, distinct — the shape migration 0005's trigger enforces. */
  readonly allowedPickPositions: readonly number[];
  /** `valid_group_shift_types.shift_type_id`, ordered. */
  readonly shiftTypeIds: readonly string[];
}

/**
 * The group's qualification vocabulary: the id↔key↔lifecycle triple.
 *
 * This is the resolution `RequiresQualification` needs and v1 could not supply.
 * It carries **no** `requires_expiry` and no evidence reference: the first is a
 * write-time control (migrations 0012/0017) that no evaluation consults, and the
 * second is `SENSITIVE-PII` free text that never crosses this boundary (I-07,
 * non-bypass rule 9). The `constituents` citation of kind `qualification`
 * continues to pin the revision — this adds the *vocabulary*, not a second
 * citation.
 */
export interface SnapshotQualification {
  readonly qualificationId: string;
  /** `qualifications.key` — the domain the AST's `qualification` field names. */
  readonly key: string;
  /** `qualifications.status`; the verdict treats an unresolvable one as retired. */
  readonly status: string;
}

/** One rule, at the exact revision the build consumes. */
export interface SnapshotRuleRevision {
  readonly ruleKey: string;
  readonly revision: string;
  readonly ruleSchemaVersion: number;
  readonly classification: 'HARD' | 'SOFT';
  readonly category: 'general' | 'pattern' | 'staff';
  readonly weight: string | null;
  readonly status: 'active' | 'disabled' | 'archived';
  readonly scope: unknown;
  readonly predicate: unknown;
}

/**
 * **The canonical input document.** One immutable versioned snapshot.
 *
 * Field order in this interface is not load-bearing —
 * `canonicalStringify` sorts keys — but the *presence* of every field is. Doc 35
 * §6a's enumeration maps onto it one for one:
 *
 * | Packet clause | Field |
 * |---|---|
 * | organization/group/version identity | `organizationId`, `groupId`, `versionId` |
 * | period | `periodId`, `periodName`, `periodStatus` |
 * | timezone snapshot [0014 basis] | `timezone` |
 * | date range | `startDate`, `endDate`, `dayCount` |
 * | locations | `locations` |
 * | demand | `demand` |
 * | active effective participants | `participants` |
 * | account/participant type | `participants[].membershipKind`, `.staffingKind` |
 * | in-force profiles + FTE [S-03] | `participants[].workProfile` |
 * | qualifications + expiry | `participants[].holdings` |
 * | shift-type qualification requirements | `shiftTypes[].requiredQualificationIds` |
 * | pins/protected/manual assignments | `fixedAssignments` |
 * | applicable rule revisions [0015] | `ruleRevisions` |
 * | configuration revisions | `constituents` |
 * | compiler version, schema version | `compilerVersion`, `snapshotSchemaVersion` |
 */
export interface SolverInputSnapshotDocument {
  readonly snapshotSchemaVersion: number;
  readonly compilerVersion: number;
  readonly ruleSchemaVersion: number;

  readonly organizationId: string;
  readonly groupId: string;
  readonly periodId: string;
  readonly versionId: string;
  readonly periodName: string;
  readonly periodStatus: 'planning' | 'published' | 'closed';

  readonly startDate: string;
  readonly endDate: string;
  readonly dayCount: number;
  readonly timezone: SnapshotTimezone;

  readonly locations: readonly SnapshotLocation[];
  readonly shiftTypes: readonly SnapshotShiftType[];
  readonly demand: readonly SnapshotDemandCell[];
  readonly participants: readonly SnapshotParticipant[];
  readonly fixedAssignments: readonly SnapshotFixedAssignment[];
  readonly ruleRevisions: readonly SnapshotRuleRevision[];

  /* ── v2 (OPUS-M4-002, FAD-38) — APPENDED, nothing above reshaped ───────────
   * Required rather than optional, and deliberately: an optional field would let
   * a document that simply forgot a vocabulary look identical to one whose group
   * genuinely has none, and the two answers differ — the first silently makes
   * every staff-group-scoped rule unresolvable, the second correctly makes it
   * resolve to nobody. An empty array says "none"; an absent field would say
   * nothing at all. The bump to `snapshotSchemaVersion = 2` is what makes that
   * requirement safe: a v1 document is refused by version, not misread. */
  /** RK-RULING-02's vocabulary. Empty when the group defines no staff groups. */
  readonly staffGroups: readonly SnapshotStaffGroup[];
  /** RK-RULING-03's vocabulary. Empty when the group defines no valid groups. */
  readonly validGroups: readonly SnapshotValidGroup[];
  /** The id↔key↔lifecycle triple `RequiresQualification` resolves against. */
  readonly qualifications: readonly SnapshotQualification[];

  /** Every constituent revision, sorted. The configuration-revision record. */
  readonly constituents: readonly SnapshotConstituent[];
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. Refusals — the six classes doc 35 §6a names
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The closed set of reasons a canonical input is refused **before the worker is
 * invoked**.
 *
 * "Before" is the whole design. A build that dispatched an ambiguous or stale
 * problem and discovered the fact from the result would have burned a solve, and
 * — much worse — would have a candidate schedule in hand that looks exactly like
 * a good one. Refusing at assembly means the bad case never becomes a thing a
 * human has to evaluate.
 */
export const SNAPSHOT_REFUSAL_REASONS = [
  /** Two rows in force at once, or two rows claiming the same key. */
  'ambiguous',
  /** A constituent's revision moved between the caller's read and this assembly. */
  'stale-revision',
  /** A constituent belongs to a different group than the one being built. */
  'cross-group',
  /** A fixed input names a participant who is not active and effective. */
  'inactive-participant',
  /** A date is not a real calendar date, or the range is inverted. */
  'invalid-date',
  /** Something the problem cannot be posed without is absent. */
  'missing-required-input',
] as const;
export type SnapshotRefusalReason = (typeof SNAPSHOT_REFUSAL_REASONS)[number];

/**
 * One refusal.
 *
 * `subject` names WHAT was wrong in structural terms — a constituent kind, a
 * field name, an id — and never carries operator free text, a payload, or a row.
 * I-07 and non-bypass rule 9 are not relaxed because this is an input error.
 */
export interface SnapshotRefusal {
  readonly reason: SnapshotRefusalReason;
  readonly subject: string;
  readonly detail: string;
}

/**
 * What the caller believed the world looked like when it last read it.
 *
 * Supplied by a scheduler's earlier read (the same shape the build-launch screen
 * will carry in M4-003). Empty means "I make no claim", which is honest and is
 * NOT treated as agreement: an empty expectation skips the staleness comparison
 * rather than passing it, and the distinction is asserted in the tests.
 */
export type SnapshotRevisionExpectation = readonly SnapshotConstituent[];

/**
 * **Every refusal that can be decided from the assembled document**, in one
 * total function.
 *
 * Returns *all* applicable refusals rather than the first, because a scheduler
 * fixing a build input wants the list. The order is fixed (structural first,
 * then dated, then staleness) so two runs over the same document produce the
 * same list and a test can compare it whole.
 */
export function snapshotRefusals(
  document: SolverInputSnapshotDocument,
  expected: SnapshotRevisionExpectation = [],
): readonly SnapshotRefusal[] {
  const refusals: SnapshotRefusal[] = [];

  /* ── missing-required-input ────────────────────────────────────────────────
   * A problem with no shift types, no demand, or no participants is not a hard
   * problem; it is an unposed one. Dispatching it would return a vacuously
   * "feasible" empty schedule, which is the single most dangerous result this
   * pipeline could produce — it looks like success. */
  if (document.shiftTypes.length === 0) {
    refusals.push({
      reason: 'missing-required-input',
      subject: 'shiftTypes',
      detail: 'the group has no active shift type, so no assignment can be expressed',
    });
  }
  if (document.demand.length === 0) {
    refusals.push({
      reason: 'missing-required-input',
      subject: 'demand',
      detail: 'no weekday default and no period requirement — the problem asks for nothing',
    });
  } else if (!document.demand.some((cell) => cell.source === 'period-requirement')) {
    /* Weekday defaults ALONE are not a problem statement, and the distinction is
     * the difference between a template and a request. The defaults describe
     * what a period is generated FROM; the requirements are what this period
     * actually asks for, on named dates. A build over a period with no
     * requirement rows would return a vacuously feasible empty schedule —
     * which is the single most dangerous result this pipeline could produce,
     * because it looks exactly like success. */
    refusals.push({
      reason: 'missing-required-input',
      subject: 'demand.periodRequirements',
      detail:
        'the period has weekday demand defaults but no dated requirement rows, so nothing is ' +
        'actually being asked for on any date in the range',
    });
  }
  if (document.participants.length === 0) {
    refusals.push({
      reason: 'missing-required-input',
      subject: 'participants',
      detail: 'no active effective participant is in scope for this group and period',
    });
  }
  if (document.timezone.basis.trim() === '') {
    refusals.push({
      reason: 'missing-required-input',
      subject: 'timezone.basis',
      detail: 'no timezone basis: a calendar date has no meaning without one (0014, R-B7)',
    });
  }

  /* ── invalid-date ──────────────────────────────────────────────────────────
   * Through `isCalendarDate`/`compareCalendarDates` — the ONE calendar
   * implementation (000B's). A second spelling of "is this a real date" is the
   * S-01 shape, and it is exactly how `2027-02-29` gets accepted on one path and
   * rejected on another. */
  if (!isCalendarDate(document.startDate)) {
    refusals.push({
      reason: 'invalid-date',
      subject: 'startDate',
      detail: 'the period start is not a real calendar date',
    });
  }
  if (!isCalendarDate(document.endDate)) {
    refusals.push({
      reason: 'invalid-date',
      subject: 'endDate',
      detail: 'the period end is not a real calendar date',
    });
  }
  if (
    isCalendarDate(document.startDate) &&
    isCalendarDate(document.endDate) &&
    compareCalendarDates(document.startDate, document.endDate) > 0
  ) {
    refusals.push({
      reason: 'invalid-date',
      subject: 'dateRange',
      detail: 'the period ends before it starts',
    });
  }
  for (const cell of document.demand) {
    if (cell.source !== 'period-requirement') continue;
    if (!isCalendarDate(cell.on)) {
      refusals.push({
        reason: 'invalid-date',
        subject: `demand.${cell.shiftTypeId}.${cell.on}`,
        detail: 'a period requirement is dated to something that is not a real calendar date',
      });
      continue;
    }
    if (
      isCalendarDate(document.startDate) &&
      isCalendarDate(document.endDate) &&
      (compareCalendarDates(cell.on, document.startDate) < 0 ||
        compareCalendarDates(cell.on, document.endDate) > 0)
    ) {
      refusals.push({
        reason: 'invalid-date',
        subject: `demand.${cell.shiftTypeId}.${cell.on}`,
        detail: 'a period requirement falls outside the period date range',
      });
    }
  }
  for (const fixed of document.fixedAssignments) {
    if (!isCalendarDate(fixed.date)) {
      refusals.push({
        reason: 'invalid-date',
        subject: `fixedAssignments.${fixed.assignmentIdentityId}`,
        detail: 'a fixed assignment is dated to something that is not a real calendar date',
      });
    }
  }

  /* ── ambiguous ─────────────────────────────────────────────────────────────
   * Two rows claiming one slot. The loader's `requireInForce` already throws for
   * two work-profile rows in force at once (which is why that case does not
   * appear here — it cannot reach an assembled document); what CAN reach here is
   * a duplicated key in a set the assembly built, and a duplicate is ambiguity
   * whichever row a consumer happens to read first. */
  pushDuplicates(
    refusals,
    document.participants.map((p) => p.membershipId),
    'participants',
    'the same participant appears twice',
  );
  pushDuplicates(
    refusals,
    document.shiftTypes.map((s) => s.shiftTypeId),
    'shiftTypes',
    'the same shift type appears twice',
  );
  pushDuplicates(
    refusals,
    document.demand.map((d) => `${d.source}:${d.shiftTypeId}:${d.on}`),
    'demand',
    'two demand cells claim the same shift type and day',
  );
  pushDuplicates(
    refusals,
    document.ruleRevisions.map((r) => r.ruleKey),
    'ruleRevisions',
    'the same rule key appears at two revisions',
  );
  pushDuplicates(
    refusals,
    document.constituents.map((c) => `${c.kind}:${c.key}`),
    'constituents',
    'the same constituent is cited at two revisions',
  );
  /* v2 (FAD-38). A duplicated qualification KEY is the ambiguity that matters
   * most here: `RequiresQualification` names a key, so two rows claiming one key
   * would make the rule resolve to whichever row a consumer read first — the
   * exact defect the id↔key vocabulary was added to remove. The id arm is
   * checked too, because a vocabulary that is ambiguous in either direction is
   * not a resolution. */
  pushDuplicates(
    refusals,
    document.qualifications.map((q) => q.key),
    'qualifications',
    'two qualifications claim the same key',
  );
  pushDuplicates(
    refusals,
    document.qualifications.map((q) => q.qualificationId),
    'qualifications',
    'the same qualification id appears twice',
  );
  pushDuplicates(
    refusals,
    document.staffGroups.map((g) => g.staffGroupId),
    'staffGroups',
    'the same staff group appears twice',
  );
  pushDuplicates(
    refusals,
    document.validGroups.map((g) => g.validGroupId),
    'validGroups',
    'the same valid group appears twice',
  );

  /* ── cross-group ───────────────────────────────────────────────────────────
   * Composite foreign keys (0014) make most of this unreachable through the
   * database, and that is exactly why the check is here rather than trusted
   * away: the document is assembled in TypeScript from several reads, and a
   * future assembly bug that joined the wrong set would produce a structurally
   * valid document describing two groups at once. Cheap, total, and it fails the
   * assembly rather than the solve. */
  const known = new Set(document.locations.map((l) => l.locationId));
  const shiftTypeIds = new Set(document.shiftTypes.map((s) => s.shiftTypeId));
  const participantIds = new Set(document.participants.map((p) => p.membershipId));
  for (const cell of document.demand) {
    if (!shiftTypeIds.has(cell.shiftTypeId)) {
      refusals.push({
        reason: 'cross-group',
        subject: `demand.${cell.shiftTypeId}`,
        detail: 'a demand cell names a shift type that is not in this group',
      });
    }
  }
  for (const fixed of document.fixedAssignments) {
    if (!shiftTypeIds.has(fixed.shiftTypeId)) {
      refusals.push({
        reason: 'cross-group',
        subject: `fixedAssignments.${fixed.assignmentIdentityId}`,
        detail: 'a fixed assignment names a shift type that is not in this group',
      });
    }
    if (fixed.locationId !== null && !known.has(fixed.locationId)) {
      refusals.push({
        reason: 'cross-group',
        subject: `fixedAssignments.${fixed.assignmentIdentityId}`,
        detail: 'a fixed assignment names a location that is not in this group',
      });
    }
  }
  /* v2 (FAD-38). The same reasoning, applied to the two new vocabularies: a
   * staff group whose members are not this group's participants, or a valid
   * group naming a shift type this group does not define, is a document
   * describing two groups at once. The composite FKs (0005 tenant identity,
   * 0014) make it unreachable through the database; this is the arm that catches
   * an ASSEMBLY that joined the wrong set. */
  for (const staffGroup of document.staffGroups) {
    for (const membershipId of staffGroup.memberMembershipIds) {
      if (participantIds.has(membershipId)) continue;
      refusals.push({
        reason: 'cross-group',
        subject: `staffGroups.${staffGroup.staffGroupId}`,
        detail:
          'a staff group names a membership that is not an active effective participant of ' +
          'this group for this period',
      });
    }
  }
  for (const validGroup of document.validGroups) {
    for (const shiftTypeId of validGroup.shiftTypeIds) {
      if (shiftTypeIds.has(shiftTypeId)) continue;
      refusals.push({
        reason: 'cross-group',
        subject: `validGroups.${validGroup.validGroupId}`,
        detail: 'a valid group names a shift type that is not in this group',
      });
    }
  }
  /* The qualification vocabulary must COVER every id the rest of the document
   * already uses, or `RequiresQualification` would resolve a key to an id that
   * no holding could ever match and the rule would silently never fire — a false
   * "satisfied", which is the worst direction for a qualification rule to fail
   * in. `missing-required-input` rather than `cross-group`: the vocabulary is
   * incomplete, not foreign. */
  const qualificationIds = new Set(document.qualifications.map((q) => q.qualificationId));
  for (const shiftType of document.shiftTypes) {
    for (const qualificationId of shiftType.requiredQualificationIds) {
      if (qualificationIds.has(qualificationId)) continue;
      refusals.push({
        reason: 'missing-required-input',
        subject: `shiftTypes.${shiftType.shiftTypeId}`,
        detail:
          'a shift-type qualification requirement names a qualification the snapshot ' +
          'vocabulary does not define',
      });
    }
  }
  for (const participant of document.participants) {
    for (const holding of participant.holdings) {
      if (qualificationIds.has(holding.qualificationId)) continue;
      refusals.push({
        reason: 'missing-required-input',
        subject: `participants.${participant.membershipId}.holdings`,
        detail: 'a holding names a qualification the snapshot vocabulary does not define',
      });
    }
  }

  /* ── inactive-participant ──────────────────────────────────────────────────
   * A fixed input naming somebody who is not an active, effective participant.
   * The build cannot honour it and must not silently drop it: dropping a pin is
   * how a "protected" assignment quietly stops being protected. */
  for (const fixed of document.fixedAssignments) {
    if (!participantIds.has(fixed.membershipId)) {
      refusals.push({
        reason: 'inactive-participant',
        subject: `fixedAssignments.${fixed.assignmentIdentityId}`,
        detail:
          'a fixed assignment names a membership that is not an active effective participant ' +
          'of this group for this period',
      });
    }
    if (
      fixed.creditedMembershipId !== null &&
      !participantIds.has(fixed.creditedMembershipId)
    ) {
      refusals.push({
        reason: 'inactive-participant',
        subject: `fixedAssignments.${fixed.assignmentIdentityId}.credit`,
        detail: 'a credit on a fixed assignment names a membership outside the participant set',
      });
    }
  }
  for (const participant of document.participants) {
    if (participant.status !== 'active') {
      refusals.push({
        reason: 'inactive-participant',
        subject: `participants.${participant.membershipId}`,
        detail: `a participant in the snapshot has membership status ${participant.status}`,
      });
    }
  }

  /* ── stale-revision ────────────────────────────────────────────────────────
   * The caller's expectation against what the assembly observed. Both
   * directions are staleness: a constituent that MOVED, and a constituent the
   * caller expected which no longer exists at all (a retired shift type, a
   * deleted requirement). The second is the one a naive comparison misses. */
  const observed = new Map<string, string>(
    document.constituents.map((c) => [`${c.kind}:${c.key}`, c.revision]),
  );
  for (const expectation of expected) {
    const key = `${expectation.kind}:${expectation.key}`;
    const now = observed.get(key);
    if (now === undefined) {
      refusals.push({
        reason: 'stale-revision',
        subject: key,
        detail: 'a constituent the caller read is no longer part of this build input',
      });
      continue;
    }
    if (now !== expectation.revision) {
      refusals.push({
        reason: 'stale-revision',
        subject: key,
        detail: `revision moved from ${expectation.revision} to ${now} since the caller read it`,
      });
    }
  }

  return refusals;
}

/** Duplicate detection, reported once per duplicated key and in a stable order. */
function pushDuplicates(
  into: SnapshotRefusal[],
  keys: readonly string[],
  subject: string,
  detail: string,
): void {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) duplicated.add(key);
    else seen.add(key);
  }
  for (const key of [...duplicated].sort()) {
    into.push({ reason: 'ambiguous', subject: `${subject}.${key}`, detail });
  }
}

/**
 * Raised when a canonical input is refused. Carries every refusal, not the first.
 *
 * The message names reasons and subjects — structure — and never a payload.
 */
export class SnapshotRefusedError extends Error {
  readonly code = 'SOLVER_INPUT_REFUSED';

  constructor(readonly refusals: readonly SnapshotRefusal[]) {
    super(
      `SOLVER_INPUT_REFUSED: ${String(refusals.length)} refusal(s) — ` +
        refusals.map((r) => `${r.reason}@${r.subject}`).join(', '),
    );
    this.name = 'SnapshotRefusedError';
  }

  /** The distinct reason classes, sorted. What an operator triages on. */
  get reasons(): readonly SnapshotRefusalReason[] {
    return [...new Set(this.refusals.map((r) => r.reason))].sort();
  }
}
