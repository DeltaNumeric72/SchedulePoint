import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { solverInputSnapshotSchema, type BuildFinding } from '@schedulepoint/contracts';
import type {
  SolverInputSnapshotDocument,
  TenantContext,
  UnitOfWork,
  UnitOfWorkRunner,
} from '@schedulepoint/domain';
import type { Kysely } from 'kysely';

import type { BuildRunState, Database } from '../db/schema.js';
import { requireScheduleCapability, type ScheduleActor } from '../schedule/actions.js';
import { createBuildInput, dispatchBuild, validateBuildOutcome } from '../solver/build-input.js';
import { readSnapshot, SnapshotIdempotencyConflictError } from '../solver/snapshot-store.js';
import type { SolveOutcomeDetail } from '../solver/solver-client.js';
import {
  assertClaimIsCurrent,
  claimQueuedBuild,
  recordFencedResult,
  workerToken,
} from './claim.js';
import {
  BuildPreconditionError,
  BuildResultFencedError,
  BuildStateMovedError,
} from './errors.js';
import { configurationFindings, readinessFindings } from './readiness.js';
import {
  assertExpectedState,
  loadRun,
  loadRunForUpdate,
  parametersOf,
  readConfiguration,
  recordBuildEvent,
  transitionRun,
  type BuildRunRow,
  type ConfigurationRow,
} from './service.js';
import { classifyOutcome } from './states.js';

/**
 * **Submission, dispatch, and result persistence** (doc 35 §6e Required
 * behaviour 2 and 4).
 *
 * ## The seam, and why the functions here take a RUNNER
 *
 * Every other function in this module takes a unit of work. These take a
 * `UnitOfWorkRunner`, because a solve cannot happen inside a transaction:
 *
 * ```
 *   transaction 1  ── claim atomically, advance the epoch ──────────  COMMIT
 *   after run() has RETURNED  ── dispatch to the worker subprocess ──
 *   transaction 2  ── fence, then persist result + violations +
 *                     candidate + the state change, together ───────  COMMIT
 * ```
 *
 * SPEC-12 U-07, and the shape M4-001 established: `solveOnWorker`'s first
 * statement is `assertOutsideUnitOfWork('solver')` over an `AsyncLocalStorage`
 * mark that follows the async context past a commit, and
 * `scripts/gates/provider-boundary-check.mjs` fails the build if a name imported
 * from a `@provider-port` module appears inside a `runner.run(...)` callback.
 * Both bind this file. A ninety-second solve inside a transaction would hold a
 * pooled connection and the build row's lock for somebody else's network, and a
 * provider that succeeded inside a transaction that then rolled back would have
 * produced an external effect with no record of it.
 *
 * ## Why the result is ONE transaction
 *
 * doc 08 §4.1: "result + violations + quality metrics written in one
 * transaction". Two transactions would make a crash between them produce a build
 * that says `completed` and carries no findings — which reads as a clean build.
 */

type Uow = UnitOfWork<Kysely<Database>>;

/** Where the worker's watcher thread looks for the cancellation signal. */
export function cancelFilePath(buildRunId: string): string {
  return join(tmpdir(), 'schedulepoint-builds', `${buildRunId}.cancel`);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Submission — draft_configuration → validating → readiness_check → queued
 * ──────────────────────────────────────────────────────────────────────────── */

export interface SubmitResult {
  readonly state: BuildRunState;
  readonly validationFindings: readonly BuildFinding[];
  readonly readinessFindings: readonly BuildFinding[];
}

/**
 * The snapshot idempotency key for a build chain.
 *
 * A retry re-poses the SAME problem (SPEC-04 §2: "re-runnable from the same
 * pinned `solver_inputs` snapshot"), so every run in a retry chain shares one
 * key and therefore one snapshot and one `input_hash`. If the world has moved
 * since the root ran, `persistCanonicalInput` refuses the replay because the
 * semantic digest no longer matches — and that refusal is correct: a retry
 * against different inputs is a different build, not the same one again.
 */
async function chainRootId(uow: Uow, run: BuildRunRow): Promise<string> {
  let current = run;
  /* Bounded by the retry limit's own ceiling; the loop cannot outrun it because
   * `retry_attempt` strictly increases along the chain. */
  for (let hop = 0; hop < 16; hop += 1) {
    const parentId = current.retry_of_build_run_id;
    if (parentId === null) return current.id;
    const parent = await loadRun(uow, parentId);
    if (parent === null) return current.id;
    current = parent;
  }
  return current.id;
}

/**
 * **Submit a configured build.**
 *
 * Report 21 §4's two bounce edges are real outcomes here, not exceptions: a
 * configuration that is not internally consistent, or a period that is not
 * ready, returns to `draft_configuration` with the reasons ITEMISED on the row.
 * An unexplained bounce is what makes a scheduler resubmit the same
 * configuration until they give up.
 */
export async function submitBuild(
  runner: UnitOfWorkRunner<Kysely<Database>>,
  context: TenantContext,
  actor: ScheduleActor,
  buildRunId: string,
  expectedState: BuildRunState,
): Promise<SubmitResult> {
  /* ── transaction 1: take the submission edge ───────────────────────────── */
  const prepared = await runner.run(context, async (uow) => {
    await requireScheduleCapability(uow, actor, 'versionEdit');
    const run = await loadRunForUpdate(uow, buildRunId);
    if (run === null) {
      throw new BuildPreconditionError(
        'BUILD_RUN_NOT_FOUND',
        `no build run ${buildRunId} is visible in this group`,
      );
    }
    assertExpectedState(run, expectedState);
    const validating = await transitionRun(uow, run, 'validating', {
      reason: 'submitted',
      submittedAt: new Date(),
    });
    return {
      run: validating,
      snapshotKey: `build.${await chainRootId(uow, validating)}`,
    };
  });

  /* ── assembly: its own transaction, opened by `createBuildInput` ────────── */
  let document: SolverInputSnapshotDocument;
  let snapshotId: string;
  let canonicalInputHash: string;
  try {
    const persisted = await createBuildInput(runner, context, {
      periodId: prepared.run.period_id,
      versionId: prepared.run.source_version_id,
      at: new Date(),
      idempotencyKey: prepared.snapshotKey,
    });
    document = persisted.document;
    snapshotId = persisted.snapshotId;
    canonicalInputHash = persisted.canonicalInputHash;
  } catch (error) {
    const findings = assemblyFindings(error);
    return runner.run(context, async (uow) => {
      const run = await loadRunForUpdate(uow, buildRunId);
      if (run === null) throw error;
      await transitionRun(uow, run, 'draft_configuration', {
        reason: 'assembly_refused',
        validationFindings: findings,
        readinessFindings: [],
      });
      return {
        state: 'draft_configuration' as const,
        validationFindings: findings,
        readinessFindings: [],
      };
    });
  }

  /* ── transaction 2: validate, then check readiness, then queue ──────────── */
  return runner.run(context, async (uow) => {
    const run = await loadRunForUpdate(uow, buildRunId);
    if (run === null) {
      throw new BuildPreconditionError(
        'BUILD_RUN_NOT_FOUND',
        `no build run ${buildRunId} is visible in this group`,
      );
    }
    if (run.state !== 'validating') throw new BuildStateMovedError(run.state);

    const validation = configurationFindings(document);
    if (validation.length > 0) {
      await transitionRun(uow, run, 'draft_configuration', {
        reason: 'validation_failed',
        validationFindings: validation,
        readinessFindings: [],
      });
      return {
        state: 'draft_configuration' as const,
        validationFindings: validation,
        readinessFindings: [],
      };
    }

    /* The pinned problem is bound to the run BEFORE the readiness edge, so a
     * build that bounces still records which problem it was checked against. */
    await uow.query
      .updateTable('build_runs')
      .set({ snapshot_id: snapshotId, canonical_input_hash: canonicalInputHash })
      .where('id', '=', run.id)
      .execute();

    const checking = await transitionRun(uow, run, 'readiness_check', {
      reason: 'configuration_consistent',
      validationFindings: [],
    });

    const readiness = readinessFindings(document);
    if (readiness.length > 0) {
      await transitionRun(uow, checking, 'draft_configuration', {
        reason: 'readiness_failed',
        readinessFindings: readiness,
      });
      return {
        state: 'draft_configuration' as const,
        validationFindings: [],
        readinessFindings: readiness,
      };
    }

    await transitionRun(uow, checking, 'queued', {
      reason: 'ready',
      readinessFindings: [],
    });
    return { state: 'queued' as const, validationFindings: [], readinessFindings: [] };
  });
}

/**
 * Assembly refusals, itemised.
 *
 * `assembleCanonicalInput` throws a `SnapshotRefusedError` carrying EVERY
 * refusal rather than the first — that is the shape M4-001 built, and it is what
 * makes this list worth showing. The error type is not exported from the solver
 * module, so the refusals are read structurally; a shape that does not match
 * produces one honest finding rather than a swallowed error.
 */
function assemblyFindings(error: unknown): readonly BuildFinding[] {
  if (error instanceof SnapshotIdempotencyConflictError) {
    return [
      {
        code: 'snapshot_inputs_moved',
        tier: 'assembly',
        date: null,
        shiftTypeId: null,
        detail:
          'this build chain is pinned to an earlier canonical input and the inputs have ' +
          'since changed; a retry against different inputs is a new build, not the same one',
      },
    ];
  }
  const refusals = (error as { refusals?: unknown }).refusals;
  if (Array.isArray(refusals)) {
    return refusals.slice(0, 200).map((refusal) => {
      const entry = refusal as { kind?: unknown; subject?: unknown; detail?: unknown };
      return {
        code: normaliseCode(typeof entry.kind === 'string' ? entry.kind : 'assembly_refused'),
        tier: 'assembly' as const,
        date: null,
        shiftTypeId: null,
        detail: [
          typeof entry.subject === 'string' ? entry.subject : null,
          typeof entry.detail === 'string' ? entry.detail : null,
        ]
          .filter((part): part is string => part !== null)
          .join(' — ')
          .slice(0, 2000) || 'the canonical input could not be assembled',
      };
    });
  }
  return [
    {
      code: 'assembly_refused',
      tier: 'assembly',
      date: null,
      shiftTypeId: null,
      detail: 'the canonical input for this period could not be assembled',
    },
  ];
}

function normaliseCode(value: string): string {
  const code = value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'assembly_refused';
}

/* ────────────────────────────────────────────────────────────────────────────
 * Dispatch
 * ──────────────────────────────────────────────────────────────────────────── */

export interface RunBuildOptions {
  /** Stub-solver selector, for tests that must not spend a real solve. */
  readonly stubBehaviour?: 'candidate' | 'dwell' | 'wedged';
  readonly stubDwellMs?: number;
  /** Overrides the configuration's wall clock. Tests only. */
  readonly timeoutMs?: number;
}

export interface RunBuildResult {
  readonly state: BuildRunState;
  readonly claimEpoch: number;
  readonly outcome: SolveOutcomeDetail;
}

/**
 * **Claim, solve, and record.**
 *
 * Returns `null` when the build was not claimable — somebody else took it, or it
 * is no longer queued. `null` rather than an exception because losing a claim
 * race is a normal outcome of concurrency, not a fault.
 */
export async function runQueuedBuild(
  runner: UnitOfWorkRunner<Kysely<Database>>,
  context: TenantContext,
  buildRunId: string,
  options: RunBuildOptions = {},
): Promise<RunBuildResult | null> {
  /* ── transaction 1: claim ───────────────────────────────────────────────── */
  const claimed = await runner.run(context, async (uow) => {
    const claim = await claimQueuedBuild(uow, buildRunId, workerToken());
    if (claim === null) return null;

    const configuration = await readConfiguration(uow, claim.run.build_configuration_id);
    if (configuration === null) {
      throw new BuildPreconditionError(
        'BUILD_CONFIGURATION_NOT_FOUND',
        'the configuration this build names is no longer visible',
      );
    }
    if (claim.run.snapshot_id === null) {
      throw new BuildPreconditionError(
        'BUILD_SNAPSHOT_MISSING',
        'a queued build carries a pinned canonical input; this one does not',
      );
    }
    const stored = await readSnapshot(uow, claim.run.snapshot_id);
    if (stored === null) {
      throw new BuildPreconditionError(
        'BUILD_SNAPSHOT_MISSING',
        'the pinned canonical input of this build is not visible',
      );
    }
    /* Parsed on the way out of the database rather than cast. The row was
     * written by the assembly and is immutable, but a parse is what makes that
     * a checked fact instead of a belief about history. */
    const document = solverInputSnapshotSchema.parse(
      stored.payload,
    ) as unknown as SolverInputSnapshotDocument;

    /* The parameters and the runtime provenance are recorded on the run at claim
     * time, so a build that then crashes still says what it was run with. */
    await uow.query
      .updateTable('build_runs')
      .set({
        solver_parameters: JSON.stringify(parametersOf(configuration)),
        random_seed: configuration.random_seed,
        deterministic_worker_count: configuration.num_search_workers,
      })
      .where('id', '=', claim.run.id)
      .execute();

    return {
      run: claim.run,
      claimEpoch: claim.claimEpoch,
      configuration,
      snapshotId: stored.snapshotId,
      canonicalInputHash: stored.canonicalInputHash,
      document,
    };
  });

  if (claimed === null) return null;

  /* ── the provider call, after the commit ────────────────────────────────── */
  const cancelFile = cancelFilePath(buildRunId);
  mkdirSync(join(tmpdir(), 'schedulepoint-builds'), { recursive: true });

  const outcome = await dispatchBuild(
    context,
    {
      snapshotId: claimed.snapshotId,
      canonicalInputHash: claimed.canonicalInputHash,
      document: claimed.document,
      replayed: false,
    },
    {
      buildRunId,
      parameters: parametersOf(claimed.configuration),
      cancelFile,
      timeoutMs: options.timeoutMs ?? claimed.configuration.dispatch_timeout_ms,
      ...(options.stubBehaviour === undefined ? {} : { stubBehaviour: options.stubBehaviour }),
      ...(options.stubDwellMs === undefined ? {} : { stubDwellMs: options.stubDwellMs }),
    },
  );

  /* The signal file is the worker's channel and nothing else's; it is removed
   * once the solve it belonged to has returned, so a later claim of the same
   * build does not inherit a cancellation nobody asked for. */
  rmSync(cancelFile, { force: true });

  const verdict = validateBuildOutcome({
    snapshot: {
      snapshotId: claimed.snapshotId,
      canonicalInputHash: claimed.canonicalInputHash,
      document: claimed.document,
      replayed: false,
    },
    outcome,
    reproducibility: 'best-effort',
  });

  /* ── transaction 2: fence, then persist everything together ─────────────── */
  const state = await recordSolveOutcome(runner, context, {
    buildRunId,
    claimEpoch: claimed.claimEpoch,
    document: claimed.document,
    outcome,
    verdict,
    configuration: claimed.configuration,
  });

  return { state, claimEpoch: claimed.claimEpoch, outcome };
}

/**
 * **The result-writing path, fence and record together.**
 *
 * `persistOutcome` refuses a stale claim by throwing, which rolls its own
 * transaction back — so the refusal cannot be recorded inside it. This is the
 * one place that sequences the two: refuse, let the transaction go, then open a
 * second one and write the `result_refused` row. Every result-bearing path goes
 * through here, so no caller can take the fence without also taking the record.
 */
export async function recordSolveOutcome(
  runner: UnitOfWorkRunner<Kysely<Database>>,
  context: TenantContext,
  input: PersistOutcomeInput,
): Promise<BuildRunState> {
  try {
    return await runner.run(context, async (uow) => persistOutcome(uow, input));
  } catch (error) {
    if (!(error instanceof BuildResultFencedError)) throw error;
    await runner.run(context, async (uow) => {
      const run = await loadRun(uow, input.buildRunId);
      await recordFencedResult(uow, {
        buildRunId: input.buildRunId,
        presentedEpoch: error.presentedEpoch,
        currentEpoch: error.currentEpoch,
        state: run?.state ?? 'unknown',
      });
    });
    throw error;
  }
}

export interface PersistOutcomeInput {
  readonly buildRunId: string;
  readonly claimEpoch: number;
  readonly document: SolverInputSnapshotDocument;
  readonly outcome: SolveOutcomeDetail;
  readonly verdict: ReturnType<typeof validateBuildOutcome>;
  readonly configuration: ConfigurationRow;
}

/**
 * **One transaction: result, violations, candidate, and the state change.**
 *
 * The order inside it is load-bearing. The fencing trigger requires the run to
 * still be `running` at its current epoch, so every result-bearing row goes in
 * BEFORE the transition that ends the run. Writing the state first would fence
 * the very rows the state is about.
 */
export async function persistOutcome(uow: Uow, input: PersistOutcomeInput): Promise<BuildRunState> {
  const run = await assertClaimIsCurrent(uow, input.buildRunId, input.claimEpoch);
  const tenant = {
    organization_id: run.organization_id,
    group_id: run.group_id,
  };

  const classified = classifyOutcome({
    outcome: input.outcome,
    usable: input.verdict === null ? null : input.verdict.usable,
  });

  const assignments = input.outcome.assignments ?? [];
  const findings = input.verdict?.findings ?? [];

  /* ── violations: every independently measured HARD finding, both kinds ──── */
  for (const finding of findings) {
    await uow.query
      .insertInto('build_run_violations')
      .values({
        ...tenant,
        build_run_id: run.id,
        claim_epoch: input.claimEpoch,
        finding: finding.finding,
        rule_key: finding.ruleKey.slice(0, 200),
        node_kind: finding.nodeKind.slice(0, 100),
        field: finding.field.slice(0, 200),
        explanation: finding.explanation.slice(0, 2000),
      })
      .execute();
  }

  /* ── the candidate, with R-8's pick positions carried through ───────────── */
  const pinned = pinnedIdentitiesOf(input.document);
  const pickPositions = await pickPositionsFor(uow, run.source_version_id, [...pinned.keys()]);

  let ordinal = 0;
  for (const assignment of assignments) {
    const identityKey = `${assignment.membershipId}|${assignment.date}|${assignment.shiftTypeId}`;
    const mirrored = pinned.get(identityKey) ?? null;
    await uow.query
      .insertInto('build_run_candidate_assignments')
      .values({
        ...tenant,
        build_run_id: run.id,
        claim_epoch: input.claimEpoch,
        ordinal,
        membership_id: assignment.membershipId,
        date: assignment.date,
        shift_type_id: assignment.shiftTypeId,
        location_id: assignment.locationId,
        mirrors_assignment_identity_id: mirrored?.assignmentIdentityId ?? null,
        mirrors_pinned: mirrored?.isPinned ?? false,
        pick_position:
          mirrored === null ? null : (pickPositions.get(mirrored.assignmentIdentityId) ?? null),
      })
      .execute();
    ordinal += 1;
  }

  /* ── the result ─────────────────────────────────────────────────────────── */
  const quality = qualityMetricsOf(input.document, assignments.length, input.outcome);
  await uow.query
    .insertInto('build_run_results')
    .values({
      ...tenant,
      build_run_id: run.id,
      claim_epoch: input.claimEpoch,
      solver_status: input.outcome.status,
      termination_reason: classified.terminationReason,
      reported_input_hash: input.outcome.canonicalInputHash,
      usable: input.verdict !== null && input.verdict.usable,
      hard_violations: input.verdict?.hardViolations ?? 0,
      assignment_count: assignments.length,
      candidate_returned: input.outcome.assignments !== null,
      objective_value:
        input.outcome.objectiveValue === null ? null : String(input.outcome.objectiveValue),
      quality_metrics: JSON.stringify(quality),
      objective_tiers: JSON.stringify(input.outcome.objectiveTiers),
      explanation_state: input.outcome.explanation?.state ?? null,
      explanation: JSON.stringify({
        structural: input.outcome.explanation?.structural ?? [],
        conflictingRuleKeys: input.outcome.explanation?.conflictingRuleKeys ?? [],
        refusalCode: input.outcome.refusalCode,
      }),
      rejections: JSON.stringify(
        (input.verdict?.rejections ?? []).map((rejection) => ({
          reason: rejection.reason,
          detail:
            'detail' in rejection
              ? rejection.detail
              : `${String(rejection.findings.length)} independently measured hard finding(s)`,
        })),
      ),
      elapsed_ms: input.outcome.elapsedMs,
    })
    .execute();

  /* ── and only now, the state ────────────────────────────────────────────── */
  await transitionRun(uow, run, classified.state, {
    terminationReason: classified.terminationReason,
    solverStatus: classified.solverStatus,
    reason: 'solve_returned',
    finishedAt: new Date(),
  });

  return classified.state;
}

interface MirroredFixedInput {
  readonly assignmentIdentityId: string;
  readonly isPinned: boolean;
}

/** Candidate row → the fixed input it mirrors, keyed the way the checker keys it. */
function pinnedIdentitiesOf(
  document: SolverInputSnapshotDocument,
): ReadonlyMap<string, MirroredFixedInput> {
  const map = new Map<string, MirroredFixedInput>();
  for (const fixed of document.fixedAssignments) {
    map.set(`${fixed.membershipId}|${fixed.date}|${fixed.shiftTypeId}`, {
      assignmentIdentityId: fixed.assignmentIdentityId,
      isPinned: fixed.isPinned,
    });
  }
  return map;
}

/**
 * **R-8, executed.**
 *
 * RK-RULING-04 rules that a solver-produced assignment has NO pick position and
 * that a NULL one satisfies `PickPositionRestriction` vacuously — which is
 * correct for a row the solver chose. It is NOT correct for a row that mirrors a
 * PINNED fixed input: that assignment already has a pick position, recorded on
 * the source version's snapshot row, and flattening it to NULL when the
 * candidate is selected would silently drop a real attribute of a real
 * assignment. The canonical snapshot does not carry `pick_position` (it is not a
 * solver input), so it is read here, from the version the build was posed
 * against, at the moment the candidate is recorded.
 */
async function pickPositionsFor(
  uow: Uow,
  sourceVersionId: string,
  keys: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  if (keys.length === 0) return new Map();
  const rows = await uow.query
    .selectFrom('assignment_snapshots')
    .select(['assignment_identity_id', 'pick_position'])
    .where('version_id', '=', sourceVersionId)
    .where('status', '=', 'active')
    .execute();

  const map = new Map<string, number>();
  for (const row of rows) {
    if (row.pick_position !== null) map.set(row.assignment_identity_id, row.pick_position);
  }
  return map;
}

/**
 * SPEC-04 §7's measurable metrics.
 *
 * Counts and ratios only. Every band except `hard_violations = 0` is undefined
 * until the benchmark corpus is run, so nothing here carries a threshold, a
 * rating, or a verdict — a number with an invented band attached is worse than
 * no number, because it looks actionable.
 */
function qualityMetricsOf(
  document: SolverInputSnapshotDocument,
  assignmentCount: number,
  outcome: SolveOutcomeDetail,
): Record<string, number | null> {
  let requiredSlots = 0;
  for (const cell of document.demand) {
    if (cell.source !== 'period-requirement') continue;
    if (!Number.isInteger(cell.requiredCount)) continue;
    if (cell.requiredCount > 0) requiredSlots += cell.requiredCount;
  }
  const filledSlots = Math.min(assignmentCount, requiredSlots);
  return {
    demandSatisfactionRate: requiredSlots === 0 ? null : filledSlots / requiredSlots,
    requiredSlots,
    filledSlots,
    hardViolations: 0,
    softPenaltyTotal: outcome.objectiveValue,
    solveWallClockMs: outcome.elapsedMs,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Cancellation
 * ──────────────────────────────────────────────────────────────────────────── */

export interface CancelResult {
  readonly state: BuildRunState;
  /** `true` when the state moved now; `false` when a running solve was signalled. */
  readonly immediate: boolean;
}

/**
 * **Cancel a build, honestly.**
 *
 * Two shapes, because there are genuinely two situations:
 *
 *  * **`queued`** — nothing is running. The state moves now, with
 *    `termination_reason = 'user_cancelled'`;
 *  * **`running`** — a solve is in progress in a subprocess. The cancellation is
 *    REQUESTED through the shipped file channel (SPEC-04 §2 mechanism 2, the
 *    watcher thread; never a signal), and the state moves when the solve
 *    actually stops and reports `CANCELLED`. Moving it now would be a claim the
 *    system has not yet earned — and would make a solve that then completed
 *    normally look cancelled.
 *
 * The request is recorded either way, so "the user asked at 14:02 and the solve
 * stopped at 14:02:06" is answerable.
 */
export async function requestCancellation(
  uow: Uow,
  actor: ScheduleActor,
  buildRunId: string,
  expectedState: BuildRunState,
): Promise<CancelResult> {
  await requireScheduleCapability(uow, actor, 'versionEdit');
  const run = await loadRunForUpdate(uow, buildRunId);
  if (run === null) {
    throw new BuildPreconditionError(
      'BUILD_RUN_NOT_FOUND',
      `no build run ${buildRunId} is visible in this group`,
    );
  }
  assertExpectedState(run, expectedState);

  if (run.state === 'queued') {
    await recordBuildEvent(uow, {
      buildRunId,
      kind: 'cancel_requested',
      claimEpoch: run.claim_epoch,
      reason: 'scheduler_cancelled',
    });
    await transitionRun(uow, run, 'cancelled', {
      terminationReason: 'user_cancelled',
      solverStatus: 'CANCELLED',
      reason: 'scheduler_cancelled',
      finishedAt: new Date(),
    });
    return { state: 'cancelled', immediate: true };
  }

  if (run.state !== 'running') {
    throw new BuildPreconditionError(
      'BUILD_NOT_CANCELLABLE',
      'only a queued or running build can be cancelled',
    );
  }

  await recordBuildEvent(uow, {
    buildRunId,
    kind: 'cancel_requested',
    claimEpoch: run.claim_epoch,
    reason: 'scheduler_cancelled',
  });

  /* The signal is written AFTER the record, so a crash between them leaves a
   * recorded request with no signal (which a scheduler can retry) rather than a
   * signal with no record (which nobody could explain). */
  const path = cancelFilePath(buildRunId);
  mkdirSync(join(tmpdir(), 'schedulepoint-builds'), { recursive: true });
  writeFileSync(path, `${String(run.claim_epoch)}\n`, 'utf8');

  return { state: 'running', immediate: false };
}
