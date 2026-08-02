import { CONTEXT_ERROR_CODES, contextStaleBodySchema } from '@schedulepoint/contracts';
import type { ContextFailure } from '@schedulepoint/domain';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { buildEnvelope } from '../errors.js';

/**
 * Turning a SPEC-01 §2.3 failure into an HTTP response.
 *
 * ## The one property this module exists to guarantee
 *
 * **Every TENANT `404` this server produces is byte-identical.** SPEC-01 §7.1
 * T-05b requires the response for "target object in another tenant, actor holds
 * no capability" to be *byte-identical to the response for a non-existent id*,
 * with "no timing or body difference". The way to get that is to have exactly one
 * not-found response in the codebase and route every tenant not-found reason
 * through it — a forged organization, a forged group, a revoked membership, a
 * cross-tenant target and a genuinely absent row all end at `sendNotFound` with
 * the same code, the same message and the same status.
 *
 * **A route that does not exist is deliberately different**, and that is
 * correct rather than an oversight: `errors.ts`'s not-found handler answers
 * `ROUTE_NOT_FOUND` before any tenant is declared, resolved, or verified. It
 * discloses the shape of the URL space, which is public — the OpenAPI document
 * says the same thing — and it discloses nothing about who exists inside a
 * tenant. Collapsing the two would mean a typo'd path was indistinguishable from
 * a permission failure, which helps an attacker not at all and costs every
 * legitimate client its first debugging step.
 *
 * `ContextFailure.reason` is the diagnostic that makes an incident debuggable,
 * and it is written to the server log **only**. If it ever reaches a client, the
 * disclosure §2.4 prevents is back.
 *
 * ## Why `409` is different, and why that is not a leak
 *
 * `CONTEXT_STALE` and `SESSION_STALE` are recoverable user-interface conditions,
 * not attacks (§2.4): the client can say "this tab is showing Group A but you
 * have switched to Group B" instead of failing mysteriously. Reaching them
 * requires having already passed steps 1–3, i.e. holding an active membership in
 * the declared tenant. `CONTEXT_TARGET_MISMATCH` is reachable only by an actor
 * who *also* holds the capability for the action in the tenant they declared
 * (§2.3 step 6, V-07). An actor without that gets the `404`.
 */

/** The single not-found body. Nothing varies with the reason. */
const NOT_FOUND_MESSAGE = 'Not found.';

export interface ContextFailureLog {
  readonly correlationId: string;
  readonly code: string;
  readonly step: number;
  readonly reason: string;
  readonly securityEvent: boolean;
  readonly principalUserId: string | null;
  readonly declaredOrganizationId: string | null;
  readonly declaredGroupId: string | null;
}

export function sendNotFound(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply
    .code(404)
    .send(buildEnvelope(CONTEXT_ERROR_CODES.notFound, NOT_FOUND_MESSAGE, request.correlationId));
}

export function sendContextFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  failure: ContextFailure,
  declared: {
    principalUserId: string | null;
    organizationId: string | null;
    groupId: string | null;
  },
): FastifyReply {
  const logLine: ContextFailureLog = {
    correlationId: request.correlationId,
    code: failure.code,
    step: failure.step,
    reason: failure.reason,
    securityEvent: failure.securityEvent,
    principalUserId: declared.principalUserId,
    declaredOrganizationId: declared.organizationId,
    declaredGroupId: declared.groupId,
  };

  // T-04: "logged as a security event". Tenant identifiers and the step are
  // operator-facing metadata; no payload body and nothing a user typed appears
  // here (I-07, I-17).
  if (failure.securityEvent) {
    request.log.warn({ contextSecurityEvent: logLine }, 'context declaration rejected');
  } else {
    request.log.info({ contextFailure: logLine }, 'context declaration rejected');
  }

  switch (failure.code) {
    case 'NOT_FOUND':
      return sendNotFound(request, reply);

    // Every 409 is parsed through its own contract on the way out, for the same
    // reason `buildEnvelope` parses the 404 path: it is the cheapest way to
    // guarantee the body a client receives is the body the contract describes,
    // and it makes a field added here without being added to the schema a test
    // failure rather than an undocumented wire change.
    case 'CONTEXT_STALE':
      return reply.code(409).send(
        contextStaleBodySchema.parse({
          error: {
            code: CONTEXT_ERROR_CODES.contextStale,
            message: 'The context this request declared is no longer current.',
            correlationId: request.correlationId,
            recover: 'refetch-context',
          },
        }),
      );

    case 'SESSION_STALE':
      return reply.code(409).send(
        contextStaleBodySchema.parse({
          error: {
            code: CONTEXT_ERROR_CODES.sessionStale,
            message: 'The session this request declared is no longer current.',
            correlationId: request.correlationId,
            recover: 'reauthenticate',
          },
        }),
      );

    case 'CONTEXT_TARGET_MISMATCH':
      return reply.code(409).send(
        contextStaleBodySchema.parse({
          error: {
            code: CONTEXT_ERROR_CODES.contextTargetMismatch,
            message: 'The target does not belong to the declared context.',
            correlationId: request.correlationId,
            recover: 'refetch-context',
          },
        }),
      );
  }
}

export function sendUnauthenticated(
  request: FastifyRequest,
  reply: FastifyReply,
  reason: string,
): FastifyReply {
  request.log.info({ correlationId: request.correlationId, reason }, 'request is unauthenticated');
  return reply
    .code(401)
    .send(
      buildEnvelope(
        CONTEXT_ERROR_CODES.unauthenticated,
        'Authentication is required.',
        request.correlationId,
      ),
    );
}

/**
 * SPEC-06 P-6: `403` where the actor may know the object exists, `404` where
 * knowing that is itself disclosure.
 *
 * A denial reached *after* the context sequence passed means the actor holds an
 * active membership in the declared tenant, so the tenant's existence is already
 * known to them and `403` discloses nothing new. Any denial that would reveal
 * something they do not already know is routed through `sendNotFound` instead.
 */
export function sendForbidden(
  request: FastifyRequest,
  reply: FastifyReply,
  reason: string,
): FastifyReply {
  request.log.info({ correlationId: request.correlationId, reason }, 'authorization denied');
  return reply
    .code(403)
    .send(
      buildEnvelope(
        CONTEXT_ERROR_CODES.forbidden,
        'This action is not permitted.',
        request.correlationId,
      ),
    );
}

export function sendContextMalformed(
  request: FastifyRequest,
  reply: FastifyReply,
  problem: string,
): FastifyReply {
  request.log.info(
    { correlationId: request.correlationId, problem },
    'context declaration malformed',
  );
  return reply
    .code(400)
    .send(
      buildEnvelope(
        CONTEXT_ERROR_CODES.contextMalformed,
        'The request did not carry a well-formed context declaration.',
        request.correlationId,
      ),
    );
}
