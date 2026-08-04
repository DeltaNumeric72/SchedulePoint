import {
  conflictBodySchema,
  createLocationRequestSchema,
  groupSettingsSchema,
  locationListSchema,
  locationResultSchema,
  setPicklistAccessRequestSchema,
  setRequestUntilRequestSchema,
  setTimezoneRequestSchema,
  updateLocationRequestSchema,
  validationProblemBodySchema,
  type CreateLocationRequest,
  type FieldProblemWire,
  type GroupSettings,
  type LocationList,
  type LocationResult,
  type PicklistAccessMode,
  type RequestUntilPolicy,
  type UpdateLocationRequest,
} from '@schedulepoint/contracts';

import { ApiError, apiRequest } from '../api/client.js';

/**
 * The settings client (OPUS-M3-007).
 *
 * The three rules `api/catalogue.ts` states apply here unchanged:
 *
 *  1. **every URL is same-origin and relative** — CAP-068 / T-23, and the
 *     client-host allowlist is empty;
 *  2. **every response is parsed through the shared zod contract** — an unparsed
 *     response is an untyped response whatever the TypeScript signature claims;
 *  3. **requests are parsed on the way OUT too**, so the schema's `.default()`
 *     values are applied and the server receives the body the contract
 *     describes rather than whatever fields a form happened to fill in.
 *
 * It lives under `src/settings/` rather than beside the catalogue client because
 * packet 32 §10a gives this packet `apps/web/src/settings/**`; `src/api/` is
 * shared surface and is left alone. `apiRequest` and `ApiError` are imported
 * from it, which is a read.
 */

/** A `422` from a settings route: the server naming the fields that are wrong. */
export class ValidationError extends ApiError {
  readonly problems: readonly FieldProblemWire[];

  constructor(message: string, problems: readonly FieldProblemWire[], correlationId?: string) {
    super('VALIDATION_FAILED', message, correlationId);
    this.name = 'ValidationError';
    this.problems = problems;
  }
}

/** A `409`: somebody else saved first, and this form is looking at stale values. */
export class ConflictError extends ApiError {
  constructor(correlationId?: string) {
    super(
      'CONFLICT',
      'Somebody else changed these settings while this form was open. Reload to see the current values.',
      correlationId,
    );
    this.name = 'ConflictError';
  }
}

/**
 * Turns a contract failure on the way OUT into the SAME shape the server's `422`
 * produces, so the form renders one summary whichever layer refused.
 *
 * The field name is the FULL path joined by `.`, matching the server's own
 * spelling — this slice's bodies nest one level (`policy.untilDate`) and a
 * summary that said "policy" could not link to the control that is wrong.
 *
 * **It is not a replacement for the server's validation.** It catches shape
 * only. Every semantic rule — the acknowledgement requirement, the version
 * check, tenant membership — is the server's and reaches the same summary by the
 * same route.
 */
function parseRequest<T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: unknown } },
  body: unknown,
): T {
  const parsed = schema.safeParse(body);
  if (parsed.success && parsed.data !== undefined) return parsed.data;

  const issues =
    (parsed.error as { issues?: { path: (string | number)[]; message: string }[] } | undefined)
      ?.issues ?? [];
  const problems = issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.map(String).join('.') : 'form',
    message: friendly(issue.message),
  }));
  throw new ValidationError(
    'Some of the details need attention.',
    problems.length > 0
      ? problems
      : [{ field: 'form', message: 'Some of the details need attention.' }],
  );
}

/**
 * Zod's messages are precise and unreadable. The handful this slice can actually
 * produce are re-worded; anything else is passed through rather than swallowed,
 * so a message nobody has translated is visible instead of hidden.
 */
function friendly(message: string): string {
  if (message.includes('Required')) return 'This is required.';
  if (message.includes('Invalid input')) return 'Choose one of the options.';
  if (message.startsWith('String must contain at least')) return 'This is required.';
  return message;
}

/**
 * Re-throws a server refusal as the typed shape the forms render.
 *
 * **Matched on the BODY rather than on `error.code`, and that is not
 * fussiness.** `errorEnvelopeSchema` is `.strict()`, so a `422` carrying
 * `problems` never parses as an envelope and reaches here with the code
 * `UNEXPECTED_RESPONSE`. Keying on the code would have missed every validation
 * failure while looking entirely correct — the catalogue client records the same
 * finding, and the first version of this file reproduced it: the AC-11 e2e test
 * caught a summary that never appeared.
 *
 * A `409` is a plain envelope and DOES parse, so the conflict arm keys on the
 * code. The asymmetry is real and is why both are spelled out.
 */
function rethrow(error: unknown): never {
  if (error instanceof ApiError) {
    const validation = validationProblemBodySchema.safeParse(error.body);
    if (validation.success) {
      throw new ValidationError(
        validation.data.error.message,
        validation.data.error.problems,
        validation.data.error.correlationId,
      );
    }
    const conflict = conflictBodySchema.safeParse(error.body);
    if (conflict.success && conflict.data.error.code === 'CONFLICT') {
      throw new ConflictError(conflict.data.error.correlationId);
    }
  }
  throw error;
}

export interface GroupScope {
  readonly organizationId: string;
  readonly groupId: string;
}

const base = (scope: GroupScope): string =>
  `/organizations/${scope.organizationId}/groups/${scope.groupId}/settings`;

const jsonHeaders = { 'content-type': 'application/json' } as const;

export async function fetchGroupSettings(scope: GroupScope): Promise<GroupSettings> {
  return groupSettingsSchema.parse(await apiRequest(base(scope)));
}

export async function setRequestUntil(
  scope: GroupScope,
  policy: RequestUntilPolicy,
  expectedVersion: number,
): Promise<void> {
  const body = parseRequest(setRequestUntilRequestSchema, { policy, expectedVersion });
  try {
    await apiRequest(`${base(scope)}/request-until`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify(body),
    });
  } catch (error) {
    rethrow(error);
  }
}

export async function setPicklistAccess(
  scope: GroupScope,
  mode: PicklistAccessMode,
  expectedVersion: number,
): Promise<void> {
  const body = parseRequest(setPicklistAccessRequestSchema, { mode, expectedVersion });
  try {
    await apiRequest(`${base(scope)}/picklist-access`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify(body),
    });
  } catch (error) {
    rethrow(error);
  }
}

export async function setTimezone(
  scope: GroupScope,
  timezone: string,
  expectedVersion: number,
  acknowledgePublishedImpact: boolean,
): Promise<void> {
  const body = parseRequest(setTimezoneRequestSchema, {
    timezone,
    expectedVersion,
    acknowledgePublishedImpact,
  });
  try {
    await apiRequest(`${base(scope)}/timezone`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify(body),
    });
  } catch (error) {
    rethrow(error);
  }
}

export async function fetchLocations(scope: GroupScope): Promise<LocationList> {
  return locationListSchema.parse(await apiRequest(`${base(scope)}/locations`));
}

export async function createLocation(
  scope: GroupScope,
  request: CreateLocationRequest,
): Promise<LocationResult> {
  const body = parseRequest(createLocationRequestSchema, request);
  try {
    return locationResultSchema.parse(
      await apiRequest(`${base(scope)}/locations`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(body),
      }),
    );
  } catch (error) {
    rethrow(error);
  }
}

export async function updateLocation(
  scope: GroupScope,
  locationId: string,
  request: UpdateLocationRequest,
): Promise<LocationResult> {
  const body = parseRequest(updateLocationRequestSchema, request);
  try {
    return locationResultSchema.parse(
      await apiRequest(`${base(scope)}/locations/${locationId}`, {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify(body),
      }),
    );
  } catch (error) {
    rethrow(error);
  }
}
