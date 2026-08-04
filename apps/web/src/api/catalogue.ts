import {
  createGroupHolidayRequestSchema,
  createShiftGroupRequestSchema,
  createShiftTypeRequestSchema,
  createStaffGroupRequestSchema,
  createValidGroupRequestSchema,
  groupHolidayListSchema,
  pickPositionCountSchema,
  setPickPositionCountRequestSchema,
  setWeekdayDemandRequestSchema,
  shiftGroupListSchema,
  shiftTypeListSchema,
  shiftTypeResultSchema,
  staffGroupListSchema,
  updateShiftTypeRequestSchema,
  validGroupListSchema,
  validationProblemBodySchema,
  weekdayDemandSchema,
  type CreateGroupHolidayRequest,
  type CreateShiftGroupRequest,
  type CreateShiftTypeRequest,
  type CreateStaffGroupRequest,
  type CreateValidGroupRequest,
  type FieldProblemWire,
  type GroupHolidayList,
  type PickPositionCount,
  type SetWeekdayDemandRequest,
  type ShiftGroupList,
  type ShiftTypeList,
  type ShiftTypeResult,
  type StaffGroupList,
  type UpdateShiftTypeRequest,
  type ValidGroupList,
  type WeekdayDemand,
} from '@schedulepoint/contracts';

import { ApiError, apiRequest } from './client.js';

/**
 * The catalogue's client.
 *
 * Two rules from `client.ts` apply unchanged and are worth restating at the only
 * place in this codebase that talks to a product API:
 *
 *  1. **every URL is same-origin and relative** — CAP-068 / T-23, and the
 *     client-host allowlist is empty;
 *  2. **every response is parsed through the shared zod contract** — an unparsed
 *     response is an untyped response whatever the TypeScript signature claims.
 *
 * ## The third rule this file adds
 *
 * **Requests are parsed on the way OUT as well.** A create call parses its body
 * through `createShiftTypeRequestSchema` before sending. That is not paranoia
 * about the network: it is what applies the schema's `.default()` values, so the
 * body the server receives is the body the contract describes rather than
 * whatever fields a form happened to fill in.
 */

/** A `422` from a catalogue route: the server naming the fields that are wrong. */
export class ValidationError extends ApiError {
  readonly problems: readonly FieldProblemWire[];

  constructor(message: string, problems: readonly FieldProblemWire[], correlationId?: string) {
    super('VALIDATION_FAILED', message, correlationId);
    this.name = 'ValidationError';
    this.problems = problems;
  }
}

/**
 * Parses a request body, turning a contract failure into the SAME shape the
 * server's `422` produces.
 *
 * ## Why this exists, and what it is not
 *
 * The client parses outgoing bodies so the schema's `.default()` values are
 * applied — the server should receive the body the contract describes rather
 * than whatever fields a form happened to fill in. But a raw `ZodError` thrown
 * from that parse would surface as an unhandled exception with a message about
 * "String must contain at least 1 character(s)", which is not something to put
 * in front of a scheduler.
 *
 * So a shape failure becomes a `ValidationError` with `{ field, message }`
 * entries, identical to the server's, and the form renders it through the same
 * summary. The user cannot tell which layer refused, which is correct: it is one
 * rule, and they are two readings of it.
 *
 * **It is NOT a replacement for the server's validation.** It catches shape
 * only — required, length, format. Every semantic rule (the manual/daily-pick
 * contradiction, the pick-position ceiling, tenant membership) is the server's,
 * and reaches the same summary by the same route.
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
    field: String(issue.path[0] ?? 'form'),
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
  if (/at least 1 character/i.test(message)) return 'Enter a value.';
  if (/at most (\d+) character/i.test(message)) {
    return `This is longer than the ${/at most (\d+)/i.exec(message)?.[1] ?? ''} characters allowed.`;
  }
  if (/HH:MM/i.test(message)) return 'Enter a time as HH:MM, for example 07:30.';
  if (/YYYY-MM-DD/i.test(message)) return 'Enter a date as YYYY-MM-DD.';
  if (/expected number|Expected number/i.test(message)) return 'Enter a number.';
  return message;
}

/**
 * Turns the catalogue's `422` into a typed `ValidationError` and leaves every
 * other failure to `apiRequest`'s envelope handling.
 *
 * The 422 is the ONLY response body in this slice that carries detail, and it is
 * the only one where detail discloses nothing: reaching it required passing the
 * evaluator in the declared group, so everything it names is something this
 * client just sent.
 */
async function catalogueRequest(path: string, init?: RequestInit): Promise<unknown> {
  try {
    return await apiRequest(path, init);
  } catch (error) {
    if (error instanceof ApiError) {
      // Matched on the BODY rather than on `error.code`, and that is not
      // fussiness: `errorEnvelopeSchema` is `.strict()`, so a 422 carrying
      // `problems` never parses as an envelope and arrives with the code
      // `UNEXPECTED_RESPONSE`. Keying on the code would have missed every
      // validation failure while looking entirely correct.
      const parsed = validationProblemBodySchema.safeParse(error.body);
      if (parsed.success) {
        throw new ValidationError(
          parsed.data.error.message,
          parsed.data.error.problems,
          parsed.data.error.correlationId,
        );
      }
    }
    throw error;
  }
}

export interface GroupScope {
  readonly organizationId: string;
  readonly groupId: string;
}

function base(scope: GroupScope): string {
  return `/organizations/${scope.organizationId}/groups/${scope.groupId}/catalogue`;
}

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

/* ── shift types ─────────────────────────────────────────────────────────── */

export async function fetchShiftTypes(scope: GroupScope): Promise<ShiftTypeList> {
  return shiftTypeListSchema.parse(await catalogueRequest(`${base(scope)}/shift-types`));
}

export async function createShiftType(
  scope: GroupScope,
  body: CreateShiftTypeRequest,
): Promise<ShiftTypeResult> {
  return shiftTypeResultSchema.parse(
    await catalogueRequest(`${base(scope)}/shift-types`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(parseRequest(createShiftTypeRequestSchema, body)),
    }),
  );
}

export async function updateShiftType(
  scope: GroupScope,
  shiftTypeId: string,
  body: UpdateShiftTypeRequest,
): Promise<ShiftTypeResult> {
  return shiftTypeResultSchema.parse(
    await catalogueRequest(`${base(scope)}/shift-types/${shiftTypeId}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify(parseRequest(updateShiftTypeRequestSchema, body)),
    }),
  );
}

export async function setWeekdayDemand(
  scope: GroupScope,
  shiftTypeId: string,
  body: SetWeekdayDemandRequest,
): Promise<WeekdayDemand> {
  return weekdayDemandSchema.parse(
    await catalogueRequest(`${base(scope)}/shift-types/${shiftTypeId}/weekday-demand`, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify(parseRequest(setWeekdayDemandRequestSchema, body)),
    }),
  );
}

/* ── shift groups, staff groups, valid combinations ──────────────────────── */

export async function fetchShiftGroups(scope: GroupScope): Promise<ShiftGroupList> {
  return shiftGroupListSchema.parse(await catalogueRequest(`${base(scope)}/shift-groups`));
}

export async function createShiftGroup(
  scope: GroupScope,
  body: CreateShiftGroupRequest,
): Promise<unknown> {
  return catalogueRequest(`${base(scope)}/shift-groups`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(parseRequest(createShiftGroupRequestSchema, body)),
  });
}

export async function fetchStaffGroups(scope: GroupScope): Promise<StaffGroupList> {
  return staffGroupListSchema.parse(await catalogueRequest(`${base(scope)}/staff-groups`));
}

export async function createStaffGroup(
  scope: GroupScope,
  body: CreateStaffGroupRequest,
): Promise<unknown> {
  return catalogueRequest(`${base(scope)}/staff-groups`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(parseRequest(createStaffGroupRequestSchema, body)),
  });
}

export async function fetchValidGroups(scope: GroupScope): Promise<ValidGroupList> {
  return validGroupListSchema.parse(await catalogueRequest(`${base(scope)}/valid-groups`));
}

export async function createValidGroup(
  scope: GroupScope,
  body: CreateValidGroupRequest,
): Promise<unknown> {
  return catalogueRequest(`${base(scope)}/valid-groups`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(parseRequest(createValidGroupRequestSchema, body)),
  });
}

/* ── group settings: pick positions and the holiday calendar ─────────────── */

export async function fetchPickPositionCount(scope: GroupScope): Promise<PickPositionCount> {
  return pickPositionCountSchema.parse(await catalogueRequest(`${base(scope)}/pick-positions`));
}

export async function setPickPositionCount(
  scope: GroupScope,
  pickPositionCount: number,
): Promise<PickPositionCount> {
  return pickPositionCountSchema.parse(
    await catalogueRequest(`${base(scope)}/pick-positions`, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify(parseRequest(setPickPositionCountRequestSchema, { pickPositionCount })),
    }),
  );
}

export async function fetchGroupHolidays(scope: GroupScope): Promise<GroupHolidayList> {
  return groupHolidayListSchema.parse(await catalogueRequest(`${base(scope)}/holidays`));
}

export async function createGroupHoliday(
  scope: GroupScope,
  body: CreateGroupHolidayRequest,
): Promise<unknown> {
  return catalogueRequest(`${base(scope)}/holidays`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(parseRequest(createGroupHolidayRequestSchema, body)),
  });
}
