import { describe, expect, it } from 'vitest';

import { TENANT_TABLES } from '../../src/db/schema.js';

/**
 * The six tables migration 0018 creates are REGISTERED, and the sweep floor this
 * packet raises (OPUS-M4-003).
 *
 * ## Why this is a test rather than a convention
 *
 * `TENANT_TABLES` is what SBX-004's sweep, the T-13 fail-closed probe, the T-15
 * storm probe and the (role, table) privilege check all iterate. A tenant table
 * that is not in it is a table nothing ever probes — and the omission is
 * invisible, because every one of those tests keeps passing.
 *
 * `apps/api/test/tenancy/roles-and-schema.test.ts` asserts the complementary
 * half: that `TENANT_TABLES` and `NON_TENANT_TABLES` together account for every
 * table in the database. This asserts the half that file cannot — that these six
 * are on the TENANT side, and that the floor moved with them.
 */

const BUILD_TABLES = [
  'build_configurations',
  'build_runs',
  'build_run_events',
  'build_run_results',
  'build_run_violations',
  'build_run_candidate_assignments',
] as const;

describe('the build lifecycle in the tenant registry', () => {
  it('registers all six tables as organization-and-group', () => {
    for (const name of BUILD_TABLES) {
      const entry = TENANT_TABLES.find((table) => table.name === name);
      expect(entry, `${name} is not in TENANT_TABLES`).toBeDefined();
      /* Never `organization-only`: a build is a proposal about ONE group's
       * period, and every row it owns names participants of that group. */
      expect(entry?.scope, `${name} is scoped wrongly`).toBe('organization-and-group');
    }
  });

  it('raises the registry to at least 54 — the floor SBX-004 asserts', () => {
    /* 48 at OPUS-M4-001 (`solver_input_snapshots`), 54 here. The floor may be
     * raised and never lowered; `apps/api/test/sbx/sbx.test.ts` carries the same
     * number and the two are meant to move together. */
    expect(TENANT_TABLES.length, 'the tenant registry shrank').toBeGreaterThanOrEqual(54);
  });
});
