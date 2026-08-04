import { SHIFT_PALETTE_KEYS, SHIFT_TEXT_STYLES, CATALOGUE_DAYS } from '@schedulepoint/domain';
import { SHIFT_PALETTE_KEY_VALUES, SHIFT_TEXT_STYLE_VALUES, CATALOGUE_DAY_VALUES } from '@schedulepoint/contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TENANT_TABLES } from '../../src/db/schema.js';
import { adminClient } from '../support/admin-client.js';
import { log } from '../support/harness.js';

/**
 * Migration 0005's schema, asserted against the code that depends on it.
 *
 * ## The specific failure this file exists to catch
 *
 * A CHECK constraint and a TypeScript constant that list the same values are two
 * copies of one fact. When they drift, the symptom is a save that fails for no
 * visible reason: the form offers a palette key the database refuses, and the
 * user sees a generic error. Nothing in a type system notices, because both
 * sides type-check perfectly against themselves.
 *
 * So the members are read out of `pg_constraint` and compared with the domain
 * constant and the contract enum — three copies, one assertion.
 */

const CATALOGUE_TABLES = [
  'shift_types',
  'shift_type_weekday_demand',
  'shift_groups',
  'shift_group_members',
  'staff_groups',
  'staff_group_members',
  'valid_groups',
  'valid_group_shift_types',
  'group_holidays',
] as const;

let admin: pg.Client;

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
});

/** The literal members of a single-column `IN (...)` CHECK, read from the catalog. */
async function checkMembers(table: string, column: string): Promise<string[]> {
  const result = await admin.query<{ definition: string }>(
    `select pg_get_constraintdef(c.oid) as definition
       from pg_constraint c
       join pg_class t on t.oid = c.conrelid
      where t.relname = $1 and c.contype = 'c' and pg_get_constraintdef(c.oid) like $2`,
    [table, `%${column}%`],
  );
  const members = new Set<string>();
  for (const row of result.rows) {
    for (const match of row.definition.matchAll(/'([a-z_]+)'::text/g)) {
      const value = match[1];
      if (value !== undefined) members.add(value);
    }
  }
  return [...members].sort();
}

describe('the display token sets agree in all three places', () => {
  it('display_palette_key: database CHECK == domain constant == contract enum', async () => {
    const fromDatabase = await checkMembers('shift_types', 'display_palette_key');
    expect(fromDatabase).toEqual([...SHIFT_PALETTE_KEYS].sort());
    expect([...SHIFT_PALETTE_KEY_VALUES].sort()).toEqual([...SHIFT_PALETTE_KEYS].sort());
    log(`display_palette_key: ${fromDatabase.join(', ')} — database, domain and contract agree`);
  });

  it('display_text_style: database CHECK == domain constant == contract enum', async () => {
    const fromDatabase = await checkMembers('shift_types', 'display_text_style');
    expect(fromDatabase).toEqual([...SHIFT_TEXT_STYLES].sort());
    expect([...SHIFT_TEXT_STYLE_VALUES].sort()).toEqual([...SHIFT_TEXT_STYLES].sort());
    log(`display_text_style: ${fromDatabase.join(', ')} — database, domain and contract agree`);
  });

  it('the demand day enumeration agrees, holiday included', async () => {
    const fromDatabase = await checkMembers('shift_type_weekday_demand', 'day');
    expect(fromDatabase).toEqual([...CATALOGUE_DAYS].sort());
    expect([...CATALOGUE_DAY_VALUES].sort()).toEqual([...CATALOGUE_DAYS].sort());
    expect(fromDatabase, 'holiday is not a day value — the M4 demand input is incomplete').toContain(
      'holiday',
    );
    log(`demand days: ${fromDatabase.join(', ')}`);
  });
});

describe('every catalogue table is a tenant table in the full sense', () => {
  it('RLS is enabled AND forced on all nine', async () => {
    const result = await admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `select relname, relrowsecurity, relforcerowsecurity
         from pg_class where relname = any($1::text[])`,
      [[...CATALOGUE_TABLES]],
    );
    expect(result.rows).toHaveLength(CATALOGUE_TABLES.length);
    for (const row of result.rows) {
      expect(row.relrowsecurity, `${row.relname}: RLS not enabled`).toBe(true);
      // FORCE is what binds the table OWNER. Without it, `app_migrator` — which
      // runs migrations and owns every table — reads every tenant.
      expect(row.relforcerowsecurity, `${row.relname}: RLS not FORCEd`).toBe(true);
    }
    log(`${String(result.rows.length)} catalogue tables: RLS enabled and FORCEd`);
  });

  it('every policy reference to app.* is nullif-guarded (A-03b)', async () => {
    // The spelling rule from 0001, applied to this migration's policies. An
    // unguarded `current_setting('app.x', true)::uuid` throws on an empty string
    // rather than returning NULL, and a policy that throws is a policy whose
    // failure mode nobody has thought about.
    const result = await admin.query<{ tablename: string; policyname: string; qual: string | null; with_check: string | null }>(
      `select tablename, policyname, qual, with_check
         from pg_policies where tablename = any($1::text[])`,
      [[...CATALOGUE_TABLES]],
    );
    expect(result.rows.length).toBeGreaterThanOrEqual(CATALOGUE_TABLES.length);

    for (const row of result.rows) {
      for (const expression of [row.qual, row.with_check]) {
        if (expression === null) continue;
        const references = [...expression.matchAll(/current_setting\('app\.[a-z_]+'::text, true\)/g)];
        expect(references.length, `${row.policyname}: no app.* reference at all`).toBeGreaterThan(0);
        const guarded = [...expression.matchAll(/NULLIF\(current_setting\('app\.[a-z_]+'::text, true\), ''::text\)/gi)];
        expect(
          guarded.length,
          `${row.tablename}.${row.policyname}: ${String(references.length)} app.* references, ${String(guarded.length)} nullif-guarded`,
        ).toBe(references.length);
      }
    }
    log(`${String(result.rows.length)} catalogue policies, every app.* reference nullif-guarded`);
  });

  it('all nine are registered in TENANT_TABLES, in the same change as the migration', () => {
    const registered = new Set(TENANT_TABLES.map((table) => table.name));
    for (const table of CATALOGUE_TABLES) {
      expect(registered, `${table} is not in TENANT_TABLES`).toContain(table);
    }
    log('all nine catalogue tables registered in TENANT_TABLES (packet 30 §7.2)');
  });

  it('no runtime role holds TRUNCATE or REFERENCES on any of them', async () => {
    // Neither is subject to RLS, so withholding the grant is the only control.
    for (const role of ['app_runtime', 'app_worker', 'app_readonly_support', 'app_breakglass']) {
      for (const table of CATALOGUE_TABLES) {
        const result = await admin.query<{ t: boolean; r: boolean }>(
          `select has_table_privilege($1, $2, 'TRUNCATE') as t,
                  has_table_privilege($1, $2, 'REFERENCES') as r`,
          [role, table],
        );
        expect(result.rows[0]?.t, `${role} holds TRUNCATE on ${table}`).toBe(false);
        expect(result.rows[0]?.r, `${role} holds REFERENCES on ${table}`).toBe(false);
      }
    }
    log('36 (role, table) pairs: no TRUNCATE, no REFERENCES');
  });

  it('`code` is NOT updatable — a shift type\'s permanent name cannot be rewritten', async () => {
    // The stable-identifier rule (non-bypass rule 13's shape) reached through
    // tenant data: a code is cited by grids, reports and audit rows, and a
    // silent rename would corrupt every citation while each still looked right.
    for (const role of ['app_runtime', 'app_worker']) {
      const result = await admin.query<{ allowed: boolean }>(
        `select has_column_privilege($1, 'shift_types', 'code', 'UPDATE') as allowed`,
        [role],
      );
      expect(result.rows[0]?.allowed, `${role} may UPDATE shift_types.code`).toBe(false);
    }
    // And the ALLOW control: `name` IS updatable, so the assertion above is
    // about `code` rather than about the whole table being read-only.
    const nameUpdatable = await admin.query<{ allowed: boolean }>(
      `select has_column_privilege('app_runtime', 'shift_types', 'name', 'UPDATE') as allowed`,
    );
    expect(nameUpdatable.rows[0]?.allowed).toBe(true);
    log('shift_types.code not updatable by any runtime role; shift_types.name is');
  });
});

describe('the shape constraints refuse the states that make no sense', () => {
  /** Inserted as the superuser, which the triggers still gate — so the CHECKs are
   * exercised through a path that reaches them: a valid row first, then mutations
   * of it that violate one constraint each. */
  it('an overnight shift must declare crosses_midnight, and a daytime one must not', async () => {
    const definition = await admin.query<{ definition: string }>(
      `select pg_get_constraintdef(c.oid) as definition
         from pg_constraint c join pg_class t on t.oid = c.conrelid
        where t.relname = 'shift_types' and c.conname = 'shift_types_overnight_shape'`,
    );
    const text = definition.rows[0]?.definition ?? '';
    expect(text, 'shift_types_overnight_shape is missing').toContain('crosses_midnight');
    expect(text).toContain('end_time');
    log(`shift_types_overnight_shape: ${text}`);
  });

  it('a shift group carries a weight exactly when it is weighted', async () => {
    const definition = await admin.query<{ definition: string }>(
      `select pg_get_constraintdef(c.oid) as definition
         from pg_constraint c join pg_class t on t.oid = c.conrelid
        where t.relname = 'shift_groups' and c.conname = 'shift_groups_scoring_shape'`,
    );
    const text = definition.rows[0]?.definition ?? '';
    expect(text, 'shift_groups_scoring_shape is missing').toContain('weight');
    log(`shift_groups_scoring_shape: ${text}`);
  });

  it('a request-off label exists exactly when requests are allowed', async () => {
    const definition = await admin.query<{ definition: string }>(
      `select pg_get_constraintdef(c.oid) as definition
         from pg_constraint c join pg_class t on t.oid = c.conrelid
        where t.relname = 'shift_groups' and c.conname = 'shift_groups_request_label_shape'`,
    );
    expect(definition.rows[0]?.definition, 'shift_groups_request_label_shape is missing').toContain(
      'request_off_label',
    );
    log('shift_groups_request_label_shape present');
  });

  it('every catalogue table carries a composite tenant foreign key to groups', async () => {
    for (const table of CATALOGUE_TABLES) {
      const result = await admin.query<{ definition: string }>(
        `select pg_get_constraintdef(c.oid) as definition
           from pg_constraint c join pg_class t on t.oid = c.conrelid
          where t.relname = $1 and c.contype = 'f'
            and pg_get_constraintdef(c.oid) like 'FOREIGN KEY (group_id, organization_id)%'`,
        [table],
      );
      expect(
        result.rows.length,
        `${table} has no composite (group_id, organization_id) foreign key — a single-column FK ` +
          'accepts a parent from another tenant, because FK checks bypass RLS (X-06)',
      ).toBeGreaterThan(0);
    }
    log('all nine catalogue tables carry the composite tenant foreign key');
  });
});
