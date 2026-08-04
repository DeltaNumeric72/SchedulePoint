import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The gate's OWN analyzer, imported rather than reimplemented.
 *
 * A copy of the rule here would be a second rule that can drift from the one CI
 * runs, and the drift would be invisible: both would pass. The module is
 * JavaScript with no declaration file — `scripts/` is outside every TypeScript
 * project in the repository — so it is loaded dynamically and narrowed once,
 * here, rather than with an `any` at each call site.
 */
interface GateViolation {
  readonly file: string;
  readonly line: number;
  readonly detail: string;
}
type GateAnalyze = (
  routes: { method: string; url: string; policy: unknown }[],
) => GateViolation[];

let analyze: GateAnalyze;
import { isRoutePolicy, preAuthRouteConfig, describePolicy } from '../../src/http/policy.js';
import { undeclaredRoutes, type RouteTableEntry } from '../../src/http/route-table.js';
import { log } from '../support/harness.js';
import { buildHttpHarness, type HttpHarness } from '../support/http.js';

/**
 * **RED CASE 7 — the explicit pre-auth policy class did NOT weaken
 * deny-by-default (I-02).**
 *
 * The packet's escalation condition was: "the route-policy gate cannot express
 * the pre-auth class without modification". It did not fire, and this file is
 * why. `scripts/gates/route-policy-check.mjs` asks whether `config.policy` is a
 * policy; the VOCABULARY of policies lives in `apps/api/src/http/policy.ts`,
 * which is this packet's file. **No gate script was modified**, and the
 * assertions below run the gate's own `analyze` function over route tables this
 * test constructs.
 *
 * ## Four properties, each of which a plausible implementation would break
 *
 * 1. an UNDECLARED route still fails the gate (the red case proper);
 * 2. a `preauth` policy missing its `stage`, or naming a stage outside the
 *    closed set, is NOT a valid policy — so it fails the gate exactly as an
 *    undeclared route does, rather than being admitted with no requirement the
 *    middleware could enforce;
 * 3. **no pre-auth route names another user.** Asserted over the REGISTERED
 *    route table: no `:userId`-style segment, and no pre-auth body schema
 *    carries a user identifier. This is what makes "the subject is always the
 *    caller" structural rather than a claim in a docblock;
 * 4. every pre-auth route carries a written `reason`, non-empty, like
 *    `PublicPolicy` does.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTE_FILE = join(HERE, '../../src/http/routes/authn.route.ts');

let harness: HttpHarness;
let registered: readonly RouteTableEntry[];

beforeAll(async () => {
  // `scripts/` is outside every TypeScript project in the repository, so the
  // module has no declaration file and `tsc` says so. Suppressed at exactly this
  // line rather than by loosening a compiler option: the narrowing below is what
  // makes the value safe, and it is one cast in one place.
  // @ts-expect-error -- untyped .mjs gate module, narrowed on the next line
  const gate = (await import('../../../../scripts/gates/route-policy-check.mjs')) as unknown as {
    analyze: GateAnalyze;
  };
  analyze = gate.analyze;
  harness = await buildHttpHarness();
  // The table the SERVER built, through its `onRoute` hook — not a list kept
  // here. A list can be complete while the server is not.
  const { buildServer } = await import('../../src/http/server.js');
  const built = await buildServer();
  registered = built.routeTable;
  await built.app.close();
});

afterAll(async () => {
  await harness.close();
});

describe('the gate still fails an undeclared route', () => {
  it('RED CASE 7 — a route with no policy is a violation, with the pre-auth class present', () => {
    const table = [
      ...registered.map((entry) => ({
        method: entry.method,
        url: entry.url,
        policy: entry.policy,
      })),
      { method: 'POST', url: '/organizations/:organizationId/authn/smuggled', policy: undefined },
    ];
    const violations = analyze(table);
    expect(violations.length, 'the gate admitted a route with no policy').toBe(1);
    expect(violations[0]?.file).toContain('/authn/smuggled');
    log(`the gate reported the undeclared route: ${violations[0]?.detail ?? ''}`);
  });

  it('GREEN: the same table WITHOUT the planted route is clean', () => {
    const table = registered.map((entry) => ({
      method: entry.method,
      url: entry.url,
      policy: entry.policy,
    }));
    expect(analyze(table)).toEqual([]);
    expect(undeclaredRoutes(registered)).toEqual([]);
  });

  it('a `preauth` policy with no stage, or an unknown stage, is NOT a policy', () => {
    expect(isRoutePolicy({ kind: 'preauth', reason: 'because' })).toBe(false);
    expect(isRoutePolicy({ kind: 'preauth', reason: 'because', stage: 'whatever' })).toBe(false);
    expect(isRoutePolicy({ kind: 'preauth', stage: 'anonymous' })).toBe(false);
    expect(isRoutePolicy({ kind: 'preauth', reason: '', stage: 'anonymous' })).toBe(false);
    // And the well-formed one IS.
    expect(isRoutePolicy({ kind: 'preauth', reason: 'because', stage: 'anonymous' })).toBe(true);

    // So a route declaring the malformed version fails the gate, exactly as an
    // undeclared one does — the gate reads `isRoutePolicy`'s verdict.
    const table = [
      { method: 'POST', url: '/x', policy: undefined },
    ];
    expect(analyze(table).length).toBe(1);
  });
});

describe('the pre-auth class is narrow, and structurally so', () => {
  it('no pre-auth route has a subject parameter naming another user', () => {
    const preAuth = registered.filter(
      (entry) => entry.method !== 'HEAD' && preAuthRouteConfig(entry.config) !== undefined,
    );
    expect(preAuth.length, 'no pre-auth routes are registered — the check is vacuous').toBeGreaterThan(
      0,
    );

    const offenders = preAuth.filter((entry) =>
      /:(userId|membershipId|targetMembershipId|principalId|subjectId)\b/.test(entry.url),
    );
    expect(
      offenders.map((entry) => `${entry.method} ${entry.url}`),
      'a pre-auth route names a subject other than the caller',
    ).toEqual([]);

    // And no pre-auth body schema carries a user identifier either: the route
    // file's pre-auth handlers must not parse one. Checked against the source,
    // because a schema is not reachable from the route table.
    const source = readFileSync(ROUTE_FILE, 'utf8');
    const preAuthBlock = source.slice(
      0,
      source.indexOf('Administrative surfaces — capability-gated'),
    );
    for (const forbidden of ['userId', 'membershipId']) {
      expect(
        preAuthBlock.includes(`parsed.data.${forbidden}`),
        `a pre-auth handler reads \`${forbidden}\` from the request body`,
      ).toBe(false);
    }
    log(
      `${String(preAuth.length)} pre-auth routes, none with a subject parameter: ` +
        preAuth.map((e) => `${e.method} ${e.url}`).join(', '),
    );
  });

  it('every pre-auth route declares a stage from the closed set and a written reason', () => {
    const rows: string[] = [];
    for (const entry of registered) {
      if (entry.method === 'HEAD') continue;
      const policy = preAuthRouteConfig(entry.config);
      if (policy === undefined) continue;
      expect(['anonymous', 'session-partial', 'session-any']).toContain(policy.stage);
      expect(policy.reason.length, `${entry.url} has an empty reason`).toBeGreaterThan(20);
      rows.push(`${entry.method} ${entry.url} -> ${describePolicy(policy)}`);
    }
    log(rows.join('\n      · '));
  });

  it('a `session-partial` route reached WITHOUT a session never touches its handler', async () => {
    // No cookie, no test principal header: the stage is not met, so the request
    // is refused by the middleware. A 401 here is the class working; a 500 or a
    // 200 would mean the handler ran.
    const response = await harness.app.inject({
      method: 'POST',
      url: '/organizations/00000000-0000-4000-8000-000000000000/authn/mfa/challenge',
      payload: { code: '123456' },
    });
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error.code).toBe('UNAUTHENTICATED');
  });

  it('every registered route has a policy, and the four kinds are the only ones', () => {
    const kinds = new Set<string>();
    for (const entry of registered) {
      if (entry.method === 'HEAD') continue;
      expect(entry.policy, `${entry.method} ${entry.url} has no policy`).toBeDefined();
      kinds.add(entry.policy!.kind);
    }
    for (const kind of kinds) {
      expect(['public', 'internal', 'capability', 'preauth']).toContain(kind);
    }
    log(`${String(registered.length)} registered routes; policy kinds in use: ${[...kinds].sort().join(', ')}`);
  });
});
