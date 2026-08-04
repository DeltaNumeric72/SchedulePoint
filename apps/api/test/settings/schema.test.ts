import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TENANT_TABLES } from '../../src/db/schema.js';
import { adminClient } from '../support/admin-client.js';
import { log } from '../support/harness.js';

/**
 * Migration `0010_group_settings_locations.sql`, asserted against the database
 * rather than against the file (OPUS-M3-007).
 *
 * Reading the SQL proves what was written. Querying the catalogues proves what
 * was **applied** — and those are different claims whenever a statement is
 * conditional, a constraint is named differently from its column, or a grant was
 * quietly widened by a later migration.
 *
 * ## What each section pins, and why it is not decoration
 *
 * | Section | The failure it exists to catch |
 * |---|---|
 * | RLS | a table with `ENABLE` and no `FORCE` is readable by its owner, which every migration runs as |
 * | the policy predicate | the CAR-001 class: an `organization_id`-only predicate looks correct and leaks every sibling group |
 * | the CHECKs | a discriminator with no shape constraint is a comment |
 * | the grants | `version` in an UPDATE grant makes the concurrency counter forgeable (the M2-002 review proved it) |
 * | no DELETE | archive-never-delete has to be a privilege, not a convention |
 */

let admin: pg.Client;

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
}, 120_000);

afterAll(async () => {
  await admin.end();
});

describe('migration 0010 — locations', () => {
  it('has RLS ENABLED **and** FORCED', async () => {
    const { rows } = await admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `select relrowsecurity, relforcerowsecurity
         from pg_class where relname = 'locations' and relkind = 'r'`,
    );

    expect(rows, 'the locations table exists').toHaveLength(1);
    expect(rows[0]?.relrowsecurity, 'RLS enabled').toBe(true);
    // FORCE is the half that matters here: without it the table owner — which
    // every migration and every seeding script runs as — bypasses the policy.
    expect(rows[0]?.relforcerowsecurity, 'RLS FORCED').toBe(true);
  });

  it('carries V-09\'s conjunctive group predicate, with every current_setting nullif-guarded', async () => {
    const { rows } = await admin.query<{ policyname: string; qual: string; with_check: string }>(
      `select policyname, qual, with_check from pg_policies
        where tablename = 'locations'`,
    );

    expect(rows, 'exactly one policy').toHaveLength(1);
    const policy = rows[0];
    expect(policy?.policyname).toBe('locations_group_scope');

    for (const [label, clause] of [
      ['USING', policy?.qual ?? ''],
      ['WITH CHECK', policy?.with_check ?? ''],
    ] as const) {
      // All three clauses, and none is redundant. The group clause is the
      // CAR-001 defect class caught below the application layer; the
      // IS NOT NULL clause is what stops an organization-scoped context
      // matching rows whose group happened to be null.
      expect(clause, `${label}: the organization boundary`).toContain('organization_id');
      expect(clause, `${label}: the group clause`).toContain('group_id');
      expect(clause, `${label}: a group context is required`).toMatch(/IS NOT NULL/i);

      /* A-03b's per-reference check, applied to this one policy.
       *
       * PER REFERENCE, not per expression, and the guard must be the
       * IMMEDIATELY enclosing call: an expression-level test passes as soon as
       * ONE reference is guarded, which in a conjunctive organization-AND-group
       * predicate is exactly half the check that matters — the group half could
       * be bare and nothing would notice. `pg_policies` renders the call
       * upper-cased and with an explicit `::text` cast, hence the tolerant
       * pattern and the case-insensitive guard test. */
      const reference = /current_setting\('app\.[a-z_]+'::text,\s*true\)/g;
      let checked = 0;
      for (const match of clause.matchAll(reference)) {
        checked += 1;
        const index = match.index ?? 0;
        const preceding = clause.slice(Math.max(0, index - 8), index);
        expect(
          /nullif\($/i.test(preceding),
          `${label}: unguarded ${match[0]} preceded by ${JSON.stringify(preceding)}`,
        ).toBe(true);
      }
      // Non-vacuous: three references per clause (organization, the group
      // IS NOT NULL probe, the group comparison). Zero would mean the pattern
      // stopped matching and "all guarded" became a lie.
      expect(checked, `${label}: the reference pattern matched nothing`).toBe(3);
    }
  });

  it('has no organization-scoped policy at all', async () => {
    // SPEC-06 §1.1: "Everything not in this enumeration is group-scoped."
    // Location administration is not in it, so an organization-scoped context
    // must see zero rows — which is a property of there being no second policy,
    // not of the group policy's wording.
    const { rows } = await admin.query(`select policyname from pg_policies where tablename = 'locations'`);
    expect(rows).toHaveLength(1);
  });

  it('is guarded by the location capability and the version trigger, in that order', async () => {
    const { rows } = await admin.query<{ tgname: string; proname: string }>(
      `select t.tgname, p.proname
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_proc p on p.oid = t.tgfoid
        where c.relname = 'locations' and not t.tgisinternal
        order by t.tgname`,
    );

    const names = rows.map((row) => row.tgname);
    expect(names).toContain('locations_guard_administration');
    expect(names).toContain('locations_maintain_version');

    // Trigger firing order is by NAME. `_guard_` must sort before `_maintain_`
    // so an unauthorized write is refused before the counter moves — the same
    // property migration 0005 relies on and states.
    expect(
      names.indexOf('locations_guard_administration') <
        names.indexOf('locations_maintain_version'),
      `firing order: ${names.join(', ')}`,
    ).toBe(true);

    expect(
      rows.find((row) => row.tgname === 'locations_guard_administration')?.proname,
    ).toBe('app_guard_location_administration');
  });

  it('refuses a blank name, a blank site label and an unknown status', async () => {
    const { rows } = await admin.query<{ conname: string }>(
      `select conname from pg_constraint c
         join pg_class t on t.oid = c.conrelid
        where t.relname = 'locations' and c.contype = 'c'`,
    );
    const names = rows.map((row) => row.conname);

    expect(names).toContain('locations_name_shape');
    expect(names).toContain('locations_site_label_shape');
    expect(names).toContain('locations_address_shape');
    expect(names).toContain('locations_timezone_shape');
    expect(names).toContain('locations_status_known');
    expect(names).toContain('locations_version_positive');
  });

  it('is tenant-qualified on its unique key and its composite foreign key', async () => {
    const { rows } = await admin.query<{ conname: string; def: string }>(
      `select conname, pg_get_constraintdef(c.oid) as def
         from pg_constraint c join pg_class t on t.oid = c.conrelid
        where t.relname = 'locations' and c.contype in ('u', 'f')`,
    );
    const byName = new Map(rows.map((row) => [row.conname, row.def]));

    // doc 06 §3.2 gives uniqueness as `(group_id, name)`; SPEC-01 §4.3 requires
    // it tenant-qualified so the key cannot collide across organizations.
    expect(byName.get('locations_name_unique_in_group')).toMatch(
      /UNIQUE \(organization_id, group_id, name\)/,
    );
    expect(byName.get('locations_tenant_identity')).toMatch(
      /UNIQUE \(id, organization_id, group_id\)/,
    );
    // The FK carries BOTH tenant columns, so a location cannot point at another
    // organization's group.
    expect(byName.get('locations_group_fk')).toMatch(
      /FOREIGN KEY \(group_id, organization_id\) REFERENCES groups\(id, organization_id\)/,
    );
  });

  it('grants no DELETE to any role, and keeps `version` out of every UPDATE grant', async () => {
    const { rows } = await admin.query<{ grantee: string; privilege_type: string; column_name: string | null }>(
      `select grantee, privilege_type, column_name
         from information_schema.column_privileges
        where table_name = 'locations'
        union all
       select grantee, privilege_type, null
         from information_schema.table_privileges
        where table_name = 'locations'`,
    );

    const runtimeRoles = ['app_runtime', 'app_worker', 'app_readonly_support', 'app_breakglass'];

    for (const role of runtimeRoles) {
      const deletes = rows.filter(
        (row) => row.grantee === role && row.privilege_type === 'DELETE',
      );
      expect(deletes, `${role} holds no DELETE on locations`).toHaveLength(0);
    }

    /* `app_migrator` is the table OWNER and holds every privilege implicitly;
     * `information_schema` reports those, and they are not grants this migration
     * made. The claim being tested is about the RUNTIME roles — the ones a
     * request is served as — so the owner is excluded by name rather than by a
     * filter that would also hide a real grant.
     *
     * The owner is not a hole: it is refused by the capability-gate trigger like
     * everybody else (`app_require_capability` is not role-conditional — the
     * property OPUS-M3-002's seeding discovered by being refused), and no
     * request is ever served as it. */
    const runtime = (privilege: string, column: string) =>
      rows.filter(
        (row) =>
          row.privilege_type === privilege &&
          row.column_name === column &&
          row.grantee !== 'app_migrator',
      );

    // `version` is assigned by `app_maintain_catalogue_version`. Naming it in an
    // UPDATE must raise 42501 — a concurrency counter the writer can choose is
    // not a concurrency control.
    expect(runtime('UPDATE', 'version'), 'no runtime role may UPDATE locations.version').toHaveLength(
      0,
    );

    // Nor may a row be re-tenanted.
    for (const column of ['id', 'organization_id', 'group_id', 'created_at']) {
      expect(
        runtime('UPDATE', column),
        `no runtime role may UPDATE locations.${column}`,
      ).toHaveLength(0);
    }

    // Non-vacuous: the mutable columns ARE granted, so "zero grants" above is a
    // statement about those columns rather than about an empty result set.
    expect(runtime('UPDATE', 'name').map((row) => row.grantee).sort()).toEqual([
      'app_runtime',
      'app_worker',
    ]);
    expect(runtime('UPDATE', 'site_label').map((row) => row.grantee).sort()).toEqual([
      'app_runtime',
      'app_worker',
    ]);
  });

  it('is registered in TENANT_TABLES — the sweep floor this packet raises', () => {
    const entry = TENANT_TABLES.find((table) => table.name === 'locations');
    expect(entry, 'locations is registered').toBeDefined();
    expect(entry?.scope).toBe('organization-and-group');
    log(`      · sweep floor: ${String(TENANT_TABLES.length)} tenant tables registered`);
  });
});

describe('migration 0010 — the groups settings columns', () => {
  it('creates the four typed columns and NO json column', async () => {
    const { rows } = await admin.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `select column_name, data_type, is_nullable
         from information_schema.columns where table_name = 'groups'`,
    );
    const byName = new Map(rows.map((row) => [row.column_name, row]));

    expect(byName.get('request_until_mode')?.data_type).toBe('text');
    expect(byName.get('request_until_mode')?.is_nullable).toBe('NO');
    expect(byName.get('request_until_date')?.data_type).toBe('date');
    expect(byName.get('request_until_lead_days')?.data_type).toBe('integer');
    expect(byName.get('picklist_access_mode')?.data_type).toBe('text');
    expect(byName.get('picklist_access_mode')?.is_nullable).toBe('NO');

    // The packet's "no free-form JSON" requirement, asserted rather than
    // intended: a `settings jsonb` column is an escape hatch, and an escape
    // hatch is where the next unmodelled concept lands instead of getting a
    // migration.
    const json = rows.filter((row) => row.data_type === 'jsonb' || row.data_type === 'json');
    expect(json.map((row) => row.column_name), 'groups carries no json column').toEqual([]);
  });

  it('enforces the request-until discriminator shape', async () => {
    const { rows } = await admin.query<{ conname: string; def: string }>(
      `select conname, pg_get_constraintdef(c.oid) as def
         from pg_constraint c join pg_class t on t.oid = c.conrelid
        where t.relname = 'groups' and c.contype = 'c'`,
    );
    const byName = new Map(rows.map((row) => [row.conname, row.def]));

    expect(byName.has('groups_request_until_mode_known')).toBe(true);
    expect(byName.has('groups_picklist_access_mode_known')).toBe(true);
    expect(byName.has('groups_request_until_lead_days_range')).toBe(true);

    const shape = byName.get('groups_request_until_shape') ?? '';
    // Each mode names the columns it requires and the columns it forbids. A
    // discriminator whose CHECK only listed the legal mode VALUES would let a
    // `closed` row keep a stale date.
    expect(shape).toContain('closed');
    expect(shape).toContain('fixed_date');
    expect(shape).toContain('days_before_period_start');
    expect(shape).toContain('request_until_date');
    expect(shape).toContain('request_until_lead_days');
  });

  it('gates the settings columns and the timezone with SEPARATE capabilities', async () => {
    const { rows } = await admin.query<{ src: string }>(
      `select prosrc as src from pg_proc where proname = 'app_guard_group_settings'`,
    );
    expect(rows, 'the guard exists').toHaveLength(1);
    const source = rows[0]?.src ?? '';

    expect(source).toContain('group.settings.administer');
    expect(source).toContain('group.timezone.administer');

    // The gate fires only when a column actually MOVES: `groups` carries name,
    // status and pick_position_count too, and an unconditional gate would make a
    // group rename require the timezone capability.
    expect(source).toMatch(/IS DISTINCT FROM/);

    // INSERT is covered for the settings columns. The M2-002 review found the
    // mirror of this hole on pick_position_count: a BEFORE UPDATE-only guard was
    // one INSERT away from being decorative.
    expect(source).toMatch(/TG_OP\s*=\s*'INSERT'/);
  });

  it('grants UPDATE on the settings columns to the runtime roles and nothing else', async () => {
    const { rows } = await admin.query<{ grantee: string; column_name: string }>(
      `select grantee, column_name from information_schema.column_privileges
        where table_name = 'groups' and privilege_type = 'UPDATE'`,
    );

    const settingsColumns = [
      'request_until_mode',
      'request_until_date',
      'request_until_lead_days',
      'picklist_access_mode',
    ];

    // `app_migrator` owns the table and holds every privilege implicitly; the
    // claim is about the RUNTIME roles.
    const runtime = rows.filter((row) => row.grantee !== 'app_migrator');

    for (const column of settingsColumns) {
      const grantees = runtime
        .filter((row) => row.column_name === column)
        .map((row) => row.grantee);
      expect(grantees.sort(), `UPDATE(${column})`).toEqual(['app_runtime', 'app_worker']);
    }

    // group_version is 0001's AUTHORIZATION freshness counter and stays
    // database-owned. So does the settings counter this migration adds: a
    // concurrency token the writer can choose is not a concurrency control.
    for (const column of ['group_version', 'settings_version']) {
      expect(
        runtime.filter((row) => row.column_name === column),
        `${column} is not grantable to a runtime role`,
      ).toHaveLength(0);
    }
  });

  it('owns settings_version in the database, and moves it only when a SETTING moves', async () => {
    /* The counter exists because the first version of this slice guarded its
     * writes with `WHERE group_version = <read value>` — and `group_version`
     * bumps only on a `status` change (0001, SPEC-06 §4), so the predicate
     * matched forever and the second writer silently overwrote the first.
     * `test/settings/timezone.test.ts` caught it; this asserts the shape of the
     * fix rather than only its effect. */
    const { rows } = await admin.query<{ src: string }>(
      `select prosrc as src from pg_proc where proname = 'app_maintain_group_settings_version'`,
    );
    expect(rows, 'the counter function exists').toHaveLength(1);
    const source = rows[0]?.src ?? '';

    // It may not decrease...
    expect(source).toMatch(/may not decrease/);
    // ...and it moves for each of the five settings columns, and only those. A
    // rename or a pick-position increase must not invalidate an open settings
    // form, which is why the bump is conditional here and unconditional on the
    // catalogue's single-facet tables.
    for (const column of [
      'request_until_mode',
      'request_until_date',
      'request_until_lead_days',
      'picklist_access_mode',
      'timezone',
    ]) {
      expect(source, `the counter watches ${column}`).toContain(column);
    }
    expect(source).not.toContain('pick_position_count');
    expect(source).not.toMatch(/NEW\.name/);

    const triggers = await admin.query<{ tgname: string }>(
      `select t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
        where c.relname = 'groups' and not t.tgisinternal order by t.tgname`,
    );
    const names = triggers.rows.map((row) => row.tgname);
    expect(names).toContain('app_guard_group_settings_trigger');
    expect(names).toContain('app_maintain_group_settings_version_trigger');
    // Firing order is by name: the guard refuses before the counter moves.
    expect(
      names.indexOf('app_guard_group_settings_trigger') <
        names.indexOf('app_maintain_group_settings_version_trigger'),
      `firing order: ${names.join(', ')}`,
    ).toBe(true);
  });
});
