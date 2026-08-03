import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { API_ROOT, CLUSTER_DATA_DIR, CLUSTER_PORT } from './env.js';

/**
 * Starting and stopping the cluster daemon.
 *
 * The daemon is a **child process** because `embedded-postgres` installs a
 * `beforeExit` hook that calls `process.exit(0)` and discards the parent's exit
 * code — see `cluster.ts` for the measurement and what it broke. Nothing that
 * needs a meaningful exit code may import that package, so both callers of this
 * module (Vitest's `globalSetup` and the standalone migration-cycle CLI) talk to
 * the cluster over a pipe instead.
 */

const DAEMON = resolve(API_ROOT, 'test/support/cluster-daemon.ts');
const TSX_CLI = resolve(API_ROOT, '../../node_modules/tsx/dist/cli.mjs');
const READY_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 20_000;

/**
 * R-07 — what a stale cluster looks like, and how to clear it.
 *
 * A SIGKILLed run leaves its data directory and, sometimes, a live postmaster on
 * the port. The next run then fails to start, and the raw failure ("could not
 * bind", "lock file exists") does not say which process or which directory. It
 * is NOT contamination — the next run refuses rather than inheriting anything —
 * but a refusal nobody can act on is nearly as expensive.
 */
function staleClusterDiagnostic(): string {
  const port = String(CLUSTER_PORT);
  const lines: string[] = [
    '',
    'STALE CLUSTER? A previous run may have been killed before teardown.',
    `  port           : ${port}`,
    `  data directory : ${CLUSTER_DATA_DIR}`,
  ];
  try {
    const holders = execFileSync('lsof', ['-nP', `-i:${port}`, '-t'], { encoding: 'utf8' })
      .split('\n')
      .map((pid) => pid.trim())
      .filter((pid) => pid.length > 0);
    lines.push(
      holders.length > 0
        ? `  orphan process : pid ${holders.join(', ')} is still listening on ${port}`
        : `  orphan process : nothing is listening on ${port}`,
    );
  } catch {
    lines.push('  orphan process : could not check (lsof unavailable)');
  }
  if (existsSync(CLUSTER_DATA_DIR)) {
    lines.push(
      '  data directory : present (this run may have created it, or a killed run left it)',
    );
  }
  lines.push(
    '',
    '  Recover with:',
    `    lsof -nP -i:${port} -t | xargs -r kill -9`,
    `    rm -rf ${CLUSTER_DATA_DIR}`,
    '',
  );
  return lines.join('\n');
}

/**
 * D-06 — the same diagnostic, for the CONNECTION path.
 *
 * A stale postmaster still holding the port does not fail at daemon startup: the
 * daemon reports READY and the first client dies with a bare "Connection
 * terminated unexpectedly", which names neither the port nor the directory. Wrap
 * anything that connects, and the failure carries its own recovery steps.
 */
export async function withClusterDiagnostic<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${what} failed: ${message}\n${staleClusterDiagnostic()}`, { cause: error });
  }
}

export function startClusterDaemon(): Promise<ChildProcess> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [TSX_CLI, DAEMON], {
      cwd: API_ROOT,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(
        new Error(
          `the cluster daemon did not report READY within ${String(READY_TIMEOUT_MS)}ms\n` +
            `stdout: ${stdout}\nstderr: ${stderr}\n${staleClusterDiagnostic()}`,
        ),
      );
    }, READY_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes('READY')) {
        clearTimeout(timer);
        resolvePromise(child);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      rejectPromise(
        new Error(
          `the cluster daemon exited with code ${String(code)}\nstderr: ${stderr}\n` +
            staleClusterDiagnostic(),
        ),
      );
    });
  });
}

export function stopClusterDaemon(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null) return Promise.resolve();
  return new Promise<void>((resolvePromise) => {
    const kill = setTimeout(() => {
      child.kill('SIGKILL');
      resolvePromise();
    }, STOP_TIMEOUT_MS);
    child.once('exit', () => {
      clearTimeout(kill);
      resolvePromise();
    });
    child.kill('SIGTERM');
  });
}
