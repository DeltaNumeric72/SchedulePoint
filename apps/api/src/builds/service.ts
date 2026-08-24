import { createHash, randomUUID } from 'node:crypto';

import type { BuildFinding } from '@schedulepoint/contracts';
import {
  SOLVER_STATUSES,
  TERMINATION_REASONS,
  reproducibilityMode,
  resultReproducibility,
  type AuditEventName,
  type ResultReproducibilityVerdict,
  type SolverParameters,
  type TenantContext,
  type UnitOfWork,
} from '@schedulepoint/domain';
import type { Kysely } from 'kysely';

import { recordAuditEvent } from '../audit/recorder.js';
import type { BuildRunState, BuildRunsTable, Database } from '../db/schema.js';
import { requireScheduleCapability, type ScheduleActor } from '../schedule/actions.js';
import { materialInputDigest } from '../schedule/review-identity.js';
import {
  BuildIdempotencyConflictError,
  BuildPreconditionError,
  BuildRetryLimitError,
  BuildStateMovedError,
  BuildTransitionError,
} from './errors.js';
import { COMPLETED_FAMILY_STATES, isLegalTransition, SETTLED_STATES } from './states.js';

/**
 * The build lifecycle's domain service (OPUS-M4-003; report 21 §4, SPEC-04).
 *
 * ## Automated scheduling is the production mechanism (I-05)
 *
 * Everything here is the automated path. The manual services in
 * `apps/api/src/schedule/**` exist for override, recovery and fixed-assignment
 * input; this module is what actually produces a schedule. The two meet in
 * exactly one place — `selection.ts`, where a validated candidate becomes a NEW
 * draft version through the manual module's own draft services — and they meet
 * there rather than anywhere else on purpose.
 *
 * ## Every function takes a unit of work and none opens one
 *
 * I-15, non-bypass rule 1 — the same rule the schedule module states. The one
 * apparent exception is `runner.ts`, which takes a **runner** because the solver
 * dispatch must happen after a commit; it opens two transactions with the
 * provider call between them, and it is the only place in this module that can.
 *
 * ## Ordering: evaluate → deny → mutate → audit LAST (FAD-12, FAD-37(2))
 *
 * Every mutator below checks the capability first and writes its
 * `build_run_events` row after the state change. FAD-37(2)'s rule that the audit
 * lock is taken last by every writer is honoured because this module takes NO
 * lock ordered against qualification rows at all: the only row-level lock it
 * takes is `FOR UPDATE` on the `build_runs` row itself, which nothing in the
 * staffing path touches.
 *
 * ## Two records, and they are not the same record
 *
 * Every transition writes BOTH:
 *
 *  * a `build_run_events` row — append-only, tenant-scoped, carrying the from/to
 *    states, the claim epoch and the actor. This is the build's own TIMELINE,
 *    which the scheduler's screen reads, and it carries things the chain
 *    deliberately does not: a fenced worker's refused epoch, a reap. It is not
 *    the audit chain and never claims to be;
 *  * an `audit_events` row through `recordAuditEvent` — the ADR-0019 chain,
 *    under the `build_run` subject and the six `build.*` names FAD-44(2)
 *    granted. Written LAST by every mutator, per FAD-37(2).
 *
 * `recordBuildEvent` writes both, in that order, so no writer can take one
 * without the other. Which chain name a transition maps to is decided once, in
 * `auditNameFor`, rather than at fourteen call sites.
 */

type Uow = UnitOfWork<Kysely<Database>>;

function tenantOf(context: TenantContext): { organization_id: string; group_id: string } {
  const { organizationId, groupId } = context;
  if (groupId === null) {
    throw new Error(
      'BUILD_REQUIRES_GROUP_CONTEXT: a build statement was reached under an ' +
        'organization-scoped unit of work',
    );
  }
  return { organization_id: organizationId, group_id: groupId };
}

export type BuildRunRow = {
  readonly [K in keyof BuildRunsTable]: BuildRunsTable[K] extends { __select__: infer S }
    ? S
    : BuildRunsTable[K];
};

/** The columns every read of a run needs. Selected explicitly, never `*`. */
export async function loadRun(uow: Uow, buildRunId: string): Promise<BuildRunRow | null> {
  const row = await uow.query
    .selectFrom('build_runs')
    .selectAll()
    .where('id', '=', buildRunId)
    .executeTakeFirst();
  return (row as BuildRunRow | undefined) ?? null;
}

/** As {@link loadRun}, but takes the row lock the transition will need. */
export async function loadRunForUpdate(
  uow: Uow,
  buildRunId: string,
): Promise<BuildRunRow | null> {
  const row = await uow.query
    .selectFrom('build_runs')
    .selectAll()
    .where('id', '=', buildRunId)
    .forUpdate()
    .executeTakeFirst();
  return (row as BuildRunRow | undefined) ?? null;
}

export interface RecordEventInput {
  readonly buildRunId: string;
  readonly kind: 'transition' | 'result_refused' | 'heartbeat_reaped' | 'claim' | 'cancel_requested';
  readonly fromState?: BuildRunState | null;
  readonly toState?: BuildRunState | null;
  readonly claimEpoch: number;
  readonly currentClaimEpoch?: number | null;
  /** A CODE from a closed vocabulary. Never operator free text (I-07). */
  readonly reason?: string | null;
  readonly detail?: Record<string, string | number | boolean | null>;
  readonly actorMembershipId?: string | null;
}

/**
 * **Which chain name a build event carries** (FAD-44(2)).
 *
 * Decided in ONE place, so the two moments a human takes responsibility —
 * cancelling, and approving — cannot drift into the generic name at one call
 * site while staying distinct at another. `null` means "timeline only": a
 * heartbeat reap and a fenced result are facts about a WORKER, and the chain
 * records what happened to the aggregate.
 */
export function auditNameFor(input: RecordEventInput): AuditEventName | null {
  if (input.kind === 'cancel_requested') return 'build.run.cancelled';
  if (input.kind !== 'transition') return null;
  if (input.fromState === null || input.fromState === undefined) return 'build.run.created';
  switch (input.toState) {
    case 'validating':
      return 'build.run.submitted';
    case 'cancelled':
      return 'build.run.cancelled';
    case 'approved':
      return 'build.run.approved';
    case 'applied_to_draft_schedule':
      return 'build.run.applied';
    default:
      return 'build.run.state_changed';
  }
}

/**
 * The build's timeline row AND its chain entry.
 *
 * Called by every writer in this module, after the mutation — which is where the
 * chain write belongs (FAD-12's evaluate → deny → mutate → audit, and FAD-37(2)'s
 * rule that the audit lock is taken LAST). The two writes are here together so
 * that no path can take one without the other.
 *
 * The payload is identifiers and closed-vocabulary tokens only: states, a claim
 * epoch, a reason CODE. Never operator free text, never a worker token (I-07).
 */
export async function recordBuildEvent(uow: Uow, input: RecordEventInput): Promise<void> {
  /* ── who acted, resolved ONCE (OPUS-M4-005) ────────────────────────────────
   *
   * `undefined` means "whoever this unit of work is for"; explicit `null` means
   * "no human, and I mean it". Since D-4b moved dispatch onto the queue there is
   * a third case that used to be unreachable: a unit of work opened by the
   * WORKER, whose context legitimately names no membership.
   *
   * That case previously threw `AUDIT_ACTOR_UNRESOLVED` — the recorder refusing
   * to attribute an event to nobody, which is right — and the claim would have
   * been unrecordable on the queued path. It is resolved here rather than at
   * each call site: the resolved actor is computed once and the system-actor
   * marker is derived FROM IT, so "the timeline says nobody" and "the chain says
   * membership" can no longer disagree. A worker claiming a build IS a system
   * act, which is exactly what the docblock below already said about the reaper
   * and the claim — the claim simply never said it. */
  const actorMembershipId = input.actorMembershipId ?? uow.context.membershipId;

  await uow.query
    .insertInto('build_run_events')
    .values({
      id: randomUUID(),
      ...tenantOf(uow.context),
      build_run_id: input.buildRunId,
      kind: input.kind,
      from_state: input.fromState ?? null,
      to_state: input.toState ?? null,
      claim_epoch: input.claimEpoch,
      current_claim_epoch: input.currentClaimEpoch ?? null,
      reason: input.reason ?? null,
      detail: JSON.stringify(input.detail ?? {}),
      actor_membership_id: actorMembershipId,
    })
    .execute();

  const eventName = auditNameFor(input);
  if (eventName === null) return;

  await recordAuditEvent(uow, {
    eventName,
    subjectType: 'build_run',
    subjectId: input.buildRunId,
    payload: {
      from: input.fromState ?? 'none',
      to: input.toState ?? 'none',
      epoch: input.claimEpoch,
      ...(input.reason === null || input.reason === undefined ? {} : { reason: input.reason }),
    },
    /* The reaper and the claim are system acts and say so. "Nobody was acting"
     * and "we failed to resolve who was acting" must not look the same in an
     * audit trail, which is what the explicit marker is for. */
    ...(actorMembershipId === null ? { systemActor: true } : {}),
  });
}

export interface TransitionOptions {
  readonly terminationReason?: string | null;
  readonly solverStatus?: string | null;
  readonly reason?: string | null;
  readonly validationFindings?: readonly BuildFinding[];
  readonly readinessFindings?: readonly BuildFinding[];
  readonly appliedToVersionId?: string | null;
  readonly supersededByBuildRunId?: string | null;
  readonly finishedAt?: Date | null;
  readonly startedAt?: Date | null;
  readonly submittedAt?: Date | null;
}

/**
 * **The one place a build's state changes.**
 *
 * The legality check here is the readable half; migration 0018's
 * `app_guard_build_run_transition` is the control and refuses the same edge for
 * every writer including a psql session. Removing this check would change the
 * error message and nothing else, which is what
 * `transition-matrix.test.ts`'s raw-SQL arm proves.
 */
export async function transitionRun(
  uow: Uow,
  run: BuildRunRow,
  to: BuildRunState,
  options: TransitionOptions = {},
): Promise<BuildRunRow> {
  const from = run.state;
  if (!isLegalTransition(from, to)) throw new BuildTransitionError(from, to);

  const patch: Record<string, unknown> = { state: to };
  if (options.terminationReason !== undefined) {
    patch['termination_reason'] = options.terminationReason;
  }
  if (options.solverStatus !== undefined) patch['solver_status'] = options.solverStatus;
  if (options.validationFindings !== undefined) {
    patch['validation_findings'] = JSON.stringify(options.validationFindings);
  }
  if (options.readinessFindings !== undefined) {
    patch['readiness_findings'] = JSON.stringify(options.readinessFindings);
  }
  if (options.appliedToVersionId !== undefined) {
    patch['applied_to_version_id'] = options.appliedToVersionId;
    patch['applied_at'] = options.appliedToVersionId === null ? null : new Date();
  }
  if (options.supersededByBuildRunId !== undefined) {
    patch['superseded_by_build_run_id'] = options.supersededByBuildRunId;
  }
  if (options.submittedAt !== undefined) patch['submitted_at'] = options.submittedAt;
  if (options.startedAt !== undefined) patch['started_at'] = options.startedAt;
  if (options.finishedAt !== undefined) patch['finished_at'] = options.finishedAt;

  const updated = await uow.query
    .updateTable('build_runs')
    .set(patch as never)
    .where('id', '=', run.id)
    .where('state', '=', from)
    .returningAll()
    .executeTakeFirst();

  /* The `where state = from` is the compare-and-set. A row that moved between
   * the read and this statement updates nothing, and reporting that as success
   * would be the lost-update the CAS exists to prevent. */
  if (updated === undefined) {
    const current = await loadRun(uow, run.id);
    throw new BuildStateMovedError(current?.state ?? from);
  }

  await recordBuildEvent(uow, {
    buildRunId: run.id,
    kind: 'transition',
    fromState: from,
    toState: to,
    claimEpoch: run.claim_epoch,
    reason: options.reason ?? null,
  });

  return updated as unknown as BuildRunRow;
}

/** Refuses when the caller's belief about the state is stale. */
export function assertExpectedState(run: BuildRunRow, expected: BuildRunState): void {
  if (run.state !== expected) throw new BuildStateMovedError(run.state);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Configurations
 * ──────────────────────────────────────────────────────────────────────────── */

export interface CreateConfigurationInput {
  readonly periodId: string;
  readonly name: string;
  readonly randomSeed?: number;
  readonly numSearchWorkers?: number;
  readonly maxTimeSeconds?: number;
  readonly maxDeterministicTime?: number | null;
  readonly interleaveSearch?: boolean;
  readonly dispatchTimeoutMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly retryLimit?: number;
}

export async function createConfiguration(
  uow: Uow,
  actor: ScheduleActor,
  input: CreateConfigurationInput,
): Promise<string> {
  await requireScheduleCapability(uow, actor, 'versionEdit');

  const id = randomUUID();
  await uow.query
    .insertInto('build_configurations')
    .values({
      id,
      ...tenantOf(uow.context),
      period_id: input.periodId,
      name: input.name,
      ...(input.randomSeed === undefined ? {} : { random_seed: input.randomSeed }),
      ...(input.numSearchWorkers === undefined
        ? {}
        : { num_search_workers: input.numSearchWorkers }),
      max_time_seconds: String(input.maxTimeSeconds ?? 10),
      max_deterministic_time:
        input.maxDeterministicTime === undefined || input.maxDeterministicTime === null
          ? null
          : String(input.maxDeterministicTime),
      ...(input.interleaveSearch === undefined
        ? {}
        : { interleave_search: input.interleaveSearch }),
      ...(input.dispatchTimeoutMs === undefined
        ? {}
        : { dispatch_timeout_ms: input.dispatchTimeoutMs }),
      ...(input.heartbeatTimeoutMs === undefined
        ? {}
        : { heartbeat_timeout_ms: input.heartbeatTimeoutMs }),
      ...(input.retryLimit === undefined ? {} : { retry_limit: input.retryLimit }),
      created_by: uow.context.membershipId,
    })
    .execute();
  return id;
}

export interface ConfigurationRow {
  readonly id: string;
  readonly period_id: string;
  readonly name: string;
  readonly random_seed: number;
  readonly num_search_workers: number;
  readonly max_time_seconds: string;
  readonly max_deterministic_time: string | null;
  readonly interleave_search: boolean;
  readonly dispatch_timeout_ms: number;
  readonly heartbeat_timeout_ms: number;
  readonly retry_limit: number;
}

export async function readConfiguration(
  uow: Uow,
  configurationId: string,
): Promise<ConfigurationRow | null> {
  const row = await uow.query
    .selectFrom('build_configurations')
    .select([
      'id',
      'period_id',
      'name',
      'random_seed',
      'num_search_workers',
      'max_time_seconds',
      'max_deterministic_time',
      'interleave_search',
      'dispatch_timeout_ms',
      'heartbeat_timeout_ms',
      'retry_limit',
    ])
    .where('id', '=', configurationId)
    .executeTakeFirst();
  return (row as ConfigurationRow | undefined) ?? null;
}

export async function listConfigurations(
  uow: Uow,
  periodId: string,
): Promise<readonly ConfigurationRow[]> {
  const rows = await uow.query
    .selectFrom('build_configurations')
    .select([
      'id',
      'period_id',
      'name',
      'random_seed',
      'num_search_workers',
      'max_time_seconds',
      'max_deterministic_time',
      'interleave_search',
      'dispatch_timeout_ms',
      'heartbeat_timeout_ms',
      'retry_limit',
    ])
    .where('period_id', '=', periodId)
    .orderBy('created_at', 'desc')
    .execute();
  return rows as readonly ConfigurationRow[];
}

/** SPEC-04 §4's parameters, read from the configuration rather than defaulted. */
export function parametersOf(configuration: ConfigurationRow): SolverParameters {
  return {
    randomSeed: configuration.random_seed,
    numSearchWorkers: configuration.num_search_workers,
    maxTimeInSeconds: Number(configuration.max_time_seconds),
    maxDeterministicTime:
      configuration.max_deterministic_time === null
        ? null
        : Number(configuration.max_deterministic_time),
    interleaveSearch: configuration.interleave_search,
  };
}

export function configurationReproducibility(
  configuration: ConfigurationRow,
): 'deterministic' | 'best-effort' {
  return reproducibilityMode(parametersOf(configuration));
}

/**
 * The RESULT-side reproducibility verdict for a finished run (FAD-49).
 *
 * Both halves come off rows this schema already carries, which is why FAD-49
 * could rule this a derivation rather than a migration:
 *
 *   * `build_runs.solver_parameters` — the FULL dispatched parameter set,
 *     written at CLAIM time precisely so "a build that then crashes still says
 *     what it was run with" (`runner.ts`), so both budgets are here;
 *   * `build_run_results.quality_metrics.solverStatistics.wallTimeSeconds` and
 *     `…solverStatistics.deterministicTimeUnits` — what the search actually
 *     spent on each clock, both already read back by `qualityOf`.
 *
 * Returns `null` for a run that has not produced a runtime record yet, matching
 * the nullability the detail surface already handles: before a solve there is
 * nothing to be honest or dishonest about.
 *
 * ## Why the statistics arrive as an OBJECT (FAD-52)
 *
 * This took `wallTimeSeconds` as a bare positional. The units-aware branch needs
 * a second `number | null` beside it, and two adjacent nullable numbers are a
 * transposition waiting to happen — one that would compile, pass every type
 * check, and report a run's search time as its deterministic cost. Named fields
 * make the swap impossible to write, and make every call site state both facts.
 */
export function runResultReproducibility(
  run: {
    readonly solver_parameters: unknown;
    readonly reproducibility_mode: string | null;
    /** FAD-50 B-1: what ENDED the run. Written by `transitionRun` on the same row. */
    readonly termination_reason: string | null;
    readonly solver_status: string | null;
  },
  statistics: {
    readonly wallTimeSeconds: number | null;
    /** FAD-52: how much SEARCH the run did, machine-independently. */
    readonly deterministicTimeUnits: number | null;
  },
): ResultReproducibilityVerdict | null {
  if (run.reproducibility_mode === null) return null;

  /* Parsed defensively rather than cast. The column is written by the claim and
   * is well-formed for every run this code path can reach, but a verdict that
   * fails OPEN on a malformed bag would be claiming reproducibility from a row
   * it could not read — the exact shape of the defect this function exists to
   * remove. An unreadable parameter set is `unrecorded`. */
  const raw = (run.solver_parameters ?? {}) as Record<string, unknown>;
  const number = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

  const maxTimeInSeconds = number(raw['maxTimeInSeconds']);
  const interleaveSearch = raw['interleaveSearch'];
  if (maxTimeInSeconds === null || typeof interleaveSearch !== 'boolean') {
    return {
      verdict: 'unrecorded',
      reproducible: false,
      detail:
        'This build did not record the parameter set it ran under, so whether its ' +
        'result can be reproduced cannot be established.',
    };
  }

  /* Parsed against the closed vocabularies rather than cast. An unrecognised
   * termination reads as ABSENT, which the verdict treats as "cannot establish
   * that it completed" — the fail-closed direction. A cast would let a value
   * outside the set walk straight past the `!== 'completed'` test.
   *
   * The same parse applies to the status, and **since REV-A-006 / GH-008 M-2
   * the verdict treats that absence the same way.** It did not: this
   * fail-closed parse fed a branch that fell through to `reproducible` with the
   * promise sentence, so an unreadable `solver_status` became a claim. The
   * repair is in `resultReproducibility` itself, where the other three nullable
   * facts are already closed; nothing about the parse changed. */
  const terminationReason = TERMINATION_REASONS.find((r) => r === run.termination_reason) ?? null;
  const status = SOLVER_STATUSES.find((s) => s === run.solver_status) ?? null;

  return resultReproducibility({
    parameters: {
      randomSeed: number(raw['randomSeed']) ?? 0,
      numSearchWorkers: number(raw['numSearchWorkers']) ?? 1,
      maxTimeInSeconds,
      maxDeterministicTime: number(raw['maxDeterministicTime']),
      interleaveSearch,
    },
    wallTimeSeconds: statistics.wallTimeSeconds,
    deterministicTimeUnits: statistics.deterministicTimeUnits,
    terminationReason,
    status,
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Runs
 * ──────────────────────────────────────────────────────────────────────────── */

export interface CreateRunInput {
  readonly configurationId: string;
  readonly sourceVersionId: string;
  readonly candidateLabel: string;
  readonly idempotencyKey: string;
  readonly parentBuildIds?: readonly string[];
  readonly protectedAssignmentIdentities?: readonly string[];
  readonly retryOfBuildRunId?: string;
}

/**
 * The digest that makes the idempotency key answer the RIGHT question.
 *
 * 0015's lesson (D-17), applied: a key that answers "have I seen this key?" will
 * tell a client its operation succeeded when a *different* one did. This binds
 * the key to the semantic request — the configuration, the source draft, the
 * label, the progressive inputs, and the retry link.
 */
export function semanticBuildRequestDigest(input: CreateRunInput): string {
  const canonical = JSON.stringify({
    configurationId: input.configurationId,
    sourceVersionId: input.sourceVersionId,
    candidateLabel: input.candidateLabel,
    parentBuildIds: [...(input.parentBuildIds ?? [])].sort(),
    protectedAssignmentIdentities: [...(input.protectedAssignmentIdentities ?? [])].sort(),
    retryOfBuildRunId: input.retryOfBuildRunId ?? null,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export interface CreatedRun {
  readonly buildRunId: string;
  /** `true` when the recorded outcome of an earlier identical request is returned. */
  readonly replayed: boolean;
}

/**
 * Create a build run in `draft_configuration` (I-13's shape at the API layer:
 * this is the explicit Save, not the click that opened the form).
 *
 * **Idempotent, in the D-17 one-domain form.** A replay with the same key and
 * the same semantic request returns the RECORDED run; the same key naming a
 * different request is refused explicitly rather than answered with somebody
 * else's build.
 *
 * **D-4a is enforced by the database**, not by a pre-check here: a second
 * in-flight run of the same configuration violates the partial unique index and
 * a friendly pre-check would only race it.
 */
export async function createRun(
  uow: Uow,
  actor: ScheduleActor,
  input: CreateRunInput,
): Promise<CreatedRun> {
  await requireScheduleCapability(uow, actor, 'versionEdit');

  const configuration = await readConfiguration(uow, input.configurationId);
  if (configuration === null) {
    throw new BuildPreconditionError(
      'BUILD_CONFIGURATION_NOT_FOUND',
      'the build configuration named by this request does not exist in this group',
    );
  }

  let retryAttempt = 0;
  if (input.retryOfBuildRunId !== undefined) {
    const parent = await loadRun(uow, input.retryOfBuildRunId);
    if (parent === null) {
      throw new BuildPreconditionError(
        'BUILD_RETRY_PARENT_NOT_FOUND',
        'the build this retry names does not exist in this group',
      );
    }
    retryAttempt = parent.retry_attempt + 1;
    if (retryAttempt > configuration.retry_limit) {
      throw new BuildRetryLimitError(configuration.retry_limit, parent.termination_reason);
    }
  }

  const digest = semanticBuildRequestDigest(input);
  const id = randomUUID();
  const tenant = tenantOf(uow.context);

  const inserted = await uow.query
    .insertInto('build_runs')
    .values({
      id,
      ...tenant,
      period_id: configuration.period_id,
      build_configuration_id: configuration.id,
      source_version_id: input.sourceVersionId,
      candidate_label: input.candidateLabel,
      retry_of_build_run_id: input.retryOfBuildRunId ?? null,
      retry_attempt: retryAttempt,
      parent_build_ids: [...(input.parentBuildIds ?? [])],
      protected_assignment_identities: [...(input.protectedAssignmentIdentities ?? [])],
      idempotency_key: input.idempotencyKey,
      semantic_request_digest: digest,
      initiated_by: uow.context.membershipId,
    })
    .onConflict((oc) =>
      oc.columns(['organization_id', 'group_id', 'period_id', 'idempotency_key']).doNothing(),
    )
    .returning('id')
    .executeTakeFirst();

  if (inserted !== undefined) {
    await recordBuildEvent(uow, {
      buildRunId: id,
      kind: 'transition',
      fromState: null,
      toState: 'draft_configuration',
      claimEpoch: 0,
      reason: 'created',
    });
    return { buildRunId: id, replayed: false };
  }

  /* The insert conflicted. Under RLS an invisible conflicting row is
   * unreachable — the conflict key carries both tenant columns — so a row that
   * cannot be read here is a genuine refusal rather than a retry opportunity. */
  const existing = await uow.query
    .selectFrom('build_runs')
    .select(['id', 'semantic_request_digest'])
    .where('period_id', '=', configuration.period_id)
    .where('idempotency_key', '=', input.idempotencyKey)
    .executeTakeFirst();

  if (existing === undefined || existing.semantic_request_digest !== digest) {
    throw new BuildIdempotencyConflictError(input.idempotencyKey);
  }
  return { buildRunId: existing.id, replayed: true };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Supersession and archiving — the two system-driven edges
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * "Any completed state → superseded: a later build for the period is approved."
 *
 * Applied to the completed FAMILY, which is what report 21's "any completed
 * state" means: everything from `completed` through `applied_to_draft_schedule`.
 * The approving run itself is excluded — a build does not supersede itself.
 */
export async function supersedeSiblings(
  uow: Uow,
  approved: BuildRunRow,
): Promise<readonly string[]> {
  const siblings = await uow.query
    .selectFrom('build_runs')
    .selectAll()
    .where('period_id', '=', approved.period_id)
    .where('id', '!=', approved.id)
    .where('state', 'in', [...COMPLETED_FAMILY_STATES])
    .forUpdate()
    .execute();

  const superseded: string[] = [];
  for (const sibling of siblings as unknown as BuildRunRow[]) {
    await transitionRun(uow, sibling, 'superseded', {
      supersededByBuildRunId: approved.id,
      reason: 'later_build_approved',
    });
    superseded.push(sibling.id);
  }
  return superseded;
}

/**
 * "Any terminal state → archived: period closed."
 *
 * The period's own status is the trigger and is READ here rather than assumed;
 * archiving builds of an open period would remove them from a scheduler's view
 * while the period is still being worked.
 */
export async function archiveSettledRunsForClosedPeriod(
  uow: Uow,
  actor: ScheduleActor,
  periodId: string,
): Promise<readonly string[]> {
  await requireScheduleCapability(uow, actor, 'periodAdminister');

  const period = await uow.query
    .selectFrom('schedule_periods')
    .select(['status'])
    .where('id', '=', periodId)
    .executeTakeFirst();

  if (period === undefined) {
    throw new BuildPreconditionError(
      'BUILD_PERIOD_NOT_FOUND',
      'the period named by this request does not exist in this group',
    );
  }
  if (period.status !== 'closed') {
    throw new BuildPreconditionError(
      'BUILD_PERIOD_NOT_CLOSED',
      'builds are archived when their period closes, and this period is not closed',
    );
  }

  const rows = await uow.query
    .selectFrom('build_runs')
    .selectAll()
    .where('period_id', '=', periodId)
    .where('state', 'in', [...SETTLED_STATES])
    .forUpdate()
    .execute();

  const archived: string[] = [];
  for (const row of rows as unknown as BuildRunRow[]) {
    await transitionRun(uow, row, 'archived', { reason: 'period_closed' });
    archived.push(row.id);
  }
  return archived;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The scheduler's review edges
 * ──────────────────────────────────────────────────────────────────────────── */

/** `completed*` → `reviewed`: the scheduler has inspected the findings (CAP-059). */
export async function markReviewed(
  uow: Uow,
  actor: ScheduleActor,
  buildRunId: string,
  expectedState: BuildRunState,
): Promise<BuildRunRow> {
  await requireScheduleCapability(uow, actor, 'versionEdit');
  const run = await loadRunForUpdate(uow, buildRunId);
  if (run === null) return notFound(buildRunId);
  assertExpectedState(run, expectedState);
  return transitionRun(uow, run, 'reviewed', { reason: 'findings_inspected' });
}

/**
 * `reviewed` → `approved`: zero unresolved hard violations.
 *
 * The count is asserted by migration 0018's transition guard, which reads
 * `build_run_violations` and `build_run_results.usable` for every writer. This
 * function does not re-count them: a second count here would be a second
 * spelling of the gate, and the one that mattered would be whichever the caller
 * happened to reach. Approving also supersedes the period's other completed
 * builds, in the same transaction.
 */
export async function approveRun(
  uow: Uow,
  actor: ScheduleActor,
  buildRunId: string,
  expectedState: BuildRunState,
): Promise<BuildRunRow> {
  await requireScheduleCapability(uow, actor, 'versionEdit');
  const run = await loadRunForUpdate(uow, buildRunId);
  if (run === null) return notFound(buildRunId);
  assertExpectedState(run, expectedState);

  const approved = await transitionRun(uow, run, 'approved', { reason: 'zero_hard_violations' });
  await supersedeSiblings(uow, approved);
  return approved;
}

/**
 * `reviewed` → `progressively_extended`: a further stage runs over this result.
 *
 * The stage itself is a NEW build carrying this one in `parentBuildIds` and the
 * identities it protects in `protectedAssignmentIdentities` (report 21 §5). This
 * edge records that the parent has been extended; the parent returns to
 * `reviewed` when the stage completes, which is the edge report 21 draws.
 */
export async function markProgressivelyExtended(
  uow: Uow,
  actor: ScheduleActor,
  buildRunId: string,
  expectedState: BuildRunState,
): Promise<BuildRunRow> {
  await requireScheduleCapability(uow, actor, 'versionEdit');
  const run = await loadRunForUpdate(uow, buildRunId);
  if (run === null) return notFound(buildRunId);
  assertExpectedState(run, expectedState);
  return transitionRun(uow, run, 'progressively_extended', { reason: 'stage_launched' });
}

/** `progressively_extended` → `reviewed`: the stage completed. */
export async function markStageComplete(
  uow: Uow,
  actor: ScheduleActor,
  buildRunId: string,
  expectedState: BuildRunState,
): Promise<BuildRunRow> {
  await requireScheduleCapability(uow, actor, 'versionEdit');
  const run = await loadRunForUpdate(uow, buildRunId);
  if (run === null) return notFound(buildRunId);
  assertExpectedState(run, expectedState);
  return transitionRun(uow, run, 'reviewed', { reason: 'stage_complete' });
}

function notFound(buildRunId: string): never {
  throw new BuildPreconditionError(
    'BUILD_RUN_NOT_FOUND',
    `no build run ${buildRunId} is visible in this group`,
  );
}

/** The source draft's material-input digest, for the selection CAS (FAD-26(2)). */
export async function sourceDigestOf(uow: Uow, run: BuildRunRow): Promise<string> {
  return materialInputDigest(uow, run.period_id, run.source_version_id);
}
