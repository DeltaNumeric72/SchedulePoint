import { isUuid } from '@schedulepoint/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { preAuth } from '../../authn/policies.js';
import { sessionMatchesDeclaredOrganization } from '../../authn/principal-resolver.js';
import { sendNotFound, sendUnauthenticated } from '../context/responses.js';

/**
 * `GET /organizations/:organizationId/me/context` — the caller's OWN context.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## Why this route exists (FAD-48 grant 1)
 *
 * SPEC-01 §2.2 is a **declare/verify** contract: the client declares the tenant
 * (path segment) and the freshness counters (`X-SchedulePoint-Context`), and the
 * server verifies both. The server half has shipped since OPUS-M1-001. **The
 * client half could not exist**, because nothing on the wire ever told a browser
 * what the counters were — `organizationVersion` appeared in the reader, in the
 * snapshot resolver and in the schema, and in no response body anywhere. Every
 * browser test therefore had to intercept the API, and the join between the real
 * web app and the real server had never been exercised (EV-M4-005 §12).
 *
 * This is the missing half, and it is deliberately the SMALLEST thing that can
 * be: one read, of one's own memberships, in one's own session's organization.
 *
 * ## Why it carries no capability key
 *
 * Reading one's own context is **session authority**, not a permission: the
 * facts it returns are the facts the §2.3 sequence is about to check against the
 * caller's own session, and a caller who could not read them could not make a
 * single authorized request. That is the FAD-25 self-scoped precedent — "reading
 * one's own published schedule is SELF-SCOPED and independent of every
 * scheduler/administrator key" — applied one level lower, to the declaration
 * itself. Inventing a capability for it would mean a role could be configured
 * such that its holder can never address the API at all.
 *
 * I-02 is untouched. This is the **`preauth` class** (`apps/api/src/http/policy.ts`),
 * a declared policy that the middleware enforces from its declared stage, not an
 * undeclared route: a route with no policy still fails
 * `scripts/gates/route-policy-check.mjs`.
 *
 * ## Four things it refuses, each tested rather than promised
 *
 *  1. **No session → 401.** Enforced by the middleware from `stage: 'session-any'`,
 *     before this handler runs.
 *  2. **A session that has not satisfied its MFA challenge → 401.** `session-any`
 *     is the widest stage the vocabulary has and it admits a half-authenticated
 *     session, which is right for sign-out and wrong for this. There is no
 *     `session-full` stage and adding one would change `policy.ts`, so the
 *     requirement is enforced here, explicitly and fail-closed.
 *  3. **A session issued for another organization → 404.** The same cross-check
 *     `principal-resolver.ts` documents: a session belonging to organization A
 *     presented on organization B's URL is refused rather than being allowed to
 *     satisfy a membership the person happens to hold in B.
 *  4. **Another user's memberships → unreachable.** There is no user parameter on
 *     this route, in the path or anywhere else. The subject is always
 *     `session.userId`, read from the server-side session row. A caller cannot
 *     name somebody else, so there is no request that could return somebody
 *     else's rows — and `me-context.test.ts` probes exactly that with two users
 *     in one organization.
 *
 * ## I-19 — the counters and the memberships come from ONE unit of work
 *
 * Every read below happens inside a single `runtime.run`, so the counters
 * returned are the counters that were true for the membership set returned, in
 * one snapshot, under RLS. Two units of work would let a membership change land
 * between them and hand the client a declaration that was never simultaneously
 * true — which the client would then declare, and §2.3 step 4 would reject with
 * a `409` the client could not learn its way out of.
 *
 * ## Why an organization-scoped context can read a GROUP membership
 *
 * `0001_tenancy_core.sql`'s third membership policy — EX-2,
 * `memberships_organization_read` — grants `SELECT` on every membership in the
 * organization **under an organization-scoped context only**. That is what makes
 * this one read able to enumerate the caller's group memberships without first
 * knowing which groups to ask about. Under a group-scoped context it would see
 * one group and could never bootstrap.
 *
 * The breadth of that grant is why this handler filters by `session.userId` in
 * SQL as well: RLS confines the rows to the organization, and the predicate
 * confines them to the caller. Neither alone is the control here; the response
 * body is the only place in the codebase where an EX-2 read reaches a caller, so
 * it carries both.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** A membership of the caller, with the group counter its declarations need. */
export interface MeContextMembership {
  readonly membershipId: string;
  readonly kind: 'organization' | 'group';
  /** `null` for an organization membership. */
  readonly groupId: string | null;
  /** `null` for an organization membership — there is no group to be fresh about. */
  readonly groupVersion: number | null;
  readonly status: string;
  readonly organizationRole: string | null;
  readonly groupRole: string | null;
}

/**
 * The response body.
 *
 * Deliberately NOT added to `packages/contracts`: FAD-48's allowed-file
 * extension names this route file and `apps/web/src/api/client.ts` (+ a context
 * module), and nothing else. The web half parses the same shape with its own
 * narrow guard in `apps/web/src/api/context.ts`, and each side says so. If a
 * later packet owns `packages/contracts/src/context.ts`, the two collapse into
 * one zod schema there — that is a consolidation, not a redesign.
 */
export interface MeContextResponse {
  readonly organizationId: string;
  readonly userId: string;
  readonly organizationVersion: number;
  readonly membershipSetVersion: number;
  /** The CURRENT epoch from `users`, which is what §2.3 step 5 compares against. */
  readonly sessionEpoch: number;
  readonly memberships: readonly MeContextMembership[];
}

interface OrganizationRow {
  id: string;
  status: string;
  organization_version: string | number;
}

interface UserRow {
  id: string;
  status: string;
  membership_set_version: string | number;
  session_epoch: string | number;
}

interface MembershipRow {
  id: string;
  kind: string;
  group_id: string | null;
  status: string;
  organization_role: string | null;
  group_role: string | null;
}

interface GroupRow {
  id: string;
  status: string;
  group_version: string | number;
}

/**
 * `bigint` arrives from `pg` as a string. Mirrors `context/snapshot.ts`'s
 * `counter`, deliberately including the safe-integer refusal: a counter that
 * cannot round-trip through a JSON number would produce a declaration the
 * server can never match, and a loud 500 is a better answer than a client stuck
 * in a re-fetch loop.
 */
function counter(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error('a freshness counter exceeded the safe integer range');
  }
  return parsed;
}

function declaredOrganizationId(request: FastifyRequest): string | undefined {
  const value = (request.params as { organizationId?: unknown } | undefined)?.organizationId;
  return typeof value === 'string' && isUuid(value) ? value : undefined;
}

export default function registerMeContextRoutes(app: FastifyInstance): void {
  app.get(
    '/organizations/:organizationId/me/context',
    {
      config: {
        policy: preAuth(
          'session-any',
          'Reading ones own context is session authority, not a permission: it returns the ' +
            'freshness counters the SPEC-01 §2.3 sequence is about to check against this very ' +
            'session, and a caller who cannot read them cannot make one authorized request. ' +
            'The FAD-25 self-scoped precedent, applied to the declaration itself. The stage is ' +
            'session-any because the vocabulary has no fuller one; a session that has not ' +
            'satisfied its challenge is refused in the handler.',
        ),
      },
    },
    async (request, reply) => {
      const organizationId = declaredOrganizationId(request);
      const session = request.authnSession;
      const principal = request.preAuthPrincipal;
      if (organizationId === undefined || session === undefined || principal === undefined) {
        return sendNotFound(request, reply);
      }
      if (!sessionMatchesDeclaredOrganization(session, organizationId)) {
        return sendNotFound(request, reply);
      }
      if (session.mfaSatisfied !== true) {
        return sendUnauthenticated(
          request,
          reply,
          'the session has not satisfied its challenge and may not read its context',
        );
      }

      const body = await app.tenancy.runtime.run(
        {
          organizationId,
          // Organization-scoped, and that is load-bearing: it is the only context
          // under which EX-2's organization-wide membership SELECT applies, which
          // is what lets one read enumerate the caller's GROUP memberships.
          groupId: null,
          // No membership is resolved — resolving one is what this read is for.
          membershipId: null,
          correlationId: request.correlationId,
        },
        async ({ query }): Promise<MeContextResponse | undefined> => {
          const organizationRows = await query
            .selectFrom('organizations')
            .select(['id', 'status', 'organization_version'])
            .where('id', '=', organizationId)
            .execute();
          const organization = organizationRows[0] as OrganizationRow | undefined;
          if (organization === undefined || organization.status !== 'active') return undefined;

          const userRows = await query
            .selectFrom('users')
            .select(['id', 'status', 'membership_set_version', 'session_epoch'])
            .where('id', '=', session.userId)
            .execute();
          const user = userRows[0] as UserRow | undefined;
          if (user === undefined || user.status !== 'active') return undefined;

          const membershipRows = (await query
            .selectFrom('memberships')
            .select(['id', 'kind', 'group_id', 'status', 'organization_role', 'group_role'])
            .where('user_id', '=', session.userId)
            .where('organization_id', '=', organizationId)
            .execute()) as MembershipRow[];

          /* ── FAD-50 N-7: the caller's OWN groups, and no others ────────────
           *
           * This used to select every active group in the organization and build
           * a counter map from all of them. Only the caller's membership groups
           * are ever read out of that map — the loop below looks up
           * `row.group_id` for memberships this user holds — so the extra rows
           * were fetched, held and discarded. That is a wider read than the
           * answer needs, and this endpoint's whole authorization argument is
           * FAD-25's SELF-SCOPE: it is `session-any` because it returns the
           * caller's own declaration material. A map built from groups the
           * caller is not a member of is not that.
           *
           * Narrowed at the query. The `in` list is the caller's own membership
           * group ids, so the widest thing this read can now touch is the set of
           * groups it is about to answer for. */
          const ownGroupIds = [
            ...new Set(
              membershipRows
                .map((row) => row.group_id)
                .filter((id): id is string => id !== null),
            ),
          ];
          const groupRows =
            ownGroupIds.length === 0
              ? []
              : ((await query
                  .selectFrom('groups')
                  .select(['id', 'status', 'group_version'])
                  .where('organization_id', '=', organizationId)
                  .where('id', 'in', ownGroupIds)
                  .execute()) as GroupRow[]);
          const groupVersions = new Map<string, number>(
            groupRows
              .filter((row) => row.status === 'active')
              .map((row) => [row.id, counter(row.group_version)] as const),
          );

          const memberships: MeContextMembership[] = [];
          for (const row of membershipRows) {
            const kind = row.kind === 'organization' ? 'organization' : 'group';
            const groupVersion =
              row.group_id === null ? null : (groupVersions.get(row.group_id) ?? null);
            // A group membership whose group is inactive or unreadable carries no
            // usable declaration. It is omitted rather than returned with a null
            // counter, because a null there would be a VALID organization-scoped
            // declaration and the client would send it on a group-scoped request.
            if (kind === 'group' && groupVersion === null) continue;
            memberships.push({
              membershipId: row.id,
              kind,
              groupId: row.group_id,
              groupVersion,
              status: row.status,
              organizationRole: row.organization_role,
              groupRole: row.group_role,
            });
          }

          return {
            organizationId,
            userId: user.id,
            organizationVersion: counter(organization.organization_version),
            membershipSetVersion: counter(user.membership_set_version),
            sessionEpoch: counter(user.session_epoch),
            memberships,
          };
        },
      );

      // An organization or principal that is not usable answers exactly like one
      // that does not exist (§2.4, T-05b). A distinct code would be the
      // disclosure.
      if (body === undefined) return sendNotFound(request, reply);
      return reply.code(200).send(body);
    },
  );
}
