import { z } from 'zod';

/**
 * OPUS-M2-003 — the wire shapes for effective-dated work profiles, weekday and
 * holiday FTE targets, and qualifications with expiry (CAP-013, CAP-058).
 *
 * Package rules, applied here without exception:
 *  - every object is `.strict()`, so an unknown key is REJECTED rather than
 *    carried through to a database that would ignore it (I-07 alignment);
 *  - identifiers are server-generated and never accepted from a caller. A
 *    caller-chosen primary key is the X-11 existence oracle: primary-key checks
 *    bypass RLS, so a 23505 raised by an invisible row discloses that it exists.
 *    Every `…Request` below therefore names a *subject* (a membership, a
 *    qualification) and no `id` of its own;
 *  - instants are ISO-8601 strings validated by zod's `datetime`, which requires
 *    an explicit offset or `Z`. A bare local timestamp is rejected, because "the
 *    profile takes effect on the 1st" means different instants in two
 *    timezones and effective dating is exactly where that matters.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Shared leaves
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * An ISO-8601 instant with an explicit zone.
 *
 * `offset: true` is what admits `2026-08-03T09:00:00+02:00` alongside a `Z`
 * form. Refusing both would force every caller into UTC; accepting a zoneless
 * string would let one through whose meaning depends on the server's timezone.
 */
export const instantSchema = z.string().datetime({ offset: true });

/**
 * The eight target days.
 *
 * `holiday` is a day *class*, not a weekday: doc 06 §3.2 gives
 * `membership_weekday_fte` a `weekday (0–6)` key, and this packet requires
 * holiday targets as well. The domain is the same eight-member set FAD-16
 * established for `shift_type_weekday_demand`, so M2's two demand/target
 * dimensions agree. Recorded as a doc-06 divergence in
 * `docs/evidence/EV-M2-PROFILES/INDEX.md`.
 */
export const TARGET_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'holiday'] as const;
export const targetDaySchema = z.enum(TARGET_DAYS);
export type TargetDay = (typeof TARGET_DAYS)[number];

export const HOLDING_STATUSES = ['pending', 'valid', 'expiring', 'expired', 'revoked'] as const;
export const holdingStatusSchema = z.enum(HOLDING_STATUSES);
export type HoldingStatus = (typeof HOLDING_STATUSES)[number];

/**
 * `evidence_ref` is a REFERENCE to a document held elsewhere, never the document
 * and never a note about a person.
 *
 * The pattern is the same one the migration's CHECK constraint enforces, and it
 * is here as well as there because a caller deserves a 400 with a named code
 * rather than a 422 from a constraint. Spaces are excluded deliberately: a
 * sentence cannot be stored in this field, which is what keeps I-07 true of a
 * column whose name invites free text.
 */
export const evidenceRefSchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,128}$/, 'evidence_ref must be an opaque reference, not free text');

/* ────────────────────────────────────────────────────────────────────────────
 * Work profiles
 * ──────────────────────────────────────────────────────────────────────────── */

export const weekdayTargetSchema = z
  .object({
    day: targetDaySchema,
    /** 0..1 inclusive, per doc 06 §3.2. */
    fteFraction: z.number().min(0).max(1),
    maxAssignments: z.number().int().min(0).nullable().optional(),
  })
  .strict();

export const authorWorkProfileRequestSchema = z
  .object({
    membershipId: z.string().uuid(),
    /**
     * When the new arrangement takes effect.
     *
     * **Omitted means "now", decided by the database rather than by the client.**
     * That is not a convenience: a supersession closes the outgoing row and opens
     * the incoming one, and if the two instants came from two clocks the windows
     * could overlap (rejected by the EXCLUDE constraint) or leave a gap (a period
     * with no profile in force at all). With this omitted, both instants are the
     * one `now()` of the transaction and neither outcome is reachable.
     *
     * **Supplied, it must not be in the past — and the layer that refuses it is
     * the SERVICE, returning 422.** The earlier wording here said "the database
     * refuses a retroactive close", which was true of a *close* and quietly
     * untrue of an *insert*: a row dated 2005 into a gap is well-formed, the
     * EXCLUDE constraint accepts it, and it changes what the in-force answer was
     * for a period that has already been scheduled against. An independent review
     * found the gap between this comment and what was enforced.
     *
     * `app_guard_work_profile_history` still refuses every UPDATE that touches
     * elapsed time — history cannot be REWRITTEN at the database. Authoring
     * history is refused one layer up, because it is a capability that should
     * eventually EXIST (an administrator does sometimes need to record "she was
     * actually at 60% from March") and needs its own decision, its own audit
     * shape and its own packet. Until then: 422.
     *
     * A caller who means "now" should OMIT this field. That is the recommended
     * spelling, it takes the database's clock rather than the client's, and it
     * cannot lose a race against the transaction instant.
     */
    effectiveFrom: instantSchema.optional(),
    /** 0 < percentage <= 100, per doc 06 §3.2. */
    workPercentage: z.number().gt(0).max(100),
    maxAssignmentsPerWeek: z.number().int().min(0).nullable().optional(),
    maxAssignmentsPerPeriod: z.number().int().min(0).nullable().optional(),
    maxConsecutiveDays: z.number().int().min(0).nullable().optional(),
    /**
     * At most one entry per day; duplicates are rejected below.
     *
     * **Omitted and `[]` mean different things, deliberately.**
     *
     * | | |
     * |---|---|
     * | omitted | on a supersession, the predecessor's targets are CARRIED FORWARD onto the new version; on a first profile there is nothing to carry |
     * | `[]` | cleared, on purpose |
     * | `[...]` | replaced wholesale |
     *
     * The distinction exists because "reduce this person to 60%" is the most
     * common call this surface takes, and it names a percentage and nothing else.
     * Treating that as "and no weekday targets" silently destroyed the per-day and
     * holiday dimension CAP-013 exists to hold — a review found it, and nothing
     * failed, because losing data the caller never mentioned looks exactly like
     * not having been asked for it.
     */
    weekdayTargets: z.array(weekdayTargetSchema).max(TARGET_DAYS.length).optional(),
  })
  .strict()
  .refine(
    (value) => {
      const days = (value.weekdayTargets ?? []).map((target) => target.day);
      return new Set(days).size === days.length;
    },
    { message: 'weekdayTargets contains the same day twice', path: ['weekdayTargets'] },
  );

export const workProfileSchema = z
  .object({
    id: z.string().uuid(),
    membershipId: z.string().uuid(),
    effectiveFrom: instantSchema,
    effectiveTo: instantSchema.nullable(),
    workPercentage: z.number(),
    maxAssignmentsPerWeek: z.number().int().nullable(),
    maxAssignmentsPerPeriod: z.number().int().nullable(),
    maxConsecutiveDays: z.number().int().nullable(),
    weekdayTargets: z.array(
      z
        .object({
          day: targetDaySchema,
          fteFraction: z.number(),
          maxAssignments: z.number().int().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export const authorWorkProfileResultSchema = z
  .object({
    profile: workProfileSchema,
    /** The row this one superseded, or `null` when it is the first. */
    supersededProfileId: z.string().uuid().nullable(),
    correlationId: z.string(),
  })
  .strict();

/**
 * The reason no row was in force, carried onto the wire **by name**.
 *
 * Four facts, never collapsed. "There is no profile" and "there is a gap between
 * two profiles" are different defects with different fixes, and an API that
 * answers `null` to both makes an effective-dating bug unreadable from the
 * outside — which is precisely how S-01 survived a milestone.
 */
export const NO_ROW_REASONS = ['no-rows', 'before-first', 'after-last', 'gap'] as const;
export const noRowReasonSchema = z.enum(NO_ROW_REASONS);

export const workProfileInForceResultSchema = z
  .object({
    membershipId: z.string().uuid(),
    /** The instant the answer is *about*. Echoed so a client cannot mis-attribute it. */
    at: instantSchema,
    profile: workProfileSchema.nullable(),
    reason: noRowReasonSchema.nullable(),
    correlationId: z.string(),
  })
  .strict();

export const workProfileHistoryResultSchema = z
  .object({
    membershipId: z.string().uuid(),
    /** Every row, oldest first. History is never filtered away. */
    profiles: z.array(workProfileSchema),
    correlationId: z.string(),
  })
  .strict();

/* ────────────────────────────────────────────────────────────────────────────
 * Qualifications
 * ──────────────────────────────────────────────────────────────────────────── */

export const createQualificationRequestSchema = z
  .object({
    key: z.string().min(1).max(64),
    name: z.string().min(1).max(200),
    requiresExpiry: z.boolean().optional(),
    issuingBody: z.string().min(1).max(200).nullable().optional(),
  })
  .strict();

export const qualificationSchema = z
  .object({
    id: z.string().uuid(),
    key: z.string(),
    name: z.string(),
    requiresExpiry: z.boolean(),
    issuingBody: z.string().nullable(),
    status: z.enum(['active', 'retired']),
  })
  .strict();

export const createQualificationResultSchema = z
  .object({ qualification: qualificationSchema, correlationId: z.string() })
  .strict();

/**
 * Retire or reinstate. There is deliberately no delete verb on this surface: 06
 * §3.2 says a qualification is "not deleted while holdings exist", and a status
 * change is reversible where a delete is not.
 */
export const setQualificationStatusRequestSchema = z
  .object({ status: z.enum(['active', 'retired']) })
  .strict();

export const grantHoldingRequestSchema = z
  .object({
    membershipId: z.string().uuid(),
    qualificationId: z.string().uuid(),
    validFrom: instantSchema.optional(),
    validUntil: instantSchema.nullable().optional(),
    evidenceRef: evidenceRefSchema.nullable().optional(),
    /** A holding may be issued `pending` verification or already `valid`. */
    status: z.enum(['pending', 'valid']).optional(),
  })
  .strict();

export const holdingSchema = z
  .object({
    id: z.string().uuid(),
    membershipId: z.string().uuid(),
    qualificationId: z.string().uuid(),
    validFrom: instantSchema,
    validUntil: instantSchema.nullable(),
    evidenceRef: z.string().nullable(),
    status: holdingStatusSchema,
  })
  .strict();

export const grantHoldingResultSchema = z
  .object({ holding: holdingSchema, correlationId: z.string() })
  .strict();

export const changeHoldingStatusRequestSchema = z
  .object({
    /**
     * The target state. `revoked` is terminal and the transition table in the
     * migration is what enforces the rest — the schema admits the vocabulary, the
     * database admits the transition.
     */
    status: z.enum(['valid', 'expiring', 'expired', 'revoked']),
  })
  .strict();

export const changeHoldingStatusResultSchema = z
  .object({ holding: holdingSchema, correlationId: z.string() })
  .strict();

export const membershipHoldingsResultSchema = z
  .object({
    membershipId: z.string().uuid(),
    at: instantSchema,
    /** Every holding visible to the caller, oldest first — including expired ones. */
    holdings: z.array(holdingSchema),
    /** Whether any visible holding confers eligibility at `at`. */
    eligible: z.boolean(),
    correlationId: z.string(),
  })
  .strict();

/* ────────────────────────────────────────────────────────────────────────────
 * Inferred types
 * ──────────────────────────────────────────────────────────────────────────── */

export type WeekdayTarget = z.infer<typeof weekdayTargetSchema>;
export type AuthorWorkProfileRequest = z.infer<typeof authorWorkProfileRequestSchema>;
export type AuthorWorkProfileResult = z.infer<typeof authorWorkProfileResultSchema>;
export type WorkProfile = z.infer<typeof workProfileSchema>;
export type WorkProfileInForceResult = z.infer<typeof workProfileInForceResultSchema>;
export type WorkProfileHistoryResult = z.infer<typeof workProfileHistoryResultSchema>;
export type NoRowReasonWire = z.infer<typeof noRowReasonSchema>;
export type CreateQualificationRequest = z.infer<typeof createQualificationRequestSchema>;
export type SetQualificationStatusRequest = z.infer<typeof setQualificationStatusRequestSchema>;
export type CreateQualificationResult = z.infer<typeof createQualificationResultSchema>;
export type Qualification = z.infer<typeof qualificationSchema>;
export type GrantHoldingRequest = z.infer<typeof grantHoldingRequestSchema>;
export type GrantHoldingResult = z.infer<typeof grantHoldingResultSchema>;
export type Holding = z.infer<typeof holdingSchema>;
export type ChangeHoldingStatusRequest = z.infer<typeof changeHoldingStatusRequestSchema>;
export type ChangeHoldingStatusResult = z.infer<typeof changeHoldingStatusResultSchema>;
export type MembershipHoldingsResult = z.infer<typeof membershipHoldingsResultSchema>;
