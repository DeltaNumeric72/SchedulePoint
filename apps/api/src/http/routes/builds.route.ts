import {
  applyBuildRequestSchema,
  applyBuildResultSchema,
  buildConfigurationListSchema,
  buildConfigurationResultSchema,
  buildRunDetailSchema,
  buildRunListSchema,
  buildRunResultSchema,
  buildStaleInputsBodySchema,
  buildStaleSourceBodySchema,
  buildStateMovedBodySchema,
  buildTransitionRequestSchema,
  candidateComparisonSchema,
  createBuildConfigurationRequestSchema,
  createBuildRunRequestSchema,
  isUuid,
  validationProblemBodySchema,
  type BuildRunStateWire,
  type BuildRunSummary,
} from '@schedulepoint/contracts';
import type { Decision, FieldProblem } from '@schedulepoint/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  evaluateInTransaction,
  respondToDenial,
} from '../../authz/authorize-request.js';
import {
  BuildInputsMovedError,
  BuildPreconditionError,
  BuildResultFencedError,
  BuildSourceMovedError,
  BuildStateMovedError,
} from '../../builds/errors.js';
import { requeueOrphanedQueuedBuilds } from '../../builds/queue.js';
import { reapStaleBuilds } from '../../builds/reaper.js';
import { runQueuedBuild, requestCancellation, submitBuild } from '../../builds/runner.js';
import { applyCandidateToNewDraft } from '../../builds/selection.js';
import * as builds from '../../builds/service.js';
import { stalenessWire, type StalenessWire } from '../../builds/constituent-diff.js';
import { buildStaleness } from '../../builds/staleness.js';
import { compareCandidates, findingsOf, readRunDetail, summaryOf } from '../../builds/views.js';
import { isPostgresError, PG_ERRORS } from '../../db/pg-errors.js';
import type { BuildRunState } from '../../db/schema.js';
import { ScheduleDeniedError } from '../../schedule/errors.js';
import { requireTenantContext } from '../context/middleware.js';
import { sendNotFound } from '../context/responses.js';
import type { RouteConfigWithPolicy } from '../policy.js';

/**
 * The scheduler-facing BUILD surface (OPUS-M4-003; report 21 §4, SPEC-04, CAP-015).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## This is the production scheduling mechanism (I-05)
 *
 * Everything on `schedule-authoring.route.ts` is the manual path — override,
 * recovery, fixed-assignment input. This is the other one. A build is how a
 * schedule is actually produced, and the only thing this surface can hand to the
 * schedule module is a NEW DRAFT version (`POST …/runs/:id/apply`). It cannot
 * publish, it cannot touch a published version, and it cannot edit the draft the
 * build was posed against.
 *
 * ## Capability keys — RULED, not a gap (FAD-44(3))
 *
 * Every route here declares `schedule.version.edit` (CAP-014/CAP-015
 * traceability) or `schedule.period.administer` (CAP-019), and that is the
 * decision of record rather than a stand-in.
 *
 * The reasoning FAD-44(3) adopted: **building toward a draft is version-editing
 * authority.** A build's only effect on the schedule is to produce a new draft
 * version, which is precisely what CAP-014 describes, so the existing key covers
 * the surface exactly — and reusing it grants nothing to anybody who could not
 * already author a draft by hand.
 *
 * A dedicated `schedule.build.administer` key would express something narrower:
 * "may run the engine, but may not hand-author". That is a real distinction and
 * a real thing an organization might want — but it is a **scope** question, and
 * scope is owner-controlled (rule 11). It is therefore a RECORDED OWNER QUESTION
 * and deliberately not implemented here, the shape FAD-27's `audit.read` split
 * followed. The 58-capability baseline is untouched either way.
 *
 * ## Two routes take a runner rather than a unit of work, and must
 *
 * `submit` and `run` cross a commit: the solve happens in a worker subprocess
 * and cannot happen inside a transaction (SPEC-12 U-07; the static
 * provider-boundary gate and `assertOutsideUnitOfWork` both bind). They
 * therefore evaluate authorization in a short transaction of their own and then
 * call into `builds/runner.ts`, which owns the transaction sequence. Every other
 * route uses `withBuild`, which is `schedule-authoring.route.ts`'s
 * `withSchedule` unchanged in shape.
 *
 * ## Nothing here writes an audit row
 *
 * Non-bypass rule 6 — the service owns the chain, and writes it LAST
 * (FAD-37(2)). See `builds/service.ts`'s header for the two records a
 * transition produces and why they are not the same record.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Policies. Two existing action keys; this packet adds no domain vocabulary.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Build authoring, submission, review, approval and selection — CAP-014/CAP-015. */
export const BUILD_EDIT_CONFIG = {
  policy: { kind: 'capability', capability: 'CAP-015' },
  actionScope: 'group',
  action: {
    key: 'schedule.version.edit',
    moduleKey: 'core_scheduling',
    requiresObjectPolicy: false,
  },
} as const satisfies RouteConfigWithPolicy;

/**
 * Operational maintenance over a period's builds — CAP-019.
 *
 * Reaping dead workers and archiving a closed period's builds are period
 * administration, not version authoring: they are decisions about the planning
 * window rather than about its content.
 */
export const BUILD_ADMINISTER_CONFIG = {
  policy: { kind: 'capability', capability: 'CAP-019' },
  actionScope: 'group',
  action: {
    key: 'schedule.period.administer',
    moduleKey: 'core_scheduling',
    requiresObjectPolicy: false,
  },
} as const satisfies RouteConfigWithPolicy;

/* ────────────────────────────────────────────────────────────────────────────
 * Outcomes — the same union `schedule-authoring.route.ts` uses, plus the two
 * refusals that carry build state.
 * ──────────────────────────────────────────────────────────────────────────── */

type Uow = Parameters<Parameters<FastifyRequest['server']['tenancy']['runtime']['run']>[1]>[0];

type Outcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'denied'; readonly decision: Decision }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'state-moved'; readonly currentState: BuildRunState }
  | { readonly kind: 'stale-source'; readonly currentSourceDigest: string }
  | { readonly kind: 'stale-inputs'; readonly staleness: StalenessWire }
  | { readonly kind: 'invalid'; readonly problems: readonly FieldProblem[] };

const MAX_PROBLEM_MESSAGE = 300;

function parseBody<T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: unknown } },
  body: unknown,
): Outcome<T> {
  const parsed = schema.safeParse(body);
  if (parsed.success && parsed.data !== undefined) return { kind: 'ok', value: parsed.data };

  const issues =
    (parsed.error as { issues?: { path: (string | number)[]; message: string }[] } | undefined)
      ?.issues ?? [];
  const problems = issues.slice(0, 40).map((issue) => ({
    field: (issue.path.length > 0 ? issue.path.join('.') : 'body').slice(0, 64),
    message:
      issue.message.length > MAX_PROBLEM_MESSAGE
        ? `${issue.message.slice(0, MAX_PROBLEM_MESSAGE - 1)}…`
        : issue.message,
  }));
  return {
    kind: 'invalid',
    problems:
      problems.length > 0
        ? problems
        : [{ field: 'body', message: 'The request body is not valid.' }],
  };
}

/**
 * Which service refusals are conflicts rather than absences.
 *
 * A fenced result, a state that moved, a retry bound reached and a period that
 * is not closed are all "you were authorized and the world is not what you
 * assumed" — 409. Everything else names a row that is not there, and "not there"
 * and "not yours" are deliberately the same reply because RLS makes another
 * group's row invisible.
 */
const CONFLICT_CODES = new Set([
  'BUILD_RESULT_FENCED',
  'BUILD_TRANSITION_ILLEGAL',
  'BUILD_IDEMPOTENCY_CONFLICT',
  'BUILD_RETRY_LIMIT_REACHED',
  'BUILD_PERIOD_NOT_CLOSED',
  'BUILD_NOT_CANCELLABLE',
  'BUILD_CANDIDATE_EMPTY',
  'BUILD_SNAPSHOT_MISSING',
]);

function outcomeOfServiceError<T>(error: unknown): Outcome<T> | null {
  if (error instanceof ScheduleDeniedError) return { kind: 'denied', decision: error.decision };
  if (error instanceof BuildStateMovedError) {
    return { kind: 'state-moved', currentState: error.currentState };
  }
  if (error instanceof BuildSourceMovedError) {
    return { kind: 'stale-source', currentSourceDigest: error.currentSourceDigest };
  }
  /* doc 35 §6g ruling 4. Its own outcome rather than a bare 409, because the
   * remedy depends on WHICH input moved and a scheduler cannot see that from a
   * status code. The two staleness refusals stay apart for the same reason
   * their errors do — one sends you to the draft, the other to a new build. */
  if (error instanceof BuildInputsMovedError) {
    /* FAD-50 C-4: the refusal discloses the same class-level projection the
       detail GET does — a caller refused a selection learns WHICH KIND of input
       moved, never which rows. */
    return { kind: 'stale-inputs', staleness: stalenessWire(error.staleness) };
  }
  if (error instanceof BuildResultFencedError) return { kind: 'conflict' };
  if (error instanceof BuildPreconditionError) {
    return CONFLICT_CODES.has(error.code) ? { kind: 'conflict' } : { kind: 'not-found' };
  }
  return null;
}

function outcomeOfAnyError<T>(request: FastifyRequest, error: unknown): Outcome<T> {
  const mapped = outcomeOfServiceError<T>(error);
  if (mapped !== null) return mapped;
  /* A non-database, non-service fault is re-thrown to `setErrorHandler`, which
   * logs it with its stack and answers 500 with the fixed message. Catching
   * everything would turn a bug in this process into a 404 whose log line
   * asserted "refused by the database" about an unexamined cause. */
  if (!isPostgresError(error)) throw error;
  if (error.code === PG_ERRORS.uniqueViolation || error.code === PG_ERRORS.exclusionViolation) {
    /* D-4a and D-4d both land here: a second in-flight build of one
     * configuration, and a second selection into one version. Both are
     * concurrency answers, not missing rows. */
    request.log.warn(
      { correlationId: request.correlationId, sqlstate: error.code },
      'build statement refused by a constraint — reported as a conflict',
    );
    return { kind: 'conflict' };
  }
  if (error.code === PG_ERRORS.restrictViolation) {
    /* Every guard in migration 0018 raises `restrict_violation`: an illegal
     * transition, a fenced result, an unresolved hard violation blocking
     * approval. The service refuses these first with a typed error; reaching
     * here means the service check was bypassed and the DATABASE refused, which
     * is a conflict and never a 500. */
    request.log.warn(
      { correlationId: request.correlationId, sqlstate: error.code },
      'build statement refused by a database guard — reported as a conflict',
    );
    return { kind: 'conflict' };
  }
  request.log.warn(
    { correlationId: request.correlationId, sqlstate: error.code },
    'build statement refused by the database',
  );
  return { kind: 'not-found' };
}

async function withBuild<T>(
  request: FastifyRequest,
  run: (uow: Uow) => Promise<Outcome<T>>,
): Promise<Outcome<T>> {
  const { context, command, route } = requireTenantContext(request);

  return request.server.tenancy.runtime.run(command, async (uow): Promise<Outcome<T>> => {
    const { decision } = await evaluateInTransaction(uow.query, { request, context, route });
    if (!decision.allowed) return { kind: 'denied', decision };
    try {
      return await run(uow);
    } catch (error) {
      return outcomeOfAnyError<T>(request, error);
    }
  });
}

/**
 * The runner-crossing form: the verdict is taken in its own transaction, the
 * work happens after it, and the caller owns its own transaction sequence.
 *
 * I-19 is unweakened — the authorization is re-evaluated against current state
 * at the start of the request, exactly as `withBuild` does — and the services
 * re-check the capability inside every transaction they open, so the verdict is
 * taken twice rather than carried.
 */
async function withBuildRunner<T>(
  request: FastifyRequest,
  run: () => Promise<Outcome<T>>,
): Promise<Outcome<T>> {
  const { context, command, route } = requireTenantContext(request);

  const verdict = await request.server.tenancy.runtime.run(command, async (uow) => {
    const { decision } = await evaluateInTransaction(uow.query, { request, context, route });
    return decision;
  });
  if (!verdict.allowed) return { kind: 'denied', decision: verdict };

  try {
    return await run();
  } catch (error) {
    return outcomeOfAnyError<T>(request, error);
  }
}

function respond<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  outcome: Outcome<T>,
  body: (value: T) => unknown,
): FastifyReply | unknown {
  if (outcome.kind === 'denied') return respondToDenial(request, reply, outcome.decision);
  if (outcome.kind === 'not-found') return sendNotFound(request, reply);
  if (outcome.kind === 'state-moved') {
    return reply.code(409).send(
      buildStateMovedBodySchema.parse({
        error: {
          code: 'BUILD_STATE_MOVED',
          message:
            'This build moved while you were looking at it. Nothing was changed — reload and decide again.',
          currentState: outcome.currentState,
          correlationId: request.correlationId,
        },
      }),
    );
  }
  if (outcome.kind === 'stale-source') {
    return reply.code(409).send(
      buildStaleSourceBodySchema.parse({
        error: {
          code: 'STALE_BUILD_SOURCE',
          message:
            'The draft this build was based on has changed. Nothing was applied — review the change and decide again.',
          currentSourceDigest: outcome.currentSourceDigest,
          correlationId: request.correlationId,
        },
      }),
    );
  }
  if (outcome.kind === 'stale-inputs') {
    return reply.code(409).send(
      buildStaleInputsBodySchema.parse({
        error: {
          code: 'STALE_BUILD_INPUTS',
          message:
            'The inputs this build was posed against have changed. Nothing was applied — ' +
            'run a new build against the current inputs.',
          staleness: {
            stale: outcome.staleness.stale,
            changes: [...outcome.staleness.changes],
            changeCount: outcome.staleness.changeCount,
            assemblyRefusals: [...outcome.staleness.assemblyRefusals],
          },
          correlationId: request.correlationId,
        },
      }),
    );
  }
  if (outcome.kind === 'conflict') {
    return reply.code(409).send({
      error: {
        code: 'CONFLICT',
        message: 'The request could not be completed.',
        correlationId: request.correlationId,
      },
    });
  }
  if (outcome.kind === 'invalid') {
    return reply.code(422).send(
      validationProblemBodySchema.parse({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Some of the details need attention.',
          correlationId: request.correlationId,
          problems: outcome.problems,
        },
      }),
    );
  }
  return body(outcome.value);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Views
 * ──────────────────────────────────────────────────────────────────────────── */

async function summaryFor(uow: Uow, run: builds.BuildRunRow): Promise<BuildRunSummary> {
  const configuration = await builds.readConfiguration(uow, run.build_configuration_id);
  return summaryOf(run, configuration?.name ?? '', configuration?.retry_limit ?? 0);
}

async function loadRunOrNotFound(
  uow: Uow,
  buildRunId: string,
): Promise<builds.BuildRunRow | null> {
  if (!isUuid(buildRunId)) return null;
  return builds.loadRun(uow, buildRunId);
}

function configurationView(row: builds.ConfigurationRow): unknown {
  return {
    id: row.id,
    periodId: row.period_id,
    name: row.name,
    randomSeed: row.random_seed,
    numSearchWorkers: row.num_search_workers,
    maxTimeSeconds: Number(row.max_time_seconds),
    maxDeterministicTime:
      row.max_deterministic_time === null ? null : Number(row.max_deterministic_time),
    interleaveSearch: row.interleave_search,
    dispatchTimeoutMs: row.dispatch_timeout_ms,
    heartbeatTimeoutMs: row.heartbeat_timeout_ms,
    retryLimit: row.retry_limit,
    reproducibilityMode: builds.configurationReproducibility(row),
  };
}

function actorOf(request: FastifyRequest): { principalUserId: string } {
  const { context } = requireTenantContext(request);
  return { principalUserId: context.principalUserId };
}

function queryString(request: FastifyRequest, key: string): string | null {
  const query = request.query as Record<string, unknown> | undefined;
  const value = query?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Registration
 * ──────────────────────────────────────────────────────────────────────────── */

export default function buildRoutes(app: FastifyInstance): void {
  const base = '/organizations/:organizationId/groups/:groupId/builds';

  /* ── configurations ─────────────────────────────────────────── CAP-015 ── */

  app.get(`${base}/configurations`, { config: BUILD_EDIT_CONFIG }, async (request, reply) => {
    const outcome = await withBuild(request, async (uow) => {
      const periodId = queryString(request, 'periodId');
      if (periodId === null || !isUuid(periodId)) return { kind: 'not-found' as const };
      const rows = await builds.listConfigurations(uow, periodId);
      return { kind: 'ok' as const, value: rows.map(configurationView) };
    });

    return respond(request, reply, outcome, (configurations) =>
      buildConfigurationListSchema.parse({
        configurations,
        correlationId: request.correlationId,
      }),
    );
  });

  app.post(`${base}/configurations`, { config: BUILD_EDIT_CONFIG }, async (request, reply) => {
    const outcome = await withBuild(request, async (uow) => {
      const parsed = parseBody(createBuildConfigurationRequestSchema, request.body);
      if (parsed.kind !== 'ok') return parsed;

      const id = await builds.createConfiguration(uow, actorOf(request), {
        periodId: parsed.value.periodId,
        name: parsed.value.name,
        ...(parsed.value.randomSeed === undefined ? {} : { randomSeed: parsed.value.randomSeed }),
        ...(parsed.value.numSearchWorkers === undefined
          ? {}
          : { numSearchWorkers: parsed.value.numSearchWorkers }),
        ...(parsed.value.maxTimeSeconds === undefined
          ? {}
          : { maxTimeSeconds: parsed.value.maxTimeSeconds }),
        ...(parsed.value.maxDeterministicTime === undefined
          ? {}
          : { maxDeterministicTime: parsed.value.maxDeterministicTime }),
        ...(parsed.value.interleaveSearch === undefined
          ? {}
          : { interleaveSearch: parsed.value.interleaveSearch }),
        ...(parsed.value.dispatchTimeoutMs === undefined
          ? {}
          : { dispatchTimeoutMs: parsed.value.dispatchTimeoutMs }),
        ...(parsed.value.heartbeatTimeoutMs === undefined
          ? {}
          : { heartbeatTimeoutMs: parsed.value.heartbeatTimeoutMs }),
        ...(parsed.value.retryLimit === undefined ? {} : { retryLimit: parsed.value.retryLimit }),
      });
      const row = await builds.readConfiguration(uow, id);
      if (row === null) return { kind: 'not-found' as const };
      return { kind: 'ok' as const, value: configurationView(row) };
    });

    return respond(request, reply, outcome, (configuration) =>
      buildConfigurationResultSchema.parse({
        configuration,
        correlationId: request.correlationId,
      }),
    );
  });

  /* ── runs ───────────────────────────────────────────────────── CAP-015 ── */

  app.get(`${base}/runs`, { config: BUILD_EDIT_CONFIG }, async (request, reply) => {
    const outcome = await withBuild(request, async (uow) => {
      const periodId = queryString(request, 'periodId');
      if (periodId === null || !isUuid(periodId)) return { kind: 'not-found' as const };

      const rows = await uow.query
        .selectFrom('build_runs')
        .selectAll()
        .where('period_id', '=', periodId)
        .orderBy('created_at', 'desc')
        .execute();

      const summaries: BuildRunSummary[] = [];
      for (const row of rows as unknown as builds.BuildRunRow[]) {
        summaries.push(await summaryFor(uow, row));
      }
      return { kind: 'ok' as const, value: summaries };
    });

    return respond(request, reply, outcome, (runs) =>
      buildRunListSchema.parse({ runs, correlationId: request.correlationId }),
    );
  });

  app.post(`${base}/runs`, { config: BUILD_EDIT_CONFIG }, async (request, reply) => {
    const outcome = await withBuild(request, async (uow) => {
      const parsed = parseBody(createBuildRunRequestSchema, request.body);
      if (parsed.kind !== 'ok') return parsed;

      const created = await builds.createRun(uow, actorOf(request), {
        configurationId: parsed.value.configurationId,
        sourceVersionId: parsed.value.sourceVersionId,
        candidateLabel: parsed.value.candidateLabel,
        idempotencyKey: parsed.value.idempotencyKey,
        ...(parsed.value.parentBuildIds === undefined
          ? {}
          : { parentBuildIds: parsed.value.parentBuildIds }),
        ...(parsed.value.protectedAssignmentIdentities === undefined
          ? {}
          : { protectedAssignmentIdentities: parsed.value.protectedAssignmentIdentities }),
        ...(parsed.value.retryOfBuildRunId === undefined
          ? {}
          : { retryOfBuildRunId: parsed.value.retryOfBuildRunId }),
      });
      const row = await builds.loadRun(uow, created.buildRunId);
      if (row === null) return { kind: 'not-found' as const };
      return { kind: 'ok' as const, value: await summaryFor(uow, row) };
    });

    return respond(request, reply, outcome, (run) =>
      buildRunResultSchema.parse({ run, correlationId: request.correlationId }),
    );
  });

  app.get(`${base}/runs/:buildRunId`, { config: BUILD_EDIT_CONFIG }, async (request, reply) => {
    const outcome = await withBuild(request, async (uow) => {
      const { buildRunId } = request.params as { buildRunId: string };
      const row = await loadRunOrNotFound(uow, buildRunId);
      if (row === null) return { kind: 'not-found' as const };

      const detail = await readRunDetail(uow, row.id);
      return {
        kind: 'ok' as const,
        value: {
          run: await summaryFor(uow, row),
          validationFindings: findingsOf(row.validation_findings),
          readinessFindings: findingsOf(row.readiness_findings),
          result: detail.result,
          violations: detail.violations,
          conflicts: detail.conflicts,
          events: detail.events,
          sourceDigest: await builds.sourceDigestOf(uow, row),
          /* The DISPATCH statement — what the platform posed the build under.
           * Correct, worth recording, and NOT a claim about the result. */
          reproducibility: row.reproducibility_mode,
          /* The RESULT-side verdict (FAD-49, EV-M4-005 §21). Derived on read
           * from the run's recorded parameters and the search time the result
           * recorded, because a request pinned `deterministic` can still have
           * been ended by its wall clock — and then it reproduces nothing. */
          resultReproducibility: builds.runResultReproducibility(
            row,
            detail.result?.quality.solverStatistics['wallTimeSeconds'] ?? null,
          ),
          /* doc 35 §6g ruling 4: the staleness is visible on the screen BEFORE
           * the scheduler decides, not only in the refusal after they have. */
          /* FAD-50 C-4. Computed over every constituent (FAD-29 — the gate reads
           * the truth) and PROJECTED to input class + direction + count before it
           * reaches a caller: the `qualificationHolding` class's keys are holding
           * row ids behind a grant-only capability. */
          staleness: stalenessWire(await buildStaleness(uow, row)),
        },
      };
    });

    return respond(request, reply, outcome, (detail) =>
      buildRunDetailSchema.parse({ ...detail, correlationId: request.correlationId }),
    );
  });

  /* ── submission and dispatch — the two runner-crossing routes ─ CAP-015 ── */

  app.post(
    `${base}/runs/:buildRunId/submit`,
    { config: BUILD_EDIT_CONFIG },
    async (request, reply) => {
      const { command } = requireTenantContext(request);
      const outcome = await withBuildRunner(request, async () => {
        const { buildRunId } = request.params as { buildRunId: string };
        if (!isUuid(buildRunId)) return { kind: 'not-found' as const };
        const parsed = parseBody(buildTransitionRequestSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;

        await submitBuild(
          request.server.tenancy.runtime,
          command,
          actorOf(request),
          buildRunId,
          parsed.value.expectedState as BuildRunState,
        );

        return withBuild(request, async (uow) => {
          const row = await builds.loadRun(uow, buildRunId);
          if (row === null) return { kind: 'not-found' as const };
          return { kind: 'ok' as const, value: await summaryFor(uow, row) };
        });
      });

      return respond(request, reply, outcome, (run) =>
        buildRunResultSchema.parse({ run, correlationId: request.correlationId }),
      );
    },
  );

  app.post(
    `${base}/runs/:buildRunId/run`,
    { config: BUILD_EDIT_CONFIG },
    async (request, reply) => {
      const { command } = requireTenantContext(request);
      const outcome = await withBuildRunner(request, async () => {
        const { buildRunId } = request.params as { buildRunId: string };
        if (!isUuid(buildRunId)) return { kind: 'not-found' as const };

        /* ── this route is now the OPERATOR path, not the production one ─────
         *
         * D-4b's queue binding (doc 35 §6g ruling 2) moved dispatch to the
         * `build.solve` worker task, which `submitBuild` enqueues in the same
         * transaction that queues the run. This route is retained because a
         * deployment without a build worker — and every e2e run, which has one
         * process — still needs a way to make a queued build run, and because
         * an operator recovering a stalled queue should not have to reach for
         * psql. It runs the SAME `runQueuedBuild`, under the SAME D-4b cap.
         *
         * `not-claimable` means the claim was lost — somebody else took this
         * build, or it is no longer queued. `deferred` means the organization
         * is at its cap and the build is still queued, waiting. Both are
         * concurrency answers, not faults, and both are 409 — but they are
         * DIFFERENT answers and the log line says which. */
        const result = await runQueuedBuild(
          request.server.tenancy.runtime,
          command,
          buildRunId,
        );
        if (result.kind === 'deferred') {
          request.log.info(
            { runningCount: result.runningCount, cap: result.cap },
            'build dispatch deferred: the organization is at its D-4b concurrency cap',
          );
          return { kind: 'conflict' as const };
        }
        if (result.kind === 'not-claimable') return { kind: 'conflict' as const };

        return withBuild(request, async (uow) => {
          const row = await builds.loadRun(uow, buildRunId);
          if (row === null) return { kind: 'not-found' as const };
          return { kind: 'ok' as const, value: await summaryFor(uow, row) };
        });
      });

      return respond(request, reply, outcome, (run) =>
        buildRunResultSchema.parse({ run, correlationId: request.correlationId }),
      );
    },
  );

  /* ── the scheduler's transitions ────────────────────────────── CAP-015 ── */

  const transition = (
    path: string,
    move: (
      uow: Uow,
      actor: { principalUserId: string },
      buildRunId: string,
      expected: BuildRunState,
    ) => Promise<unknown>,
  ): void => {
    app.post(`${base}/runs/:buildRunId/${path}`, { config: BUILD_EDIT_CONFIG }, async (request, reply) => {
      const outcome = await withBuild(request, async (uow) => {
        const { buildRunId } = request.params as { buildRunId: string };
        if (!isUuid(buildRunId)) return { kind: 'not-found' as const };
        const parsed = parseBody(buildTransitionRequestSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;

        await move(
          uow,
          actorOf(request),
          buildRunId,
          parsed.value.expectedState as BuildRunState,
        );
        const row = await builds.loadRun(uow, buildRunId);
        if (row === null) return { kind: 'not-found' as const };
        return { kind: 'ok' as const, value: await summaryFor(uow, row) };
      });

      return respond(request, reply, outcome, (run) =>
        buildRunResultSchema.parse({ run, correlationId: request.correlationId }),
      );
    });
  };

  transition('cancel', (uow, actor, id, expected) =>
    requestCancellation(uow, actor, id, expected),
  );
  transition('review', (uow, actor, id, expected) => builds.markReviewed(uow, actor, id, expected));
  transition('extend', (uow, actor, id, expected) =>
    builds.markProgressivelyExtended(uow, actor, id, expected),
  );
  transition('stage-complete', (uow, actor, id, expected) =>
    builds.markStageComplete(uow, actor, id, expected),
  );
  transition('approve', (uow, actor, id, expected) => builds.approveRun(uow, actor, id, expected));

  /* ── selection ──────────────────────────────────────────────── CAP-015 ── */

  app.post(
    `${base}/runs/:buildRunId/apply`,
    { config: BUILD_EDIT_CONFIG },
    async (request, reply) => {
      const outcome = await withBuild(request, async (uow) => {
        const { buildRunId } = request.params as { buildRunId: string };
        if (!isUuid(buildRunId)) return { kind: 'not-found' as const };
        const parsed = parseBody(applyBuildRequestSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;

        const applied = await applyCandidateToNewDraft(
          uow,
          actorOf(request),
          buildRunId,
          parsed.value.expectedState as BuildRunState,
          parsed.value.expectedSourceDigest,
        );
        return {
          kind: 'ok' as const,
          value: {
            run: await summaryFor(uow, applied.run),
            draftVersionId: applied.draftVersionId,
            assignmentsWritten: applied.assignmentsWritten,
            pickPositionsCarried: applied.pickPositionsCarried,
          },
        };
      });

      return respond(request, reply, outcome, (value) =>
        applyBuildResultSchema.parse({ ...value, correlationId: request.correlationId }),
      );
    },
  );

  /* ── D-4c comparison ────────────────────────────────────────── CAP-015 ── */

  app.get(`${base}/comparison`, { config: BUILD_EDIT_CONFIG }, async (request, reply) => {
    const outcome = await withBuild(request, async (uow) => {
      const raw = queryString(request, 'runIds');
      if (raw === null) return { kind: 'not-found' as const };
      const runIds = raw.split(',').filter((id) => isUuid(id)).slice(0, 8);
      if (runIds.length < 2) {
        return {
          kind: 'invalid' as const,
          problems: [{ field: 'runIds', message: 'Choose at least two candidates to compare.' }],
        };
      }

      const summaries: BuildRunSummary[] = [];
      const quality: { runId: string; quality: unknown }[] = [];
      for (const runId of runIds) {
        const row = await builds.loadRun(uow, runId);
        if (row === null) return { kind: 'not-found' as const };
        summaries.push(await summaryFor(uow, row));
        const detail = await readRunDetail(uow, runId);
        if (detail.result !== null) quality.push({ runId, quality: detail.result.quality });
      }

      const projection = await compareCandidates(uow, runIds);
      return {
        kind: 'ok' as const,
        value: {
          runs: summaries,
          /* REPAIR F-02 (FAD-46). This list is per-candidate FACT — each entry
           * carries the objective profile and digest it was measured under — so
           * it is sent whether or not the candidates are comparable, and the
           * client renders it one candidate at a time on a refusal.
           *
           * What must never happen is the side-by-side TABLE: one column each,
           * under a notice saying they cannot be compared. The verdict below
           * travels in the same response precisely so the renderer can tell
           * those two arrangements apart, and the page is gated on it. Withholding
           * the measurements entirely would be the other error — a candidate's own
           * measurement is not invalidated by the existence of an incomparable
           * sibling. */
          quality,
          /* OPUS-M4-004. The comparability verdict travels WITH the projection,
           * and the projection is empty whenever it refuses. A client cannot
           * accidentally render a difference list across two snapshots because
           * there is no difference list to render. */
          comparability: projection.comparability,
          differences: projection.differences,
          sharedAssignmentCount: projection.sharedAssignmentCount,
        },
      };
    });

    return respond(request, reply, outcome, (value) =>
      candidateComparisonSchema.parse({ ...value, correlationId: request.correlationId }),
    );
  });

  /* ── operational maintenance ────────────────────────────────── CAP-019 ── */

  app.post(`${base}/reap`, { config: BUILD_ADMINISTER_CONFIG }, async (request, reply) => {
    const outcome = await withBuild(request, async (uow) => {
      const reaped = await reapStaleBuilds(uow);
      /* D-4b's other recovery. The reaper answers "a worker died holding a
       * RUNNING build"; this answers "a QUEUED build has no live job" — the
       * shape a saturated organization reaches when its `build.solve` job
       * exhausts its attempts (`builds/queue.ts`). Neither covers the other,
       * and a build stuck in `queued` for ever is as invisible as one stuck in
       * `running` and has no reaper of its own. */
      const requeued = await requeueOrphanedQueuedBuilds(uow);
      return {
        kind: 'ok' as const,
        value: { reaped: reaped.map((entry) => entry.buildRunId), requeued: [...requeued] },
      };
    });

    return respond(request, reply, outcome, (value) => ({
      reaped: value.reaped,
      requeued: value.requeued,
      correlationId: request.correlationId,
    }));
  });

  app.post(`${base}/archive`, { config: BUILD_ADMINISTER_CONFIG }, async (request, reply) => {
    const outcome = await withBuild(request, async (uow) => {
      const periodId = queryString(request, 'periodId');
      if (periodId === null || !isUuid(periodId)) return { kind: 'not-found' as const };
      const archived = await builds.archiveSettledRunsForClosedPeriod(
        uow,
        actorOf(request),
        periodId,
      );
      return { kind: 'ok' as const, value: [...archived] };
    });

    return respond(request, reply, outcome, (archived) => ({
      archived,
      correlationId: request.correlationId,
    }));
  });
}

/** Re-exported for the state-matrix proof, which drives the wire vocabulary. */
export type { BuildRunStateWire };
