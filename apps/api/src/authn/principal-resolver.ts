import type { PrincipalResolution, PrincipalResolver } from '@schedulepoint/domain';
import type { FastifyRequest } from 'fastify';

import type { PgUnitOfWorkRunner } from '../db/unit-of-work.js';
import { readSessionCookie } from './cookies.js';
import type { AuthnService } from './service.js';
import type { SessionRow } from './store.js';
import { decodeSessionCookie } from './tokens.js';

/**
 * The production principal resolver — SPEC-01 §2.1's "server-side session".
 *
 * ## What replaced `denyAllPrincipalResolver`, and what did not
 *
 * OPUS-M1-001 shipped a resolver that denied everything, with a docblock saying
 * so was the correct fail-closed default until a session store existed. It now
 * exists, and this is it. **What has NOT changed** is the absence of any
 * header-based, environment-variable-based or query-parameter-based principal:
 * there is still exactly one way to be authenticated in a production process,
 * and it is a cookie that names a row in `sessions`.
 *
 * The test harness still injects its own resolver through `buildServer`, so the
 * bypass exists only in the test process and cannot be switched on anywhere else.
 *
 * ## The tenant context comes from the COOKIE, and that is not a hole
 *
 * `sessions` is organization-tenanted, so the lookup needs a tenant context
 * before it can run — which is one step earlier than SPEC-01's usual point of
 * declaration. The cookie carries `<organization_id>.<secret>` and the
 * organization id is used as the DECLARED tenant for the lookup's unit of work.
 *
 * That is client-declared and server-verified in exactly SPEC-01's sense:
 *
 *  - declaring another organization does not widen anything. RLS scopes the
 *    lookup to the declared organization, and the token hash is 256 bits of
 *    `randomBytes`, so a session in organization A is simply not there when
 *    organization B is declared;
 *  - the organization the URL declares is verified INDEPENDENTLY, by the §2.3
 *    sequence, against the principal's memberships;
 *  - and the two are cross-checked below: a session issued for organization A
 *    presented on a URL for organization B is refused, rather than being allowed
 *    to satisfy §2.3 through a membership the person happens to hold in B.
 *
 * The last check is the one a reviewer should try to break. Without it, a person
 * with memberships in two organizations could authenticate against one and act
 * in the other with a session the second organization never issued — which is
 * not a tenant leak, but is a session that outlives the tenant it belongs to.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The resolved session row. Present only when the cookie named a live one.
     *
     * Carries no token and no hash: `SessionRow` has neither, by construction.
     */
    authnSession?: SessionRow;
  }
}

export interface SessionPrincipalResolverOptions {
  readonly runtime: PgUnitOfWorkRunner;
  readonly authn: AuthnService;
}

export class SessionPrincipalResolver implements PrincipalResolver {
  readonly #runtime: PgUnitOfWorkRunner;
  readonly #authn: AuthnService;

  constructor(options: SessionPrincipalResolverOptions) {
    this.#runtime = options.runtime;
    this.#authn = options.authn;
  }

  async resolve(request: unknown): Promise<PrincipalResolution> {
    const typed = request as FastifyRequest;
    const cookie = readSessionCookie(typed);
    if (cookie === undefined) {
      return { authenticated: false, reason: 'no session cookie was presented' };
    }
    const decoded = decodeSessionCookie(cookie);
    if (decoded === undefined) {
      // A malformed cookie never reaches a query. The shape check is in
      // `decodeSessionCookie` and it is deliberately strict about length and
      // alphabet: a value that is not a token is not a token that is wrong.
      return { authenticated: false, reason: 'the session cookie is malformed' };
    }

    const session = await this.#lookUp(decoded.organizationId, decoded.secret, typed);
    if (session === undefined) {
      return { authenticated: false, reason: 'the session is unknown, expired or revoked' };
    }

    typed.authnSession = session;
    return {
      authenticated: true,
      principal: {
        userId: session.userId,
        // The epoch the session was ISSUED under. SPEC-01 §2.3 step 5 compares
        // the client's declared epoch against the CURRENT one in `users`, so a
        // bump since issue surfaces there as `409 SESSION_STALE` — a recoverable
        // reload — while a bump that also revoked the session surfaces here as
        // an unknown session. Two mechanisms, two different user experiences,
        // and both are deliberate.
        sessionEpoch: Number(session.sessionEpochAtIssue),
      },
    };
  }

  async #lookUp(
    organizationId: string,
    secret: string,
    request: FastifyRequest,
  ): Promise<SessionRow | undefined> {
    try {
      return await this.#runtime.run(
        {
          organizationId,
          groupId: null,
          // Nobody is resolved yet — that is what this lookup is for. The audit
          // recorder refuses to attribute an event to an unresolved membership,
          // which is why nothing in this path records one.
          membershipId: null,
          correlationId: request.correlationId,
        },
        (uow) => this.#authn.resolveSession(uow, secret),
      );
    } catch (error) {
      // A failed lookup is an unauthenticated request, not a 500 with a stack.
      // The error is logged for an operator and the client is told nothing.
      request.log.warn(
        { correlationId: request.correlationId, error: (error as Error).name },
        'session lookup failed',
      );
      return undefined;
    }
  }
}

/**
 * Refuses a session that belongs to a different organization than the URL
 * declares.
 *
 * Exported and called from the route layer rather than folded into `resolve`,
 * because `resolve` runs before the declared context is parsed and has no
 * business parsing it. See the header for why this check is load-bearing.
 */
export function sessionMatchesDeclaredOrganization(
  session: SessionRow,
  declaredOrganizationId: string,
): boolean {
  return session.organizationId === declaredOrganizationId;
}
