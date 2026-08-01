import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
  }
}

export const CORRELATION_ID_HEADER = 'x-correlation-id';

/**
 * A client-supplied correlation id is accepted only if it is a plain, bounded
 * token. Anything else is replaced rather than sanitised — an id is echoed into
 * logs and audit rows, so it is treated as untrusted input with a positive
 * allowlist, not as a string to clean up.
 */
const ACCEPTABLE_INBOUND_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Correlation-id hook.
 *
 * Every request carries an id from its first hook to its response header, so a
 * user-visible failure can be quoted back and found in one query. I-06 requires
 * the same id on the audit row of every mutation; this is where it originates.
 */
export function registerCorrelationId(app: FastifyInstance): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const supplied = request.headers[CORRELATION_ID_HEADER];
    const candidate = Array.isArray(supplied) ? supplied[0] : supplied;

    request.correlationId =
      typeof candidate === 'string' && ACCEPTABLE_INBOUND_ID.test(candidate)
        ? candidate
        : randomUUID();

    reply.header(CORRELATION_ID_HEADER, request.correlationId);
  });
}
