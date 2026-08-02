import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ROLES } from '../../src/db/roles.js';
import { TENANT_TABLES } from '../../src/db/schema.js';
import { adminClient } from '../support/admin-client.js';
import { FIXTURE, NONEXISTENT_ID, groupContext, organizationContext } from '../support/fixtures.js';
import { createRuntime, log, outsideUnitOfWork, type Runtime } from '../support/harness.js';

/**
 * Suite A / X — the environment, the SPEC-01 §4.4 role matrix, the RLS policy
 * shape, and the sharp edges the executed spike found.
 *
 * Every one of these is a property the tenancy design *rests on* and that no
 * amount of application-level care can restore if the database does not have
 * it. They are asserted against the real server rather than assumed from the
 * migration text.
 */

let admin: pg.Client;
let runtime: Runtime;
let worker: Runtime;

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  runtime = createRuntime('app_runtime', { max: 4 });
  worker = createRuntime('app_worker', { max: 2 });
});

afterAll(async () => {
  await runtime.destroy();
  await worker.destroy();
  await admin.end();
});

describe('A — environment and the SPEC-01 §4.4 role matrix', () => {
  it('A-01 runs against a real PostgreSQL 17.x server (FAD-7 substitution)', async () => {
    const result = await admin.query<{ version: string }>('select version() as version');
    const version = result.rows[0]?.version ?? '';
    log(version);
    expect(version).toMatch(/^PostgreSQL 17\./);
  });

  it('A-02 the five roles exist with exactly the attributes SPEC-01 §4.4 requires', async () => {
    const result = await admin.query<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      rolcanlogin: boolean;
    }>(
      `select rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin
         from pg_roles where rolname = any($1::text[]) order by rolname`,
      [ROLES.map((role) => role.name)],
    );

    expect(result.rows).toHaveLength(ROLES.length);
    for (const spec of ROLES) {
      const row = result.rows.find((r) => r.rolname === spec.name);
      expect(row, `role ${spec.name} is missing`).toBeDefined();
      expect(row?.rolsuper, `${spec.name} superuser`).toBe(spec.expect.superuser);
      expect(row?.rolbypassrls, `${spec.name} BYPASSRLS`).toBe(spec.expect.bypassRls);
      expect(row?.rolcreaterole, `${spec.name} CREATEROLE`).toBe(false);
      expect(row?.rolcreatedb, `${spec.name} CREATEDB`).toBe(false);
      expect(row?.rolcanlogin, `${spec.name} LOGIN`).toBe(true);
      log(
        `${spec.name}: superuser=${String(row?.rolsuper)} bypassrls=${String(row?.rolbypassrls)} createrole=${String(row?.rolcreaterole)}`,
      );
    }

    // Only ONE role owns the schema, and it is the migrator.
    const owner = await admin.query<{ owner: string }>(
      `select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = 'public'`,
    );
    expect(owner.rows[0]?.owner).toBe('app_migrator');
  });

  it('A-03 every tenant table has RLS ENABLED and FORCED, with at least one policy', async () => {
    const result = await admin.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      policies: number;
    }>(
      `select c.relname,
              c.relrowsecurity,
              c.relforcerowsecurity,
              (select count(*)::int from pg_policies p
                where p.tablename = c.relname and p.schemaname = 'public') as policies
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = any($1::text[])
        order by c.relname`,
      [TENANT_TABLES.map((table) => table.name)],
    );

    expect(result.rows).toHaveLength(TENANT_TABLES.length);
    for (const row of result.rows) {
      expect(row.relrowsecurity, `${row.relname} ENABLE ROW LEVEL SECURITY`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} FORCE ROW LEVEL SECURITY`).toBe(true);
      expect(row.policies, `${row.relname} policy count`).toBeGreaterThan(0);
      log(`${row.relname}: enabled+forced, ${String(row.policies)} policy/policies`);
    }
  });

  it('A-03b EVERY tenant-setting reference in EVERY policy is nullif-guarded', () => {
    // SPIKE-REPORT §7 condition 1, the only amendment its author called
    // mandatory. `SET LOCAL` reverts a GUC's VALUE without undefining it, so on a
    // reused connection — the production steady state — a bare
    // `current_setting(...)::uuid` raises 22P02 on every query instead of
    // returning zero rows.
    //
    // The check is PER REFERENCE, not per expression. An expression-level check
    // passes as soon as ONE reference is guarded, which in a conjunctive
    // organization-AND-group predicate is exactly half the check that matters:
    // the group half could be bare and nothing would notice.
    return admin
      .query<{
        tablename: string;
        policyname: string;
        qual: string | null;
        with_check: string | null;
      }>(
        `select tablename, policyname, qual, with_check
           from pg_policies
          where schemaname = 'public' and tablename = any($1::text[])
          order by tablename, policyname`,
        [TENANT_TABLES.map((table) => table.name)],
      )
      .then((result) => {
        expect(result.rows.length).toBeGreaterThan(0);

        const reference = /current_setting\('app\.[a-z_]+'::text,\s*true\)/g;
        let checked = 0;

        for (const row of result.rows) {
          for (const [clause, expression] of [
            ['USING', row.qual],
            ['WITH CHECK', row.with_check],
          ] as const) {
            if (expression === null) continue;

            for (const match of expression.matchAll(reference)) {
              checked += 1;
              const index = match.index ?? 0;
              // The guard has to be the IMMEDIATELY enclosing call. Anything
              // else — `nullif` somewhere else in the same expression — is the
              // false pass this rewrite exists to remove.
              const preceding = expression.slice(Math.max(0, index - 8), index);
              expect(
                /nullif\($/i.test(preceding),
                `${row.tablename}.${row.policyname} [${clause}]: unguarded ${match[0]} at offset ${String(index)} — preceded by ${JSON.stringify(preceding)}`,
              ).toBe(true);
            }
          }
          log(`${row.tablename}.${row.policyname}: every reference guarded`);
        }

        // Non-vacuous: if `pg_policies` ever renders the expression differently
        // and the pattern stops matching, "0 unguarded references" would be a
        // lie. The fixture has four tables with conjunctive predicates.
        expect(checked, 'the reference pattern matched nothing — the check is vacuous').toBeGreaterThan(
          10,
        );
        log(`${String(checked)} individual tenant-setting references checked`);
      });
  });

  it('A-03c the per-reference check would CATCH a half-guarded predicate', () => {
    // The red case for A-03b, run against the same matching logic. A conjunctive
    // predicate with the organization half guarded and the group half bare is
    // the realistic mistake, and an expression-level check passes it.
    const halfGuarded =
      "((organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)" +
      " AND (group_id = (current_setting('app.group_id'::text, true))::uuid))";

    const reference = /current_setting\('app\.[a-z_]+'::text,\s*true\)/g;
    const unguarded: string[] = [];
    for (const match of halfGuarded.matchAll(reference)) {
      const index = match.index ?? 0;
      if (!/nullif\($/i.test(halfGuarded.slice(Math.max(0, index - 8), index))) {
        unguarded.push(match[0]);
      }
    }
    expect(unguarded, 'the per-reference check failed to notice a bare group predicate').toHaveLength(
      1,
    );
  });

  it('A-04 FORCE RLS binds the OWNER too: app_migrator sees zero rows without context', async () => {
    const migrator = createRuntime('app_migrator', { max: 1 });
    try {
      for (const table of TENANT_TABLES) {
        const result = await outsideUnitOfWork<{ n: number }>(
          migrator,
          `select count(*)::int as n from ${table.name}`,
        );
        expect(result.rows[0]?.n, `app_migrator sees ${table.name} rows without context`).toBe(0);
      }
      log('app_migrator, the schema owner, reads 0 rows from every tenant table without context');
    } finally {
      await migrator.destroy();
    }
  });

  it('A-05 no runtime role holds TRUNCATE or REFERENCES on ANY tenant table', async () => {
    // Neither is subject to RLS (S-03), so withholding the grant is the ONLY
    // control. A single missed grant is a cross-tenant delete or a cross-tenant
    // foreign key away.
    const roles = ['app_runtime', 'app_worker', 'app_readonly_support', 'app_breakglass'];
    let pairs = 0;
    for (const role of roles) {
      for (const table of TENANT_TABLES) {
        const result = await admin.query<{ truncate: boolean; references: boolean }>(
          `select has_table_privilege($1, $2, 'TRUNCATE') as truncate,
                  has_table_privilege($1, $2, 'REFERENCES') as references`,
          [role, table.name],
        );
        expect(result.rows[0]?.truncate, `${role} holds TRUNCATE on ${table.name}`).toBe(false);
        expect(result.rows[0]?.references, `${role} holds REFERENCES on ${table.name}`).toBe(false);
        pairs += 1;
      }
    }
    log(`${String(pairs)} (role, table) pairs checked, 0 TRUNCATE/REFERENCES violations`);
  });

  it('A-05b no runtime role holds TEMP on the database', async () => {
    // TEMP is not a convenience privilege here. `app_bump_membership_set_version`
    // is SECURITY DEFINER; a role holding TEMP could create a temporary table
    // named `users` and shadow the real one inside it, so the function would
    // update a decoy, `GET DIAGNOSTICS` would see its one row, and the real
    // `membership_set_version` would never move — a privilege change committing
    // with a stale counter.
    //
    // Two defences, and this asserts the outer one. The inner is
    // `SET search_path = public, pg_temp` on the function (pg_temp LAST, so it
    // is searched last rather than first). The outer is that the bootstrap
    // revokes TEMP from PUBLIC and grants back CONNECT only — which was an
    // untested assumption until this test.
    for (const role of [
      'app_runtime',
      'app_worker',
      'app_readonly_support',
      'app_breakglass',
    ] as const) {
      const result = await admin.query<{ allowed: boolean }>(
        `select has_database_privilege($1, current_database(), 'TEMP') as allowed`,
        [role],
      );
      expect(
        result.rows[0]?.allowed,
        `${role} holds TEMP — it could shadow a table inside the SECURITY DEFINER trigger`,
      ).toBe(false);
    }

    // And the inner defence is actually configured, in the right order.
    const fn = await admin.query<{ config: string[] | null }>(
      `select proconfig as config from pg_proc where proname = 'app_bump_membership_set_version'`,
    );
    expect(fn.rows[0]?.config, 'the SECURITY DEFINER function pins no search_path').toContain(
      'search_path=public, pg_temp',
    );
    log('no runtime role holds TEMP; the trigger pins search_path=public, pg_temp (pg_temp last)');
  });

  it('A-06 app_runtime cannot disable RLS on a table it does not own', async () => {
    await expect(
      outsideUnitOfWork(runtime, 'alter table organizations disable row level security'),
    ).rejects.toMatchObject({ code: '42501' });
    log('app_runtime: ALTER TABLE ... DISABLE ROW LEVEL SECURITY rejected 42501');
  });

  it('A-07 app_readonly_support reads under context and is denied every write', async () => {
    const support = createRuntime('app_readonly_support', { max: 2 });
    try {
      const seen = await support.runner.run(
        groupContext(FIXTURE.alpha.organizationId, FIXTURE.alpha.groupOne.id),
        async ({ query }) => query.selectFrom('memberships').select(['id']).execute(),
      );
      expect(seen.length).toBeGreaterThan(0);

      await expect(
        support.runner.run(
          groupContext(FIXTURE.alpha.organizationId, FIXTURE.alpha.groupOne.id),
          async ({ query }) =>
            query
              .updateTable('memberships')
              .set({ last_active_at: new Date() })
              .where('id', '=', FIXTURE.alpha.users.scheduler.membershipId)
              .execute(),
        ),
      ).rejects.toMatchObject({ code: '42501' });

      log(
        `app_readonly_support: ${String(seen.length)} memberships readable under context, UPDATE rejected 42501`,
      );
    } finally {
      await support.destroy();
    }
  });

  it('A-08 app_breakglass genuinely differs: BYPASSRLS sees both organizations', async () => {
    const breakglass = createRuntime('app_breakglass', { max: 1 });
    try {
      const result = await outsideUnitOfWork<{ n: number }>(
        breakglass,
        'select count(distinct organization_id)::int as n from memberships',
      );
      // Two organizations, with NO context set at all. That is what BYPASSRLS
      // means, and why the role exists only for two-person emergency use.
      expect(result.rows[0]?.n).toBe(2);
      log('app_breakglass sees both organizations with no context — the role is genuinely distinct');
    } finally {
      await breakglass.destroy();
    }
  });
});

describe('X — sharp edges from the executed spike, re-proved against production schema', () => {
  it('X-06 composite tenant FK: a cross-tenant membership reference is rejected', async () => {
    // The FK check itself bypasses RLS, so a single-column
    // `REFERENCES groups (id)` would happily accept a group the caller cannot
    // see. `memberships_group_fk` carries the tenant columns, so the reference
    // cannot cross a tenant boundary regardless of RLS or application bugs.
    //
    // Alpha's context, declaring Alpha's organization but Beta's group id.
    //
    // MEASURED, not assumed: the COMPOSITE FK fires FIRST (23503), before the
    // RLS `WITH CHECK` would have raised 42501. PostgreSQL evaluates
    // referential integrity ahead of the row-security check on INSERT, so the
    // inner control is the one that reports. Both are present and either
    // outcome is fail-closed; the assertion accepts either rather than pinning
    // an evaluation order the server does not promise.
    await expect(
      runtime.runner.run(
        groupContext(FIXTURE.alpha.organizationId, FIXTURE.beta.groupOne.id),
        async ({ query }) =>
          query
            .insertInto('memberships')
            .values({
              id: randomUUID(),
              organization_id: FIXTURE.alpha.organizationId,
              group_id: FIXTURE.beta.groupOne.id,
              user_id: FIXTURE.alpha.users.scheduler.id,
              kind: 'group',
              group_role: 'member',
              organization_role: null,
            })
            .execute(),
      ),
    ).rejects.toSatisfy((error: unknown) => {
      const code = (error as { code?: string }).code;
      expect(['23503', '42501'], `unexpected SQLSTATE ${String(code)}`).toContain(code);
      log(`cross-tenant membership INSERT under RLS rejected with SQLSTATE ${String(code)}`);
      return true;
    });

    // Now prove the FK itself, out of band, where RLS is not the thing being
    // tested: as superuser, a cross-tenant composite reference still fails.
    await expect(
      admin.query(
        `insert into memberships (id, organization_id, group_id, user_id, kind, group_role)
         values ($1, $2, $3, $4, 'group', 'member')`,
        [
          randomUUID(),
          FIXTURE.alpha.organizationId,
          FIXTURE.beta.groupOne.id,
          FIXTURE.alpha.users.scheduler.id,
        ],
      ),
    ).rejects.toMatchObject({ code: '23503' });

    log('cross-tenant membership reference rejected by the composite FK (23503) even as superuser');
  });

  it('X-11 tenant-qualified unique keys keep 23505 inside the caller\'s own tenant', async () => {
    // PK and unique checks bypass RLS, so a globally-unique key a caller can
    // choose is an existence oracle for invisible rows. Every unique key on a
    // tenant table here leads with `organization_id`, so a collision can only be
    // reported against a row the caller's own organization owns.
    const result = await admin.query<{ indexdef: string; indexname: string }>(
      `select indexname, indexdef from pg_indexes
        where schemaname = 'public'
          and tablename = any($1::text[])
          and indexdef ilike '%UNIQUE%'
        order by indexname`,
      [TENANT_TABLES.map((t) => t.name)],
    );

    const unqualified: string[] = [];
    for (const row of result.rows) {
      // The primary keys are on `id`, a server-generated UUIDv4 the caller does
      // not choose; every OTHER unique key must lead with organization_id.
      const isPrimaryKey = /_pkey$/.test(row.indexname);
      // "Tenant-qualified" means the tenant column participates in the key, so a
      // collision can only ever be reported against a row in the caller's own
      // organization. Whether it leads is a performance question, not a
      // disclosure one.
      const carriesOrganization = /\((?:[^)]*\W)?organization_id\b/i.test(row.indexdef);
      // `users` is global by PO-DEC-06 and its login_email key cannot be
      // tenant-qualified without breaking global login; 23505 is translated to a
      // generic error at the edge instead (src/db/pg-errors.ts).
      const isGlobalUserKey = row.indexname === 'users_login_email_unique';
      if (!isPrimaryKey && !carriesOrganization && !isGlobalUserKey) {
        unqualified.push(`${row.indexname}: ${row.indexdef}`);
      }
      log(
        `${row.indexname}: ${isPrimaryKey ? 'primary key on a server-generated id' : carriesOrganization ? 'tenant-qualified' : 'GLOBAL (login identity)'}`,
      );
    }
    expect(unqualified, 'unique keys on tenant tables must be tenant-qualified').toEqual([]);

    // And the one global key's 23505 is translated rather than surfaced.
    const { translatePgError } = await import('../../src/db/pg-errors.js');
    const translated = translatePgError({
      code: '23505',
      constraint: 'users_login_email_unique',
      table: 'users',
    });
    expect(translated?.clientCode).toBe('CONFLICT');
    expect(translated?.clientMessage).not.toContain('login_email');
    expect(translated?.clientMessage).not.toContain('users');
  });

  it('X-09 SET LOCAL reverts the VALUE and does not undefine the GUC', async () => {
    // The finding that makes `nullif(..., '')` mandatory. Three readings:
    // pristine backend -> NULL; reused after COMMIT -> ''; reused after ROLLBACK
    // -> ''. In production every connection is reused and a rolled-back
    // transaction is the common case, so `''` is the steady state.
    const solo = createRuntime('app_runtime', { max: 1 });
    try {
      const client = await solo.pool.connect();
      try {
        const pristine = await client.query<{ v: string | null }>(
          `select current_setting('app.organization_id', true) as v`,
        );
        expect(pristine.rows[0]?.v).toBeNull();

        await client.query('BEGIN');
        await client.query('select set_config($1, $2, true)', [
          'app.organization_id',
          FIXTURE.alpha.organizationId,
        ]);
        await client.query('COMMIT');
        const afterCommit = await client.query<{ v: string | null }>(
          `select current_setting('app.organization_id', true) as v`,
        );
        expect(afterCommit.rows[0]?.v).toBe('');

        await client.query('BEGIN');
        await client.query('select set_config($1, $2, true)', [
          'app.organization_id',
          FIXTURE.beta.organizationId,
        ]);
        await client.query('ROLLBACK');
        const afterRollback = await client.query<{ v: string | null }>(
          `select current_setting('app.organization_id', true) as v`,
        );
        expect(afterRollback.rows[0]?.v).toBe('');

        // And the consequence: with the empty string in place, the predicate is
        // false and the table returns zero rows rather than raising 22P02.
        const rows = await client.query<{ n: number }>(
          'select count(*)::int as n from memberships',
        );
        expect(rows.rows[0]?.n).toBe(0);

        log('pristine=NULL, after COMMIT=\'\', after ROLLBACK=\'\'; predicate false, 0 rows, no 22P02');
      } finally {
        client.release();
      }
    } finally {
      await solo.destroy();
    }
  });

  it('X-10 `SET LOCAL` cannot be parameterised; only set_config() can', async () => {
    // This is why lint bans every `SET` form of a tenant setting. The only way to
    // write `SET LOCAL app.organization_id = ...` is to interpolate the tenant id
    // into SQL, which puts an injection surface at the single most
    // security-critical statement in the system.
    const solo = createRuntime('app_runtime', { max: 1 });
    try {
      const client = await solo.pool.connect();
      try {
        // Assembled from fragments for the same reason as the lint red case:
        // the statement must reach the SERVER, but a literal spelling of it in
        // this repository would (correctly) fail the lint rule that bans it, and
        // disabling that rule to write a test about it would be absurd.
        const setLocalStatement = ['SET', 'LOCAL', 'app.organization_id', '= $1'].join(' ');
        await client.query('BEGIN');
        await expect(
          client.query(setLocalStatement, [FIXTURE.alpha.organizationId]),
        ).rejects.toMatchObject({ code: '42601' });
        await client.query('ROLLBACK');

        await client.query('BEGIN');
        const ok = await client.query<{ set_config: string }>(
          'select set_config($1, $2, true)',
          ['app.organization_id', FIXTURE.alpha.organizationId],
        );
        expect(ok.rows[0]?.set_config).toBe(FIXTURE.alpha.organizationId);
        await client.query('ROLLBACK');

        log('SET LOCAL with a bind parameter -> 42601; set_config(name, $1, true) -> accepted');
      } finally {
        client.release();
      }
    } finally {
      await solo.destroy();
    }
  });

  it('X-07 an organization-scoped context is fail-closed on group-scoped rows', async () => {
    // `set_config(name, NULL, true)` stores the EMPTY STRING, not NULL, so a
    // group-scoped predicate under an organization-scoped unit of work must be
    // false rather than matching everything.
    const seen = await runtime.runner.run(
      organizationContext(FIXTURE.alpha.organizationId),
      async ({ query }) => {
        const organizationMemberships = await query
          .selectFrom('memberships')
          .select(['id', 'organization_id', 'group_id'])
          .where('group_id', 'is', null)
          .execute();
        const groups = await query.selectFrom('groups').select(['id', 'organization_id']).execute();
        return { organizationMemberships, groups };
      },
    );

    // Exactly one organization membership exists in the fixture, and no group
    // membership may appear in this list — `set_config(name, NULL, true)` stores
    // the EMPTY STRING, so a group predicate that was not `nullif`-guarded would
    // match nothing at all, and one that was mis-written could match everything.
    expect(seen.organizationMemberships).toHaveLength(1);

    // Group count is asserted as a property, not a number: other tests in this
    // project create marker groups, and an exact count would be measuring the
    // suite rather than the isolation.
    expect(seen.groups.length).toBeGreaterThanOrEqual(2);
    expect(
      seen.groups.every((group) => group.organization_id === FIXTURE.alpha.organizationId),
      'a group from another organization was visible',
    ).toBe(true);
    const ids = seen.groups.map((group) => group.id);
    expect(ids).toContain(FIXTURE.alpha.groupOne.id);
    expect(ids).toContain(FIXTURE.alpha.groupTwo.id);

    log(
      `organization-scoped context: 1 organization membership, ${String(seen.groups.length)} groups, all in Alpha`,
    );
  });
});

describe('R-05 — app_runtime\'s DML envelope is bounded by grants, not by convention', () => {
  const COUNTER_COLUMNS: readonly { table: string; column: string }[] = [
    { table: 'organizations', column: 'organization_version' },
    { table: 'groups', column: 'group_version' },
    { table: 'users', column: 'membership_set_version' },
    { table: 'users', column: 'session_epoch' },
  ];

  it('D/E: no runtime role holds column-level UPDATE on any freshness counter', () => {
    return (async () => {
      for (const role of ['app_runtime', 'app_worker'] as const) {
        for (const { table, column } of COUNTER_COLUMNS) {
          const result = await admin.query<{ allowed: boolean }>(
            `select has_column_privilege($1, $2, $3, 'UPDATE') as allowed`,
            [role, table, column],
          );
          expect(
            result.rows[0]?.allowed,
            `${role} can UPDATE ${table}.${column} — a freshness counter must be trigger-maintained`,
          ).toBe(false);
        }
      }
      log(
        `${String(COUNTER_COLUMNS.length * 2)} (role, counter) pairs checked; none is application-writable`,
      );
    })();
  });

  it('D/E: the counters the application DOES need are still writable', () => {
    // The negative above is only meaningful next to this. A blanket revocation
    // would satisfy it and break the product.
    return (async () => {
      for (const { table, column } of [
        { table: 'memberships', column: 'last_active_at' },
        { table: 'memberships', column: 'status' },
        { table: 'organizations', column: 'name' },
        { table: 'groups', column: 'name' },
      ]) {
        const result = await admin.query<{ allowed: boolean }>(
          `select has_column_privilege('app_runtime', $1, $2, 'UPDATE') as allowed`,
          [table, column],
        );
        expect(result.rows[0]?.allowed, `app_runtime cannot UPDATE ${table}.${column}`).toBe(true);
      }
    })();
  });

  it('D/E: an attempted counter write under app_runtime is rejected 42501', async () => {
    // The grant is the control; this proves the control fires rather than that
    // the catalogue merely says it should.
    await expect(
      runtime.runner.run(
        organizationContext(FIXTURE.alpha.organizationId),
        async ({ query }) =>
          query
            .updateTable('organizations')
            .set({ organization_version: '99' })
            .where('id', '=', FIXTURE.alpha.organizationId)
            .execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    log('app_runtime UPDATE of organization_version rejected 42501');
  });

  it('MONOTONIC: a counter cannot be moved backwards, even by a superuser', async () => {
    // The trigger, not the grant. A counter that can be rewound makes every
    // `409 CONTEXT_STALE` unfalsifiable, so the rewind raises rather than being
    // clamped — clamping would hide the bug that caused it.
    await expect(
      admin.query('update organizations set organization_version = 0 where id = $1', [
        FIXTURE.alpha.organizationId,
      ]),
    ).rejects.toMatchObject({ code: '23001' });

    await expect(
      admin.query('update users set session_epoch = 0 where id = $1', [
        FIXTURE.alpha.users.scheduler.id,
      ]),
    ).rejects.toMatchObject({ code: '23001' });
    log('organization_version and session_epoch both refuse to decrease (23001)');
  });

  it('TRIGGER-MAINTAINED: a status change advances organization_version by itself', async () => {
    const before = await admin.query<{ v: string }>(
      'select organization_version as v from organizations where id = $1',
      [FIXTURE.beta.organizationId],
    );
    // The status round-trip leaves the row as it was and the counter advanced
    // twice — which is the point: the counter tracks CHANGES, not final state.
    await admin.query(`update organizations set status = 'inactive' where id = $1`, [
      FIXTURE.beta.organizationId,
    ]);
    await admin.query(`update organizations set status = 'active' where id = $1`, [
      FIXTURE.beta.organizationId,
    ]);
    const after = await admin.query<{ v: string }>(
      'select organization_version as v from organizations where id = $1',
      [FIXTURE.beta.organizationId],
    );
    expect(Number(after.rows[0]?.v)).toBe(Number(before.rows[0]?.v) + 2);

    // And a non-privilege-bearing update does NOT advance it (SPEC-01 §2.1,
    // V-08: a routine edit must not make 409 CONTEXT_STALE routine).
    await admin.query(`update organizations set name = name where id = $1`, [
      FIXTURE.beta.organizationId,
    ]);
    const unchanged = await admin.query<{ v: string }>(
      'select organization_version as v from organizations where id = $1',
      [FIXTURE.beta.organizationId],
    );
    expect(Number(unchanged.rows[0]?.v)).toBe(Number(after.rows[0]?.v));
    log('status change advances organization_version; a name-only update does not');
  });

  it('TRIGGER-MAINTAINED: a membership role change advances the user\'s membership_set_version', async () => {
    const userId = FIXTURE.alpha.users.member.id;
    const membershipId = FIXTURE.alpha.users.member.membershipId;
    const read = async (): Promise<number> => {
      const r = await admin.query<{ v: string }>(
        'select membership_set_version as v from users where id = $1',
        [userId],
      );
      return Number(r.rows[0]?.v);
    };

    const inGroupOne = (): ReturnType<typeof groupContext> =>
      groupContext(FIXTURE.alpha.organizationId, FIXTURE.alpha.groupOne.id);

    const before = await read();
    await runtime.runner.run(inGroupOne(), async ({ query }) =>
      query.updateTable('memberships').set({ group_role: 'viewer' }).where('id', '=', membershipId).execute(),
    );
    const afterRoleChange = await read();
    expect(afterRoleChange, 'a role change did not advance membership_set_version').toBe(before + 1);

    // `last_active_at` is a routine, privilege-free edit and must NOT bump it
    // (SPEC-01 §2.1, V-08).
    await runtime.runner.run(inGroupOne(), async ({ query }) =>
      query.updateTable('memberships').set({ last_active_at: new Date() }).where('id', '=', membershipId).execute(),
    );
    expect(await read(), 'a last_active_at touch advanced a freshness counter').toBe(
      afterRoleChange,
    );

    await runtime.runner.run(inGroupOne(), async ({ query }) =>
      query.updateTable('memberships').set({ group_role: 'member' }).where('id', '=', membershipId).execute(),
    );
    log('role change bumps membership_set_version; last_active_at does not');
  });

  it('F/B: DELETE is granted to no runtime role on any tenant table', () => {
    return (async () => {
      let pairs = 0;
      for (const role of ['app_runtime', 'app_worker', 'app_readonly_support', 'app_breakglass']) {
        for (const table of TENANT_TABLES) {
          const result = await admin.query<{ allowed: boolean }>(
            `select has_table_privilege($1, $2, 'DELETE') as allowed`,
            [role, table.name],
          );
          expect(
            result.rows[0]?.allowed,
            `${role} holds DELETE on ${table.name} — doc 09 §4 permits no hard delete of tenant data`,
          ).toBe(false);
          pairs += 1;
        }
      }
      log(`${String(pairs)} (role, table) pairs checked; DELETE granted nowhere`);
    })();
  });

  it('F/B: an attempted DELETE under app_runtime is rejected 42501, inside the wrapper', async () => {
    // Stronger than "affects zero rows": the statement is refused outright, so a
    // revocation path that tried to hard-delete a membership would fail loudly
    // in development rather than quietly doing nothing.
    await expect(
      runtime.runner.run(
        groupContext(FIXTURE.alpha.organizationId, FIXTURE.alpha.groupOne.id),
        async ({ query }) =>
          query
            .deleteFrom('memberships')
            .where('id', '=', FIXTURE.alpha.users.member.membershipId)
            .execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    const survivor = await admin.query<{ n: number }>(
      'select count(*)::int as n from memberships where id = $1',
      [FIXTURE.alpha.users.member.membershipId],
    );
    expect(survivor.rows[0]?.n).toBe(1);
    log('DELETE on memberships rejected 42501; the row survives');
  });
});

describe('residuals this milestone leaves open', () => {
  // R-03(c). These tests DOCUMENT current behaviour rather than asserting a
  // desired property: each one passing means the residual is real and still
  // open. When OPUS-M1-002's capability gate lands, these are the assertions it
  // flips — a red baseline, deliberately left red-side-up.
  //
  // They are recorded in `apps/api/migrations/0001_tenancy_core.sql` (the `users`
  // docblock) and in `docs/evidence/EV-M1-TENANCY/INDEX.md` §5.

  it('RESIDUAL (1): an organization-scoped writer can attach ANY user to its organization', async () => {
    // `memberships_organization_scope`'s WITH CHECK constrains organization_id
    // and group_id; it never inspects user_id, and it cannot — `users` carries no
    // tenant column by PO-DEC-06's design, so there is no tenant to compare
    // against. The control is SPEC-06 L4.2 on the user-administration
    // capability, which does not exist yet.
    const betaOnlyUser = FIXTURE.beta.users.organizationAdmin.id;
    const attachedMembershipId = '0f000001-1111-4111-8111-00000000f001';

    // Before: Beta's user is invisible under Alpha's organization context.
    const invisibleBefore = await runtime.runner.run(
      organizationContext(FIXTURE.alpha.organizationId),
      async ({ query }) =>
        query.selectFrom('users').select(['id']).where('id', '=', betaOnlyUser).execute(),
    );
    expect(invisibleBefore).toHaveLength(0);

    try {
      // One statement, and the user becomes Alpha's.
      await runtime.runner.run(
        organizationContext(FIXTURE.alpha.organizationId),
        async ({ query }) =>
          query
            .insertInto('memberships')
            .values({
              id: attachedMembershipId,
              organization_id: FIXTURE.alpha.organizationId,
              group_id: null,
              user_id: betaOnlyUser,
              kind: 'organization',
              organization_role: 'org_admin',
              group_role: null,
            })
            .execute(),
      );

      const visibleAfter = await runtime.runner.run(
        organizationContext(FIXTURE.alpha.organizationId),
        async ({ query }) =>
          query.selectFrom('users').select(['id', 'login_email']).where('id', '=', betaOnlyUser).execute(),
      );
      expect(
        visibleAfter,
        'the residual has been closed — update this test and INDEX.md §5',
      ).toHaveLength(1);
      log(
        'RESIDUAL CONFIRMED: a membership INSERT attaches a foreign user and makes them readable. ' +
          'Owner: OPUS-M1-002 (capability gate on user administration).',
      );
    } finally {
      await admin.query('delete from memberships where id = $1', [attachedMembershipId]);
    }

    // The tenant boundary itself is NOT breached: Beta's own rows stay invisible.
    const betaMemberships = await runtime.runner.run(
      organizationContext(FIXTURE.alpha.organizationId),
      async ({ query }) =>
        query
          .selectFrom('memberships')
          .select(['id'])
          .where('organization_id', '=', FIXTURE.beta.organizationId)
          .execute(),
    );
    expect(betaMemberships, 'the ORGANIZATION boundary leaked, which would be a different finding').toHaveLength(0);
  });

  it('RESIDUAL (2): the membership FK is a global user-id existence oracle', async () => {
    // `memberships.user_id REFERENCES users (id)` is checked outside RLS. A
    // membership INSERT naming a non-existent user raises 23503; one naming an
    // existing-but-invisible user gets past the FK. The pair distinguishes "this
    // id exists somewhere" from "it does not".
    const probeId = '0f000002-1111-4111-8111-00000000f002';

    // (a) An id that exists nowhere: 23503, the FK talking.
    await expect(
      runtime.runner.run(organizationContext(FIXTURE.alpha.organizationId), async ({ query }) =>
        query
          .insertInto('memberships')
          .values({
            id: probeId,
            organization_id: FIXTURE.alpha.organizationId,
            group_id: null,
            user_id: NONEXISTENT_ID,
            kind: 'organization',
            organization_role: 'org_admin',
            group_role: null,
          })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23503' });

    // (b) An id that exists only in Beta: the FK is satisfied, so the failure
    //     mode differs — and the difference is the oracle.
    try {
      await runtime.runner.run(organizationContext(FIXTURE.alpha.organizationId), async ({ query }) =>
        query
          .insertInto('memberships')
          .values({
            id: probeId,
            organization_id: FIXTURE.alpha.organizationId,
            group_id: null,
            user_id: FIXTURE.beta.users.scheduler.id,
            kind: 'organization',
            organization_role: 'org_admin',
            group_role: null,
          })
          .execute(),
      );
      log(
        'RESIDUAL CONFIRMED: non-existent user id -> 23503, invisible-but-existing user id -> accepted. ' +
          'Owner: OPUS-M1-002 (capability gate on the INSERT).',
      );
    } finally {
      await admin.query('delete from memberships where id = $1', [probeId]);
    }
  });
});

describe('the counter bump enforces the unit of work', () => {
  // MEASURED while implementing R-05, and it changed the design.
  //
  // An owner-exempt UPDATE policy was tried first, so that an administrative
  // membership change without tenant context could still advance the counter. It
  // does not work: `UPDATE users SET membership_set_version = ... WHERE id = $1`
  // READS columns, so the SELECT policy applies to the row lookup too, and the
  // only way to make it succeed would be to let the owner read every user row
  // without a tenant context — the exact property A-04 asserts.
  //
  // So the exemption was removed and the consequence embraced: a membership
  // change outside a unit of work is REFUSED. It already violated I-15 and
  // non-bypass rule 1; now the database says so instead of silently leaving the
  // counter behind, which would have made every later `409 CONTEXT_STALE`
  // decision wrong.

  it('A-04 still holds for users: the owner reads zero rows without context', async () => {
    const migrator = createRuntime('app_migrator', { max: 1 });
    try {
      const result = await outsideUnitOfWork<{ n: number }>(
        migrator,
        'select count(*)::int as n from users',
      );
      expect(
        result.rows[0]?.n,
        'the counter-maintenance policy widened READ access — it is declared FOR UPDATE',
      ).toBe(0);
      log('app_migrator still reads 0 user rows without context; the policy is UPDATE-only');
    } finally {
      await migrator.destroy();
    }
  });

  it('EVERY policy on EVERY tenant table applies to PUBLIC — no role is exempted', async () => {
    // The first version of this test looked for `app_migrator` in `qual`. That
    // catches an exemption spelled `USING (current_user = 'app_migrator')` and
    // MISSES the ordinary spelling, `CREATE POLICY … TO app_migrator`, which
    // lands in `pg_policies.roles` and not in `qual` at all. The reviewer planted
    // exactly that policy and the test found 0 of 1.
    //
    // So the assertion is inverted: every policy must apply to `{public}`. A
    // policy scoped `TO` any named role is an exemption for that role, whoever
    // it is, however it is written.
    const policies = await admin.query<{
      tablename: string;
      policyname: string;
      roles: string;
      qual: string | null;
    }>(
      `select tablename, policyname, roles::text as roles, qual
         from pg_policies
        where schemaname = 'public' and tablename = any($1::text[])
        order by tablename, policyname`,
      [TENANT_TABLES.map((table) => table.name)],
    );

    expect(policies.rows.length, 'no policies found — the check would be vacuous').toBeGreaterThan(0);

    const roleScoped = policies.rows.filter((row) => row.roles !== '{public}');
    expect(
      roleScoped.map((row) => `${row.tablename}.${row.policyname} TO ${row.roles}`),
      'a policy is scoped to a named role — that is a per-role exemption',
    ).toEqual([]);

    // And the qual spelling of the same idea, kept as well: an exemption can be
    // written either way and neither is acceptable.
    const namedInQual = policies.rows.filter((row) => /app_migrator|current_user/i.test(row.qual ?? ''));
    expect(
      namedInQual.map((row) => `${row.tablename}.${row.policyname}`),
      'a policy predicate tests the connected role — an owner exemption in disguise',
    ).toEqual([]);

    log(`${String(policies.rows.length)} policies checked; all apply TO public, none tests current_user`);
  });

  it('a privilege-bearing membership change OUTSIDE a unit of work is refused', async () => {
    // The enforcement point. The statement below is a plain superuser UPDATE
    // with no transaction-local tenant context — which is exactly what I-15
    // forbids — and it fails rather than committing a privilege change with a
    // stale counter.
    const membershipId = FIXTURE.beta.users.scheduler.membershipId;
    await expect(
      admin.query(`update memberships set status = 'suspended' where id = $1`, [membershipId]),
    ).rejects.toMatchObject({ code: '23001' });

    const unchanged = await admin.query<{ status: string }>(
      'select status from memberships where id = $1',
      [membershipId],
    );
    expect(unchanged.rows[0]?.status, 'the refused change committed anyway').toBe('active');
    log('membership status change with no tenant context refused 23001; row unchanged');
  });

  it('the SAME change INSIDE a unit of work succeeds and advances the counter', async () => {
    // Both directions. A trigger that refused everything would satisfy the test
    // above and break the product.
    const userId = FIXTURE.beta.users.scheduler.id;
    const membershipId = FIXTURE.beta.users.scheduler.membershipId;
    const read = async (): Promise<number> => {
      const r = await admin.query<{ v: string }>(
        'select membership_set_version as v from users where id = $1',
        [userId],
      );
      return Number(r.rows[0]?.v);
    };
    const context = (): ReturnType<typeof groupContext> =>
      groupContext(FIXTURE.beta.organizationId, FIXTURE.beta.groupOne.id);

    const before = await read();
    await runtime.runner.run(context(), async ({ query }) =>
      query.updateTable('memberships').set({ status: 'suspended' }).where('id', '=', membershipId).execute(),
    );
    expect(await read()).toBe(before + 1);

    await runtime.runner.run(context(), async ({ query }) =>
      query.updateTable('memberships').set({ status: 'active' }).where('id', '=', membershipId).execute(),
    );
    expect(await read()).toBe(before + 2);
    log('the same change inside a unit of work advances membership_set_version twice');
  });
});
