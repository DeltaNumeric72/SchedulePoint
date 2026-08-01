import Fastify, { type FastifyInstance } from 'fastify';

import { registerCorrelationId } from './correlation-id.js';
import { registerErrorEnvelope } from './errors.js';
import { registerRoutes } from './routes/index.js';
import { createRouteTable, type RouteTableEntry } from './route-table.js';

export interface BuiltServer {
  app: FastifyInstance;
  /** Every route Fastify registered, with its declared policy (or `undefined`). */
  routeTable: readonly RouteTableEntry[];
}

/**
 * Builds the server. No product routes, no database, no queue — the scaffold's
 * API is the three cross-cutting concerns (correlation id, error envelope,
 * policy-checked route table) and one liveness route.
 */
export async function buildServer(options: { logger?: boolean } = {}): Promise<BuiltServer> {
  const app = Fastify({
    logger: options.logger ?? false,
    // A forged or oversized correlation id must not reach the log line as-is;
    // `correlation-id.ts` allowlists it. Disabling Fastify's own request id
    // keeps exactly one id in play.
    genReqId: () => '',
    disableRequestLogging: true,
  });

  const { entries, plugin } = createRouteTable();
  plugin(app);

  registerCorrelationId(app);
  registerErrorEnvelope(app);
  await registerRoutes(app);
  await app.ready();

  return { app, routeTable: entries };
}
