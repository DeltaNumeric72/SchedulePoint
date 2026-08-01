import { errorEnvelopeSchema, type ErrorEnvelope } from '@schedulepoint/contracts';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * The typed error envelope.
 *
 * Two properties matter and both are tested:
 *
 *  1. **One shape.** Every non-2xx response — thrown error, 404, validation
 *     failure — is `{ error: { code, message, correlationId } }`. Fastify's
 *     default error body never reaches a client.
 *  2. **Nothing leaks.** For 5xx the message is a fixed string. Framework
 *     messages routinely quote the offending value, and a quoted value is how
 *     a payload body or a contact value ends up in a client response and a log
 *     line (I-17, SPEC-07 §3). The correlation id is the only thing the client
 *     gets, and it is enough to find the real error server-side.
 */

const GENERIC_5XX_MESSAGE = 'The request could not be completed.';

export function buildEnvelope(code: string, message: string, correlationId: string): ErrorEnvelope {
  // Parsing our own output looks redundant; it is the cheapest way to guarantee
  // the envelope the client receives is the envelope the contract describes.
  return errorEnvelopeSchema.parse({ error: { code, message, correlationId } });
}

export function registerErrorEnvelope(app: FastifyInstance): void {
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    void reply
      .code(404)
      .send(buildEnvelope('ROUTE_NOT_FOUND', 'No such route.', request.correlationId));
  });

  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const status = typeof error.statusCode === 'number' ? error.statusCode : 500;

    if (status >= 500) {
      request.log.error(
        { err: error, correlationId: request.correlationId },
        'unhandled request error',
      );
      void reply
        .code(status)
        .send(buildEnvelope('INTERNAL_ERROR', GENERIC_5XX_MESSAGE, request.correlationId));
      return;
    }

    void reply
      .code(status)
      .send(
        buildEnvelope(
          typeof error.code === 'string' && error.code.length > 0 ? error.code : 'BAD_REQUEST',
          error.message.length > 0 ? error.message : 'The request was rejected.',
          request.correlationId,
        ),
      );
  });
}
