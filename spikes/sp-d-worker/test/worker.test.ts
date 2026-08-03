import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { makeWorkerUtils, runMigrations } from 'graphile-worker';
import pg from 'pg';

import { WorkerChild, sleep, stayFalse, waitFor } from '../src/child-handle.ts';
import { SpikeCluster } from '../src/cluster.ts';
import { WORKER_SCHEMA, connectionConfig, connectionString } from '../src/config.ts';
import {
  createDomainSchema,
  grantWorkerSchema,
  remediateWorkerSchema,
  rlsEnabledWorkerTables,
  truncateObservations,
} from '../src/domain.ts';
import { Observer } from '../src/observe.ts';

/* ────────────────────────────────────────────────────────────────────────────
 * SP-D — TDG-04 confirmation micro-spike (OPUS-M1-003 step 0)
 *
 * Three questions, and nothing else:
 *
 *   E-1  Does the enqueue participate in the CALLER's transaction? A rolled-back
 *        domain transaction must enqueue nothing. This is the whole outbox
 *        property; without it the audit/outbox design has no atomicity.
 *   E-2  Is the lease durable? A job locked by a worker that then dies must be
 *        re-executed once the lease expires. MEASURE the recovery.
 *   E-3  Does a SIGKILL mid-job leave recoverable state? The job must re-run and
 *        complete, with no orphaned lock and no duplicated effect.
 *
 * E-0 comes first because it had to: the first run of this harness failed with
 * `42501 new row violates row-level security policy for table "_private_tasks"`,
 * which is not a thing the TDG-04 row anticipated. E-0 is that discovery,
 * written down as an experiment instead of quietly patched around.
 *
 * E-4 is the I-11 contrast, cheap to add once the rest exists.
 *
 * THE DESCRIBE BLOCKS ARE ORDER-DEPENDENT. E-0 applies the remediation
 * everything after it needs, and E-2.2/E-2.3 and E-3.2 deliberately continue
 * from the state their predecessor left. `--test-concurrency=1` is required and
 * is set in package.json.
 *
 * Everything printed by `record()` ends up in evidence/harness-output.txt and is
 * the only source for numbers quoted in SPIKE-REPORT.md.
 * ──────────────────────────────────────────────────────────────────────────── */

const cluster = new SpikeCluster();
const observer = new Observer();
const children: WorkerChild[] = [];

const MEASUREMENTS: string[] = [];
function record(id: string, text: string): void {
  const line = `[MEASURED] ${id}  ${text}`;
  MEASUREMENTS.push(line);
  console.log(line);
}

function child(options: ConstructorParameters<typeof WorkerChild>[0]): WorkerChild {
  const c = new WorkerChild(options);
  children.push(c);
  return c;
}

async function clientAs(role: 'app_runtime' | 'app_worker' | 'app_migrator'): Promise<pg.Client> {
  const client = new pg.Client({ ...connectionConfig(role) });
  await client.connect();
  return client;
}

/** The production-shaped enqueue: a SECURITY DEFINER wrapper, called by app_runtime. */
async function enqueue(
  client: pg.Client,
  identifier: string,
  payload: Record<string, unknown>,
  maxAttempts?: number,
): Promise<string> {
  const { rows } =
    maxAttempts === undefined
      ? await client.query<{ id: string }>('SELECT spike_enqueue($1, $2::json)::text AS id', [
          identifier,
          JSON.stringify(payload),
        ])
      : await client.query<{ id: string }>(
          'SELECT spike_enqueue_capped($1, $2::json, $3)::text AS id',
          [identifier, JSON.stringify(payload), maxAttempts],
        );
  const id = rows[0]?.id;
  assert.ok(id, 'the enqueue wrapper must return the new job id');
  return id;
}

before(async () => {
  const t0 = Date.now();
  await cluster.start();
  await cluster.bootstrapRolesAndDatabase();
  await createDomainSchema();
  await runMigrations({ connectionString: connectionString('app_migrator') });
  await grantWorkerSchema();
  await observer.connect();

  const [version] = await observer.query<{ version: string }>('SELECT version() AS version');
  const [gw] = await observer.query<{ n: string }>(
    `SELECT max(id)::text AS n FROM ${WORKER_SCHEMA}.migrations`,
  );
  record('ENV', `PostgreSQL: ${version?.version ?? 'unknown'}`);
  record('ENV', `graphile-worker: 0.17.3, schema migrations applied through ${gw?.n ?? '?'}`);
  record('ENV', `cluster + schema bootstrap: ${String(Date.now() - t0)} ms`);
});

after(async () => {
  for (const c of children) await c.stopIfRunning();
  await observer.end();
  await cluster.stop();
  console.log('\n──────── MEASUREMENT SUMMARY ────────');
  for (const line of MEASUREMENTS) console.log(line);
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe("E-0 — graphile-worker's own schema is closed to every role but its owner", () => {
  it('E-0.1  every graphile-worker table has RLS ENABLED and ZERO policies', async () => {
    const tables = await rlsEnabledWorkerTables();
    assert.ok(tables.length > 0, 'expected graphile-worker to enable RLS on its tables');
    for (const t of tables) {
      assert.equal(t.policies, 0, `${t.table} unexpectedly ships a policy`);
    }
    record(
      'E-0.1',
      `graphile-worker enables RLS with ZERO policies on ${String(tables.length)} tables: ` +
        tables.map((t) => t.table).join(', '),
    );
  });

  it('E-0.2  full table GRANTs are NOT sufficient: app_worker reads nothing, app_runtime is refused', async () => {
    // app_worker holds SELECT/INSERT/UPDATE/DELETE on every table in the schema.
    const worker = await clientAs('app_worker');
    let workerVisible = -1;
    try {
      const { rows } = await worker.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${WORKER_SCHEMA}._private_tasks`,
      );
      workerVisible = Number(rows[0]?.n ?? -1);
    } finally {
      await worker.end();
    }
    assert.equal(workerVisible, 0, 'a granted-but-unpolicied role sees zero rows, silently');

    const runtime = await clientAs('app_runtime');
    let sqlstate = '';
    try {
      await runtime.query(`SELECT ${WORKER_SCHEMA}.add_job('spike.complete', '{}'::json)`);
      assert.fail('add_job should not have been permitted');
    } catch (error) {
      sqlstate = (error as { code?: string }).code ?? '';
    } finally {
      await runtime.end();
    }
    assert.equal(sqlstate, '42501', 'expected insufficient_privilege');
    record(
      'E-0.2',
      'with full table GRANTs: app_worker SELECT returns 0 rows SILENTLY; ' +
        `app_runtime add_job raises SQLSTATE ${sqlstate} (RLS, not a missing grant)`,
    );
  });

  it('E-0.3  the remediation: named policies for the consumer, a SECURITY DEFINER wrapper for the producer', async () => {
    const policies = await remediateWorkerSchema();
    assert.ok(policies > 0);

    const runtime = await clientAs('app_runtime');
    try {
      const id = await enqueue(runtime, 'spike.complete', { key: 'e0-3' });
      assert.match(id, /^\d+$/);
    } finally {
      await runtime.end();
    }
    const worker = await clientAs('app_worker');
    let workerVisible = -1;
    try {
      const { rows } = await worker.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${WORKER_SCHEMA}._private_jobs`,
      );
      workerVisible = Number(rows[0]?.n ?? -1);
    } finally {
      await worker.end();
    }
    assert.equal(workerVisible, 1, 'the consumer can now see the job');

    record(
      'E-0.3',
      `${String(policies)} named policies TO app_worker + a SECURITY DEFINER enqueue wrapper ` +
        '(app_runtime holds NO grant and NO policy on the queue tables) → producer and ' +
        'consumer both work. No RLS was disabled and no role was given BYPASSRLS',
    );
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('E-1 — transactional enqueue (the outbox property)', () => {
  it('E-1.1  a ROLLED BACK domain transaction enqueues NOTHING', async () => {
    await truncateObservations();
    const client = await clientAs('app_runtime');
    let jobId = '';
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO spike_domain_writes (id, label) VALUES ($1, $2)', [
        randomUUID(),
        'rolled-back',
      ]);
      // The wrapper returns the id of a row that now exists on THIS connection.
      // A no-op would have to invent a plausible bigint to fake this.
      jobId = await enqueue(client, 'spike.complete', { key: 'e1-1' });
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }

    assert.deepEqual(await observer.jobs(), [], 'no job may survive the rollback');
    assert.deepEqual(await observer.domainWrites(), [], 'no domain row may survive the rollback');
    record(
      'E-1.1',
      `ROLLBACK → 0 jobs, 0 domain rows (the enqueue had returned job id ${jobId} inside the ` +
        'transaction, so SECURITY DEFINER did NOT open a transaction of its own)',
    );
  });

  it('E-1.2  a COMMITTED domain transaction enqueues exactly one job', async () => {
    await truncateObservations();
    const client = await clientAs('app_runtime');
    let txid = '';
    let jobId = '';
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO spike_domain_writes (id, label) VALUES ($1, $2)', [
        randomUUID(),
        'committed',
      ]);
      jobId = await enqueue(client, 'spike.complete', { key: 'e1-2' });
      const t = await client.query<{ x: string }>('SELECT pg_current_xact_id()::text AS x');
      txid = t.rows[0]?.x ?? '';
      await client.query('COMMIT');
    } finally {
      await client.end();
    }

    const jobs = await observer.jobs();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.id, jobId);
    assert.equal(jobs[0]?.task_identifier, 'spike.complete');
    assert.equal((await observer.domainWrites()).length, 1);
    record('E-1.2', `COMMIT → 1 job (id ${jobId}) + 1 domain row, one transaction (xid ${txid})`);
  });

  it('E-1.3  a failure AFTER the enqueue takes the enqueue down with it', async () => {
    await truncateObservations();
    const client = await clientAs('app_runtime');
    let sqlstate = '';
    try {
      await client.query('BEGIN');
      await enqueue(client, 'spike.complete', { key: 'e1-3' });
      try {
        // The domain write fails its CHECK constraint — the ordinary shape of
        // "the mutation turned out to be invalid after we queued the follow-up".
        await client.query('INSERT INTO spike_domain_writes (id, label) VALUES ($1, $2)', [
          randomUUID(),
          '   ',
        ]);
        assert.fail('the CHECK constraint should have rejected this row');
      } catch (error) {
        sqlstate = (error as { code?: string }).code ?? '';
      }
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }

    assert.equal(sqlstate, '23514', 'expected a check_violation');
    assert.deepEqual(await observer.jobs(), []);
    assert.deepEqual(await observer.domainWrites(), []);
    record('E-1.3', `domain failure (SQLSTATE ${sqlstate}) after enqueue → 0 jobs enqueued`);
  });

  it('E-1.4  an uncommitted enqueue is invisible to every other connection', async () => {
    await truncateObservations();
    const client = await clientAs('app_runtime');
    try {
      await client.query('BEGIN');
      await enqueue(client, 'spike.complete', { key: 'e1-4' });
      // A different connection, at READ COMMITTED, mid-transaction.
      assert.deepEqual(await observer.jobs(), [], 'an uncommitted job must not be visible');
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
    record('E-1.4', 'uncommitted enqueue invisible on a second connection (READ COMMITTED)');
  });

  it('E-1.5  after commit, a worker consumes the job end to end', async () => {
    await truncateObservations();
    const worker = child({ label: 'e1-consumer', resetMs: 500 });
    await worker.start();

    const client = await clientAs('app_runtime');
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO spike_domain_writes (id, label) VALUES ($1, $2)', [
        randomUUID(),
        'consumed',
      ]);
      await enqueue(client, 'spike.complete', { key: 'e1-5' });
      await client.query('COMMIT');
    } finally {
      await client.end();
    }

    const { elapsedMs } = await waitFor('the effect to be applied', async () => {
      const effects = await observer.effects();
      return effects.length === 1 ? effects : undefined;
    });

    await waitFor('the job to leave the queue', async () => {
      const jobs = await observer.jobs();
      return jobs.length === 0 ? jobs : undefined;
    });
    await worker.terminate();
    record('E-1.5', `commit → consumed → effect applied in ${String(elapsedMs)} ms`);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('E-2 — durable lease behaviour', () => {
  it('E-2.1  a SIGKILLed worker leaves the job durable and still locked', async () => {
    await truncateObservations();
    const holder = child({ label: 'e2-holder' });
    await holder.start();

    const client = await clientAs('app_runtime');
    try {
      await enqueue(client, 'spike.hold', { key: 'e2' });
    } finally {
      await client.end();
    }

    const started = await waitFor('the hold task to start', async () => {
      const runs = await observer.runs();
      return runs.length === 1 ? runs : undefined;
    });
    const holderPid = holder.pid;
    const exit = await holder.kill();

    assert.equal(exit.signal, 'SIGKILL', 'the worker must have died by signal, not gracefully');
    assert.equal(started.value[0]?.worker_pid, holderPid);

    const jobs = await observer.jobs();
    assert.equal(jobs.length, 1, 'the job must survive the worker');
    assert.notEqual(jobs[0]?.locked_at, null, 'and it must still be locked');
    assert.equal(jobs[0]?.attempts, 1);
    record(
      'E-2.1',
      `SIGKILL of pid ${String(holderPid)} mid-job → job survives, still locked ` +
        `(locked_by=${String(jobs[0]?.locked_by)}, attempts=1)`,
    );
  });

  it('E-2.2  a live second worker will NOT take the leased job', async () => {
    // Continues from E-2.1 — deliberately no truncate.
    const second = child({ label: 'e2-second', resetMs: 250, holdMode: 'complete' });
    await second.start();

    const window = await stayFalse(
      'the leased job being executed by another worker',
      async () => (await observer.runs()).length > 1,
      4_000,
    );

    const jobs = await observer.jobs();
    assert.equal(jobs.length, 1);
    assert.notEqual(jobs[0]?.locked_at, null);
    record(
      'E-2.2',
      `a second worker sweeping stale locks every 250–500 ms did not touch the leased job ` +
        `for ${String(window)} ms`,
    );
    await second.terminate();
  });

  it('E-2.3  the lease boundary is measured, not assumed: 3h59m held, 4h01m reclaimed', async () => {
    // Continues from E-2.2 — the job is still locked by the dead worker.
    const sweeper = child({ label: 'e2-sweeper', resetMs: 250, holdMode: 'complete' });
    await sweeper.start();

    const agedShort = await observer.ageLocks('3 hours 59 minutes'); // FAULT INJECTION
    assert.equal(agedShort, 1);
    const heldFor = await stayFalse(
      'reclaim at 3h59m of lock age',
      async () => (await observer.runs()).length > 1,
      3_000,
    );
    record('E-2.3a', `locked_at aged to 3h59m → NOT reclaimed within ${String(heldFor)} ms`);

    const agedLong = await observer.ageLocks('4 hours 1 minute'); // FAULT INJECTION
    assert.equal(agedLong, 1);
    const reclaimed = await waitFor('the job to be re-executed after lease expiry', async () => {
      const runs = await observer.runs();
      return runs.length > 1 ? runs : undefined;
    });
    const done = await waitFor('the reclaimed job to complete', async () => {
      const jobs = await observer.jobs();
      return jobs.length === 0 ? jobs : undefined;
    });

    const effects = await observer.effects();
    assert.equal(effects.length, 1, 'the effect must be applied exactly once');
    assert.equal(reclaimed.value[1]?.attempt, 2, 'the re-execution is attempt 2');

    record(
      'E-2.3b',
      `locked_at aged to 4h01m → re-executed after ${String(reclaimed.elapsedMs)} ms ` +
        `(sweep interval 250–500 ms), completed after ${String(done.elapsedMs)} ms; ` +
        'effect applied exactly once',
    );
    record(
      'E-2.3c',
      'LEASE = 4 hours, hard-coded in graphile-worker (resetLockedAt() and the SQL functions). ' +
        'Only the SWEEP INTERVAL is configurable (minResetLockedInterval / ' +
        'maxResetLockedInterval, default 8–10 min). There is no option to shorten the lease',
    );
    await sweeper.terminate();
  });

  it('E-2.4  SIGTERM with an ABORT-AWARE task in flight: the worker exits cleanly but STRANDS the job', async () => {
    // This test asserts the opposite of what it was first written to assert.
    // The premise — "graceful shutdown returns the in-flight job promptly" — is
    // simply false, and it took a 20-second timeout and a standalone diagnostic
    // to establish that rather than a plausible-looking green test.
    await truncateObservations();
    const holder = child({ label: 'e2-graceful', abortMs: 500 });
    await holder.start();

    const client = await clientAs('app_runtime');
    try {
      await enqueue(client, 'spike.abortable', { key: 'e2-graceful' });
    } finally {
      await client.end();
    }
    await waitFor('the abortable task to start', async () => {
      const runs = await observer.runs();
      return runs.length === 1 ? runs : undefined;
    });

    // Signal WITHOUT waiting, so the database can be observed while the worker
    // is still shutting down. See WorkerChild.terminate() for why waiting on the
    // process first deadlocked the first run of this harness.
    const t0 = Date.now();
    holder.signalOnly('SIGTERM');
    const exit = await holder.waitForExit(15_000);
    const exitMs = Date.now() - t0;

    // The task DID observe the abort and DID throw — the run log proves it.
    const runs = await observer.runs();
    assert.ok(
      runs.some((r) => r.phase === 'aborted'),
      'the task must have seen abortSignal',
    );
    // graphile-worker's signal handler cleans up and then re-raises the signal
    // on itself, so the exit is `signal=SIGTERM, code=null` — a clean, intended
    // shutdown, not a kill from outside.
    assert.equal(exit.signal, 'SIGTERM');
    assert.equal(exit.code, null);

    // …and the job is nevertheless still locked, with the failure NOT persisted.
    await sleep(1_000); // generous room for a late write, if one existed
    const jobs = await observer.jobs();
    assert.equal(jobs.length, 1);
    assert.notEqual(jobs[0]?.locked_at, null, 'the job is stranded under the lease');
    assert.equal(jobs[0]?.last_error, null, 'the failure was never written');
    assert.equal(jobs[0]?.attempts, 1);
    record(
      'E-2.4',
      `SIGTERM + abortSignal-aware task → the task observed the abort and threw, the process ` +
        `exited on its own re-raised SIGTERM in ${String(exitMs)} ms, and the job was STILL LOCKED with ` +
        'last_error=null 1000 ms later. The in-flight failure is NOT persisted on shutdown: ' +
        'an ordinary rolling deploy strands every in-flight job for the full 4-hour lease',
    );
  });

  it('E-2.4b  a task that IGNORES the abort signal does not exit on the first SIGTERM at all', async () => {
    await truncateObservations();
    const holder = child({ label: 'e2-stubborn', abortMs: 500 });
    await holder.start();

    const client = await clientAs('app_runtime');
    try {
      await enqueue(client, 'spike.hold', { key: 'e2-stubborn' });
    } finally {
      await client.end();
    }
    await waitFor('the hold task to start', async () => {
      const runs = await observer.runs();
      return runs.length === 1 ? runs : undefined;
    });

    holder.signalOnly('SIGTERM');
    const stillAlive = await stayFalse(
      'the process exiting on the first SIGTERM',
      async () => {
        try {
          process.kill(holder.pid, 0);
          return false;
        } catch {
          return true;
        }
      },
      6_000,
    );
    assert.notEqual((await observer.jobs())[0]?.locked_at, null);

    // A SECOND SIGTERM is graphile-worker's forceful path (the "Ctrl-C twice"
    // behaviour), and it does end the process.
    const t1 = Date.now();
    const exit = await holder.terminate();
    record(
      'E-2.4b',
      `SIGTERM + a task that never settles and ignores abortSignal → process STILL ALIVE and ` +
        `job still locked after ${String(stillAlive)} ms; a SECOND SIGTERM (forceful shutdown) ` +
        `ended it in ${String(Date.now() - t1)} ms (escalated-to-SIGKILL=${String(exit.escalated)}). ` +
        'CONSEQUENCE: every SchedulePoint job handler must honour helpers.abortSignal, and the ' +
        'deployment must send SIGTERM twice or set a kill deadline',
    );
  });

  it('E-2.5  forceUnlockWorkers is the operational escape from a 4-hour lease', async () => {
    await truncateObservations();
    const holder = child({ label: 'e2-forceunlock' });
    await holder.start();

    const client = await clientAs('app_runtime');
    try {
      await enqueue(client, 'spike.hold', { key: 'e2-force' });
    } finally {
      await client.end();
    }
    await waitFor('the hold task to start', async () => {
      const runs = await observer.runs();
      return runs.length === 1 ? runs : undefined;
    });
    await holder.kill();

    const locked = await observer.jobs();
    const lockedBy = locked[0]?.locked_by;
    assert.ok(lockedBy, 'the dead worker must have left its pool id on the job');

    const utils = await makeWorkerUtils({ connectionString: connectionString('app_worker') });
    const t0 = Date.now();
    try {
      await utils.forceUnlockWorkers([lockedBy]);
    } finally {
      await utils.release();
    }
    const elapsed = Date.now() - t0;

    const afterUnlock = await observer.jobs();
    assert.equal(afterUnlock.length, 1);
    assert.equal(afterUnlock[0]?.locked_at, null, 'forceUnlockWorkers must clear the lock');
    record(
      'E-2.5',
      `forceUnlockWorkers(['${lockedBy}']) cleared a dead worker's lease in ${String(elapsed)} ms ` +
        '— an explicit operator action, not automatic recovery',
    );
  });

  it('E-2.6  MITIGATION: a startup reclaim recovers stranded jobs in milliseconds, not four hours', async () => {
    await truncateObservations();
    const doomed = child({ label: 'e2-doomed' });
    await doomed.start();

    const client = await clientAs('app_runtime');
    try {
      await enqueue(client, 'spike.hold', { key: 'e2-reclaim' });
    } finally {
      await client.end();
    }
    await waitFor('the hold task to start', async () => {
      const runs = await observer.runs();
      return runs.length === 1 ? runs : undefined;
    });
    await doomed.kill();

    const stranded = await observer.jobs();
    const strandedPool = stranded[0]?.locked_by;
    assert.ok(strandedPool);
    const registered = await observer.query<{ pool_id: string; released_at: Date | null }>(
      'SELECT pool_id, released_at FROM spike_pools ORDER BY started_at',
    );
    assert.equal(registered.length, 1);
    assert.equal(registered[0]?.pool_id, strandedPool, 'our registry recorded the dead pool');
    assert.equal(registered[0]?.released_at, null, 'and it never released');

    // The replacement worker reclaims on startup, BEFORE serving. No clock is
    // manipulated here: this is the real elapsed time.
    const t0 = Date.now();
    const replacement = child({
      label: 'e2-replacement',
      holdMode: 'complete',
      reclaim: true,
    });
    await replacement.start();
    const done = await waitFor('the stranded job to be re-executed and completed', async () => {
      const jobs = await observer.jobs();
      return jobs.length === 0 ? jobs : undefined;
    });
    const elapsed = Date.now() - t0;

    const effects = await observer.effects();
    assert.equal(effects.length, 1, 'the stranded job ran exactly once after reclaim');
    const readyLine = replacement.stdoutLines.find((l) => l.includes('"event":"ready"')) ?? '';
    assert.ok(readyLine.includes(strandedPool), 'the reclaim must name the dead pool');

    record(
      'E-2.6',
      `MITIGATION MEASURED: a self-registering pool table + force_unlock_workers at worker ` +
        `startup recovered the stranded job in ${String(elapsed)} ms end-to-end ` +
        `(re-execution observed ${String(done.elapsedMs)} ms after the replacement was ready), ` +
        'against a 4-hour unmitigated lease. No clock was manipulated in this test',
    );
    await replacement.terminate();
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('E-3 — crash mid-job (SIGKILL) recovery', () => {
  it('E-3.1  a job that SIGKILLs its own worker leaves the effect unapplied', async () => {
    await truncateObservations();
    const victim = child({ label: 'e3-victim', suicideUntilAttempt: 1 });
    await victim.start();
    const victimPid = victim.pid;

    const client = await clientAs('app_runtime');
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO spike_domain_writes (id, label) VALUES ($1, $2)', [
        randomUUID(),
        'crash-test',
      ]);
      await enqueue(client, 'spike.suicide', { key: 'e3-once' });
      await client.query('COMMIT');
    } finally {
      await client.end();
    }

    const started = await waitFor('the suicide task to start', async () => {
      const runs = await observer.runs();
      return runs.length === 1 ? runs : undefined;
    });
    const reaped = await waitFor(
      'the child process to die of its own SIGKILL',
      async () => {
        try {
          process.kill(victimPid, 0);
          return undefined;
        } catch {
          return true;
        }
      },
      { timeoutMs: 10_000 },
    );
    assert.equal(reaped.value, true);
    assert.equal(started.value[0]?.worker_pid, victimPid);

    // Give the OS a beat so a late-flushing write could still appear if one existed.
    await sleep(250);
    assert.deepEqual(await observer.effects(), [], 'the effect must NOT have been applied');
    assert.equal((await observer.domainWrites()).length, 1, 'the domain change is committed');
    const jobs = await observer.jobs();
    assert.equal(jobs.length, 1, 'the job survives the crash');
    assert.notEqual(jobs[0]?.locked_at, null);
    assert.equal(jobs[0]?.attempts, 1);
    record(
      'E-3.1',
      `worker SIGKILLed itself mid-job (pid ${String(victimPid)}, started after ` +
        `${String(started.elapsedMs)} ms); domain row committed, effect NOT applied, ` +
        'job durable and still locked (attempts=1)',
    );
  });

  it('E-3.2  a restarted worker re-runs the job to completion, exactly once, with no orphaned state', async () => {
    // Continues from E-3.1 — deliberately no truncate.
    const replacement = child({
      label: 'e3-replacement',
      resetMs: 250,
      suicideUntilAttempt: 1, // attempt 2 completes instead of dying
    });
    await replacement.start();

    const aged = await observer.ageLocks('4 hours 1 minute'); // FAULT INJECTION (see Observer)
    assert.equal(aged, 1);

    const rerun = await waitFor('the crashed job to be re-executed', async () => {
      const runs = await observer.runs();
      return runs.some((r) => r.attempt === 2) ? runs : undefined;
    });
    const drained = await waitFor('the queue to drain', async () => {
      const jobs = await observer.jobs();
      return jobs.length === 0 ? jobs : undefined;
    });

    const effects = await observer.effects();
    assert.equal(effects.length, 1, 'exactly one externally visible effect');
    assert.equal(effects[0]?.attempt, 2, 'applied by the second attempt');
    assert.deepEqual(await observer.lockedQueues(), [], 'no orphaned job-queue lock');
    assert.equal((await observer.domainWrites()).length, 1, 'the domain change is untouched');

    const runs = await observer.runs();
    assert.equal(runs.filter((r) => r.phase === 'completed').length, 1);
    assert.equal(runs.filter((r) => r.phase === 'started').length, 2);

    record(
      'E-3.2',
      `after lease expiry a replacement worker re-ran the crashed job in ` +
        `${String(rerun.elapsedMs)} ms and drained the queue in ${String(drained.elapsedMs)} ms; ` +
        '2 starts, 1 completion, effect applied EXACTLY ONCE (idempotency key), ' +
        'no orphaned queue lock',
    );
    await replacement.terminate();
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('E-4 — I-11 contrast: a failing job never rolls back the domain change', () => {
  it('E-4.1  a job that always throws leaves the committed domain row intact', async () => {
    await truncateObservations();
    const worker = child({ label: 'e4-failing', resetMs: 500 });
    await worker.start();

    const client = await clientAs('app_runtime');
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO spike_domain_writes (id, label) VALUES ($1, $2)', [
        randomUUID(),
        'survives-job-failure',
      ]);
      await enqueue(client, 'spike.always_fails', { key: 'e4' }, 2);
      await client.query('COMMIT');
    } finally {
      await client.end();
    }

    const failed = await waitFor('the job to record a failure', async () => {
      const jobs = await observer.jobs();
      return jobs[0]?.last_error != null ? jobs : undefined;
    });

    assert.equal((await observer.domainWrites()).length, 1, 'the domain change must survive');
    assert.equal((await observer.effects()).length, 0);
    record(
      'E-4.1',
      `job failed after ${String(failed.elapsedMs)} ms ` +
        `(attempts=${String(failed.value[0]?.attempts)}/${String(failed.value[0]?.max_attempts)}, ` +
        `last_error=${JSON.stringify(failed.value[0]?.last_error)}); ` +
        'the committed domain row is untouched — I-11 holds',
    );
    await worker.terminate();
  });
});
