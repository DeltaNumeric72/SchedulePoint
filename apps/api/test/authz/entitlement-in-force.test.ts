import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { authorize } from '@schedulepoint/domain';

import { loadPolicyInput, pickEntitlementInForce } from '../../src/authz/load-policy-input.js';
import { adminClient } from '../support/admin-client.js';

import { log } from '../support/harness.js';
import { buildHttpHarness, contextHeaders, currentCounters, type HttpHarness } from '../support/http.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * FAD-15 Layer 2 — this file owns its tenant.
 *
 * It used to write to the shared MULTI baseline, which every other file also read.
 * NR-13 measured what that cost: six order-dependent tests across five files, and
 * eleven of twenty-four files modifying rows the shared seed created. The fixture
 * below has the same shape and fresh identifiers, and RLS — not agreement — is what
 * keeps it out of everybody else's queries.
 */
const multi = ownedMulti('authz-entitlement-in-force');


/**
 * **S-01 / S-08 — L1 must read the entitlement IN FORCE, and the write must
 * target it.**
 *
 * `entitlements` is deliberately effective-dated with a `[)` EXCLUDE constraint,
 * so **more than one row per (organization, module) is the designed steady
 * state** — re-windowing leaves a closed historical row beside the live one.
 *
 * The first version of the loader had no window predicate and no `ORDER BY`:
 * whichever row PostgreSQL returned last won. An independent review reproduced
 * the consequence through the shipped runner — **one legitimate administrative
 * write makes every action in that module 404 organization-wide**, with no error
 * raised anywhere and nothing in the logs pointing at the entitlement table. The
 * write path had the same defect in mirror: it UPDATEd every row for the module,
 * rewriting the state of windows that had ended months earlier.
 *
 * Every test here fails on a revert of either fix.
 */

let harness: HttpHarness;
let admin: pg.Client;
/** Lazy: the owned fixture does not exist until `beforeAll` has run. */
const alpha = () => multi().alpha;
const groupPath = () => `/organizations/${alpha().organizationId}/groups/${alpha().groupOne.id}/context-probe/touch`;

/** Rows this file plants, removed after each test. */
const planted: string[] = [];

/**
 * Runs superuser SQL **with the organization administrator declared**.
 *
 * A superuser bypasses RLS but **not triggers**: `entitlements_guard_administration`
 * fires for everyone, and the SECURITY DEFINER counter bump runs as the schema
 * owner, which IS subject to `FORCE ROW LEVEL SECURITY`. So planting or removing
 * an entitlement row out of band still needs a tenant context and an acting
 * administrator — which is the guard working, and is why this helper exists
 * rather than a bare `admin.query`.
 */
async function asAdministratorSql<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  await admin.query('BEGIN');
  try {
    await admin.query(`select set_config('app.organization_id', $1, true)`, [
      alpha().organizationId,
    ]);
    await admin.query(`select set_config('app.group_id', '', true)`);
    await admin.query(`select set_config('app.membership_id', $1, true)`, [
      alpha().users.organizationAdmin.membershipId,
    ]);
    const result = await admin.query<T>(text, values);
    await admin.query('COMMIT');
    return result;
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
}

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  harness = await buildHttpHarness();
});

afterAll(async () => {
  await harness.close();
  await admin.end();
});

afterEach(async () => {
  if (planted.length > 0) {
    // DELETE is granted to no runtime role; the superuser is the only way to
    // clean up, and DELETE fires no guard trigger.
    await admin.query('delete from entitlements where id = any($1::uuid[])', [planted]);
    planted.length = 0;
  }
  // Put the live row back the way the fixture left it.
  await asAdministratorSql(
    `update entitlements set state = 'active',
                             effective_from = '2020-01-01T00:00:00Z',
                             effective_to = null
      where organization_id = $1 and module_key = 'core_scheduling'`,
    [alpha().organizationId],
  );
});

async function headersFor(userId: string, groupId: string | null): Promise<Record<string, string>> {
  return contextHeaders(
    userId,
    await currentCounters(admin, { organizationId: alpha().organizationId, groupId, userId }),
  );
}

/**
 * Plants a CLOSED historical window beside the live one, exactly as an
 * administrative re-window would.
 *
 * Written with the superuser rather than through the route: the point is to
 * reproduce the row shape the exclusion constraint permits, not to test the
 * route that produces it.
 */
async function plantHistoricalRow(state: 'revoked' | 'suspended'): Promise<string> {
  const id = randomUUID();
  planted.push(id);
  await asAdministratorSql(
    `insert into entitlements (id, organization_id, module_key, state, effective_from, effective_to)
     values ($1, $2, 'core_scheduling', $3, '2016-01-01T00:00:00Z', '2017-01-01T00:00:00Z')`,
    [id, alpha().organizationId, state],
  );
  return id;
}

describe('S-01 — a historical entitlement row must not govern', () => {
  it('the baseline allows, so the assertions below measure the planted row', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: groupPath(),
      headers: await headersFor(alpha().users.scheduler.id, alpha().groupOne.id),
    });
    expect(response.statusCode).toBe(200);
  });

  it('a CLOSED, REVOKED historical window alongside the live one changes nothing', async () => {
    // The reviewer's exact scenario. Before the fix this returned 404 for every
    // action in the module, organization-wide.
    await plantHistoricalRow('revoked');

    const rows = await admin.query<{ n: string }>(
      `select count(*)::text as n from entitlements
        where organization_id = $1 and module_key = 'core_scheduling'`,
      [alpha().organizationId],
    );
    expect(rows.rows[0]?.n, 'the fixture no longer has two rows — the test is vacuous').toBe('2');

    const response = await harness.app.inject({
      method: 'POST',
      url: groupPath(),
      headers: await headersFor(alpha().users.scheduler.id, alpha().groupOne.id),
    });
    expect(
      response.statusCode,
      'a historical entitlement row governed the request — S-01 has regressed',
    ).toBe(200);
    log('a closed revoked window beside the live one leaves evaluation unaffected');
  });

  it('a closed SUSPENDED historical window likewise changes nothing', async () => {
    await plantHistoricalRow('suspended');
    const response = await harness.app.inject({
      method: 'POST',
      url: groupPath(),
      headers: await headersFor(alpha().users.scheduler.id, alpha().groupOne.id),
    });
    expect(response.statusCode).toBe(200);
  });

  it('the LIVE row still governs when it is the one that changes', async () => {
    // Both directions. A loader that always ignored the second row would pass
    // the tests above and break the product.
    await plantHistoricalRow('revoked');
    await asAdministratorSql(
      `update entitlements set state = 'suspended'
        where organization_id = $1 and module_key = 'core_scheduling' and effective_to is null`,
      [alpha().organizationId],
    );
    const response = await harness.app.inject({
      method: 'POST',
      url: groupPath(),
      headers: await headersFor(alpha().users.scheduler.id, alpha().groupOne.id),
    });
    expect(response.statusCode, 'the live row stopped governing').toBe(404);
  });

  it('L1.3 is still reachable: with only an EXPIRED row, the denial is EXPIRED not NOT_ENTITLED', async () => {
    // Filtering out-of-window rows in SQL would have been the easy fix and would
    // have deleted a row of the truth table: every expired entitlement would
    // report `NOT_ENTITLED`. The selection rule falls back to the most recently
    // ended row precisely so L1.3 can still fire.
    await asAdministratorSql(
      `update entitlements set effective_from = '2020-01-01T00:00:00Z',
                               effective_to = '2021-01-01T00:00:00Z'
        where organization_id = $1 and module_key = 'core_scheduling'`,
      [alpha().organizationId],
    );
    harness.clearLogs();
    const response = await harness.app.inject({
      method: 'POST',
      url: groupPath(),
      headers: await headersFor(alpha().users.scheduler.id, alpha().groupOne.id),
    });
    expect(response.statusCode).toBe(404);
    const denial = harness.logs.find(
      (line) => (line as { authorization?: unknown }).authorization !== undefined,
    ) as { authorization?: { reason?: string; step?: string } } | undefined;
    expect(denial?.authorization?.reason, 'L1.3 was collapsed into L1.1').toBe(
      'ENTITLEMENT_EXPIRED',
    );
    expect(denial?.authorization?.step).toBe('L1.3');
  });

  it('L1.4 uses the same selection: a DEPENDENCY\'s historical row does not govern', async () => {
    // **REWRITTEN.** The first version planted a row for
    // `organization_administration` — which is not in `core_scheduling`'s
    // closure at all — and then asserted a `core_scheduling` route still worked.
    // A second reviewer showed that mutating the dependency map to take the
    // OLDEST row failed zero tests, so the L1.4 half of S-01 had no evidence
    // behind it while §10 cited this file as proof.
    //
    // `connectors.manage` is in `hospital_integration`, whose closure is
    // hospital_integration → picklist → core_scheduling. No route declares it,
    // so this drives the loader and the evaluator directly — which is the honest
    // way to exercise a layer no surface reaches.
    const planted3: string[] = [];
    const action = {
      key: 'connectors.manage',
      moduleKey: 'hospital_integration' as const,
      scope: 'group' as const,
      requiresObjectPolicy: false,
    };
    const context = {
      principalUserId: alpha().users.scheduler.id,
      expectedOrganizationId: alpha().organizationId,
      expectedGroupId: alpha().groupOne.id,
      membershipId: alpha().users.scheduler.membershipId,
    };

    try {
      // Entitle the whole closure, LIVE, and make the module available.
      for (const moduleKey of ['hospital_integration', 'picklist'] as const) {
        const id = randomUUID();
        planted3.push(id);
        await asAdministratorSql(
          `insert into entitlements (id, organization_id, module_key, state, effective_from, effective_to)
           values ($1, $2, $3, 'active', '2020-01-01T00:00:00Z', null)`,
          [id, alpha().organizationId, moduleKey],
        );
      }
      const availabilityId = randomUUID();
      await asAdministratorSql(
        `insert into group_module_availability (id, organization_id, group_id, module_key, available)
         values ($1, $2, $3, 'hospital_integration', true)`,
        [availabilityId, alpha().organizationId, alpha().groupOne.id],
      );
      // A grant, because `connectors.manage` is carried by no role.
      const grantId = randomUUID();
      await asAdministratorSql(
        `insert into capability_grants (id, organization_id, group_id, membership_id, capability_key, granted)
         values ($1, $2, $3, $4, 'connectors.manage', true)`,
        [grantId, alpha().organizationId, alpha().groupOne.id, alpha().users.scheduler.membershipId],
      );

      const decide = async (): Promise<ReturnType<typeof authorize>> =>
        harness.runtime.runner.run(
          {
            organizationId: alpha().organizationId,
            groupId: alpha().groupOne.id,
            membershipId: alpha().users.scheduler.membershipId,
            correlationId: 'l14-selection',
          },
          async ({ query }) =>
            authorize(await loadPolicyInput(query, { context, action, now: new Date() })),
        );

      const before = await decide();
      expect(before.allowed, 'the baseline denies — the test below would prove nothing').toBe(true);

      // Now plant a CLOSED, REVOKED historical row for the DEPENDENCY `picklist`.
      // If the dependency map took the oldest row, or any row, this denies.
      const historical = randomUUID();
      planted3.push(historical);
      await asAdministratorSql(
        `insert into entitlements (id, organization_id, module_key, state, effective_from, effective_to)
         values ($1, $2, 'picklist', 'revoked', '2016-01-01T00:00:00Z', '2017-01-01T00:00:00Z')`,
        [historical, alpha().organizationId],
      );

      const after = await decide();
      expect(
        after.allowed,
        'a dependency\'s CLOSED historical row governed L1.4 — the dependency map does not select the row in force',
      ).toBe(true);

      // And the live dependency row still governs when IT changes, so the
      // selection is not simply ignoring the second row.
      await asAdministratorSql(
        `update entitlements set state = 'revoked'
          where organization_id = $1 and module_key = 'picklist' and effective_to is null`,
        [alpha().organizationId],
      );
      const revoked = await decide();
      expect(revoked.allowed, 'the LIVE dependency row stopped governing').toBe(false);
      if (!revoked.allowed) expect(revoked.reason).toBe('MODULE_DEPENDENCY_UNSATISFIED');
      log('a dependency\'s historical row is ignored; its live row governs');

      await admin.query('delete from capability_grants where id = $1', [grantId]);
      await admin.query('delete from group_module_availability where id = $1', [availabilityId]);
    } finally {
      if (planted3.length > 0) {
        await admin.query('delete from entitlements where id = any($1::uuid[])', [planted3]);
      }
    }
  });
});

describe('S-08 — the entitlement write must target the row in force', () => {
  it('changing state leaves a historical row untouched', async () => {
    const historicalId = await plantHistoricalRow('revoked');

    const response = await harness.app.inject({
      method: 'PATCH',
      url: `/organizations/${alpha().organizationId}/entitlements/core_scheduling`,
      headers: {
        ...(await headersFor(alpha().users.organizationAdmin.id, null)),
        'content-type': 'application/json',
      },
      payload: { state: 'suspended' },
    });
    expect(response.statusCode, response.body).toBe(200);

    const historical = await admin.query<{ state: string }>(
      'select state from entitlements where id = $1',
      [historicalId],
    );
    expect(
      historical.rows[0]?.state,
      'the write rewrote history — S-08 has regressed',
    ).toBe('revoked');

    const live = await admin.query<{ state: string }>(
      `select state from entitlements
        where organization_id = $1 and module_key = 'core_scheduling' and effective_to is null`,
      [alpha().organizationId],
    );
    expect(live.rows[0]?.state, 'the live row was not changed').toBe('suspended');
    log('the entitlement write touches the in-force row only; history is intact');
  });

  it('with NO row in force, the write is a 404 rather than a history rewrite', async () => {
    await asAdministratorSql(
      `update entitlements set effective_from = '2020-01-01T00:00:00Z',
                               effective_to = '2021-01-01T00:00:00Z'
        where organization_id = $1 and module_key = 'core_scheduling'`,
      [alpha().organizationId],
    );
    const response = await harness.app.inject({
      method: 'PATCH',
      url: `/organizations/${alpha().organizationId}/entitlements/core_scheduling`,
      headers: {
        ...(await headersFor(alpha().users.organizationAdmin.id, null)),
        'content-type': 'application/json',
      },
      payload: { state: 'active' },
    });
    expect(response.statusCode).toBe(404);

    const rows = await admin.query<{ state: string }>(
      `select state from entitlements where organization_id = $1 and module_key = 'core_scheduling'`,
      [alpha().organizationId],
    );
    expect(rows.rows[0]?.state, 'the closed row was rewritten anyway').toBe('active');
  });

  it('re-window then re-evaluate: the correct row governs afterwards', async () => {
    // The full administrative cycle the reviewer asked for.
    const historicalId = await plantHistoricalRow('revoked');

    // Suspend the live row through the route, then restore it.
    for (const state of ['suspended', 'active'] as const) {
      const response = await harness.app.inject({
        method: 'PATCH',
        url: `/organizations/${alpha().organizationId}/entitlements/core_scheduling`,
        headers: {
          ...(await headersFor(alpha().users.organizationAdmin.id, null)),
          'content-type': 'application/json',
        },
        payload: { state },
      });
      expect(response.statusCode, response.body).toBe(200);
    }

    const evaluation = await harness.app.inject({
      method: 'POST',
      url: groupPath(),
      headers: await headersFor(alpha().users.scheduler.id, alpha().groupOne.id),
    });
    expect(evaluation.statusCode, 'the historical row governed after a re-window').toBe(200);

    const historical = await admin.query<{ state: string }>(
      'select state from entitlements where id = $1',
      [historicalId],
    );
    expect(historical.rows[0]?.state).toBe('revoked');
  });
});

describe('the selection rule itself', () => {
  const at = new Date('2026-08-02T12:00:00.000Z');
  const row = (
    from: string,
    to: string | null,
    state: 'active' | 'revoked' = 'active',
  ): Parameters<typeof pickEntitlementInForce>[0][number] => ({
    moduleKey: 'core_scheduling',
    state,
    effectiveFrom: from,
    effectiveTo: to,
  });

  it('prefers the row in force over any number of closed ones', () => {
    const chosen = pickEntitlementInForce(
      [
        row('2019-01-01T00:00:00Z', '2020-01-01T00:00:00Z', 'revoked'),
        row('2026-01-01T00:00:00Z', null),
        row('2020-01-01T00:00:00Z', '2021-01-01T00:00:00Z', 'revoked'),
      ],
      at,
    );
    expect(chosen?.effectiveFrom).toBe('2026-01-01T00:00:00Z');
  });

  it('falls back to the most recently ENDED row so L1.3 can fire', () => {
    const chosen = pickEntitlementInForce(
      [
        row('2019-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
        row('2021-01-01T00:00:00Z', '2022-01-01T00:00:00Z'),
      ],
      at,
    );
    expect(chosen?.effectiveFrom).toBe('2021-01-01T00:00:00Z');
  });

  it('falls back to the earliest FUTURE row when nothing has started', () => {
    const chosen = pickEntitlementInForce(
      [row('2030-01-01T00:00:00Z', null), row('2027-01-01T00:00:00Z', '2028-01-01T00:00:00Z')],
      at,
    );
    expect(chosen?.effectiveFrom).toBe('2027-01-01T00:00:00Z');
  });

  it('an UNPARSABLE upper bound is not open-ended', () => {
    // A corrupt row must not read as unlimited entitlement.
    expect(pickEntitlementInForce([row('2026-01-01T00:00:00Z', 'unparsable-instant')], at)).toEqual(
      // Not in force, and it is the only row, so it is returned for L1.3 to deny.
      expect.objectContaining({ effectiveTo: 'unparsable-instant' }),
    );
  });

  it('no rows at all is null — L1.1', () => {
    expect(pickEntitlementInForce([], at)).toBeNull();
  });
});

describe('S-06 (second half) — HTTP coverage for L1.1', () => {
  /**
   * An independent review noted that L1.1, L1.4, L5.1, L6.1 and L6.2 had no HTTP
   * coverage at all. L5.1 gained it with the object-policy fix
   * (`context-surface.test.ts`, T-05). This is L1.1.
   *
   * L1.4, L6.1 and L6.2 remain evaluator-only, and the reason is disclosed in
   * `docs/evidence/EV-M1-AUTHZ/INDEX.md` §5.2 rather than papered over: no route
   * in this milestone declares an action in a module WITH dependencies, and
   * SPEC-01 §2.2's declaration carries no proxy or impersonation channel, so
   * neither is reachable over the wire.
   */
  it('with NO entitlement row at all, the denial is NOT_ENTITLED at L1.1', async () => {
    // DELETE fires no guard trigger, and no runtime role holds the grant — the
    // superuser is the only way to reach the "no row exists" state, which is
    // itself the reason L1.1 is hard to produce through the product.
    const removed = await admin.query<{ id: string; state: string; effective_from: Date; effective_to: Date | null }>(
      `delete from entitlements
        where organization_id = $1 and module_key = 'core_scheduling'
        returning id, state, effective_from, effective_to`,
      [alpha().organizationId],
    );
    expect(removed.rows.length, 'nothing was removed — the test would be vacuous').toBeGreaterThan(0);

    try {
      harness.clearLogs();
      const response = await harness.app.inject({
        method: 'POST',
        url: groupPath(),
        headers: await headersFor(alpha().users.scheduler.id, alpha().groupOne.id),
      });
      // P-5: the existence of an unentitled module is not disclosed.
      expect(response.statusCode).toBe(404);
      const denial = harness.logs.find(
        (line) => (line as { authorization?: unknown }).authorization !== undefined,
      ) as { authorization?: { reason?: string; step?: string } } | undefined;
      expect(denial?.authorization?.reason).toBe('NOT_ENTITLED');
      expect(denial?.authorization?.step).toBe('L1.1');
      log('no entitlement row: 404 at L1.1, over HTTP');
    } finally {
      for (const row of removed.rows) {
        await asAdministratorSql(
          `insert into entitlements (id, organization_id, module_key, state, effective_from, effective_to)
           values ($1, $2, 'core_scheduling', $3, $4, $5)`,
          [row.id, alpha().organizationId, row.state, row.effective_from, row.effective_to],
        );
      }
    }
  });
});
