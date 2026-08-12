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
  /** `null` is open-ended. `requires_expiry` is enforced at write time (0012). */
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
