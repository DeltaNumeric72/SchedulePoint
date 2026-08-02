import { ProcessAlertSink } from './db/alerts.js';
import { createPool } from './db/pool.js';
import { assertTransactionAffinity } from './db/pooler-assertion.js';
import { PgUnitOfWorkRunner } from './db/unit-of-work.js';
import { denyAllPrincipalResolver } from './http/context/principal.js';
import { undeclaredRoutes } from './http/route-table.js';
import { buildServer } from './http/server.js';

/**
 * Process entry point.
 *
 * Three things happen before the socket opens, and each of them refuses to serve
 * traffic rather than degrade:
 *
 *  1. **The pooler-mode assertion** (SPEC-01 §4 amendment (c)). The
 *     per-transaction read-back is a detector, not a proof, against
 *     statement-level routing — the load-bearing control is configuration. A
 *     process that cannot demonstrate transaction affinity has no basis for any
 *     tenant guarantee it would otherwise make, so it exits.
 *
 *  2. **The undeclared-route assertion** (I-02). CI catches this before merge;
 *     the boot check means a route that somehow reaches a running process still
 *     fails closed rather than serving unauthorized traffic.
 *
 *  3. **The principal resolver is `denyAllPrincipalResolver`.** Authentication
 *     lands in a later packet, and until it does this server serves no
 *     authenticated traffic at all rather than inventing a principal.
 */
async function main(): Promise<void> {
  const alerts = new ProcessAlertSink();
  const pool = createPool('app_runtime');

  const probe = await assertTransactionAffinity(pool);
  process.stdout.write(
    `pooler-mode assertion passed: one backend (${String(probe.firstBackendPid)}) for the ` +
      'whole transaction, transaction-local setting survived within it and expired after it\n',
  );

  const runtime = new PgUnitOfWorkRunner({ role: 'app_runtime', pool, alerts });

  const { app, routeTable } = await buildServer({
    logger: true,
    tenancy: { runtime, principals: denyAllPrincipalResolver },
  });

  const undeclared = undeclaredRoutes(routeTable);
  if (undeclared.length > 0) {
    for (const route of undeclared) {
      app.log.fatal({ route }, 'route registered without a policy declaration');
    }
    throw new Error(`${String(undeclared.length)} route(s) registered without a policy`);
  }

  const port = Number.parseInt(process.env['PORT'] ?? '3001', 10);
  const host = process.env['HOST'] ?? '127.0.0.1';
  await app.listen({ port, host });
}

await main();
