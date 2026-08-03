import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ROLES } from '../../src/db/roles.js';
import { TENANT_TABLES } from '../../src/db/schema.js';
import { NON_TENANT_TABLES, accountedForTables } from '../support/schema-census.js';
import { adminClient } from '../support/admin-client.js';
import {
  FIXTURE,
  NONEXISTENT_ID,
  administratorContext,
  groupContext,
  organizationContext,
} from '../support/fixtures.js';
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
    /* The ONE table this is not true of, and it is true on purpose.
     *
     * `audit_checkpoints` carries FAD-14's maintenance-plane read — `FOR SELECT
     * TO app_migrator USING (true)` — so the schema owner CAN read it without a
     * tenant context, which is the whole reason the policy exists: the periodic
     * checkpoint and verification jobs must ask "which organizations are due?"
     * before any per-tenant unit of work exists to ask it in.
     *
     * Asserted in both directions rather than skipped. Skipping it would make
     * the exemption invisible here; asserting `> 0` makes it fail if the policy
     * is ever removed, and asserting the other roles see nothing makes it fail if
     * the reach ever widens beyond `app_migrator`. */
    const MAINTENANCE_READABLE = new Set(['audit_checkpoints']);

    const migrator = createRuntime('app_migrator', { max: 1 });
    try {
      for (const table of TENANT_TABLES) {
        const result = await outsideUnitOfWork<{ n: number }>(
          migrator,
          `select count(*)::int as n from ${table.name}`,
        );
        if (MAINTENANCE_READABLE.has(table.name)) {
          expect(
            result.rows[0]?.n,
            `${table.name} carries FAD-14's maintenance read but app_migrator sees nothing — ` +
              'either the policy is gone or the fixture seeds no rows, and both make this vacuous',
          ).toBeGreaterThan(0);
          continue;
        }
        expect(result.rows[0]?.n, `app_migrator sees ${table.name} rows without context`).toBe(0);
      }
      log(
        `app_migrator reads 0 rows from every tenant table without context except ` +
          `${[...MAINTENANCE_READABLE].join(', ')} (FAD-14's sanctioned maintenance read)`,
      );
    } finally {
      await migrator.destroy();
    }
  });

  it('the FAD-14 maintenance read reaches app_migrator ALONE, and no runtime role', async () => {
    // The exemption's blast radius, asserted directly. Every RLS-bound role must
    // see nothing without context — including `app_worker`, which is the role
    // that actually writes checkpoints.
    //
    // `app_breakglass` is excluded and must be: SPEC-01 §4.4 gives it
    // `BYPASSRLS` deliberately ("two-person emergency only, every session
    // audited and alerted"), so it reads every table in every tenant by
    // definition. Asserting 0 for it would contradict the role matrix, and A-08
    // asserts the attribute directly. It is named here rather than silently
    // omitted so the omission is a decision a reader can see.
    for (const role of ['app_runtime', 'app_worker', 'app_readonly_support'] as const) {
      const runtime = createRuntime(role, { max: 1 });
      try {
        const result = await outsideUnitOfWork<{ n: number }>(
          runtime,
          'select count(*)::int as n from audit_checkpoints',
        );
        expect(
          result.rows[0]?.n,
          `${role} reached audit_checkpoints without a tenant context`,
        ).toBe(0);
      } finally {
        await runtime.destroy();
      }
    }
    log('FAD-14 maintenance read: app_migrator only; the three RLS-bound roles read 0 rows');
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
    //
    // CHANGED BY OPUS-M1-002. The statement now has to get PAST the capability
    // guard first — `memberships_guard_administration_on_insert` fires BEFORE
    // the FK and would report 42501, which would make this assertion pass for
    // the wrong reason and stop measuring the FK at all. So the session declares
    // an authorized administrator, and the 23503 that follows is the composite
    // FK and nothing else. The version of this test that just expected "some
    // rejection" would have silently stopped testing X-06.
    await admin.query('BEGIN');
    try {
      await admin.query(`select set_config('app.organization_id', $1, true)`, [
        FIXTURE.alpha.organizationId,
      ]);
      await admin.query(`select set_config('app.group_id', '', true)`);
      await admin.query(`select set_config('app.membership_id', $1, true)`, [
        FIXTURE.alpha.users.organizationAdmin.membershipId,
      ]);
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
    } finally {
      await admin.query('ROLLBACK');
    }

    log('cross-tenant membership reference rejected by the composite FK (23503) even as an authorized superuser');
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

describe('OPUS-M1-004 — the registry accounts for EVERY table in the schema', () => {
  /**
   * The omission this task exists to fix, turned into a check.
   *
   * `TENANT_TABLES` drives the pool-cleanliness probe, the wrong-tenant probe,
   * the T-15 storm, the (role, table) privilege matrix and the nullif-guard
   * scan. Migration 0003's four tenant tables were left out of it — not by
   * anyone's choice, but because `db/schema.ts` was a parallel task's file scope
   * — and nothing noticed, because **nothing was asking**. Every one of those
   * probes reported clean while covering none of them.
   *
   * So the question is asked here, against the database rather than against a
   * list: every table in the public schema is either registered as a tenant
   * table or declared as a non-tenant one WITH A REASON. A future migration
   * cannot add a table that both lists forget.
   */
  it('every public table is either in TENANT_TABLES or declared with a reason', async () => {
    const result = await admin.query<{ tablename: string }>(
      `select c.relname as tablename
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
        order by 1`,
    );
    const actual = result.rows.map((row) => row.tablename).sort();
    expect(actual.length, 'no tables found — the check would be vacuous').toBeGreaterThan(10);

    const accounted = new Set(accountedForTables());
    const unaccounted = actual.filter((name) => !accounted.has(name));
    expect(
      unaccounted,
      `these tables are in neither list — register them in TENANT_TABLES or declare them in ` +
        `test/support/schema-census.ts with a reason:\n${unaccounted.join('\n')}`,
    ).toEqual([]);

    // And the other direction: a registry entry naming a table that does not
    // exist silently drops that table from every probe above, and reads as
    // coverage.
    const missing = [...accounted].filter((name) => !actual.includes(name)).sort();
    expect(missing, `these registry entries name no real table:\n${missing.join('\n')}`).toEqual([]);

    log(
      `${String(actual.length)} public tables: ${String(TENANT_TABLES.length)} tenant, ` +
        `${String(NON_TENANT_TABLES.length)} declared non-tenant, 0 unaccounted`,
    );
  });

  it('every declared non-tenant table carries a real reason', () => {
    for (const table of NON_TENANT_TABLES) {
      expect(table.reason.length, `${table.name}'s exclusion has no reason`).toBeGreaterThan(60);
    }
  });

  it('the audit and outbox tables are registered with the scope their POLICIES have', async () => {
    // The registry's `scope` is what `wrongTenantProbe` builds its predicate
    // from, so a mis-declared scope produces a probe that cannot fail. Checked
    // against `pg_policies` rather than against the migration text.
    const expected: readonly { table: string; groupPredicate: boolean }[] = [
      { table: 'audit_events', groupPredicate: true },
      { table: 'outbox_events', groupPredicate: true },
      { table: 'outbox_effects', groupPredicate: true },
      { table: 'audit_checkpoints', groupPredicate: false },
    ];

    for (const { table, groupPredicate } of expected) {
      const registered = TENANT_TABLES.find((entry) => entry.name === table);
      expect(registered, `${table} is not registered`).toBeDefined();
      expect(registered?.scope).toBe(
        groupPredicate ? 'organization-and-group' : 'organization-context-only',
      );

      // A `group_id` COLUMN is what makes the group half of the probe's
      // predicate expressible at all. `wrongTenantProbe`'s
      // `organization-and-group` branch compares it; if the column is absent the
      // probe would not compile, and if it is present but the table is
      // registered organization-only the group half of the check silently
      // vanishes. Read from the catalogue, not from the migration text.
      const columns = await admin.query<{ n: string }>(
        `select count(*)::text as n from information_schema.columns
          where table_schema = 'public' and table_name = $1 and column_name = 'group_id'`,
        [table],
      );
      expect(
        columns.rows[0]?.n === '1',
        `${table}'s registered scope disagrees with whether it HAS a group_id column`,
      ).toBe(groupPredicate);

      const policies = await admin.query<{ qual: string | null; with_check: string | null }>(
        `select qual, with_check from pg_policies
          where schemaname = 'public' and tablename = $1 and roles::text = '{public}'`,
        [table],
      );
      expect(policies.rows.length, `${table} has no PUBLIC policy`).toBeGreaterThan(0);

      // Every one of them reads `app.group_id` — the group-scoped tables to bind
      // against it, `audit_checkpoints` to require it be NULL (0003, R-06). A
      // policy on a tenant table that never consults the group setting is a
      // policy that cannot distinguish the two contexts.
      const consultsGroupSetting = policies.rows.every((row) =>
        /app\.group_id/.test(`${row.qual ?? ''} ${row.with_check ?? ''}`),
      );
      expect(consultsGroupSetting, `a policy on ${table} never reads app.group_id`).toBe(true);
    }
    log('four 0003 tables registered with the scope their policies actually implement');
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
    // A ROLE change is a privilege change, and since OPUS-M1-002 that needs an
    // acting administrator (EV-M1-TENANCY residual 4's control). A
    // `last_active_at` touch is not, and deliberately still runs in the plain
    // group context below — the two paths differing is the property under test.
    const asAdministrator = (): ReturnType<typeof groupContext> =>
      administratorContext(FIXTURE.alpha.organizationId, 'r05-role-change');

    const before = await read();
    await runtime.runner.run(asAdministrator(), async ({ query }) =>
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

    await runtime.runner.run(asAdministrator(), async ({ query }) =>
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

describe('EV-M1-TENANCY residuals 1, 2 and 4 — CLOSED by OPUS-M1-002', () => {
  // These three tests were written by OPUS-M1-001 as a deliberately red-side-up
  // baseline: each one PASSED by demonstrating that the residual was real, and
  // the describe block was called "residuals this milestone leaves open".
  //
  // They have been flipped. Each now asserts the control, and the assertion is
  // the mirror image of what it replaced — same statement, same context, opposite
  // outcome. The closure is recorded in `docs/evidence/EV-M1-AUTHZ/INDEX.md` §4;
  // EV-M1-TENANCY §5.2 is left as the historical record and is not edited.
  //
  // The control is `apps/api/migrations/0002_authorization.sql`'s
  // `memberships_guard_administration_on_insert` / `_on_privilege_change`, which
  // require `organization.membership.administer` from the acting membership.
  // FAD-11 ruling 3 permits it: a TRIGGER on `memberships` that reads
  // `memberships` is not the infinite recursion a POLICY on `memberships` that
  // reads `memberships` would be.

  it('RESIDUAL (1) CLOSED: an actor with no capability can no longer attach ANY user', async () => {
    const betaOnlyUser = FIXTURE.beta.users.organizationAdmin.id;
    const attachedMembershipId = '0f000001-1111-4111-8111-00000000f001';

    // The counter is read BEFORE, so the "did not move" claim below is an
    // assertion rather than a log line. The first version of this test selected
    // the value, interpolated it into a message, and compared it to nothing —
    // found by an independent review.
    const counterBefore = await admin.query<{ v: string }>(
      'select membership_set_version as v from users where id = $1',
      [betaOnlyUser],
    );

    // Before: Beta's user is invisible under Alpha's organization context.
    const invisibleBefore = await runtime.runner.run(
      organizationContext(FIXTURE.alpha.organizationId),
      async ({ query }) =>
        query.selectFrom('users').select(['id']).where('id', '=', betaOnlyUser).execute(),
    );
    expect(invisibleBefore).toHaveLength(0);

    // The statement that used to succeed. It is byte-for-byte the one
    // OPUS-M1-001 recorded, including the context with no acting membership.
    await expect(
      runtime.runner.run(organizationContext(FIXTURE.alpha.organizationId), async ({ query }) =>
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
      ),
      'the residual is OPEN again — an unauthorized actor attached a foreign user',
    ).rejects.toMatchObject({ code: '42501' });

    // And the two consequences the residual named are both absent: the user is
    // still invisible, and the FOREIGN user's monotonic, un-lowerable
    // `membership_set_version` did not move.
    const invisibleAfter = await runtime.runner.run(
      organizationContext(FIXTURE.alpha.organizationId),
      async ({ query }) =>
        query.selectFrom('users').select(['id']).where('id', '=', betaOnlyUser).execute(),
    );
    expect(invisibleAfter, 'the foreign user became readable').toHaveLength(0);

    const rows = await admin.query<{ n: string; v: string }>(
      `select (select count(*) from memberships where id = $1)::text as n,
              (select membership_set_version from users where id = $2)::text as v`,
      [attachedMembershipId, betaOnlyUser],
    );
    expect(rows.rows[0]?.n, 'the membership row landed anyway').toBe('0');
    expect(
      Number(rows.rows[0]?.v),
      "the foreign user's monotonic, un-lowerable membership_set_version moved",
    ).toBe(Number(counterBefore.rows[0]?.v));
    log(
      `RESIDUAL 1 CLOSED: unauthorized attach -> 42501; foreign user's membership_set_version ` +
        `asserted unchanged at ${String(rows.rows[0]?.v)}`,
    );
  });

  it('RESIDUAL (1) CLOSED, both directions: an AUTHORIZED administrator still can', async () => {
    // A gate that refused everything would satisfy the test above and break the
    // product. The organization administrator holds
    // `organization.membership.administer` through `role_capabilities`, so the
    // same statement succeeds — for a user of its OWN organization.
    const membershipId = '0f000004-1111-4111-8111-00000000f004';
    try {
      await runtime.runner.run(
        administratorContext(FIXTURE.alpha.organizationId, 'residual-1-positive'),
        async ({ query }) =>
          query
            .insertInto('memberships')
            .values({
              id: membershipId,
              organization_id: FIXTURE.alpha.organizationId,
              group_id: FIXTURE.alpha.groupTwo.id,
              user_id: FIXTURE.alpha.users.member.id,
              kind: 'group',
              group_role: 'member',
              organization_role: null,
            })
            .execute(),
      );
      const landed = await admin.query<{ n: string }>(
        'select count(*)::text as n from memberships where id = $1',
        [membershipId],
      );
      expect(landed.rows[0]?.n, 'the gate refuses an authorized administrator too').toBe('1');
      log('an authorized administrator can still create a membership — the gate is not a wall');
    } finally {
      await admin.query('delete from memberships where id = $1', [membershipId]);
    }
  });

  it('RESIDUAL (2) CLOSED: the FK is no longer a global user-id existence oracle', async () => {
    // The oracle was the DIFFERENCE between two outcomes: a non-existent user id
    // raised 23503 (the FK talking) while an existing-but-invisible one was
    // accepted. Both statements now stop at the same place, with the same
    // SQLSTATE, before the FK is ever consulted — a BEFORE ROW trigger runs
    // before referential integrity is checked, measured on this cluster rather
    // than assumed.
    const probeId = '0f000002-1111-4111-8111-00000000f002';

    const attempt = (userId: string): Promise<unknown> =>
      runtime.runner.run(organizationContext(FIXTURE.alpha.organizationId), async ({ query }) =>
        query
          .insertInto('memberships')
          .values({
            id: probeId,
            organization_id: FIXTURE.alpha.organizationId,
            group_id: null,
            user_id: userId,
            kind: 'organization',
            organization_role: 'org_admin',
            group_role: null,
          })
          .execute(),
      );

    const codes: string[] = [];
    for (const userId of [NONEXISTENT_ID, FIXTURE.beta.users.scheduler.id]) {
      await attempt(userId).then(
        () => {
          codes.push('ACCEPTED');
        },
        (error: unknown) => {
          codes.push(String((error as { code?: string }).code));
        },
      );
    }

    expect(codes, 'the two outcomes still differ — the oracle is open').toEqual(['42501', '42501']);
    const landed = await admin.query<{ n: string }>(
      'select count(*)::text as n from memberships where id = $1',
      [probeId],
    );
    expect(landed.rows[0]?.n).toBe('0');
    log(
      'RESIDUAL 2 CLOSED: a non-existent user id and an existing-but-invisible one now produce ' +
        'the SAME SQLSTATE (42501), so the pair discloses nothing',
    );
  });

  it('RESIDUAL (4) CLOSED: a member cannot escalate its own role', async () => {
    // "An actor with UPDATE on `memberships` in its own group can raise its own
    // role." The acting membership is the Alpha member — role `member`, which
    // holds no administration capability — and the target is itself.
    const membershipId = FIXTURE.alpha.users.member.membershipId;
    const before = await admin.query<{ group_role: string }>(
      'select group_role from memberships where id = $1',
      [membershipId],
    );

    await expect(
      runtime.runner.run(
        groupContext(FIXTURE.alpha.organizationId, FIXTURE.alpha.groupOne.id, membershipId),
        async ({ query }) =>
          query
            .updateTable('memberships')
            .set({ group_role: 'group_admin' })
            .where('id', '=', membershipId)
            .execute(),
      ),
      'a member escalated its own role',
    ).rejects.toMatchObject({ code: '42501' });

    const after = await admin.query<{ group_role: string }>(
      'select group_role from memberships where id = $1',
      [membershipId],
    );
    expect(after.rows[0]?.group_role).toBe(before.rows[0]?.group_role);

    // Nor can a SCHEDULER — a role with a capability, just not this one. The
    // gate is about the capability, not about being unprivileged.
    await expect(
      runtime.runner.run(
        groupContext(
          FIXTURE.alpha.organizationId,
          FIXTURE.alpha.groupOne.id,
          FIXTURE.alpha.users.scheduler.membershipId,
        ),
        async ({ query }) =>
          query
            .updateTable('memberships')
            .set({ group_role: 'group_admin' })
            .where('id', '=', FIXTURE.alpha.users.scheduler.membershipId)
            .execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    log('RESIDUAL 4 CLOSED: self role escalation refused 42501 for member and for scheduler');
  });

  it('a PRINCIPAL may not write a capability grant for any of their own memberships', async () => {
    // Not in SPEC-06 — the database half of residual 4, and unconditional. Even
    // the organization administrator, who holds `organization.role.administer`,
    // is refused.
    //
    // **The check keys on the USER, not on the membership row**, and the first
    // version of it did not: an independent review escalated through a second
    // membership of the same user in two requests. The cross-membership case is
    // exercised over HTTP in `apps/api/test/authz/http-authorization.test.ts`,
    // describe block "a principal cannot grant themselves a capability through a
    // SECOND membership"; this is the same-membership case.
    const adminMembership = FIXTURE.alpha.users.organizationAdmin.membershipId;
    await expect(
      runtime.runner.run(
        administratorContext(FIXTURE.alpha.organizationId, 'self-grant'),
        async ({ query }) =>
          query
            .insertInto('capability_grants')
            .values({
              id: '0f000003-1111-4111-8111-00000000f003',
              organization_id: FIXTURE.alpha.organizationId,
              group_id: null,
              membership_id: adminMembership,
              capability_key: 'identity.impersonate',
              granted: true,
            })
            .execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    log('a self-grant is refused even for the organization administrator');
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

    /* ── the ONE sanctioned exemption, named (FAD-14) ─────────────────────────
     *
     * OPUS-M1-004 registered migration 0003's tenant tables, and one of them
     * carries a policy scoped `TO app_migrator`. It is not an oversight and it
     * is not new: it is the maintenance-plane cross-tenant read FAD-14 adopted
     * as normative, and it is described there as **"the only cross-tenant read
     * in the system, pinned by tests, not itself audited"**. This is that pin.
     *
     * The periodic checkpoint and verification jobs (SPEC-11 §2) must answer
     * "which organizations are due?" before they can open a per-tenant unit of
     * work for any of them, and there is no tenant context in which that
     * question can be asked. FORCE RLS binds the table owner too, so a SECURITY
     * DEFINER function alone does not reach it — the reach has to be a policy,
     * written down, rather than a bypass nobody can see.
     *
     * The exemption is allowed by NAME and by SHAPE. Anything else — a second
     * such policy, a different role, a widening from SELECT, or the same name on
     * a different table — fails here. `audit_chain_heads` carries the twin
     * policy and is not in the registry (see test/support/schema-census.ts), so
     * it is not reachable through this list at all. */
    // T-04: the OTHER half of this pinning is
    // `apps/api/test/audit/chain.test.ts`, "the cross-tenant maintenance read is
    // reachable by NO application role", which covers both maintenance policies
    // — including the one on `audit_chain_heads`, which is not in TENANT_TABLES
    // and so cannot be seen from here. Change one, look at the other.
    const SANCTIONED_ROLE_SCOPED = [
      { table: 'audit_checkpoints', policy: 'audit_checkpoints_maintenance_read', roles: '{app_migrator}' },
    ] as const;

    const roleScoped = policies.rows.filter((row) => row.roles !== '{public}');
    const unsanctioned = roleScoped.filter(
      (row) =>
        !SANCTIONED_ROLE_SCOPED.some(
          (allowed) =>
            allowed.table === row.tablename &&
            allowed.policy === row.policyname &&
            allowed.roles === row.roles,
        ),
    );
    expect(
      unsanctioned.map((row) => `${row.tablename}.${row.policyname} TO ${row.roles}`),
      'a policy is scoped to a named role — that is a per-role exemption',
    ).toEqual([]);

    // The allowance is not a hole that can quietly widen: the sanctioned policy
    // must actually exist (an allowance for a policy nobody wrote is an
    // allowance for whatever is written next under that name), and it must be
    // SELECT-only. FAD-14: "FOR SELECT only. Nothing may be written cross-tenant."
    const commands = await admin.query<{ tablename: string; policyname: string; cmd: string }>(
      `select tablename, policyname, cmd from pg_policies
        where schemaname = 'public' and roles::text <> '{public}'
        order by tablename, policyname`,
    );
    for (const allowed of SANCTIONED_ROLE_SCOPED) {
      const found = commands.rows.find(
        (row) => row.tablename === allowed.table && row.policyname === allowed.policy,
      );
      expect(found, `${allowed.table}.${allowed.policy} no longer exists`).toBeDefined();
      expect(found?.cmd, `${allowed.policy} is no longer SELECT-only`).toBe('SELECT');
    }

    // And the qual spelling of the same idea, kept as well: an exemption can be
    // written either way and neither is acceptable.
    const namedInQual = policies.rows.filter((row) => /app_migrator|current_user/i.test(row.qual ?? ''));
    expect(
      namedInQual.map((row) => `${row.tablename}.${row.policyname}`),
      'a policy predicate tests the connected role — an owner exemption in disguise',
    ).toEqual([]);

    log(`${String(policies.rows.length)} policies checked; all apply TO public, none tests current_user`);
  });

  it('a privilege-bearing membership change OUTSIDE a unit of work is refused — by TWO independent controls', async () => {
    // The enforcement point, and since OPUS-M1-002 there are two of them. They
    // are asserted separately, because a test that accepts "some rejection"
    // stops noticing when one of the two disappears.
    const membershipId = FIXTURE.beta.users.scheduler.membershipId;

    // (a) The CAPABILITY guard, added by 0002. No context at all means no acting
    //     membership, so `app_acting_membership_holds` is false and the BEFORE
    //     UPDATE trigger refuses with 42501 before anything else runs.
    await expect(
      admin.query(`update memberships set status = 'suspended' where id = $1`, [membershipId]),
    ).rejects.toMatchObject({ code: '42501' });

    // (b) The COUNTER trigger from 0001, which is a different control for a
    //     different reason (I-15: a privilege change must not commit with a
    //     stale counter). To reach it the statement has to satisfy (a) first, so
    //     the session declares an authorized administrator — and STILL omits the
    //     organization context the counter bump needs. 23001, as before.
    await admin.query('BEGIN');
    try {
      await admin.query(`select set_config('app.membership_id', $1, true)`, [
        FIXTURE.beta.users.organizationAdmin.membershipId,
      ]);
      await expect(
        admin.query(`update memberships set status = 'suspended' where id = $1`, [membershipId]),
      ).rejects.toMatchObject({ code: '23001' });
    } finally {
      await admin.query('ROLLBACK');
    }

    const unchanged = await admin.query<{ status: string }>(
      'select status from memberships where id = $1',
      [membershipId],
    );
    expect(unchanged.rows[0]?.status, 'the refused change committed anyway').toBe('active');
    log(
      'membership status change with no context: 42501 (capability guard); with an actor but no ' +
        'tenant context: 23001 (counter trigger). Row unchanged either way.',
    );
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
    // An administrator's organization-scoped context: a status change is a
    // privilege change, and privilege changes are organization-scoped actions
    // (SPEC-06 §1.1) that now require the capability.
    const context = (): ReturnType<typeof groupContext> =>
      administratorContext(FIXTURE.beta.organizationId, 'counter-bump-inside');

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
