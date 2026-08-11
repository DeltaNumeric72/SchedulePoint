import { z } from 'zod';

import { calendarDateSchema } from './calendar-date.js';

import { publicationIdempotencyKeySchema } from './publication.js';
import {
  gridShiftTypeSchema,
  revisionTokenSchema,
  schedulePeriodViewSchema,
  scheduleVersionViewSchema,
} from './authoring.js';

/**
 * The publication and version-management surface's wire shapes (OPUS-M3-005;
 * SPEC-05 §6/§6.1, doc 07 §2–§4, CAP-014).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## What this module is about, in one sentence
 *
 * Everything here describes **reading history and making one irreversible
 * decision**. A published version is immutable (I-18, non-bypass rule 5), so the
 * only write these shapes describe is the publication itself — and every read
 * they describe is of something that can never change again.
 *
 * ## Three rules the package works under, restated where they bite
 *
 *  - **`.strict()` on every object.** An unknown key is rejected, never carried.
 *  - **No response body carries a denial reason** (SPEC-06 P-3). The two `409`
 *    bodies below carry detail because neither is an authorization signal: the
 *    caller was authorized and the world moved underneath them.
 *  - **The client never computes an instant or a version number.** Both come
 *    from the server, inside the publishing transaction.
 *
 * ## Why the CAS token is REQUIRED here too
 *
 * `publishVersion` already requires `expectedPriorCurrentVersionId` (FAD-22(2)),
 * and this surface does not soften it: the field is required and nullable, and
 * `null` means "I believe nothing is current in this period yet". An omitted
 * compare-and-set is indistinguishable from a caller that never considered
 * concurrency, and the loser of a publication race must fail explicitly rather
 * than silently supersede a version it never saw.
 *
 * ## Why there is a SECOND compare-and-set, over the review itself
 *
 * The prior-current CAS answers "did another publication win this period?". It
 * does **not** answer "did the draft I reviewed change while I was reading it?"
 * — a co-author can add or remove an assignment between the review read and the
 * confirmation, and the publication would then commit content the confirming
 * human never saw. That is the same class of defect the grid's cell revision
 * exists for, one level up, so it takes the same shape: the review response
 * carries `reviewDigest`, the publication echoes it as `expectedReviewDigest`,
 * and a mismatch is `409 STALE_REVIEW` with the current digest and an explicit
 * re-read. Nothing is merged and nothing is retried automatically.
 *
 * The alternative — a confirmation dialog that confirms whatever the server
 * happens to hold at commit time — is a confirmation that confirms nothing, and
 * this repository has twice found a control that looked like a compare-and-set
 * and was decorative (OPUS-M3-004 B-1, OPUS-M3-007's settings counter).
 * ─────────────────────────────────────────────────────────────────────────────
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
const displayName = z.string().min(1).max(200);

/* ────────────────────────────────────────────────────────────────────────────
 * The difference between two versions
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The four kinds `apps/api/src/schedule/diff.ts` produces. Asserted equal to the
 * module's own union by `apps/api/test/schedule/publication-diff-parity.test.ts`
 * — a fifth kind added there and not here would be a silent wire truncation.
 */
export const ASSIGNMENT_CHANGE_KINDS = ['added', 'removed', 'reassigned', 'retimed'] as const;
export type AssignmentChangeKindWire = (typeof ASSIGNMENT_CHANGE_KINDS)[number];

/**
 * **Exactly** what the pure diff decides, and nothing else.
 *
 * Split out from the view below so the packet's equality requirement — "the diff
 * display equals the pure-function diff" — is a comparison of two values of the
 * same type rather than a hand-written field-by-field check that could quietly
 * stop covering a field somebody added.
 */
export const assignmentChangeCoreSchema = z
  .object({
    assignmentIdentityId: uuid,
    kind: z.enum(ASSIGNMENT_CHANGE_KINDS),
    fromMembershipId: uuid.nullable(),
    toMembershipId: uuid.nullable(),
  })
  .strict();
export type AssignmentChangeCore = z.infer<typeof assignmentChangeCoreSchema>;

/**
 * One change, as a human reads it.
 *
 * The decoration (`date`, the shift type, the two display names, the instants)
 * is looked up per identity **after** the pure function has decided; it never
 * participates in deciding. `assignmentChangeCoreOf` below is the projection the
 * equality proof compares.
 */
export const assignmentChangeViewSchema = assignmentChangeCoreSchema.extend({
  /** The calendar date of the assignment on whichever side exists. */
  date: isoDate,
  shiftTypeId: uuid,
  shiftTypeCode: z.string().min(1).max(24),
  startsAt: instant,
  endsAt: instant,
  /** `null` when the membership is not visible to this reader, or absent. */
  fromDisplayName: displayName.nullable(),
  toDisplayName: displayName.nullable(),
});
export type AssignmentChangeView = z.infer<typeof assignmentChangeViewSchema>;

/** The projection the diff-equality proof compares. Pure, total, no defaults. */
export function assignmentChangeCoreOf(view: AssignmentChangeView): AssignmentChangeCore {
  return {
    assignmentIdentityId: view.assignmentIdentityId,
    kind: view.kind,
    fromMembershipId: view.fromMembershipId,
    toMembershipId: view.toMembershipId,
  };
}

/**
 * One affected person.
 *
 * A reassignment affects BOTH people — the one who lost the shift and the one
 * who gained it — which is why `affectedMembershipIds` is a union rather than
 * the after-side. Notifying only the gainer is the defect that union prevents,
 * and this list is the display of the same set.
 */
export const affectedMemberSchema = z
  .object({
    membershipId: uuid,
    displayName: displayName.nullable(),
    /** How many changes of each kind touch this person. Zero is omitted-as-zero, never absent. */
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    reassignedAway: z.number().int().nonnegative(),
    reassignedTo: z.number().int().nonnegative(),
    retimed: z.number().int().nonnegative(),
  })
  .strict();
export type AffectedMember = z.infer<typeof affectedMemberSchema>;

export const versionDifferenceSchema = z
  .object({
    changes: z.array(assignmentChangeViewSchema),
    /** Sorted, deterministic, and the union of both sides of every change. */
    affectedMembershipIds: z.array(uuid),
    affectedMembers: z.array(affectedMemberSchema),
  })
  .strict();
export type VersionDifferenceWire = z.infer<typeof versionDifferenceSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * What blocks a publication, and what merely deserves attention
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The blocking codes.
 *
 * **Each one predicts a refusal the publication transaction actually performs**,
 * and that is the discipline this list is written under: a blocking item the
 * server would not enforce is a fabricated gate, and an enforced refusal absent
 * from this list is a confirmation dialog that lies about what will happen.
 *
 * | Code | The server-side refusal it predicts |
 * |---|---|
 * | `OPEN_HARD_BREACH` | `assertNoOpenHardBreach`, publication step 05 |
 * | `VERSION_NOT_APPROVED` | step 03's `VERSION_STATE_UNEXPECTED` |
 * | `VERSION_ALREADY_PUBLISHED` | the same step, for a version that is already history |
 * | `VERSION_PERIOD_MISMATCH` | step 03's period check |
 *
 * **Rule execution against the draft arrived with OPUS-M3-008.** SPEC-05 §6 step
 * 06 evaluates the group's active compiled HARD rules against the version's
 * content inside the publication transaction, and this branch now predicts that
 * refusal too:
 *
 * | Code | The server-side refusal it predicts |
 * |---|---|
 * | `HARD_RULE_BREACH` | step 06: the content breaches an active HARD rule |
 * | `HARD_RULE_NOT_EVALUABLE` | step 06: an active HARD rule this system cannot yet decide |
 *
 * The second is not a euphemism for "ignored". SPEC-04 §3.3 forbids skipping a
 * HARD rule by any code path, so a rule whose semantics SPEC-04 §3.1 does not
 * pin blocks publication and names itself — the honest alternative to passing it
 * over. The remaining kinds are M4's.
 */
export const PUBLICATION_BLOCKER_CODES = [
  'OPEN_HARD_BREACH',
  'VERSION_NOT_APPROVED',
  'VERSION_ALREADY_PUBLISHED',
  'VERSION_PERIOD_MISMATCH',
  'HARD_RULE_BREACH',
  'HARD_RULE_NOT_EVALUABLE',
] as const;
export type PublicationBlockerCode = (typeof PUBLICATION_BLOCKER_CODES)[number];

export const publicationBlockerSchema = z
  .object({
    code: z.enum(PUBLICATION_BLOCKER_CODES),
    /** Plain prose for a scheduler. Never a denial reason (P-3); this is state, not authority. */
    message: z.string().min(1).max(300),
    /** The conflict row this blocker came from, when it came from one. */
    conflictId: uuid.nullable(),
    /**
     * The STABLE `rule_key` (non-bypass rule 13) this blocker came from, when it
     * came from a rule — the two `HARD_RULE_*` codes. `null` otherwise.
     *
     * Named rather than folded into `message` because a scheduler's next action
     * is to open that rule, and a key buried in prose is a key a client cannot
     * link to.
     */
    ruleKey: z.string().max(64).nullable(),
  })
  .strict();
export type PublicationBlocker = z.infer<typeof publicationBlockerSchema>;

/**
 * Something worth reading before publishing, which does **not** block.
 *
 * Unmet demand is the important one and it is deliberately a warning: nothing in
 * SPEC-05, doc 07 or the publication transaction refuses a publication for a
 * short-staffed date, and inventing that refusal here would be a business rule
 * this packet has no authority to make. A rota is frequently published knowingly
 * short; the surface says so and lets the human decide.
 */
export const PUBLICATION_WARNING_CODES = [
  'UNMET_REQUIREMENT',
  'NO_ACTIVE_ASSIGNMENTS',
  'OPEN_SOFT_CONFLICT',
] as const;
export type PublicationWarningCode = (typeof PUBLICATION_WARNING_CODES)[number];

export const publicationWarningSchema = z
  .object({
    code: z.enum(PUBLICATION_WARNING_CODES),
    message: z.string().min(1).max(300),
    count: z.number().int().nonnegative(),
  })
  .strict();
export type PublicationWarning = z.infer<typeof publicationWarningSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Graduated confirmation friction (SP-E §3)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * How much friction this particular publication earns.
 *
 * > SP-E §3: "**Destructive actions:** typed-confirmation only for irreversible
 * > ones; everything else undoes by compensating action (publication supersedes
 * > forward, I-18 — the UI never offers 'edit published')."
 *
 * Publication is always irreversible in the sense that matters — a published
 * version can never be edited or deleted, only superseded — so the floor is an
 * explicit acknowledgement and there is no frictionless arm. What graduates is
 * whether somebody else's already-live schedule is about to change under them:
 *
 * | Situation | Tier |
 * |---|---|
 * | first publication of a period, nobody affected | `acknowledge` |
 * | supersedes a live version, or any affected staff, or a revert | `type-to-confirm` |
 *
 * **The tier is computed by this shared function, not by the client.** The
 * server re-computes it inside the publishing transaction from its own reading
 * of the world and enforces whatever it computes. A client that skipped the
 * typed phrase would be refused; a client that asked for MORE friction than the
 * server requires is harmless. Neither can lower it.
 */
export type PublicationFrictionTier = 'acknowledge' | 'type-to-confirm';

export interface PublicationFrictionInput {
  /** True when a currently-published version will be superseded by this act. */
  readonly supersedesCurrentVersion: boolean;
  readonly affectedMembershipCount: number;
  /** A revert always types, because it un-does something people are working to. */
  readonly isRevert: boolean;
}

export function publicationFrictionTier(input: PublicationFrictionInput): PublicationFrictionTier {
  if (input.isRevert) return 'type-to-confirm';
  if (input.supersedesCurrentVersion) return 'type-to-confirm';
  return input.affectedMembershipCount > 0 ? 'type-to-confirm' : 'acknowledge';
}

/**
 * The phrase a `type-to-confirm` tier demands.
 *
 * The **period name** rather than a fixed word like "PUBLISH": a fixed word is
 * muscle memory within a week and stops being a check at all, while the period
 * name cannot be typed without having read which planning window is about to go
 * live — which is the mistake this friction exists to catch (publishing the
 * wrong period's draft).
 *
 * A revert prefixes `revert `, so the phrase for reverting is never one the
 * user could have typed for an ordinary publication.
 */
export function publicationConfirmationPhrase(input: {
  readonly periodName: string;
  readonly isRevert: boolean;
}): string {
  return input.isRevert ? `revert ${input.periodName}` : input.periodName;
}

/**
 * Whether a typed phrase satisfies the required one.
 *
 * Case-folded and whitespace-collapsed, deliberately. Case sensitivity on a
 * human-authored period name adds no safety — nobody publishes the wrong period
 * because they typed it in the wrong case — and it produces a refusal the user
 * cannot see the cause of, which trains people to paste rather than read.
 *
 * Shared by the client (to enable the button) and the server (to enforce it), so
 * the two can never disagree about what counts as confirmed.
 */
export function publicationPhraseMatches(typed: string, required: string): boolean {
  const normalise = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase();
  return normalise(typed).length > 0 && normalise(typed) === normalise(required);
}

/* ────────────────────────────────────────────────────────────────────────────
 * The review
 * ──────────────────────────────────────────────────────────────────────────── */

export const publicationReviewSchema = z
  .object({
    version: scheduleVersionViewSchema,
    period: schedulePeriodViewSchema,
    /** The version this publication would supersede. `null` on a first publication. */
    currentVersion: scheduleVersionViewSchema.nullable(),
    /**
     * The compare-and-set token the confirmation must echo (FAD-22(2)). It is
     * `currentVersion?.id ?? null` and is carried explicitly so the client
     * cannot derive it wrongly from a partially-rendered view.
     */
    expectedPriorCurrentVersionId: uuid.nullable(),
    /** The second compare-and-set: a digest of the difference below. */
    reviewDigest: revisionTokenSchema,
    difference: versionDifferenceSchema,
    blockers: z.array(publicationBlockerSchema),
    warnings: z.array(publicationWarningSchema),
    /**
     * Whether THIS caller holds `schedule.publish` in this group.
     *
     * Evaluated separately, through the same evaluator, inside the same
     * transaction — the same shape as the authoring surface's eligibility
     * visibility. It exists so the interface can render an honest deny state
     * (SP-E §1.3: "what a user cannot do is absent or disabled-with-reason"),
     * and it is **not** the authority: the server denies the publication itself
     * regardless of what a client did with this flag.
     */
    canPublish: z.boolean(),
    /** Whether this caller holds `schedule.revert`. Same status as `canPublish`. */
    canRevert: z.boolean(),
    /** What the server will demand at confirmation time. */
    frictionTier: z.enum(['acknowledge', 'type-to-confirm']),
    confirmationPhrase: z.string().min(1).max(200),
    /** The group's IANA zone, so times are named rather than implied. */
    timezone: z.string().min(1).max(64),
    correlationId: z.string().min(1),
  })
  .strict();
export type PublicationReview = z.infer<typeof publicationReviewSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Sign-off — the state a version must reach before it can be published
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Move a version along SPEC-05 §3.1's lifecycle, short of publication.
 *
 * ## Why this lives on the PUBLICATION surface and not the authoring one
 *
 * `draft → in_review → approved` is sign-off: the act of declaring a draft
 * finished and fit to go out. Doc 07 §2.1 and the frozen service treat it as
 * part of the publication flow rather than of authoring — `transitionVersion`
 * calls `assertNoOpenHardBreach` on the move to `approved`, which is the same
 * prerequisite the publication transaction re-checks at commit, and the reason
 * it is checked twice is that "the world can change between approval and
 * publication".
 *
 * ## This is a DISCLOSED ADDITION to packet 32 §10d
 *
 * §10d enumerates review, publish, revert, history, comparison, affected-staff
 * and audit display. It does not name sign-off — and OPUS-M3-004 did not ship a
 * transition route either, so **before this existed there was no HTTP path by
 * which any version could reach `approved`**, and the publication surface was
 * unreachable end to end from a browser however correct it was. It is one route
 * over one existing frozen service function under an existing action key, and it
 * is called out in the return report so it can be removed or reassigned in a
 * single hunk if Fable would rather it belonged to M3-008.
 *
 * `publishing`, `published` and `superseded` are deliberately absent from this
 * enum: those transitions belong to the publication transaction and to the
 * reconciler, and the frozen service's `LEGAL_TRANSITIONS` refuses them from
 * this surface independently of what the wire allows.
 */
export const versionSignOffRequestSchema = z
  .object({ to: z.enum(['in_review', 'approved', 'draft', 'cancelled']) })
  .strict();
export type VersionSignOffRequest = z.infer<typeof versionSignOffRequestSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * The publication itself
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Confirm a publication.
 *
 * `idempotencyKey` is **generated and retained by the client** for one
 * publication attempt and every retry of it. That is the whole mechanism: a
 * double-click, a retried request after a dropped connection, or a user pressing
 * the button again because nothing appeared to happen all carry the SAME key, so
 * D-17's unique constraint turns the second one into a replay that emits no
 * second outbox event, no second audit row and no second supersession. A client
 * that minted a fresh key per attempt would publish twice, and the second
 * publication would supersede the first — which is why the retention is
 * red-cased at the UI level rather than only asserted.
 */
export const publishRequestSchema = z
  .object({
    idempotencyKey: publicationIdempotencyKeySchema,
    /** REQUIRED and nullable (FAD-22(2)). `null` = "nothing is current yet". */
    expectedPriorCurrentVersionId: uuid.nullable(),
    /** The digest of the difference the human actually read. */
    expectedReviewDigest: revisionTokenSchema,
    /** The floor: an explicit, deliberate act. Never defaulted true. */
    acknowledged: z.literal(true),
    /** Required by the `type-to-confirm` tier; ignored (and refused if wrong) otherwise. */
    confirmationPhrase: z.string().max(200).optional(),
  })
  .strict();
export type PublishRequest = z.infer<typeof publishRequestSchema>;

/**
 * Revert by publishing FORWARD (SPEC-05 §6.1).
 *
 * "Reverting to v3 creates v5 with v3's content. Deleting v4 would erase the
 * fact that it happened." So the request names the historical version whose
 * content is wanted, and the server clones it into a new draft, approves it and
 * publishes that. **Nothing is deleted and no published row is touched.**
 */
export const revertRequestSchema = z
  .object({
    /** The historical version whose content is wanted back. */
    revertToVersionId: uuid,
    idempotencyKey: publicationIdempotencyKeySchema,
    expectedPriorCurrentVersionId: uuid.nullable(),
    acknowledged: z.literal(true),
    confirmationPhrase: z.string().max(200),
  })
  .strict();
export type RevertRequest = z.infer<typeof revertRequestSchema>;

export const publishResultSchema = z
  .object({
    /** `true` when the idempotency key had already published: nothing was emitted. */
    replay: z.boolean(),
    versionId: uuid,
    versionNumber: z.number().int().positive(),
    priorCurrentVersionId: uuid.nullable(),
    affectedMembershipCount: z.number().int().nonnegative(),
    changeCount: z.number().int().nonnegative(),
    correlationId: z.string().min(1),
  })
  .strict();
export type PublishResultWire = z.infer<typeof publishResultSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * The two 409s. Neither is an authorization signal.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * `409 CURRENT_VERSION_MOVED` — the compare-and-set loser, told exactly what it
 * lost to.
 *
 * V-12's "the loser fails explicitly" is a requirement about the INTERFACE as
 * much as about the transaction: a scheduler whose publication was refused
 * because a colleague published first has to be able to tell that apart from a
 * server error, and has to be handed a way back to a correct view. So the body
 * names the version that is actually current — **both its id, which the client
 * needs, and its number, which the reader needs** — and the client re-reads the
 * review against it. It never retries by itself.
 */
export const currentVersionMovedBodySchema = z
  .object({
    error: z
      .object({
        code: z.literal('CURRENT_VERSION_MOVED'),
        message: z.string().min(1).max(300),
        correlationId: z.string().min(1),
        /** What the server found to be current. `null` = nothing is current. */
        currentVersionId: uuid.nullable(),
        /**
         * The same version's NUMBER — what a human calls it.
         *
         * Carried alongside the id because the id is what the client needs and
         * the number is what the reader needs, and the surface must not have to
         * choose. Rendering the uuid was review finding N3: the panel's own
         * docblock promised it "names the version" and it printed
         * `44444444-4444-4444-8444-444444444444`, which names nothing to the
         * scheduler being told their publication was refused.
         *
         * `null` when nothing is current, or (unreachably, under the period
         * lock) when the refusal came from the frozen service rather than from
         * the route's own check.
         */
        currentVersionNumber: z.number().int().positive().nullable(),
      })
      .strict(),
  })
  .strict();
export type CurrentVersionMovedBody = z.infer<typeof currentVersionMovedBodySchema>;

/** `409 STALE_REVIEW` — the draft changed between the review and the confirmation. */
export const staleReviewBodySchema = z
  .object({
    error: z
      .object({
        code: z.literal('STALE_REVIEW'),
        message: z.string().min(1).max(300),
        correlationId: z.string().min(1),
        currentReviewDigest: revisionTokenSchema,
      })
      .strict(),
  })
  .strict();
export type StaleReviewBody = z.infer<typeof staleReviewBodySchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * History — immutable by construction, and rendered as such
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A version as the history renders it.
 *
 * `isImmutable` is computed by the SERVER from the state, and the client renders
 * an edit affordance for exactly the rows where it is `false`. Deriving it in
 * the browser would put the "can this be edited?" decision in two places, and
 * the browser's copy is the one that drifts.
 */
export const publishedVersionViewSchema = scheduleVersionViewSchema.extend({
  publishedAt: instant.nullable(),
  publishedByMembershipId: uuid.nullable(),
  publishedByDisplayName: displayName.nullable(),
  supersededAt: instant.nullable(),
  supersededByVersionId: uuid.nullable(),
  createdAt: instant,
  /** True for `published` and `superseded`: the row can never change again (I-18). */
  isImmutable: z.boolean(),
  /** How many active assignments the version holds. Counting, not rule execution. */
  activeAssignmentCount: z.number().int().nonnegative(),
});
export type PublishedVersionView = z.infer<typeof publishedVersionViewSchema>;

export const versionHistorySchema = z
  .object({
    period: schedulePeriodViewSchema,
    /** Newest first: history is read backwards from what is live. */
    versions: z.array(publishedVersionViewSchema),
    currentVersionId: uuid.nullable(),
    canPublish: z.boolean(),
    canRevert: z.boolean(),
    timezone: z.string().min(1).max(64),
    correlationId: z.string().min(1),
  })
  .strict();
export type VersionHistory = z.infer<typeof versionHistorySchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Comparison and the affected-staff read
 * ──────────────────────────────────────────────────────────────────────────── */

export const versionComparisonSchema = z
  .object({
    /** The earlier side. `null` compares a version against nothing (everything added). */
    fromVersion: publishedVersionViewSchema.nullable(),
    toVersion: publishedVersionViewSchema,
    difference: versionDifferenceSchema,
    shiftTypes: z.array(gridShiftTypeSchema),
    timezone: z.string().min(1).max(64),
    correlationId: z.string().min(1),
  })
  .strict();
export type VersionComparison = z.infer<typeof versionComparisonSchema>;

export const affectedStaffDiffSchema = z
  .object({
    fromVersionId: uuid.nullable(),
    toVersionId: uuid,
    affectedMembers: z.array(affectedMemberSchema),
    /** Present so a reader can check the member list against the changes it came from. */
    changeCount: z.number().int().nonnegative(),
    correlationId: z.string().min(1),
  })
  .strict();
export type AffectedStaffDiff = z.infer<typeof affectedStaffDiffSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * The published schedule, read-only
 * ──────────────────────────────────────────────────────────────────────────── */

export const publishedAssignmentSchema = z
  .object({
    assignmentIdentityId: uuid,
    membershipId: uuid,
    displayName: displayName.nullable(),
    date: isoDate,
    shiftTypeId: uuid,
    startsAt: instant,
    endsAt: instant,
    isPinned: z.boolean(),
    overrideReasonGiven: z.boolean(),
  })
  .strict();
export type PublishedAssignment = z.infer<typeof publishedAssignmentSchema>;

export const publishedScheduleSchema = z
  .object({
    period: schedulePeriodViewSchema,
    /** `null` when the period has never been published — an EMPTY state, not an error. */
    version: publishedVersionViewSchema.nullable(),
    assignments: z.array(publishedAssignmentSchema),
    shiftTypes: z.array(gridShiftTypeSchema),
    timezone: z.string().min(1).max(64),
    correlationId: z.string().min(1),
  })
  .strict();
export type PublishedSchedule = z.infer<typeof publishedScheduleSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Publication records — what the publication transaction durably recorded
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * One row of `publication_records`.
 *
 * ## This is NOT the audit chain, and it does not pretend to be
 *
 * The packet asks for "publication audit display **where authorized** (if no
 * audit read API exists, that is an escalation, not an in-packet audit-module
 * edit)". There is no audit read API: `apps/api/src/audit/` exposes a recorder,
 * a chain verifier and a checkpoint writer, and no query surface exists on any
 * route. That gap is escalated in the return report and **not** worked around
 * here — this surface reads `publication_records`, which is the publication
 * module's own append-only account of what it did (D-15d: no UPDATE or DELETE
 * grant exists on it), and it is labelled as such on screen so a reader is never
 * shown a publication record while being told it is an audit record.
 *
 * The idempotency key is deliberately absent from the wire: it is a caller-chosen
 * token whose only job is de-duplication, and publishing it invites a reader to
 * treat it as an identifier of the act.
 */
export const publicationRecordViewSchema = z
  .object({
    id: uuid,
    versionId: uuid,
    versionNumber: z.number().int().positive().nullable(),
    outcome: z.enum(['published', 'failed']),
    recordedAt: instant,
    actorMembershipId: uuid.nullable(),
    actorDisplayName: displayName.nullable(),
    /** From the record's own prerequisites snapshot, so a replay reads truthfully. */
    affectedCount: z.number().int().nonnegative().nullable(),
    priorCurrentVersionId: uuid.nullable(),
  })
  .strict();
export type PublicationRecordView = z.infer<typeof publicationRecordViewSchema>;

export const publicationRecordListSchema = z
  .object({
    periodId: uuid,
    records: z.array(publicationRecordViewSchema),
    correlationId: z.string().min(1),
  })
  .strict();
export type PublicationRecordList = z.infer<typeof publicationRecordListSchema>;
