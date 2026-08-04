import { z } from 'zod';

/**
 * The publication idempotency key — one domain, stated once (FAD-22(3)).
 *
 * ## Why the domain exists at all
 *
 * D-17 makes publication idempotent by `UNIQUE (period_id,
 * publication_idempotency_key)`, and the key also composes into the outbox
 * event's own idempotency key as `schedule-publish:<period uuid>:<key>`. Before
 * this was pinned, the key was any text up to 200 characters, which had two
 * consequences the independent review named:
 *
 *  - a key carrying whitespace, punctuation or a colon could collide in the
 *    COMPOSED outbox namespace even while being distinct here;
 *  - a key outside what the database would accept surfaced as a raw `23514`
 *    from the middle of the publishing transaction, after work had been done —
 *    a 500-shaped failure for what is a caller mistake.
 *
 * ## Why these characters and this length
 *
 * `[A-Za-z0-9_.-]` is exactly the set that survives being embedded in the
 * composed outbox key without escaping, and it excludes the colon that
 * separates the composed key's own fields — so no key can forge a field
 * boundary there. 64 characters keeps the composed key
 * (`schedule-publish:` + 36 + `:` + 64 = 118) inside SPEC-07's outbox-key
 * constraint with room to spare, and is far more than a UUID or a ULID needs.
 *
 * The same pattern is CHECK-enforced on `publication_records` in migration
 * 0009. This is the copy that produces a 422; the CHECK is the backstop that
 * makes the property true for a caller that never came through here.
 */
export const PUBLICATION_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

export const publicationIdempotencyKeySchema = z
  .string()
  .regex(
    PUBLICATION_IDEMPOTENCY_KEY_PATTERN,
    'A publication idempotency key is 1–64 characters of letters, digits, underscore, dot or hyphen.',
  );

export type PublicationIdempotencyKey = z.infer<typeof publicationIdempotencyKeySchema>;

/**
 * The publication request.
 *
 * `expectedPriorCurrentVersionId` is REQUIRED (FAD-22(2)) and nullable: the
 * caller states which version it believes it is superseding, and `null` means
 * "I believe nothing is current yet" — a first publication. It is deliberately
 * not optional, because an omitted compare-and-set is indistinguishable from a
 * caller that never considered concurrency, and V-12's "the loser fails
 * explicitly" cannot hold when the check can be skipped.
 */
export const publishVersionRequestSchema = z
  .object({
    periodId: z.string().uuid(),
    versionId: z.string().uuid(),
    idempotencyKey: publicationIdempotencyKeySchema,
    expectedPriorCurrentVersionId: z.string().uuid().nullable(),
    expectedVersionState: z.literal('approved').optional(),
  })
  .strict();

export type PublishVersionRequest = z.infer<typeof publishVersionRequestSchema>;
