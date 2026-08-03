import { TENANT_TABLES } from '../../src/db/schema.js';

/**
 * The tables that are deliberately **not** in `TENANT_TABLES`, and why.
 *
 * ## Why this list exists at all
 *
 * An exclusion nobody wrote down is indistinguishable from an omission nobody
 * noticed — and OPUS-M1-004 exists partly because migration 0003's four tenant
 * tables were exactly that kind of omission. So the exclusions are declared,
 * each carries a reason, and `apps/api/test/tenancy/roles-and-schema.test.ts`
 * asserts that `TENANT_TABLES ∪ NON_TENANT_TABLES` is **every table in the
 * public schema**. A new table cannot be quietly left out of both.
 *
 * ## Why it lives in test support rather than beside the registry
 *
 * Because it names `audit_chain_heads`, and
 * `apps/api/test/audit/architecture.test.ts` asserts that **no module under
 * `src/` names that table at all** — the chain tip belongs to the SECURITY
 * DEFINER trigger and to nothing else. That rule is worth keeping absolute, and
 * a declaration that a table must never be reached is not a reason to weaken it.
 */
export interface NonTenantTable {
  readonly name: string;
  readonly reason: string;
}

export const NON_TENANT_TABLES: readonly NonTenantTable[] = [
  {
    name: 'audit_chain_heads',
    reason:
      'The chain tip. It IS organization-scoped and FORCE-RLS, but NO runtime role holds any '
      + 'grant on it — it moves only through the SECURITY DEFINER trigger — so the generic probes '
      + 'cannot even issue their SELECT against it. That is a stronger control than the registry '
      + 'can express, and it is pinned separately by test/audit/architecture.test.ts, which '
      + 'asserts that no TypeScript module names the table at all.',
  },
  {
    name: 'queue_pools',
    reason:
      'SP-D condition C-2 (FAD-14): the worker-pool heartbeat registry. It is NOT tenant-scoped '
      + 'and must not be — reclaiming a dead peer\'s in-flight jobs is a maintenance-plane '
      + 'operation across every tenant, so it cannot run inside a unit of work. '
      + 'src/db/queue-pools.ts is a declared connection owner for the same reason.',
  },
  {
    name: 'pgmigrations',
    reason:
      "node-pg-migrate's own migration ledger, owned by app_migrator. No runtime role touches it "
      + 'and it holds no tenant data.',
  },
];

/** Every table name the schema is expected to contain, from both lists. */
export function accountedForTables(): readonly string[] {
  return [...TENANT_TABLES.map((table) => table.name), ...NON_TENANT_TABLES.map((t) => t.name)];
}
