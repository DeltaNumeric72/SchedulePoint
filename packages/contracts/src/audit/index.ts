import { z } from 'zod';

/**
 * The audit **read** surface (OPUS-M3-008; FAD-26's recorded gap).
 *
 * ## Why this did not exist until now
 *
 * `apps/api/src/audit/` shipped a recorder, a chain verifier and a checkpoint
 * writer at M1, and nothing that reads. OPUS-M3-005 needed "publication audit
 * display where authorized", found no read API, and did the right thing: it
 * escalated rather than reaching into a frozen module, and shipped the display
 * over `publication_records` **labelled as not-the-chain**. FAD-26 recorded the
 * gap and assigned it here.
 *
 * ## What is safe to put on the wire, and why
 *
 * `audit_events.payload` is CLOSED by `app_audit_payload_is_closed` (migration
 * 0003): at most sixteen keys, scalar values, each string at most 64 printable
 * characters. That constraint exists for I-07 — no patient-identifying
 * information and no clinical free text can be in an audit payload, because the
 * database refuses the row otherwise. So the payload is publishable here for the
 * same reason it was writable there, and a reader gets the identifiers an
 * investigation actually needs rather than a row of opaque timestamps.
 *
 * `entry_hash` and `prev_hash` travel as hex. They are not secrets — the whole
 * point of a hash chain is that anyone holding the rows can verify it — and
 * without them a reader cannot tell this surface from an ordinary log.
 *
 * **`sequence` is per organization, and this read is group-scoped**, so a group
 * reader sees a subset with gaps in it. That is stated on the wire
 * (`sequenceIsOrganizationWide`) rather than left to be misread as damage: it is
 * exactly the confusion that produced the M3-003 review's N-8 false alarm, and
 * the chain VERIFIER now refuses a group-scoped invocation for the same reason.
 * Verification is not this surface's job and this surface never claims it.
 */

const uuid = z.string().uuid();
const instant = z.string().datetime({ offset: true });
const hex = z.string().regex(/^[0-9a-f]+$/, 'a hash is lower-case hex');

/* The three bounds of `app_audit_payload_is_closed`, named so a reader can check
 * them against the migration rather than count characters in a regex. */
/** `jsonb_object_keys(p_payload) <= 16`. */
export const AUDIT_PAYLOAD_MAX_KEYS = 16;
/** `length(v #>> '{}') > 64` refuses the row. */
export const AUDIT_PAYLOAD_MAX_VALUE_LENGTH = 64;
/** `k !~ '^[a-z][a-zA-Z0-9]{0,39}$'` refuses the row. */
export const AUDIT_PAYLOAD_KEY_PATTERN = /^[a-z][a-zA-Z0-9]{0,39}$/;
/** `(v #>> '{}') !~ '^[!-~]*$'` refuses the row: printable ASCII only. */
export const AUDIT_PAYLOAD_VALUE_PATTERN = /^[!-~]*$/;

/**
 * The closed audit payload, mirroring `app_audit_payload_is_closed` key for key.
 *
 * `null` is admitted as a VALUE even though the CHECK's `jsonb_typeof` list does
 * not include it, because a JSON `null` is `jsonb_typeof = 'null'` and would be
 * refused by the database — so a payload carrying one cannot have come from the
 * table. It is accepted here only so that a caller reading a row written before
 * the constraint existed does not 500 on a shape the surface can render; the
 * database remains the control.
 */
const auditPayloadValue = z.union([
  z.string().max(AUDIT_PAYLOAD_MAX_VALUE_LENGTH).regex(AUDIT_PAYLOAD_VALUE_PATTERN),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const auditPayloadSchema = z
  .record(z.string().regex(AUDIT_PAYLOAD_KEY_PATTERN), auditPayloadValue)
  .refine(
    (payload) => Object.keys(payload).length <= AUDIT_PAYLOAD_MAX_KEYS,
    `an audit payload carries at most ${String(AUDIT_PAYLOAD_MAX_KEYS)} keys`,
  );

export const auditEventViewSchema = z
  .object({
    id: uuid,
    /** Per ORGANIZATION and gapless there; a group-scoped read sees a subset. */
    sequence: z.string().regex(/^\d+$/),
    occurredAt: instant,
    eventName: z.string().min(1).max(120),
    actorKind: z.string().min(1).max(32),
    actorMembershipId: uuid.nullable(),
    actorDisplayName: z.string().min(1).max(200).nullable(),
    groupId: uuid.nullable(),
    subjectType: z.string().min(1).max(64),
    subjectId: uuid.nullable(),
    /**
     * The audit payload, **re-stated on the wire rather than trusted**.
     *
     * `app_audit_payload_is_closed` (migration 0003) is what makes an audit
     * payload publishable at all: it refuses any row whose payload is not an
     * object of at most **sixteen** keys matching `^[a-z][a-zA-Z0-9]{0,39}$`,
     * whose values are not string/number/boolean, or whose strings exceed **64**
     * printable characters. That constraint is I-07's enforcement — it is why no
     * clinical free text and no patient identifier can be in there to leak.
     *
     * This schema mirrors it exactly, for the reason the period-length CHECK was
     * added at the database as well as the contract: **a bound enforced in one
     * layer is a bound the next writer does not have.** The database is the
     * control; this is the second layer, and it is what stops a future reader,
     * a fixture, or a mock from putting a shape on this surface that the real
     * table could never have produced. The two are asserted equal by
     * `apps/api/test/audit/read-surface.test.ts`.
     */
    payload: auditPayloadSchema,
    entryHash: hex,
    prevHash: hex,
  })
  .strict();
export type AuditEventView = z.infer<typeof auditEventViewSchema>;

/** The hard ceiling on one page of audit rows. */
export const AUDIT_READ_MAX_LIMIT = 200;

export const auditEventListSchema = z
  .object({
    events: z.array(auditEventViewSchema),
    /**
     * `true` when the ceiling truncated the answer, so a reader is never shown a
     * partial history that looks complete.
     */
    truncated: z.boolean(),
    /**
     * Restated on every response: this is a filtered, group-scoped READ of the
     * chain, not a verification of it, and its sequence numbers are expected to
     * have gaps.
     */
    sequenceIsOrganizationWide: z.literal(true),
    correlationId: z.string().min(1),
  })
  .strict();
export type AuditEventList = z.infer<typeof auditEventListSchema>;

/** The query a caller may narrow an audit read with. Everything optional. */
export const auditEventQuerySchema = z
  .object({
    subjectType: z.string().min(1).max(64).optional(),
    subjectId: uuid.optional(),
    /** An exact event name, never a pattern: a wildcard is a query language. */
    eventName: z.string().min(1).max(120).optional(),
    limit: z.coerce.number().int().positive().max(AUDIT_READ_MAX_LIMIT).optional(),
  })
  .strict();
export type AuditEventQuery = z.infer<typeof auditEventQuerySchema>;
