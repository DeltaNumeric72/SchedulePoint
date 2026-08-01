import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { REPO_ROOT, parseArgs, report } from './lib/gate.mjs';

/**
 * Route-without-policy check — I-02, SPEC-06.
 *
 * "Every route declares its required capability. An undeclared route fails the
 * build."
 *
 * The check enumerates the routes Fastify **actually registered** — it boots the
 * server in a child process and reads the table built by the `onRoute` hook —
 * rather than reading a list someone maintains by hand. A hand-maintained list
 * can be complete while the server is not; `onRoute` fires for every route
 * however it was registered, including from inside a plugin, so a route that
 * skips the project's own helpers is still seen.
 *
 * A child process rather than an in-process import: a route file with a
 * top-level side effect must not be able to influence the checker.
 */

/**
 * @typedef {{ method: string, url: string, policy: unknown }} RouteRow
 * @typedef {{ file: string, line: number, detail: string }} Violation
 */

/**
 * @param {RouteRow[]} routes
 * @returns {Violation[]}
 */
export function analyze(routes) {
  /** @type {Violation[]} */
  const violations = [];

  if (routes.length === 0) {
    violations.push({
      file: 'apps/api',
      line: 0,
      detail:
        'the server registered zero routes — the check would pass vacuously, which is treated as a failure',
    });
    return violations;
  }

  for (const route of routes) {
    // HEAD is synthesised by Fastify from every GET and inherits its config; it
    // is not an independently declarable surface.
    if (route.method === 'HEAD') continue;
    if (route.policy === null || route.policy === undefined) {
      violations.push({
        file: `${route.method} ${route.url}`,
        line: 0,
        detail: 'route registered without a policy declaration (config.policy)',
      });
    }
  }

  return violations;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const entry =
    typeof args['entry'] === 'string'
      ? resolve(args['entry'])
      : resolve(REPO_ROOT, 'apps/api/src/tooling/print-route-table.ts');

  const result = spawnSync(
    process.execPath,
    [resolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'), entry],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    },
  );

  if (result.status !== 0) {
    process.stdout.write(`FAIL  route-policy-check (I-02) — route enumeration failed\n`);
    process.stdout.write(result.stderr || result.stdout || '(no output)\n');
    process.exit(1);
  }

  /** @type {RouteRow[]} */
  let routes;
  try {
    routes = JSON.parse(result.stdout);
  } catch {
    process.stdout.write('FAIL  route-policy-check (I-02) — route table was not valid JSON\n');
    process.stdout.write(`${result.stdout}\n`);
    process.exit(1);
    return;
  }

  const declared = routes.filter((r) => r.method !== 'HEAD');
  process.exit(
    report(
      'route-policy-check (I-02)',
      analyze(routes),
      `${String(declared.length)} registered route(s)`,
    ),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
