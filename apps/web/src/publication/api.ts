import {
  affectedStaffDiffSchema,
  auditEventListSchema,
  cloneVersionRequestSchema,
  currentVersionMovedBodySchema,
  publicationRecordListSchema,
  publicationReviewSchema,
  publishedScheduleSchema,
  publishRequestSchema,
  publishResultSchema,
  revertRequestSchema,
  scheduleVersionResultSchema,
  versionSignOffRequestSchema,
  staleReviewBodySchema,
  versionComparisonSchema,
  versionHistorySchema,
  type AffectedStaffDiff,
  type AuditEventList,
  type PublicationRecordList,
  type PublicationReview,
  type PublishedSchedule,
  type PublishRequest,
  type PublishResultWire,
  type RevertRequest,
  type ScheduleVersionResult,
  type VersionSignOffRequest,
  type VersionComparison,
  type VersionHistory,
} from '@schedulepoint/contracts';

import { ApiError, apiRequest } from '../api/client.js';
import { ValidationError } from '../api/catalogue.js';

/**
 * The publication client (OPUS-M3-005).
 *
 * It lives beside the surface it serves, exactly as `schedule/api.ts` does, and
 * imports `ApiError`, `apiRequest` and `ValidationError` from the shared client
 * rather than reimplementing them — so there is still one place the error
 * envelope is parsed and one `ValidationError` the shared summary recognises by
 * `instanceof`.
 *
 * The three package rules apply unchanged:
 *
 *  1. **every URL is same-origin and relative** — CAP-068 / T-23, allowlist empty;
 *  2. **every response is parsed through the shared zod contract**;
 *  3. **requests are parsed on the way OUT**, so the server receives the body the
 *     contract describes rather than whatever fields a form happened to fill in.
 *
 * ## Two refusals get their own classes, and both are keyed on the BODY
 *
 * `errorEnvelopeSchema` is `.strict()`, so a `409` carrying an extra field never
 * parses as an envelope and reaches here with the code `UNEXPECTED_RESPONSE`.
 * Keying on `error.code` would therefore miss every one of them while looking
 * entirely correct — the trap `schedule/api.ts` and `api/rules.ts` both record.
 * So the body is re-parsed, and each class carries what the recovery flow needs:
 * the version that is actually current, or the digest of the difference as it
 * now stands.
 *
 * **Neither is retried here.** SP-E §1.4: stale context is a first-class state
 * and the surface says so; a client that silently re-read and re-submitted would
 * publish something the human never confirmed.
 */

/** `409 CURRENT_VERSION_MOVED` — another publication won the period (FAD-22(2), V-12). */
export class CurrentVersionMovedError extends Error {
  readonly currentVersionId: string | null;
  /** The same version's NUMBER — what the surface shows a human (review N3). */
  readonly currentVersionNumber: number | null;
  readonly correlationId: string;

  constructor(
    message: string,
    currentVersionId: string | null,
    currentVersionNumber: number | null,
    correlationId: string,
  ) {
    super(message);
    this.name = 'CurrentVersionMovedError';
    this.currentVersionId = currentVersionId;
    this.currentVersionNumber = currentVersionNumber;
    this.correlationId = correlationId;
  }
}

/** `409 STALE_REVIEW` — the draft changed between the review and the confirmation. */
export class StaleReviewError extends Error {
  readonly currentReviewDigest: string;
  readonly correlationId: string;

  constructor(message: string, currentReviewDigest: string, correlationId: string) {
    super(message);
    this.name = 'StaleReviewError';
    this.currentReviewDigest = currentReviewDigest;
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
 * Order matters: the two `409` shapes are checked before the `422`, because all
 * three arrive as an `ApiError` whose body must be re-parsed and only one of them
 * is a validation problem.
 */
function asTypedError(error: unknown): never {
  if (error instanceof ApiError) {
    const moved = currentVersionMovedBodySchema.safeParse(error.body);
    if (moved.success) {
      throw new CurrentVersionMovedError(
        moved.data.error.message,
        moved.data.error.currentVersionId,
        moved.data.error.currentVersionNumber,
        moved.data.error.correlationId,
      );
    }
    const stale = staleReviewBodySchema.safeParse(error.body);
    if (stale.success) {
      throw new StaleReviewError(
        stale.data.error.message,
        stale.data.error.currentReviewDigest,
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

/* ── reads ───────────────────────────────────────────────────────────────── */

export async function fetchPublicationReview(
  scope: GroupScope,
  versionId: string,
): Promise<PublicationReview> {
  return publicationReviewSchema.parse(
    await apiRequest(`${base(scope)}/versions/${versionId}/publication-review`),
  );
}

export async function fetchVersionHistory(
  scope: GroupScope,
  periodId: string,
): Promise<VersionHistory> {
  return versionHistorySchema.parse(
    await apiRequest(`${base(scope)}/periods/${periodId}/history`),
  );
}

export async function fetchPublishedSchedule(
  scope: GroupScope,
  periodId: string,
): Promise<PublishedSchedule> {
  return publishedScheduleSchema.parse(
    await apiRequest(`${base(scope)}/periods/${periodId}/published`),
  );
}

export async function fetchPublicationRecords(
  scope: GroupScope,
  periodId: string,
): Promise<PublicationRecordList> {
  return publicationRecordListSchema.parse(
    await apiRequest(`${base(scope)}/periods/${periodId}/publication-records`),
  );
}

/**
 * The audit CHAIN for this group, narrowed to one subject (OPUS-M3-008).
 *
 * A different base path from every other call in this file, and deliberately so:
 * the audit read is its own surface with its own capability
 * (`audit.read`, grant-only) and its own scope rules, and hanging it off
 * `…/schedule/` would suggest it is part of the schedule module's authorization.
 * It is not — a scheduler without the grant gets a denial here while everything
 * else on the page loads.
 */
export async function fetchAuditEvents(
  scope: GroupScope,
  options: { subjectType?: string; subjectId?: string; limit?: number } = {},
): Promise<AuditEventList> {
  const search = new URLSearchParams();
  if (options.subjectType !== undefined) search.set('subjectType', options.subjectType);
  if (options.subjectId !== undefined) search.set('subjectId', options.subjectId);
  if (options.limit !== undefined) search.set('limit', String(options.limit));
  const query = search.toString();
  return auditEventListSchema.parse(
    await apiRequest(
      `/organizations/${scope.organizationId}/groups/${scope.groupId}/audit-events` +
        (query === '' ? '' : `?${query}`),
    ),
  );
}

export async function fetchVersionComparison(
  scope: GroupScope,
  versionId: string,
  againstVersionId?: string,
): Promise<VersionComparison> {
  const search =
    againstVersionId === undefined
      ? ''
      : `?${new URLSearchParams({ againstVersionId }).toString()}`;
  return versionComparisonSchema.parse(
    await apiRequest(`${base(scope)}/versions/${versionId}/comparison${search}`),
  );
}

export async function fetchAffectedStaff(
  scope: GroupScope,
  versionId: string,
  againstVersionId?: string,
): Promise<AffectedStaffDiff> {
  const search =
    againstVersionId === undefined
      ? ''
      : `?${new URLSearchParams({ againstVersionId }).toString()}`;
  return affectedStaffDiffSchema.parse(
    await apiRequest(`${base(scope)}/versions/${versionId}/affected-staff${search}`),
  );
}

/* ── writes ──────────────────────────────────────────────────────────────── */

/**
 * Publish a version.
 *
 * The caller supplies the idempotency key and is responsible for RETAINING it
 * across every retry of this one publication — see `idempotency.ts`. This
 * function deliberately does not mint one: a key generated here would be fresh
 * on every call, so a retry would publish a second time and instantly supersede
 * the first publication, which is the exact failure D-17 exists to prevent.
 */
export async function publishVersion(
  scope: GroupScope,
  versionId: string,
  body: PublishRequest,
): Promise<PublishResultWire> {
  return write(
    `${base(scope)}/versions/${versionId}/publication`,
    publishRequestSchema,
    body,
    (value) => publishResultSchema.parse(value),
  );
}

/** Revert a period to a historical version, by publishing FORWARD (SPEC-05 §6.1). */
export async function revertPeriod(
  scope: GroupScope,
  periodId: string,
  body: RevertRequest,
): Promise<PublishResultWire> {
  return write(
    `${base(scope)}/periods/${periodId}/revert`,
    revertRequestSchema,
    body,
    (value) => publishResultSchema.parse(value),
  );
}

/**
 * Move a version along the lifecycle, short of publication (sign-off).
 *
 * A DISCLOSED ADDITION to packet 32 §10d — see the route's docblock. It carries
 * `schedule.version.edit`, not `schedule.publish`: approving a draft is not
 * publishing it.
 */
export async function signOffVersion(
  scope: GroupScope,
  versionId: string,
  body: VersionSignOffRequest,
): Promise<ScheduleVersionResult> {
  return write(
    `${base(scope)}/versions/${versionId}/state`,
    versionSignOffRequestSchema,
    body,
    (value) => scheduleVersionResultSchema.parse(value),
  );
}

/**
 * Clone a published version into a new draft — the forward-correction handoff.
 *
 * It calls the AUTHORING surface's existing clone route rather than a publication
 * route of its own: correcting a published schedule is authoring, it is gated by
 * `schedule.version.edit` and not by `schedule.publish`, and a second endpoint
 * that did the same thing under a different key would be a second answer to the
 * question of who may edit a draft. The surface hands off to the authoring grid
 * afterwards; nothing about the published version is touched (SPEC-05 §6.1).
 */
export async function cloneForCorrection(
  scope: GroupScope,
  sourceVersionId: string,
): Promise<ScheduleVersionResult> {
  return write(
    `${base(scope)}/versions/clone`,
    cloneVersionRequestSchema,
    { sourceVersionId },
    (value) => scheduleVersionResultSchema.parse(value),
  );
}
