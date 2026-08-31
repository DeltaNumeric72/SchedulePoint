import { z } from 'zod';

import { calendarDateSchema } from './calendar-date.js';

/**
 * The scheduler-facing authoring surface's wire shapes (OPUS-M3-004; SPEC-05,
 * doc 07, CAP-014/CAP-019/CAP-020).
 *
 * ## Rules this package works under, restated where they bite
 *
 *  - **`.strict()` on every object.** An unknown key is rejected, never carried.
 *    A schedule write that silently accepted an extra field would be a free-text
 *    channel into content that a publication freezes forever (I-18).
 *  - **No response body carries a denial reason** (SPEC-06 P-3). A denial is the
 *    fixed 403/404 envelope; these schemas describe success, field-addressed
 *    validation, and the one refusal that is NOT an authorization signal — the
 *    stale-edit `409` below.
 *  - **The client never computes an instant.** Every mutation names a `date` and
 *    a `shiftTypeId`; the SERVER derives `starts_at`/`ends_at` from the shift
 *    type's times and the group's timezone. A browser that computed them would
 *    write the viewer's zone into the schedule, and two schedulers in two zones
 *    would author two different shifts from the same click.
 *
 * ## The revision token, and why every mutation carries one
 *
 * PO-DEC-18 is server-authoritative: **a stale edit is refused and re-fetched,
 * never silently merged.** Each grid CELL (one date × one shift type within one
 * version) carries a `revision` — a digest of the active assignment content in
 * that cell, computed by the server. A mutation states the revision it believes
 * it is editing; the server recomputes it inside the same transaction, before
 * the mutation, and refuses with `409 STALE_EDIT` when they differ.
 *
 * The token is a digest of CONTENT, deliberately not a timestamp. A `timestamptz`
 * read back through node-postgres is millisecond-truncated, so two edits inside
 * one millisecond would produce the same token and the second would overwrite
 * the first — the exact silent merge this exists to prevent.
 *
 * A cell with no active assignment digests to a single constant, which the grid
 * read carries once as `emptyCellRevision` rather than repeating for every empty
 * cell in a 31-day × N-shift-type period.
 */

const uuid = z.string().uuid();
/**
 * A date on the wire. **A real calendar date**, not merely a `YYYY-MM-DD`-shaped
 * string: `calendarDateSchema` refuses `2027-02-29`, `2027-13-01` and
 * `2027-04-31`, which the regex this alias replaced accepted (OPUS-M4-000B,
 * doc 34 §4-F). The alias is kept so every existing reference reads unchanged.
 */
const isoDate = calendarDateSchema;
const instant = z.string().datetime();

/**
 * A content revision token. Hex sha-256 as produced by the schedule module's
 * `digestRows`, so the shape is fixed and a client cannot invent one that looks
 * plausible.
 */
export const revisionTokenSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'a revision token is a 64-character hex digest');
export type RevisionToken = z.infer<typeof revisionTokenSchema>;

/**
 * A scheduler-authored reason.
 *
 * Administrative text about a rota decision — never clinical, never patient
 * data (I-07). It is required wherever the domain service requires it
 * (removal, reassignment) so the audit trail records that a reason was given;
 * the TEXT itself never enters an audit payload.
 */
const reason = z.string().min(1).max(500);

/* ────────────────────────────────────────────────────────────────────────────
 * Periods (CAP-019/CAP-020 — `schedule.period.administer`)
 * ──────────────────────────────────────────────────────────────────────────── */

export const schedulePeriodViewSchema = z
  .object({
    id: uuid,
    name: z.string().min(1).max(120),
    startDate: isoDate,
    endDate: isoDate,
    /** `schedule_periods.status` — the planning window's own lifecycle. */
    status: z.enum(['planning', 'published', 'closed']),
  })
  .strict();
export type SchedulePeriodView = z.infer<typeof schedulePeriodViewSchema>;

/**
 * The longest planning window this surface accepts, in days.
 *
 * 366 — one year including a leap day. The number is a product bound, not a
 * technical one, and it is chosen because the authoring grid renders one row per
 * date: past a year the surface stops being usable as a grid, and a period long
 * enough to break it is far likelier to be a typo than an intention.
 *
 * It exists because nothing bounded the window before: a 4000-day period was
 * accepted, and BOTH renderings then silently truncated at the internal
 * iteration guard — showing a schedule that was not the schedule, with no
 * indication anything was missing. Silent truncation of a rota is the worst
 * available failure.
 *
 * **The database half is deliberately absent.** A CHECK on `schedule_periods`
 * would need a migration and this packet has none; recorded so the constraint
 * lands with a future migration packet rather than being forgotten.
 */
export const MAX_PERIOD_DAYS = 366;

/** Whole days from `startDate` to `endDate` inclusive. */
function inclusiveDayCount(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.floor((end - start) / 86_400_000) + 1;
}

export const createPeriodRequestSchema = z
  .object({
    name: z.string().min(1).max(120),
    startDate: isoDate,
    endDate: isoDate,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.endDate < value.startDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endDate'],
        message: 'The end date cannot be before the start date.',
      });
      return;
    }
    if (inclusiveDayCount(value.startDate, value.endDate) > MAX_PERIOD_DAYS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endDate'],
        message: `A period covers at most ${String(MAX_PERIOD_DAYS)} days. Split a longer plan into separate periods.`,
      });
    }
  });
export type CreatePeriodRequest = z.infer<typeof createPeriodRequestSchema>;

export const schedulePeriodListSchema = z
  .object({ periods: z.array(schedulePeriodViewSchema), correlationId: z.string().min(1) })
  .strict();
export type SchedulePeriodList = z.infer<typeof schedulePeriodListSchema>;

export const schedulePeriodResultSchema = z
  .object({ period: schedulePeriodViewSchema, correlationId: z.string().min(1) })
  .strict();
export type SchedulePeriodResult = z.infer<typeof schedulePeriodResultSchema>;

/**
 * The explicit, audited period lifecycle transition (OPUS-M4-000C, doc 34 §4-G).
 *
 * A `closed` period refuses new versions, new requirements and any publication
 * — at the database, not only in the service (migration 0015). This request is
 * the ONE way past those refusals, and reopening goes to `planning` rather than
 * straight back to `published`, so the reopen and the republication are two
 * recorded acts rather than one silent one.
 *
 * The legal moves, enforced in the service AND by an independent trigger:
 *
 *     planning  -> published | closed
 *     published -> closed
 *     closed    -> planning
 */
export const periodTransitionRequestSchema = z
  .object({ to: z.enum(['planning', 'published', 'closed']) })
  .strict();
export type PeriodTransitionRequest = z.infer<typeof periodTransitionRequestSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Requirements — period-scoped demand (doc 07 §1: "how much staffing is needed
 * on a date for a shift type"). A PERIOD INSTANCE, deliberately not the
 * catalogue's per-weekday demand default (FAD-16), which is a different concept.
 * ──────────────────────────────────────────────────────────────────────────── */

export const scheduleRequirementViewSchema = z
  .object({
    id: uuid,
    date: isoDate,
    shiftTypeId: uuid,
    requiredCount: z.number().int().nonnegative(),
    revision: revisionTokenSchema,
  })
  .strict();
export type ScheduleRequirementView = z.infer<typeof scheduleRequirementViewSchema>;

export const scheduleRequirementListSchema = z
  .object({
    periodId: uuid,
    requirements: z.array(scheduleRequirementViewSchema),
    /** The revision every (date, shift type) with no requirement row carries. */
    absentRequirementRevision: revisionTokenSchema,
    correlationId: z.string().min(1),
  })
  .strict();
export type ScheduleRequirementList = z.infer<typeof scheduleRequirementListSchema>;

/**
 * Author one requirement.
 *
 * The service upserts on (period, date, shift type), so without a
 * compare-and-set a second author's number would silently replace a first's.
 * `expectedRevision` is REQUIRED for the same reason the publication's
 * compare-and-set is (FAD-22(2)): an omitted CAS is indistinguishable from a
 * caller that never considered concurrency.
 */
export const setRequirementRequestSchema = z
  .object({
    date: isoDate,
    shiftTypeId: uuid,
    requiredCount: z.number().int().nonnegative().max(999),
    expectedRevision: revisionTokenSchema,
  })
  .strict();
export type SetRequirementRequest = z.infer<typeof setRequirementRequestSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * The whole-set requirements replacement (OPUS-M4-000A; doc 34 §4-A)
 *
 * The per-cell PUT above is SUPERSEDED on the wire by the aggregate form
 * below; the schemas are retained (additive contract discipline) but the
 * route now speaks the aggregate. Rationale, and the canonical omitted-entry
 * rule, stated once here and mirrored on the page:
 *
 *   **Saving produces exactly the presented set. An entry omitted from the
 *   request is DELETED.** No merge, no union: the requirement set after a
 *   successful save is the request's set, byte for byte.
 *
 * A `requiredCount` of zero is a REAL entry and is stored: an explicit zero
 * on a date is a statement (it overrides whatever a weekday default would
 * have implied), which is precisely why the period editor does NOT normalise
 * zero to absent while the catalogue's weekday grid does — the catalogue read
 * defines an absent day AS zero, and this one does not.
 *
 * `expectedVersion` is the AGGREGATE set version (`staffing_set_versions`,
 * scope `period_requirements`; an aggregate never written presents 1). A
 * stale value is refused with an explicit `409` carrying the current version;
 * nothing is merged. Two concurrent replacements can therefore never combine
 * into a union — the loser is told, re-reads, and decides again.
 * ──────────────────────────────────────────────────────────────────────────── */

export const requirementEntrySchema = z
  .object({
    date: isoDate,
    shiftTypeId: uuid,
    requiredCount: z.number().int().nonnegative().max(999),
  })
  .strict();
export type RequirementEntry = z.infer<typeof requirementEntrySchema>;

/**
 * The whole set, one request (I-10). The ceiling is deliberate: a period is at
 * most 366 days (contract + `schedule_periods_length`), and 4000 entries is
 * more date×shift-type cells than any observed group authors while still being
 * a bounded statement.
 */
export const replaceRequirementsRequestSchema = z
  .object({
    requirements: z.array(requirementEntrySchema).max(4000),
    expectedVersion: z.number().int().min(1),
  })
  .strict();
export type ReplaceRequirementsRequest = z.infer<typeof replaceRequirementsRequestSchema>;

export const scheduleRequirementSetViewSchema = z
  .object({
    id: uuid,
    date: isoDate,
    shiftTypeId: uuid,
    requiredCount: z.number().int().nonnegative(),
  })
  .strict();
export type ScheduleRequirementSetView = z.infer<typeof scheduleRequirementSetViewSchema>;

export const scheduleRequirementSetSchema = z
  .object({
    periodId: uuid,
    requirements: z.array(scheduleRequirementSetViewSchema),
    /** The aggregate set version AFTER this read/save — what the next save presents. */
    version: z.number().int().min(1),
    correlationId: z.string().min(1),
  })
  .strict();
export type ScheduleRequirementSet = z.infer<typeof scheduleRequirementSetSchema>;

/**
 * The stale-aggregate refusal body. `currentVersion` is disclosed because the
 * caller has already proven they may edit this set — it is the refetch hint
 * PO-DEC-18's explicit-refusal flow requires, never an authorization signal.
 */
export const staleSetVersionBodySchema = z
  .object({
    error: z
      .object({
        code: z.literal('STALE_SET_VERSION'),
        message: z.string().min(1),
        currentVersion: z.number().int().min(1),
        correlationId: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type StaleSetVersionBody = z.infer<typeof staleSetVersionBodySchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Versions (CAP-014 — `schedule.version.edit`)
 * ──────────────────────────────────────────────────────────────────────────── */

export const SCHEDULE_VERSION_STATES = [
  'draft',
  'in_review',
  'approved',
  'publishing',
  'published',
  'superseded',
  'cancelled',
] as const;

export const scheduleVersionViewSchema = z
  .object({
    id: uuid,
    periodId: uuid,
    versionNumber: z.number().int().positive().nullable(),
    state: z.enum(SCHEDULE_VERSION_STATES),
    lockState: z.enum(['unlocked', 'locked']),
    isCurrent: z.boolean(),
    clonedFromVersionId: uuid.nullable(),
    /** True only for `draft` + `unlocked`: the one state content may be edited in. */
    isEditable: z.boolean(),
  })
  .strict();
export type ScheduleVersionView = z.infer<typeof scheduleVersionViewSchema>;

export const scheduleVersionListSchema = z
  .object({
    periodId: uuid,
    versions: z.array(scheduleVersionViewSchema),
    correlationId: z.string().min(1),
  })
  .strict();
export type ScheduleVersionList = z.infer<typeof scheduleVersionListSchema>;

export const scheduleVersionResultSchema = z
  .object({ version: scheduleVersionViewSchema, correlationId: z.string().min(1) })
  .strict();
export type ScheduleVersionResult = z.infer<typeof scheduleVersionResultSchema>;

/** Creating a draft takes no body: the period is in the path. */
export const createVersionRequestSchema = z.object({}).strict();

/** Cloning names the source explicitly rather than inferring "the latest". */
export const cloneVersionRequestSchema = z.object({ sourceVersionId: uuid }).strict();
export type CloneVersionRequest = z.infer<typeof cloneVersionRequestSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * The grid
 * ──────────────────────────────────────────────────────────────────────────── */

export const ASSIGNMENT_ORIGINS = [
  'manual',
  'solver',
  'clone',
  'picklist',
  'import',
  /* OPUS-M5-004: SPEC-08 §5.6's commit places OFF assignment snapshots, and
   * migration 0009's four mechanisms did not name it. A snapshot's origin is
   * frozen the moment its version publishes (I-18), so the value lands with the
   * writer that creates the rows rather than after some of them are unfixable. */
  'vacation_commit',
] as const;

/**
 * One assignment as the grid renders it.
 *
 * `overrideReasonGiven` is a BOOLEAN and the reason text is not on the wire.
 * The grid needs to show that a human overrode something; it does not need to
 * broadcast what they typed to every reader of the schedule.
 */
export const gridAssignmentSchema = z
  .object({
    assignmentIdentityId: uuid,
    snapshotId: uuid,
    membershipId: uuid,
    startsAt: instant,
    endsAt: instant,
    status: z.enum(['active', 'cancelled']),
    /** Provenance (doc 07): where this assignment came from. */
    origin: z.enum(ASSIGNMENT_ORIGINS),
    isPinned: z.boolean(),
    overrideReasonGiven: z.boolean(),
    pickPosition: z.number().int().nonnegative().nullable(),
    /** The credit, which is a separate concept from the assignment (doc 07). */
    creditId: uuid.nullable(),
    creditedMembershipId: uuid.nullable(),
    creditStatus: z.enum(['active', 'reassigned', 'voided']).nullable(),
    /**
     * The LOCATION of the shift this assignment hangs on (OPUS-M4-000B; doc 34
     * §4-F). `null` is a stated allowed state — a single-site group schedules
     * without locations — and is deliberately not the same as "not shown".
     *
     * REQUIRED rather than optional even though a consumer already exists. An
     * optional field would make "this shift has no location" and "this server
     * does not report locations" the same value on the wire, and the grid has to
     * distinguish them to decide whether to render a location column at all. The
     * one consumer (`apps/web/src/schedule`) is updated in the same change, and
     * `.strict()` means a stale client would have failed on the new key anyway.
     *
     * The name travels with the id so the grid can label a cell without a second
     * request (I-10), and `locationArchived` travels so an archived location's
     * EXISTING shifts can be rendered with the archived marker. Archiving refuses
     * NEW references and retains old ones (migration 0014), so a published
     * schedule can legitimately point at an archived place and the reader has to
     * be told which.
     */
    locationId: uuid.nullable(),
    locationName: z.string().min(1).max(120).nullable(),
    locationArchived: z.boolean(),
  })
  .strict();
export type GridAssignment = z.infer<typeof gridAssignmentSchema>;

/**
 * A location the authoring surface can assign a shift to.
 *
 * `timezone` is present and is **display metadata only**: the GROUP's timezone
 * governs every schedule semantic (OPUS-M4-000B's ruling; doc 06 §Time,
 * "shift-local semantics resolve against the group timezone"). It is here so a
 * scheduler working across sites can see what the clock on that wall reads —
 * nothing computes from it, and the grid's own `timezone` field is the one that
 * every instant on this payload was derived under.
 *
 * `archived` locations are listed because existing shifts still reference them
 * and the grid has to label those; a client offers only `archived === false`
 * ones as targets for a NEW assignment, and the database refuses the rest
 * regardless (`SCHEDULE_SHIFT_LOCATION_ARCHIVED`).
 */
export const gridLocationSchema = z
  .object({
    id: uuid,
    name: z.string().min(1).max(120),
    /** The PO-DEC-01 free-form attribute. Not an id, referencing nothing. */
    siteLabel: z.string().max(120).nullable(),
    /** DISPLAY METADATA. The group timezone governs — see above. */
    timezone: z.string().max(64).nullable(),
    archived: z.boolean(),
  })
  .strict();
export type GridLocation = z.infer<typeof gridLocationSchema>;

export const gridCellSchema = z
  .object({
    date: isoDate,
    shiftTypeId: uuid,
    requiredCount: z.number().int().nonnegative(),
    assignments: z.array(gridAssignmentSchema),
    revision: revisionTokenSchema,
  })
  .strict();
export type GridCell = z.infer<typeof gridCellSchema>;

export const gridShiftTypeSchema = z
  .object({
    id: uuid,
    code: z.string().min(1).max(24),
    name: z.string().min(1).max(120),
    startTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    endTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    crossesMidnight: z.boolean(),
  })
  .strict();
export type GridShiftType = z.infer<typeof gridShiftTypeSchema>;

/**
 * A member of the group, as the cell editor offers them.
 *
 * `displayName` comes from `users.display_name`, which migration 0001 makes
 * readable to any context in the same organization through membership — an
 * existing, deliberate disclosure boundary, not one this packet opens. No email,
 * no credential, and nothing patient-related (I-07).
 */
export const rosterMemberSchema = z
  .object({
    membershipId: uuid,
    displayName: z.string().min(1).max(200),
    staffingKind: z.enum(['staff', 'locum']),
    status: z.enum(['invited', 'active', 'suspended', 'ended']),
  })
  .strict();
export type RosterMember = z.infer<typeof rosterMemberSchema>;

export const scheduleConflictViewSchema = z
  .object({
    id: uuid,
    severity: z.enum(['hard-breach', 'soft', 'info']),
    state: z.enum(['open', 'accepted', 'resolved']),
    explanation: z.string().max(1000).nullable(),
  })
  .strict();
export type ScheduleConflictView = z.infer<typeof scheduleConflictViewSchema>;

export const scheduleConflictListSchema = z
  .object({
    versionId: uuid,
    conflicts: z.array(scheduleConflictViewSchema),
    correlationId: z.string().min(1),
  })
  .strict();
export type ScheduleConflictList = z.infer<typeof scheduleConflictListSchema>;

/**
 * The whole authoring grid for one version.
 *
 * `cells` carries only the cells that hold a requirement or an assignment; every
 * other (date × shift type) pair is empty and carries `emptyCellRevision`. A
 * 31-day period over 20 shift types is 620 cells, and shipping 600 identical
 * empty objects would make the payload measure the calendar rather than the
 * content.
 */
export const scheduleGridSchema = z
  .object({
    version: scheduleVersionViewSchema,
    period: schedulePeriodViewSchema,
    /** Every date in the period, ascending. The grid's column (or row) axis. */
    dates: z.array(isoDate),
    shiftTypes: z.array(gridShiftTypeSchema),
    cells: z.array(gridCellSchema),
    emptyCellRevision: revisionTokenSchema,
    conflicts: z.array(scheduleConflictViewSchema),
    roster: z.array(rosterMemberSchema),
    /**
     * The locations this group can schedule at (OPUS-M4-000B). Archived ones are
     * included so existing references can be labelled; only `archived === false`
     * is offered as a NEW target.
     */
    locations: z.array(gridLocationSchema),
    /**
     * The IANA zone every instant on this payload was derived under.
     *
     * For a DRAFT this is the group's current zone. For a PUBLISHED version it
     * is the zone the version was published with (`schedule_versions.
     * timezone_basis`), because a published version is immutable (I-18) and its
     * rendering may not move when an administrator changes a setting.
     */
    timezone: z.string().min(1).max(64),
    /**
     * Where `timezone` came from (OPUS-M4-000B; doc 34 §4-F).
     *
     * `version-snapshot` — the version records its own basis, and this rendering
     *                      is reproducible from it;
     * `group-current`    — the version predates migration 0014 and records no
     *                      basis, so the group's CURRENT zone was used. A
     *                      fallback that is VISIBLE in the payload rather than
     *                      disguised as a snapshot.
     */
    timezoneSource: z.enum(['version-snapshot', 'group-current']),
    /**
     * The tz DATABASE rule set the instants were derived under, e.g. `2026b`, or
     * `unknown` when the runtime does not expose one. Recorded so a divergence is
     * DETECTABLE; it does not make an old interpretation reproducible, and
     * nothing here claims it does.
     */
    tzdbVersion: z.string().min(1).max(32),
    /**
     * `true` when this version was authored against a zone the group has since
     * left. Publication is refused (`TIMEZONE_BASIS_STALE`) until it is
     * re-derived — the explicit staleness surfacing doc 34 §4-F requires, rather
     * than a silently hour-shifted rota.
     */
    timezoneStale: z.boolean(),
    correlationId: z.string().min(1),
  })
  .strict();
export type ScheduleGrid = z.infer<typeof scheduleGridSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Cell mutations. Every one is draft-only and carries a compare-and-set.
 * ──────────────────────────────────────────────────────────────────────────── */

export const addAssignmentRequestSchema = z
  .object({
    date: isoDate,
    shiftTypeId: uuid,
    membershipId: uuid,
    /**
     * Where the shift happens (OPUS-M4-000B; doc 34 §4-F).
     *
     * Optional on the wire and defaulting to `null`, which is the un-located
     * shift every existing caller authors — a stated allowed state, not a
     * missing value. A location in another group is refused by the composite FK
     * (migration 0014), and an ARCHIVED location is refused as a NEW reference
     * while existing references are retained.
     */
    locationId: uuid.nullable().optional(),
    isPinned: z.boolean().optional(),
    /** Required when this assignment is a manual OVERRIDE. */
    overrideReason: reason.optional(),
    expectedCellRevision: revisionTokenSchema,
  })
  .strict();
export type AddAssignmentRequest = z.infer<typeof addAssignmentRequestSchema>;

export const removeAssignmentRequestSchema = z
  .object({ reason, expectedCellRevision: revisionTokenSchema })
  .strict();
export type RemoveAssignmentRequest = z.infer<typeof removeAssignmentRequestSchema>;

export const reassignAssignmentRequestSchema = z
  .object({ toMembershipId: uuid, reason, expectedCellRevision: revisionTokenSchema })
  .strict();
export type ReassignAssignmentRequest = z.infer<typeof reassignAssignmentRequestSchema>;

export const setPinRequestSchema = z
  .object({ isPinned: z.boolean(), expectedCellRevision: revisionTokenSchema })
  .strict();
export type SetPinRequest = z.infer<typeof setPinRequestSchema>;

/**
 * Move a credit. **Draft-only** (FAD-22(1)): a credit written against a
 * published version is frozen by D-15a and can never be corrected, so a
 * post-publication correction is expressed on a draft of the next version.
 */
export const moveCreditRequestSchema = z
  .object({
    creditedMembershipId: uuid,
    weight: z.number().positive().max(1000).optional(),
    reason: reason.optional(),
    expectedCellRevision: revisionTokenSchema,
  })
  .strict();
export type MoveCreditRequest = z.infer<typeof moveCreditRequestSchema>;

export const voidCreditRequestSchema = z
  .object({ expectedCellRevision: revisionTokenSchema })
  .strict();
export type VoidCreditRequest = z.infer<typeof voidCreditRequestSchema>;

/** What a mutation returns: the cell as the server now sees it. */
export const cellResultSchema = z
  .object({ cell: gridCellSchema, correlationId: z.string().min(1) })
  .strict();
export type CellResult = z.infer<typeof cellResultSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * The stale-edit refusal
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * `409 STALE_EDIT`.
 *
 * Distinct from the fixed conflict envelope because it carries `currentRevision`
 * — the client needs to know that what it holds is out of date, and the refetch
 * flow is explicit rather than a silent retry (SP-E §1.4). It carries no
 * content: the client re-reads, it does not merge.
 *
 * This is NOT an authorization signal, so carrying detail here does not weaken
 * P-3: the caller was authorized and the world changed.
 */
export const staleEditBodySchema = z
  .object({
    error: z
      .object({
        code: z.literal('STALE_EDIT'),
        message: z.string().min(1).max(300),
        correlationId: z.string().min(1),
        currentRevision: revisionTokenSchema,
      })
      .strict(),
  })
  .strict();
export type StaleEditBody = z.infer<typeof staleEditBodySchema>;

/**
 * `409 TIMEZONE_BASIS_STALE` (OPUS-M4-000B; doc 34 §4-F).
 *
 * The same CLASS of refusal as `STALE_EDIT` and deliberately a different code:
 * a stale cell edit is fixed by re-reading the cell, and this one is not — the
 * version's stored instants were derived under a zone the group has left, so
 * the remedy is to re-derive the draft or restore the zone. Telling a client
 * "stale, re-read" when re-reading changes nothing is how a client ends up in a
 * retry loop against a condition only a human can clear.
 *
 * It carries both zones because the administrator who changed the setting and
 * the scheduler who meets the refusal are usually different people, and "it was
 * X, it is now Y" is the whole diagnosis. Neither is an authorization signal, so
 * P-3 is untouched.
 */
export const timezoneBasisStaleBodySchema = z
  .object({
    error: z
      .object({
        code: z.literal('TIMEZONE_BASIS_STALE'),
        message: z.string().min(1).max(400),
        correlationId: z.string().min(1),
        recordedTimezone: z.string().min(1).max(64),
        currentTimezone: z.string().min(1).max(64),
      })
      .strict(),
  })
  .strict();
export type TimezoneBasisStaleBody = z.infer<typeof timezoneBasisStaleBodySchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Eligibility — the absent-vs-empty ruling's wire shape
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * One candidate for a cell.
 *
 * `eligible` is **nullable, and `null` does not mean "no"**. It means the
 * eligibility read was not available to this caller — they hold
 * `schedule.version.edit` but not `staffing.qualification_holding.read`
 * (CAP-058), so the credential-derived answer is ABSENT rather than empty.
 *
 * Rendering absent as ineligible would state "this person is not qualified"
 * when the truth is "you cannot see whether they are", which is a lie about a
 * patient-safety-adjacent fact. The catalogue service says the same thing from
 * the other side: its answer "is a report about what the caller can see, not a
 * verdict about the member".
 */
export const candidateSchema = z
  .object({
    membershipId: uuid,
    displayName: z.string().min(1).max(200),
    staffingKind: z.enum(['staff', 'locum']),
    /** `null` = eligibility unknown to this caller. Never rendered as "no". */
    eligible: z.boolean().nullable(),
    missingQualificationIds: z.array(uuid),
    /** True when this membership already holds an active assignment in the cell. */
    alreadyAssigned: z.boolean(),
  })
  .strict();
export type Candidate = z.infer<typeof candidateSchema>;

export const candidateListSchema = z
  .object({
    date: isoDate,
    shiftTypeId: uuid,
    /**
     * Whether eligibility could be computed at all for this caller. `false` is
     * the ABSENT arm: every `candidate.eligible` is `null`.
     */
    eligibilityKnown: z.boolean(),
    candidates: z.array(candidateSchema),
    correlationId: z.string().min(1),
  })
  .strict();
export type CandidateList = z.infer<typeof candidateListSchema>;
