import { randomUUID } from 'node:crypto';

import { CAPABILITIES } from '@schedulepoint/domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TENANT_TABLES } from '../../src/db/schema.js';
import { adminClient } from '../support/admin-client.js';
import { FIXTURE, administratorContext, groupContext, organizationContext } from '../support/fixtures.js';
import { createRuntime, log, outsideUnitOfWork, type Runtime } from '../support/harness.js';

/**
 * `migrations/0002_authorization.sql` — the properties, not the DDL.
 *
 * Every assertion below reads the LIVE catalogue (`pg_policies`, `pg_class`,
 * `pg_constraint`, `has_table_privilege`) rather than the migration text. A test
 * that greps SQL passes when the SQL is right and the applied schema is not,
 * which is the only case that matters.
 */

const NEW_TABLES = [
  'roles',
  'role_capabilities',
  'capability_grants',
  'entitlements',
  'group_module_availability',
] as const;

let admin: pg.Client;
let runtime: Runtime;

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  runtime = createRuntime('app_runtime', { max: 3 });
});

afterAll(async () => {
  await runtime.destroy();
  await admin.end();
});

describe('the authorization tables are tenant tables in every sense', () => {
  it('every one of them is registered in TENANT_TABLES', () => {
    const registered = new Set(TENANT_TABLES.map((table) => table.name));
    for (const table of NEW_TABLES) {
      expect(registered, `${table} is not in TENANT_TABLES`).toContain(table);
    }
    // The registry is what the T-13 fail-closed probe, the T-15 storm and the
    // (role, table) privilege matrix iterate. A table missing from it is a table
    // none of those cover.
  });

  it('RLS is ENABLED and FORCED on all five', async () => {
    const result = await admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `select relname, relrowsecurity, relforcerowsecurity
         from pg_class
        where relname = any($1::text[]) and relkind = 'r'
        order by relname`,
      [[...NEW_TABLES]],
    );
    expect(result.rows).toHaveLength(NEW_TABLES.length);
    for (const row of result.rows) {
      expect(row.relrowsecurity, `${row.relname}: RLS not enabled`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname}: RLS not FORCED`).toBe(true);
    }
    log(`${String(result.rows.length)} authorization tables: RLS enabled and forced`);
  });

  it('A-03b: EVERY current_setting reference in EVERY new policy is nullif-guarded', async () => {
    // The per-reference shape check, extended to 0002's policies. A single
    // unguarded `current_setting('app.x')::uuid` raises 22P02 on every query on
    // a reused pooled connection instead of returning zero rows (X-09), and it
    // is the kind of typo that reads correctly.
    const policies = await admin.query<{ tablename: string; policyname: string; qual: string | null; withcheck: string | null }>(
      `select tablename, policyname, qual, with_check as withcheck
         from pg_policies
        where schemaname = 'public' and tablename = any($1::text[])
        order by tablename, policyname`,
      [[...NEW_TABLES, 'memberships']],
    );
    expect(policies.rows.length, 'no policies found — the check would be vacuous').toBeGreaterThan(0);

    const unguarded: string[] = [];
    let references = 0;
    for (const row of policies.rows) {
      for (const expression of [row.qual, row.withcheck]) {
        if (expression === null) continue;
        // Every occurrence, not just the first: a policy with three references
        // and one typo must fail.
        for (const match of expression.matchAll(/current_setting\('app\.[a-z_]+'::text,\s*true\)/g)) {
          references += 1;
          const index = match.index ?? 0;
          const before = expression.slice(Math.max(0, index - 20), index);
          if (!/NULLIF\(\s*$/i.test(before)) {
            unguarded.push(`${row.tablename}.${row.policyname}: …${expression.slice(Math.max(0, index - 40), index + 60)}…`);
          }
        }
      }
    }
    expect(references, 'no current_setting references found — the check is vacuous').toBeGreaterThan(10);
    expect(unguarded, 'an app.* setting is read without a nullif guard').toEqual([]);
    log(`${String(references)} current_setting references checked, all nullif-guarded`);
  });

  it('no policy anywhere calls `app_acting_membership_holds` — that would be infinite recursion', async () => {
    // The rule the migration's docblock states, enforced. The helper reads
    // `memberships` and `capability_grants`; a POLICY on either that called it
    // would re-enter that table's policy evaluation (FAD-11 escalation 3). It is
    // safe from a TRIGGER and only from a trigger.
    const result = await admin.query<{ tablename: string; policyname: string }>(
      `select tablename, policyname
         from pg_policies
        where schemaname = 'public'
          and (coalesce(qual, '') ilike '%app_acting_membership_holds%'
            or coalesce(with_check, '') ilike '%app_acting_membership_holds%')`,
    );
    expect(
      result.rows.map((row) => `${row.tablename}.${row.policyname}`),
      'a policy calls the capability probe — that is the recursion FAD-11 ruled against',
    ).toEqual([]);

    // And the probe IS installed, so the assertion above is not vacuous.
    const exists = await admin.query<{ n: string }>(
      `select count(*)::text as n from pg_proc where proname = 'app_acting_membership_holds'`,
    );
    expect(exists.rows[0]?.n).toBe('1');
  });

  it('every policy applies TO public — no per-role exemption crept in', async () => {
    const policies = await admin.query<{ tablename: string; policyname: string; roles: string }>(
      `select tablename, policyname, roles::text as roles
         from pg_policies
        where schemaname = 'public' and tablename = any($1::text[])`,
      [[...NEW_TABLES]],
    );
    expect(policies.rows.length).toBeGreaterThan(0);
    expect(
      policies.rows.filter((row) => row.roles !== '{public}').map((row) => row.policyname),
    ).toEqual([]);
  });

  it('composite tenant FKs, and tenant-qualified unique keys', async () => {
    const constraints = await admin.query<{ conname: string; conrelid: string; definition: string }>(
      `select c.conname, c.conrelid::regclass::text as conrelid, pg_get_constraintdef(c.oid) as definition
         from pg_constraint c
        where c.conrelid = any($1::regclass[])
          and c.contype in ('f', 'u')
        order by conrelid, conname`,
      [[...NEW_TABLES]],
    );

    const foreignKeys = constraints.rows.filter((row) => row.definition.startsWith('FOREIGN KEY'));
    expect(foreignKeys.length, 'no foreign keys found').toBeGreaterThan(0);
    for (const fk of foreignKeys) {
      // Every FK between tenant tables carries `organization_id`, so a reference
      // cannot cross a tenant boundary regardless of RLS (SPEC-01 §4 (a), X-06).
      if (fk.definition.includes('REFERENCES organizations(')) continue;
      expect(
        fk.definition,
        `${fk.conrelid}.${fk.conname} is not composite over the tenant column`,
      ).toMatch(/FOREIGN KEY \([^)]*organization_id[^)]*\)/);
    }

    const uniques = constraints.rows.filter((row) => row.definition.startsWith('UNIQUE'));
    for (const unique of uniques) {
      expect(
        unique.definition,
        `${unique.conrelid}.${unique.conname} is not tenant-qualified — a 23505 could disclose an invisible row (X-11)`,
      ).toContain('organization_id');
    }
    log(`${String(foreignKeys.length)} FKs and ${String(uniques.length)} unique keys, all tenant-qualified`);
  });

  it('DELETE is granted to no runtime role on any authorization table', async () => {
    let pairs = 0;
    for (const role of ['app_runtime', 'app_worker', 'app_readonly_support', 'app_breakglass']) {
      for (const table of NEW_TABLES) {
        for (const privilege of ['DELETE', 'TRUNCATE', 'REFERENCES']) {
          const result = await admin.query<{ allowed: boolean }>(
            'select has_table_privilege($1, $2, $3) as allowed',
            [role, table, privilege],
          );
          expect(result.rows[0]?.allowed, `${role} holds ${privilege} on ${table}`).toBe(false);
          pairs += 1;
        }
      }
    }
    log(`${String(pairs)} (role, table, privilege) triples checked; none granted`);
  });

  it('T-13: outside a unit of work every authorization table returns zero rows', async () => {
    for (const table of NEW_TABLES) {
      const result = await outsideUnitOfWork<{ n: number }>(
        runtime,
        `select count(*)::int as n from ${table}`,
      );
      expect(result.rows[0]?.n, `${table} is readable outside a unit of work`).toBe(0);
    }
    log('all five authorization tables fail closed outside the wrapper');
  });

  it('S-05 / T-13b: a group-scoped context sees only its OWN grants, not the group\'s', async () => {
    // NARROWED BY S-05. It used to be "only its own group's grants", scoped by
    // tenant alone — so any member could read every grant in their group,
    // including who was explicitly denied what. An independent review noted that
    // this discloses WHO HOLDS WHAT, which is strictly more than the role
    // vocabulary the other read policies expose.
    //
    // Now: your own grants, and nothing else, under a group context.
    const visible = await runtime.runner.run(
      groupContext(
        FIXTURE.alpha.organizationId,
        FIXTURE.alpha.groupOne.id,
        FIXTURE.alpha.users.scheduler.membershipId,
      ),
      async ({ query }) =>
        query.selectFrom('capability_grants').select(['id', 'group_id', 'membership_id']).execute(),
    );
    expect(visible.length, 'the probe is vacuous — the scheduler has no grants').toBeGreaterThan(0);
    for (const row of visible) {
      expect(row.group_id, 'a sibling group\'s grant is visible under a group context').toBe(
        FIXTURE.alpha.groupOne.id,
      );
      expect(
        row.membership_id,
        'another membership\'s grant is visible under a group context — S-05 has regressed',
      ).toBe(FIXTURE.alpha.users.scheduler.membershipId);
    }

    // The Alpha member has an explicit DENY of `documents.manage` in the same
    // group. It must be invisible to the scheduler, and visible to the member.
    const asMember = await runtime.runner.run(
      groupContext(
        FIXTURE.alpha.organizationId,
        FIXTURE.alpha.groupOne.id,
        FIXTURE.alpha.users.member.membershipId,
      ),
      async ({ query }) => query.selectFrom('capability_grants').select(['membership_id']).execute(),
    );
    expect(asMember.length, 'a principal cannot read their own grants').toBeGreaterThan(0);
    for (const row of asMember) {
      expect(row.membership_id).toBe(FIXTURE.alpha.users.member.membershipId);
    }
    log('under a group context a principal sees their OWN grants and no others');
  });

  it('S-05: an organization role WITHOUT the administration capability reads no grants', async () => {
    // `org_observer` exists in the catalogue precisely as a capability-less
    // organization role. Before S-05 it could read every grant in the
    // organization; the policy scoped by tenant and nothing else.
    const observerMembership = randomUUID();
    const observerUser = randomUUID();
    try {
      await runtime.runner.run(
        administratorContext(FIXTURE.alpha.organizationId, 's05-observer'),
        async ({ query }) => {
          await query
            .insertInto('users')
            .values({
              id: observerUser,
              login_email: `s05-observer-${observerUser}@example.invalid`,
              display_name: 'Organization Observer (synthetic)',
            })
            .execute();
          await query
            .insertInto('memberships')
            .values({
              id: observerMembership,
              organization_id: FIXTURE.alpha.organizationId,
              group_id: null,
              user_id: observerUser,
              kind: 'organization',
              organization_role: 'org_observer',
              group_role: null,
            })
            .execute();
        },
      );

      const visible = await runtime.runner.run(
        {
          organizationId: FIXTURE.alpha.organizationId,
          groupId: null,
          membershipId: observerMembership,
          correlationId: 's05-observer-read',
        },
        async ({ query }) => query.selectFrom('capability_grants').select(['id']).execute(),
      );
      expect(
        visible,
        'a capability-less organization role read the organization\'s capability grants',
      ).toHaveLength(0);

      // And the administrator still can — the narrowing is not a wall.
      const asAdministrator = await runtime.runner.run(
        administratorContext(FIXTURE.alpha.organizationId, 's05-admin-read'),
        async ({ query }) => query.selectFrom('capability_grants').select(['id']).execute(),
      );
      expect(
        asAdministrator.length,
        'the administrator can no longer read grants — the narrowing went too far',
      ).toBeGreaterThan(0);
      log(
        `org_observer reads 0 grants; org_admin reads ${String(asAdministrator.length)} — EX-2's gate is applied, not just cited`,
      );
    } finally {
      await admin.query('delete from memberships where id = $1', [observerMembership]);
      await admin.query('delete from users where id = $1', [observerUser]);
    }
  });
});

describe('SPEC-06 P-7 / A-12 — overlapping grant windows are rejected by the exclusion constraint', () => {
  const capability = 'vacation.commit';
  const target = FIXTURE.alpha.users.groupTwoScheduler.membershipId;

  it('the constraint exists, and is a gist EXCLUDE over the window', async () => {
    const result = await admin.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition
         from pg_constraint
        where conname = 'capability_grants_no_overlapping_window'`,
    );
    const definition = result.rows[0]?.definition ?? '';
    expect(definition, 'the P-7 exclusion constraint is missing').toContain('EXCLUDE USING gist');
    expect(definition).toContain('tstzrange');
    log(definition);
  });

  it('A-12: a second, OVERLAPPING window for the same (membership, capability) is rejected 23P01', async () => {
    const first = randomUUID();
    const second = randomUUID();
    try {
      await runtime.runner.run(
        administratorContext(FIXTURE.alpha.organizationId, 'a12-first'),
        async ({ query }) =>
          query
            .insertInto('capability_grants')
            .values({
              id: first,
              organization_id: FIXTURE.alpha.organizationId,
              group_id: FIXTURE.alpha.groupTwo.id,
              membership_id: target,
              capability_key: capability,
              granted: true,
              valid_from: new Date('2026-01-01T00:00:00.000Z'),
              valid_to: new Date('2027-01-01T00:00:00.000Z'),
            })
            .execute(),
      );

      await expect(
        runtime.runner.run(
          administratorContext(FIXTURE.alpha.organizationId, 'a12-overlap'),
          async ({ query }) =>
            query
              .insertInto('capability_grants')
              .values({
                id: second,
                organization_id: FIXTURE.alpha.organizationId,
                group_id: FIXTURE.alpha.groupTwo.id,
                membership_id: target,
                capability_key: capability,
                // Overlaps the first by six months, and DENIES — which is
                // exactly the ambiguity P-1 cannot tolerate.
                granted: false,
                valid_from: new Date('2026-07-01T00:00:00.000Z'),
                valid_to: new Date('2027-07-01T00:00:00.000Z'),
              })
              .execute(),
        ),
        'an overlapping grant window was accepted — P-1 now has two rows to choose between',
      ).rejects.toMatchObject({ code: '23P01' });

      // ADJACENT windows must still be accepted: end-dating a grant by starting
      // its replacement at the same instant is the ordinary way to change one,
      // and a closed upper bound would have broken it.
      const adjacent = randomUUID();
      await runtime.runner.run(
        administratorContext(FIXTURE.alpha.organizationId, 'a12-adjacent'),
        async ({ query }) =>
          query
            .insertInto('capability_grants')
            .values({
              id: adjacent,
              organization_id: FIXTURE.alpha.organizationId,
              group_id: FIXTURE.alpha.groupTwo.id,
              membership_id: target,
              capability_key: capability,
              granted: false,
              valid_from: new Date('2027-01-01T00:00:00.000Z'),
              valid_to: new Date('2028-01-01T00:00:00.000Z'),
            })
            .execute(),
      );
      await admin.query('delete from capability_grants where id = $1', [adjacent]);
      log('overlapping window rejected 23P01; a touching window at the same instant accepted');
    } finally {
      await admin.query('delete from capability_grants where id = any($1::uuid[])', [
        [first, second],
      ]);
    }
  });

  it('the same EXCLUDE shape protects entitlements', async () => {
    const result = await admin.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition
         from pg_constraint
        where conname = 'entitlements_no_overlapping_window'`,
    );
    expect(result.rows[0]?.definition ?? '').toContain('EXCLUDE USING gist');
  });
});

describe('SPEC-06 §4 — the counters an authorization change bumps', () => {
  it('an entitlement state change advances organization_version, in the same transaction', async () => {
    const read = async (): Promise<number> => {
      const r = await admin.query<{ v: string }>(
        'select organization_version as v from organizations where id = $1',
        [FIXTURE.alpha.organizationId],
      );
      return Number(r.rows[0]?.v);
    };
    const before = await read();
    await runtime.runner.run(
      administratorContext(FIXTURE.alpha.organizationId, 'entitlement-bump'),
      async ({ query }) =>
        query
          .updateTable('entitlements')
          .set({ state: 'trial' })
          .where('module_key', '=', 'core_scheduling')
          .execute(),
    );
    expect(await read(), 'an entitlement change did not advance organization_version').toBe(
      before + 1,
    );
    await runtime.runner.run(
      administratorContext(FIXTURE.alpha.organizationId, 'entitlement-restore'),
      async ({ query }) =>
        query
          .updateTable('entitlements')
          .set({ state: 'active' })
          .where('module_key', '=', 'core_scheduling')
          .execute(),
    );
    expect(await read()).toBe(before + 2);
  });

  it('a module-availability change advances group_version', async () => {
    const read = async (): Promise<number> => {
      const r = await admin.query<{ v: string }>(
        'select group_version as v from groups where id = $1',
        [FIXTURE.alpha.groupTwo.id],
      );
      return Number(r.rows[0]?.v);
    };
    const before = await read();
    await runtime.runner.run(
      administratorContext(FIXTURE.alpha.organizationId, 'availability-bump'),
      async ({ query }) =>
        query
          .updateTable('group_module_availability')
          .set({ available: false })
          .where('group_id', '=', FIXTURE.alpha.groupTwo.id)
          .where('module_key', '=', 'core_scheduling')
          .execute(),
    );
    expect(await read()).toBe(before + 1);
    await runtime.runner.run(
      administratorContext(FIXTURE.alpha.organizationId, 'availability-restore'),
      async ({ query }) =>
        query
          .updateTable('group_module_availability')
          .set({ available: true })
          .where('group_id', '=', FIXTURE.alpha.groupTwo.id)
          .where('module_key', '=', 'core_scheduling')
          .execute(),
    );
    expect(await read()).toBe(before + 2);
  });

  it('a grant change advances the GRANTEE\'s membership_set_version', async () => {
    const userId = FIXTURE.alpha.users.groupTwoScheduler.id;
    const read = async (): Promise<number> => {
      const r = await admin.query<{ v: string }>(
        'select membership_set_version as v from users where id = $1',
        [userId],
      );
      return Number(r.rows[0]?.v);
    };
    const grantId = randomUUID();
    const before = await read();
    try {
      await runtime.runner.run(
        administratorContext(FIXTURE.alpha.organizationId, 'grant-bump'),
        async ({ query }) =>
          query
            .insertInto('capability_grants')
            .values({
              id: grantId,
              organization_id: FIXTURE.alpha.organizationId,
              group_id: FIXTURE.alpha.groupTwo.id,
              membership_id: FIXTURE.alpha.users.groupTwoScheduler.membershipId,
              capability_key: 'picklist.administer',
              granted: true,
            })
            .execute(),
      );
      expect(await read(), 'a grant did not advance the grantee\'s freshness counter').toBe(
        before + 1,
      );
    } finally {
      await admin.query('delete from capability_grants where id = $1', [grantId]);
    }
  });
});

describe('the seeded role capabilities match the catalogue', () => {
  it('every seeded (role, capability) pair is catalogued at the role\'s own scope (P-10)', async () => {
    const rows = await runtime.runner.run(
      organizationContext(FIXTURE.alpha.organizationId),
      async ({ query }) =>
        query
          .selectFrom('role_capabilities')
          .innerJoin('roles', 'roles.id', 'role_capabilities.role_id')
          .select(['roles.scope', 'roles.key', 'role_capabilities.capability_key'])
          .execute(),
    );
    expect(rows.length, 'no role capabilities were provisioned').toBeGreaterThan(0);
    const byKey = new Map(CAPABILITIES.map((capability) => [capability.key, capability]));
    for (const row of rows) {
      const definition = byKey.get(row.capability_key);
      expect(definition, `${row.key} -> ${row.capability_key} is not in the catalogue`).toBeDefined();
      expect(definition?.scope, `${row.key} -> ${row.capability_key} crosses namespaces`).toBe(
        row.scope,
      );
    }
    log(`${String(rows.length)} seeded role capabilities, all catalogued at the matching scope`);
  });
});

describe('S-22 — infinite window bounds are rejected, on every effective-dated table', () => {
  /**
   * `timestamptz` accepts `infinity` and `-infinity`, and **every window CHECK
   * written before this one was satisfied by them** — `valid_to > valid_from` is
   * true when `valid_to` is `infinity`. A second reviewer wrote infinite bounds
   * successfully to all three tables, while `instantOf`'s docblock claimed this
   * migration already forbade them. That was the third comment in this task's
   * history describing a control that was not there; the instruction was to fix
   * the control.
   *
   * One test per table, both bounds, both directions of infinity. The superuser
   * is used because a CHECK constraint binds superusers too — that is the point
   * of putting it in the schema rather than in the application.
   */
  const cases = [
    {
      table: 'memberships',
      column: 'valid_to',
      insert: (value: string) =>
        [
          `insert into memberships (id, organization_id, group_id, user_id, kind, group_role, valid_to)
           values ($1, $2, $3, $4, 'group', 'member', ${value})`,
          [
            randomUUID(),
            FIXTURE.alpha.organizationId,
            FIXTURE.alpha.groupOne.id,
            FIXTURE.alpha.users.member.id,
          ],
        ] as const,
    },
    {
      table: 'capability_grants',
      column: 'valid_to',
      insert: (value: string) =>
        [
          `insert into capability_grants (id, organization_id, group_id, membership_id, capability_key, granted, valid_to)
           values ($1, $2, $3, $4, 'vacation.commit', true, ${value})`,
          [
            randomUUID(),
            FIXTURE.alpha.organizationId,
            FIXTURE.alpha.groupOne.id,
            FIXTURE.alpha.users.member.membershipId,
          ],
        ] as const,
    },
    {
      table: 'entitlements',
      column: 'effective_to',
      insert: (value: string) =>
        [
          `insert into entitlements (id, organization_id, module_key, state, effective_to)
           values ($1, $2, 'marketplace', 'active', ${value})`,
          [randomUUID(), FIXTURE.alpha.organizationId],
        ] as const,
    },
  ] as const;

  /**
   * The statement runs with an authorized administrator declared, and that is
   * load-bearing rather than convenience: the guard TRIGGERS fire before
   * constraint checks, so an unauthorized statement is refused with 42501 and
   * the CHECK is never reached. A test that accepted "some rejection" would pass
   * with no CHECK in the schema at all — the same trap the X-06 case fell into
   * earlier in this task.
   */
  async function asAuthorized(text: string, values: readonly unknown[]): Promise<void> {
    await admin.query('BEGIN');
    try {
      await admin.query(`select set_config('app.organization_id', $1, true)`, [
        FIXTURE.alpha.organizationId,
      ]);
      await admin.query(`select set_config('app.group_id', '', true)`);
      await admin.query(`select set_config('app.membership_id', $1, true)`, [
        FIXTURE.alpha.users.organizationAdmin.membershipId,
      ]);
      await admin.query(text, [...values]);
    } finally {
      await admin.query('ROLLBACK');
    }
  }

  for (const testCase of cases) {
    it(`${testCase.table}.${testCase.column} = 'infinity' is refused by a CHECK`, async () => {
      const [text, values] = testCase.insert(`'infinity'::timestamptz`);
      await expect(
        asAuthorized(text, values),
        `${testCase.table} accepted an infinite bound — S-22 has regressed`,
      ).rejects.toMatchObject({ code: '23514' });
    });

    it(`${testCase.table}.${testCase.column} = '-infinity' is refused by a CHECK`, async () => {
      const [text, values] = testCase.insert(`'-infinity'::timestamptz`);
      await expect(asAuthorized(text, values)).rejects.toMatchObject({ code: '23514' });
    });
  }

  it('memberships.valid_from = \'-infinity\' is refused too — both bounds, not just the upper', async () => {
    await expect(
      asAuthorized(
        `insert into memberships (id, organization_id, group_id, user_id, kind, group_role, valid_from)
         values ($1, $2, $3, $4, 'group', 'member', '-infinity'::timestamptz)`,
        [
          randomUUID(),
          FIXTURE.alpha.organizationId,
          FIXTURE.alpha.groupOne.id,
          FIXTURE.alpha.users.member.id,
        ],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('a FINITE bound is still accepted — the constraint is not a blanket refusal', async () => {
    const id = randomUUID();
    try {
      await runtime.runner.run(
        administratorContext(FIXTURE.alpha.organizationId, 's22-finite'),
        async ({ query }) =>
          query
            .insertInto('capability_grants')
            .values({
              id,
              organization_id: FIXTURE.alpha.organizationId,
              group_id: FIXTURE.alpha.groupOne.id,
              membership_id: FIXTURE.alpha.users.member.membershipId,
              capability_key: 'vacation.commit',
              granted: true,
              valid_to: new Date('2030-01-01T00:00:00.000Z'),
            })
            .execute(),
      );
      const landed = await admin.query<{ n: string }>(
        'select count(*)::text as n from capability_grants where id = $1',
        [id],
      );
      expect(landed.rows[0]?.n).toBe('1');
      log('infinite bounds refused on all three tables; a finite bound still lands');
    } finally {
      await admin.query('delete from capability_grants where id = $1', [id]);
    }
  });

  it('the three CHECK constraints exist by name, so a rename cannot silently drop one', async () => {
    const result = await admin.query<{ conname: string }>(
      `select conname from pg_constraint
        where conname in ('memberships_finite_window', 'capability_grants_finite_window',
                          'entitlements_finite_window')
        order by conname`,
    );
    expect(result.rows.map((row) => row.conname)).toEqual([
      'capability_grants_finite_window',
      'entitlements_finite_window',
      'memberships_finite_window',
    ]);
  });
});
