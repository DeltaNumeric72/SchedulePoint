import { buildServer } from './http/server.js';
import { undeclaredRoutes } from './http/route-table.js';

/**
 * Process entry point.
 *
 * The undeclared-route assertion runs at boot as well as in CI. CI catches it
 * before merge; the boot check means a route that somehow reaches a running
 * process still fails closed rather than serving unauthorized traffic (I-02).
 */
async function main(): Promise<void> {
  const { app, routeTable } = await buildServer({ logger: true });

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
