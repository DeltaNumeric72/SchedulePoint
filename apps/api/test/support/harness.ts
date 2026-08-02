import { expect } from 'vitest';
import type pg from 'pg';

import type { TenantContext } from '@schedulepoint/domain';

import { ProcessAlertSink } from '../../src/db/alerts.js';
import { createPool, type PoolOptions } from '../../src/db/pool.js';
import { TENANT_TABLES, type TenantTable } from '../../src/db/schema.js';
import { PgUnitOfWorkRunner } from '../../src/db/unit-of-work.js';
import type { RoleName } from '../../src/db/roles.js';
import { VALID_ORGANIZATIONS, VALID_PARTITIONS } from './fixtures.js';

/** A role's pool, runner and alert sink, disposed together. */
export interface Runtime {
  readonly role: RoleName;
  readonly pool: pg.Pool;
  readonly runner: PgUnitOfWorkRunner;
  readonly alerts: ProcessAlertSink;
  destroy(): Promise<void>;
}

export function createRuntime(role: RoleName, options: PoolOptions = {}): Runtime {
  const pool = createPool(role, { max: 4, allowExitOnIdle: true, ...options });
  // The sink swallows its stderr write so a deliberately-triggered page does not
  // bury the test output. The retained buffer is what the assertions read.
  const alerts = new ProcessAlertSink({ write: () => {} });
  const runner = new PgUnitOfWorkRunner({ role, pool, alerts });
  return {
    role,
    pool,
    runner,
    alerts,
    destroy: async () => {
      await pool.end();
    },
  };
}

/**
 * A statement issued **deliberately outside** any unit of work.
 *
 * This is the T-13 fail-closed probe, and it lives in test support on purpose:
 * production has no such function. `PgUnitOfWorkRunner` exposes no pool, no
 * client and no escape hatch, so the only way to reach a tenant table without
 * transaction-local context is to build a pool yourself — which is exactly what
 * this does, and which nothing under `src/` does.
 */
export async function outsideUnitOfWork<T extends pg.QueryResultRow = pg.QueryResultRow>(
  runtime: Runtime,
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  const client = await runtime.pool.connect();
  try {
    return await client.query<T>(text, params);
  } finally {
    client.release();
  }
}

/**
 * "No tenant value" is one of exactly two readings.
 *
 * On a **pristine** backend a never-set custom GUC reads back as `NULL`. On a
 * **reused** backend the placeholder survives with the EMPTY STRING as its reset
 * value, because `SET LOCAL` reverts a GUC's value without undefining the GUC.
 * Both are "no tenant", both are fail-closed, and the second is the production
 * steady state — which is why every RLS predicate is spelled
 * `nullif(current_setting(...), '')` (SPIKE-REPORT §6.1 / X-09).
 */
export function assertNoTenantValue(actual: string | null, label: string): void {
  expect(
    actual === null || actual === '',
    `${label}: expected no tenant value, found ${JSON.stringify(actual)}`,
  ).toBe(true);
}

/**
 * Grab every connection the pool can hold and assert not one of them carries
 * tenant context, and not one of them can read a tenant row.
 *
 * This is the "next checkout sees no setting" clause of T-07..T-10, checked
 * across the whole pool rather than against one lucky checkout.
 */
export async function assertPoolIsClean(runtime: Runtime, label: string): Promise<void> {
  const max = (runtime.pool as unknown as { options: { max: number } }).options.max;
  const clients = await Promise.all(Array.from({ length: max }, () => runtime.pool.connect()));
  try {
    for (const client of clients) {
      const settings = await client.query<{
        organization: string | null;
        group: string | null;
        membership: string | null;
        pid: number;
      }>(
        `select current_setting('app.organization_id', true) as organization,
                current_setting('app.group_id',        true) as "group",
                current_setting('app.membership_id',   true) as membership,
                pg_backend_pid() as pid`,
      );
      const row = settings.rows[0];
      assertNoTenantValue(row?.organization ?? null, `${label}: backend ${String(row?.pid)} app.organization_id`);
      assertNoTenantValue(row?.group ?? null, `${label}: backend ${String(row?.pid)} app.group_id`);
      assertNoTenantValue(row?.membership ?? null, `${label}: backend ${String(row?.pid)} app.membership_id`);

      // The consequence that actually matters, asserted directly rather than
      // inferred from the settings.
      for (const table of TENANT_TABLES) {
        const count = await client.query<{ n: number }>(
          `select count(*)::int as n from ${table.name}`,
        );
        expect(
          count.rows[0]?.n,
          `${label}: backend ${String(row?.pid)} sees ${String(count.rows[0]?.n)} ${table.name} rows outside the wrapper`,
        ).toBe(0);
      }
    }
  } finally {
    for (const client of clients) client.release();
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * The wrong-tenant probe
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ProbeResult {
  readonly table: string;
  readonly wrong: number;
  readonly visible: number;
}

/**
 * Every user id that MAY legitimately be visible under a context, computed from
 * ground truth with the superuser.
 *
 * `users` is global (PO-DEC-06) and reachable only through a membership visible
 * in the current context, so "which users should I see" is a property of the
 * membership table rather than of a tenant column — and it cannot be expressed
 * as a predicate the probe evaluates inside its own RLS-filtered query.
 */
export async function expectedVisibleUserIds(
  admin: pg.Client,
  context: TenantContext,
): Promise<string[]> {
  const result = await admin.query<{ user_id: string }>(
    `select distinct user_id
       from memberships
      where organization_id = $1::uuid
        and ($2::uuid is null or group_id = $2::uuid)`,
    [context.organizationId, context.groupId],
  );
  return result.rows.map((row) => row.user_id);
}

/**
 * "How many rows can I see that do NOT belong to my context?"
 *
 * Must return `wrong = 0` in a correct system, always, on every table, under
 * every role, inside and outside the wrapper.
 *
 * The table name is interpolated because an identifier cannot be a bind
 * parameter. It comes only from `TENANT_TABLES` — a closed, hard-coded registry
 * in `src/db/schema.ts` — and never from input.
 */
export function wrongTenantProbe(
  table: TenantTable,
  context: TenantContext,
  expectedUserIds: readonly string[],
): { text: string; values: unknown[] } {
  switch (table.scope) {
    case 'organization-identity':
      return {
        text: `select count(*) filter (where id is distinct from $1::uuid)::int as wrong,
                      count(*)::int as visible
                 from ${table.name}`,
        values: [context.organizationId],
      };

    case 'organization-and-group': {
      // `groups` is keyed by `id`; `memberships` carries `group_id`. Both must
      // be confined to the declared organization, and to the declared group when
      // one is in force.
      const groupColumn = table.name === 'groups' ? 'id' : 'group_id';
      return {
        text: `select count(*) filter (
                        where organization_id is distinct from $1::uuid
                           or ($2::uuid is not null and ${groupColumn} is distinct from $2::uuid)
                      )::int as wrong,
                      count(*)::int as visible
                 from ${table.name}`,
        values: [context.organizationId, context.groupId],
      };
    }

    case 'through-membership':
      return {
        text: `select count(*) filter (where id <> all($1::uuid[]))::int as wrong,
                      count(*)::int as visible
                 from ${table.name}`,
        values: [expectedUserIds],
      };
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Ground truth
 * ──────────────────────────────────────────────────────────────────────────── */

export interface CensusRow {
  readonly table: string;
  readonly organizationId: string;
  readonly groupId: string | null;
  readonly n: number;
}

/**
 * A census of every tenant-scoped partition, read out of band with the
 * superuser. Never used to prove application behaviour — only to check that no
 * row anywhere landed in a partition that cannot legitimately exist.
 */
export async function tenantRowCensus(admin: pg.Client): Promise<CensusRow[]> {
  const result = await admin.query<{
    tbl: string;
    organization_id: string;
    group_id: string | null;
    n: string;
  }>(
    `select 'organizations' as tbl, id as organization_id, null::uuid as group_id, count(*)::text as n
       from organizations group by 1, 2, 3
     union all
     select 'groups', organization_id, id, count(*)::text from groups group by 1, 2, 3
     union all
     select 'memberships', organization_id, group_id, count(*)::text from memberships group by 1, 2, 3
     order by 1, 2, 3`,
  );
  return result.rows.map((row) => ({
    table: row.tbl,
    organizationId: row.organization_id,
    groupId: row.group_id,
    n: Number(row.n),
  }));
}

/**
 * The (organization, group) pairs that legitimately exist, read from ground
 * truth rather than hard-coded.
 *
 * The fixture's four pairs are in `VALID_PARTITIONS`, but tests create groups of
 * their own as write markers, and a census that flagged those would be measuring
 * the test rather than the system. Reading the pairs from `groups` keeps the
 * census honest: the question it asks is "does any row sit in a partition that
 * does not exist", and `groups` is what defines which partitions exist.
 */
export async function actualPartitions(admin: pg.Client): Promise<ReadonlySet<string>> {
  const result = await admin.query<{ id: string; organization_id: string }>(
    'select id, organization_id from groups',
  );
  const pairs = new Set(result.rows.map((row) => `${row.organization_id}|${row.id}`));
  // The fixture's pairs must always be among them; if a test deleted one, the
  // census would silently start passing for the wrong reason.
  for (const pair of VALID_PARTITIONS) {
    if (!pairs.has(pair)) throw new Error(`fixture partition ${pair} has disappeared`);
  }
  return pairs;
}

/** Every census row whose (organization, group) partition cannot legitimately exist. */
export function impossibleCensusRows(
  rows: readonly CensusRow[],
  partitions: ReadonlySet<string>,
): CensusRow[] {
  return rows.filter((row) => {
    // A row's ORGANIZATION must always be one of the two that exist. That is the
    // tenant boundary, and no test may create a third.
    if (!VALID_ORGANIZATIONS.has(row.organizationId)) return true;
    // `organizations` and organization-scoped `memberships` carry no group.
    if (row.groupId === null) return false;
    // `groups` rows are keyed by their own id, which by construction defines a
    // partition; everything else must sit in one that exists.
    if (row.table === 'groups') return false;
    return !partitions.has(`${row.organizationId}|${row.groupId}`);
  });
}

export function log(...parts: unknown[]): void {
  console.log('      ·', ...parts);
}
