import type { ChildProcess } from 'node:child_process';

import { ProcessAlertSink } from '../../src/db/alerts.js';
import { bootstrapCluster, rolePasswordsFromEnv } from '../../src/db/bootstrap.js';
import { migrateCycle } from '../../src/db/migrate.js';
import { createPool } from '../../src/db/pool.js';
import { PgUnitOfWorkRunner } from '../../src/db/unit-of-work.js';
import { installQueueSchema } from '../../src/db/queue-schema.js';
import { startClusterDaemon, stopClusterDaemon } from './cluster-process.js';
import { applyHarnessEnv } from './env.js';
import { seedFixture } from './fixtures.js';

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
  await bootstrapCluster({ passwords: rolePasswordsFromEnv() });

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
  try {
    await seedFixture(runner);
  } finally {
    await pool.end();
  }
}

export async function teardown(): Promise<void> {
  await stopClusterDaemon(daemon);
}
