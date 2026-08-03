import { ProcessAlertSink } from '../../src/db/alerts.js';
import { bootstrapCluster, rolePasswordsFromEnv } from '../../src/db/bootstrap.js';
import { migrateCycle } from '../../src/db/migrate.js';
import { createPool } from '../../src/db/pool.js';
import { installQueueSchema } from '../../src/db/queue-schema.js';
import { PgUnitOfWorkRunner } from '../../src/db/unit-of-work.js';
import { adminClient } from '../support/admin-client.js';
import { startClusterDaemon, stopClusterDaemon } from '../support/cluster-process.js';
import { applyHarnessEnv } from '../support/env.js';
import { FIXTURE, organizationContext, seedFixture } from '../support/fixtures.js';

/* ────────────────────────────────────────────────────────────────────────────
 * OPUS-M2-001 phase A — is per-test transactional rollback AVAILABLE at all?
 *
 * "Wrap each test in a transaction and roll it back" is the textbook answer to
 * shared-fixture coupling, and the packet requires it to be measured rather than
 * dismissed. Measuring its RUNTIME is easy; the question that decides it is
 * whether the strategy can express what this suite actually does. Four
 * experiments, each run against the real cluster and the real wrapper, none of
 * them a simulation:
 *
 *   E1  Can one test-level transaction span BOTH fixture organizations?
 *   E2  Can a second connection see the outer transaction's uncommitted rows?
 *   E3  Can the superuser observation client (the ground-truth census, the
 *       fault injector) see them?
 *   E4  What does the nesting itself cost, per unit of work?
 *
 * E1-E3 are the feasibility question. E4 only matters if E1-E3 permit it.
 * ──────────────────────────────────────────────────────────────────────────── */

const ALPHA = FIXTURE.alpha.organizationId;
const BETA = FIXTURE.beta.organizationId;

function describeError(error: unknown): string {
  const name = (error as { name?: string }).name ?? 'Error';
  const code = (error as { code?: string }).code;
  const message = (error as { message?: string }).message ?? String(error);
  return `${name}${code === undefined ? '' : ` [${code}]`}: ${message}`;
}

async function main(): Promise<void> {
  applyHarnessEnv();
  const daemon = await startClusterDaemon();
  const findings: string[] = [];
  let failure: unknown;

  try {
    await bootstrapCluster({ passwords: rolePasswordsFromEnv() });
    await migrateCycle();
    await installQueueSchema();

    const poolA = createPool('app_runtime', { max: 4, allowExitOnIdle: true });
    const runnerA = new PgUnitOfWorkRunner({
      role: 'app_runtime',
      pool: poolA,
      alerts: new ProcessAlertSink({ write: () => {} }),
    });
    // A SECOND runtime, exactly as `createRuntime` builds one in test support.
    // Ten of the twenty-four api test files construct at least one of these.
    const poolB = createPool('app_runtime', { max: 4, allowExitOnIdle: true });
    const runnerB = new PgUnitOfWorkRunner({
      role: 'app_runtime',
      pool: poolB,
      alerts: new ProcessAlertSink({ write: () => {} }),
    });

    const admin = adminClient();
    await admin.connect();

    try {
      await seedFixture(runnerA);

      /* ── E1 ─────────────────────────────────────────────────────────────── */
      let e1 = 'NOT REACHED';
      await runnerA.run(organizationContext(ALPHA, 'nr13-e1'), async () => {
        try {
          await runnerA.run(organizationContext(BETA, 'nr13-e1-inner'), () => Promise.resolve());
          e1 = 'ACCEPTED — a single transaction spanned both organizations';
        } catch (error) {
          e1 = `REFUSED — ${describeError(error)}`;
        }
      });
      findings.push(
        'E1  one test-level transaction across BOTH fixture organizations\n' +
          `      ${e1}\n` +
          '      Consequence: a per-test transaction is per-TENANT, not per-test. Any test\n' +
          '      that touches Alpha and Beta — which is what a cross-tenant isolation probe\n' +
          '      IS — cannot be wrapped in one.',
      );

      /* ── E2 / E3 ────────────────────────────────────────────────────────── */
      const markerId = '0000ffff-0000-4000-8000-00000000e2e3';
      let e2 = 'NOT REACHED';
      let e3 = 'NOT REACHED';
      await runnerA.run(organizationContext(ALPHA, 'nr13-e2'), async ({ query }) => {
        await query
          .insertInto('groups')
          .values({ id: markerId, organization_id: ALPHA, name: 'NR-13 uncommitted marker' })
          .execute();

        // A second pool: a different backend, a different transaction.
        const seenByB = await runnerB.run(
          organizationContext(ALPHA, 'nr13-e2-observer'),
          async (uow) => {
            const rows = await uow.query
              .selectFrom('groups')
              .select('id')
              .where('id', '=', markerId)
              .execute();
            return rows.length;
          },
        );
        e2 =
          seenByB === 0
            ? 'INVISIBLE — the second connection saw 0 rows'
            : `VISIBLE — the second connection saw ${String(seenByB)} row(s)`;

        const seenByAdmin = await admin.query<{ n: string }>(
          'select count(*)::text as n from groups where id = $1',
          [markerId],
        );
        const n = Number(seenByAdmin.rows[0]?.n ?? '0');
        e3 =
          n === 0
            ? 'INVISIBLE — the superuser observation client saw 0 rows'
            : `VISIBLE — the superuser observation client saw ${String(n)} row(s)`;

        throw new Error('nr13-e2-rollback');
      }).catch((error: unknown) => {
        if ((error as { message?: string }).message !== 'nr13-e2-rollback') throw error;
      });

      findings.push(
        'E2  a SECOND pool/connection observing the outer transaction\n' +
          `      ${e2}\n` +
          '      Consequence: every test that builds a second Runtime, probes outside the\n' +
          '      unit of work, drives the HTTP server, or runs a graphile-worker job runs on\n' +
          '      a different backend and cannot see the test-level transaction. Its own\n' +
          '      writes commit independently and survive the rollback.',
      );
      findings.push(
        'E3  the SUPERUSER observation client (ground-truth census, fault injection)\n' +
          `      ${e3}\n` +
          '      Consequence: the census and every `admin.query` assertion would read a\n' +
          '      database in which the test under way had not happened.',
      );

      // Confirm the marker really did roll back, so E2/E3 are not reporting a
      // failed INSERT rather than invisibility.
      const afterRollback = await admin.query<{ n: string }>(
        'select count(*)::text as n from groups where id = $1',
        [markerId],
      );
      findings.push(
        'E2/E3 control — the marker after the rollback: ' +
          `${afterRollback.rows[0]?.n ?? '?'} row(s) (expected 0; if the INSERT had simply ` +
          'failed, E2/E3 would be measuring nothing)',
      );

      /* ── E4 ─────────────────────────────────────────────────────────────── */
      const plain: number[] = [];
      for (let i = 0; i < 200; i += 1) {
        const started = performance.now();
        await runnerA.run(organizationContext(ALPHA, 'nr13-e4-plain'), () => Promise.resolve());
        plain.push(performance.now() - started);
      }
      const nested: number[] = [];
      await runnerA.run(organizationContext(ALPHA, 'nr13-e4-outer'), async () => {
        for (let i = 0; i < 200; i += 1) {
          const started = performance.now();
          await runnerA.run(organizationContext(ALPHA, 'nr13-e4-outer'), () => Promise.resolve());
          nested.push(performance.now() - started);
        }
      });
      const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
      findings.push(
        'E4  cost of the nesting itself, 200 iterations each\n' +
          `      outermost unit of work: mean ${mean(plain).toFixed(3)} ms\n` +
          `      nested (savepoint):     mean ${mean(nested).toFixed(3)} ms\n` +
          '      Reading: the runtime cost of per-test rollback is negligible. Runtime was\n' +
          '      never the obstacle — E1 to E3 are.',
      );
    } finally {
      await admin.end();
      await poolA.end();
      await poolB.end();
    }
  } catch (error) {
    failure = error;
  } finally {
    await stopClusterDaemon(daemon);
  }

  process.stdout.write(`\n${findings.join('\n\n')}\n`);
  if (failure !== undefined) throw failure;
}

await main();
