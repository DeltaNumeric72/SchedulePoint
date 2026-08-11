import {
  addAssignmentRequestSchema,
  candidateListSchema,
  cellResultSchema,
  cloneVersionRequestSchema,
  createPeriodRequestSchema,
  moveCreditRequestSchema,
  reassignAssignmentRequestSchema,
  removeAssignmentRequestSchema,
  scheduleConflictListSchema,
  scheduleGridSchema,
  schedulePeriodListSchema,
  schedulePeriodResultSchema,
  replaceRequirementsRequestSchema,
  scheduleRequirementSetSchema,
  scheduleVersionListSchema,
  scheduleVersionResultSchema,
  setPinRequestSchema,
  staleSetVersionBodySchema,
  staleEditBodySchema,
  voidCreditRequestSchema,
  type AddAssignmentRequest,
  type CandidateList,
  type CellResult,
  type CreatePeriodRequest,
  type MoveCreditRequest,
  type ReassignAssignmentRequest,
  type RemoveAssignmentRequest,
  type ScheduleConflictList,
  type ScheduleGrid,
  type SchedulePeriodList,
  type SchedulePeriodResult,
  type ScheduleRequirementSet,
  type SetPinRequest,
  type ReplaceRequirementsRequest,
  type ScheduleVersionList,
  type ScheduleVersionResult,
} from '@schedulepoint/contracts';

import { ApiError, apiRequest } from '../api/client.js';
import { ValidationError } from '../api/catalogue.js';

/**
 * The schedule-authoring client (OPUS-M3-004).
 *
 * It lives beside the surface it serves rather than in `src/api/`, because this
 * packet's allowed globs are `apps/web/src/schedule/**` and `apps/web/src/rules/**`
 * — `ApiError`, `apiRequest` and `ValidationError` are IMPORTED from the shared
 * client rather than reimplemented, so there is still exactly one place the
 * error envelope is parsed and one `ValidationError` the shared summary
 * recognises by `instanceof`.
 *
 * The three rules `api/catalogue.ts` states apply unchanged:
 *
 *  1. **every URL is same-origin and relative** — CAP-068 / T-23, allowlist empty;
 *  2. **every response is parsed through the shared zod contract**;
 *  3. **requests are parsed on the way OUT**, so the server receives the body the
 *     contract describes rather than whatever fields a form happened to fill in.
 *
 * ## The stale-edit error is its own class, and it is keyed on the BODY
 *
 * `errorEnvelopeSchema` is `.strict()`, so a `409` carrying `currentRevision`
 * never parses as an envelope and reaches here with the code
 * `UNEXPECTED_RESPONSE`. Keying on `error.code === 'STALE_EDIT'` would therefore
 * miss every stale edit while looking entirely correct — the same trap
 * `api/rules.ts` records for its `422`. So the body is re-parsed through
 * `staleEditBodySchema`, and the class carries the server's current revision so
 * the refetch flow can be explicit rather than a guess.
 */

export class StaleEditError extends Error {
  readonly currentRevision: string;
  readonly correlationId: string;

  constructor(message: string, currentRevision: string, correlationId: string) {
    super(message);
    this.name = 'StaleEditError';
    this.currentRevision = currentRevision;
    this.correlationId = correlationId;
  }
}

/**
 * The aggregate cousin of `StaleEditError` (OPUS-M4-000A): a whole-set save
 * presented a stale `expectedVersion`. Carries the CURRENT version — the
 * refetch hint the explicit-refusal flow requires; nothing is merged.
 */
export class StaleSetVersionError extends Error {
  readonly currentVersion: number;
  readonly correlationId: string;

  constructor(message: string, currentVersion: number, correlationId: string) {
    super(message);
    this.name = 'StaleSetVersionError';
    this.currentVersion = currentVersion;
    this.correlationId = correlationId;
  }
}

export interface GroupScope {
  readonly organizationId: string;
  readonly groupId: string;
}

function base(scope: GroupScope): string {
  return `/organizations/${scope.organizationId}/groups/${scope.groupId}/schedule`;
}

/**
 * Turn a refusal into the class the surface renders.
 *
 * Order matters: a `409 STALE_EDIT` is checked before the `422` shape, because
 * both arrive as an `ApiError` whose body must be re-parsed and only one of them
 * is a validation problem.
 */
function asTypedError(error: unknown): never {
  if (error instanceof ApiError) {
    const stale = staleEditBodySchema.safeParse(error.body);
    if (stale.success) {
      throw new StaleEditError(
        stale.data.error.message,
        stale.data.error.currentRevision,
        stale.data.error.correlationId,
      );
    }
    const staleSet = staleSetVersionBodySchema.safeParse(error.body);
    if (staleSet.success) {
      throw new StaleSetVersionError(
        staleSet.data.error.message,
        staleSet.data.error.currentVersion,
        staleSet.data.error.correlationId,
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

/** POST/PUT with the outgoing contract parse, then the typed refusal mapping. */
async function write<TRequest, TResponse>(
  path: string,
  method: 'POST' | 'PUT',
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
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed.data),
      }),
    );
  } catch (error) {
    return asTypedError(error);
  }
}

/* ── periods ─────────────────────────────────────────────────────────────── */

export async function fetchPeriods(scope: GroupScope): Promise<SchedulePeriodList> {
  return schedulePeriodListSchema.parse(await apiRequest(`${base(scope)}/periods`));
}

export async function createPeriod(
  scope: GroupScope,
  body: CreatePeriodRequest,
): Promise<SchedulePeriodResult> {
  return write(`${base(scope)}/periods`, 'POST', createPeriodRequestSchema, body, (value) =>
    schedulePeriodResultSchema.parse(value),
  );
}

/* ── requirements ────────────────────────────────────────────────────────── */

/** The load-before-edit read (OPUS-M4-000A): the rows plus the aggregate set version. */
export async function fetchRequirements(
  scope: GroupScope,
  periodId: string,
): Promise<ScheduleRequirementSet> {
  return scheduleRequirementSetSchema.parse(
    await apiRequest(`${base(scope)}/periods/${periodId}/requirements`),
  );
}

/**
 * The atomic whole-set replacement (OPUS-M4-000A). Saving produces exactly
 * the presented set; an entry omitted from the request is DELETED — the
 * canonical rule, stated here and on the page. Stale `expectedVersion` →
 * `StaleSetVersionError`, never a merge.
 */
export async function replaceRequirements(
  scope: GroupScope,
  periodId: string,
  body: ReplaceRequirementsRequest,
): Promise<ScheduleRequirementSet> {
  return write(
    `${base(scope)}/periods/${periodId}/requirements`,
    'PUT',
    replaceRequirementsRequestSchema,
    body,
    (value) => scheduleRequirementSetSchema.parse(value),
  );
}

/* ── versions ────────────────────────────────────────────────────────────── */

export async function fetchVersions(
  scope: GroupScope,
  periodId: string,
): Promise<ScheduleVersionList> {
  return scheduleVersionListSchema.parse(
    await apiRequest(`${base(scope)}/periods/${periodId}/versions`),
  );
}

export async function createDraftVersion(
  scope: GroupScope,
  periodId: string,
): Promise<ScheduleVersionResult> {
  try {
    return scheduleVersionResultSchema.parse(
      await apiRequest(`${base(scope)}/periods/${periodId}/versions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
  } catch (error) {
    return asTypedError(error);
  }
}

export async function cloneVersion(
  scope: GroupScope,
  sourceVersionId: string,
): Promise<ScheduleVersionResult> {
  return write(
    `${base(scope)}/versions/clone`,
    'POST',
    cloneVersionRequestSchema,
    { sourceVersionId },
    (value) => scheduleVersionResultSchema.parse(value),
  );
}

/* ── the grid ────────────────────────────────────────────────────────────── */

export async function fetchGrid(scope: GroupScope, versionId: string): Promise<ScheduleGrid> {
  return scheduleGridSchema.parse(await apiRequest(`${base(scope)}/versions/${versionId}/grid`));
}

export async function fetchConflicts(
  scope: GroupScope,
  versionId: string,
): Promise<ScheduleConflictList> {
  return scheduleConflictListSchema.parse(
    await apiRequest(`${base(scope)}/versions/${versionId}/conflicts`),
  );
}

export async function fetchCandidates(
  scope: GroupScope,
  versionId: string,
  cell: { date: string; shiftTypeId: string },
): Promise<CandidateList> {
  const search = new URLSearchParams({ date: cell.date, shiftTypeId: cell.shiftTypeId });
  return candidateListSchema.parse(
    await apiRequest(`${base(scope)}/versions/${versionId}/candidates?${search.toString()}`),
  );
}

/* ── cell mutations ──────────────────────────────────────────────────────── */

export async function addAssignment(
  scope: GroupScope,
  versionId: string,
  body: AddAssignmentRequest,
): Promise<CellResult> {
  return write(
    `${base(scope)}/versions/${versionId}/assignments`,
    'POST',
    addAssignmentRequestSchema,
    body,
    (value) => cellResultSchema.parse(value),
  );
}

export async function removeAssignment(
  scope: GroupScope,
  versionId: string,
  identityId: string,
  body: RemoveAssignmentRequest,
): Promise<CellResult> {
  return write(
    `${base(scope)}/versions/${versionId}/assignments/${identityId}/removal`,
    'POST',
    removeAssignmentRequestSchema,
    body,
    (value) => cellResultSchema.parse(value),
  );
}

export async function reassignAssignment(
  scope: GroupScope,
  versionId: string,
  identityId: string,
  body: ReassignAssignmentRequest,
): Promise<CellResult> {
  return write(
    `${base(scope)}/versions/${versionId}/assignments/${identityId}/reassignment`,
    'POST',
    reassignAssignmentRequestSchema,
    body,
    (value) => cellResultSchema.parse(value),
  );
}

export async function setPin(
  scope: GroupScope,
  versionId: string,
  identityId: string,
  body: SetPinRequest,
): Promise<CellResult> {
  return write(
    `${base(scope)}/versions/${versionId}/assignments/${identityId}/pin`,
    'PUT',
    setPinRequestSchema,
    body,
    (value) => cellResultSchema.parse(value),
  );
}

export async function moveCredit(
  scope: GroupScope,
  versionId: string,
  identityId: string,
  body: MoveCreditRequest,
): Promise<CellResult> {
  return write(
    `${base(scope)}/versions/${versionId}/assignments/${identityId}/credit`,
    'PUT',
    moveCreditRequestSchema,
    body,
    (value) => cellResultSchema.parse(value),
  );
}

export async function voidCredit(
  scope: GroupScope,
  versionId: string,
  creditId: string,
  expectedCellRevision: string,
): Promise<CellResult> {
  return write(
    `${base(scope)}/versions/${versionId}/credits/${creditId}/void`,
    'POST',
    voidCreditRequestSchema,
    { expectedCellRevision },
    (value) => cellResultSchema.parse(value),
  );
}
