import { z } from 'zod';

/**
 * The one example contract in the scaffold.
 *
 * It is deliberately not a product contract: it describes the liveness probe
 * only. Its job is to prove that a single zod schema is the source of truth for
 * the API response type and the web client's parse step.
 */
export const healthStatusSchema = z
  .object({
    status: z.literal('ok'),
    /** Server-side ISO-8601 instant. The client never trusts its own clock. */
    checkedAt: z.string().datetime(),
    /** Correlation id echoed from the request, so a UI can quote it in a bug report. */
    correlationId: z.string().min(1),
  })
  .strict();

export type HealthStatus = z.infer<typeof healthStatusSchema>;

/**
 * The typed error envelope. Every non-2xx API response has this shape and no
 * other; handlers never emit a bare string or a framework default body.
 *
 * `message` is operator-facing and must never carry a payload body, a contact
 * value, or delivery material (I-17, SPEC-07 §3).
 */
export const errorEnvelopeSchema = z
  .object({
    error: z
      .object({
        /** Stable machine-readable code, screaming snake case. */
        code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
        /** Short human-readable summary. Never interpolates request data. */
        message: z.string().min(1),
        /** The correlation id of the failing request. */
        correlationId: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
