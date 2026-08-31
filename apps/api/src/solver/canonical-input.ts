import {
  COMPILER_VERSION,
  RULE_SCHEMA_VERSION,
  SOLVER_SNAPSHOT_SCHEMA_VERSION,
  SnapshotRefusedError,
  evaluateEligibility,
  inclusiveDayCount,
  isCalendarDate,
  snapshotRefusals,
  type QualificationLifecycle,
  type SnapshotConstituent,
  type SnapshotDemandCell,
  type SnapshotEligibility,
  type SnapshotFixedAssignment,
  type SnapshotHolding,
  type SnapshotLocation,
  type SnapshotParticipant,
  type SnapshotQualification,
  type SnapshotRefusal,
  type SnapshotRevisionExpectation,
  type SnapshotRuleRevision,
  type SnapshotShiftType,
  type SnapshotStaffGroup,
  type SnapshotValidGroup,
  type SnapshotWorkProfile,
  type SolverInputSnapshotDocument,
  type UnitOfWork,
  type VerdictHolding,
} from '@schedulepoint/domain';
import { sql, type Kysely } from 'kysely';

import { listShiftTypeQualifications, listShiftTypes } from '../catalogue/service.js';
import { readStaffingSetVersion } from '../catalogue/staffing-set-version.js';
import type { Database } from '../db/schema.js';
import { loadHoldings, loadWeekdayTargets, workProfileInForce } from '../profiles/in-force-loader.js';
import { categoryOf, listRules } from '../rules/service.js';
import { instantOfDate } from '../schedule/hard-rule-revalidation.js';
import { resolveRenderTimezone, timezoneBasisState } from '../schedule/timezone.js';

import { calendarText } from './calendar-text.js';
import { assembleRequestProjection } from './request-projection.js';

/**
 * **Canonical input assembly** — one immutable snapshot of everything a build
 * consumes (OPUS-M4-001; doc 35 §6a, SPEC-04 §3.4).
 *
 * ## One transaction, one world
 *
 * Every read here runs on the caller's unit of work. That is not a style rule:
 * SPEC-04 §3.4 calls `solver_inputs` "a **complete immutable snapshot**", and a
 * snapshot assembled across two transactions is not a snapshot of anything — it
 * is two half-worlds stapled together, and the seam is invisible in the
 * resulting document. Assembly is therefore phase one of a two-phase operation,
 * and **the RPC is phase two, after the transaction commits** (SPEC-12 U-07;
 * see `build-input.ts`, which is the only place the two phases meet).
 *
 * ## Nothing here re-derives a rule that already has one implementation
 *
 * Doc 35 §6a's binding constraint 3 — "no second spelling of any selection rule
 * (the S-01 scanner class)" — is the reason this module is mostly composition:
 *
 *  - **Eligibility** is `evaluateEligibility`, the frozen shared verdict
 *    (`packages/domain/src/eligibility`, doc 34 §4-B). Consumed read-only.
 *  - **Effective-dated staffing rows** come through `in-force-loader.ts`, the
 *    only module in this codebase permitted to select from them —
 *    `loader-is-the-only-selector.test.ts` fails the build otherwise, and it
 *    already caught the review-digest's second spelling once (000C, doc 34 §4a).
 *  - **The timezone basis** is `schedule/timezone.ts`'s, on 0014's columns.
 *  - **Calendar dates** are `packages/domain/src/calendar`'s.
 *  - **Rules** and **shift types** come through their modules' shipped reads.
 *
 * What this module adds is the *shape* and the *refusals*, and even the refusals
 * are decided by a pure function in the domain (`snapshotRefusals`) so that a
 * reviewer's probes can hand-build a pathological document without a database.
 *
 * ## Reading holdings on the ENFORCEMENT plane, and why that is not a widening
 *
 * `qualification_holdings` is `SENSITIVE-PII`: a caller without
 * `staffing.qualification_holding.read_any` sees only their own. A build input
 * assembled on the *caller's visibility* would mark every other participant
 * uncredentialed and the solver would refuse to staff a perfectly well-credentialed
 * group — FAD-23's warning ("an access-control artefact manufacturing a false
 * patient-safety-adjacent statement") fired in the blocking direction, exactly as
 * migration 0012 describes for the publication gate.
 *
 * So the same additive, purpose-scoped policy that gate uses is used here, with
 * the same literal token, opened immediately before the holding reads and
 * cleared immediately after whatever happens. The confinement 0012 states is
 * unchanged: **the tenant predicate does not move**, RLS stays ENABLED and
 * FORCEd, every existing policy stands, and `set_config(name, value, true)` —
 * the sole permitted spelling (non-bypass rule 2) — is transaction-local.
 *
 * What leaves the computation is narrower than what 0012 already sanctions for
 * the publication gate's siblings and narrower than the row: **qualification id,
 * validity window and status, and nothing else.** `evidence_ref` — the free-text
 * field a certificate reference would live in — is deliberately not carried into
 * the snapshot, is never persisted in it, and never crosses to the worker (I-07).
 */

type Uow = UnitOfWork<Kysely<Database>>;

/** The purpose token migration 0012 declared. One literal, one meaning. */
const ENFORCEMENT_READ_TOKEN = 'qualification_requirements';

export interface AssembleCanonicalInputOptions {
  readonly periodId: string;
  readonly versionId: string;
  /**
   * The instant the build is assembled at — what "in force" means (the S-03
   * ruling). A parameter with no default, never `now()` read inside a query:
   * two rows evaluated against two clock readings inside one transaction is the
   * defect class the in-force loader exists to prevent.
   */
  readonly at: Date;
  /**
   * What the caller believed the constituent revisions were when it last read
   * them. Empty makes no claim and skips the comparison — which is honest, and
   * is NOT the same as agreeing.
   */
  readonly expectedRevisions?: SnapshotRevisionExpectation;
  /**
   * **The progressive stage's protected inputs** (OPUS-M4-004; doc 08 §5,
   * SPEC-04 §6, report 21 §5).
   *
   * `build_runs.protected_assignment_identities[]` has existed since migration
   * 0018 and **nothing read it**. A progressive build recorded what it intended
   * to protect and then solved a problem in which those assignments were free to
   * move — which is the worst possible shape for this feature, because the
   * record said the protection had happened.
   *
   * Passing the identities here marks the matching fixed assignments
   * `isPinned` in the document, and a pin is already a hard input on both sides:
   * `cpsat_adapter` fixes the cell to 1, and `validateCandidate` refuses a
   * candidate that dropped one. So the protection travels through the ONE
   * mechanism that already exists rather than through a second one that would
   * have to agree with it.
   *
   * Expressed against the **stable identity**, per doc 08 §5's V-23 amendment:
   * protection must survive a clone into the next candidate version, which a
   * per-version row reference cannot express.
   *
   * An identity that names no assignment on the source version is a REFUSAL, not
   * a silent no-op — "I protected it" and "there was nothing there" must not be
   * the same outcome.
   */
  readonly protectedAssignmentIdentities?: readonly string[];
}

export interface AssembledCanonicalInput {
  readonly document: SolverInputSnapshotDocument;
  readonly constituents: readonly SnapshotConstituent[];
}

/**
 * Read, shape, and refuse. **Runs inside the caller's unit of work.**
 *
 * Throws {@link SnapshotRefusedError} carrying every refusal rather than the
 * first: a scheduler fixing a build input wants the list, and returning one at a
 * time turns a single correction into a queue of round trips.
 */
export async function assembleCanonicalInput(
  uow: Uow,
  options: AssembleCanonicalInputOptions,
): Promise<AssembledCanonicalInput> {
  const query = uow.query;
  const organizationId = uow.context.organizationId;
  const groupId = uow.context.groupId;
  if (groupId === null) {
    throw new SnapshotRefusedError([
      {
        reason: 'missing-required-input',
        subject: 'groupId',
        detail: 'a build input is group-scoped; this unit of work has no group context',
      },
    ]);
  }

  const constituents: SnapshotConstituent[] = [];
  const add = (kind: SnapshotConstituent['kind'], key: string, revision: unknown): void => {
    constituents.push({ kind, key, revision: String(revision) });
  };

  /* ── period and version ───────────────────────────────────────────────────
   * Absent means the caller named something this context cannot see. "Not
   * visible" and "does not exist" are deliberately the same answer here (P-3);
   * the refusal names the field, never whether a row exists elsewhere. */
  const period = (await query
    .selectFrom('schedule_periods')
    .select(['id', 'name', 'start_date', 'end_date', 'status', 'period_version'])
    .where('id', '=', options.periodId)
    .executeTakeFirst()) as unknown as
    | {
        id: string;
        name: string;
        start_date: string | Date;
        end_date: string | Date;
        status: 'planning' | 'published' | 'closed';
        period_version: string;
      }
    | undefined;

  const version = (await query
    .selectFrom('schedule_versions')
    .select(['id', 'period_id', 'state'])
    .where('id', '=', options.versionId)
    .executeTakeFirst()) as unknown as
    | { id: string; period_id: string; state: string }
    | undefined;

  const preflight = [];
  if (period === undefined) {
    preflight.push({
      reason: 'missing-required-input' as const,
      subject: 'period',
      detail: 'the named schedule period is not visible in this context',
    });
  }
  if (version === undefined) {
    preflight.push({
      reason: 'missing-required-input' as const,
      subject: 'version',
      detail: 'the named schedule version is not visible in this context',
    });
  }
  if (period !== undefined && version !== undefined && version.period_id !== period.id) {
    preflight.push({
      reason: 'cross-group' as const,
      subject: 'version.period',
      detail: 'the named version belongs to a different period than the one being built',
    });
  }
  if (preflight.length > 0) throw new SnapshotRefusedError(preflight);
  /* Narrowed by the throw above; TypeScript cannot see through the array. */
  const periodRow = period as NonNullable<typeof period>;

  add('period', periodRow.id, periodRow.period_version);
  add('version', options.versionId, (version as NonNullable<typeof version>).state);

  /* ── timezone, from 0014's basis columns (binding constraint 4) ───────────
   * R-B7: a version authored under one zone and built under another would
   * produce instants nobody authored. `assertTimezoneBasisFresh` is publication's
   * spelling of this; a build takes the same state and refuses on the same arm,
   * as a typed input refusal rather than as an HTTP precondition — the caller
   * here is an assembly, not a route. */
  const basisState = await timezoneBasisState(uow, options.versionId);
  if (basisState.kind === 'stale') {
    throw new SnapshotRefusedError([
      {
        reason: 'stale-revision',
        subject: 'timezoneBasis',
        detail:
          `the version was authored against ${basisState.basis.zone} and the group is now ` +
          `${basisState.currentZone}; its instants were derived under the old zone (R-B7)`,
      },
    ]);
  }
  const renderZone = await resolveRenderTimezone(uow, options.versionId);
  add('timezoneBasis', options.versionId, `${renderZone.zone}@${renderZone.tzdb}`);

  const startDate = calendarText(periodRow.start_date);
  const endDate = calendarText(periodRow.end_date);

  /* ── locations ────────────────────────────────────────────────────────────
   * Archived ones are carried. A shift built while a location was live is
   * explained by that location, and a snapshot that hid it would make the
   * retention pointless. `snapshotRefusals` refuses a fixed assignment naming a
   * location OUTSIDE this set; being archived is not being outside it. */
  const locationRows = (await query
    .selectFrom('locations')
    .select(['id', 'name', 'status', 'timezone', 'version'])
    .orderBy('id')
    .execute()) as unknown as {
    id: string;
    name: string;
    status: 'active' | 'archived';
    timezone: string | null;
    version: number;
  }[];
  const locations: SnapshotLocation[] = locationRows.map((row) => {
    add('location', row.id, row.version);
    return {
      locationId: row.id,
      name: row.name,
      status: row.status,
      timezone: row.timezone,
    };
  });

  /* ── shift types and their ACTIVE qualification requirements ──────────────
   * Doc 34 §4-B: "shift-type qualification requirements enforced even when no
   * duplicate authored rule exists". They are an input in their own right, not
   * a convenience denormalisation of the rule set. */
  const shiftTypeViews = await listShiftTypes(uow);
  const shiftTypes: SnapshotShiftType[] = [];
  const requiredByShiftType = new Map<string, readonly string[]>();
  for (const shiftType of shiftTypeViews) {
    add('shiftType', shiftType.shiftTypeId, shiftType.version);
    if (shiftType.status !== 'active') continue;
    const requirements = await listShiftTypeQualifications(uow, shiftType.shiftTypeId);
    /* `active` is the wire spelling of `shift_type_qualifications.status`:
     * archived requirements are retained because they explain schedules built
     * while they were in force, so the set a build enforces is the ACTIVE one
     * and the archived rows are still cited as constituents. */
    const active = requirements
      .filter((requirement) => requirement.active)
      .map((requirement) => requirement.qualificationId)
      .sort();
    /* ONE constituent per shift type, at the aggregate's own counter, rather
     * than one per edge at a value that never moves.
     *
     * `staffing_set_versions` is the database-owned aggregate CAS counter 000A
     * introduced (migration 0012): its triggers bump it on every insert, update
     * and delete of the content rows, and no application role holds a write
     * grant on it. Citing it is therefore a citation of the SET, which is what a
     * build consumes — and reusing the shipped counter rather than inventing a
     * second notion of "the requirement set changed" is the same discipline the
     * rest of this module follows. */
    add(
      'shiftTypeQualification',
      shiftType.shiftTypeId,
      await readStaffingSetVersion(uow, 'qualification_requirements', shiftType.shiftTypeId),
    );
    requiredByShiftType.set(shiftType.shiftTypeId, active);
    shiftTypes.push({
      shiftTypeId: shiftType.shiftTypeId,
      code: shiftType.code,
      startTime: shiftType.startTime,
      endTime: shiftType.endTime,
      crossesMidnight: shiftType.crossesMidnight,
      isManualOnly: shiftType.isManualOnly,
      /* v2 (FAD-39). The catalogue read already carries it; not carrying it into
       * the snapshot was the omission, not a missing column. */
      isOnCall: shiftType.isOnCall,
      creditWeight: String(shiftType.creditWeight),
      status: shiftType.status,
      requiredQualificationIds: active,
    });
  }

  /* ── demand: catalogue defaults AND the period's requirement rows ─────────
   * Both, because they are different facts. The defaults are the template a
   * period is generated from; the requirements are what this period actually
   * asks for. A build that consumed only one of them would either ignore an
   * editor's per-day correction or ignore the template it was derived from. */
  const weekdayRows = (await query
    .selectFrom('shift_type_weekday_demand')
    .select(['shift_type_id', 'day', 'demand_count'])
    .orderBy('shift_type_id')
    .orderBy('day')
    .execute()) as unknown as {
    shift_type_id: string;
    day: string;
    demand_count: number;
  }[];
  const requirementRows = (await query
    .selectFrom('schedule_requirements')
    .select(['shift_type_id', 'date', 'required_count'])
    .where('period_id', '=', options.periodId)
    .orderBy('date')
    .orderBy('shift_type_id')
    .execute()) as unknown as {
    shift_type_id: string;
    date: string | Date;
    required_count: number;
  }[];

  const demand: SnapshotDemandCell[] = [];
  for (const row of weekdayRows) {
    demand.push({
      source: 'weekday-default',
      shiftTypeId: row.shift_type_id,
      on: row.day,
      requiredCount: row.demand_count,
    });
  }
  for (const row of requirementRows) {
    demand.push({
      source: 'period-requirement',
      shiftTypeId: row.shift_type_id,
      on: calendarText(row.date),
      requiredCount: row.required_count,
    });
  }

  /* Demand is cited at the AGGREGATE, not per row.
   *
   * `shift_type_weekday_demand.version` and `schedule_requirements`'
   * `requirement_version` are per-row columns that nothing maintains on update —
   * citing them would produce a revision that never moves, which is worse than
   * no citation because it would make a staleness check pass forever. The thing
   * that DOES move is `staffing_set_versions`, the database-owned counter 000A
   * built for exactly this question and whose triggers fire on every insert,
   * update and delete of the content rows. It is also the token the editors'
   * compare-and-set already uses, so the build's notion of "demand changed" and
   * the editor's are the same notion. */
  for (const shiftType of shiftTypes) {
    add(
      'weekdayDemand',
      shiftType.shiftTypeId,
      await readStaffingSetVersion(uow, 'weekday_demand', shiftType.shiftTypeId),
    );
  }
  add(
    'requirement',
    options.periodId,
    await readStaffingSetVersion(uow, 'period_requirements', options.periodId),
  );

  /* ── qualification lifecycles ─────────────────────────────────────────────
   * The verdict needs them and treats an unresolvable one as retired
   * (fail-closed). Retiring a qualification changes who is eligible without
   * touching a single holding, which is why the DEFINITIONS are a constituent
   * of their own. */
  const qualificationRows = (await query
    .selectFrom('qualifications')
    .select(['id', 'key', 'status', 'requires_expiry', 'version'])
    .orderBy('key')
    .execute()) as unknown as {
    id: string;
    key: string;
    status: QualificationLifecycle;
    requires_expiry: boolean;
    version: number;
  }[];
  const lifecycles = new Map<string, QualificationLifecycle>();
  /* v2 (OPUS-M4-002, FAD-38): the id↔key↔status VOCABULARY, alongside the
   * revision citation that was already here.
   *
   * The citation pins *what moved*; the vocabulary answers *what the key means*.
   * v1 carried only the first, so `RequiresQualification(qualification = <key>)`
   * — a rule whose identifier domain the AST pins as `qualifications.key` — could
   * not be resolved to the ids `holdings[]` and `shiftTypes[]` carry, and the
   * worker could not model it at all. Read from the SAME rows in the SAME
   * transaction as the citation, so the two can never disagree.
   *
   * `requires_expiry` is read here because the CITATION includes it (a flip
   * changes what a build may legally contain) and is deliberately NOT carried
   * into the vocabulary: no evaluation consults it, and 0012/0017 own it at
   * write time. */
  const qualifications: SnapshotQualification[] = [];
  for (const row of qualificationRows) {
    lifecycles.set(row.id, row.status);
    add('qualification', row.key, `${row.version}:${row.status}:${String(row.requires_expiry)}`);
    qualifications.push({ qualificationId: row.id, key: row.key, status: row.status });
  }

  /* ── participants ─────────────────────────────────────────────────────────
   * Group memberships only. An ORGANIZATION membership has no group dimension
   * and is not a schedulable participant; including it would put an
   * administrator into the staffing pool. FAD-31 recorded functional and
   * placeholder participants as explicitly out of M4 solver-input scope, and
   * this schema has no such kind, so nothing here silently admits one. */
  const membershipRows = (await query
    .selectFrom('memberships')
    .select(['id', 'kind', 'staffing_kind', 'status', 'valid_from', 'valid_to'])
    .where('kind', '=', 'group')
    .orderBy('id')
    .execute()) as unknown as {
    id: string;
    kind: 'organization' | 'group';
    staffing_kind: 'staff' | 'locum';
    status: 'invited' | 'active' | 'suspended' | 'ended';
    valid_from: Date;
    valid_to: Date | null;
  }[];

  const effective = membershipRows.filter((row) => isEffectiveAt(row, options.at));
  const holdingsByMembership = await loadHoldingsForEnforcement(
    query,
    organizationId,
    effective.map((row) => row.id),
  );

  const participants: SnapshotParticipant[] = [];
  for (const row of effective) {
    const holdings = holdingsByMembership.get(row.id) ?? [];
    for (const holding of holdings) add('qualificationHolding', holding.id, holding.version);

    const selection = await workProfileInForce(query, {
      organizationId,
      membershipId: row.id,
      at: options.at,
    });
    const inForce = selection.kind === 'in-force' ? selection.row : null;
    const targets =
      inForce === null
        ? []
        : await loadWeekdayTargets(query, { organizationId, workProfileIds: [inForce.id] });

    const workProfile: SnapshotWorkProfile | null =
      inForce === null
        ? null
        : {
            workProfileId: inForce.id,
            effectiveFrom: inForce.effectiveFrom,
            effectiveTo: inForce.effectiveTo,
            workPercentage: inForce.workPercentage,
            maxAssignmentsPerWeek: inForce.maxAssignmentsPerWeek,
            maxAssignmentsPerPeriod: inForce.maxAssignmentsPerPeriod,
            maxConsecutiveDays: inForce.maxConsecutiveDays,
            weekdayTargets: targets
              .map((target) => ({
                day: target.day,
                fteFraction: target.fteFraction,
                maxAssignments: target.maxAssignments,
              }))
              .sort((a, b) => a.day.localeCompare(b.day)),
          };

    /* Eligibility is evaluated **at the shift date's instant**, not at "now"
     * (CAP-058). A period spans weeks, and a credential that expires inside it
     * makes a member eligible on the Monday and not on the Friday — collapsing
     * that to one verdict per member is how an expired credential gets
     * scheduled. So the verdict is per (participant, shift type, date) and the
     * snapshot carries the per-shift-type roll-up plus the dates it holds for.
     *
     * The instant convention is `instantOfDate`'s — MIDDAY UTC, the one instant
     * no offset in use (UTC−12..UTC+14) can move across a date boundary. Reused
     * rather than respelled, for exactly the reason the rest of this module is
     * composition. */
    const eligibility: SnapshotEligibility[] = [];
    for (const shiftType of shiftTypes) {
      const required = requiredByShiftType.get(shiftType.shiftTypeId) ?? [];
      const outcomes = new Set<string>();
      let eligibleEveryDay = true;
      for (const date of buildDates(startDate, endDate)) {
        const verdict = evaluateEligibility({
          requiredQualificationIds: required,
          holdings: holdings as readonly VerdictHolding[],
          qualificationLifecycles: lifecycles,
          membershipState: row.status,
          workProfileInForce: inForce !== null,
          at: instantOfDate(date),
        });
        if (!verdict.eligible) eligibleEveryDay = false;
        for (const entry of verdict.qualifications) {
          outcomes.add(`${entry.qualificationId}:${entry.outcome}`);
        }
      }
      eligibility.push({
        shiftTypeId: shiftType.shiftTypeId,
        eligible: eligibleEveryDay,
        outcomes: [...outcomes].sort(),
      });
    }

    participants.push({
      membershipId: row.id,
      membershipKind: row.kind,
      staffingKind: row.staffing_kind,
      status: row.status,
      validFrom: row.valid_from.toISOString(),
      validTo: row.valid_to === null ? null : row.valid_to.toISOString(),
      workProfile,
      holdings: holdings.map(
        (holding): SnapshotHolding => ({
          qualificationId: holding.qualificationId,
          validFrom: holding.effectiveFrom,
          validUntil: holding.effectiveTo,
          status: holding.status,
        }),
      ),
      eligibility,
    });
  }

  /* ── fixed inputs: pins, protected ranges, manual assignments ─────────────
   * SPEC-04 §6: a progressive build's fixed inputs are **recorded rather than
   * inferred**. Everything active on the target version is carried, with its
   * pin flag and its credit, because a solver that could not see a credit could
   * move an assignment and silently orphan the score attached to it. */
  const fixedRows = await sql<{
    assignment_identity_id: string;
    membership_id: string;
    date: string | Date;
    shift_type_id: string;
    location_id: string | null;
    is_pinned: boolean;
    origin: 'manual' | 'clone' | 'solver' | 'picklist' | 'vacation_commit';
    credited_membership_id: string | null;
    weight: string | null;
  }>`
    SELECT s.assignment_identity_id, s.membership_id, s.date, s.is_pinned, s.origin,
           sh.shift_type_id, sh.location_id,
           c.credited_membership_id, c.weight
      FROM assignment_snapshots s
      JOIN shifts sh ON sh.id = s.shift_id
      LEFT JOIN credits c
        ON c.source_snapshot_id = s.id AND c.status = 'active'
     WHERE s.version_id = ${options.versionId}
       AND s.status = 'active'
     ORDER BY s.date, sh.shift_type_id, s.membership_id
  `.execute(query);

  /* OPUS-M4-004 — the progressive stage's protected identities, applied.
   *
   * `protected` UNIONS with the version's own pins; it never clears one. A
   * progressive stage protects MORE than the draft already did, and a stage that
   * silently unpinned something the scheduler had pinned by hand would be the
   * "explicit unlocking" report 21 §5 requires to be a deliberate action,
   * happening as a side effect of regeneration. */
  const protectedIdentities = new Set(options.protectedAssignmentIdentities ?? []);
  const presentIdentities = new Set(fixedRows.rows.map((row) => row.assignment_identity_id));
  const protectionRefusals: SnapshotRefusal[] = [];
  for (const identity of [...protectedIdentities].sort()) {
    if (presentIdentities.has(identity)) continue;
    protectionRefusals.push({
      reason: 'missing-required-input',
      subject: `protectedAssignmentIdentities.${identity}`,
      detail:
        'a progressive build protects an assignment identity that is not on the source ' +
        'version; protecting nothing and protecting something must not be the same outcome',
    });
  }

  const fixedAssignments: SnapshotFixedAssignment[] = fixedRows.rows.map((row) => ({
    assignmentIdentityId: row.assignment_identity_id,
    membershipId: row.membership_id,
    date: calendarText(row.date),
    shiftTypeId: row.shift_type_id,
    locationId: row.location_id,
    isPinned: row.is_pinned || protectedIdentities.has(row.assignment_identity_id),
    origin: row.origin,
    creditedMembershipId: row.credited_membership_id,
    creditWeight: row.weight,
  }));

  /* ── staff groups and valid groups (snapshot v2 — OPUS-M4-002, FAD-38) ────
   *
   * RK-RULING-02 pins `MemberOfStaffGroup.staffGroup` and `RuleScope.staffGroups`
   * to `staff_groups.id`; RK-RULING-03 pins `ValidGroupRestriction.validGroup` to
   * `valid_groups.id`. Neither could be evaluated at v1 because neither
   * vocabulary was in the document — and because `scope.staffGroups` filters
   * EVERY kind, its absence made any staff-group-scoped rule of any kind
   * unresolvable. Migration 0005 has carried all four tables since M2; this is a
   * document-shape gap, not a schema one, which is why v2 needs no migration.
   *
   * **ACTIVE rows only, and only ACTIVE edges.** Archived staff groups and valid
   * groups are excluded on the same reasoning the rule set uses one line below:
   * archiving something is what makes a build stop consulting it. The
   * `is_active` edge flags are honoured for the same reason — a deactivated
   * membership edge is not a membership.
   *
   * `name` is read for neither. The ruling's whole point is that a rename must
   * not change a rule's historical meaning, so carrying the mutable display
   * string into the immutable snapshot would put a moving value inside the hash
   * for no evaluation to consume. */
  const staffGroupRows = (await query
    .selectFrom('staff_groups')
    .select(['id', 'version'])
    .where('status', '=', 'active')
    .orderBy('id')
    .execute()) as unknown as { id: string; version: number }[];
  const staffGroupMemberRows = (await query
    .selectFrom('staff_group_members')
    .select(['staff_group_id', 'membership_id'])
    .where('is_active', '=', true)
    .orderBy('staff_group_id')
    .orderBy('membership_id')
    .execute()) as unknown as { staff_group_id: string; membership_id: string }[];

  /* The participant set the snapshot actually carries — a staff group may name
   * somebody who is not an effective participant of THIS period (ended, not yet
   * started, suspended), and carrying that edge would make a rule scoped to the
   * group refer to a person the document does not contain. `snapshotRefusals`
   * refuses exactly that shape, so filtering here is what keeps a legitimate
   * roster change from becoming an assembly refusal. */
  const participantIdSet = new Set(participants.map((participant) => participant.membershipId));
  const membersByStaffGroup = new Map<string, string[]>();
  for (const row of staffGroupMemberRows) {
    if (!participantIdSet.has(row.membership_id)) continue;
    const list = membersByStaffGroup.get(row.staff_group_id);
    if (list === undefined) membersByStaffGroup.set(row.staff_group_id, [row.membership_id]);
    else list.push(row.membership_id);
  }
  const staffGroups: SnapshotStaffGroup[] = staffGroupRows.map((row) => {
    add('staffGroup', row.id, row.version);
    return {
      staffGroupId: row.id,
      memberMembershipIds: (membersByStaffGroup.get(row.id) ?? []).sort(),
    };
  });

  const validGroupRows = (await query
    .selectFrom('valid_groups')
    .select(['id', 'allowed_pick_positions', 'version'])
    .where('status', '=', 'active')
    .orderBy('id')
    .execute()) as unknown as {
    id: string;
    allowed_pick_positions: number[];
    version: number;
  }[];
  const validGroupShiftTypeRows = (await query
    .selectFrom('valid_group_shift_types')
    .select(['valid_group_id', 'shift_type_id'])
    .where('is_active', '=', true)
    .orderBy('valid_group_id')
    .orderBy('shift_type_id')
    .execute()) as unknown as { valid_group_id: string; shift_type_id: string }[];

  /* Retired shift types are excluded from `shiftTypes` above, so an edge naming
   * one would fail the cross-group refusal. Filtering to the carried set keeps a
   * retired shift type from turning a live valid group into a refused assembly. */
  const carriedShiftTypeIds = new Set(shiftTypes.map((shiftType) => shiftType.shiftTypeId));
  const shiftTypesByValidGroup = new Map<string, string[]>();
  for (const row of validGroupShiftTypeRows) {
    if (!carriedShiftTypeIds.has(row.shift_type_id)) continue;
    const list = shiftTypesByValidGroup.get(row.valid_group_id);
    if (list === undefined) shiftTypesByValidGroup.set(row.valid_group_id, [row.shift_type_id]);
    else list.push(row.shift_type_id);
  }
  const validGroups: SnapshotValidGroup[] = validGroupRows.map((row) => {
    add('validGroup', row.id, row.version);
    return {
      validGroupId: row.id,
      allowedPickPositions: [...row.allowed_pick_positions].sort((a, b) => a - b),
      shiftTypeIds: (shiftTypesByValidGroup.get(row.id) ?? []).sort(),
    };
  });

  /* ── rule revisions (0015) ────────────────────────────────────────────────
   * `rules.version` IS the revision number (migration 0015 §4), so the citation
   * a build records reads `rule_key@revision` and the immutable `rule_revisions`
   * row for that pair reconstructs the AST byte-identically. Disabled and
   * archived rules are excluded — that is what disabling a rule MEANS. */
  const ruleViews = await listRules(uow);
  const ruleRevisions: SnapshotRuleRevision[] = [];
  for (const rule of ruleViews) {
    if (rule.state !== 'active') continue;
    add('rule', rule.ruleKey, rule.version);
    ruleRevisions.push({
      ruleKey: rule.ruleKey,
      revision: String(rule.version),
      ruleSchemaVersion: rule.ruleSchemaVersion,
      classification: rule.classification,
      /* `rules.category` is database-owned and absent from `RuleView`. It is
       * recomputed through `categoryOf` — the SHIPPED discriminator the writer
       * itself uses (FAD-21) — rather than re-decided here, so the snapshot's
       * category and the stored column cannot disagree. */
      category: categoryOf(
        /* The contracts type and the domain type describe the same data with
         * different optionality strictness (`exactOptionalPropertyTypes` makes
         * `{ a?: T }` and `{ a?: T | undefined }` distinct). The cast crosses
         * that one difference and nothing else — the VALUES are the stored AST,
         * already validated on the way in. */
        rule.scope as unknown as Parameters<typeof categoryOf>[0],
        rule.predicate as unknown as Parameters<typeof categoryOf>[1],
      ),
      weight: rule.weight === null ? null : String(rule.weight),
      status: rule.state,
      scope: rule.scope,
      predicate: rule.predicate,
    });
  }

  constituents.sort((a, b) =>
    a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key),
  );

  /* SPEC-08 §6 (OPUS-M5-004). `availabilityIsBinding` is `false` because §6's
   * qualifier — "where group policy makes it binding" — names a group policy
   * this schema does not have; `request-projection.ts`'s docblock carries the
   * verification and the narrower-never-wider reasoning, and this is the one
   * line that changes when the policy lands. */
  const requestProjection = await assembleRequestProjection(uow, {
    startDate,
    endDate,
    availabilityIsBinding: false,
  });

  const document: SolverInputSnapshotDocument = {
    snapshotSchemaVersion: SOLVER_SNAPSHOT_SCHEMA_VERSION,
    compilerVersion: COMPILER_VERSION,
    ruleSchemaVersion: RULE_SCHEMA_VERSION,
    organizationId,
    groupId,
    periodId: periodRow.id,
    versionId: options.versionId,
    periodName: periodRow.name,
    periodStatus: periodRow.status,
    startDate,
    endDate,
    dayCount:
      isCalendarDate(startDate) && isCalendarDate(endDate)
        ? Math.max(0, inclusiveDayCount(startDate, endDate))
        : 0,
    timezone: {
      basis: renderZone.zone,
      tzdbVersion: renderZone.tzdb,
      source: renderZone.source,
    },
    locations,
    shiftTypes,
    demand,
    participants,
    fixedAssignments,
    ruleRevisions,
    /* v2 (FAD-38) — the three vocabularies, appended. */
    staffGroups,
    validGroups,
    qualifications,
    /* v3 (OPUS-M5-004) — SPEC-08 §6: "The projection is part of the pinned
     * `solver_inputs` snapshot." Assembled on THIS unit of work, so the
     * absences the document carries are the absences that were true when the
     * participants and the demand were read. */
    requestProjection,
    constituents,
  };

  /* The document's own refusals FIRST, then this assembly's. `snapshotRefusals`
   * is the shared, pure statement of what makes a snapshot unposeable and it
   * cannot see a caller-supplied protection list, so the two lists are
   * concatenated rather than one of them being taught about the other. */
  const refusals = [...snapshotRefusals(document, options.expectedRevisions ?? []), ...protectionRefusals];
  if (refusals.length > 0) throw new SnapshotRefusedError(refusals);

  return { document, constituents };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Reads and coercions
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Holdings for the whole participant set, on the enforcement plane.
 *
 * The token is set once for the whole set and cleared in a `finally`, so the
 * widened arm exists for the span of these reads and no longer — including when
 * a read throws. The selection itself is still `loadHoldings`, the one selector;
 * what changes is which rows RLS admits, not how "in force" is decided.
 */
async function loadHoldingsForEnforcement(
  query: Kysely<Database>,
  organizationId: string,
  membershipIds: readonly string[],
): Promise<Map<string, Awaited<ReturnType<typeof loadHoldings>>>> {
  const byMembership = new Map<string, Awaited<ReturnType<typeof loadHoldings>>>();
  await sql`select set_config('app.enforcement_read', ${ENFORCEMENT_READ_TOKEN}, true)`.execute(
    query,
  );
  try {
    for (const membershipId of membershipIds) {
      byMembership.set(membershipId, await loadHoldings(query, { organizationId, membershipId }));
    }
  } finally {
    await sql`select set_config('app.enforcement_read', '', true)`.execute(query);
  }
  return byMembership;
}


/**
 * Every date in the period, or an empty list when either bound is not a real
 * date.
 *
 * The empty list is deliberate rather than a throw: an impossible range is
 * already a refusal `snapshotRefusals` will report with its subject and its
 * reason, and throwing here would replace that report with a stack trace from a
 * helper.
 */
function buildDates(startDate: string, endDate: string): readonly string[] {
  if (!isCalendarDate(startDate) || !isCalendarDate(endDate)) return [];
  const days = inclusiveDayCount(startDate, endDate);
  if (days <= 0) return [];
  const dates: string[] = [];
  const [y, m, d] = startDate.split('-').map((part) => Number.parseInt(part, 10));
  const cursor = new Date(Date.UTC(y as number, (m as number) - 1, d as number));
  for (let index = 0; index < days; index += 1) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/**
 * A membership is a participant when the build instant is inside its window and
 * its status is `active`.
 *
 * The half-open convention `[valid_from, valid_to)` is the one every effective
 * window in this schema uses (`containsInstant`, the holding window, the work
 * profile window). A membership that ends *at* the build instant has ended.
 *
 * Non-`active` memberships are excluded here, and `snapshotRefusals` refuses any
 * that reach the document anyway — belt and braces on purpose: this filter is
 * the ordinary path, and the refusal is what catches a future change to it.
 */
function isEffectiveAt(
  row: { status: string; valid_from: Date; valid_to: Date | null },
  at: Date,
): boolean {
  if (row.status !== 'active') return false;
  if (row.valid_from.getTime() > at.getTime()) return false;
  if (row.valid_to !== null && row.valid_to.getTime() <= at.getTime()) return false;
  return true;
}
