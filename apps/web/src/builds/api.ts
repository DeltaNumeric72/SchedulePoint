import {
  applyBuildRequestSchema,
  applyBuildResultSchema,
  buildConfigurationListSchema,
  buildConfigurationResultSchema,
  buildRunDetailSchema,
  buildRunListSchema,
  buildRunResultSchema,
  buildStaleSourceBodySchema,
  buildStateMovedBodySchema,
  buildTransitionRequestSchema,
  candidateComparisonSchema,
  createBuildConfigurationRequestSchema,
  createBuildRunRequestSchema,
  type ApplyBuildRequest,
  type ApplyBuildResult,
  type BuildConfigurationList,
  type BuildConfigurationResult,
  type BuildRunDetail,
  type BuildRunList,
  type BuildRunResult,
  type BuildRunStateWire,
  type CandidateComparison,
  type CreateBuildConfigurationRequest,
  type CreateBuildRunRequest,
} from '@schedulepoint/contracts';

import { ValidationError } from '../api/catalogue.js';
import { ApiError, apiRequest } from '../api/client.js';

/**
 * The build-lifecycle client (OPUS-M4-003).
 *
 * It lives beside the surface it serves, exactly as `publication/api.ts` does,
 * and imports `ApiError`, `apiRequest` and `ValidationError` from the shared
 * client rather than reimplementing them — so there is still one place the error
 * envelope is parsed and one `ValidationError` the shared summary recognises.
 *
 * ## Refusals are matched on the BODY, never on the code
 *
 * `errorEnvelopeSchema` is `.strict()`, so a body carrying `currentState` or
 * `currentSourceDigest` never parses as an envelope and arrives with code
 * `UNEXPECTED_RESPONSE`. Keying on `error.code` would therefore miss exactly the
 * two refusals that carry the information the surface needs.
 *
 * ## Nothing here retries
 *
 * A build that moved, or a source draft that moved, is a first-class state the
 * surface states plainly. A client that silently re-read and re-submitted would
 * apply a schedule the human never confirmed.
 */

/** `409 BUILD_STATE_MOVED` — the build moved between the read and the decision. */
export class BuildStateMovedError extends Error {
  readonly currentState: BuildRunStateWire;
  readonly correlationId: string;

  constructor(message: string, currentState: BuildRunStateWire, correlationId: string) {
    super(message);
    this.name = 'BuildStateMovedError';
    this.currentState = currentState;
    this.correlationId = correlationId;
  }
}

/** `409 STALE_BUILD_SOURCE` — the draft the build was posed against changed. */
export class BuildSourceMovedError extends Error {
  readonly currentSourceDigest: string;
  readonly correlationId: string;

  constructor(message: string, currentSourceDigest: string, correlationId: string) {
    super(message);
    this.name = 'BuildSourceMovedError';
    this.currentSourceDigest = currentSourceDigest;
    this.correlationId = correlationId;
  }
}

export interface GroupScope {
  readonly organizationId: string;
  readonly groupId: string;
}

function base(scope: GroupScope): string {
  return `/organizations/${scope.organizationId}/groups/${scope.groupId}/builds`;
}

function asTypedError(error: unknown): never {
  if (error instanceof ApiError) {
    const moved = buildStateMovedBodySchema.safeParse(error.body);
    if (moved.success) {
      throw new BuildStateMovedError(
        moved.data.error.message,
        moved.data.error.currentState,
        moved.data.error.correlationId,
      );
    }
    const stale = buildStaleSourceBodySchema.safeParse(error.body);
    if (stale.success) {
      throw new BuildSourceMovedError(
        stale.data.error.message,
        stale.data.error.currentSourceDigest,
        stale.data.error.correlationId,
      );
    }
    const validation = (
      error.body as { error?: { problems?: { field: string; message: string }[] } } | undefined
    )?.error;
    if (validation?.problems !== undefined) {
      throw new ValidationError(
        'Some of the details need attention.',
        validation.problems,
        error.correlationId,
      );
    }
  }
  throw error;
}

/** POST with the outgoing contract parse, then the typed refusal mapping. */
async function write<TRequest, TResponse>(
  path: string,
  schema: { safeParse: (value: unknown) => { success: boolean; data?: TRequest; error?: unknown } },
  body: TRequest,
  parse: (value: unknown) => TResponse,
): Promise<TResponse> {
  const parsed = schema.safeParse(body);
  if (!parsed.success || parsed.data === undefined) {
    const issues =
      (parsed.error as { issues?: { path: (string | number)[]; message: string }[] } | undefined)
        ?.issues ?? [];
    throw new ValidationError(
      'Some of the details need attention.',
      issues.slice(0, 40).map((issue) => ({
        field: (issue.path.length > 0 ? issue.path.join('.') : 'body').slice(0, 64),
        message: issue.message.slice(0, 300),
      })),
    );
  }

  try {
    return parse(
      await apiRequest(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed.data),
      }),
    );
  } catch (error) {
    return asTypedError(error);
  }
}

/* ── reads ────────────────────────────────────────────────────────────────── */

export async function fetchConfigurations(
  scope: GroupScope,
  periodId: string,
): Promise<BuildConfigurationList> {
  return buildConfigurationListSchema.parse(
    await apiRequest(`${base(scope)}/configurations?periodId=${encodeURIComponent(periodId)}`),
  );
}

export async function fetchRuns(scope: GroupScope, periodId: string): Promise<BuildRunList> {
  return buildRunListSchema.parse(
    await apiRequest(`${base(scope)}/runs?periodId=${encodeURIComponent(periodId)}`),
  );
}

export async function fetchRun(scope: GroupScope, buildRunId: string): Promise<BuildRunDetail> {
  return buildRunDetailSchema.parse(
    await apiRequest(`${base(scope)}/runs/${encodeURIComponent(buildRunId)}`),
  );
}

export async function fetchComparison(
  scope: GroupScope,
  buildRunIds: readonly string[],
): Promise<CandidateComparison> {
  return candidateComparisonSchema.parse(
    await apiRequest(`${base(scope)}/comparison?runIds=${buildRunIds.join(',')}`),
  );
}

/* ── writes ───────────────────────────────────────────────────────────────── */

export async function createConfiguration(
  scope: GroupScope,
  body: CreateBuildConfigurationRequest,
): Promise<BuildConfigurationResult> {
  return write(
    `${base(scope)}/configurations`,
    createBuildConfigurationRequestSchema,
    body,
    (value) => buildConfigurationResultSchema.parse(value),
  );
}

export async function createRun(
  scope: GroupScope,
  body: CreateBuildRunRequest,
): Promise<BuildRunResult> {
  return write(`${base(scope)}/runs`, createBuildRunRequestSchema, body, (value) =>
    buildRunResultSchema.parse(value),
  );
}

/** Every transition route takes the same body and answers the same shape. */
export async function transitionRun(
  scope: GroupScope,
  buildRunId: string,
  action: 'submit' | 'run' | 'cancel' | 'review' | 'extend' | 'stage-complete' | 'approve',
  expectedState: BuildRunStateWire,
): Promise<BuildRunResult> {
  return write(
    `${base(scope)}/runs/${encodeURIComponent(buildRunId)}/${action}`,
    buildTransitionRequestSchema,
    { expectedState },
    (value) => buildRunResultSchema.parse(value),
  );
}

/**
 * `run` takes no body: the claim is atomic and there is no state the caller
 * could usefully assert about a build somebody else may be claiming right now.
 */
export async function runBuild(
  scope: GroupScope,
  buildRunId: string,
): Promise<BuildRunResult> {
  try {
    return buildRunResultSchema.parse(
      await apiRequest(`${base(scope)}/runs/${encodeURIComponent(buildRunId)}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
  } catch (error) {
    return asTypedError(error);
  }
}

/**
 * **Retry a build that did not finish** (FAD-45(2), review R-2).
 *
 * SPEC-04 §2: "a retry is a **new** `build_run` with a new id and the same
 * `input_hash`, linked by `retry_of_build_run_id`. **Retries are never
 * in-place**." So this creates a run rather than transitioning one — which is
 * why it goes through `createRun` and not through the transition helper, and why
 * the surface calling it must send the failed build's id rather than its state.
 *
 * The bound is the server's: `createRun` refuses past the configuration's
 * `retryLimit` with `BUILD_RETRY_LIMIT_REACHED`, and the surface renders the
 * exhaustion rather than hiding the control, so a scheduler learns the chain is
 * spent instead of pressing a button that silently does nothing.
 */
export async function retryBuild(
  scope: GroupScope,
  failedRun: {
    readonly id: string;
    readonly configurationId: string;
    readonly sourceVersionId: string;
    readonly candidateLabel: string;
  },
  idempotencyKey: string,
): Promise<BuildRunResult> {
  return createRun(scope, {
    configurationId: failedRun.configurationId,
    sourceVersionId: failedRun.sourceVersionId,
    candidateLabel: failedRun.candidateLabel,
    idempotencyKey,
    retryOfBuildRunId: failedRun.id,
  });
}

export async function applyBuild(
  scope: GroupScope,
  buildRunId: string,
  body: ApplyBuildRequest,
): Promise<ApplyBuildResult> {
  return write(
    `${base(scope)}/runs/${encodeURIComponent(buildRunId)}/apply`,
    applyBuildRequestSchema,
    body,
    (value) => applyBuildResultSchema.parse(value),
  );
}
