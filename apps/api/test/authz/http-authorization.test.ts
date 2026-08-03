import { randomUUID } from 'node:crypto';

import {
  authorize,
  denialDisclosure,
  policyInputFor,
  type CrossProductCase,
  type DenyReason,
} from '@schedulepoint/domain';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { adminClient } from '../support/admin-client.js';
import { FIXTURE, administratorContext } from '../support/fixtures.js';
import { log } from '../support/harness.js';
import {
  buildHttpHarness,
  contextHeaders,
  currentCounters,
  lastActiveAt,
  type HttpHarness,
} from '../support/http.js';

/**
 * SPEC-06 over HTTP — the sampled subset, and the properties only a real request
 * can show.
 *
 * ## What is sampled here, and what is not
 *
 * The **full** ~39-million-case cross-product runs at the evaluator level
 * (`packages/domain/test/authz/cross-product.test.ts`), unsampled. What runs here
 * is SPEC-06 §8.1's other half — "the same combination is then executed against
 * HTTP … and all six must agree" — for a deliberately chosen subset. Each row of
 * the table below moves ONE dimension away from an allowing baseline and asserts
 * that the HTTP status matches what `denialDisclosure` says the pure evaluator's
 * reason maps to. That is the agreement claim, made per request rather than
 * asserted in prose.
 *
 * Six surfaces are named in §8.1. Two exist: HTTP and the worker, and since
 * OPUS-M1-004 **both run the same evaluator** — the worker's role allow-list is
 * deleted (FAD-13 item 1). The job surface's half of the agreement is asserted in
 * `apps/api/test/jobs/job-context.test.ts`; the remaining four surfaces do not
 * exist yet, so the six-way agreement is still only two-way, which is recorded in
 * `docs/evidence/EV-M1-INTEGRATION/INDEX.md` §5.
 */

let harness: HttpHarness;
let admin: pg.Client;

const alpha = FIXTURE.alpha;
const groupPath = `/organizations/${alpha.organizationId}/groups/${alpha.groupOne.id}/context-probe/touch`;
const organizationPath = `/organizations/${alpha.organizationId}/context-probe/touch`;

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  harness = await buildHttpHarness();
});

afterAll(async () => {
  await harness.close();
  await admin.end();
});

afterEach(() => {
  harness.clearLogs();
});

async function headersFor(userId: string, groupId: string | null): Promise<Record<string, string>> {
  return contextHeaders(
    userId,
    await currentCounters(admin, { organizationId: alpha.organizationId, groupId, userId }),
  );
}

/** Runs `fn` as the organization administrator and puts the world back afterwards. */
async function asAdministrator<T>(
  fn: (query: Parameters<Parameters<HttpHarness['runtime']['runner']['run']>[1]>[0]['query']) => Promise<T>,
): Promise<T> {
  return harness.runtime.runner.run(
    administratorContext(alpha.organizationId, 'http-authz-admin'),
    async ({ query }) => fn(query),
  );
}

/**
 * The same headers, with a chosen correlation id so the audit rows are findable.
 *
 * `json` defaults to true because most of these routes take a body. It must be
 * FALSE for the bodyless ones: Fastify rejects `content-type: application/json`
 * with an empty body as a 400, and a 400 would silently replace the 403 the
 * denial-ordering test is actually asserting on.
 */
async function headersForCorrelated(
  userId: string,
  groupId: string | null,
  correlationId: string,
  options: { readonly json?: boolean } = {},
): Promise<Record<string, string>> {
  const headers = contextHeaders(
    userId,
    await currentCounters(admin, { organizationId: alpha.organizationId, groupId, userId }),
    correlationId,
  );
  return options.json === false ? headers : { ...headers, 'content-type': 'application/json' };
}

/**
 * Audit rows for a correlation id, read from GROUND TRUTH with the superuser.
 *
 * Never through the application's own read path: a test that asked the audited
 * system whether it audited something would pass for a system that recorded
 * nothing and answered from memory.
 */
async function auditRowsFor(correlationId: string) {
  const { rows } = await admin.query<{
    event_name: string;
    actor_kind: string;
    actor_membership_id: string | null;
    group_id: string | null;
    subject_type: string;
    subject_id: string;
    sequence: string;
  }>(
    `select event_name, actor_kind, actor_membership_id::text as actor_membership_id,
            group_id::text as group_id, subject_type, subject_id::text as subject_id,
            sequence::text as sequence
       from audit_events where correlation_id = $1 order by sequence`,
    [correlationId],
  );
  return rows;
}

/**
 * Closes a grant's window so it authorizes nothing afterwards.
 *
 * No runtime role holds DELETE on `capability_grants` (PO-DEC-04: disabling
 * never deletes data), so the window MOVES. Both bounds move, because
 * `capability_grants_window` is `valid_to > valid_from` and `valid_from`
 * defaulted to the insert's `now()`.
 */
async function closeGrant(id: string): Promise<void> {
  const from = new Date(Date.now() - 2000);
  const to = new Date(Date.now() - 1000);
  await asAdministrator(async (query) => {
    await query
      .updateTable('capability_grants')
      .set({ valid_from: from, valid_to: to })
      .where('id', '=', id)
      .execute();
  });
}

/**
 * A user row for a membership-creation test, written through the administrator's
 * unit of work rather than with the superuser.
 *
 * `users` is global (PO-DEC-06) and reachable only through a membership visible
 * in context, so creating one is an administrative act like any other.
 */
async function createSyntheticUser(): Promise<string> {
  const id = randomUUID();
  await asAdministrator(async (query) => {
    await query
      .insertInto('users')
      .values({
        id,
        login_email: `authz-emit-${id}@example.invalid`,
        display_name: 'Emission Test Subject (synthetic)',
      })
      .execute();
  });
  return id;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The HTTP subset of the cross-product
 * ──────────────────────────────────────────────────────────────────────────── */

describe('SPEC-06 §8.1 — the HTTP half agrees with the pure evaluator', () => {
  it('the baseline ALLOWS, so every denial below is caused by the dimension it moves', async () => {
    const before = await lastActiveAt(admin, alpha.users.scheduler.membershipId);
    const response = await harness.app.inject({
      method: 'POST',
      url: groupPath,
      headers: await headersFor(alpha.users.scheduler.id, alpha.groupOne.id),
    });
    expect(response.statusCode).toBe(200);
    const after = await lastActiveAt(admin, alpha.users.scheduler.membershipId);
    expect(after?.getTime() ?? null).not.toBe(before?.getTime() ?? null);
  });

  /**
   * One row per layer of the truth table, each moving exactly one dimension.
   *
   * `expectedReason` is the reason the PURE evaluator produces for the same
   * situation; the expected HTTP status is derived from it through
   * `denialDisclosure`, not written down separately. So the test cannot drift
   * from the disclosure rule — if P-5/P-6 changed, these statuses change with it.
   */
  interface HttpCase {
    readonly label: string;
    readonly layer: string;
    readonly expectedReason: DenyReason;
    /**
     * Which layer of the request actually refuses.
     *
     * **This is a real finding, not a test convenience.** SPEC-01 §2.3's
     * validation sequence runs BEFORE SPEC-06's evaluator, and its steps 1 and 2
     * already refuse three of the situations the truth table also refuses:
     * an inactive organization (step 1 / L0.1), a suspended membership and an
     * out-of-window membership (step 2 / L3.2, L3.3 — `membershipIsActive` is
     * literally L3.2 and L3.3, and `verification.ts` says so).
     *
     * Both layers answer the same **404**, so the disclosure is identical and
     * nothing leaks either way. What differs is which layer logs it. Marking
     * these `context` rather than pretending the evaluator saw them is the
     * difference between a test that documents the architecture and one that
     * asserts a fiction.
     */
    readonly deniedBy: 'context' | 'authorization';
    readonly arrange: () => Promise<void>;
    readonly restore: () => Promise<void>;
    readonly userId?: string;
  }

  const cases: readonly HttpCase[] = [
    {
      label: 'L0.1 the organization is inactive',
      layer: 'L0.1',
      deniedBy: 'context',
      expectedReason: 'ORG_INACTIVE',
      arrange: async () => {
        await asAdministrator(async (query) => {
          await query
            .updateTable('organizations')
            .set({ status: 'inactive' })
            .where('id', '=', alpha.organizationId)
            .execute();
        });
      },
      restore: async () => {
        await asAdministrator(async (query) => {
          await query
            .updateTable('organizations')
            .set({ status: 'active' })
            .where('id', '=', alpha.organizationId)
            .execute();
        });
      },
    },
    {
      label: 'L1.2 the module entitlement is suspended',
      layer: 'L1.2',
      deniedBy: 'authorization',
      expectedReason: 'ENTITLEMENT_SUSPENDED',
      arrange: async () => {
        await asAdministrator(async (query) => {
          await query
            .updateTable('entitlements')
            .set({ state: 'suspended' })
            .where('module_key', '=', 'core_scheduling')
            .execute();
        });
      },
      restore: async () => {
        await asAdministrator(async (query) => {
          await query
            .updateTable('entitlements')
            .set({ state: 'active' })
            .where('module_key', '=', 'core_scheduling')
            .execute();
        });
      },
    },
    {
      label: 'L1.3 the entitlement window has closed',
      layer: 'L1.3',
      deniedBy: 'authorization',
      expectedReason: 'ENTITLEMENT_EXPIRED',
      arrange: async () => {
        await asAdministrator(async (query) => {
          await query
            .updateTable('entitlements')
            .set({
              effective_from: new Date('2020-01-01T00:00:00.000Z'),
              effective_to: new Date('2021-01-01T00:00:00.000Z'),
            })
            .where('module_key', '=', 'core_scheduling')
            .execute();
        });
      },
      restore: async () => {
        await asAdministrator(async (query) => {
          await query
            .updateTable('entitlements')
            .set({ effective_from: new Date('2020-01-01T00:00:00.000Z'), effective_to: null })
            .where('module_key', '=', 'core_scheduling')
            .execute();
        });
      },
    },
    {
      label: 'L2.1 the module is unavailable in this group',
      layer: 'L2.1',
      deniedBy: 'authorization',
      expectedReason: 'MODULE_UNAVAILABLE_IN_GROUP',
      arrange: async () => {
        await asAdministrator(async (query) => {
          await query
            .updateTable('group_module_availability')
            .set({ available: false })
            .where('group_id', '=', alpha.groupOne.id)
            .where('module_key', '=', 'core_scheduling')
            .execute();
        });
      },
      restore: async () => {
        await asAdministrator(async (query) => {
          await query
            .updateTable('group_module_availability')
            .set({ available: true })
            .where('group_id', '=', alpha.groupOne.id)
            .where('module_key', '=', 'core_scheduling')
            .execute();
        });
      },
    },
    {
      label: 'L3.2 the membership is suspended',
      layer: 'L3.2',
      deniedBy: 'context',
      expectedReason: 'MEMBERSHIP_SUSPENDED',
      arrange: async () => {
        await asAdministrator(async (query) => {
          await query
            .updateTable('memberships')
            .set({ status: 'suspended' })
            .where('id', '=', alpha.users.scheduler.membershipId)
            .execute();
        });
      },
      restore: async () => {
        await asAdministrator(async (query) => {
          await query
            .updateTable('memberships')
            .set({ status: 'active' })
            .where('id', '=', alpha.users.scheduler.membershipId)
            .execute();
        });
      },
    },
    {
      label: 'L3.3 the membership validity window has closed',
      layer: 'L3.3',
      deniedBy: 'context',
      expectedReason: 'MEMBERSHIP_EXPIRED',
      arrange: async () => {
        await asAdministrator(async (query) => {
          await query
            .updateTable('memberships')
            .set({
              valid_from: new Date('2020-01-01T00:00:00.000Z'),
              valid_to: new Date('2021-01-01T00:00:00.000Z'),
            })
            .where('id', '=', alpha.users.scheduler.membershipId)
            .execute();
        });
      },
      restore: async () => {
        await asAdministrator(async (query) => {
          await query
            .updateTable('memberships')
            .set({ valid_from: new Date('2020-01-01T00:00:00.000Z'), valid_to: null })
            .where('id', '=', alpha.users.scheduler.membershipId)
            .execute();
        });
      },
    },
    {
      label: 'L4.1 an explicit DENY grant beats the role (P-1)',
      layer: 'L4.1',
      deniedBy: 'authorization',
      expectedReason: 'EXPLICIT_DENY',
      arrange: async () => {
        await asAdministrator(async (query) => {
          await query
            .insertInto('capability_grants')
            .values({
              id: DENY_GRANT_ID,
              organization_id: alpha.organizationId,
              group_id: alpha.groupOne.id,
              membership_id: alpha.users.scheduler.membershipId,
              capability_key: 'membership.touch_self',
              granted: false,
            })
            .execute();
        });
      },
      restore: async () => {
        await admin.query('delete from capability_grants where id = $1', [DENY_GRANT_ID]);
      },
    },
    {
      label: 'L4.2 the role does not carry the capability',
      layer: 'L4.2',
      deniedBy: 'authorization',
      expectedReason: 'NO_CAPABILITY',
      userId: alpha.users.member.id,
      arrange: () => Promise.resolve(),
      restore: () => Promise.resolve(),
    },
  ];

  const DENY_GRANT_ID = '7d000001-1111-4111-8111-000000000001';

  for (const testCase of cases) {
    it(`${testCase.label} → ${testCase.expectedReason} (${denialDisclosure(testCase.expectedReason) === 'forbidden' ? '403' : '404'})`, async () => {
      const userId = testCase.userId ?? alpha.users.scheduler.id;
      const membershipId =
        userId === alpha.users.member.id
          ? alpha.users.member.membershipId
          : alpha.users.scheduler.membershipId;

      await testCase.arrange();
      try {
        // Counters are read AFTER the arrangement, so the request is fresh and
        // the denial is the authorization layer's rather than step 4's.
        const headers = await headersFor(userId, alpha.groupOne.id);
        const before = await lastActiveAt(admin, membershipId);

        const response = await harness.app.inject({ method: 'POST', url: groupPath, headers });

        const expectedStatus =
          denialDisclosure(testCase.expectedReason) === 'forbidden' ? 403 : 404;
        expect(response.statusCode, `${testCase.layer}: wrong status`).toBe(expectedStatus);

        const after = await lastActiveAt(admin, membershipId);
        expect(after?.getTime() ?? null, `${testCase.layer}: the mutation landed anyway`).toBe(
          before?.getTime() ?? null,
        );

        // And the server-side log says WHICH layer refused, so "the two surfaces
        // agree" is checked rather than inferred from the status alone — two
        // different reasons can share a status.
        if (testCase.deniedBy === 'authorization') {
          const denial = harness.logs.find(
            (line) => (line as { authorization?: { reason?: string } }).authorization !== undefined,
          ) as { authorization?: { reason?: string; step?: string } } | undefined;
          expect(denial?.authorization?.reason, `${testCase.layer}: unexpected reason`).toBe(
            testCase.expectedReason,
          );
          expect(denial?.authorization?.step).toBe(testCase.layer);
        } else {
          // SPEC-01 §2.3 refused first. Assert that it did — and that no
          // authorization line was written, because the evaluator never ran.
          const contextFailure = harness.logs.find(
            (line) =>
              (line as { contextFailure?: unknown }).contextFailure !== undefined ||
              (line as { contextSecurityEvent?: unknown }).contextSecurityEvent !== undefined,
          );
          expect(
            contextFailure,
            `${testCase.layer}: neither the context sequence nor the evaluator refused`,
          ).toBeDefined();
          expect(
            harness.logs.some((line) => (line as { authorization?: unknown }).authorization !== undefined),
            `${testCase.layer}: the evaluator ran after the context sequence had already refused`,
          ).toBe(false);
        }
      } finally {
        await testCase.restore();
      }
    });
  }

  it('the eight rows above cover eight DISTINCT layers — the table is not one case repeated', () => {
    expect(new Set(cases.map((c) => c.layer)).size).toBe(cases.length);
    log(`HTTP subset covers ${cases.map((c) => c.layer).join(', ')}`);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * A-05 / A-09 — entitlement revocation mid-session, and re-enable
 * ──────────────────────────────────────────────────────────────────────────── */

describe('A-05 and A-09 — entitlement revocation mid-session, and data intact on re-enable', () => {
  it('A-05: a request that would have succeeded is denied the moment the entitlement is revoked', async () => {
    // The T-06 analogue at the ENTITLEMENT layer rather than the context layer.
    // OPUS-M1-001's T-06 proved the long-open submission failed closed at step 4
    // because `organization_version` had moved; this proves the L1 denial itself.
    const userId = alpha.users.scheduler.id;
    const ok = await harness.app.inject({
      method: 'POST',
      url: groupPath,
      headers: await headersFor(userId, alpha.groupOne.id),
    });
    expect(ok.statusCode).toBe(200);

    const revoke = await harness.app.inject({
      method: 'PATCH',
      url: `/organizations/${alpha.organizationId}/entitlements/core_scheduling`,
      headers: {
        ...(await headersFor(alpha.users.organizationAdmin.id, null)),
        'content-type': 'application/json',
      },
      payload: { state: 'revoked' },
    });
    expect(revoke.statusCode, 'the administrator could not revoke the entitlement').toBe(200);

    try {
      const denied = await harness.app.inject({
        method: 'POST',
        url: groupPath,
        headers: await headersFor(userId, alpha.groupOne.id),
      });
      // P-5: an unentitled module's existence is not disclosed.
      expect(denied.statusCode).toBe(404);
      log('entitlement revoked mid-session: the next request is 404, not 403');
    } finally {
      const restore = await harness.app.inject({
        method: 'PATCH',
        url: `/organizations/${alpha.organizationId}/entitlements/core_scheduling`,
        headers: {
          ...(await headersFor(alpha.users.organizationAdmin.id, null)),
          'content-type': 'application/json',
        },
        payload: { state: 'active' },
      });
      expect(restore.statusCode).toBe(200);
    }
  });

  it('A-09: re-enabling restores access, and no row was deleted while it was off', async () => {
    const countRows = async (): Promise<string> => {
      const r = await admin.query<{ n: string }>(
        'select count(*)::text as n from memberships where organization_id = $1',
        [alpha.organizationId],
      );
      return r.rows[0]?.n ?? '0';
    };
    const before = await countRows();

    await harness.app.inject({
      method: 'PATCH',
      url: `/organizations/${alpha.organizationId}/entitlements/core_scheduling`,
      headers: {
        ...(await headersFor(alpha.users.organizationAdmin.id, null)),
        'content-type': 'application/json',
      },
      payload: { state: 'suspended' },
    });
    expect(await countRows(), 'disabling a module deleted data — PO-DEC-04 forbids it').toBe(before);

    await harness.app.inject({
      method: 'PATCH',
      url: `/organizations/${alpha.organizationId}/entitlements/core_scheduling`,
      headers: {
        ...(await headersFor(alpha.users.organizationAdmin.id, null)),
        'content-type': 'application/json',
      },
      payload: { state: 'active' },
    });

    const restored = await harness.app.inject({
      method: 'POST',
      url: groupPath,
      headers: await headersFor(alpha.users.scheduler.id, alpha.groupOne.id),
    });
    expect(restored.statusCode, 'access was not restored on re-enable').toBe(200);
    expect(await countRows()).toBe(before);
    log('module disabled then re-enabled: access restored, row count unchanged');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Grant-driven allow and deny, over HTTP
 * ──────────────────────────────────────────────────────────────────────────── */

describe('deny paths and allow paths for every GRANT type', () => {
  // The server chooses the grant id (a caller-chosen primary key would be an
  // X-11 existence oracle), so the cleanup is by membership rather than by an id
  // the test could have predicted.
  const grantee = FIXTURE.alpha.users.member.membershipId;

  afterEach(async () => {
    await admin.query(
      `delete from capability_grants where membership_id = $1 and capability_key <> 'documents.manage'`,
      [grantee],
    );
  });

  it('an explicit ALLOW grant lets a role through that would otherwise be denied', async () => {
    // The Alpha member holds no capability at all. A grant is the only thing
    // that can change that — and it is L4.2's other half.
    const denied = await harness.app.inject({
      method: 'POST',
      url: groupPath,
      headers: await headersFor(alpha.users.member.id, alpha.groupOne.id),
    });
    expect(denied.statusCode).toBe(403);

    const write = await harness.app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/memberships/${alpha.users.member.membershipId}/grants`,
      headers: {
        ...(await headersFor(alpha.users.organizationAdmin.id, null)),
        'content-type': 'application/json',
      },
      payload: {
        membershipId: alpha.users.member.membershipId,
        capabilityKey: 'membership.touch_self',
        granted: true,
      },
    });
    expect(write.statusCode, 'the administrator could not write the grant').toBe(200);

    const allowed = await harness.app.inject({
      method: 'POST',
      url: groupPath,
      headers: await headersFor(alpha.users.member.id, alpha.groupOne.id),
    });
    expect(allowed.statusCode, 'an explicit allow grant did not take effect').toBe(200);
    log('member: 403 without a grant, 200 with one — L4.2 both ways');
  });

  it('an EXPIRED grant does not authorize', async () => {
    // S-09: the setup `inject` is ASSERTED. Unasserted, a 400 or 404 here would
    // mean no grant was ever written and the test would pass by proving nothing
    // — the same shape as the residual-1 test an independent review found
    // passing either way.
    const write = await harness.app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/memberships/${alpha.users.member.membershipId}/grants`,
      headers: {
        ...(await headersFor(alpha.users.organizationAdmin.id, null)),
        'content-type': 'application/json',
      },
      payload: {
        membershipId: alpha.users.member.membershipId,
        capabilityKey: 'membership.touch_self',
        granted: true,
        validFrom: '2020-01-01T00:00:00.000Z',
        validTo: '2021-01-01T00:00:00.000Z',
      },
    });
    expect(write.statusCode, `the expired grant was never written: ${write.body}`).toBe(200);
    const landed = await admin.query<{ n: string }>(
      `select count(*)::text as n from capability_grants
        where membership_id = $1 and capability_key = 'membership.touch_self'`,
      [alpha.users.member.membershipId],
    );
    expect(landed.rows[0]?.n, 'no grant row exists — the test is vacuous').toBe('1');

    const response = await harness.app.inject({
      method: 'POST',
      url: groupPath,
      headers: await headersFor(alpha.users.member.id, alpha.groupOne.id),
    });
    expect(response.statusCode, 'an out-of-window grant authorized a request').toBe(403);
  });

  it('a grant for a DIFFERENT capability does not authorize this action', async () => {
    const write = await harness.app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/memberships/${alpha.users.member.membershipId}/grants`,
      headers: {
        ...(await headersFor(alpha.users.organizationAdmin.id, null)),
        'content-type': 'application/json',
      },
      payload: {
        membershipId: alpha.users.member.membershipId,
        capabilityKey: 'schedule.publish',
        granted: true,
      },
    });
    expect(write.statusCode, `the grant was never written: ${write.body}`).toBe(200);

    const response = await harness.app.inject({
      method: 'POST',
      url: groupPath,
      headers: await headersFor(alpha.users.member.id, alpha.groupOne.id),
    });
    expect(response.statusCode).toBe(403);
  });

  it('A-12 over HTTP: an overlapping grant window is a 409, and the first grant is untouched', async () => {
    const first = await harness.app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/memberships/${alpha.users.member.membershipId}/grants`,
      headers: {
        ...(await headersFor(alpha.users.organizationAdmin.id, null)),
        'content-type': 'application/json',
      },
      payload: {
        membershipId: alpha.users.member.membershipId,
        capabilityKey: 'membership.touch_self',
        granted: true,
      },
    });
    expect(first.statusCode).toBe(200);

    const second = await harness.app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/memberships/${alpha.users.member.membershipId}/grants`,
      headers: {
        ...(await headersFor(alpha.users.organizationAdmin.id, null)),
        'content-type': 'application/json',
      },
      payload: {
        membershipId: alpha.users.member.membershipId,
        capabilityKey: 'membership.touch_self',
        granted: false,
      },
    });
    expect(second.statusCode, 'the exclusion constraint did not surface as a conflict').toBe(409);
    expect(second.body, 'the response quoted the constraint').not.toContain('capability_grants');

    const rows = await admin.query<{ n: string }>(
      `select count(*)::text as n from capability_grants
        where membership_id = $1 and capability_key = 'membership.touch_self'`,
      [alpha.users.member.membershipId],
    );
    expect(rows.rows[0]?.n, 'the overlapping grant landed').toBe('1');
  });

  it('an unknown capability key is refused before any row is written', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/memberships/${alpha.users.member.membershipId}/grants`,
      headers: {
        ...(await headersFor(alpha.users.organizationAdmin.id, null)),
        'content-type': 'application/json',
      },
      payload: {
        membershipId: alpha.users.member.membershipId,
        capabilityKey: 'invented.capability',
        granted: true,
      },
    });
    expect(response.statusCode).toBe(400);
    const rows = await admin.query<{ n: string }>(
      `select count(*)::text as n from capability_grants
        where membership_id = $1 and capability_key = 'invented.capability'`,
      [alpha.users.member.membershipId],
    );
    expect(rows.rows[0]?.n).toBe('0');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Residual 1 and 2, at the application layer
 * ──────────────────────────────────────────────────────────────────────────── */

describe('the membership-creation route — EV-M1-TENANCY residuals 1 and 2', () => {
  // Ids created here are the SERVER's, so the cleanup targets the users these
  // tests attach rather than an id the test chose.
  const attachedUsers = [
    FIXTURE.beta.users.scheduler.id,
    '00000000-0000-4000-8000-0000000000ff',
    FIXTURE.alpha.users.groupOnly.id,
  ];

  afterEach(async () => {
    await admin.query(
      `delete from memberships
        where organization_id = $1 and user_id = any($2::uuid[]) and group_id is not distinct from $3`,
      [alpha.organizationId, attachedUsers, null],
    );
    await admin.query(
      `delete from memberships where organization_id = $1 and group_id = $2 and user_id = any($3::uuid[])`,
      [alpha.organizationId, alpha.groupTwo.id, attachedUsers],
    );
  });

  it('an actor WITHOUT the capability cannot create a membership at all', async () => {
    // The Alpha organization has exactly one organization membership, the
    // administrator's. A group member reaching this route fails SPEC-01 §2.3
    // step 2's organization branch before authorization even runs — 404, and
    // the route never issues a statement.
    const response = await harness.app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/memberships`,
      headers: {
        ...(await headersFor(alpha.users.member.id, null)),
        'content-type': 'application/json',
      },
      payload: {
        userId: FIXTURE.beta.users.scheduler.id,
        groupId: null,
        role: 'org_admin',
      },
    });
    expect(response.statusCode).toBe(404);
    const rows = await admin.query<{ n: string }>(
      `select count(*)::text as n from memberships
        where organization_id = $1 and user_id = $2`,
      [alpha.organizationId, FIXTURE.beta.users.scheduler.id],
    );
    expect(rows.rows[0]?.n).toBe('0');
  });

  it('RESIDUAL 2: a non-existent user and a foreign user are BYTE-IDENTICAL to an unauthorized actor', async () => {
    // The oracle was the difference between two responses. Both are now the same
    // 404, with the same body, the same content-type and the same content-length
    // — the T-05b standard, applied to the membership edge.
    // The SAME correlation id for both, because the envelope echoes it — two
    // requests with different correlation ids differ in one field for a reason
    // that has nothing to do with disclosure, and comparing them raw would
    // measure the wrong thing.
    const headers = {
      ...contextHeaders(
        alpha.users.member.id,
        await currentCounters(admin, {
          organizationId: alpha.organizationId,
          groupId: null,
          userId: alpha.users.member.id,
        }),
        'residual-2-byte-identical',
      ),
      'content-type': 'application/json',
    };
    const nonExistent = await harness.app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/memberships`,
      headers,
      payload: {
        userId: '00000000-0000-4000-8000-0000000000ff',
        groupId: null,
        role: 'org_admin',
      },
    });
    const foreign = await harness.app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/memberships`,
      headers,
      payload: {
        userId: FIXTURE.beta.users.scheduler.id,
        groupId: null,
        role: 'org_admin',
      },
    });

    expect(nonExistent.statusCode).toBe(foreign.statusCode);
    expect(nonExistent.body).toBe(foreign.body);
    expect(nonExistent.headers['content-type']).toBe(foreign.headers['content-type']);
    expect(nonExistent.headers['content-length']).toBe(foreign.headers['content-length']);
    log(
      `residual 2: non-existent user and foreign user both answer ${String(nonExistent.statusCode)} ` +
        'with a byte-identical body',
    );
  });

  it('RESIDUAL 1b, STATED AS IT IS: an AUTHORIZED administrator CAN still attach a foreign user', async () => {
    // **This test used to branch on the status code and pass either way**, under
    // a title that asserted the administrator could NOT do this. An independent
    // review called that out, and it was right to: a green test list said the
    // opposite of the truth, which is the exact artifact the previous
    // milestone's rejection was about.
    //
    // So it asserts what actually happens. `users` carries no tenant column
    // (PO-DEC-06), `memberships`' WITH CHECK therefore cannot inspect `user_id`,
    // and no non-recursive predicate can. What OPUS-M1-002 closes is the
    // UNAUTHORIZED path; the authorized one is a provisioning-design question,
    // recorded as narrowed residual 1b in EV-M1-AUTHZ §4.
    //
    // The counter assertion is the important half: the foreign user's
    // `membership_set_version` is monotonic and un-lowerable, so this IS the
    // irreversible cross-tenant availability effect residual 1 named, still
    // live, reachable only by an actor who already administers the organization.
    // When the provisioning design closes it, this test flips.
    const victim = FIXTURE.beta.users.scheduler.id;
    const before = await admin.query<{ v: string }>(
      'select membership_set_version as v from users where id = $1',
      [victim],
    );

    const response = await harness.app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/memberships`,
      headers: {
        ...(await headersFor(alpha.users.organizationAdmin.id, null)),
        'content-type': 'application/json',
      },
      payload: { userId: victim, groupId: null, role: 'org_admin' },
    });

    expect(
      response.statusCode,
      'residual 1b has been CLOSED — update this test, its title, and EV-M1-AUTHZ §4',
    ).toBe(200);

    const after = await admin.query<{ v: string }>(
      'select membership_set_version as v from users where id = $1',
      [victim],
    );
    expect(
      Number(after.rows[0]?.v),
      "the attach did not bump the foreign user's counter — the residual's shape has changed",
    ).toBe(Number(before.rows[0]?.v) + 1);

    log(
      'RESIDUAL 1b OPEN and asserted: an authorized administrator attaches a foreign user and ' +
        `raises their monotonic membership_set_version ${String(before.rows[0]?.v)} -> ` +
        `${String(after.rows[0]?.v)}. Owner: the provisioning design (EV-M1-AUTHZ §4)`,
    );
  });

  it('X-11: the caller CANNOT choose the row id — a client-supplied one is rejected outright', async () => {
    // `memberships.id` is a primary key, PK checks bypass RLS, and a primary key
    // cannot be tenant-qualified. So a 23505 on a caller-chosen id would tell the
    // caller that id exists SOMEWHERE — the same oracle class as residual 2. The
    // contract is `.strict()`, so an extra key is a 400 rather than a field the
    // server quietly ignores; a permissive schema here would have re-opened it.
    const response = await harness.app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/memberships`,
      headers: {
        ...(await headersFor(alpha.users.organizationAdmin.id, null)),
        'content-type': 'application/json',
      },
      payload: {
        membershipId: FIXTURE.beta.users.scheduler.membershipId,
        userId: alpha.users.groupOnly.id,
        groupId: alpha.groupTwo.id,
        role: 'viewer',
      },
    });
    expect(
      response.statusCode,
      'the route accepted a client-chosen primary key — that is an X-11 existence oracle',
    ).toBe(400);
    log('a client-supplied membershipId is rejected: the server owns the primary key');
  });

  it('an authorized administrator CAN create a membership for a user of its own organization', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/memberships`,
      headers: {
        ...(await headersFor(alpha.users.organizationAdmin.id, null)),
        'content-type': 'application/json',
      },
      payload: {
        userId: alpha.users.groupOnly.id,
        groupId: alpha.groupTwo.id,
        role: 'viewer',
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const created = response.json<{ membershipId: string }>();
    expect(created.membershipId, 'the server did not return the id it generated').toMatch(
      /^[0-9a-f-]{36}$/,
    );
    const rows = await admin.query<{ group_role: string }>(
      'select group_role from memberships where id = $1',
      [created.membershipId],
    );
    expect(rows.rows[0]?.group_role).toBe('viewer');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * FAD-12 and I-19
 * ──────────────────────────────────────────────────────────────────────────── */

describe('FAD-12 — the evaluation and the mutation share ONE unit of work', () => {
  it('a request still opens exactly TWO transactions with the real evaluator in place', async () => {
    // OPUS-M1-001 asserted this against a role allow-list read. The evaluator
    // reads five more relations; the count must not have moved, because every
    // one of those reads goes through the SAME `Kysely` handle the mutation uses.
    harness.runner.resetCalls();
    const response = await harness.app.inject({
      method: 'POST',
      url: groupPath,
      headers: await headersFor(alpha.users.scheduler.id, alpha.groupOne.id),
    });
    expect(response.statusCode).toBe(200);
    expect(
      harness.runner.calls,
      'the evaluator opened a transaction of its own — FAD-12 is broken',
    ).toBe(2);
    log('one request, two transactions: the §2.3 snapshot and the command');
  });

  it('an entitlement revoked BETWEEN the snapshot and the command is caught by the command', async () => {
    // The behavioural half, at a layer OPUS-M1-001 could not reach. The
    // revocation commits in the gap; a server that trusted the snapshot would
    // authorize on evidence that was already stale.
    let revoked = false;
    harness.runner.resetCalls();
    harness.runner.beforeRun = async (callIndex) => {
      if (callIndex === 2 && !revoked) {
        revoked = true;
        await asAdministrator(async (query) => {
          await query
            .updateTable('entitlements')
            .set({ state: 'revoked' })
            .where('module_key', '=', 'core_scheduling')
            .execute();
        });
      }
    };

    const before = await lastActiveAt(admin, alpha.users.scheduler.membershipId);
    try {
      const response = await harness.app.inject({
        method: 'POST',
        url: groupPath,
        headers: await headersFor(alpha.users.scheduler.id, alpha.groupOne.id),
      });
      expect(revoked, 'the interleaving never fired — the test proved nothing').toBe(true);
      expect(response.statusCode, 'a revoked entitlement was authorized by a stale snapshot').toBe(
        404,
      );
      const after = await lastActiveAt(admin, alpha.users.scheduler.membershipId);
      expect(after?.getTime() ?? null).toBe(before?.getTime() ?? null);
      log('entitlement revoked between snapshot and command: 404, no write');
    } finally {
      harness.runner.beforeRun = undefined;
      await asAdministrator(async (query) => {
        await query
          .updateTable('entitlements')
          .set({ state: 'active' })
          .where('module_key', '=', 'core_scheduling')
          .execute();
      });
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * P-8 / P-9 over HTTP
 * ──────────────────────────────────────────────────────────────────────────── */

describe('P-8 and P-9 over HTTP — the namespaces stay disjoint', () => {
  it('the organization administrator is allowed at organization scope', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: organizationPath,
      headers: await headersFor(alpha.users.organizationAdmin.id, null),
    });
    expect(response.statusCode).toBe(200);
  });

  it('P-8: the organization administrator holds NOTHING inside a group', async () => {
    // No group membership at all, so §2.3 step 2's group branch answers 404
    // before authorization runs — which is P-8 enforced one layer earlier than
    // the evaluator, and equally binding.
    const response = await harness.app.inject({
      method: 'POST',
      url: groupPath,
      headers: await headersFor(alpha.users.organizationAdmin.id, alpha.groupOne.id),
    });
    expect(response.statusCode).toBe(404);
  });

  it('P-9: a group-only principal is refused an organization-scoped action', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: organizationPath,
      headers: await headersFor(alpha.users.groupOnly.id, null),
    });
    expect(response.statusCode).toBe(404);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The audit contract with OPUS-M1-003
 * ──────────────────────────────────────────────────────────────────────────── */

describe('OPUS-M1-004 — every OPUS-M1-002 mutation emits its audit event', () => {
  /**
   * The test that stood here asserted that **no** `audit_events` table existed.
   *
   * That was the correct assertion at the time: OPUS-M1-003 was building the
   * chain in a parallel worktree, and non-bypass rule 6 forbids writing an audit
   * row outside a chain that does not exist. The assertion's job was to stop a
   * "temporary" audit table appearing without one. FAD-13 item 2 is the merge
   * that makes it obsolete, and it is replaced with its opposite rather than
   * deleted — the mutations must now emit, and each one is checked against
   * ground truth read with the superuser.
   */
  it('the event names are stable, exported, and in the domain vocabulary', async () => {
    const { AUDIT_EVENTS } = await import('../../src/http/routes/authorization.route.js');
    expect(AUDIT_EVENTS).toEqual({
      membershipCreated: 'authorization.membership.created',
      capabilityGrantWritten: 'authorization.capability_grant.written',
      entitlementStateChanged: 'authorization.entitlement.state_changed',
    });

    // The names are only a contract if BOTH sides hold them. `isAuditEventName`
    // is what the recorder's type demands; asserting it here means the route's
    // constant cannot drift out of the closed vocabulary.
    const { isAuditEventName } = await import('@schedulepoint/domain');
    for (const name of Object.values(AUDIT_EVENTS)) {
      expect(isAuditEventName(name), `${name} is not in AUDIT_EVENT_NAMES`).toBe(true);
    }
  });

  it('creating a membership emits one row, attributed to the acting administrator', async () => {
    const correlationId = `authz-emit-m-${randomUUID().slice(0, 8)}`;
    const userId = await createSyntheticUser();
    const response = await harness.app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/memberships`,
      headers: await headersForCorrelated(alpha.users.organizationAdmin.id, null, correlationId),
      // A GROUP membership, like the success case above. An extra ORGANIZATION
      // membership in Alpha would break `roles-and-schema.test.ts`'s X-07, which
      // asserts the fixture has exactly one — correctly, since a second one
      // changes what an organization-scoped read is supposed to see.
      payload: { userId, groupId: alpha.groupTwo.id, role: 'viewer' },
    });
    expect(response.statusCode, response.body).toBe(200);
    const created = response.json<{ membershipId: string }>();

    const rows = await auditRowsFor(correlationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_name).toBe('authorization.membership.created');
    expect(rows[0]?.subject_type).toBe('membership');
    expect(rows[0]?.subject_id, 'the subject is the membership that was created').toBe(
      created.membershipId,
    );
    expect(rows[0]?.actor_kind).toBe('membership');
    expect(rows[0]?.actor_membership_id).toBe(alpha.users.organizationAdmin.membershipId);
    // An organization-scoped mutation files against no group — `audit_events`'s
    // organization INSERT policy requires `group_id IS NULL`, so this is the
    // database agreeing as well as the assertion.
    expect(rows[0]?.group_id).toBeNull();
    log(`membership.created -> audit sequence ${String(rows[0]?.sequence)}`);
  });

  it('writing a capability grant emits one row whose subject is the GRANT', async () => {
    const correlationId = `authz-emit-g-${randomUUID().slice(0, 8)}`;
    // The target is the DEPARTED membership and the capability is one no other
    // test asserts on. A grant is durable state in a shared cluster: granting
    // `membership.touch_self` to an actor another test expects to be denied
    // makes that test fail for a reason nobody can see from its own source. The
    // window is closed in `finally` regardless.
    const target = alpha.users.departed.membershipId;
    let grantId: string | undefined;
    try {
      const response = await harness.app.inject({
        method: 'POST',
        url: `/organizations/${alpha.organizationId}/memberships/${target}/grants`,
        headers: await headersForCorrelated(alpha.users.organizationAdmin.id, null, correlationId),
        payload: { membershipId: target, capabilityKey: 'messaging.bulk_send', granted: true },
      });
      expect(response.statusCode, response.body).toBe(200);
      grantId = response.json<{ grantId: string }>().grantId;

      const rows = await auditRowsFor(correlationId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.event_name).toBe('authorization.capability_grant.written');
      expect(rows[0]?.subject_type).toBe('capability_grant');
      expect(rows[0]?.subject_id).toBe(grantId);
      log(`capability_grant.written -> audit sequence ${String(rows[0]?.sequence)}`);
    } finally {
      if (grantId !== undefined) await closeGrant(grantId);
    }
  });

  it('changing an entitlement emits an audit row AND an outbox row linked to it', async () => {
    const correlationId = `authz-emit-e-${randomUUID().slice(0, 8)}`;
    try {
      const response = await harness.app.inject({
        method: 'PATCH',
        // `core_scheduling`, because it is the module the fixture actually
        // entitles. Suspend-and-restore is the same shape the A-09 case above
        // uses, and the restore is in a `finally` for the same reason.
        url: `/organizations/${alpha.organizationId}/entitlements/core_scheduling`,
        headers: await headersForCorrelated(alpha.users.organizationAdmin.id, null, correlationId),
        payload: { state: 'suspended' },
      });
      expect(response.statusCode, response.body).toBe(200);

      const rows = await auditRowsFor(correlationId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.event_name).toBe('authorization.entitlement.state_changed');
      expect(rows[0]?.subject_type).toBe('entitlement');

      // The outbox row exists, and it is LINKED to that audit row's sequence —
      // SPEC-11 §3.3's reconciler joins on exactly this.
      const outbox = await admin.query<{
        kind: string;
        audit_sequence: string;
        idempotency_key: string;
      }>(
        `select kind, audit_sequence::text as audit_sequence, idempotency_key
           from outbox_events where correlation_id = $1`,
        [correlationId],
      );
      expect(outbox.rows).toHaveLength(1);
      expect(outbox.rows[0]?.kind).toBe('authorization.entitlement.state_changed');
      expect(outbox.rows[0]?.audit_sequence).toBe(rows[0]?.sequence);
      expect(outbox.rows[0]?.idempotency_key).toBe(`entitlement-state:${String(rows[0]?.sequence)}`);
      log(
        `entitlement.state_changed -> audit ${String(rows[0]?.sequence)} + outbox ` +
          `${String(outbox.rows[0]?.idempotency_key)}`,
      );
    } finally {
      await asAdministrator(async (query) => {
        await query
          .updateTable('entitlements')
          .set({ state: 'active' })
          .where('organization_id', '=', alpha.organizationId)
          .where('module_key', '=', 'core_scheduling')
          .execute();
      });
    }
  });

  it('a mutation DENIED BY THE EVALUATOR writes neither the change nor an audit row', async () => {
    /* ── T-02: this test denied one layer too early, and proved nothing ───────
     *
     * It used to drive `alpha.users.groupOnly` at the organization-scoped
     * membership-creation route. That principal holds NO organization
     * membership, so SPEC-01 §2.3 step 2 refuses in the middleware and the
     * handler never runs at all — which means the test passed identically
     * against a handler ordered mutate → evaluate → audit. It was asserting that
     * the middleware works, while claiming to assert the merge's central
     * property.
     *
     * The actor is now one who **passes** §2.3 and is denied INSIDE the handler's
     * open transaction: `alpha.users.member` holds an active group membership in
     * Group One, so step 2 resolves it, and the group role `member` does not
     * carry `membership.touch_self`, so SPEC-06 denies at L4.2.
     *
     * Three things discriminate "denied by the evaluator" from "refused by the
     * middleware", and all three are asserted:
     *
     *   1. the status is **403**. Every §2.3 failure is 404 (SPEC-01 §2.4), so a
     *      403 can only have come from a request that reached L4 with an active
     *      membership already established;
     *   2. the denial the server LOGGED names an L4 step and a capability reason;
     *   3. `authorizationEvaluated` was set — the middleware's onSend guard turns
     *      a capability route that answers 2xx without it into a 500, and the
     *      log line above only exists because the evaluator produced a decision.
     *
     * Then: no mutation, and no audit row. Together those say the handler
     * evaluated first and returned before writing either. */
    const correlationId = `authz-emit-d-${randomUUID().slice(0, 8)}`;
    const membershipId = alpha.users.member.membershipId;
    const before = await lastActiveAt(admin, membershipId);
    harness.clearLogs();

    const response = await harness.app.inject({
      method: 'POST',
      url: groupPath,
      headers: await headersForCorrelated(alpha.users.member.id, alpha.groupOne.id, correlationId, {
        json: false,
      }),
    });

    expect(
      response.statusCode,
      'a 404 means the middleware refused and the handler never ran — the ordering is unproven',
    ).toBe(403);

    const denial = harness.logs.find(
      (line) => (line as { authorization?: unknown }).authorization !== undefined,
    ) as { authorization?: { reason?: string; step?: string } } | undefined;
    expect(denial, 'no authorization decision was logged — the evaluator did not run').toBeDefined();
    expect(denial?.authorization?.step, 'denied before L4 — the evaluator was not reached').toMatch(
      /^L4/,
    );
    expect(denial?.authorization?.reason).toBe('NO_CAPABILITY');

    /* ── and now the property itself ─────────────────────────────────────── */
    const after = await lastActiveAt(admin, membershipId);
    expect(
      after?.getTime() ?? null,
      'the mutation landed despite the denial — the handler wrote before it evaluated',
    ).toBe(before?.getTime() ?? null);
    expect(
      await auditRowsFor(correlationId),
      'a denied mutation left an audit row — the audit call runs before the denial returns',
    ).toEqual([]);

    log(
      `denied at ${String(denial?.authorization?.step)} (${String(denial?.authorization?.reason)}) ` +
        'inside the handler: 403, last_active_at unmoved, 0 audit rows',
    );
  });

  it('the SAME route ALLOWS the same actor once the capability is granted — the denial is not a wall', async () => {
    // Without this, the test above passes for a route that is simply broken.
    // An explicit ALLOW grant (SPEC-06 L4.1) turns exactly one dimension around
    // and the mutation and its audit row both appear.
    const correlationId = `authz-emit-a-${randomUUID().slice(0, 8)}`;
    const membershipId = alpha.users.member.membershipId;
    const before = await lastActiveAt(admin, membershipId);
    let grantId: string | undefined;
    try {
      const write = await harness.app.inject({
        method: 'POST',
        url: `/organizations/${alpha.organizationId}/memberships/${membershipId}/grants`,
        headers: await headersForCorrelated(alpha.users.organizationAdmin.id, null, `${correlationId}-g`),
        payload: { membershipId, capabilityKey: 'membership.touch_self', granted: true },
      });
      expect(write.statusCode, write.body).toBe(200);
      grantId = write.json<{ grantId: string }>().grantId;

      const response = await harness.app.inject({
        method: 'POST',
        url: groupPath,
        headers: await headersForCorrelated(
          alpha.users.member.id,
          alpha.groupOne.id,
          correlationId,
          { json: false },
        ),
      });
      expect(response.statusCode, response.body).toBe(200);

      const after = await lastActiveAt(admin, membershipId);
      expect(after?.getTime() ?? null, 'the allowed mutation did not land').not.toBe(
        before?.getTime() ?? null,
      );
      const rows = await auditRowsFor(correlationId);
      expect(rows, 'the allowed mutation recorded no audit row').toHaveLength(1);
      expect(rows[0]?.event_name).toBe('membership.activity_touched');
      log('the same actor, one grant later: 200, the row moved, and exactly one audit row');
    } finally {
      if (grantId !== undefined) await closeGrant(grantId);
    }
  });

  it('a mutation that FAILS after its audit call leaves neither (FAD-12)', async () => {
    // The A-12 exclusion constraint fires on the grant INSERT, inside the same
    // transaction the audit row would be written in. The first grant's audit row
    // is real and committed; the second attempt takes its own audit row down
    // with the failed insert.
    const first = `authz-emit-x1-${randomUUID().slice(0, 8)}`;
    const second = `authz-emit-x2-${randomUUID().slice(0, 8)}`;
    const target = alpha.users.departed.membershipId;
    let grantId: string | undefined;

    try {
      const ok = await harness.app.inject({
        method: 'POST',
        url: `/organizations/${alpha.organizationId}/memberships/${target}/grants`,
        headers: await headersForCorrelated(alpha.users.organizationAdmin.id, null, first),
        payload: { membershipId: target, capabilityKey: 'documents.manage', granted: true },
      });
      expect(ok.statusCode, ok.body).toBe(200);
      grantId = ok.json<{ grantId: string }>().grantId;
      expect(await auditRowsFor(first)).toHaveLength(1);

      const clash = await harness.app.inject({
        method: 'POST',
        url: `/organizations/${alpha.organizationId}/memberships/${target}/grants`,
        headers: await headersForCorrelated(alpha.users.organizationAdmin.id, null, second),
        payload: { membershipId: target, capabilityKey: 'documents.manage', granted: false },
      });
      expect(clash.statusCode, 'the overlapping window was accepted (A-12)').toBe(409);
      expect(
        await auditRowsFor(second),
        'a rolled-back mutation left an audit row behind',
      ).toEqual([]);
      log('overlapping grant window: 409, and 0 audit rows for the failed attempt');
    } finally {
      if (grantId !== undefined) await closeGrant(grantId);
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The pure evaluator and the HTTP surface, on the same input
 * ──────────────────────────────────────────────────────────────────────────── */

describe('the surfaces agree on the SAME case, not merely on the same status', () => {
  it('a case the pure evaluator denies at L4.2 is denied at L4.2 over HTTP', async () => {
    const pureCase: CrossProductCase = {
      capabilityKey: 'membership.touch_self',
      scope: 'group',
      orgStatus: 'active',
      groupStatus: 'active',
      entitlement: 'active',
      window: 'within',
      dependencySatisfied: true,
      available: true,
      membershipStatus: 'active',
      membershipWindow: 'within',
      role: 'member',
      organizationMembershipStatus: 'active',
      organizationRole: 'absent',
      grant: 'absent',
      ownership: 'absent',
      proxy: 'none',
      impersonation: 'none',
    };
    const pure = authorize(policyInputFor(pureCase));
    expect(pure.allowed).toBe(false);
    if (pure.allowed) return;

    harness.clearLogs();
    const response = await harness.app.inject({
      method: 'POST',
      url: groupPath,
      headers: await headersFor(alpha.users.member.id, alpha.groupOne.id),
    });

    const denial = harness.logs.find(
      (line) => (line as { authorization?: unknown }).authorization !== undefined,
    ) as { authorization?: { reason?: string; step?: string } } | undefined;

    expect(denial?.authorization?.step, 'the two surfaces denied at different layers').toBe(
      pure.step,
    );
    expect(denial?.authorization?.reason).toBe(pure.reason);
    expect(response.statusCode).toBe(denialDisclosure(pure.reason) === 'forbidden' ? 403 : 404);
    log(`pure evaluator and HTTP both deny at ${pure.step} with ${pure.reason}`);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The two-hop self-grant an independent review found
 * ──────────────────────────────────────────────────────────────────────────── */

describe('a principal cannot grant themselves a capability through a SECOND membership', () => {
  /**
   * **The escalation that shipped in the first version of this task.**
   *
   * The self-grant check compared `body.membershipId` to `context.membershipId`.
   * A *user* holds many memberships — 0001's partial unique indexes explicitly
   * permit an organization membership and a group membership at once — and
   * `org_admin` holds BOTH `organization.membership.administer` and
   * `organization.role.administer`. So:
   *
   *   1. create a group membership for your own user;
   *   2. grant that membership `schedule.publish` — the ids differ, so the check
   *      passed;
   *   3. act in that group.
   *
   * `schedule.publish`, `vacation.commit`, `picklist.administer`,
   * `identity.impersonate` and `audit.export` are all grant-only: in no role's
   * capability set, by design (doc 08 §6's `G` cells). The path issued them to
   * self, in two requests, with no second person involved.
   *
   * Both halves now key on the PRINCIPAL: the route compares `target.user_id` to
   * `context.principalUserId`, and the database trigger compares the two
   * memberships' `user_id`s.
   */
  const adminUser = FIXTURE.alpha.users.organizationAdmin;
  let selfGroupMembershipId: string | undefined;

  afterEach(async () => {
    if (selfGroupMembershipId !== undefined) {
      await admin.query('delete from capability_grants where membership_id = $1', [
        selfGroupMembershipId,
      ]);
      await admin.query('delete from memberships where id = $1', [selfGroupMembershipId]);
      selfGroupMembershipId = undefined;
    }
  });

  it('hop 1 succeeds — an administrator may legitimately give themselves a group membership', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/memberships`,
      headers: {
        ...(await headersFor(adminUser.id, null)),
        'content-type': 'application/json',
      },
      payload: { userId: adminUser.id, groupId: alpha.groupTwo.id, role: 'member' },
    });
    expect(response.statusCode, response.body).toBe(200);
    selfGroupMembershipId = response.json<{ membershipId: string }>().membershipId;
  });

  it('hop 2 is REFUSED: the grant names a membership of the acting principal', async () => {
    const created = await harness.app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/memberships`,
      headers: {
        ...(await headersFor(adminUser.id, null)),
        'content-type': 'application/json',
      },
      payload: { userId: adminUser.id, groupId: alpha.groupTwo.id, role: 'member' },
    });
    expect(created.statusCode, created.body).toBe(200);
    selfGroupMembershipId = created.json<{ membershipId: string }>().membershipId;

    const grant = await harness.app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/memberships/${selfGroupMembershipId}/grants`,
      headers: {
        ...(await headersFor(adminUser.id, null)),
        'content-type': 'application/json',
      },
      payload: {
        membershipId: selfGroupMembershipId,
        capabilityKey: 'schedule.publish',
        granted: true,
      },
    });

    expect(
      grant.statusCode,
      'a principal granted themselves a grant-only capability through a second membership',
    ).toBe(404);

    const rows = await admin.query<{ n: string }>(
      'select count(*)::text as n from capability_grants where membership_id = $1',
      [selfGroupMembershipId],
    );
    expect(rows.rows[0]?.n, 'the self-grant landed anyway').toBe('0');
    log('the two-hop self-grant is refused at the route: the check keys on the principal');
  });

  it('the ROUTE half refuses it on its own — isolated from the trigger', async () => {
    // S-10. The test above proves the request is refused; it does not prove
    // WHICH control refused it, and the trigger would refuse it too — so a
    // revert of the route-side fix alone would leave that test green.
    //
    // The route emits a distinctive security-event log line before it issues any
    // statement. The trigger cannot produce that line, so asserting it isolates
    // the route half exactly.
    const created = await harness.app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/memberships`,
      headers: {
        ...(await headersFor(adminUser.id, null)),
        'content-type': 'application/json',
      },
      payload: { userId: adminUser.id, groupId: alpha.groupTwo.id, role: 'member' },
    });
    expect(created.statusCode, created.body).toBe(200);
    selfGroupMembershipId = created.json<{ membershipId: string }>().membershipId;

    harness.clearLogs();
    const grant = await harness.app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/memberships/${selfGroupMembershipId}/grants`,
      headers: {
        ...(await headersFor(adminUser.id, null)),
        'content-type': 'application/json',
      },
      payload: {
        membershipId: selfGroupMembershipId,
        capabilityKey: 'schedule.publish',
        granted: true,
      },
    });
    expect(grant.statusCode).toBe(404);

    const securityEvent = harness.logs.find((line) =>
      String((line as { msg?: unknown }).msg ?? '').includes(
        'a principal attempted to write a capability grant for one of their own memberships',
      ),
    );
    expect(
      securityEvent,
      'the ROUTE did not refuse it — only the database did, so the route-side fix could be reverted unnoticed',
    ).toBeDefined();
    expect((securityEvent as { securityEvent?: boolean } | undefined)?.securityEvent).toBe(true);
  });

  it('and the DATABASE refuses it too, with the route bypassed entirely', async () => {
    const created = await harness.app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/memberships`,
      headers: {
        ...(await headersFor(adminUser.id, null)),
        'content-type': 'application/json',
      },
      payload: { userId: adminUser.id, groupId: alpha.groupTwo.id, role: 'member' },
    });
    expect(created.statusCode, created.body).toBe(200);
    selfGroupMembershipId = created.json<{ membershipId: string }>().membershipId;
    const targetId = selfGroupMembershipId;

    await expect(
      asAdministrator(async (query) =>
        query
          .insertInto('capability_grants')
          .values({
            id: randomUUID(),
            organization_id: alpha.organizationId,
            group_id: alpha.groupTwo.id,
            membership_id: targetId,
            capability_key: 'schedule.publish',
            granted: true,
          })
          .execute(),
      ),
      'the database permitted a principal to grant one of their own memberships',
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('granting ANOTHER principal the same capability still works — the gate is not a wall', async () => {
    const grantee = FIXTURE.alpha.users.groupTwoScheduler.membershipId;
    const response = await harness.app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/memberships/${grantee}/grants`,
      headers: {
        ...(await headersFor(adminUser.id, null)),
        'content-type': 'application/json',
      },
      payload: { membershipId: grantee, capabilityKey: 'vacation.commit', granted: true },
    });
    expect(response.statusCode, response.body).toBe(200);
    await admin.query(
      `delete from capability_grants where membership_id = $1 and capability_key = 'vacation.commit'`,
      [grantee],
    );
  });
});

describe('a capability grant must carry its membership\'s group', () => {
  it('a mismatched group_id is refused rather than filed where nobody can see it', async () => {
    // Without this the grant would be invisible under the correct group's
    // context — a silent, permanent revocation — while remaining live for an
    // organization-scoped evaluation, which filters by membership_id alone.
    await expect(
      asAdministrator(async (query) =>
        query
          .insertInto('capability_grants')
          .values({
            id: randomUUID(),
            organization_id: alpha.organizationId,
            // The membership is in Group One; the grant claims Group Two.
            group_id: alpha.groupTwo.id,
            membership_id: alpha.users.member.membershipId,
            capability_key: 'vacation.commit',
            granted: true,
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('a system role cannot be deprecated — that would destroy the capability to undo it', async () => {
    // The second self-lockout an independent review found: `roles.status` is
    // application-writable, `app_acting_membership_holds` requires
    // `status = 'active'`, and there is no DELETE grant and no way back.
    await expect(
      asAdministrator(async (query) =>
        query
          .updateTable('roles')
          .set({ status: 'deprecated' })
          .where('organization_id', '=', alpha.organizationId)
          .where('key', '=', 'org_admin')
          .execute(),
      ),
      'a system role was deprecated — the organization can now lock itself out',
    ).rejects.toMatchObject({ code: '42501' });
  });
});
