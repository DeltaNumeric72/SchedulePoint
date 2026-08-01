import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- gate scripts are plain JS with JSDoc types; there is no .d.ts.
import { analyzeFile } from '../migration-rls-check.mjs';

/**
 * The migration+RLS gate runs against an empty directory in this repository,
 * which means the gate itself is trivially green and proves nothing. These
 * tests are what actually establish that it works: real fixture migrations, one
 * set that must pass and one set that must fail, each for a named reason.
 *
 * A gate whose only evidence is "it passed on no input" is not a gate.
 */

const FIXTURES = fileURLToPath(new URL('./fixtures/migrations', import.meta.url));

function load(kind: 'green' | 'red', name: string): { path: string; sql: string } {
  const path = join(FIXTURES, kind, name);
  return { path, sql: readFileSync(path, 'utf8') };
}

function names(kind: 'green' | 'red'): string[] {
  return readdirSync(join(FIXTURES, kind)).filter((f) => f.endsWith('.sql'));
}

describe('migration + RLS pairing — green fixtures', () => {
  it.each(names('green'))('%s produces no violation', (name) => {
    expect(analyzeFile(load('green', name))).toEqual([]);
  });

  it('has green fixtures at all', () => {
    expect(names('green').length).toBeGreaterThan(0);
  });
});

describe('migration + RLS pairing — red fixtures', () => {
  it.each(names('red'))('%s is rejected', (name) => {
    const violations = analyzeFile(load('red', name));
    expect(violations.length).toBeGreaterThan(0);
  });

  it('names the missing clause rather than failing vaguely', () => {
    const [violation] = analyzeFile(load('red', '001-no-rls-at-all.sql')) as {
      detail: string;
    }[];
    expect(violation?.detail).toContain('ENABLE ROW LEVEL SECURITY');
    expect(violation?.detail).toContain('FORCE ROW LEVEL SECURITY');
    expect(violation?.detail).toContain('CREATE POLICY');
  });

  it('rejects a table that enables RLS but never forces it', () => {
    const violations = analyzeFile(load('red', '002-enabled-but-not-forced.sql')) as {
      detail: string;
    }[];
    expect(violations[0]?.detail).toContain('FORCE ROW LEVEL SECURITY');
    expect(violations[0]?.detail).not.toContain('ENABLE ROW LEVEL SECURITY');
  });

  it('rejects RLS enabled on a DIFFERENT table than the one created', () => {
    // The failure mode a naive "does the file mention RLS anywhere" check misses.
    expect(analyzeFile(load('red', '003-rls-on-wrong-table.sql')).length).toBeGreaterThan(0);
  });
});

describe('migration + RLS pairing — opt-out', () => {
  it('accepts a non-tenant table when the opt-out states a reason', () => {
    expect(analyzeFile(load('green', '003-opt-out-with-reason.sql'))).toEqual([]);
  });

  it('rejects an opt-out with an empty reason', () => {
    expect(analyzeFile(load('red', '004-opt-out-without-reason.sql')).length).toBeGreaterThan(0);
  });
});

describe('migration + RLS pairing — parsing', () => {
  it('ignores a CREATE TABLE inside a block comment', () => {
    expect(
      analyzeFile({
        path: 'inline.sql',
        sql: '/* CREATE TABLE shift (id uuid); */\nSELECT 1;\n',
      }),
    ).toEqual([]);
  });

  it('handles schema-qualified and quoted identifiers', () => {
    expect(
      analyzeFile({
        path: 'inline.sql',
        sql: [
          'CREATE TABLE app."shift" (id uuid primary key, organization_id uuid not null);',
          'ALTER TABLE app.shift ENABLE ROW LEVEL SECURITY;',
          'ALTER TABLE app.shift FORCE ROW LEVEL SECURITY;',
          'CREATE POLICY shift_tenant ON app.shift USING (true);',
        ].join('\n'),
      }),
    ).toEqual([]);
  });
});
