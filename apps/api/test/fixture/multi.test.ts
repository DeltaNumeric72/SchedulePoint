import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { adminClient } from '../support/admin-client.js';
import { groupContext, organizationContext } from '../support/fixtures.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { buildMultiFixture, type MultiFixture } from '../support/multi.js';
import { ownedMulti } from '../support/owned-multi.js';

/* ────────────────────────────────────────────────────────────────────────────
 * MULTI — the multi-organization fixture environment (OPUS-M2-001 deliverable C,
 * doc 16 §3).
 *
 * Two fixtures are provisioned, with the `full` profile:
 *
 *   `multi`  the subject of the ten support points below;
 *   `twin`   an independently provisioned fixture, used only for the determinism
 *            comparison — two provisions from clean must produce canonically
 *            identical CONTENT.
 *
 * FAD-15 ruling 4 governs the comparison: identifiers and slug-derived addresses
 * are minted per fixture by construction, so the comparison canonicalises them
 * away and this file states exactly what it canonicalises (see
 * `canonicalContent`). Comparing raw rows would be comparing UUIDs, which two
 * fixtures are *required* to differ in.
 * ──────────────────────────────────────────────────────────────────────────── */

const multi = ownedMulti('fixture-multi', { profile: 'full' });
const twin = ownedMulti('fixture-multi-twin', { profile: 'full' });

let admin: pg.Client;
let runtime: Runtime;

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  runtime = createRuntime('app_runtime');
});

afterAll(async () => {
  await runtime.destroy();
  await admin.end();
});

/* ────────────────────────────────────────────────────────────────────────────
 * Canonicalisation
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The content of a provisioned fixture, with everything that is minted per
 * fixture replaced by its structural position.
 *
 * **Canonicalised away, deliberately and exhaustively:**
 *  - every UUID (organization, group, membership, user, role, grant, event);
 *  - the slug, wherever it appears — in a login address or a display name;
 *  - every timestamp (`created_at`, `last_active_at`, validity bounds), which
 *    the packet excepts by name;
 *  - hash and signature bytes, which are functions of the above.
 *
 * **Not canonicalised, therefore compared:** organization names, group names,
 * role keys and scopes, capability keys and their granted flag, module keys and
 * entitlement states, membership kind / role / status, and which group each
 * membership belongs to.
 *
 * **Row COUNTS are compared for four tables only** — audit_events,
 * audit_checkpoints, outbox_events and outbox_effects. An earlier version of this
 * comment implied all thirteen. `role_capabilities` and `group_module_availability`
 * are NOT compared at all: they are written wholly by `provisionAuthorization`
 * from a static catalogue, so two provisions cannot differ in them without the
 * catalogue itself changing, which the roles comparison above would show. Stated
 * rather than quietly omitted.
 */
async function canonicalContent(fixture: MultiFixture): Promise<unknown> {
  const label = new Map<string, string>();
  label.set(fixture.alpha.organizationId, 'ALPHA');
  label.set(fixture.beta.organizationId, 'BETA');
  if (fixture.gamma !== undefined) label.set(fixture.gamma.organizationId, 'GAMMA');
  label.set(fixture.alpha.groupOne.id, 'ALPHA/G1');
  label.set(fixture.alpha.groupTwo.id, 'ALPHA/G2');
  label.set(fixture.beta.groupOne.id, 'BETA/G1');
  label.set(fixture.beta.groupTwo.id, 'BETA/G2');
  if (fixture.gamma !== undefined) {
    label.set(fixture.gamma.groupOne.id, 'GAMMA/G1');
    label.set(fixture.gamma.groupTwo.id, 'GAMMA/G2');
  }

  const slugPattern = new RegExp(fixture.slug, 'g');
  const anonymise = (value: string | null): string | null =>
    value === null ? null : value.replace(slugPattern, '<SLUG>');
  const named = (id: string | null): string => (id === null ? '-' : (label.get(id) ?? '<MINTED>'));

  const organizationIds = fixture.organizationIds;

  const groups = await admin.query<{ organization_id: string; name: string }>(
    `select organization_id, name from groups
      where organization_id = any($1::uuid[]) order by name`,
    [organizationIds],
  );

  const memberships = await admin.query<{
    organization_id: string;
    group_id: string | null;
    kind: string;
    group_role: string | null;
    organization_role: string | null;
    status: string;
    display_name: string;
    login_email: string;
  }>(
    `select m.organization_id, m.group_id, m.kind, m.group_role, m.organization_role, m.status,
            u.display_name, u.login_email
       from memberships m join users u on u.id = m.user_id
      where m.organization_id = any($1::uuid[])
      order by m.organization_id, m.kind, m.group_id nulls first,
               m.organization_role nulls last, m.group_role nulls last, u.login_email`,
    [organizationIds],
  );

  const roles = await admin.query<{ organization_id: string; scope: string; key: string }>(
    `select organization_id, scope, key from roles
      where organization_id = any($1::uuid[]) order by organization_id, scope, key`,
    [organizationIds],
  );

  const grants = await admin.query<{
    organization_id: string;
    group_id: string | null;
    capability_key: string;
    granted: boolean;
  }>(
    `select organization_id, group_id, capability_key, granted from capability_grants
      where organization_id = any($1::uuid[])
      order by organization_id, group_id, capability_key, granted`,
    [organizationIds],
  );

  const entitlements = await admin.query<{
    organization_id: string;
    module_key: string;
    state: string;
  }>(
    `select organization_id, module_key, state from entitlements
      where organization_id = any($1::uuid[]) order by organization_id, module_key`,
    [organizationIds],
  );

  const counts = await admin.query<{ tbl: string; organization_id: string; n: string }>(
    `select 'audit_events' as tbl, organization_id, count(*)::text as n from audit_events
       where organization_id = any($1::uuid[]) group by 1, 2
     union all
     select 'audit_checkpoints', organization_id, count(*)::text from audit_checkpoints
       where organization_id = any($1::uuid[]) group by 1, 2
     union all
     select 'outbox_events', organization_id, count(*)::text from outbox_events
       where organization_id = any($1::uuid[]) group by 1, 2
     union all
     select 'outbox_effects', organization_id, count(*)::text from outbox_effects
       where organization_id = any($1::uuid[]) group by 1, 2
     order by 1, 2`,
    [organizationIds],
  );

  // Sorted AFTER canonicalisation, never before. The SQL `order by` runs on raw
  // UUIDs, which are minted per fixture — so ordering by them makes two identical
  // fixtures compare unequal for the one reason the comparison must ignore.
  const sorted = (values: string[]): string[] => [...values].sort();

  return {
    groups: sorted(groups.rows.map((row) => `${named(row.organization_id)} ${row.name}`)),
    memberships: sorted(
      memberships.rows.map(
        (row) =>
          `${named(row.organization_id)} ${named(row.group_id)} ${row.kind} ` +
          `org=${row.organization_role ?? '-'} grp=${row.group_role ?? '-'} ${row.status} ` +
          `${String(anonymise(row.display_name))} ${String(anonymise(row.login_email))}`,
      ),
    ),
    roles: sorted(roles.rows.map((row) => `${named(row.organization_id)} ${row.scope}:${row.key}`)),
    grants: sorted(
      grants.rows.map(
        (row) =>
          `${named(row.organization_id)} ${named(row.group_id)} ${row.capability_key}=${String(row.granted)}`,
      ),
    ),
    entitlements: sorted(
      entitlements.rows.map((row) => `${named(row.organization_id)} ${row.module_key}=${row.state}`),
    ),
    counts: sorted(counts.rows.map((row) => `${row.tbl} ${named(row.organization_id)} ${row.n}`)),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Determinism
 * ──────────────────────────────────────────────────────────────────────────── */

describe('MULTI determinism — two provisions produce canonically identical content', () => {
  it('identifier minting is deterministic for a given slug', () => {
    // The shape, before any database is involved. Same slug in, same identifiers
    // out — which is what makes a fixture reproducible from its name rather than
    // from a stored dump.
    expect(buildMultiFixture('determinism-probe', 'full')).toEqual(
      buildMultiFixture('determinism-probe', 'full'),
    );
    // And two different slugs must NOT collide, or "owned" would be a fiction.
    const a = buildMultiFixture('determinism-a', 'full');
    const b = buildMultiFixture('determinism-b', 'full');
    expect(a.alpha.organizationId).not.toBe(b.alpha.organizationId);
    expect(a.alpha.users.scheduler.membershipId).not.toBe(b.alpha.users.scheduler.membershipId);
    log('minting is deterministic per slug and disjoint across slugs');
  });

  it('two independently provisioned fixtures are canonically identical', async () => {
    const first = await canonicalContent(multi());
    const second = await canonicalContent(twin());
    expect(second).toEqual(first);
    log(
      `double-provision comparison: ${String((first as { memberships: string[] }).memberships.length)} ` +
        'memberships, identical modulo minted identity (ids, slug-derived addresses, timestamps)',
    );
  });

  it('the comparison is not vacuous — a single changed row breaks it', async () => {
    // If `canonicalContent` canonicalised too much, it would report two DIFFERENT
    // fixtures as identical and the test above would prove nothing.
    const reference = await canonicalContent(multi());
    // A group NAME: compared by `canonicalContent`, and not privilege-bearing —
    // a role change is refused outright without tenant context by the membership
    // administration guard, which would make this probe measure that refusal
    // rather than the comparison.
    const target = twin().alpha.groupTwo.id;
    const before = await admin.query<{ name: string }>('select name from groups where id = $1::uuid', [
      target,
    ]);
    const originalName = before.rows[0]?.name;
    expect(originalName, 'the twin fixture is missing its second group').toBe('Alpha Group Two');
    try {
      await admin.query('update groups set name = $1 where id = $2::uuid', [
        'Renamed By The Vacuity Probe (synthetic)',
        target,
      ]);
      expect(await canonicalContent(twin())).not.toEqual(reference);
      log('a single changed group name breaks the comparison — it is comparing something');
    } finally {
      await admin.query('update groups set name = $1 where id = $2::uuid', [originalName, target]);
    }
    expect(await canonicalContent(twin())).toEqual(reference);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The ten support points (packet, deliverable C)
 * ──────────────────────────────────────────────────────────────────────────── */

describe('MULTI supports the ten things doc 16 §3 requires of it', () => {
  it('1 + 2: at least two organizations, each with at least two groups', async () => {
    expect(multi().organizationIds.length).toBeGreaterThanOrEqual(2);
    const { rows } = await admin.query<{ organization_id: string; n: string }>(
      `select organization_id, count(*)::text as n from groups
        where organization_id = any($1::uuid[]) group by 1`,
      [multi().organizationIds],
    );
    expect(rows.length).toBe(multi().organizationIds.length);
    for (const row of rows) expect(Number(row.n), `${row.organization_id} has too few groups`).toBeGreaterThanOrEqual(2);
    log(`${String(multi().organizationIds.length)} organizations, each with >= 2 groups`);
  });

  it('3: one user holds DIFFERENT roles in different memberships', async () => {
    const dual = multi().alpha.full?.dualRole;
    expect(dual, "the `full` profile did not provision the dual-role principal").toBeDefined();
    const { rows } = await admin.query<{ group_role: string; group_id: string }>(
      'select group_role, group_id::text from memberships where user_id = $1::uuid order by group_role',
      [dual?.id],
    );
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((row) => row.group_role)).size, 'the two memberships share a role').toBe(2);
    log(`one principal, two memberships, roles [${rows.map((r) => r.group_role).join(', ')}]`);
  });

  it('4: users cover every SPEC-06 role, and the suspended / invited / ended cases exist', async () => {
    const { rows } = await admin.query<{ group_role: string | null; organization_role: string | null; status: string }>(
      `select group_role, organization_role, status from memberships
        where organization_id = any($1::uuid[])`,
      [multi().organizationIds],
    );
    const groupRoles = new Set(rows.map((row) => row.group_role).filter((role) => role !== null));
    const organizationRoles = new Set(
      rows.map((row) => row.organization_role).filter((role) => role !== null),
    );
    const statuses = new Set(rows.map((row) => row.status));

    for (const role of ['member', 'viewer', 'telecom', 'scheduler', 'group_admin']) {
      expect(groupRoles.has(role), `no membership holds group role ${role}`).toBe(true);
    }
    for (const role of ['org_admin', 'org_observer']) {
      expect(organizationRoles.has(role), `no membership holds organization role ${role}`).toBe(true);
    }
    for (const status of ['active', 'suspended', 'invited', 'ended']) {
      expect(statuses.has(status), `no membership is ${status}`).toBe(true);
    }
    log(
      `group roles [${[...groupRoles].sort().join(', ')}] · organization roles ` +
        `[${[...organizationRoles].sort().join(', ')}] · statuses [${[...statuses].sort().join(', ')}]`,
    );
  });

  it('5: an entitlement-ON and an entitlement-OFF organization both exist', async () => {
    const gamma = multi().gamma;
    expect(gamma, 'the `full` profile did not provision the entitlement-off organization').toBeDefined();
    const modules = async (organizationId: string): Promise<Set<string>> => {
      const { rows } = await admin.query<{ module_key: string }>(
        'select module_key from entitlements where organization_id = $1::uuid',
        [organizationId],
      );
      return new Set(rows.map((row) => row.module_key));
    };
    expect((await modules(multi().alpha.organizationId)).has('core_scheduling')).toBe(true);
    expect((await modules(gamma?.organizationId ?? '')).has('core_scheduling')).toBe(false);
    log('Alpha is entitled to core_scheduling; Gamma deliberately is not');
  });

  it('6: a cross-ORGANIZATION read is denied — zero rows, not an error', async () => {
    const seen = await runtime.runner.run(
      organizationContext(multi().alpha.organizationId, 'multi-cross-org'),
      async ({ query }) =>
        query
          .selectFrom('memberships')
          .select('id')
          .where('organization_id', '=', multi().beta.organizationId)
          .execute(),
    );
    expect(seen, 'an Alpha context saw Beta memberships').toEqual([]);
    log('cross-organization read under an Alpha context: 0 rows');
  });

  it('7: a cross-GROUP read inside ONE organization is denied', async () => {
    const seen = await runtime.runner.run(
      groupContext(
        multi().alpha.organizationId,
        multi().alpha.groupOne.id,
        multi().alpha.users.scheduler.membershipId,
        'multi-cross-group',
      ),
      async ({ query }) =>
        query
          .selectFrom('memberships')
          .select('id')
          .where('group_id', '=', multi().alpha.groupTwo.id)
          .execute(),
    );
    expect(seen, 'a Group One context saw Group Two memberships').toEqual([]);

    // And the same principal DOES see Group Two under its Group Two membership,
    // so the denial above is scoping rather than an absence of rows.
    const viaGroupTwo = await runtime.runner.run(
      groupContext(
        multi().alpha.organizationId,
        multi().alpha.groupTwo.id,
        multi().alpha.users.scheduler.groupTwoMembershipId,
        'multi-cross-group-control',
      ),
      async ({ query }) =>
        query
          .selectFrom('memberships')
          .select('id')
          .where('group_id', '=', multi().alpha.groupTwo.id)
          .execute(),
    );
    expect(viaGroupTwo.length, 'the control saw nothing either — the probe is vacuous').toBeGreaterThan(0);
    log(`cross-group: 0 rows from Group One, ${String(viaGroupTwo.length)} from Group Two`);
  });

  it('8: organization-scoped administration works, and group-scoped operations work', async () => {
    // Organization scope: the administrator reads across both of its groups.
    const organizationWide = await runtime.runner.run(
      multi.administrator(multi().alpha.organizationId, 'multi-org-admin'),
      async ({ query }) => query.selectFrom('groups').select('id').execute(),
    );
    expect(organizationWide.length, 'the organization administrator sees both groups').toBe(2);

    // Group scope: a group-scoped context sees exactly its own group.
    const groupScoped = await runtime.runner.run(
      groupContext(
        multi().alpha.organizationId,
        multi().alpha.groupOne.id,
        multi().alpha.users.scheduler.membershipId,
        'multi-group-scope',
      ),
      async ({ query }) => query.selectFrom('groups').select('id').execute(),
    );
    expect(groupScoped.map((row) => row.id)).toEqual([multi().alpha.groupOne.id]);
    log('organization scope sees 2 groups; group scope sees exactly its own');
  });

  it('9: the maintenance plane can be tested against it', async () => {
    // FAD-14's sanctioned cross-tenant read: `app_migrator` alone, SELECT only,
    // on `audit_checkpoints`. MULTI must give it more than one organization to
    // read, or a maintenance-plane test proves nothing.
    const migrator = createRuntime('app_migrator', { max: 1 });
    try {
      const client = await migrator.pool.connect();
      try {
        const { rows } = await client.query<{ organization_id: string }>(
          'select distinct organization_id from audit_checkpoints where organization_id = any($1::uuid[])',
          [multi().organizationIds],
        );
        expect(
          rows.length,
          'the maintenance plane saw fewer than two of this fixture organizations',
        ).toBeGreaterThanOrEqual(2);
        log(`maintenance plane reads checkpoints for ${String(rows.length)} of this fixture's organizations`);
      } finally {
        client.release();
      }
    } finally {
      await migrator.destroy();
    }
  });

  it('10: it is provisioned by ONE owner, and this file ran standalone to prove it', async () => {
    // Support point 10 is "standalone execution". The claim is only worth
    // anything because `pnpm fixture-regression` runs this file alone; what is
    // asserted here is the other half — that the fixture came from the single
    // provisioning owner and nothing else wrote it. Every row carries the slug.
    const { rows } = await admin.query<{ n: string }>(
      `select count(*)::text as n from users u
         join memberships m on m.user_id = u.id
        where m.organization_id = any($1::uuid[]) and u.login_email not like $2`,
      [multi().organizationIds, `${multi().slug}-%`],
    );
    expect(rows[0]?.n, 'a user in this fixture was not created by the MULTI provisioner').toBe('0');
    log('every user in this fixture carries the provisioner slug — one owner, no strays');
  });
});
