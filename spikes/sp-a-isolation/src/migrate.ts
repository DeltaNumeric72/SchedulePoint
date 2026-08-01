import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { MIGRATIONS_DIR, connectionConfig } from './config.ts';

export type Direction = 'up' | 'down';

export interface MigrateResult {
  direction: Direction;
  applied: string[];
}

/**
 * Migrations run as `app_migrator` and only as `app_migrator` (SPEC-01 §4.4).
 * node-pg-migrate is driven through its programmatic `runner()` with a client
 * we own, so the spike never shells out and never uses a second credential.
 *
 * Migration files are PLAIN SQL (`-- Up Migration` / `-- Down Migration`), not
 * the JS DSL: SPEC-15 SP-2 is about whether the required constraint forms are
 * expressible in migrations, and hand-written SQL is the honest test of that.
 */
export async function migrate(
  direction: Direction,
  options: { count?: number; log?: (m: string) => void } = {},
): Promise<MigrateResult> {
  const { count = Infinity, log = () => {} } = options;

  const client = new pg.Client(connectionConfig('app_migrator'));
  await client.connect();
  try {
    const migrations = await runner({
      dbClient: client,
      dir: MIGRATIONS_DIR,
      direction,
      migrationsTable: 'pgmigrations',
      count,
      verbose: false,
      log,
      // One transaction for the whole batch: a partially-applied schema is a
      // worse outcome than a failed migration.
      singleTransaction: true,
    });
    return { direction, applied: migrations.map((m) => m.name) };
  } finally {
    await client.end();
  }
}

/** Verify that the schema is genuinely reversible: up -> down -> up. */
export async function migrateCycle(
  log: (m: string) => void = () => {},
): Promise<{ up1: string[]; down: string[]; up2: string[] }> {
  const up1 = await migrate('up', { log });
  const down = await migrate('down', { count: Infinity, log });
  const up2 = await migrate('up', { log });
  return { up1: up1.applied, down: down.applied, up2: up2.applied };
}
