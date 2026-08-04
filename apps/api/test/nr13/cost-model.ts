import { randomUUID } from 'node:crypto';

import { provisionAuthorization } from '../../src/authz/provisioning.js';
import { ProcessAlertSink } from '../../src/db/alerts.js';
import { bootstrapCluster, rolePasswordsFromEnv } from '../../src/db/bootstrap.js';
import { migrateCycle } from '../../src/db/migrate.js';
import { createPool } from '../../src/db/pool.js';
import { installQueueSchema } from '../../src/db/queue-schema.js';
import { PgUnitOfWorkRunner } from '../../src/db/unit-of-work.js';
import { adminClient } from '../support/admin-client.js';
import { startClusterDaemon, stopClusterDaemon } from '../support/cluster-process.js';
import { applyHarnessEnv, CLUSTER_DATABASE } from '../support/env.js';
import { organizationContext, seedAuditAndOutbox, seedFixture } from '../support/fixtures.js';

/* ────────────────────────────────────────────────────────────────────────────
 * OPUS-M2-001 phase A — the NR-13 cost model (MEASUREMENT INSTRUMENT).
 *
 * Every candidate fixture-isolation strategy reduces to a per-unit price paid
 * some number of times. This script measures those prices against the real
 * cluster, the real migrations and the real seed path — never a simulation:
 *
 *   1. the fixed cost of a run    — daemon, bootstrap, migration cycle, queue
 *                                   schema, MULTI seed, audit/outbox seed,
 *                                   each timed separately;
 *   2. per ORGANIZATION           — provisioning one more synthetic tenant
 *                                   through the production path (strategy 2's
 *                                   unit price);
 *   3. per TEMPLATE CLONE         — CREATE DATABASE ... TEMPLATE and DROP
 *                                   DATABASE (a per-file database reset);
 *   4. per UNIT OF WORK           — an empty BEGIN/set_config×4/read-back/COMMIT
 *                                   (strategy 1's floor: what a per-test
 *                                   transaction costs before it does anything);
 *   5. TRUNCATE feasibility       — whether a per-file "wipe and reseed" is even
 *                                   available on this schema.
 *
 * Run with `SP_TEST_PG_PORT` set to something other than this worktree's derived
 * port so it cannot collide with a test run. Since OPUS-M2-004 the default is
 * derived per worktree (`scripts/sbx/test-port.mjs`), not the old fixed 55433;
 * `docs/dev-setup.md` §Ports, per worktree gives the one-liner that prints it.
 * This script owns its cluster and destroys it at the end.
 * ──────────────────────────────────────────────────────────────────────────── */

const REPETITIONS = Number.parseInt(process.env['SP_NR13_REPS'] ?? '10', 10);

interface Sample {
  readonly label: string;
  readonly ms: readonly number[];
}

const samples: Sample[] = [];

async function timeOnce(label: string, fn: () => Promise<void>): Promise<number> {
  const started = performance.now();
  await fn();
  const elapsed = performance.now() - started;
  samples.push({ label, ms: [elapsed] });
  return elapsed;
}

async function timeMany(label: string, n: number, fn: (i: number) => Promise<void>): Promise<void> {
  const ms: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const started = performance.now();
    await fn(i);
    ms.push(performance.now() - started);
  }
  samples.push({ label, ms });
}

function report(): string {
  const rows = samples.map((sample) => {
    const sorted = [...sample.ms].sort((a, b) => a - b);
    const n = sorted.length;
    const total = sorted.reduce((sum, value) => sum + value, 0);
    const median = n % 2 === 1 ? sorted[(n - 1) / 2] : ((sorted[n / 2 - 1] ?? 0) + (sorted[n / 2] ?? 0)) / 2;
    return [
      sample.label,
      String(n),
      (sorted[0] ?? 0).toFixed(1),
      (median ?? 0).toFixed(1),
      (sorted[n - 1] ?? 0).toFixed(1),
      total.toFixed(1),
    ];
  });
  const header = ['MEASUREMENT', 'n', 'min ms', 'median ms', 'max ms', 'total ms'];
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => (row[index] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ').trimEnd();
  return [line(header), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)].join('\n');
}

/**
 * One more synthetic organization, created the way production creates one:
 * the bootstrap door (an organization with no memberships at all), then
 * `provisionAuthorization`, then the first organization membership last inside
 * the same transaction — the shape `seedOrganization` uses in `fixtures.ts`.
 *
 * Deliberately NOT imported from `fixtures.ts`: phase A measures, it does not
 * modify the shared fixture. Every identifier here is a fresh UUID and every
 * address is at the RFC 2606 reserved TLD `example.invalid`.
 */
async function provisionOneOrganization(runner: PgUnitOfWorkRunner, index: number): Promise<void> {
  const organizationId = randomUUID();
  const groupIds = [randomUUID(), randomUUID()];
  const userId = randomUUID();
  const membershipId = randomUUID();

  await runner.run(organizationContext(organizationId, `nr13-cost-${String(index)}`), async ({ query }) => {
    await query
      .insertInto('organizations')
      .values({ id: organizationId, name: `Cost Model Organization ${String(index)} (synthetic)` })
      .execute();
    await query
      .insertInto('groups')
      .values(
        groupIds.map((id, position) => ({
          id,
          organization_id: organizationId,
          name: `Cost Model Group ${String(position)} (synthetic)`,
        })),
      )
      .execute();
    await query
      .insertInto('users')
      .values({
        id: userId,
        login_email: `cost-model-${String(index)}@example.invalid`,
        display_name: `Cost Model Administrator ${String(index)} (synthetic)`,
      })
      .execute();
    await provisionAuthorization(query, { organizationId, groupIds });
    await query
      .insertInto('memberships')
      .values({
        id: membershipId,
        organization_id: organizationId,
        group_id: null,
        user_id: userId,
        kind: 'organization' as const,
        organization_role: 'org_admin',
        group_role: null,
      })
      .execute();
  });
}

async function main(): Promise<void> {
  applyHarnessEnv();

  const daemonStarted = performance.now();
  const daemon = await startClusterDaemon();
  samples.push({
    label: 'fixed: startClusterDaemon (initdb + start, fresh data directory)',
    ms: [performance.now() - daemonStarted],
  });
  let failure: unknown;
  try {
    await timeOnce('fixed: bootstrapCluster (5 roles + database)', async () => {
      await bootstrapCluster({ passwords: rolePasswordsFromEnv() });
    });
    await timeOnce('fixed: migrateCycle up -> down -> up', async () => {
      await migrateCycle();
    });
    await timeOnce('fixed: installQueueSchema (graphile-worker)', async () => {
      await installQueueSchema();
    });

    const pool = createPool('app_runtime', { max: 4, allowExitOnIdle: true });
    const runner = new PgUnitOfWorkRunner({
      role: 'app_runtime',
      pool,
      alerts: new ProcessAlertSink({ write: () => {} }),
    });
    const workerPool = createPool('app_worker', { max: 2, allowExitOnIdle: true });
    const workerRunner = new PgUnitOfWorkRunner({
      role: 'app_worker',
      pool: workerPool,
      alerts: new ProcessAlertSink({ write: () => {} }),
    });

    try {
      await timeOnce('fixed: seedFixture (MULTI: 2 organizations)', async () => {
        await seedFixture(runner);
      });
      await timeOnce('fixed: seedAuditAndOutbox (4 groups + 2 checkpoints)', async () => {
        await seedAuditAndOutbox(runner, workerRunner);
      });

      await timeMany('unit: provision ONE more organization (2 groups, 1 admin)', REPETITIONS, (i) =>
        provisionOneOrganization(runner, i),
      );

      await timeMany('unit: empty unit of work (BEGIN + 4 set_config + readback + COMMIT)', 200, () =>
        runner.run(organizationContext('11111111-1111-4111-8111-111111111111', 'nr13-empty'), () =>
          Promise.resolve(),
        ),
      );
    } finally {
      await pool.end();
      await workerPool.end();
    }

    /* ── template clone / drop, and the TRUNCATE question ───────────────── */
    const admin = adminClient('postgres');
    await admin.connect();
    try {
      await timeMany('unit: CREATE DATABASE ... TEMPLATE (per-file database clone)', 5, async (i) => {
        await admin.query(`create database "nr13_clone_${String(i)}" template "${CLUSTER_DATABASE}"`);
      });
      await timeMany('unit: DROP DATABASE (the clone\'s other half)', 5, async (i) => {
        await admin.query(`drop database "nr13_clone_${String(i)}"`);
      });
    } finally {
      await admin.end();
    }

    const inDatabase = adminClient();
    await inDatabase.connect();
    const truncateFindings: string[] = [];
    try {
      for (const table of ['memberships', 'audit_events', 'audit_checkpoints', 'outbox_events']) {
        try {
          await inDatabase.query('begin');
          await inDatabase.query(`truncate table ${table} cascade`);
          await inDatabase.query('rollback');
          truncateFindings.push(`  ${table}: TRUNCATE accepted (as superuser, rolled back)`);
        } catch (error) {
          await inDatabase.query('rollback');
          const code = (error as { code?: string }).code ?? '?';
          const message = (error as { message?: string }).message ?? String(error);
          truncateFindings.push(`  ${table}: TRUNCATE REFUSED — SQLSTATE ${code}: ${message}`);
        }
      }
    } finally {
      await inDatabase.end();
    }

    process.stdout.write(`\n${report()}\n`);
    process.stdout.write(
      '\nTRUNCATE feasibility (superuser, inside a transaction that is then rolled back):\n' +
        `${truncateFindings.join('\n')}\n`,
    );
  } catch (error) {
    failure = error;
  } finally {
    await stopClusterDaemon(daemon);
  }
  if (failure !== undefined) throw failure;
}

await main();
