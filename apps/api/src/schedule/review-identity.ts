import type { UnitOfWork } from '@schedulepoint/domain';
import { sql, type Kysely } from 'kysely';

import type { Database } from '../db/schema.js';
import {
  loadHoldings,
  loadWeekdayTargets,
  loadWorkProfiles,
} from '../profiles/in-force-loader.js';
import { digestRows } from './render.js';

/**
 * The ONE material-change definition, and the publication review identity
 * (OPUS-M4-000C; doc 34 §4-G, doc 35 §5).
 *
 * ## Two things live here, and they answer two different questions
 *
 *  1. **{@link materialChangeFields}** — "in what way did this assignment
 *     change?" One definition, consumed by the schedule difference
 *     (`diff.ts`), by the affected-participant calculation (the same function,
 *     one level down) and by the review digest. Doc 34 §4-G requires those three
 *     to share a definition, and before this they did not: `differenceByIdentity`
 *     compared participant and instants and NOTHING else, so moving an
 *     assignment to a different shift type, moving it to a different location,
 *     pinning it, or moving its credit to another person all produced **no
 *     change at all** — no diff row, nobody notified, and a review digest that
 *     did not move when the schedule did.
 *
 *  2. **{@link materialInputDigest}** — "is the world I reviewed still the world
 *     I am publishing?" The M3-005 review digest covered the four fields the old
 *     diff decided. Doc 34 §4-G expands the review identity to every material
 *     input: participant, date, time, shift type, location, pin, credit,
 *     conflicts, rule revisions, catalogue revisions, profiles, qualifications,
 *     demand and timezone.
 *
 * ## Why the expansion does not break FAD-26's shipped CAS
 *
 * FAD-26 ratified the review-digest compare-and-set: the review response carries
 * `reviewDigest`, the publication echoes it as `expectedReviewDigest`, a
 * mismatch is `409 STALE_REVIEW` with the current digest, and omission is a 422
 * rather than a bypass. **All of that is unchanged.** The token is still one
 * opaque string of the same wire type; only what feeds it grows. That is an
 * extension of the shape, not a conflict with it — which is why this did not
 * need the escalation the packet reserved for a genuine conflict.
 *
 * It DOES change the invalidation semantics, deliberately, and the change is
 * worth stating because it is a real trade: a review now goes stale when a rule
 * is amended, a qualification expires, demand is edited or the group timezone
 * moves — none of which alters the diff, and all of which alter what the
 * publication will actually do. The M3-005 digest was scoped to core changes so
 * that "a renamed person" could not invalidate an accurate review. That
 * reasoning still holds and is preserved: **decoration is still excluded.** A
 * display name, a shift-type colour, a report order — none of them is in the
 * digest. What is in it is what changes the SCHEDULE or the DECISION, and a
 * publication that quietly used a different rule revision than the one reviewed
 * is exactly the thing a review is supposed to prevent.
 *
 * ## Pure where it can be, and a read where it cannot
 *
 * `materialChangeFields` is pure and total over two plain values, so the
 * definition is testable without a database and the equality the packet asks for
 * is an assertion rather than an argument. `materialInputDigest` must read, so
 * it takes a unit of work and reads everything inside it — one transaction, one
 * consistent world (I-15).
 */

type Uow = UnitOfWork<Kysely<Database>>;

/* ────────────────────────────────────────────────────────────────────────────
 * 1. The material-change definition
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The dimensions along which an assignment can materially change.
 *
 * Doc 34 §4-G names time, shift type, location, pins and credits; `participant`
 * and `date` are here because they were already material and leaving them out of
 * the shared definition would leave two definitions again.
 *
 * A closed set, ordered, so a `materialFields` list is deterministic and two
 * runs never differ.
 */
export const MATERIAL_FIELDS = [
  'participant',
  'date',
  'time',
  'shiftType',
  'location',
  'pin',
  'credit',
] as const;
export type MaterialField = (typeof MATERIAL_FIELDS)[number];

/**
 * One assignment, flattened to exactly the facts that are material.
 *
 * Everything here changes what the schedule MEANS. Nothing here is decoration:
 * there is no display name, no colour, no ordering, no `updated_at`. That
 * exclusion is the reason a review can stay valid while the world moves around
 * it in ways that do not matter.
 */
export interface MaterialAssignment {
  readonly assignmentIdentityId: string;
  readonly membershipId: string;
  /** `YYYY-MM-DD` in the group's timezone. */
  readonly date: string;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
  readonly shiftTypeId: string;
  /** `null` is a stated, allowed state — a shift need not name a location. */
  readonly locationId: string | null;
  /** A solver INPUT, not a display flag: unpinning changes what a build may do. */
  readonly isPinned: boolean;
  /** The membership CREDITED for this assignment, which may differ from the assignee. */
  readonly creditedMembershipId: string | null;
  /** `numeric` as the driver renders it, compared as a string so 1.0 ≠ 1.00 is not invented. */
  readonly creditWeight: string | null;
}

/**
 * **The single definition.** In what ways do these two states of one assignment
 * differ materially?
 *
 * An empty result means "identical content", and its holder is NOT affected —
 * the half of the property a difference returning "everyone" would fail.
 */
export function materialChangeFields(
  before: MaterialAssignment,
  after: MaterialAssignment,
): readonly MaterialField[] {
  const fields: MaterialField[] = [];
  if (before.membershipId !== after.membershipId) fields.push('participant');
  if (before.date !== after.date) fields.push('date');
  if (before.startsAtMs !== after.startsAtMs || before.endsAtMs !== after.endsAtMs) {
    fields.push('time');
  }
  if (before.shiftTypeId !== after.shiftTypeId) fields.push('shiftType');
  if (before.locationId !== after.locationId) fields.push('location');
  if (before.isPinned !== after.isPinned) fields.push('pin');
  if (
    before.creditedMembershipId !== after.creditedMembershipId ||
    before.creditWeight !== after.creditWeight
  ) {
    fields.push('credit');
  }
  return fields;
}

/**
 * Every membership with a stake in one assignment's state.
 *
 * The assignee AND the credited membership, because "who works a shift and who
 * is scored for it can legitimately differ" (doc 07). A credit moved from A to B
 * affects both of them and neither is the assignee.
 */
export function materialStakeholders(assignment: MaterialAssignment): readonly string[] {
  const stakeholders = [assignment.membershipId];
  if (
    assignment.creditedMembershipId !== null &&
    assignment.creditedMembershipId !== assignment.membershipId
  ) {
    stakeholders.push(assignment.creditedMembershipId);
  }
  return stakeholders;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. The material-input digest
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Every material input to a publication, as a digest per input class.
 *
 * Per class rather than one opaque number, so a `409 STALE_REVIEW` can later be
 * explained ("the rules changed", "demand changed") instead of only announced.
 * The composite {@link materialInputDigest} is what the CAS compares.
 */
export interface MaterialInputDigests {
  /** Participant, date, time, shift type, location, pin — the version's own content. */
  readonly assignments: string;
  /** Credits attached to this version. */
  readonly credits: string;
  /** Open conflicts against this version: they are publication blockers. */
  readonly conflicts: string;
  /** `rule_key@revision` for every ACTIVE rule — the exact revisions this publication uses. */
  readonly ruleRevisions: string;
  /** Shift-type and location catalogue revisions. */
  readonly catalogueRevisions: string;
  /** In-force work profiles and their weekday FTE. */
  readonly profiles: string;
  /** Qualification definitions and holdings — what makes an assignee eligible. */
  readonly qualifications: string;
  /** Weekday demand defaults and the period's requirement rows. */
  readonly demand: string;
  /** The GROUP timezone: it decides what a calendar date means. */
  readonly timezone: string;
}

/** The digest names, in the fixed order the composite is built from. */
export const MATERIAL_INPUT_CLASSES = [
  'assignments',
  'credits',
  'conflicts',
  'ruleRevisions',
  'catalogueRevisions',
  'profiles',
  'qualifications',
  'demand',
  'timezone',
] as const satisfies readonly (keyof MaterialInputDigests)[];

/**
 * Read and digest every material input for one version in one period.
 *
 * Everything is read through the caller's unit of work, so the whole digest
 * describes one consistent world. Nothing here is decoration — see the header
 * for why that exclusion is load-bearing.
 *
 * `digestRows` is the schedule module's own length-prefixed digest, reused
 * rather than reimplemented: several of these columns hold operator free text,
 * and a `key=value` digest could be forged by typing a delimiter into a reason
 * (N-7).
 */
export async function materialInputDigests(
  uow: Uow,
  periodId: string,
  versionId: string,
): Promise<MaterialInputDigests> {
  const query = uow.query;

  const assignments = await sql<Record<string, unknown>>`
    SELECT s.assignment_identity_id, s.membership_id, s.date, s.starts_at, s.ends_at,
           s.is_pinned, s.status, sh.shift_type_id, sh.location_id
      FROM assignment_snapshots s
      JOIN shifts sh ON sh.id = s.shift_id
     WHERE s.version_id = ${versionId}
  `.execute(query);

  const credits = await sql<Record<string, unknown>>`
    SELECT assignment_identity_id, credited_membership_id, weight, status
      FROM credits
     WHERE source_version_id = ${versionId}
  `.execute(query);

  const conflicts = await sql<Record<string, unknown>>`
    SELECT id, severity, state
      FROM schedule_conflicts
     WHERE version_id = ${versionId}
  `.execute(query);

  /* The EXACT rule revisions. `rules.version` is the revision number
   * (migration 0015), so this is the citation a build records and the thing a
   * reviewer is entitled to have held still: a publication that silently used a
   * different rule revision than the one reviewed is precisely what a review
   * exists to prevent. */
  const ruleRevisions = await sql<Record<string, unknown>>`
    SELECT rule_key, version AS revision, classification, status
      FROM rules
     WHERE status = 'active'
  `.execute(query);

  /* Through the TYPED builder rather than raw SQL.
   *
   * Both tables are in the `Database` interface, so nothing here needs a raw
   * statement — and the I-15 architecture scan
   * (`test/architecture/no-tenant-access-outside-unit-of-work.test.ts`) flagged
   * the raw form. Its tenant-table detector fires on a line where a quoted
   * literal precedes `FROM <tenant table>`, which is the shape of a one-line
   * `client.query('select … from memberships')` — the thing it exists to catch.
   * The original `SELECT 'shift_type' AS kind … FROM shift_types` matched that
   * shape because of its own discriminator literal.
   *
   * Every statement in this module already runs through `uow.query` inside the
   * caller's transaction, so it was a false positive rather than an I-15
   * breach — but the right answer to a control that fires is to remove the
   * shape, not to reformat around the regex and not to widen the allow-list
   * (which suppresses the CONNECTION detectors too, and would have recorded a
   * reason that was not true). Two typed reads are also simply better: they are
   * checked against the schema, and the hand-written UNION goes away. */
  const shiftTypeRevisions = await query
    .selectFrom('shift_types')
    .select(['id', 'version', 'status'])
    .execute();
  const locationRevisions = await query
    .selectFrom('locations')
    .select(['id', 'version', 'status'])
    .execute();
  const catalogueRevisions = [
    ...shiftTypeRevisions.map((row) => ({ kind: 'shift_type', ...row })),
    ...locationRevisions.map((row) => ({ kind: 'location', ...row })),
  ];

  /* ── Profiles and qualifications, THROUGH THE ONE SELECTOR ────────────────
   *
   * `apps/api/src/profiles/in-force-loader.ts` is "the only module in this
   * codebase that selects from an effective-dated staffing table", and that is a
   * rule with a scanner behind it
   * (`test/profiles/loader-is-the-only-selector.test.ts`).
   *
   * The first version of this function issued its own
   * `effective_from <= now() AND (effective_to IS NULL OR effective_to > now())`
   * and its own join on `qualification_holdings`. The scanner caught it, and it
   * was right to: that is the S-01 defect exactly — a second spelling of a
   * window rule, reasonable-looking at its own call site, that disagrees with
   * the first for any tenant which has ever re-windowed a row. A review digest
   * computed from a second reading of "in force" would go stale, or fail to go
   * stale, on precisely the tenants where the answer matters.
   *
   * ## Scoped to the memberships this version actually involves
   *
   * The loader is per-membership, so the digest needs a set. It uses the
   * assignees and credited memberships of THIS version rather than every
   * membership in the group — cheaper, and more precisely correct: a profile
   * change for somebody who is not on this schedule cannot affect this
   * publication, and going stale for it would be a false alarm with a real cost
   * (the scheduler re-reads the review and finds nothing changed).
   *
   * The loader returns EVERY window, not only the in-force one, and that is what
   * belongs in a digest: authoring a future-effective row is a real change to the
   * staffing input, and the person confirming a publication is entitled to know
   * the ground moved even when it has not moved yet. */
  const involved = new Set<string>();
  for (const row of assignments.rows) {
    const membershipId = row['membership_id'];
    if (typeof membershipId === 'string') involved.add(membershipId);
  }
  for (const row of credits.rows) {
    const membershipId = row['credited_membership_id'];
    if (typeof membershipId === 'string') involved.add(membershipId);
  }
  const organizationId = uow.context.organizationId;

  const profileRows: Record<string, unknown>[] = [];
  const holdingRows: Record<string, unknown>[] = [];
  for (const membershipId of [...involved].sort()) {
    const profiles = await loadWorkProfiles(query, { organizationId, membershipId });
    const targets = await loadWeekdayTargets(query, {
      organizationId,
      workProfileIds: profiles.map((profile) => profile.id),
    });

    for (const profile of profiles) {
      profileRows.push({
        membership: profile.membershipId,
        from: profile.effectiveFrom,
        to: profile.effectiveTo,
        percentage: profile.workPercentage,
        perWeek: profile.maxAssignmentsPerWeek,
        perPeriod: profile.maxAssignmentsPerPeriod,
        consecutive: profile.maxConsecutiveDays,
        targets: targets
          .filter((target) => target.workProfileId === profile.id)
          .map(
            (target) =>
              `${target.day}:${String(target.fteFraction)}:${String(target.maxAssignments)}`,
          )
          .sort()
          .join('|'),
      });
    }

    for (const holding of await loadHoldings(query, { organizationId, membershipId })) {
      holdingRows.push({
        membership: holding.membershipId,
        qualification: holding.qualificationId,
        from: holding.effectiveFrom,
        to: holding.effectiveTo,
        status: holding.status,
        version: holding.version,
      });
    }
  }

  /* The qualification DEFINITIONS. `qualifications` is not an effective-dated
   * table and is not the loader's; it carries its own CAS counter. Retiring a
   * qualification or flipping `requires_expiry` changes who is eligible without
   * touching a single holding. */
  const qualificationDefinitions = await sql<Record<string, unknown>>`
    SELECT key, status, requires_expiry, version FROM qualifications
  `.execute(query);

  const demand = await sql<Record<string, unknown>>`
    SELECT 'weekday' AS kind, shift_type_id::text AS subject, day, demand_count AS count, version
      FROM shift_type_weekday_demand
    UNION ALL
    SELECT 'requirement' AS kind, shift_type_id::text AS subject, date::text AS day,
           required_count AS count, requirement_version AS version
      FROM schedule_requirements
     WHERE period_id = ${periodId}
  `.execute(query);

  const timezone = await sql<Record<string, unknown>>`
    SELECT timezone FROM groups
     WHERE id = nullif(current_setting('app.group_id', true), '')::uuid
  `.execute(query);

  return {
    assignments: digestRows(assignments.rows),
    credits: digestRows(credits.rows),
    conflicts: digestRows(conflicts.rows),
    ruleRevisions: digestRows(ruleRevisions.rows),
    catalogueRevisions: digestRows(catalogueRevisions),
    profiles: digestRows(profileRows),
    qualifications: digestRows([...qualificationDefinitions.rows, ...holdingRows]),
    demand: digestRows(demand.rows),
    timezone: digestRows(timezone.rows),
  };
}

/**
 * The composite review identity — the token the compare-and-set compares.
 *
 * One opaque string, the same wire shape FAD-26 shipped. It is built from the
 * per-class digests in a FIXED order and through the same length-prefixed
 * digest, so two different worlds cannot collide by rearranging which class
 * moved.
 */
export function composeMaterialInputDigest(digests: MaterialInputDigests): string {
  return digestRows(
    MATERIAL_INPUT_CLASSES.map((name) => ({ class: name, digest: digests[name] })),
  );
}

/** Read, digest and compose in one call. What the review response carries. */
export async function materialInputDigest(
  uow: Uow,
  periodId: string,
  versionId: string,
): Promise<string> {
  return composeMaterialInputDigest(await materialInputDigests(uow, periodId, versionId));
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. The semantic request identity (doc 34 §4-G, idempotency)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * What a publication idempotency key is a key FOR.
 *
 * D-17 bound idempotency to (period, key), which answers "have I seen this
 * key?" and not "have I seen this key for THIS request?". A client that reused a
 * key for a REVERT after a PUBLISH — or for a publish naming a different
 * expected prior-current version — was told its operation had already succeeded
 * when a different one had.
 */
export interface SemanticPublishRequest {
  readonly operation: 'publish' | 'revert';
  readonly periodId: string;
  readonly versionId: string;
  readonly expectedVersionState: string;
  readonly expectedPriorCurrentVersionId: string | null;
  /** Present only for a revert: the historical version whose content was wanted. */
  readonly revertedToVersionId: string | null;
}

/**
 * The digest a `publication_records` row stores and a replay is checked against.
 *
 * Length-prefixed like every other digest here, so a uuid cannot be made to look
 * like a field boundary.
 */
export function semanticRequestDigest(request: SemanticPublishRequest): string {
  return digestRows([
    {
      operation: request.operation,
      period: request.periodId,
      version: request.versionId,
      expectedState: request.expectedVersionState,
      expectedPriorCurrent: request.expectedPriorCurrentVersionId,
      revertedTo: request.revertedToVersionId,
    },
  ]);
}
