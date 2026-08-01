/**
 * Standalone migration CLI.
 *
 *   npm run migrate:up      -- apply every pending migration
 *   npm run migrate:down    -- revert every applied migration
 *   npm run migrate:cycle   -- up -> down -> up, proving reversibility
 *
 * Each invocation starts a throwaway cluster, bootstraps roles, runs the
 * requested direction and stops. This is the SP-2 "migrates up and down"
 * evidence in a form that can be run on its own, independent of the harness.
 */
import { SpikeCluster } from './cluster.ts';
import { migrate, migrateCycle } from './migrate.ts';

const mode = process.argv[2] ?? 'up';

const cluster = new SpikeCluster();
const log = (m: string) => console.log(`  ${m}`);

console.log(`[migrate] starting embedded PostgreSQL (FAD-7 substitution for docker compose)`);
await cluster.start({ fresh: true });
await cluster.bootstrapRolesAndDatabase();
console.log('[migrate] roles + database bootstrapped as superuser');

try {
  if (mode === 'cycle') {
    console.log('[migrate] --- UP ---');
    const r = await migrateCycle(log);
    console.log(`[migrate] up#1   applied: ${JSON.stringify(r.up1)}`);
    console.log(`[migrate] down   reverted: ${JSON.stringify(r.down)}`);
    console.log(`[migrate] up#2   applied: ${JSON.stringify(r.up2)}`);
    if (r.up1.length === 0 || r.up1.length !== r.down.length || r.up1.length !== r.up2.length) {
      throw new Error('migration cycle is not symmetric');
    }
    console.log(`[migrate] OK — ${r.up1.length} migrations are reversible`);
  } else if (mode === 'up' || mode === 'down') {
    const r = await migrate(mode, { log });
    console.log(`[migrate] ${mode}: ${JSON.stringify(r.applied)}`);
  } else {
    throw new Error(`unknown mode "${mode}" (expected up | down | cycle)`);
  }
} finally {
  await cluster.stop();
  console.log('[migrate] cluster stopped');
}
