import { randomUUID } from 'node:crypto';
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

export interface SolverEnvOptions {
  /** Override the interpreter. Defaults to `python3` from `PATH`. */
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
  set('SP_SOLVER_WORKER_COMMAND', options.command ?? 'python3');
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
