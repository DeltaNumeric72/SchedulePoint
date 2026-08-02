import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The harness environment, in one place.
 *
 * `globalSetup` runs in Vitest's main process and the tests run in a worker, so
 * environment variables set in one are not visible in the other. Both import
 * this module and call `applyHarnessEnv()`, which makes the configuration
 * identical by construction rather than by two lists staying in sync.
 *
 * ## About the credentials below
 *
 * They are **synthetic, local-only, throwaway** strings for a PostgreSQL cluster
 * that listens on `127.0.0.1`, is created from an empty data directory at the
 * start of every run, and is destroyed at the end of it. They are not secrets,
 * they are not reused anywhere, and they must never be copied into non-test
 * code. Every one of them starts with `fixture-local-` so that a reader — and
 * the secret-scan gate — can tell at a glance that it is not a credential.
 *
 * The production code reads exactly the same variable names and has **no
 * default** for any of them: a missing password throws rather than falling back.
 * That is why the fixture has to set them explicitly here.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** `apps/api` */
export const API_ROOT = resolve(HERE, '../..');

/**
 * A port distinct from the SP-A spike's 55432, so a spike run and a harness run
 * on the same machine cannot collide — and so two worktrees can each override it
 * (execution standards §E: concurrent agents never share a database instance).
 */
export const CLUSTER_PORT = Number.parseInt(process.env['SP_TEST_PG_PORT'] ?? '55433', 10);

/**
 * Throwaway cluster data directory. Destroyed and recreated on every run.
 *
 * **The port is part of the path, and that is load-bearing.** A fixed path made
 * `SP_TEST_PG_PORT` a half-measure: a second harness on a different port still
 * `rm -rf`'d the first one's data directory on startup, and the first cluster
 * died mid-query with `could not open file "global/pg_filenode.map"`. The
 * exit-code red case spawns exactly that second harness, so the collision was
 * real rather than hypothetical — it is what `pnpm check` caught. Deriving the
 * directory from the port makes "a distinct port" mean a genuinely distinct
 * instance, which is what execution standards §E asks for.
 */
export const CLUSTER_DATA_DIR = resolve(API_ROOT, `.pgdata-test-${String(CLUSTER_PORT)}`);

export const CLUSTER_DATABASE = 'schedulepoint_test';

export const HARNESS_ENV: Readonly<Record<string, string>> = {
  SP_PG_HOST: '127.0.0.1',
  SP_PG_PORT: String(CLUSTER_PORT),
  SP_PG_DATABASE: CLUSTER_DATABASE,
  SP_PG_SUPERUSER: 'postgres',
  SP_PG_SUPERUSER_PASSWORD: 'fixture-local-superuser',
  SP_PG_PASSWORD_APP_MIGRATOR: 'fixture-local-migrator',
  SP_PG_PASSWORD_APP_RUNTIME: 'fixture-local-runtime',
  SP_PG_PASSWORD_APP_WORKER: 'fixture-local-worker',
  SP_PG_PASSWORD_APP_READONLY_SUPPORT: 'fixture-local-support',
  SP_PG_PASSWORD_APP_BREAKGLASS: 'fixture-local-breakglass',
};

export function applyHarnessEnv(): void {
  for (const [key, value] of Object.entries(HARNESS_ENV)) {
    process.env[key] = value;
  }
}
