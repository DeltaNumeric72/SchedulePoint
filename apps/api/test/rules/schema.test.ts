import { RULE_NODE_KINDS } from '@schedulepoint/domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TENANT_TABLES } from '../../src/db/schema.js';
import { adminClient } from '../support/admin-client.js';
import { log } from '../support/harness.js';

/**
 * Migration 0008's schema, asserted against the code that depends on it.
 *
 * ## The specific failure this file exists to catch
 *
 * A CHECK constraint and a TypeScript constant that list the same values are two
 * copies of one fact — the `catalogue/schema.test.ts` finding, applied to the
 * thing it matters most for here: **the closed node set**. If
 * `rules_predicate_kind_is_closed` and `RULE_NODE_KINDS` drift, the symptom is a
 * rule the compiler can map and the database refuses (or, far worse, one the
 * database accepts and the compiler cannot map — a build-time error at run time,
 * which is exactly what SPEC-04 §3.2 forbids).
 *
 * So the members are read out of `pg_constraint` and compared with the domain
 * constant: two copies, one assertion.
 */

const RULE_TABLES = ['rules', 'rule_sets'] as const;

let admin: pg.Client;

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
});

/** Every constraint definition on a table, from the catalog. */
async function constraintDefs(table: string): Promise<string[]> {
  const result = await admin.query<{ definition: string }>(
    `select pg_get_constraintdef(c.oid) as definition
       from pg_constraint c
       join pg_class t on t.oid = c.conrelid
      where t.relname = $1 and c.contype = 'c'`,
    [table],
  );
  return result.rows.map((row) => row.definition);
}

describe('migration 0008 — the tables exist with RLS enabled AND forced', () => {
  it('both tables have relrowsecurity and relforcerowsecurity', async () => {
    const result = await admin.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `select relname, relrowsecurity, relforcerowsecurity
         from pg_class where relname = any($1::text[])`,
      [[...RULE_TABLES]],
    );
    expect(result.rows).toHaveLength(RULE_TABLES.length);
    for (const row of result.rows) {
      expect(row.relrowsecurity, `${row.relname} has RLS disabled`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} does not FORCE RLS`).toBe(true);
    }
  });

  it('every policy pins the tenant with the nullif-guarded spelling (A-03b)', async () => {
    const result = await admin.query<{
      tablename: string;
      policyname: string;
      qual: string | null;
      with_check: string | null;
    }>(
      `select tablename, policyname, qual, with_check
         from pg_policies where tablename = any($1::text[])`,
      [[...RULE_TABLES]],
    );
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      for (const expression of [row.qual, row.with_check]) {
        if (expression === null) continue;
        // Every `current_setting('app.*')` occurrence must be nullif-guarded —
        // an unguarded one returns '' and casts to a uuid error, or worse,
        // silently matches nothing and hides a broken predicate.
        const occurrences = [...expression.matchAll(/current_setting\('app\.[a-z_]+'/g)];
        expect(occurrences.length, `${row.policyname} names no app setting`).toBeGreaterThan(0);
        const guarded = [...expression.matchAll(/NULLIF\(current_setting\('app\.[a-z_]+'/gi)];
        expect(guarded.length, `${row.policyname} has an unguarded current_setting`).toBe(
          occurrences.length,
        );
      }
    }
    log(
      `      · ${String(result.rows.length)} policy expression(s) on rules/rule_sets, all nullif-guarded`,
    );
  });

  it('both tables are registered in TENANT_TABLES (packet 30 §7.2)', () => {
    const registered = new Set(TENANT_TABLES.map((table) => table.name));
    for (const table of RULE_TABLES) expect(registered.has(table)).toBe(true);
  });
});

describe('the closed node set is enforced by the database (SPEC-04 §3.1)', () => {
  it('the CHECK lists exactly the thirty kinds the domain declares', async () => {
    const definitions = await constraintDefs('rules');
    const closed = definitions.find((definition) => definition.includes("predicate ->> 'kind'"));
    expect(closed, 'rules_predicate_kind_is_closed is missing').toBeDefined();

    // The discriminator expression itself contains `->> 'kind'`, which the
    // literal regex would otherwise capture as a thirty-first "node kind".
    // Stripped rather than filtered by name: a filter on the string `kind` would
    // also silently hide a genuine node kind if one were ever called that.
    const listOnly = (closed ?? '').replace(/->>\s*'kind'::text/g, '->> _');
    const members = new Set(
      [...listOnly.matchAll(/'([A-Za-z]+)'::text/g)].map((match) => match[1] as string),
    );
    expect(members).toEqual(new Set(RULE_NODE_KINDS));
    log(
      `      · the database CHECK and RULE_NODE_KINDS agree on ${String(members.size)} node kinds`,
    );
  });

  it('the hard/soft CHECK (CAR-006) exists and names both arms', async () => {
    const definitions = await constraintDefs('rules');
    const hardSoft = definitions.find(
      (definition) =>
        definition.includes("'HARD'") &&
        definition.includes("'SOFT'") &&
        definition.includes('weight'),
    );
    expect(hardSoft, 'rules_hard_soft_weight is missing').toBeDefined();
    expect(hardSoft).toMatch(/weight IS NULL/);
    expect(hardSoft).toMatch(/weight IS NOT NULL/);
  });

  it('the category discriminator is a closed enum (FAD-21)', async () => {
    const definitions = await constraintDefs('rules');
    const category = definitions.find(
      (definition) => definition.includes('category') && definition.includes("'general'"),
    );
    expect(category, 'the category CHECK is missing').toBeDefined();
    const members = new Set(
      [...(category ?? '').matchAll(/'([a-z]+)'::text/g)].map((match) => match[1] as string),
    );
    expect(members).toEqual(new Set(['general', 'pattern', 'staff']));
  });
});

describe('the runtime roles hold no privilege they should not', () => {
  it('rule_key is absent from every UPDATE grant (stable-ID discipline)', async () => {
    const result = await admin.query<{ column_name: string }>(
      `select column_name from information_schema.column_privileges
        where table_name = 'rules' and privilege_type = 'UPDATE'
          and grantee in ('app_runtime', 'app_worker')`,
    );
    const updatable = new Set(result.rows.map((row) => row.column_name));
    for (const column of [
      'rule_key',
      'id',
      'organization_id',
      'group_id',
      'version',
      'created_at',
    ]) {
      expect(updatable.has(column), `${column} is UPDATE-grantable and must not be`).toBe(false);
    }
    log(`      · updatable columns on rules: ${[...updatable].sort().join(', ')}`);
  });

  it('no runtime role holds DELETE on either table', async () => {
    const result = await admin.query<{ table_name: string; grantee: string }>(
      `select table_name, grantee from information_schema.table_privileges
        where table_name = any($1::text[]) and privilege_type = 'DELETE'
          and grantee in ('app_runtime', 'app_worker', 'app_readonly_support')`,
      [[...RULE_TABLES]],
    );
    expect(result.rows).toEqual([]);
  });
});
