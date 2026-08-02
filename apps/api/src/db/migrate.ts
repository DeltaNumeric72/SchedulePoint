import { runner } from 'node-pg-migrate';
import pg from 'pg';

import { MIGRATIONS_DIR, connectionConfig } from './config.js';

/**
 * Migrations run as `app_migrator` and **only** as `app_migrator` (SPEC-01
 * §4.4). The runner is driven programmatically with a client this module owns,
 * so nothing shells out and no second credential is in play.
 *
 * Migration bodies are **hand-written plain SQL** (`-- Up Migration` /
 * `-- Down Migration`), not the JS DSL. The forms the schema depends on —
 * conjunctive RLS predicates, composite foreign keys over tenant columns,
 * partial unique indexes, `FORCE ROW LEVEL SECURITY` — are all expressible, and
 * hand-written SQL is what the migration+RLS gate reads. A DSL that generated
 * the DDL would put a translation layer between the reviewed text and the
 * applied schema, at precisely the place where a translation error is a
 * cross-tenant leak.
 *
 * `singleTransaction` is on: a partially-applied schema is a worse outcome than
 * a failed migration, and a table that exists without its RLS policy is the
 * exact window the same-file gate rule exists to close.
 */

export type MigrationDirection = 'up' | 'down';

export interface MigrationResult {
  readonly direction: MigrationDirection;
  readonly applied: readonly string[];
}

export async function migrate(
  direction: MigrationDirection,
  options: { count?: number; log?: (message: string) => void } = {},
): Promise<MigrationResult> {
  const { count = Infinity, log = (): void => {} } = options;

  const client = new pg.Client(connectionConfig('app_migrator'));
  await client.connect();
  try {
    const applied = await runner({
      dbClient: client,
      dir: MIGRATIONS_DIR,
      direction,
      migrationsTable: 'pgmigrations',
      // Only `.sql` files are migrations. Without this, node-pg-migrate tries to
      // `import()` the directory's README as a migration module and fails with
      // ERR_UNKNOWN_FILE_EXTENSION — a confusing error a long way from its cause.
      ignorePattern: String.raw`(\..*|.*\.md)`,
      count,
      verbose: false,
      log,
      singleTransaction: true,
    });
    return { direction, applied: applied.map((m) => m.name) };
  } finally {
    await client.end();
  }
}

/**
 * up → down → up.
 *
 * Execution standards §E requires a stated, *executable* down migration before
 * merge, so that a `git revert` of a schema change is always runnable in
 * development. Running the cycle is the only way to know the down migration
 * works: a down migration that has never been executed is a comment.
 */
export async function migrateCycle(
  log: (message: string) => void = (): void => {},
): Promise<{ up1: readonly string[]; down: readonly string[]; up2: readonly string[] }> {
  const up1 = await migrate('up', { log });
  const down = await migrate('down', { count: Infinity, log });
  const up2 = await migrate('up', { log });
  return { up1: up1.applied, down: down.applied, up2: up2.applied };
}
