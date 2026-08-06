import {
  dailySheetSchema,
  personalScheduleSchema,
  type DailySheet,
  type PersonalSchedule,
} from '@schedulepoint/contracts';

import { apiRequest } from '../api/client.js';

/**
 * The staff-facing schedule read client (OPUS-M3-006).
 *
 * It lives beside the surface it serves, exactly as `schedule/api.ts` does, and
 * imports `apiRequest` from the shared client rather than reimplementing it —
 * so there is still one place the error envelope is parsed and one `ApiError`
 * the shared `SurfaceState` recognises by `instanceof`.
 *
 * The three standing rules, restated because they bite here:
 *
 *  1. **every URL is same-origin and relative** — CAP-068 / T-23, allowlist
 *     empty. A calendar surface is the classic place a third-party host sneaks
 *     in (a font, an icon set, an "add to calendar" widget); none is present and
 *     the gate would fail the build on one.
 *  2. **every response is parsed through the shared zod contract**, so a field
 *     the server stopped sending is a parse failure rather than an `undefined`
 *     rendered as "undefined" in somebody's rota.
 *  3. **nothing is written.** There is no POST, PUT or DELETE in this module.
 *     A published version is immutable (I-18) and this is the surface that reads
 *     it.
 */

export interface GroupScope {
  readonly organizationId: string;
  readonly groupId: string;
}

function base(scope: GroupScope): string {
  return `/organizations/${scope.organizationId}/groups/${scope.groupId}/published-schedule`;
}

/**
 * One membership's own published schedule over a range.
 *
 * The membership is in the path because the server's object policy binds to it
 * (SPEC-06 L5.1). The server still answers from the VERIFIED context's
 * membership, so this parameter is what the request is *about* rather than what
 * decides the rows — and asking about somebody else is a `404`, which
 * `SurfaceState` renders as "not found" without inventing a reason.
 */
export async function fetchPersonalSchedule(
  scope: GroupScope,
  membershipId: string,
  range: { from: string; to: string },
): Promise<PersonalSchedule> {
  // Encoded, not interpolated raw. Every one of these reaches this function from
  // a URL path parameter, so a hand-edited address is the input — and a value
  // carrying `?`, `&` or `#` would otherwise re-partition the request the client
  // is building. The server validates all three independently; this is the
  // client not constructing a URL it did not mean.
  const membership = encodeURIComponent(membershipId);
  const from = encodeURIComponent(range.from);
  const to = encodeURIComponent(range.to);
  return personalScheduleSchema.parse(
    await apiRequest(`${base(scope)}/members/${membership}?from=${from}&to=${to}`),
  );
}

/** The daily assignment sheet for one date — everybody working, not only the caller. */
export async function fetchDailySheet(scope: GroupScope, date: string): Promise<DailySheet> {
  return dailySheetSchema.parse(
    await apiRequest(`${base(scope)}/daily-sheet?date=${encodeURIComponent(date)}`),
  );
}
