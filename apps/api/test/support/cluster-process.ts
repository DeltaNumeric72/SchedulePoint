import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

import { API_ROOT } from './env.js';

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
            `stdout: ${stdout}\nstderr: ${stderr}`,
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
        new Error(`the cluster daemon exited with code ${String(code)}\nstderr: ${stderr}`),
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
