import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SolverParameters } from '@schedulepoint/domain';

import type { PgUnitOfWorkRunner } from '../../src/db/unit-of-work.js';
import { assembleCanonicalInput } from '../../src/solver/canonical-input.js';
import { persistCanonicalInput } from '../../src/solver/snapshot-store.js';
import { createDraftVersion, createPeriod, setRequirement } from '../../src/schedule/service.js';
import { scheduleActor } from './schedule.js';

/**
 * The solver boundary's fixture support (OPUS-M4-001).
 *
 * ## The credentials here are not credentials
 *
 * `FIXTURE_RPC_SECRET` is a synthetic, local-only, throwaway string for a
 * subprocess this machine spawns and reaps within one test. It is not reused
 * anywhere, it names nothing real, and — like every other fixture secret in this
 * repository — it starts with `fixture-local-` so a reader and the secret-scan
 * gate can both tell at a glance that it is not a credential.
 *
 * The production code reads the same variable names and has **no default**: a
 * missing secret throws rather than falling back. That is why the fixture has to
 * set them explicitly.
 *
 * ## The worker really runs
 *
 * These helpers point the client at the real Python package under `solver/`,
 * executed by the host interpreter — the FAD-7 substitution, recorded rather
 * than smoothed over. Nothing here mocks the subprocess: the properties under
 * proof are *a subprocess starts, authenticates, can be cancelled, and can be
 * killed*, and a mock would prove that a mock does those things.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** `<worktree>/solver` — the Python package's directory. */
export const SOLVER_ROOT = resolve(HERE, '../../../../solver');

/** A hostile worker, for the response-refusal proofs. See the file's own header. */
export const HOSTILE_WORKER = resolve(HERE, 'hostile-worker.py');

/**
 * 44 bytes, comfortably over the 32-byte minimum both ends enforce.
 *
 * The length is deliberate: a fixture secret at exactly the minimum would make a
 * future off-by-one in either length check invisible, because the fixture would
 * fail at the same time the check did.
 */
export const FIXTURE_RPC_SECRET = 'fixture-local-solver-rpc-secret-0123456789ab';
export const FIXTURE_RPC_KEY_ID = 'fixture-local-solver-key-1';

/* ────────────────────────────────────────────────────────────────────────────
 * Which interpreter runs the worker
 *
 * ## The defect this closes
 *
 * `applySolverEnv` used to hard-code `'python3'` as its default command. That
 * default is correct for a machine whose `python3` has OR-Tools installed, and
 * it silently OVERRODE `SP_SOLVER_WORKER_COMMAND` on every machine where it is
 * not — so `SP_SOLVER_WORKER_COMMAND=… vitest run` set a variable that the very
 * first `beforeEach` unset again. The symptom was seventeen solver proofs
 * failing with `FAILED`/`crashed` while the identical snapshot solved fine when
 * the venv interpreter was invoked by hand (EV-M4-002 step-07/step-08).
 *
 * The attribution was never wrong: a child that dies on
 * `from ortools.sat.python import cp_model` **has** crashed, and that is what
 * the parent must say. The wiring was wrong.
 *
 * ## The order, and why each rung exists
 *
 *   1. `SP_SOLVER_WORKER_COMMAND` — the deployment/CI answer, and the one this
 *      helper must stop stepping on. Read from the AMBIENT environment captured
 *      at module load, because `applySolverEnv` writes that same variable and a
 *      later read would see the harness's own value rather than the operator's.
 *   2. `SP_SOLVER_VENV` — a venv ROOT rather than an interpreter path, for the
 *      common local case. A root that has no `bin/python` **throws**: falling
 *      back would reproduce exactly the failure this exists to remove, with a
 *      typo presenting as `crashed` half an hour later.
 *   3. **Discovery**, at repository-relative paths only — `solver/.venv` and the
 *      worktree's `.venv`. Both are already gitignored, so a developer creates
 *      one (or symlinks one) and every battery works with no environment at all.
 *   4. `python3`. The generic committed default, unchanged.
 *
 * **No user-specific path is committed anywhere in this file.** Rungs 2 and 3
 * are how a local venv is reached; `docs/evidence/EV-M4-002/INDEX.md` records
 * the one-line local setup.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The ambient values, captured BEFORE any `applySolverEnv` call can write them. */
const AMBIENT_WORKER_COMMAND = process.env['SP_SOLVER_WORKER_COMMAND'];
const AMBIENT_SOLVER_VENV = process.env['SP_SOLVER_VENV'];

/** Rung 3, in order. Repository-relative and gitignored — never a home directory. */
export const DISCOVERED_INTERPRETER_PATHS: readonly string[] = [
  resolve(SOLVER_ROOT, '.venv/bin/python'),
  resolve(SOLVER_ROOT, '../.venv/bin/python'),
];

export interface InterpreterSources {
  readonly workerCommand?: string | undefined;
  readonly venvRoot?: string | undefined;
  /** Injected so the resolution ORDER is testable without touching a filesystem. */
  readonly exists?: (path: string) => boolean;
}

/** Resolve the worker interpreter by the four-rung order documented above. */
export function resolveWorkerInterpreter(sources: InterpreterSources = {}): string {
  const exists = sources.exists ?? existsSync;

  const explicit = sources.workerCommand;
  if (explicit !== undefined && explicit !== '') return explicit;

  const venvRoot = sources.venvRoot;
  if (venvRoot !== undefined && venvRoot !== '') {
    const candidate = resolve(venvRoot, 'bin', 'python');
    if (exists(candidate)) return candidate;
    throw new Error(
      `SP_SOLVER_VENV is set to ${venvRoot}, which has no bin/python. A venv path that ` +
        'does not resolve is a configuration error; falling back to the system interpreter ' +
        'would report it as a crashed worker instead.',
    );
  }

  for (const candidate of DISCOVERED_INTERPRETER_PATHS) {
    if (exists(candidate)) return candidate;
  }
  return 'python3';
}

/** The interpreter THIS run uses. One resolution, at module load. */
export const WORKER_INTERPRETER = resolveWorkerInterpreter({
  workerCommand: AMBIENT_WORKER_COMMAND,
  venvRoot: AMBIENT_SOLVER_VENV,
});

export interface SolverEnvOptions {
  /** Override the interpreter. Defaults to {@link WORKER_INTERPRETER}. */
  readonly command?: string;
  /** Override the module invocation — the hostile-worker fixtures use this. */
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly secret?: string;
  readonly keyId?: string;
}

/**
 * Point the client at a worker, and restore whatever was there before.
 *
 * Returns a restore function rather than mutating and hoping: two solver files
 * run in the same worker process, and a test that left `SP_SOLVER_WORKER_ARGS`
 * pointing at a hostile fixture would make an unrelated file fail in a way that
 * looks like a boundary defect. FAD-15's isolation discipline, applied to the
 * environment.
 */
export function applySolverEnv(options: SolverEnvOptions = {}): () => void {
  const previous: Record<string, string | undefined> = {};
  const set = (name: string, value: string | undefined): void => {
    previous[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  set('SP_SOLVER_RPC_SECRET', options.secret ?? FIXTURE_RPC_SECRET);
  set('SP_SOLVER_RPC_KEY_ID', options.keyId ?? FIXTURE_RPC_KEY_ID);
  set('SP_SOLVER_WORKER_COMMAND', options.command ?? WORKER_INTERPRETER);
  set(
    'SP_SOLVER_WORKER_ARGS',
    JSON.stringify(options.args ?? ['-m', 'schedulepoint_solver']),
  );
  set('SP_SOLVER_WORKER_CWD', options.cwd ?? SOLVER_ROOT);

  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

/** Point the client at the hostile-worker fixture in the named mode. */
export function applyHostileWorkerEnv(mode: string): () => void {
  return applySolverEnv({ args: [HOSTILE_WORKER, mode], cwd: SOLVER_ROOT });
}

/**
 * Parameters that make a run REPRODUCIBLE by SPEC-04 §4's amended definition:
 * the deterministic portfolio on, and a deterministic time limit pinned.
 *
 * Named rather than inlined so the tests that assert `reproducibilityMode` are
 * asserting against the conditions rather than against a literal they also
 * wrote.
 */
export const DETERMINISTIC_PARAMETERS: SolverParameters = {
  randomSeed: 20270301,
  numSearchWorkers: 1,
  maxTimeInSeconds: 10,
  maxDeterministicTime: 100,
  interleaveSearch: true,
};

/**
 * **The SOLVED set** — the two statuses that mean "a candidate came back".
 *
 * SPEC-04 §2 keeps `FEASIBLE` and `OPTIMAL` distinct, and SPEC-04 §7 forbids
 * claiming the second without a proof. They are NOT interchangeable and this
 * constant does not make them so: it exists because a test whose subject is
 * *"the round trip produced a candidate"* was written as `toBe('FEASIBLE')`
 * when the only implementation behind it was a stub that could never prove
 * optimality. The real CP-SAT model proves it on these fixtures and returns
 * `OPTIMAL` — SPEC-04 §7 honoured, not violated — so the assertion has to say
 * what it always meant.
 *
 * A test that means *specifically feasible-and-not-proven-optimal* must
 * construct that case and assert `toBe('FEASIBLE')` on its own; nothing here
 * admits `OPTIMAL` into such a test, and nothing here weakens the honesty
 * proofs, which assert exact statuses and still do
 * (`response-refusals.test.ts`'s ten impossible pairs, `worker-invariants`'
 * "the stub never claims OPTIMAL").
 */
export const SOLVED_STATUSES: readonly string[] = ['FEASIBLE', 'OPTIMAL'];

/** The same, with the two reproducibility conditions absent. */
export const BEST_EFFORT_PARAMETERS: SolverParameters = {
  randomSeed: 20270301,
  numSearchWorkers: 8,
  maxTimeInSeconds: 10,
  maxDeterministicTime: null,
  interleaveSearch: false,
};

export interface SolverFixture {
  readonly periodId: string;
  readonly versionId: string;
  readonly shiftTypeId: string;
  readonly startDate: string;
  readonly endDate: string;
}

export interface SeedSolverFixtureInput {
  readonly organizationId: string;
  readonly groupId: string;
  readonly actorMembershipId: string;
  readonly actorUserId: string;
  readonly shiftTypeId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly requiredCount?: number;
}

/**
 * A period, a dated requirement, and a draft version — through the production
 * write path.
 *
 * `createPeriod` and `setRequirement` are the same functions a route calls. A
 * fixture that inserted rows directly would seed states the application cannot
 * produce, and would then "prove" things about rows no code path can create.
 *
 * The draft version is what gives the snapshot its timezone basis: `0014`
 * records it when a draft comes into existence, and a build against a version
 * with no basis is a build nobody can reproduce.
 */
export async function seedSolverFixture(
  runtime: PgUnitOfWorkRunner,
  input: SeedSolverFixtureInput,
): Promise<SolverFixture> {
  const actor = scheduleActor(input.actorUserId);
  const context = {
    organizationId: input.organizationId,
    groupId: input.groupId,
    membershipId: input.actorMembershipId,
    correlationId: 'solver-fixture-seed',
  };

  return runtime.run(context, async (uow) => {
    const periodId = await createPeriod(uow, actor, {
      name: `Solver fixture ${input.startDate}`,
      startDate: input.startDate,
      endDate: input.endDate,
    });
    await setRequirement(uow, actor, {
      periodId,
      date: input.startDate,
      shiftTypeId: input.shiftTypeId,
      requiredCount: input.requiredCount ?? 1,
    });
    const versionId = await createDraftVersion(uow, actor, periodId);
    return {
      periodId,
      versionId,
      shiftTypeId: input.shiftTypeId,
      startDate: input.startDate,
      endDate: input.endDate,
    };
  });
}

export interface SweepSeedTarget {
  readonly label: string;
  readonly organizationId: string;
  readonly groupId: string;
  readonly membershipId: string;
  readonly userId: string;
  readonly shiftTypeId: string;
  readonly startDate: string;
  readonly endDate: string;
}

/**
 * A snapshot row in each named group, so SBX-004's sweep has something it could
 * see if the group predicate were broken.
 *
 * The purpose is **the existence of rows in more than one group**, not the
 * exercise of the assembly path — which the named proofs cover directly. The
 * sweep's own non-vacuity check fails a REGISTERED table that is never observed
 * with a visible row, and a probe over an empty table reports "0 wrong-tenant
 * rows" for the most boring possible reason.
 *
 * It goes through `assembleCanonicalInput` + `persistCanonicalInput`, exactly as
 * `seedRulesForSweep` goes through the rule write path: a snapshot the fixture
 * could write directly is a snapshot the application could forge.
 */
export async function seedSolverSnapshotsForSweep(
  runtime: PgUnitOfWorkRunner,
  targets: readonly SweepSeedTarget[],
): Promise<number> {
  let written = 0;
  for (const target of targets) {
    const fixture = await seedSolverFixture(runtime, {
      organizationId: target.organizationId,
      groupId: target.groupId,
      actorMembershipId: target.membershipId,
      actorUserId: target.userId,
      shiftTypeId: target.shiftTypeId,
      startDate: target.startDate,
      endDate: target.endDate,
    });

    await runtime.run(
      {
        organizationId: target.organizationId,
        groupId: target.groupId,
        membershipId: target.membershipId,
        correlationId: `solver-sweep-${target.label}`,
      },
      async (uow) => {
        const assembled = await assembleCanonicalInput(uow, {
          periodId: fixture.periodId,
          versionId: fixture.versionId,
          at: new Date(`${fixture.startDate}T12:00:00.000Z`),
        });
        await persistCanonicalInput(uow, {
          document: assembled.document,
          constituents: assembled.constituents,
          idempotencyKey: `sweep-${target.label}-${randomUUID()}`,
        });
      },
    );
    written += 1;
  }
  return written;
}
