import { z } from 'zod';

/**
 * SPEC-01 §2.2 — the wire form of the client's context declaration.
 *
 * > | JSON API | Path segment `/organizations/{org}/groups/{group}/…` for
 * > group-scoped actions, `/organizations/{org}/…` for organization-scoped ones,
 * > **and** an `X-SchedulePoint-Context` header carrying `context_version` and
 * > `session_epoch` |
 *
 * > **The path segment is not sufficient on its own** — it identifies the tenant
 * > but not the freshness. Both are required.
 *
 * The header is JSON so it can carry the three counters SPEC-06 §4 defines
 * without three more headers. It is parsed with a **strict** schema: an unknown
 * key is a rejection, not a field to ignore, because a client sending a field
 * this server does not understand is a client whose freshness assumptions this
 * server cannot verify.
 */
export const CONTEXT_HEADER = 'x-schedulepoint-context';

/** A version counter. Non-negative, integral, and bounded to a safe integer. */
const versionCounter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const contextVersionSchema = z
  .object({
    organizationVersion: versionCounter,
    /** `null` for an organization-scoped action — there is no group to be fresh about. */
    groupVersion: versionCounter.nullable(),
    membershipSetVersion: versionCounter,
  })
  .strict();

export type ContextVersionWire = z.infer<typeof contextVersionSchema>;

export const contextHeaderSchema = z
  .object({
    contextVersion: contextVersionSchema,
    sessionEpoch: versionCounter,
  })
  .strict();

export type ContextHeaderWire = z.infer<typeof contextHeaderSchema>;

/**
 * The error codes SPEC-01 §2.3 defines, as they appear on the wire.
 *
 * `CONTEXT_STALE` and `SESSION_STALE` are **recoverable user-interface
 * conditions**, not attacks: the client can re-fetch and retry, and telling it
 * so is what stops a stale tab from failing mysteriously or, worse, succeeding
 * against the wrong group (§2.4).
 *
 * There is deliberately **no** `FORGED_CONTEXT`, `NOT_A_MEMBER`, or
 * `WRONG_TENANT` code. Every such case is `NOT_FOUND`, byte-identical to a
 * non-existent id (§2.4, T-05b). A distinct code would be the disclosure.
 */
export const CONTEXT_ERROR_CODES = {
  /** §2.3 steps 1–3, and step 6 for an unauthorized actor. HTTP 404. */
  notFound: 'NOT_FOUND',
  /** §2.3 step 4. HTTP 409, with a re-fetch directive. */
  contextStale: 'CONTEXT_STALE',
  /** §2.3 step 5. HTTP 409 — forces re-authentication of context. */
  sessionStale: 'SESSION_STALE',
  /** §2.3 step 6 for an actor authorized in the declared tenant. HTTP 409. */
  contextTargetMismatch: 'CONTEXT_TARGET_MISMATCH',
  /** No session. HTTP 401. */
  unauthenticated: 'UNAUTHENTICATED',
  /** §2.3 step 7 denial where the actor may know the object exists. HTTP 403. */
  forbidden: 'FORBIDDEN',
  /** The declaration itself was malformed — a missing or unparseable header. HTTP 400. */
  contextMalformed: 'CONTEXT_MALFORMED',
} as const;

export type ContextErrorCode = (typeof CONTEXT_ERROR_CODES)[keyof typeof CONTEXT_ERROR_CODES];

/**
 * The re-fetch directive carried by a `409`.
 *
 * A stale context is recoverable, so the response says how: the client re-reads
 * the context endpoint for the declared tenant and retries. It carries **no
 * counter values** — echoing the current counters back would let an actor who
 * failed step 2 learn them.
 */
export const contextStaleBodySchema = z
  .object({
    error: z
      .object({
        code: z.enum(['CONTEXT_STALE', 'SESSION_STALE', 'CONTEXT_TARGET_MISMATCH']),
        message: z.string().min(1),
        correlationId: z.string().min(1),
        /** What the client must do to recover. A fixed, enumerated instruction. */
        recover: z.enum(['refetch-context', 'reauthenticate']),
      })
      .strict(),
  })
  .strict();

export type ContextStaleBody = z.infer<typeof contextStaleBodySchema>;

/**
 * The body of the context-probe surfaces this milestone ships.
 *
 * These routes exist to exercise SPEC-01 §2.3 and §3 over HTTP. They are
 * declared with placeholder policies that deny by default; the real policies
 * arrive with the SPEC-06 evaluator in OPUS-M1-002.
 */
export const contextProbeResultSchema = z
  .object({
    /** Echoed back so a test can prove the DECLARED tenant was honoured, not a substituted one. */
    organizationId: z.string().uuid(),
    groupId: z.string().uuid().nullable(),
    membershipId: z.string().uuid(),
    actionScope: z.enum(['group', 'organization']),
    authorizationVersion: z.string().min(1),
    correlationId: z.string().min(1),
    /** ISO-8601 instant the mutation wrote, so a caller can prove a write happened. */
    mutatedAt: z.string().datetime(),
  })
  .strict();

export type ContextProbeResult = z.infer<typeof contextProbeResultSchema>;

export const jobEnqueueResultSchema = z
  .object({
    jobId: z.string().uuid(),
    kind: z.string().min(1),
    /** The context frozen into the payload at enqueue (SPEC-01 §6). */
    frozen: z
      .object({
        organizationId: z.string().uuid(),
        groupId: z.string().uuid().nullable(),
        membershipId: z.string().uuid().nullable(),
        actionScope: z.enum(['group', 'organization']),
        authorizationVersionAtEnqueue: z.string().min(1),
      })
      .strict(),
    correlationId: z.string().min(1),
  })
  .strict();

export type JobEnqueueResult = z.infer<typeof jobEnqueueResultSchema>;
