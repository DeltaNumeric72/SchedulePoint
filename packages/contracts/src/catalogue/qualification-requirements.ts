import { z } from 'zod';

/**
 * `shift_type_qualifications` — the requirement edge, and the two eligibility
 * reads it exists to answer (OPUS-M2-004; CAP-011 x CAP-058).
 *
 * The same rules as the rest of the catalogue contracts: `.strict()` throughout,
 * server-generated ids, no denial reason in any body.
 *
 * ## What these types deliberately do NOT say
 *
 * Nothing here decides whether a member may be **assigned** to a shift. The
 * requirement set is an INPUT to the M4 scheduling engine, and the engine is its
 * consumer. `eligible` below is arithmetic over the requirements a caller can
 * see and the holdings RLS lets them see — a report, not a verdict. Calling it a
 * verdict is exactly the mistake that would put an authorization decision on the
 * client.
 */

const uuid = z.string().uuid();

/**
 * One requirement, as a shift-type author sees it.
 *
 * `qualificationKey` and `qualificationName` are joined in so an authoring form
 * does not have to issue a second request per requirement — I-10 is about one
 * user action producing one request, and a list that forces N follow-ups is the
 * amplification the invariant names.
 */
export const shiftTypeQualificationSchema = z
  .object({
    shiftTypeQualificationId: uuid,
    qualificationId: uuid,
    qualificationKey: z.string().min(1).max(64),
    qualificationName: z.string().min(1).max(200),
    /** `false` once the requirement has been archived. Archived rows are retained. */
    active: z.boolean(),
  })
  .strict();

export type ShiftTypeQualification = z.infer<typeof shiftTypeQualificationSchema>;

export const shiftTypeQualificationListSchema = z
  .object({
    shiftTypeId: uuid,
    requirements: z.array(shiftTypeQualificationSchema),
    correlationId: z.string(),
  })
  .strict();

export type ShiftTypeQualificationList = z.infer<typeof shiftTypeQualificationListSchema>;

/**
 * The whole requirement set for a shift type, sent as a set.
 *
 * A PUT of the complete set rather than per-row POST/DELETE, for two reasons.
 * I-10: an author changing three requirements performs one action and must issue
 * one request. And archive-not-delete: expressing removal as "this id is no
 * longer in the set" keeps the archiving decision on the server, where the
 * retention rule lives, instead of asking the client to send a DELETE the
 * database would refuse.
 *
 * Twenty is a deliberate ceiling rather than an open list: the request is
 * authenticated and authorized before it is parsed, but an unbounded array is an
 * unbounded statement, and no shift type in the observed model has anything like
 * twenty distinct credential requirements.
 */
export const setShiftTypeQualificationsRequestSchema = z
  .object({
    qualificationIds: z.array(uuid).max(20),
  })
  .strict();

export type SetShiftTypeQualificationsRequest = z.infer<
  typeof setShiftTypeQualificationsRequestSchema
>;

/**
 * One shift type, from the member-eligibility direction.
 *
 * `missingQualificationIds` is the answer to "why not", and it is safe to send
 * because reaching this response at all requires the credential-read capability
 * in this group: everything named is something the caller could already read.
 */
export const shiftTypeEligibilitySchema = z
  .object({
    shiftTypeId: uuid,
    shiftTypeCode: z.string().min(1).max(32),
    requiredQualificationIds: z.array(uuid),
    missingQualificationIds: z.array(uuid),
    /**
     * `requiredQualificationIds` minus what the member holds, empty.
     *
     * **A report, not an authorization verdict.** Enforcement belongs to the M4
     * engine; this says what the requirement data currently implies.
     */
    eligible: z.boolean(),
  })
  .strict();

export type ShiftTypeEligibility = z.infer<typeof shiftTypeEligibilitySchema>;

export const membershipEligibilitySchema = z
  .object({
    membershipId: uuid,
    /** The instant the holdings were evaluated at — expiry makes eligibility time-dependent. */
    at: z.string().datetime(),
    shiftTypes: z.array(shiftTypeEligibilitySchema),
    correlationId: z.string(),
  })
  .strict();

export type MembershipEligibility = z.infer<typeof membershipEligibilitySchema>;
