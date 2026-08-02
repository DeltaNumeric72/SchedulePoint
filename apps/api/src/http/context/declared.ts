import { CONTEXT_HEADER, contextHeaderSchema } from '@schedulepoint/contracts';
import type { ActionScope, DeclaredContext, Principal } from '@schedulepoint/domain';
import type { FastifyRequest } from 'fastify';

/**
 * SPEC-01 §2.2 — reading the client's declaration off the wire.
 *
 * Two carriers, both required:
 *
 *  - the **path segment** `/organizations/{org}[/groups/{group}]`, which
 *    identifies the tenant;
 *  - the **`X-SchedulePoint-Context` header**, which carries the freshness
 *    counters. "The path segment is not sufficient on its own — it identifies
 *    the tenant but not the freshness. Both are required."
 *
 * Nothing here trusts anything. `expected_*` is *declared* by the client and
 * *verified* by the server (I-14); this module's whole job is to get the
 * declaration into a typed value so the verification sequence can reject it.
 *
 * The one thing this module must never do is **substitute**. If the group
 * segment is missing on a group-scoped route, `expectedGroupId` is `null` and
 * step 3 rejects it — it is not filled in from a session, a cookie, a default,
 * or "the user's only group". That substitution is CAR-001.
 */

export type DeclarationProblem =
  | 'CONTEXT_HEADER_MISSING'
  | 'CONTEXT_HEADER_MALFORMED'
  | 'ORGANIZATION_SEGMENT_MISSING'
  | 'ORGANIZATION_SEGMENT_MALFORMED'
  | 'GROUP_SEGMENT_MALFORMED';

export type DeclarationOutcome =
  | { readonly ok: true; readonly declared: DeclaredContext }
  | { readonly ok: false; readonly problem: DeclarationProblem };

/**
 * A UUID, in the one canonical form the system emits.
 *
 * Deliberately strict rather than permissive: PostgreSQL accepts several
 * spellings of a UUID, so a lax parser here would let two textually different
 * declarations name the same row — and any comparison this server does in
 * TypeScript (`target.organizationId !== ctx.expectedOrganizationId`) is a
 * string comparison.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function pathParam(request: FastifyRequest, name: string): string | undefined {
  const params = request.params as Record<string, unknown> | undefined;
  const value = params?.[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function readDeclaredContext(
  request: FastifyRequest,
  principal: Principal,
  actionScope: ActionScope,
): DeclarationOutcome {
  const organizationId = pathParam(request, 'organizationId');
  if (organizationId === undefined) return { ok: false, problem: 'ORGANIZATION_SEGMENT_MISSING' };
  if (!UUID.test(organizationId)) return { ok: false, problem: 'ORGANIZATION_SEGMENT_MALFORMED' };

  const groupSegment = pathParam(request, 'groupId');
  if (groupSegment !== undefined && !UUID.test(groupSegment)) {
    return { ok: false, problem: 'GROUP_SEGMENT_MALFORMED' };
  }

  // The declaration is reported EXACTLY as the client made it, for both scopes.
  //
  // The scope itself comes from the ROUTE, never from the shape of the URL, and
  // the two are compared at step 3: a group-scoped route reached without a group
  // segment declares a null group and is rejected (T-06d), and an
  // organization-scoped route that somehow carried a group segment is rejected
  // too. Neither is quietly reinterpreted as the other scope, which is the whole
  // point of V-06 — "the branch is selected by the route's declared scope, never
  // by the presence or absence of the field".
  const expectedGroupId = groupSegment ?? null;

  const raw = request.headers[CONTEXT_HEADER];
  const headerValue = Array.isArray(raw) ? raw[0] : raw;
  if (typeof headerValue !== 'string' || headerValue.length === 0) {
    return { ok: false, problem: 'CONTEXT_HEADER_MISSING' };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(headerValue);
  } catch {
    return { ok: false, problem: 'CONTEXT_HEADER_MALFORMED' };
  }

  const parsed = contextHeaderSchema.safeParse(parsedJson);
  if (!parsed.success) return { ok: false, problem: 'CONTEXT_HEADER_MALFORMED' };

  return {
    ok: true,
    declared: {
      principalUserId: principal.userId,
      actionScope,
      expectedOrganizationId: organizationId,
      expectedGroupId,
      contextVersion: {
        organizationVersion: parsed.data.contextVersion.organizationVersion,
        groupVersion: parsed.data.contextVersion.groupVersion,
        membershipSetVersion: parsed.data.contextVersion.membershipSetVersion,
      },
      sessionEpoch: parsed.data.sessionEpoch,
      correlationId: request.correlationId,
      // Impersonation and proxy are SPEC-06 §3.2/§3.3 and land with the
      // evaluator. Declaring the field as always-null now keeps the tuple whole
      // rather than optional, so nothing has to be retrofitted into audit rows.
      onBehalfOfMembershipId: null,
    },
  };
}
