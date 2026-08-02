import { bootstrapCluster, rolePasswordsFromEnv } from '../../src/db/bootstrap.js';
import { migrate, migrateCycle } from '../../src/db/migrate.js';
import { startClusterDaemon, stopClusterDaemon } from './cluster-process.js';
import { applyHarnessEnv } from './env.js';

/**
 * `pnpm --filter @schedulepoint/api migrate:cycle:embedded`
 *
 * The migration cycle, end to end, against a throwaway embedded cluster — a
 * command a reviewer can run and capture without a database of their own.
 *
 * The cycle is `up → down → up` on a data directory that is destroyed first, so
 * it proves three things at once: the up migration applies to an empty database,
 * the down migration is genuinely executable, and the up migration applies again
 * to the schema the down migration left behind. Execution standards §E requires
 * a stated rollback path before merge; a down migration that has never been run
 * is a comment, not a rollback path.
 *
 * `globalSetup` runs the same cycle before every test run, so the schema every
 * test sees is one whose reversibility was just demonstrated.
 */

applyHarnessEnv();

const started = Date.now();
const daemon = await startClusterDaemon();

try {
  process.stdout.write('cluster: started (embedded PostgreSQL, FAD-7 substitution)\n');

  await bootstrapCluster({
    passwords: rolePasswordsFromEnv(),
    log: (message) => process.stdout.write(`bootstrap: ${message}\n`),
  });

  const log = (message: string): void => {
    process.stdout.write(`  ${message}\n`);
  };

  process.stdout.write('\n--- up -> down -> up -------------------------------------------\n');
  const cycle = await migrateCycle(log);
  process.stdout.write(`\nup   : ${cycle.up1.join(', ')}\n`);
  process.stdout.write(`down : ${cycle.down.join(', ')}\n`);
  process.stdout.write(`up   : ${cycle.up2.join(', ')}\n`);

  if (cycle.up1.length === 0 || cycle.down.length === 0 || cycle.up2.length === 0) {
    throw new Error('the cycle applied nothing in at least one direction');
  }
  if (cycle.up1.join(',') !== cycle.up2.join(',')) {
    throw new Error('the second `up` applied a different set of migrations than the first');
  }

  // A fourth leg, so the report can state that the schema is genuinely empty
  // after `down` rather than merely that `down` did not error.
  process.stdout.write('\n--- down again, then verify the schema is empty ----------------\n');
  await migrate('down', { count: Infinity, log });

  const { default: pg } = await import('pg');
  const { superuserConfig } = await import('../../src/db/config.js');
  const client = new pg.Client(superuserConfig());
  await client.connect();
  try {
    const tables = await client.query<{ tablename: string }>(
      `select tablename from pg_tables
        where schemaname = 'public' and tablename <> 'pgmigrations'
        order by tablename`,
    );
    const policies = await client.query<{ n: number }>(
      `select count(*)::int as n from pg_policies where schemaname = 'public'`,
    );
    process.stdout.write(
      `tables remaining after down: ${tables.rows.length === 0 ? '(none)' : tables.rows.map((r) => r.tablename).join(', ')}\n`,
    );
    process.stdout.write(`policies remaining after down: ${String(policies.rows[0]?.n ?? -1)}\n`);
    if (tables.rows.length > 0 || (policies.rows[0]?.n ?? -1) !== 0) {
      throw new Error('the down migration left objects behind');
    }
  } finally {
    await client.end();
  }

  process.stdout.write('\n--- up, to leave a usable schema ------------------------------\n');
  const final = await migrate('up', { log });
  process.stdout.write(`up   : ${final.applied.join(', ')}\n`);

  process.stdout.write(
    `\nMIGRATION CYCLE CLEAN — up -> down -> up -> down -> up, ${String(Date.now() - started)}ms\n`,
  );
} finally {
  await stopClusterDaemon(daemon);
  process.stdout.write('cluster: stopped\n');
}
