import type { JobQueue } from '@schedulepoint/domain';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

import { InMemoryJobQueue } from '../jobs/in-memory-queue.js';
import { registerContextMiddleware, type TenancyRuntime } from './context/middleware.js';
import { registerCorrelationId } from './correlation-id.js';
import { registerErrorEnvelope } from './errors.js';
import { registerRoutes } from './routes/index.js';
import { createRouteTable, type RouteTableEntry } from './route-table.js';

declare module 'fastify' {
  interface FastifyInstance {
    jobQueue: JobQueue;
  }
}

export interface BuiltServer {
  app: FastifyInstance;
  /** Every route Fastify registered, with its declared policy (or `undefined`). */
  routeTable: readonly RouteTableEntry[];
}

export interface BuildServerOptions {
  /**
   * `true` for the default logger, `false` for none, or a Fastify logger option
   * object.
   *
   * The object form exists because SPEC-01 §7.1 T-04 requires a forged context
   * declaration to be "logged as a security event", and the only honest way to
   * assert that is to read the log the server actually wrote. The harness passes
   * a stream it can inspect; production passes `true`.
   */
  readonly logger?: FastifyServerOptions['logger'];
  /**
   * The tenancy runtime: the unit-of-work runner and the principal resolver.
   *
   * **Optional, and its absence is not permissive.** `scripts/gates/route-policy-check.mjs`
   * boots the server to enumerate routes and has no database; with no runtime,
   * every `capability` route answers `503` and no tenant table is touched. A
   * server that cannot verify context serves nothing that needs context.
   */
  readonly tenancy?: TenancyRuntime;
  readonly jobQueue?: JobQueue;
}

/**
 * Builds the server.
 *
 * Registration order is load-bearing: the correlation id must exist before
 * anything logs, and the SPEC-01 §2.3 context middleware must run before every
 * handler — as a global hook, so a new route is covered by default rather than
 * when somebody remembers to opt in.
 *
 * Both properties are asserted by
 * `apps/api/test/http/context-surface.test.ts`, describe block "the middleware
 * cannot be skipped": every capability route answers 401/400 before its handler
 * can run, and every response carries a correlation id.
 */
export async function buildServer(options: BuildServerOptions = {}): Promise<BuiltServer> {
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
  app.decorate('jobQueue', options.jobQueue ?? new InMemoryJobQueue());
  registerContextMiddleware(app, options.tenancy);
  await registerRoutes(app);
  await app.ready();

  return { app, routeTable: entries };
}
