import type { ChildProcess } from 'node:child_process';

import { ProcessAlertSink } from '../../src/db/alerts.js';
import { bootstrapCluster, rolePasswordsFromEnv } from '../../src/db/bootstrap.js';
import { migrateCycle } from '../../src/db/migrate.js';
import { createPool } from '../../src/db/pool.js';
import { PgUnitOfWorkRunner } from '../../src/db/unit-of-work.js';
import { installQueueSchema } from '../../src/db/queue-schema.js';
import { adminClient } from './admin-client.js';
import { captureBaselineDigest } from './baseline-guard.js';
import {
  startClusterDaemon,
  stopClusterDaemon,
  withClusterDiagnostic,
} from './cluster-process.js';
import { drainQueue } from './queue.js';
import { applyHarnessEnv } from './env.js';
import { LocalCheckpointSigner } from '../../src/audit/checkpoint-signer.js';
import { writeCheckpoint } from '../../src/audit/checkpoints.js';
import { FIXTURE, seedAuditAndOutbox, seedFixture } from './fixtures.js';

/**
 * One cluster for the whole `api` test project.
 *
 * Vitest runs this in its main process, before any worker starts, and runs the
 * teardown after the last one finishes. The tests reach the cluster over TCP, so
 * nothing has to cross the process boundary except the port — which every side
 * reads from `./env.ts`.
 *
 * ## The cluster runs in a CHILD process, deliberately
 *
 * `embedded-postgres` installs a `beforeExit` hook that calls `process.exit(0)`
 * and discards `process.exitCode`. Imported here, it made `vitest run` report
 * `1 failed | 232 passed` and **exit 0** — a unit gate that cannot fail. The
 * cluster therefore lives in `cluster-daemon.ts`, spawned below, and this
 * process imports only `pg` and `node-pg-migrate`. See `cluster.ts` for the
 * measurement.
 *
 * ## What the setup does, and why it does the slow version
 *
 *  1. spawn the daemon, which destroys and re-initialises the data directory —
 *     no run inherits state from the last one;
 *  2. bootstrap the five roles and the database as superuser;
 *  3. run the migration cycle **up → down → up**, so every test runs against a
 *     schema whose down migration has just been proven executable. A down
 *     migration that has never been run is a comment (execution standards §E);
 *  4. seed the MULTI fixture **through the unit of work**, under `app_runtime`.
 */

let daemon: ChildProcess | undefined;

export async function setup(): Promise<void> {
  applyHarnessEnv();

  daemon = await startClusterDaemon();
  // The FIRST thing that connects. A stale postmaster surfaces here, so this is
  // where the diagnostic has to be (D-06).
  await withClusterDiagnostic('bootstrapCluster', () =>
    bootstrapCluster({ passwords: rolePasswordsFromEnv() }),
  );

  const cycle = await migrateCycle();
  if (cycle.up1.length === 0 || cycle.down.length === 0 || cycle.up2.length === 0) {
    throw new Error(
      `migration cycle did not apply anything: up=${String(cycle.up1.length)} down=${String(cycle.down.length)} up=${String(cycle.up2.length)}`,
    );
  }

  // OPUS-M1-003: graphile-worker owns its own schema and its own migration
  // history, so it cannot live in `apps/api/migrations`. This is the same kind
  // of step as `bootstrapCluster` — infrastructure the domain schema sits on —
  // and it also applies SP-D condition C-1, without which `app_worker` reads
  // zero rows from the queue and processes nothing, silently (SP-D E-0.2).
  await installQueueSchema();

  const pool = createPool('app_runtime', { max: 4, allowExitOnIdle: true });
  const runner = new PgUnitOfWorkRunner({
    role: 'app_runtime',
    pool,
    alerts: new ProcessAlertSink({ write: () => {} }),
  });
  // OPUS-M1-004: `outbox_effects` and `audit_checkpoints` are app_worker's
  // alone (0003's grants, SPEC-11 §2), so seeding them needs the worker's own
  // credential. Using app_runtime raises 42501 rather than quietly succeeding,
  // which is the grant matrix doing its job.
  const workerPool = createPool('app_worker', { max: 2, allowExitOnIdle: true });
  const workerRunner = new PgUnitOfWorkRunner({
    role: 'app_worker',
    pool: workerPool,
    alerts: new ProcessAlertSink({ write: () => {} }),
  });
  try {
    await seedFixture(runner);
    // Migration 0003's four tenant tables are in `TENANT_TABLES` since
    // OPUS-M1-004, and a probe over an empty table is a vacuous probe.
    await seedAuditAndOutbox(runner, workerRunner);
  } finally {
    await pool.end();
    await workerPool.end();
  }

  // FAD-15 Layer 3: the queue is NOT a tenant table. The baseline's seeded
  // outbox events enqueue jobs, and any worker any later file starts takes
  // whatever job is next — which would dispatch the baseline's rows and change
  // the very state Layer 1 protects. Draining here, through the real dispatcher,
  // leaves the baseline in the state production would leave it in and leaves the
  // queue empty, so no file inherits a backlog it did not create. That is the
  // C-2 lesson (EV-M1-INTEGRATION §3.5) applied at the source instead of once
  // per test that tripped over it.
  const drainPool = createPool('app_worker', { max: 2, allowExitOnIdle: true });
  const drainRunner = new PgUnitOfWorkRunner({
    role: 'app_worker',
    pool: drainPool,
    alerts: new ProcessAlertSink({ write: () => {} }),
  });
  const admin = adminClient();
  await admin.connect();
  try {
    await drainQueue({ worker: drainRunner, admin, label: 'global-setup-drain' });

    // Dispatching appended `outbox.dispatched` rows, so each baseline chain head
    // is now AHEAD of the checkpoint the seed signed. The periodic checkpoint
    // sweep is a maintenance-plane operation over EVERY organization — tenancy
    // does not scope it — so it would legitimately checkpoint the baseline and
    // trip Layer 1. Checkpointing the settled head here leaves nothing due, so
    // the sweep is a no-op for the baseline and the file running it only affects
    // its own tenant. Layer 3 again: the fix belongs at the shared resource, not
    // in every test that meets it.
    const signer = new LocalCheckpointSigner({ keyId: 'baseline-settled-key' });
    for (const organizationId of FIXTURE.organizationIds) {
      await drainRunner.run(
        {
          organizationId,
          groupId: null,
          membershipId: null,
          correlationId: 'global-setup-settle',
        },
        (uow) => writeCheckpoint(uow, signer),
      );
    }
  } finally {
    await admin.end();
    await drainPool.end();
  }

  // FAD-15 Layer 1: the reference digest of the read-only baseline. Every test
  // file re-digests it afterwards (`setup-env.ts`) and the run fails naming any
  // file that changed a row. Taken LAST, so it covers the audit, outbox and
  // dispatch rows above as well as the tenants.
  await captureBaselineDigest();
}

export async function teardown(): Promise<void> {
  await stopClusterDaemon(daemon);
}
