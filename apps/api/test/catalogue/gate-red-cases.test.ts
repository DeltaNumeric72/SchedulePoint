import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SHIFT_TYPE_CONFIG } from '../../src/catalogue/policies.js';
import { log } from '../support/harness.js';

/**
 * The two build-failing gates, exercised against **this task's own tables and
 * routes** rather than against a generic fixture.
 *
 * Packet 30: "New tenant table without RLS fails the gate (**exercised for one
 * of this task's tables** in a red-case proof); route without policy fails the
 * gate."
 *
 * `scripts/red-cases/` already proves both gates fire on their generic
 * violations. That is not the same claim as this one: it proves the gate works,
 * and this proves the gate would have caught **`shift_types` shipped without a
 * policy** — the specific mistake this migration could have made. The two are
 * complementary and neither replaces the other.
 *
 * Both cases run the gate's OWN exported analyzer, never a copy of its rules,
 * so narrowing a pattern turns these red rather than leaving them green against
 * a private reimplementation.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(HERE, '../../migrations/0005_shift_catalogue.sql');

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly detail: string;
}

/**
 * The gates' OWN analyzers, loaded at run time.
 *
 * A dynamic import with an explicit signature rather than a static one: the
 * gates are hand-written `.mjs` with JSDoc types and no declaration files, so a
 * static import is an implicit `any` the strict build refuses. The signature
 * below is asserted by use — if a gate's analyzer changed shape, these cases
 * would fail rather than silently pass against a stale expectation.
 */
async function migrationAnalyzer(): Promise<
  (file: { path: string; sql: string }) => Violation[]
> {
  const loaded: unknown = await import(
    /* @vite-ignore */ resolve(HERE, '../../../../scripts/gates/migration-rls-check.mjs')
  );
  return (loaded as { analyzeFile: (file: { path: string; sql: string }) => Violation[] })
    .analyzeFile;
}

async function routeAnalyzer(): Promise<
  (routes: { method: string; url: string; policy: unknown }[]) => Violation[]
> {
  const loaded: unknown = await import(
    /* @vite-ignore */ resolve(HERE, '../../../../scripts/gates/route-policy-check.mjs')
  );
  return (loaded as { analyze: (routes: { method: string; url: string; policy: unknown }[]) => Violation[] })
    .analyze;
}

describe('migration + RLS pairing, against this task\'s own tables', () => {
  it('GREEN: 0005 as shipped has ENABLE + FORCE + a policy for every table it creates', async () => {
    const analyzeFile = await migrationAnalyzer();
    const sql = readFileSync(MIGRATION, 'utf8');
    const violations = analyzeFile({ path: '0005_shift_catalogue.sql', sql });
    expect(
      violations.map((violation) => violation.detail),
      'the shipped migration fails the RLS pairing gate',
    ).toEqual([]);
    log('0005 as shipped: 0 RLS pairing violations');
  });

  it('RED: `shift_types` with its policy removed FAILS the gate, naming the table', async () => {
    const analyzeFile = await migrationAnalyzer();
    // The real migration text with one control deleted — not a toy fixture.
    // A synthetic `CREATE TABLE t (…)` would prove the regex works; this proves
    // the gate would have caught THIS table shipped without THIS policy.
    const sql = readFileSync(MIGRATION, 'utf8').replace(
      /CREATE POLICY shift_types_group_scope[\s\S]*?;\n/,
      '',
    );
    const violations = analyzeFile({ path: '0005_shift_catalogue.sql', sql });
    const detail = violations.map((violation) => violation.detail).join(' | ');
    expect(detail).toContain('shift_types');
    expect(detail).toContain('CREATE POLICY');
    log(`RED (policy deleted): ${detail}`);
  });

  it('RED: `group_holidays` with FORCE removed FAILS the gate', async () => {
    const analyzeFile = await migrationAnalyzer();
    // FORCE is what binds the table OWNER. Without it `app_migrator` — which
    // runs migrations and owns every table — reads every tenant, and ENABLE
    // alone looks entirely correct in review.
    const sql = readFileSync(MIGRATION, 'utf8').replace(
      'ALTER TABLE group_holidays             FORCE  ROW LEVEL SECURITY;',
      '',
    );
    const violations = analyzeFile({ path: '0005_shift_catalogue.sql', sql });
    const detail = violations.map((violation) => violation.detail).join(' | ');
    expect(detail).toContain('group_holidays');
    expect(detail).toContain('FORCE ROW LEVEL SECURITY');
    log(`RED (FORCE deleted): ${detail}`);
  });
});

describe('route-without-policy, against this task\'s own routes', () => {
  const CATALOGUE_URL =
    '/organizations/:organizationId/groups/:groupId/catalogue/shift-types';

  it('GREEN: the catalogue route as declared passes', async () => {
    const analyzeRoutes = await routeAnalyzer();
    expect(
      analyzeRoutes([{ method: 'POST', url: CATALOGUE_URL, policy: SHIFT_TYPE_CONFIG.policy }]),
    ).toEqual([]);
  });

  it('RED: the same route with its policy removed FAILS, naming the route', async () => {
    const analyzeRoutes = await routeAnalyzer();
    const violations = analyzeRoutes([{ method: 'POST', url: CATALOGUE_URL, policy: undefined }]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe(`POST ${CATALOGUE_URL}`);
    expect(violations[0]?.detail).toContain('without a policy declaration');
    log(`RED (policy removed): ${violations[0]?.file ?? ''} — ${violations[0]?.detail ?? ''}`);
  });

  it('RED: an EMPTY route table is a failure, not a vacuous pass', async () => {
    const analyzeRoutes = await routeAnalyzer();
    // The gate's own non-vacuity floor, asserted here because a catalogue route
    // file that failed to register would otherwise produce a green run.
    expect(analyzeRoutes([])).toHaveLength(1);
  });
});
