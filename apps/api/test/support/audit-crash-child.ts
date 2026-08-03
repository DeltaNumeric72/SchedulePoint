/**
 * A worker in its own OS process, so the harness can kill it for real.
 *
 * The crash questions cannot be answered in-process: `SIGKILL` to the Vitest
 * worker ends the run, and anything softer gives the process a chance to clean
 * up — which is exactly what the experiment must not allow. So this is a child
 * process, the harness holds its PID, and the kill is a real signal 9.
 *
 * It imports **`applyHarnessEnv`, never `cluster.ts`** — importing
 * `embedded-postgres` changes a process's exit code (see `cluster.ts`), and this
 * process's exit code is an assertion.
 *
 * Two modes:
 *
 * | `SPIKE_MODE` | What it does |
 * |---|---|
 * | `append` | appends audit events in a tight loop, printing `{"committed":N}` after each COMMIT. Killed mid-batch by the harness |
 * | `hold` | starts the real outbox runner with a sink that never returns, so a queue job is held under a lease when the process dies |
 */
import { ProcessAlertSink } from '../../src/db/alerts.js';
import { createPool } from '../../src/db/pool.js';
import { PgUnitOfWorkRunner } from '../../src/db/unit-of-work.js';
import { recordAuditEvent } from '../../src/audit/recorder.js';
import { startOutboxRunner } from '../../src/outbox/runner.js';
import type { OutboxDelivery, OutboxSink } from '../../src/outbox/sink.js';
import { applyHarnessEnv } from './env.js';

applyHarnessEnv();

function emit(event: string, detail: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ event, pid: process.pid, ...detail })}\n`);
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
}

/** Never resolves. The job stays leased until the process is killed. */
class BlockingSink implements OutboxSink {
  deliver(delivery: OutboxDelivery): Promise<boolean> {
    // Deliberately does NOT write the effect row: this child models a worker
    // that dies BEFORE its effect. The crash-AFTER-effect window is a separate
    // experiment in `outbox-dispatch.test.ts`.
    emit('delivering', { outboxEventId: delivery.outboxEventId });
    return new Promise(() => {
      /* the harness kills this process */
    });
  }
}

async function appendForever(): Promise<never> {
  const pool = createPool('app_runtime', { max: 2, allowExitOnIdle: true });
  const runner = new PgUnitOfWorkRunner({
    role: 'app_runtime',
    pool,
    alerts: new ProcessAlertSink({ write: () => {} }),
  });
  const context = {
    organizationId: required('SPIKE_ORGANIZATION_ID'),
    groupId: required('SPIKE_GROUP_ID'),
    membershipId: required('SPIKE_MEMBERSHIP_ID'),
    correlationId: required('SPIKE_CORRELATION_ID'),
  };

  emit('ready');
  for (let index = 0; ; index += 1) {
    const recorded = await runner.run(context, (uow) =>
      recordAuditEvent(uow, {
        eventName: 'membership.activity_touched',
        subjectType: 'membership',
        subjectId: context.membershipId,
        payload: { index },
      }),
    );
    // Printed AFTER the commit returns, so a sequence the harness has seen is a
    // sequence that is durably in the chain. Anything the harness has not seen
    // may or may not have committed — which is the honest boundary, and the one
    // the assertions are written against.
    emit('committed', { sequence: recorded.sequence, entryHash: recorded.entryHash });
  }
}

async function holdJob(): Promise<never> {
  const pool = createPool('app_worker', { max: 3, allowExitOnIdle: true });
  const runner = new PgUnitOfWorkRunner({
    role: 'app_worker',
    pool,
    alerts: new ProcessAlertSink({ write: () => {} }),
  });
  const outbox = await startOutboxRunner({
    worker: runner,
    sink: new BlockingSink(),
    label: 'crash-child',
    pollIntervalMs: 100,
    // Long, so this child never reclaims anything itself — the harness is
    // testing the REPLACEMENT's reclaim, and a child that swept its own peers
    // would make the measurement ambiguous.
    staleAfterMs: 3_600_000,
    sweepIntervalMs: 60_000,
  });
  emit('ready', { poolId: outbox.poolId });
  return new Promise(() => {
    /* the harness kills this process */
  });
}

const mode = required('SPIKE_MODE');
const main = mode === 'append' ? appendForever : holdJob;

main().catch((error: unknown) => {
  emit('crashed', { message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
