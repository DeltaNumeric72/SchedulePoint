import { expect } from 'vitest';
import type pg from 'pg';

import type { TenantContext } from '@schedulepoint/domain';

import { ProcessAlertSink } from '../../src/db/alerts.js';
import { createPool, type PoolOptions } from '../../src/db/pool.js';
import { TENANT_TABLES, type TenantTable } from '../../src/db/schema.js';
import { PgUnitOfWorkRunner } from '../../src/db/unit-of-work.js';
import type { RoleName } from '../../src/db/roles.js';
import { BASELINE_PARTITIONS } from './fixtures.js';

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

    case 'organization-only':
    // `roles`, `role_capabilities` and `entitlements`: an organization column
    // and no group column. Readable under a group-scoped context by design
    // (SPEC-06 L1 and L4.2 run during group-scoped requests and these rows have
    // no group dimension), so "wrong" means the ORGANIZATION is wrong and there
    // is no group clause to add.
    //
    // fallthrough
    case 'organization-context-only':
      // `audit_checkpoints`: the same PREDICATE — the organization must match and
      // there is no group column to compare — but for the opposite reason. It is
      // readable ONLY under an organization-scoped context, so under a group
      // context the correct result is zero visible rows and therefore zero wrong
      // ones. The probe asks "can I see a row that is not mine", and seeing
      // nothing answers it too.
      return {
        text: `select count(*) filter (where organization_id is distinct from $1::uuid)::int as wrong,
                      count(*)::int as visible
                 from ${table.name}`,
        values: [context.organizationId],
      };

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
 * The T-15 storm's ceiling (FAD-53 R-13)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * How many full 54-table probe passes the T-15 storm performs.
 *
 * 900 iterations x (one group-scoped probe pass + one organization-scoped probe
 * pass) = 1 800. The figure is a CONSTANT of the storm's design, asserted by the
 * storm's own `probePasses` counter, and it is the multiplier that turns "what
 * does one probe pass cost right now" into "what should the whole storm cost".
 */
export const STORM_PROBE_PASSES = 1_800;

/**
 * The floor the ceiling can never go below.
 *
 * This is the Vitest `testTimeout` the storm was judged against before R-13, so
 * a ceiling that never goes below it **cannot turn a previously-green run red**:
 * any run that used to pass finished inside 120 000 ms, and 120 000 ms is still
 * allowed. That is the whole no-regression argument, and it is the reason the
 * floor is written as a floor rather than as a starting point.
 */
export const STORM_CEILING_FLOOR_MS = 120_000;

/**
 * How much slower than its own measured unit cost the storm may run before the
 * ceiling binds.
 *
 * Four, following R-12's precedent (`Math.max(45_000, inherited x 150)` against
 * a measured 35.5 ms per job — a 4.2x envelope). The margin absorbs the
 * contention the calibration cannot see: the calibration passes run alone, the
 * storm's run alongside four concurrent units of work and an outside-wrapper
 * probe.
 *
 * **How much of the margin that contention actually eats, measured.** In a
 * composed run the storm's observed cost per probe pass comes in ABOVE the
 * calibrated figure, and the worst case observed so far is **30.0%** — 78.08 ms
 * observed against 60.08 ms calibrated, in R-13's review reproduction; R-13's
 * own composed run saw 10.3% (75.64 against 68.58). Four still holds with room:
 * the worst case leaves an effective margin of 3.08x rather than 4x. If a future
 * run is ever seen consuming more than about half its budget, this constant is
 * the thing to revisit — not the floor.
 */
export const STORM_CEILING_SAFETY = 4;

/**
 * The Vitest `testTimeout` for the storm's suite: the backstop for a HANG, and
 * nothing else.
 *
 * It is **not** the ceiling and it is not the largest ceiling either. A wedged
 * `await` is a different failure from a slow storm, and it must not be allowed
 * to run for hours; this is the only thing that stops it. The storm's actual
 * deadline is `stormCeilingMs`, measured and enforced at the iteration boundary,
 * and it is held `STORM_CEILING_HEADROOM_MS` below this value so that the
 * measured, named failure always fires before this generic one.
 */
export const STORM_HARD_CAP_MS = 900_000;

/**
 * The gap kept between the largest ceiling `stormCeilingMs` may return and the
 * Vitest backstop above it.
 *
 * Without a gap the two would be reachable at the same instant and which one
 * reported the failure would be a race — the generic "Test timed out" being the
 * outcome that says least. With it, the largest ceiling the model can produce is
 * `STORM_HARD_CAP_MS - STORM_CEILING_HEADROOM_MS` = 840 000 ms, and that cap
 * binds only above ~117 ms per probe pass: roughly nine times the ~13 ms measured
 * on an otherwise-idle cluster, and well beyond anything the battery's seven
 * completed composed runs imply (see `stormCeilingMs`).
 */
export const STORM_CEILING_HEADROOM_MS = 60_000;

/**
 * **The T-15 storm's deadline, measured rather than assumed (FAD-53 R-13).**
 *
 * ## Why the storm needs one at all
 *
 * The storm's workload is FIXED — 900 iterations, 3 600 units of work, 1 800
 * probe passes over all 54 tenant tables. Its wall-clock cost is not: across the
 * SEVEN completed runs of the doc 38 §7 battery's eight composed 142-file runs it
 * ran from 23.1 s to 85.6 s, and in the eighth it ran past the fixed 120 000 ms
 * `testTimeout` at file position 111 of 142 — that run is CENSORED at the
 * ceiling, not measured, so it contributes no upper figure to the range.
 * `WRONG-TENANT ROWS: 0` in every completed run. The proof held everywhere; only
 * the clock ran out.
 *
 * ## What the cost actually tracks, measured
 *
 * The storm's time is very nearly `STORM_PROBE_PASSES x (cost of one probe
 * pass)`: 54 `count(*)` round trips per pass, and the probe passes are the
 * critical path the concurrent workload hides behind. R-13 measured one pass at
 * 12.7-14.2 ms on an idle cluster, which projects 22.9-25.6 s against a measured
 * 22.8 s — and the battery's shallowest composed run (position 3) took 23.1 s.
 *
 * That per-pass cost is what varies, and R-13 measured that it is **not** a
 * function of how much inherited data is in the database: synthesizing 200 extra
 * MULTI fixtures through the production write paths took the live census from 12
 * to 2 412 partitions and the 54 tenant tables from 198 to 34 998 rows, and the
 * probe pass stayed flat at 12.7-18.6 ms across the whole sweep — with the
 * MAXIMUM of that range at the sweep's MINIMUM depth (18.6 ms at 12 partitions,
 * the first and coldest measurement), which is the opposite of what a depth
 * effect looks like. Retaining 1.5 GB of ballast in the worker moved it by 8%.
 * What the battery's transcripts DO show is run-wide: of the 141 files common to
 * all eight runs the median correlation between a file's duration and its
 * POSITION in the run is +0.95, and the files that do not correlate are
 * predominantly the ones that are not round-trip-dominated — solver and
 * subprocess work, plus a few that do touch the database but are too short for
 * the drift to register. The storm issues by far the most round trips, so it
 * feels it first.
 *
 * So the ceiling is not modelled from partition counts or row counts — R-13
 * measured both and neither predicts. It is derived from the storm's own unit
 * cost, sampled in the same process, on the same cluster, seconds before the
 * storm starts. Whatever makes a round trip cost more late in a composed run,
 * the calibration sees it.
 *
 * **One known bias, stated rather than left for a reader to find.** The
 * calibration times only the GROUP-scoped probe pass, while `STORM_PROBE_PASSES`
 * counts 900 group-scoped and 900 organization-scoped passes, and an
 * organization-scoped pass is plausibly the dearer of the two — so the calibrated
 * figure is a systematic UNDER-estimate of the storm's average pass, and part of
 * why observed/calibrated comes in above 1 in every composed run. The direction
 * is the safe one only because `STORM_CEILING_SAFETY` absorbs it; the bias is
 * real and it is not corrected here.
 *
 * ## What it still catches
 *
 * Everything the fixed deadline caught except "the machine is busier than it was
 * in 2026": a storm that costs materially more than its own measured unit cost x
 * its own fixed workload is contending, retrying, leaking or deadlocking, and
 * that is a defect. The floor keeps the pre-R-13 budget available unconditionally.
 *
 * **Every figure above is machine-specific** (4 vCPU, PostgreSQL 17.10, embedded
 * cluster on the same host). They are recorded as the measurements that chose
 * these constants, not as a contract about any other machine — which is exactly
 * why the ceiling measures instead of hard-coding.
 */
export function stormCeilingMs(probePassMs: number): number {
  if (!Number.isFinite(probePassMs) || probePassMs <= 0) return STORM_CEILING_FLOOR_MS;
  return Math.min(
    STORM_HARD_CAP_MS - STORM_CEILING_HEADROOM_MS,
    Math.max(
      STORM_CEILING_FLOOR_MS,
      Math.round(probePassMs * STORM_PROBE_PASSES * STORM_CEILING_SAFETY),
    ),
  );
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
 * The baseline's four pairs are in `BASELINE_PARTITIONS`, but tests create groups
 * of their own as write markers — and since FAD-15 every mutating file
 * provisions a whole tenant of its own — so a census that flagged those would be
 * measuring the test rather than the system. Reading the pairs from `groups`
 * keeps the census honest: the question it asks is "does any row sit in a
 * partition that does not exist", and `groups` is what defines which partitions
 * exist.
 */
export async function actualPartitions(admin: pg.Client): Promise<ReadonlySet<string>> {
  const result = await admin.query<{ id: string; organization_id: string }>(
    'select id, organization_id from groups',
  );
  const pairs = new Set(result.rows.map((row) => `${row.organization_id}|${row.id}`));
  // The BASELINE's pairs must always be among them; if a test deleted one, the
  // census would silently start passing for the wrong reason.
  for (const pair of BASELINE_PARTITIONS) {
    if (!pairs.has(pair)) throw new Error(`baseline partition ${pair} has disappeared`);
  }
  return pairs;
}

/**
 * The organizations that legitimately exist, read from ground truth.
 *
 * Before FAD-15 this was a hard-coded pair, because the suite had exactly one
 * fixture. Owned fixtures make the set open, so it is read rather than asserted
 * — the census's question is "does a row sit in an organization that does not
 * exist", and `organizations` is what defines which do.
 */
export async function actualOrganizations(admin: pg.Client): Promise<ReadonlySet<string>> {
  const result = await admin.query<{ id: string }>('select id from organizations');
  return new Set(result.rows.map((row) => row.id));
}

/** Every census row whose (organization, group) partition cannot legitimately exist. */
export function impossibleCensusRows(
  rows: readonly CensusRow[],
  partitions: ReadonlySet<string>,
  organizations: ReadonlySet<string>,
): CensusRow[] {
  return rows.filter((row) => {
    // A row's ORGANIZATION must exist. That is the tenant boundary: a row in an
    // organization with no `organizations` row is unreachable by any context.
    if (!organizations.has(row.organizationId)) return true;
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
