import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { provisionAuthorization } from '../../src/authz/provisioning.js';
import { adminClient } from '../support/admin-client.js';
import { FIXTURE, organizationContext } from '../support/fixtures.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { buildHttpHarness, contextHeaders, type HttpHarness } from '../support/http.js';

/**
 * The provisioning door, and the fact that it shuts.
 *
 * `0002_authorization.sql`'s `app_require_capability` waives the capability
 * check for an ORGANIZATION-scoped context in an organization that has no
 * memberships. That is the only way a tenant can come into existence, and an
 * escape hatch that is only ever observed working is not evidence of anything —
 * so this file walks through it once and then proves it is shut.
 *
 * ## Synthetic, and disposable
 *
 * Every organization created here is a fresh UUID, is named "(synthetic)", and
 * is torn down by id. Nothing touches the MULTI fixture the rest of the suite
 * depends on.
 */

let admin: pg.Client;
let runtime: Runtime;
let harness: HttpHarness;
const created: string[] = [];

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  runtime = createRuntime('app_runtime', { max: 3 });
  harness = await buildHttpHarness();
});

afterAll(async () => {
  // Reverse dependency order. DELETE is granted to no runtime role, which is
  // why the cleanup is the superuser's — and why production cannot do this.
  for (const organizationId of created) {
    await admin.query('delete from capability_grants where organization_id = $1', [organizationId]);
    await admin.query('delete from role_capabilities where organization_id = $1', [organizationId]);
    await admin.query('delete from roles where organization_id = $1', [organizationId]);
    await admin.query('delete from group_module_availability where organization_id = $1', [
      organizationId,
    ]);
    await admin.query('delete from entitlements where organization_id = $1', [organizationId]);
    await admin.query('delete from memberships where organization_id = $1', [organizationId]);
    await admin.query('delete from groups where organization_id = $1', [organizationId]);
    await admin.query('delete from organizations where id = $1', [organizationId]);
  }
  await harness.close();
  await runtime.destroy();
  await admin.end();
});

interface Provisioned {
  readonly organizationId: string;
  readonly groupId: string;
  readonly userId: string;
  readonly adminMembershipId: string;
}

/** Creates a fresh organization exactly the way `seedFixture` does. */
async function provision(): Promise<Provisioned> {
  const organizationId = randomUUID();
  const groupId = randomUUID();
  const userId = randomUUID();
  const adminMembershipId = randomUUID();
  created.push(organizationId);

  await runtime.runner.run(organizationContext(organizationId, 'provisioning-test'), async ({ query }) => {
    await query
      .insertInto('organizations')
      .values({ id: organizationId, name: `Provisioning Test ${organizationId} (synthetic)` })
      .execute();
    await query
      .insertInto('groups')
      .values({ id: groupId, organization_id: organizationId, name: 'Provisioning Group One' })
      .execute();
    await query
      .insertInto('users')
      .values({
        id: userId,
        login_email: `provisioning-${userId}@example.invalid`,
        display_name: 'Provisioning Administrator (synthetic)',
      })
      .execute();

    await provisionAuthorization(query, { organizationId, groupIds: [groupId] });

    // The LAST statement that walks through the door: the trigger fires before
    // the row exists, so `memberships` is still empty when it checks.
    await query
      .insertInto('memberships')
      .values({
        id: adminMembershipId,
        organization_id: organizationId,
        group_id: null,
        user_id: userId,
        kind: 'organization',
        organization_role: 'org_admin',
        group_role: null,
      })
      .execute();
  });

  return { organizationId, groupId, userId, adminMembershipId };
}

describe('the provisioning door opens once', () => {
  it('a fresh organization can be provisioned with no acting membership', async () => {
    const { organizationId, groupId } = await provision();

    const state = await admin.query<{ roles: string; caps: string; ents: string; avail: string }>(
      `select (select count(*) from roles where organization_id = $1)::text as roles,
              (select count(*) from role_capabilities where organization_id = $1)::text as caps,
              (select count(*) from entitlements where organization_id = $1)::text as ents,
              (select count(*) from group_module_availability where group_id = $2)::text as avail`,
      [organizationId, groupId],
    );
    const row = state.rows[0];
    expect(Number(row?.roles), 'no roles were provisioned').toBeGreaterThan(0);
    expect(Number(row?.caps), 'no role capabilities were provisioned').toBeGreaterThan(0);
    // core_scheduling + organization_administration + entitlements.
    expect(row?.ents).toBe('3');
    expect(Number(row?.avail)).toBe(3);
    log(`provisioned ${String(row?.roles)} roles, ${String(row?.caps)} role capabilities, 3 entitlements`);
  });
});

describe('and then it is shut', () => {
  it('a SECOND membership with no acting administrator is refused', async () => {
    const { organizationId } = await provision();
    await expect(
      runtime.runner.run(organizationContext(organizationId, 'door-shut'), async ({ query }) =>
        query
          .insertInto('memberships')
          .values({
            id: randomUUID(),
            organization_id: organizationId,
            group_id: null,
            user_id: FIXTURE.alpha.users.member.id,
            kind: 'organization',
            organization_role: 'org_admin',
            group_role: null,
          })
          .execute(),
      ),
      'the provisioning door is still open after the first membership',
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('a second ROLE with no acting administrator is refused', async () => {
    const { organizationId } = await provision();
    await expect(
      runtime.runner.run(organizationContext(organizationId, 'door-shut-roles'), async ({ query }) =>
        query
          .insertInto('roles')
          .values({
            id: randomUUID(),
            organization_id: organizationId,
            scope: 'group',
            key: 'invented_role',
            name: 'Invented',
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('a second ENTITLEMENT with no acting administrator is refused', async () => {
    const { organizationId } = await provision();
    await expect(
      runtime.runner.run(organizationContext(organizationId, 'door-shut-ents'), async ({ query }) =>
        query
          .insertInto('entitlements')
          .values({
            id: randomUUID(),
            organization_id: organizationId,
            module_key: 'picklist',
            state: 'active',
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('the door never opens under a GROUP-scoped context, even in an empty group', async () => {
    // Under a group context `memberships_group_scope` narrows the count to the
    // declared group, so "no memberships" would mean "none in THIS group" and an
    // empty group would reopen the door. `app_require_capability` refuses to
    // consider the bootstrap branch at all unless `app.group_id` is unset.
    const { organizationId, groupId } = await provision();
    await expect(
      runtime.runner.run(
        { organizationId, groupId, membershipId: null, correlationId: 'empty-group' },
        async ({ query }) =>
          query
            .insertInto('memberships')
            .values({
              id: randomUUID(),
              organization_id: organizationId,
              group_id: groupId,
              user_id: FIXTURE.alpha.users.member.id,
              kind: 'group',
              group_role: 'member',
              organization_role: null,
            })
            .execute(),
      ),
      'the bootstrap door opened under a group-scoped context in an empty group',
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('the provisioned administrator CAN continue — the door shutting is not a lockout', async () => {
    const { organizationId, groupId, adminMembershipId } = await provision();
    const secondUser = randomUUID();
    const secondMembership = randomUUID();

    await runtime.runner.run(
      { organizationId, groupId: null, membershipId: adminMembershipId, correlationId: 'admin-continues' },
      async ({ query }) => {
        await query
          .insertInto('users')
          .values({
            id: secondUser,
            login_email: `provisioning-second-${secondUser}@example.invalid`,
            display_name: 'Second Member (synthetic)',
          })
          .execute();
        await query
          .insertInto('memberships')
          .values({
            id: secondMembership,
            organization_id: organizationId,
            group_id: groupId,
            user_id: secondUser,
            kind: 'group',
            group_role: 'scheduler',
            organization_role: null,
          })
          .execute();
      },
    );

    const landed = await admin.query<{ n: string }>(
      'select count(*)::text as n from memberships where id = $1',
      [secondMembership],
    );
    expect(landed.rows[0]?.n).toBe('1');
    log('the provisioned org_admin can create further memberships — the gate is capability-based');
  });
});

describe('an UNPROVISIONED organization denies everything', () => {
  it('a membership with no roles seeded resolves to no capabilities at all', async () => {
    // The fail-closed direction of the whole design: an organization whose
    // `roles` rows are missing has memberships that carry a role KEY with no
    // capability set behind it, so L4.2 denies. A half-configured tenant is
    // inert rather than unpredictable.
    const organizationId = randomUUID();
    const userId = randomUUID();
    const membershipId = randomUUID();
    created.push(organizationId);

    await runtime.runner.run(organizationContext(organizationId, 'unprovisioned'), async ({ query }) => {
      await query
        .insertInto('organizations')
        .values({ id: organizationId, name: 'Unprovisioned (synthetic)' })
        .execute();
      await query
        .insertInto('users')
        .values({
          id: userId,
          login_email: `unprovisioned-${userId}@example.invalid`,
          display_name: 'Unprovisioned Administrator (synthetic)',
        })
        .execute();
      await query
        .insertInto('memberships')
        .values({
          id: membershipId,
          organization_id: organizationId,
          group_id: null,
          user_id: userId,
          kind: 'organization',
          organization_role: 'org_admin',
          group_role: null,
        })
        .execute();
    });

    // The membership exists and names `org_admin`, but no `roles` row does — so
    // the database-level capability probe answers false, and the next
    // administrative statement is refused.
    await expect(
      runtime.runner.run(
        { organizationId, groupId: null, membershipId, correlationId: 'unprovisioned-act' },
        async ({ query }) =>
          query
            .insertInto('entitlements')
            .values({
              id: randomUUID(),
              organization_id: organizationId,
              module_key: 'core_scheduling',
              state: 'active',
            })
            .execute(),
      ),
      'an unprovisioned organization granted an administrative write',
    ).rejects.toMatchObject({ code: '42501' });
    log('a role key with no `roles` row behind it grants nothing — fail-closed');
  });
});

describe('the bootstrap door is unreachable over HTTP — residual 7, revisited', () => {
  /**
   * **The question an adversarial reader should ask, asked here.**
   *
   * `app_require_capability` waives the capability check for an organization
   * with no memberships. EV-M1-TENANCY residual 7 records that any unit of work
   * can INSERT an `organizations` row for a UUID it declared. Put the two
   * together and there is an obvious attack: create a fresh organization, walk
   * through its open door, and attach an arbitrary global `user_id` — which
   * fires 0001's counter trigger and irreversibly raises a FOREIGN user's
   * `membership_set_version`. That is residual 1's availability half, reached by
   * a different route.
   *
   * **It is not reachable through the application, and the reason is structural
   * rather than lucky:** no HTTP path opens a unit of work for an organization
   * the caller is not already a member of. SPEC-01 §2.3 step 2 resolves the
   * acting membership BEFORE the command transaction exists, and a
   * membership-less organization has none — so the request is a 404 and no
   * transaction with that organization in context is ever opened.
   *
   * Asserted rather than argued, because "no route does that" is a claim about
   * every route that will ever exist.
   */
  it('a request declaring a freshly created, membership-less organization is a 404', async () => {
    const organizationId = randomUUID();
    created.push(organizationId);

    // The residual-7 statement itself: an actor declares a UUID and creates it.
    await runtime.runner.run(organizationContext(organizationId, 'residual-7'), async ({ query }) => {
      await query
        .insertInto('organizations')
        .values({ id: organizationId, name: 'Attacker Organization (synthetic)' })
        .execute();
    });

    const landed = await admin.query<{ n: string }>(
      'select count(*)::text as n from organizations where id = $1',
      [organizationId],
    );
    expect(landed.rows[0]?.n, 'residual 7 has been closed — update this test and the evidence').toBe(
      '1',
    );

    // And now the door. Every membership-creating surface is behind §2.3 step 2.
    const response = await harness.app.inject({
      method: 'POST',
      url: `/organizations/${organizationId}/memberships`,
      headers: {
        ...contextHeaders(FIXTURE.alpha.users.organizationAdmin.id, {
          organizationVersion: 1,
          groupVersion: null,
          membershipSetVersion: 1,
          sessionEpoch: 1,
        }),
        'content-type': 'application/json',
      },
      payload: {
        userId: FIXTURE.beta.users.scheduler.id,
        groupId: null,
        role: 'org_admin',
      },
    });

    expect(
      response.statusCode,
      'the bootstrap door is reachable over HTTP through a self-created organization',
    ).toBe(404);

    const memberships = await admin.query<{ n: string }>(
      'select count(*)::text as n from memberships where organization_id = $1',
      [organizationId],
    );
    expect(memberships.rows[0]?.n).toBe('0');
    log(
      'a self-created, membership-less organization is inert over HTTP: §2.3 step 2 refuses before ' +
        'any command transaction opens, so the provisioning door is never entered',
    );
  });

  it("and the foreign user's monotonic counter did not move", async () => {
    // The consequence residual 1 called irreversible, checked directly.
    const organizationId = randomUUID();
    created.push(organizationId);
    const victim = FIXTURE.beta.users.scheduler.id;

    const before = await admin.query<{ v: string }>(
      'select membership_set_version as v from users where id = $1',
      [victim],
    );

    await runtime.runner.run(organizationContext(organizationId, 'residual-7b'), async ({ query }) => {
      await query
        .insertInto('organizations')
        .values({ id: organizationId, name: 'Attacker Organization 2 (synthetic)' })
        .execute();
    });

    await harness.app.inject({
      method: 'POST',
      url: `/organizations/${organizationId}/memberships`,
      headers: {
        ...contextHeaders(FIXTURE.alpha.users.organizationAdmin.id, {
          organizationVersion: 1,
          groupVersion: null,
          membershipSetVersion: 1,
          sessionEpoch: 1,
        }),
        'content-type': 'application/json',
      },
      payload: { userId: victim, groupId: null, role: 'org_admin' },
    });

    const after = await admin.query<{ v: string }>(
      'select membership_set_version as v from users where id = $1',
      [victim],
    );
    expect(
      Number(after.rows[0]?.v),
      "a foreign user's irreversible freshness counter was raised from outside their organization",
    ).toBe(Number(before.rows[0]?.v));
  });
});

describe('S-02 — an organization cannot be left without an administrator', () => {
  /**
   * **The third self-lockout, and the one that was neither closed nor recorded.**
   *
   * A sole `org_admin` could end their own membership in one authorized request.
   * Nothing could undo it: the guard trigger fires for the schema owner and for
   * a superuser (a trigger is not RLS), `memberships` has no DELETE grant,
   * `app_acting_membership_holds` requires an ACTIVE membership, and
   * `app_breakglass` holds SELECT only. The organization would be permanently
   * unadministrable.
   *
   * Found by an independent review, which noted the same class had already been
   * closed for `roles` and recorded as unclosable for `entitlements`. It IS
   * closable here, for the reason the rest of this migration works: a TRIGGER on
   * `memberships` may query `memberships`; only a POLICY may not.
   */
  it('a sole administrator cannot end their own membership', async () => {
    const { organizationId, adminMembershipId } = await provision();
    await expect(
      runtime.runner.run(
        { organizationId, groupId: null, membershipId: adminMembershipId, correlationId: 's02-self' },
        async ({ query }) =>
          query
            .updateTable('memberships')
            .set({ status: 'ended' })
            .where('id', '=', adminMembershipId)
            .execute(),
      ),
      'the sole administrator locked the organization out of itself',
    ).rejects.toMatchObject({ code: '42501' });

    const still = await admin.query<{ status: string }>(
      'select status from memberships where id = $1',
      [adminMembershipId],
    );
    expect(still.rows[0]?.status).toBe('active');
    log('a sole administrator cannot end their own membership');
  });

  it('nor demote themselves by changing their organization role', async () => {
    const { organizationId, adminMembershipId } = await provision();
    await expect(
      runtime.runner.run(
        { organizationId, groupId: null, membershipId: adminMembershipId, correlationId: 's02-demote' },
        async ({ query }) =>
          query
            .updateTable('memberships')
            .set({ organization_role: 'org_observer' })
            .where('id', '=', adminMembershipId)
            .execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('nor close their own validity window', async () => {
    const { organizationId, adminMembershipId } = await provision();
    await expect(
      runtime.runner.run(
        { organizationId, groupId: null, membershipId: adminMembershipId, correlationId: 's02-window' },
        async ({ query }) =>
          query
            .updateTable('memberships')
            .set({ valid_to: new Date('2021-01-01T00:00:00.000Z') })
            .where('id', '=', adminMembershipId)
            .execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('SELF-demotion is refused even when another administrator exists', async () => {
    // The count would permit it; the two-person rule does not. An administrator
    // removing their own authority is the one case where "ask a colleague" costs
    // nothing and a mistake costs the organization — the same rule capability
    // grants already follow.
    const { organizationId, groupId, adminMembershipId, userId } = await provision();
    const secondUser = randomUUID();
    const secondAdmin = randomUUID();

    await runtime.runner.run(
      { organizationId, groupId: null, membershipId: adminMembershipId, correlationId: 's02-second' },
      async ({ query }) => {
        await query
          .insertInto('users')
          .values({
            id: secondUser,
            login_email: `s02-second-${secondUser}@example.invalid`,
            display_name: 'Second Administrator (synthetic)',
          })
          .execute();
        await query
          .insertInto('memberships')
          .values({
            id: secondAdmin,
            organization_id: organizationId,
            group_id: null,
            user_id: secondUser,
            kind: 'organization',
            organization_role: 'org_admin',
            group_role: null,
          })
          .execute();
      },
    );
    expect(groupId).toBeDefined();
    expect(userId).toBeDefined();

    await expect(
      runtime.runner.run(
        { organizationId, groupId: null, membershipId: adminMembershipId, correlationId: 's02-self2' },
        async ({ query }) =>
          query
            .updateTable('memberships')
            .set({ status: 'ended' })
            .where('id', '=', adminMembershipId)
            .execute(),
      ),
      'self-demotion was permitted because a second administrator exists',
    ).rejects.toMatchObject({ code: '42501' });

    // But the SECOND administrator may end the first — which is the recovery
    // path, and the reason the rule is not a trap.
    await runtime.runner.run(
      { organizationId, groupId: null, membershipId: secondAdmin, correlationId: 's02-other' },
      async ({ query }) =>
        query
          .updateTable('memberships')
          .set({ status: 'ended' })
          .where('id', '=', adminMembershipId)
          .execute(),
    );
    const ended = await admin.query<{ status: string }>(
      'select status from memberships where id = $1',
      [adminMembershipId],
    );
    expect(ended.rows[0]?.status, 'a second administrator could not end the first').toBe('ended');
    log('another administrator CAN end the first — the guard is a two-person rule, not a wall');
  });

  it('a NON-administrator membership can still be ended normally', () => {
    // The check must not fire for ordinary memberships, or every departure
    // becomes an error.
    return (async () => {
      const { organizationId, groupId, adminMembershipId } = await provision();
      const memberUser = randomUUID();
      const memberMembership = randomUUID();
      await runtime.runner.run(
        { organizationId, groupId: null, membershipId: adminMembershipId, correlationId: 's02-member' },
        async ({ query }) => {
          await query
            .insertInto('users')
            .values({
              id: memberUser,
              login_email: `s02-member-${memberUser}@example.invalid`,
              display_name: 'Ordinary Member (synthetic)',
            })
            .execute();
          await query
            .insertInto('memberships')
            .values({
              id: memberMembership,
              organization_id: organizationId,
              group_id: groupId,
              user_id: memberUser,
              kind: 'group',
              group_role: 'member',
              organization_role: null,
            })
            .execute();
          await query
            .updateTable('memberships')
            .set({ status: 'ended' })
            .where('id', '=', memberMembership)
            .execute();
        },
      );
      const ended = await admin.query<{ status: string }>(
        'select status from memberships where id = $1',
        [memberMembership],
      );
      expect(ended.rows[0]?.status).toBe('ended');
    })();
  });
});

describe('S-11 — derived ids do not collide across organizations', () => {
  /**
   * The first version derived role ids from the organization id's **first eight
   * hex characters** plus a 32-bit hash. Two organizations sharing eight leading
   * hex characters produced identical role primary keys — and `roles.id` is a
   * primary key, so the collision surfaces as a 23505 from a check that
   * **bypasses RLS**, reporting against a row the caller cannot see. An
   * independent review found it.
   */
  it('two organizations sharing eight leading hex characters get distinct role ids', async () => {
    // The exact adversarial shape: identical first block, everything else
    // different. Under the old scheme these two produced byte-identical ids.
    const first = 'aaaaaaaa-1111-4111-8111-111111111111';
    const second = 'aaaaaaaa-2222-4222-8222-222222222222';

    const ids = new Map<string, string[]>();
    for (const organizationId of [first, second]) {
      created.push(organizationId);
      await runtime.runner.run(
        organizationContext(organizationId, 's11'),
        async ({ query }) => {
          await query
            .insertInto('organizations')
            .values({ id: organizationId, name: `S11 ${organizationId} (synthetic)` })
            .execute();
          const roles = await provisionAuthorization(query, { organizationId });
          ids.set(
            organizationId,
            roles.map((role) => role.id),
          );
        },
      );
    }

    const firstIds = ids.get(first) ?? [];
    const secondIds = ids.get(second) ?? [];
    expect(firstIds.length, 'no roles were provisioned').toBeGreaterThan(0);
    const overlap = firstIds.filter((id) => secondIds.includes(id));
    expect(
      overlap,
      'two organizations produced identical role primary keys — S-11 has regressed',
    ).toEqual([]);
    log(`${String(firstIds.length)} roles per organization, 0 id collisions across the two`);
  });

  it('the derivation is still DETERMINISTIC — the same organization gets the same ids', async () => {
    // A random id would satisfy the test above and break the fixture's ability
    // to assert against rows it did not write.
    const organizationId = 'bbbbbbbb-3333-4333-8333-333333333333';
    created.push(organizationId);
    let firstRun: readonly string[] = [];
    await runtime.runner.run(organizationContext(organizationId, 's11b'), async ({ query }) => {
      await query
        .insertInto('organizations')
        .values({ id: organizationId, name: 'S11 determinism (synthetic)' })
        .execute();
      firstRun = (await provisionAuthorization(query, { organizationId })).map((r) => r.id);
    });

    // Re-deriving without writing must produce the same values.
    await expect(
      runtime.runner.run(organizationContext(organizationId, 's11c'), async ({ query }) =>
        provisionAuthorization(query, { organizationId }),
      ),
      'a second provisioning run did not collide with the first — the ids are not deterministic',
    ).rejects.toMatchObject({ code: '23505' });
    expect(firstRun.length).toBeGreaterThan(0);
  });

  it('every derived id is a well-formed UUID', async () => {
    const organizationId = 'cccccccc-4444-4444-8444-444444444444';
    created.push(organizationId);
    await runtime.runner.run(organizationContext(organizationId, 's11d'), async ({ query }) => {
      await query
        .insertInto('organizations')
        .values({ id: organizationId, name: 'S11 shape (synthetic)' })
        .execute();
      const roles = await provisionAuthorization(query, { organizationId });
      for (const role of roles) {
        expect(role.id, `${role.key} is not a v4-shaped UUID`).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
      }
    });
  });
});
