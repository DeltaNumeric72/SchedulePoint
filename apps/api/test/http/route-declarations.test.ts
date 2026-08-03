import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SYSTEM_GROUP_ROLES, SYSTEM_ROLE_CAPABILITIES, capabilityDefinition } from '@schedulepoint/domain';

import { GROUP_ROLES, ORGANIZATION_ROLES, overlappingRoleKeys } from '../../src/http/authorization/roles.js';
import { capabilityRouteConfig, routeActionProblems } from '../../src/http/policy.js';
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

/** Every `.ts` file under a directory, recursively. */
function walkTypeScript(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walkTypeScript(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

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

  it('every CAPABILITY route declares an action scope and a catalogued action (A-14, A-16)', () => {
    // Read from the config object the route was REGISTERED with, via the
    // `onRoute` hook — not from a copy, and not from a re-derived shape. An
    // earlier version of this test rebuilt `{ policy }` and threw the rest away,
    // so the scope declaration it claimed to check was never looked at.
    const capabilityRoutes = routeTable.filter(
      (entry) => entry.method !== 'HEAD' && entry.policy?.kind === 'capability',
    );
    expect(capabilityRoutes.length, 'no capability routes are registered').toBeGreaterThan(0);

    const problems = capabilityRoutes.flatMap((entry) => routeActionProblems(entry));
    expect(problems, 'SPEC-06 A-14 / A-16').toEqual([]);

    for (const entry of capabilityRoutes) {
      const narrowed = capabilityRouteConfig(entry.config);
      expect(narrowed, `${entry.method} ${entry.url}`).toBeDefined();
      if (narrowed === undefined) continue;

      // SPEC-01 §2.1 (V-06): the scope is one of exactly two values, declared.
      expect(['group', 'organization']).toContain(narrowed.actionScope);

      const definition = capabilityDefinition(narrowed.action.key);
      expect(definition, `${entry.url} names an uncatalogued capability`).toBeDefined();

      log(
        `${entry.method} ${entry.url}: ${narrowed.actionScope}-scoped, ${narrowed.policy.capability}, ` +
          `action=${narrowed.action.key}, module=${narrowed.action.moduleKey}, ` +
          `objectPolicy=${String(narrowed.action.requiresObjectPolicy)}`,
      );
    }
  });

  it('the role namespaces are still disjoint, and every shipped role is catalogued (P-10)', () => {
    expect(overlappingRoleKeys()).toEqual([]);
    // The role KEYS the HTTP layer knows and the role keys the catalogue's
    // system-role map seeds must be the same set. They are written in two
    // places — `src/http/authorization/roles.ts` and the domain's
    // `SYSTEM_ROLE_CAPABILITIES` — and a role that exists in one and not the
    // other is a role that either grants nothing or cannot be assigned.
    expect([...GROUP_ROLES].sort()).toEqual([...SYSTEM_GROUP_ROLES].sort());
    for (const role of ORGANIZATION_ROLES) {
      expect(Object.keys(SYSTEM_ROLE_CAPABILITIES)).toContain(role);
    }
    for (const [role, capabilities] of Object.entries(SYSTEM_ROLE_CAPABILITIES)) {
      const scope = (GROUP_ROLES as readonly string[]).includes(role) ? 'group' : 'organization';
      for (const key of capabilities) {
        expect(capabilityDefinition(key)?.scope, `${role} -> ${key}`).toBe(scope);
      }
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

  it('a capability config missing its scope or action is NOT accepted by the narrowing function', () => {
    // The middleware refuses to serve such a route. This is the unit-level proof
    // that the narrowing it depends on rejects the malformed shape rather than
    // defaulting it to something plausible.
    const wellFormedAction = {
      key: 'membership.touch_self',
      moduleKey: 'core_scheduling',
      requiresObjectPolicy: false,
    };
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
        action: wellFormedAction,
      }),
    ).toBeUndefined();
    expect(
      capabilityRouteConfig({
        policy: { kind: 'capability', capability: 'CAP-003' },
        actionScope: 'group',
        action: { key: '', moduleKey: 'core_scheduling', requiresObjectPolicy: false },
      }),
    ).toBeUndefined();
    expect(
      capabilityRouteConfig({
        policy: { kind: 'capability', capability: 'CAP-003' },
        actionScope: 'group',
        action: wellFormedAction,
      }),
    ).toBeDefined();
  });
});

describe('the new build-failing check: a policy naming an unknown capability', () => {
  // The packet's red case. `scripts/gates/route-policy-check.mjs` fails the build
  // for a route with no policy; it cannot know whether the capability a route
  // names exists. `routeActionProblems` closes that, and the `unit` gate — one of
  // the twelve in `pnpm check` — is what makes it build-failing.
  const base = {
    method: 'POST',
    url: '/organizations/:organizationId/example',
  };

  it('accepts a well-formed, catalogued declaration', () => {
    expect(
      routeActionProblems({
        ...base,
        config: {
          policy: { kind: 'capability', capability: 'CAP-006' },
          actionScope: 'organization',
          action: {
            key: 'organization.membership.administer',
            moduleKey: 'organization_administration',
            requiresObjectPolicy: false,
          },
        },
      }),
    ).toEqual([]);
  });

  it('REJECTS an action key that is not in the catalogue', () => {
    const problems = routeActionProblems({
      ...base,
      config: {
        policy: { kind: 'capability', capability: 'CAP-006' },
        actionScope: 'organization',
        action: {
          key: 'organization.invented.capability',
          moduleKey: 'organization_administration',
          requiresObjectPolicy: false,
        },
      },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('not in the capability catalogue');
  });

  it('REJECTS a route whose declared scope disagrees with the catalogue (A-16)', () => {
    const problems = routeActionProblems({
      ...base,
      config: {
        policy: { kind: 'capability', capability: 'CAP-006' },
        // `membership.touch_self` is group-scoped in the catalogue.
        actionScope: 'organization',
        action: {
          key: 'membership.touch_self',
          moduleKey: 'core_scheduling',
          requiresObjectPolicy: false,
        },
      },
    });
    expect(problems.join(' ')).toContain('P-10 / A-16');
  });

  it('REJECTS a route naming the wrong module for its capability', () => {
    const problems = routeActionProblems({
      ...base,
      config: {
        policy: { kind: 'capability', capability: 'CAP-006' },
        actionScope: 'group',
        action: {
          key: 'membership.touch_self',
          moduleKey: 'picklist',
          requiresObjectPolicy: false,
        },
      },
    });
    expect(problems.join(' ')).toContain('belongs to module core_scheduling');
  });

  it('REJECTS an ownership override naming an uncatalogued capability', () => {
    const problems = routeActionProblems({
      ...base,
      config: {
        policy: { kind: 'capability', capability: 'CAP-006' },
        actionScope: 'group',
        action: {
          key: 'membership.touch_self',
          moduleKey: 'core_scheduling',
          requiresObjectPolicy: true,
          ownershipRequired: true,
          ownershipOverrideCapability: 'not.a.capability',
        },
      },
    });
    expect(problems.join(' ')).toContain('ownership override');
  });

  it('says nothing about a public or internal route', () => {
    expect(
      routeActionProblems({ ...base, config: { policy: { kind: 'public', reason: 'liveness' } } }),
    ).toEqual([]);
  });
});

describe('OPUS-M1-004 — there is no second authorization path left', () => {
  // OPUS-M1-002 could not delete `provisionallyAuthorized`: `apps/api/src/jobs/
  // worker.ts` was OPUS-M1-003's parallel file scope and still called it, so the
  // job surface authorized on a role allow-list while HTTP authorized on the
  // SPEC-06 truth table. FAD-13 item 1 closed that, and this replaces the tests
  // that covered the deny-by-default behaviour of the deleted mechanism.
  //
  // A deleted mechanism needs a test too, for the same reason the old one did: a
  // second evaluator that quietly reappears is exactly the defect SPEC-06 §7
  // names, and it will reappear looking like a small convenience.
  it('`provisionallyAuthorized` is exported by nothing and called by nobody', async () => {
    const policy: Record<string, unknown> = await import('../../src/http/policy.js');
    expect(Object.keys(policy)).not.toContain('provisionallyAuthorized');
    expect(Object.keys(policy)).not.toContain('ProvisionalJobPolicy');

    const src = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');
    const offenders = walkTypeScript(src).filter((file) =>
      /\bprovisional(?:ly)?[A-Za-z]*\s*\(/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders, offenders.join('\n')).toEqual([]);
    log('the provisional role allow-list is gone from src/ entirely');
  });

  it('every registered capability route declares a catalogue action, not a role list', () => {
    const capabilityRoutes = routeTable.filter((entry) => entry.policy?.kind === 'capability');
    expect(capabilityRoutes.length).toBeGreaterThan(0);
    for (const entry of capabilityRoutes) {
      const narrowed = capabilityRouteConfig(entry.config);
      expect(narrowed, `${entry.method} ${entry.url} has no well-formed action`).toBeDefined();
      expect(
        (entry.config as { provisional?: unknown }).provisional,
        `${entry.method} ${entry.url} still carries a provisional allow-list`,
      ).toBeUndefined();
    }
  });

  it('P-10: the two role namespaces do not overlap', () => {
    expect(overlappingRoleKeys()).toEqual([]);
  });
});
