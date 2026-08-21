import {
  E2_OBJECTIVE_PROFILE,
  OBJECTIVE_SCALE,
  type SolverInputSnapshotDocument,
} from '@schedulepoint/domain';

import { claimQueuedBuild } from '../../src/builds/claim.js';
import {
  OBJECTIVE_PROFILE_DIGEST,
  readStatistics,
} from '../../src/solver/objective-record.js';
import { persistOutcome } from '../../src/builds/runner.js';
import {
  createConfiguration,
  createRun,
  loadRun,
  readConfiguration,
  transitionRun,
} from '../../src/builds/service.js';
import type { PgUnitOfWorkRunner } from '../../src/db/unit-of-work.js';
import { assembleCanonicalInput } from '../../src/solver/canonical-input.js';
import type { SolveOutcomeDetail } from '../../src/solver/solver-client.js';
import { createDraftVersion, createPeriod, setRequirement } from '../../src/schedule/service.js';
import { scheduleActor } from './schedule.js';

/**
 * The build lifecycle's fixture support (OPUS-M4-003).
 *
 * ## Everything here goes through the production service
 *
 * `createConfiguration`, `createRun`, `transitionRun`, `claimQueuedBuild` and
 * `persistOutcome` are the same functions a route calls. Nothing inserts a build
 * row directly, for the reason `seedRulesForSweep` and
 * `seedSolverSnapshotsForSweep` give: a row the fixture could write is a row the
 * application could forge, and the whole value of the transition guard, the
 * fencing trigger and the validation gate is that they cannot be.
 *
 * ## What the seeder deliberately does NOT do
 *
 * It does not spawn the worker. The dispatch is covered directly by the named
 * proofs — `apps/api/test/builds/concurrency-recovery-matrix.test.ts`'s M-07,
 * M-08 and M-23 arms, which drive a real subprocess through cancellation, wall
 * clock and a hostile response — which is where a subprocess belongs; a sweep
 * that
 * spawned one per group would add minutes and a second failure mode to a test
 * whose question is "does any table leak across a tenant boundary". The outcome
 * handed to `persistOutcome` is a hand-built one — which is exactly the shape
 * M4-001 built `validateBuildOutcome` to be testable with — and the rows it
 * produces are written by production code through the production constraints.
 */

export interface BuildSweepTarget {
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
 * A hand-built worker outcome carrying one placement.
 *
 * `INFEASIBLE`, `TIMEOUT`, `CANCELLED` and `FAILED` all carry `assignments:
 * null`, so a seeder that used one of them would populate no candidate rows.
 * `FEASIBLE` with one assignment is the smallest outcome that reaches every one
 * of the three result-bearing tables.
 */
export function syntheticOutcome(
  canonicalInputHash: string,
  membershipId: string,
  date: string,
  shiftTypeId: string,
): SolveOutcomeDetail {
  return {
    status: 'FEASIBLE',
    terminationReason: 'completed',
    canonicalInputHash,
    assignments: [{ membershipId, date, shiftTypeId, locationId: null }],
    runtime: {
      imageDigest: 'fixture-local-none',
      solverVersion: 'fixture-local-stub',
      compilerVersion: 'fixture-local-stub',
      platformArch: process.arch,
      languageRuntime: 'fixture-local-stub',
      reproducibilityMode: 'best-effort',
    },
    elapsedMs: 1,
    explanation: null,
    objectiveTiers: [],
    objectiveValue: null,
    /* OPUS-M4-004. The platform's OWN profile, because this outcome stands in
     * for a worker that agreed — a fixture reporting a mismatching digest would
     * be seeding a state `solveOnWorker` refuses to produce. */
    objectiveProfile: {
      profileId: E2_OBJECTIVE_PROFILE.profileId,
      scale: OBJECTIVE_SCALE,
      digest: OBJECTIVE_PROFILE_DIGEST,
    },
    statistics: readStatistics(null),
    refusalCode: null,
  };
}

export interface SeededBuild {
  readonly configurationId: string;
  readonly buildRunId: string;
  readonly periodId: string;
  readonly versionId: string;
}

/**
 * One complete build per named group, populating all six tables 0018 creates.
 *
 * The candidate is deliberately made UNUSABLE by a synthetic `not-evaluable`
 * finding, so that `build_run_violations` has a row too and the run settles in
 * `failed` with the honest FAD-34 reason `rejected`. A seeder that produced a
 * clean build would leave the violations table empty and the sweep's own
 * non-vacuity check would fail it — which is the check working.
 */
export async function seedBuildLifecycleForSweep(
  runtime: PgUnitOfWorkRunner,
  targets: readonly BuildSweepTarget[],
): Promise<number> {
  let written = 0;

  for (const target of targets) {
    const actor = scheduleActor(target.userId);
    const context = {
      organizationId: target.organizationId,
      groupId: target.groupId,
      membershipId: target.membershipId,
      correlationId: `build-sweep-${target.label}`,
    };

    const seeded = await runtime.run(context, async (uow) => {
      const periodId = await createPeriod(uow, actor, {
        name: `Build fixture ${target.startDate}`,
        startDate: target.startDate,
        endDate: target.endDate,
      });
      await setRequirement(uow, actor, {
        periodId,
        date: target.startDate,
        shiftTypeId: target.shiftTypeId,
        requiredCount: 1,
      });
      const versionId = await createDraftVersion(uow, actor, periodId);

      const configurationId = await createConfiguration(uow, actor, {
        periodId,
        name: `Build fixture ${target.label}`,
        maxTimeSeconds: 5,
      });
      const created = await createRun(uow, actor, {
        configurationId,
        sourceVersionId: versionId,
        candidateLabel: `sweep-${target.label}`,
        idempotencyKey: `sweep.${target.label}`,
      });

      return { periodId, versionId, configurationId, buildRunId: created.buildRunId };
    });

    /* The snapshot the outcome is validated against. Assembled through the
     * production path so the document is a real one. */
    const document = await runtime.run(context, async (uow) => {
      const assembled = await assembleCanonicalInput(uow, {
        periodId: seeded.periodId,
        versionId: seeded.versionId,
        at: new Date(`${target.startDate}T12:00:00.000Z`),
      });
      return assembled.document;
    });

    await runtime.run(context, async (uow) => {
      const run = await loadRun(uow, seeded.buildRunId);
      if (run === null) throw new Error('the seeded build run vanished');
      const validating = await transitionRun(uow, run, 'validating', { reason: 'submitted' });
      const checking = await transitionRun(uow, validating, 'readiness_check', {
        reason: 'configuration_consistent',
      });
      await transitionRun(uow, checking, 'queued', { reason: 'ready' });
    });

    await runtime.run(context, async (uow) => {
      const claim = await claimQueuedBuild(uow, seeded.buildRunId, `sweep.${process.pid}.seed`);
      if (claim === null) throw new Error('the seeded build run could not be claimed');

      const configuration = await readConfiguration(uow, seeded.configurationId);
      if (configuration === null) throw new Error('the seeded configuration vanished');

      await persistOutcome(uow, {
        buildRunId: seeded.buildRunId,
        claimEpoch: claim.claimEpoch,
        document: document as SolverInputSnapshotDocument,
        outcome: syntheticOutcome(
          claim.run.canonical_input_hash ?? 'f'.repeat(64),
          target.membershipId,
          target.startDate,
          target.shiftTypeId,
        ),
        verdict: {
          usable: false,
          rejections: [
            {
              reason: 'hard-violation',
              findings: [
                {
                  finding: 'not-evaluable',
                  ruleKey: 'fixture.sweep.not-evaluable',
                  nodeKind: 'PatternRule',
                  field: 'rule',
                  explanation:
                    'a synthetic not-evaluable finding, so the sweep sees a violation row',
                },
              ],
            },
          ],
          findings: [
            {
              finding: 'not-evaluable',
              ruleKey: 'fixture.sweep.not-evaluable',
              nodeKind: 'PatternRule',
              field: 'rule',
              explanation:
                'a synthetic not-evaluable finding, so the sweep sees a violation row',
            },
          ],
          hardViolations: 0,
        },
        configuration,
      });
    });

    written += 1;
  }

  return written;
}

/* ────────────────────────────────────────────────────────────────────────────
 * A named fixture for the build proofs
 * ──────────────────────────────────────────────────────────────────────────── */

export interface SeedBuildFixtureInput {
  readonly organizationId: string;
  readonly groupId: string;
  readonly membershipId: string;
  readonly userId: string;
  readonly shiftTypeId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly label: string;
  readonly requiredCount?: number;
}

export interface BuildFixture {
  readonly periodId: string;
  readonly versionId: string;
  readonly configurationId: string;
  readonly context: {
    readonly organizationId: string;
    readonly groupId: string;
    readonly membershipId: string;
    readonly correlationId: string;
  };
}

/**
 * A period, a dated requirement, a draft version and a build configuration —
 * all through the production write path, exactly as `seedSolverFixture` does.
 */
export async function seedBuildFixture(
  runtime: PgUnitOfWorkRunner,
  input: SeedBuildFixtureInput,
): Promise<BuildFixture> {
  const actor = scheduleActor(input.userId);
  const context = {
    organizationId: input.organizationId,
    groupId: input.groupId,
    membershipId: input.membershipId,
    correlationId: `build-fixture-${input.label}`,
  };

  return runtime.run(context, async (uow) => {
    const periodId = await createPeriod(uow, actor, {
      name: `Build proof ${input.label} ${input.startDate}`,
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
    const configurationId = await createConfiguration(uow, actor, {
      periodId,
      name: `Configuration ${input.label}`,
      maxTimeSeconds: 5,
      heartbeatTimeoutMs: 1000,
    });
    return { periodId, versionId, configurationId, context };
  });
}
