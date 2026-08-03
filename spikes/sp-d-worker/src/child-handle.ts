import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';

import { SPIKE_ROOT, connectionString } from './config.ts';

const CHILD = join(SPIKE_ROOT, 'src', 'worker-child.ts');

export interface ChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface WorkerChildOptions {
  readonly label: string;
  /** `minResetLockedInterval` in ms. 0 leaves graphile-worker's 8–10 min default. */
  readonly resetMs?: number;
  readonly holdMode?: 'hold' | 'complete';
  readonly suicideUntilAttempt?: number;
  readonly pollMs?: number;
  /** graphile-worker's `gracefulShutdownAbortTimeout`, ms. Default 5000. */
  readonly abortMs?: number;
  /** Run the startup reclaim of stale pools (E-2.6's mitigation). */
  readonly reclaim?: boolean;
}

/**
 * A worker child process the harness can start, observe and kill.
 *
 * The child is a REAL separate process (`node --import tsx src/worker-child.ts`),
 * which is what makes `kill('SIGKILL')` mean what it says. An in-process worker
 * would only ever prove that a promise was abandoned.
 */
export class WorkerChild {
  readonly label: string;
  #proc: ChildProcess | undefined;
  #exit: Promise<ChildExit> | undefined;
  readonly #lines: string[] = [];
  readonly #stderr: string[] = [];

  constructor(private readonly options: WorkerChildOptions) {
    this.label = options.label;
  }

  get pid(): number {
    const pid = this.#proc?.pid;
    if (pid === undefined) throw new Error(`child ${this.label} is not running`);
    return pid;
  }

  get stdoutLines(): readonly string[] {
    return this.#lines;
  }

  get stderrText(): string {
    return this.#stderr.join('');
  }

  async start(timeoutMs = 30_000): Promise<void> {
    const proc = spawn(
      process.execPath,
      ['--import', 'tsx', CHILD],
      {
        cwd: SPIKE_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          SPIKE_DB_URL: connectionString('app_worker'),
          SPIKE_WORKER_LABEL: this.options.label,
          SPIKE_RESET_MS: String(this.options.resetMs ?? 0),
          SPIKE_HOLD_MODE: this.options.holdMode ?? 'hold',
          SPIKE_SUICIDE_UNTIL_ATTEMPT: String(this.options.suicideUntilAttempt ?? 1),
          SPIKE_POLL_MS: String(this.options.pollMs ?? 200),
          SPIKE_ABORT_MS: String(this.options.abortMs ?? 5000),
          SPIKE_RECLAIM: this.options.reclaim === true ? '1' : '0',
        },
      },
    );
    this.#proc = proc;

    let buffer = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        this.#lines.push(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => this.#stderr.push(chunk));

    this.#exit = new Promise<ChildExit>((resolve) => {
      proc.on('exit', (code, signal) => { resolve({ code, signal }); });
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.#lines.some((line) => line.includes('"event":"ready"'))) return;
      if (proc.exitCode !== null || proc.signalCode !== null) {
        throw new Error(
          `child ${this.label} exited before ready: code=${String(proc.exitCode)} ` +
            `signal=${String(proc.signalCode)}\n${this.stderrText}`,
        );
      }
      await sleep(25);
    }
    throw new Error(`child ${this.label} did not become ready within ${String(timeoutMs)}ms`);
  }

  /** SIGKILL — no cleanup, no lock release, no chance to be graceful. */
  async kill(): Promise<ChildExit> {
    this.signalOnly('SIGKILL');
    return this.waitForExit();
  }

  /**
   * SIGTERM — graphile-worker's graceful shutdown path, with a hard deadline.
   *
   * The deadline is not defensive tidiness; it is a MEASUREMENT. The first run
   * of this harness hung indefinitely here, because graphile-worker's graceful
   * shutdown waits for the in-flight task to settle and `spike.hold` never
   * does — `gracefulShutdownAbortTimeout` bounds the *job*, not the *process*.
   * `escalated: true` in the result is that finding, recorded rather than
   * hidden behind a longer timeout.
   */
  async terminate(graceMs = 8_000): Promise<ChildExit & { escalated: boolean }> {
    this.signalOnly('SIGTERM');
    const graceful = await this.waitForExit(graceMs).catch(() => undefined);
    if (graceful !== undefined) return { ...graceful, escalated: false };
    this.signalOnly('SIGKILL');
    return { ...(await this.waitForExit()), escalated: true };
  }

  /** Sends a signal without waiting. Lets the harness observe the DATABASE
   *  while the process is still shutting down. */
  signalOnly(signal: NodeJS.Signals): void {
    if (this.#proc === undefined) throw new Error(`child ${this.label} is not running`);
    this.#proc.kill(signal);
  }

  async waitForExit(timeoutMs = 30_000): Promise<ChildExit> {
    if (this.#exit === undefined) throw new Error(`child ${this.label} was never started`);
    const exit = await Promise.race([
      this.#exit,
      sleep(timeoutMs).then(() => undefined),
    ]);
    if (exit === undefined) {
      throw new Error(`child ${this.label} did not exit within ${String(timeoutMs)}ms`);
    }
    this.#proc = undefined;
    return exit;
  }

  async stopIfRunning(): Promise<void> {
    if (this.#proc !== undefined) {
      try {
        await this.kill();
      } catch {
        /* already gone */
      }
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls `predicate` until it returns a value, or the deadline passes.
 *
 * Returns the elapsed milliseconds alongside the value, because every recovery
 * claim in the report is a measured number, not an adjective.
 */
export async function waitFor<T>(
  description: string,
  predicate: () => Promise<T | undefined>,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ value: T; elapsedMs: number }> {
  const { timeoutMs = 20_000, intervalMs = 25 } = options;
  const started = Date.now();
  const deadline = started + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value !== undefined) return { value, elapsedMs: Date.now() - started };
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${String(timeoutMs)}ms waiting for: ${description}`);
    }
    await sleep(intervalMs);
  }
}

/** Asserts that something does NOT happen within a window. Returns the window. */
export async function stayFalse(
  description: string,
  predicate: () => Promise<boolean>,
  windowMs: number,
  intervalMs = 50,
): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < windowMs) {
    if (await predicate()) {
      throw new Error(
        `expected NOT to observe "${description}" within ${String(windowMs)}ms, ` +
          `but observed it after ${String(Date.now() - started)}ms`,
      );
    }
    await sleep(intervalMs);
  }
  return Date.now() - started;
}
