import { z } from 'zod';

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
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date is YYYY-MM-DD');
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

export const ASSIGNMENT_ORIGINS = ['manual', 'solver', 'clone', 'picklist', 'import'] as const;

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
  })
  .strict();
export type GridAssignment = z.infer<typeof gridAssignmentSchema>;

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
    /** The group's IANA zone, so the alternative rendering can name it. */
    timezone: z.string().min(1).max(64),
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
