import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import pg from 'pg';

import { recordAuditEvent } from '../../src/audit/recorder.js';
import { ProcessAlertSink } from '../../src/db/alerts.js';
import { bootstrapCluster, rolePasswordsFromEnv } from '../../src/db/bootstrap.js';
import { superuserConfig } from '../../src/db/config.js';
import { migrate } from '../../src/db/migrate.js';
import { createPool } from '../../src/db/pool.js';
import { installQueueSchema } from '../../src/db/queue-schema.js';
import { PgUnitOfWorkRunner } from '../../src/db/unit-of-work.js';
import { startClusterDaemon, stopClusterDaemon } from './cluster-process.js';
import { API_ROOT, applyHarnessEnv } from './env.js';
import { FIXTURE, groupContext, seedFixture } from './fixtures.js';

/**
 * `tsx test/support/audit-verify-demo.ts`
 *
 * A capture harness for the **chain-verification command**, end to end on a
 * throwaway cluster, so a reviewer can run one thing and read the output.
 *
 * It runs the CLI three times against the same organization:
 *
 *  1. **on an intact chain** — expect exit `0`;
 *  2. **after a privileged actor edits a row** (triggers disabled, exactly the
 *     SPEC-11 §3 threat) — expect exit `1` and a named problem;
 *  3. **after the edit is reverted** — expect exit `0` again, which is what makes
 *     (2) a detection rather than a one-way alarm.
 *
 * The exit codes are the point. A verification tool whose exit code does not
 * change is a verification tool nobody can automate.
 */

applyHarnessEnv();

const CLI = resolve(API_ROOT, 'src/audit/verify-cli.ts');
const ALPHA = FIXTURE.alpha;

function runCli(label: string): number {
  process.stdout.write(`\n--- ${label} -----------------------------------------\n`);
  process.stdout.write(`$ tsx src/audit/verify-cli.ts ${ALPHA.organizationId}\n`);
  const result = spawnSync(process.execPath, ['--import', 'tsx', CLI, ALPHA.organizationId], {
    cwd: API_ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  process.stdout.write(result.stdout);
  if (result.stderr !== '') process.stdout.write(`[stderr] ${result.stderr}`);
  process.stdout.write(`exit code: ${String(result.status)}\n`);
  return result.status ?? -1;
}

const daemon = await startClusterDaemon();
try {
  process.stdout.write('cluster: started (embedded PostgreSQL, FAD-7 substitution)\n');
  await bootstrapCluster({ passwords: rolePasswordsFromEnv() });
  await migrate('up');
  await installQueueSchema((m) => process.stdout.write(`${m}\n`));

  const pool = createPool('app_runtime', { max: 2, allowExitOnIdle: true });
  const runner = new PgUnitOfWorkRunner({
    role: 'app_runtime',
    pool,
    alerts: new ProcessAlertSink({ write: () => {} }),
  });
  try {
    await seedFixture(runner);
    const context = groupContext(
      ALPHA.organizationId,
      ALPHA.groupOne.id,
      ALPHA.users.scheduler.membershipId,
      'verify-demo',
    );
    for (let i = 0; i < 5; i += 1) {
      await runner.run(context, (uow) =>
        recordAuditEvent(uow, {
          eventName: 'membership.activity_touched',
          subjectType: 'membership',
          subjectId: ALPHA.users.scheduler.membershipId,
          payload: { index: i },
        }),
      );
    }
    process.stdout.write('seeded: 5 audit events for Organization Alpha (synthetic)\n');
  } finally {
    await pool.end();
  }

  const intact = runCli('1. intact chain');

  /* ── the SPEC-11 §3 threat, performed ─────────────────────────────────── */
  const admin = new pg.Client(superuserConfig());
  await admin.connect();
  try {
    process.stdout.write(
      '\n[fault injection] a privileged actor disables the refusal trigger and edits ' +
        'sequence 3\n',
    );
    await admin.query('alter table audit_events disable trigger audit_events_refuse_update');
    await admin.query(
      `update audit_events set payload = payload || '{"tampered": true}'::jsonb
        where organization_id = $1::uuid and sequence = 3`,
      [ALPHA.organizationId],
    );
    await admin.query('alter table audit_events enable always trigger audit_events_refuse_update');

    const broken = runCli('2. after a privileged edit');

    process.stdout.write('\n[fault injection] the edit is reverted\n');
    await admin.query('alter table audit_events disable trigger audit_events_refuse_update');
    await admin.query(
      `update audit_events set payload = payload - 'tampered'
        where organization_id = $1::uuid and sequence = 3`,
      [ALPHA.organizationId],
    );
    await admin.query('alter table audit_events enable always trigger audit_events_refuse_update');

    const recovered = runCli('3. after the edit is reverted');

    process.stdout.write('\n=== SUMMARY =====================================\n');
    process.stdout.write(`intact chain          -> exit ${String(intact)}   (expected 0)\n`);
    process.stdout.write(`after a privileged edit -> exit ${String(broken)}   (expected 1)\n`);
    process.stdout.write(`after the revert      -> exit ${String(recovered)}   (expected 0)\n`);

    if (intact !== 0 || broken !== 1 || recovered !== 0) {
      throw new Error('the verification command did not distinguish the three states');
    }
    process.stdout.write('\nCHAIN VERIFICATION COMMAND BEHAVED AS SPECIFIED\n');
  } finally {
    await admin.end();
  }
} finally {
  await stopClusterDaemon(daemon);
  process.stdout.write('cluster: stopped\n');
}
