import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Solver worker configuration — SPEC-04 §§1.1, 2.
 *
 * The same rule this repository's database configuration lives by, for the same
 * reason: **there is no default credential**. A missing shared secret throws at
 * the point of use rather than falling back to a well-known string, because a
 * fallback credential is indistinguishable from a working configuration until
 * the day it is the production one.
 *
 * Deliberately NOT a provider module: no `@provider-port` marker, nothing here
 * reaches anything, and nothing here needs the boundary guard. Keeping it
 * separate is what lets `solver-client.ts` hold the property the static gate
 * checks — **every exported function in a provider module opens with the
 * guard** — without carving out exemptions for bookkeeping helpers. The
 * `provider-probe.ts`/`provider-probe-log.ts` split records the same lesson.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * `solver/` — the Python worker package's directory.
 *
 * **Found by walking up, not by counting `..`.** A fixed depth is correct for
 * exactly one layout: `apps/api/src/solver/config.ts` is four levels below the
 * worktree root, but the COMPILED module lives at
 * `apps/api/dist/src/solver/config.js`, which is five — so the constant silently
 * resolved to `apps/api/solver`, a directory that does not exist. Nothing caught
 * it because every test runs from source; the first thing to break would have
 * been a built deployment, at the point of spawning the worker.
 *
 * Walking up until a directory contains `solver/schedulepoint_solver` is correct
 * for both layouts and for any future one, and it FAILS LOUDLY when the package
 * is genuinely absent rather than handing `spawn` a path that cannot work.
 */
function locateSolverPackage(): string {
  let cursor = HERE;
  for (let hop = 0; hop < 12; hop += 1) {
    const candidate = resolve(cursor, 'solver');
    if (existsSync(resolve(candidate, 'schedulepoint_solver'))) return candidate;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error(
    'the solver worker package could not be located from ' +
      `${HERE}. Expected a 'solver/schedulepoint_solver' directory in an ancestor; ` +
      'set SP_SOLVER_WORKER_CWD explicitly if the worker lives elsewhere.',
  );
}

export const SOLVER_PACKAGE_ROOT = locateSolverPackage();

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

function requiredEnv(name: string, why: string): string {
  const value = env(name);
  if (value === undefined) {
    throw new Error(`${name} is not set. ${why} There is deliberately no default.`);
  }
  return value;
}

/**
 * The minimum secret length, mirrored from the worker's own check.
 *
 * Both ends enforce it. A length rule enforced on one side only is a rule the
 * other side can be configured around, and the failure would present as a
 * working system with a weak key.
 */
export const MIN_RPC_SECRET_BYTES = 32;

export interface SolverRpcKey {
  readonly keyId: string;
  readonly secret: string;
}

/**
 * The shared secret and its key id.
 *
 * Read on every dispatch rather than cached at module load. A cached secret
 * survives a rotation until a restart, and the process this talks to is one that
 * exits after a single solve — the asymmetry would be surprising in exactly the
 * situation (a rotation) where surprise is expensive.
 */
export function solverRpcKey(): SolverRpcKey {
  const secret = requiredEnv(
    'SP_SOLVER_RPC_SECRET',
    'The solver RPC channel is mutually authenticated (SPEC-04 §1.1).',
  );
  if (Buffer.byteLength(secret, 'utf8') < MIN_RPC_SECRET_BYTES) {
    throw new Error(
      `SP_SOLVER_RPC_SECRET is shorter than the ${String(MIN_RPC_SECRET_BYTES)}-byte minimum. ` +
        'A key materially shorter than its own MAC tag makes the control decorative.',
    );
  }
  return {
    keyId: requiredEnv(
      'SP_SOLVER_RPC_KEY_ID',
      'The key id names which secret a message was signed with, so a rotation is a ' +
        'deliberate two-key window rather than a cutover.',
    ),
    secret,
  };
}

/**
 * How to start one worker subprocess.
 *
 * `SP_SOLVER_WORKER_COMMAND` and `SP_SOLVER_WORKER_ARGS` exist because the
 * worker is a *separate deployment unit* (SPEC-04 §1.1) and the way it is
 * reached differs by environment: an interpreter path under the FAD-7 venv
 * substitution, a container entry point in CI. The default is the plain
 * interpreter invocation, which is the one that works from a checkout.
 *
 * **This is the whole surface over which a solve is reached.** There is no
 * connection string, no credential, and no filesystem handoff — the worker
 * receives its problem on stdin and returns its result on stdout (SPEC-04 §1.1:
 * "Not a shared database, not a shared filesystem").
 */
export interface SolverWorkerCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export function solverWorkerCommand(): SolverWorkerCommand {
  const command = env('SP_SOLVER_WORKER_COMMAND') ?? 'python3';
  const rawArgs = env('SP_SOLVER_WORKER_ARGS');
  const args =
    rawArgs === undefined ? ['-m', 'schedulepoint_solver'] : (JSON.parse(rawArgs) as string[]);
  return { command, args, cwd: env('SP_SOLVER_WORKER_CWD') ?? SOLVER_PACKAGE_ROOT };
}

/** The image digest the worker records, when a deployment supplied one. */
export function solverImageDigest(): string | undefined {
  return env('SP_SOLVER_IMAGE_DIGEST');
}

/**
 * How long the parent waits after asking a solve to stop before it terminates
 * the subprocess.
 *
 * SPEC-04 §2's "grace period" between mechanism 2 and mechanism 3. Two seconds
 * is far above the 17 ms the spike measured for a watcher-thread stop and far
 * below anything a scheduler would experience as a hang.
 */
export const DEFAULT_TERMINATION_GRACE_MS = 2_000;
