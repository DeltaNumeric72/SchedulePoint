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
 * substitution, a container entry point in CI.
 *
 * **This is the whole surface over which a solve is reached.** There is no
 * connection string, no credential, and no filesystem handoff — the worker
 * receives its problem on stdin and returns its result on stdout (SPEC-04 §1.1:
 * "Not a shared database, not a shared filesystem").
 *
 * ## `NO_SOLVER_COMMAND` — FU-04, ruled 2026-08-26 under the delegated mandate
 *
 * The command used to default to the literal `'python3'`. **That default is
 * gone**, and this is the FU-04 exit: *"a missing solver command becomes a named
 * `NO_SOLVER_COMMAND` refusal (or startup validation with the same name) — the
 * documented-invocation status quo is superseded."*
 *
 * The evidence is why the diagnosis had to be added HERE rather than at the spawn.
 * `docs/evidence/EV-DOC38-GATE/leg7-attempt1-no-solver-env-real-stack.txt` is a
 * full real-stack run with the variable unset: `python3` existed, so nothing
 * failed to spawn — it started, found no OR-Tools, and exited without writing a
 * response, which the parent correctly attributed as `crashed` /
 * `exit-N-no-response`. The build reached `failed`, the UI said "the independent
 * check REFUSED this candidate", and **nothing anywhere named the missing
 * configuration**. So an `ENOENT` branch at the spawn would not have caught the
 * observed failure at all; only asking the question before the spawn does.
 *
 * **Fail-closed is unchanged — only the diagnosis is added.** Without the
 * variable the system already could not solve; it merely could not say so. This
 * refusal is the same shape, at the same point of use, as `solverRpcKey`'s
 * refusal for a missing shared secret directly above: there is deliberately no
 * default, and the throw travels the identical path — `solveOnWorker` reads the
 * secret and the command two lines apart, so the handling of the two is not
 * merely similar, it is the same code.
 *
 * **The trade, stated rather than discovered.** A deployment that relied on a
 * bare working `python3` on `PATH` must now set the variable. Nothing in this
 * repository did: `ci.yml` and `nightly.yml` export it (twice each), the test
 * harness `applySolverEnv` always sets it, `real-stack-daemon.ts` forwards it,
 * and `docs/dev-setup.md` §8 documents the invocation with it. And a bare
 * `python3` was never a working configuration anyway unless it happened to carry
 * OR-Tools — which is precisely the silent failure the evidence records.
 */
export interface SolverWorkerCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

/**
 * The refusal name FU-04 asks for, carried in the message so it survives into
 * every log line, transcript and screenshot that quotes the error.
 *
 * ADDITIVE to the error taxonomy: nothing is renamed, no existing refusal
 * changes shape, and no wire enum gains a member — this is a configuration
 * refusal at the point of use, like the two above it, not a solve outcome.
 */
export const NO_SOLVER_COMMAND = 'NO_SOLVER_COMMAND';

export function solverWorkerCommand(): SolverWorkerCommand {
  const command = requiredEnv(
    'SP_SOLVER_WORKER_COMMAND',
    `${NO_SOLVER_COMMAND}: the solver worker is a separate deployment unit (SPEC-04 §1.1) and ` +
      'the interpreter or entry point that runs it differs by environment, so there is no ' +
      'command this process can guess. Set it to an interpreter that has OR-Tools — ' +
      'see docs/dev-setup.md §8 (FAD-7 venv substitution) — or to the worker container\'s ' +
      'entry point.',
  );
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
