import { TestCluster } from './cluster.js';
import { applyHarnessEnv } from './env.js';

/**
 * The cluster daemon — the **only** process that imports `embedded-postgres`.
 *
 * `globalSetup` spawns this, waits for the `READY` line on stdout, and sends
 * `SIGTERM` at teardown. The reason it is a separate process rather than a
 * function call is recorded in `cluster.ts`: importing `embedded-postgres`
 * installs a `beforeExit` hook that calls `process.exit(0)` and **discards the
 * process's exit code**, which turned Vitest's `1 failed` into a green gate.
 *
 * Isolating it here means the exit hook belongs to a process whose exit code
 * nobody reads, and it keeps the hook's actual benefit: if the daemon is killed
 * or the terminal is interrupted, the hook shuts the cluster down rather than
 * leaving a zombie `postgres`.
 */

applyHarnessEnv();

const cluster = new TestCluster();
let stopping = false;

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await cluster.stop();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

await cluster.start({ fresh: true });

// The readiness handshake. `globalSetup` blocks on this exact line, so it must
// be the first thing written and must be newline-terminated.
process.stdout.write('READY\n');

// Nothing else to do; stay alive until the parent says stop. The interval is the
// simplest thing that keeps the event loop occupied without polling anything.
setInterval(() => {}, 1 << 30);
