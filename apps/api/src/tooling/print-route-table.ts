import { buildServer } from '../http/server.js';

/**
 * Emits the registered route table as JSON on stdout, for
 * `scripts/gates/route-policy-check.ts`.
 *
 * The gate runs this in a child process rather than importing the server
 * in-process so that a route file with a top-level side effect cannot influence
 * the checker.
 */
const { app, routeTable } = await buildServer({ logger: false });
await app.close();

process.stdout.write(`${JSON.stringify(routeTable, null, 2)}\n`);
