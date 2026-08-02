import Fastify from 'fastify';

import { registerCorrelationId } from '../../../src/http/correlation-id.js';
import { createRouteTable } from '../../../src/http/route-table.js';
import { registerRoutes } from '../../../src/http/routes/index.js';

/**
 * A RED-CASE entry point: the real routes, plus one **genuinely registered**
 * route that declares no `config.policy`.
 *
 * `scripts/gates/route-policy-check.mjs --entry <this file>` must fail on it.
 *
 * The rogue route is registered for real — through `app.post`, observed by the
 * same `onRoute` hook the production server uses — rather than appended to the
 * table afterwards. Appending would only prove that the gate's array filter
 * works; registering proves that a route which skips the project's own helpers
 * is still seen, which is the property the hook exists for.
 *
 * It is a separate entry point rather than a file dropped into
 * `src/http/routes/` because route discovery is directory-based: a fixture there
 * would be registered by the real server too, and a deliberately unprotected
 * route must never be reachable outside the check that needs it.
 *
 * Not a `*.test.ts`, so vitest does not collect it. It is executed by
 * `gates-fail-on-violations.test.ts`, through the gate, in a child process.
 */
const app = Fastify({ logger: false, genReqId: () => '' });

const { entries, plugin } = createRouteTable();
plugin(app);
registerCorrelationId(app);
await registerRoutes(app);

// The violation: a registered route with no policy declaration at all.
app.post('/red-case/undeclared', async () => ({ ok: true }));

await app.ready();
await app.close();

process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
