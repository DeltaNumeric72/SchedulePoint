import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GROUP_ROLES, ORGANIZATION_ROLES, overlappingRoleKeys } from '../../src/http/authorization/roles.js';
import { capabilityRouteConfig, provisionallyAuthorized } from '../../src/http/policy.js';
import { undeclaredRoutes, type RouteTableEntry } from '../../src/http/route-table.js';
import { buildServer } from '../../src/http/server.js';
import { discoverRouteFiles } from '../../src/http/routes/index.js';
import { log } from '../support/harness.js';

/**
 * Every route's declaration, checked against the *registered* table.
 *
 * `scripts/gates/route-policy-check.mjs` already fails the build for a route
 * with no `config.policy`. SPEC-01 §2.1 (V-06) adds a second obligation the gate
 * does not know about — **every route declares its scope** — and SPEC-06 §1.1
 * makes the organization-scoped set closed. This asserts the second half, and it
 * asserts it against what Fastify actually registered rather than against a
 * hand-maintained list.
 */

let app: FastifyInstance;
let routeTable: readonly RouteTableEntry[];

beforeAll(async () => {
  ({ app, routeTable } = await buildServer());
});

afterAll(async () => {
  await app.close();
});

describe('route declarations', () => {
  it('registers more than the scaffold\'s single route', () => {
    // A vacuous pass is the failure mode these assertions guard against.
    expect(discoverRouteFiles().length).toBeGreaterThan(1);
    expect(routeTable.filter((entry) => entry.method !== 'HEAD').length).toBeGreaterThan(1);
    log(
      routeTable
        .filter((entry) => entry.method !== 'HEAD')
        .map((entry) => `${entry.method} ${entry.url} -> ${entry.policy?.kind ?? 'NONE'}`)
        .join('\n        '),
    );
  });

  it('no route is registered without a policy (I-02)', () => {
    expect(undeclaredRoutes(routeTable)).toEqual([]);
  });

  it('every CAPABILITY route declares an action scope and a provisional authorization', () => {
    // Read from the config object the route was REGISTERED with, via the
    // `onRoute` hook — not from a copy, and not from a re-derived shape. An
    // earlier version of this test rebuilt `{ policy }` and threw the rest away,
    // so the scope declaration it claimed to check was never looked at.
    const capabilityRoutes = routeTable.filter(
      (entry) => entry.method !== 'HEAD' && entry.policy?.kind === 'capability',
    );
    expect(capabilityRoutes.length, 'no capability routes are registered').toBeGreaterThan(0);

    for (const entry of capabilityRoutes) {
      const narrowed = capabilityRouteConfig(entry.config);
      expect(
        narrowed,
        `${entry.method} ${entry.url} declares a capability but no well-formed actionScope/provisional`,
      ).toBeDefined();
      if (narrowed === undefined) continue;

      // SPEC-01 §2.1 (V-06): the scope is one of exactly two values, declared.
      expect(['group', 'organization']).toContain(narrowed.actionScope);

      // SPEC-06 §1.1's organization-scoped set is CLOSED, and everything not in
      // it is group-scoped. A route may not invent a third answer.
      expect(narrowed.provisional.allowRoles.length, `${entry.url} allows no role at all`).toBeGreaterThan(0);
      expect(
        narrowed.provisional.rationale.length,
        `${entry.url} has no recorded rationale for its allow-list`,
      ).toBeGreaterThan(30);

      // P-10: the allow-list must name roles from the matching namespace only.
      const expectedNamespace: readonly string[] =
        narrowed.actionScope === 'group' ? GROUP_ROLES : ORGANIZATION_ROLES;
      for (const role of narrowed.provisional.allowRoles) {
        expect(
          expectedNamespace,
          `${entry.url} (${narrowed.actionScope}-scoped) lists the out-of-namespace role \`${role}\``,
        ).toContain(role);
      }

      log(
        `${entry.method} ${entry.url}: ${narrowed.actionScope}-scoped, ${narrowed.policy.capability}, roles=[${narrowed.provisional.allowRoles.join(', ')}]`,
      );
    }
  });

  it('the registered config is really carried through — the assertion above is not vacuous', () => {
    // If `config` were dropped by the route table again, `capabilityRouteConfig`
    // would return undefined for every route and the loop above would fail —
    // but only if there IS a capability route to loop over. This pins that.
    const withConfig = routeTable.filter((entry) => entry.config !== undefined);
    expect(withConfig.length).toBe(routeTable.length);
    const health = routeTable.find((entry) => entry.url === '/health' && entry.method === 'GET');
    expect((health?.config as { policy?: { kind?: string } } | undefined)?.policy?.kind).toBe(
      'public',
    );
  });

  it('a capability config missing its scope is NOT accepted by the narrowing function', () => {
    // The middleware refuses to serve such a route. This is the unit-level proof
    // that the narrowing it depends on rejects the malformed shape rather than
    // defaulting it to something plausible.
    expect(
      capabilityRouteConfig({ policy: { kind: 'capability', capability: 'CAP-003' } }),
    ).toBeUndefined();
    expect(
      capabilityRouteConfig({
        policy: { kind: 'capability', capability: 'CAP-003' },
        actionScope: 'group',
      }),
    ).toBeUndefined();
    expect(
      capabilityRouteConfig({
        policy: { kind: 'capability', capability: 'CAP-003' },
        actionScope: 'tenant',
        provisional: { allowRoles: [], rationale: 'x' },
      }),
    ).toBeUndefined();
    expect(
      capabilityRouteConfig({
        policy: { kind: 'capability', capability: 'CAP-003' },
        actionScope: 'group',
        provisional: { allowRoles: ['scheduler'], rationale: 'x' },
      }),
    ).toBeDefined();
  });
});

describe('the provisional evaluator is deny-by-default', () => {
  const groupRoute = {
    policy: { kind: 'capability', capability: 'CAP-003' },
    actionScope: 'group',
    provisional: { allowRoles: ['scheduler'], rationale: 'test' },
  } as const;

  it('an empty allow-list denies every role', () => {
    const closed = { ...groupRoute, provisional: { allowRoles: [], rationale: 'test' } };
    for (const role of GROUP_ROLES) {
      expect(provisionallyAuthorized(closed, { kind: 'group', role })).toBe(false);
    }
  });

  it('a null role is denied', () => {
    expect(provisionallyAuthorized(groupRoute, { kind: 'group', role: null })).toBe(false);
  });

  it('P-8: an organization membership never satisfies a group-scoped route', () => {
    for (const role of ORGANIZATION_ROLES) {
      expect(provisionallyAuthorized(groupRoute, { kind: 'organization', role })).toBe(false);
    }
    // Even if the organization role's key were somehow listed.
    const misconfigured = {
      ...groupRoute,
      provisional: { allowRoles: [...ORGANIZATION_ROLES], rationale: 'test' },
    };
    expect(provisionallyAuthorized(misconfigured, { kind: 'organization', role: 'org_admin' })).toBe(
      false,
    );
  });

  it('P-9: a group membership never satisfies an organization-scoped route', () => {
    const organizationRoute = {
      policy: { kind: 'capability', capability: 'CAP-003' },
      actionScope: 'organization',
      provisional: { allowRoles: ['org_admin', 'scheduler'], rationale: 'test' },
    } as const;
    expect(provisionallyAuthorized(organizationRoute, { kind: 'group', role: 'scheduler' })).toBe(
      false,
    );
    expect(provisionallyAuthorized(organizationRoute, { kind: 'organization', role: 'org_admin' })).toBe(
      true,
    );
  });

  it('P-10: the two role namespaces do not overlap', () => {
    expect(overlappingRoleKeys()).toEqual([]);
  });

  it('only an exactly-listed role is allowed — there is no wildcard', () => {
    expect(provisionallyAuthorized(groupRoute, { kind: 'group', role: 'scheduler' })).toBe(true);
    for (const role of ['*', 'SCHEDULER', 'scheduler ', 'group_admin', 'member']) {
      expect(provisionallyAuthorized(groupRoute, { kind: 'group', role })).toBe(false);
    }
  });
});
