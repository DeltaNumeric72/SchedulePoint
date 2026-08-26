import { capabilityDefinition } from '@schedulepoint/domain';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { capabilityRouteConfig, routeActionProblems } from '../../src/http/policy.js';
import type { RouteTableEntry } from '../../src/http/route-table.js';
import { buildServer } from '../../src/http/server.js';

/**
 * The request surface's POLICY declarations — SPEC-08 §4, SPEC-06, I-02
 * (OPUS-M5-001, doc 42 §5c Part D).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## Why this file exists beside `test/http/route-declarations.test.ts`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * That file asserts the GENERAL obligations over every route Fastify registers:
 * a policy exists, a scope is declared, the action key is in the catalogue, the
 * scope and module agree with it. Those apply to this surface automatically and
 * are not restated here.
 *
 * This file asserts what is SPECIFIC to the request surface, and specifically the
 * one thing SPEC-08 §4 states as a rule and this codebase enforces as a **config
 * field**:
 *
 * > **Withdraw** — **Requester-initiated only.** An administrator "withdrawing"
 * > for someone is a **denial with a reason**, recorded as such.
 *
 * The mechanism is `ownershipRequired: true` with **no**
 * `ownershipOverrideCapability`. An ownership override on the withdrawal route
 * would be precisely the confusion §4 forbids, spelled as one added line — and
 * nothing else in the build would object, because an override is a perfectly
 * valid field that other routes legitimately use. **A rule enforced by the
 * ABSENCE of a field needs a test that asserts the absence**, or the field can
 * be added back by anybody who thinks it looks like an oversight.
 *
 * ## No cluster
 *
 * `buildServer()` registers the route table without touching a database, so this
 * runs in milliseconds. The policy declaration is a static property of the
 * surface, and proving it does not need a tenant.
 */

const BASE = '/organizations/:organizationId/groups/:groupId/requests';

/** The four routes this packet ships, and what each one's declaration must be. */
const EXPECTED = [
  { method: 'POST', url: BASE, key: 'requests.own.submit' },
  { method: 'POST', url: `${BASE}/:requestId/withdraw`, key: 'requests.own.withdraw' },
  { method: 'GET', url: `${BASE}/mine`, key: 'requests.own.read' },
  { method: 'GET', url: `${BASE}/deadline`, key: 'requests.own.read' },
] as const;

let app: FastifyInstance;
let routeTable: readonly RouteTableEntry[];

/** The registered entry for a method/url pair, or `undefined`. */
function entryFor(method: string, url: string): RouteTableEntry | undefined {
  return routeTable.find((entry) => entry.method === method && entry.url === url);
}

/** Every registered route on the request surface, HEAD excluded. */
function requestRoutes(): readonly RouteTableEntry[] {
  return routeTable.filter((entry) => entry.method !== 'HEAD' && entry.url.startsWith(BASE));
}

beforeAll(async () => {
  ({ app, routeTable } = await buildServer());
});

afterAll(async () => {
  await app.close();
});

describe('the request surface registers exactly the four routes this packet ships', () => {
  it('each expected route is REGISTERED, with the expected action key', () => {
    for (const expected of EXPECTED) {
      const entry = entryFor(expected.method, expected.url);
      expect(entry, `${expected.method} ${expected.url} is not registered`).toBeDefined();
      const config = capabilityRouteConfig(entry?.config);
      expect(config, `${expected.method} ${expected.url} has no capability config`).toBeDefined();
      expect(config?.action.key).toBe(expected.key);
    }
  });

  it('and registers NO OTHERS — the scheduler queue is M5-002\'s, not a gap here', () => {
    /* Doc 42 §5c Part D names "scheduler read routes"; the queue was moved to
     * M5-002 as a ratified scope MOVE, because a queue's shape IS its decision
     * affordances and §4's decision verbs are M5-002's. Asserting the count is
     * what makes that a DECISION rather than something that quietly slips: an
     * added route on this surface fails here until somebody updates the list. */
    const registered = requestRoutes().map((entry) => `${entry.method} ${entry.url}`).sort();
    expect(registered).toEqual(
      EXPECTED.map((expected) => `${expected.method} ${expected.url}`).sort(),
    );
  });

  it('every one declares CAP-021, group scope, and the requests_vacation module', () => {
    for (const entry of requestRoutes()) {
      const where = `${entry.method} ${entry.url}`;
      expect(entry.policy?.kind, where).toBe('capability');
      const config = capabilityRouteConfig(entry.config);
      expect(config, where).toBeDefined();
      expect(config?.policy.capability, where).toBe('CAP-021');
      expect(config?.actionScope, where).toBe('group');
      expect(config?.action.moduleKey, where).toBe('requests_vacation');
      /* And the general obligations, run over this surface specifically, so a
       * failure here names the request route rather than appearing in a
       * repo-wide list. */
      expect(routeActionProblems(entry), where).toEqual([]);
    }
  });

  it('every action key EXISTS in the catalogue with a matching scope and module', () => {
    /* The catalogue keys and the routes landed in the same change, so this is
     * the assertion that they landed CONSISTENTLY. `routeActionProblems` checks
     * it too; this states it directly so the failure message is about the key. */
    for (const expected of EXPECTED) {
      const definition = capabilityDefinition(expected.key);
      expect(definition, `${expected.key} is not in the capability catalogue`).toBeDefined();
      expect(definition?.scope, expected.key).toBe('group');
      expect(definition?.module, expected.key).toBe('requests_vacation');
    }
  });
});

describe('SPEC-08 §4 — withdrawal is REQUESTER-INITIATED ONLY, enforced by an absence', () => {
  it('every route on this surface is self-scoped: ownershipRequired, object policy on', () => {
    for (const entry of requestRoutes()) {
      const where = `${entry.method} ${entry.url}`;
      const config = capabilityRouteConfig(entry.config);
      expect(config?.action.requiresObjectPolicy, `${where}: L5.1 must run`).toBe(true);
      expect(config?.action.ownershipRequired, `${where}: ownership must be required`).toBe(true);
    }
  });

  it('NO route on this surface carries an ownership OVERRIDE — the §4 ruling', () => {
    /* **This is the assertion that matters most in this file.** An
     * `ownershipOverrideCapability` on the withdrawal route would make
     * "withdraw somebody else's request" a power that exists, which §4 says it
     * is not: an administrator ending a request does it by DENYING with a
     * reason, which is a different operation on a different key, in M5-002.
     *
     * Nothing else in the build objects to an override — it is a valid field
     * that `schedule.own_published.read`'s neighbours legitimately use — so the
     * absence is only a rule while something asserts it. */
    for (const entry of requestRoutes()) {
      const config = capabilityRouteConfig(entry.config);
      expect(
        config?.action.ownershipOverrideCapability,
        `${entry.method} ${entry.url} must NOT lift its ownership requirement`,
      ).toBeUndefined();
    }
  });

  it('no route on this surface names another PERSON in its path', () => {
    /* The structural half, asserted over the REGISTERED table rather than over a
     * list: there is no `:membershipId`, no `:userId` and no subject parameter of
     * any kind, so there is no request that could act on somebody else's
     * behalf even if a policy declaration were disarmed. The one path parameter
     * beyond the tenant pair is `:requestId`, which names a REQUEST — and the
     * narrowed RLS policy makes another member's request invisible, so it
     * resolves to a 404 rather than to somebody else's row.
     *
     * The same assertion the pre-auth class makes about its own surface, for the
     * same reason. */
    const tenantParameters = new Set([':organizationId', ':groupId', ':requestId']);
    for (const entry of requestRoutes()) {
      const parameters = entry.url.split('/').filter((segment) => segment.startsWith(':'));
      for (const parameter of parameters) {
        expect(
          tenantParameters.has(parameter),
          `${entry.method} ${entry.url} names ${parameter} — a subject parameter on a self-scoped surface`,
        ).toBe(true);
      }
    }
  });
});

describe('I-02 — deny-by-default holds over this surface', () => {
  it('no route on this surface is public, internal, or pre-auth', () => {
    /* A request surface reachable without a tenant would be a request surface
     * whose rows RLS cannot scope. Every one of the four is a capability route,
     * and the three other policy kinds are asserted absent rather than assumed
     * absent. */
    for (const entry of requestRoutes()) {
      expect(entry.policy?.kind, `${entry.method} ${entry.url}`).toBe('capability');
    }
  });

  it('and the surface is NON-EMPTY, so the assertions above are not vacuous', () => {
    expect(requestRoutes().length).toBe(EXPECTED.length);
    expect(requestRoutes().length).toBeGreaterThan(0);
  });
});
