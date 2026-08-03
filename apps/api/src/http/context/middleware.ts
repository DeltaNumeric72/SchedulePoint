import {
  verifyDeclaredContext,
  type DeclaredContext,
  type PrincipalResolver,
  type RequestContext,
  type TenantContext,
} from '@schedulepoint/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { PgUnitOfWorkRunner } from '../../db/unit-of-work.js';
import { capabilityRouteConfig, declaresCapability, type CapabilityRouteConfig } from '../policy.js';
import { readDeclaredContext } from './declared.js';
import {
  sendContextFailure,
  sendContextMalformed,
  sendNotFound,
  sendUnauthenticated,
} from './responses.js';
import { commandContext, resolveContextSnapshot } from './snapshot.js';

/**
 * The SPEC-01 §2.3 middleware.
 *
 * ## It is global, and that is the design
 *
 * The hook is registered once, for every route, and decides what to do from the
 * route's own declaration. A per-route opt-in would mean a new route is
 * unprotected until somebody remembers to add the middleware, and "somebody
 * remembers" is not a control. Concretely:
 *
 *  - `public` / `internal` route → no tenant context, nothing to verify;
 *  - `capability` route, well-formed declaration → the full §2.3 sequence runs;
 *  - `capability` route with a **missing or malformed** `actionScope` or
 *    `provisional` block → the request is **refused**. A route that asks for a
 *    capability and forgets to say at what scope fails closed, loudly, on its
 *    first request rather than defaulting to something plausible.
 *
 * ## What a handler gets, and what it cannot get
 *
 * On success the request carries `tenantContext` (the verified, immutable §2.1
 * tuple) and `commandContext` (the four settings a unit of work needs, with the
 * membership resolved at step 2). It carries **no** connection, **no** pool and
 * **no** query handle: the only way to reach a tenant table is
 * `app.tenancy.runtime.run(request.commandContext, …)`, which is the unit of
 * work (I-15).
 *
 * Nothing anywhere reads a session-global "active organization" or "active
 * group" — SPEC-01 §3.1 deleted the concept, and its absence is the CAR-001
 * remediation.
 * `apps/api/test/architecture/no-tenant-access-outside-unit-of-work.test.ts`,
 * describe block "no ambient tenant state (SPEC-01 §3.1)", asserts the absence
 * rather than trusting it.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** The verified §2.1 tuple. Present only after the sequence passes. */
    tenantContext?: RequestContext;
    /** The four transaction-local settings for the command's unit of work. */
    commandContext?: TenantContext;
    /** The route's capability declaration, narrowed. */
    routeCapability?: CapabilityRouteConfig;
    /**
     * Set by `evaluateInTransaction`, read by the `onSend` guard below.
     *
     * I-02 says an operation with no policy "fails closed". The route-policy
     * gate proves every route *declares* one; this proves every capability route
     * that *succeeds* actually **evaluated** it.
     */
    authorizationEvaluated?: boolean;
  }

  interface FastifyInstance {
    /**
     * `undefined` when the process was built without a database — the
     * route-enumeration path. Capability routes then answer `503`.
     */
    tenancy: TenancyRuntime;
  }
}

export interface TenancyRuntime {
  readonly runtime: PgUnitOfWorkRunner;
  readonly principals: PrincipalResolver;
}

/** Reads the route's `config` object in a Fastify-version-independent way. */
function routeConfigOf(request: FastifyRequest): unknown {
  return (request.routeOptions as { config?: unknown } | undefined)?.config;
}

export function registerContextMiddleware(
  app: FastifyInstance,
  tenancy: TenancyRuntime | undefined,
): void {
  app.decorate('tenancy', tenancy as TenancyRuntime);

  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const rawConfig = routeConfigOf(request);

    // Public and internal routes address no tenant. They are still policy-
    // declared — the route-policy gate proves that — they simply have no context
    // to verify.
    if (!declaresCapability(rawConfig)) return;

    // No database: the route-enumeration path. A capability route must not be
    // served at all, and 503 says why without pretending the resource is absent.
    if ((app.tenancy as TenancyRuntime | undefined) === undefined) {
      await reply.code(503).send({
        error: {
          code: 'TENANCY_UNAVAILABLE',
          message: 'The request could not be completed.',
          correlationId: request.correlationId,
        },
      });
      return reply;
    }

    const config = capabilityRouteConfig(rawConfig);
    if (config === undefined) {
      // A capability route whose scope or provisional block is missing or
      // malformed. Fail closed, and make it a 500 rather than a 4xx: this is a
      // defect in the server, not in the request, and a 404 would let it hide.
      request.log.error(
        { correlationId: request.correlationId, url: request.url },
        'capability route is missing a well-formed actionScope or provisional declaration',
      );
      await reply
        .code(500)
        .send({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'The request could not be completed.',
            correlationId: request.correlationId,
          },
        });
      return reply;
    }
    request.routeCapability = config;

    /* ── the principal (SPEC-01 §2.1: server-side session) ─────────────────── */
    const resolution = await app.tenancy.principals.resolve(request);
    if (!resolution.authenticated) {
      await sendUnauthenticated(request, reply, resolution.reason);
      return reply;
    }

    /* ── the declaration (§2.2) ────────────────────────────────────────────── */
    const declaration = readDeclaredContext(request, resolution.principal, config.actionScope);
    if (!declaration.ok) {
      // A missing organization segment on a capability route is a routing
      // defect, not a client error; everything else is a malformed declaration.
      if (declaration.problem === 'ORGANIZATION_SEGMENT_MISSING') {
        request.log.error(
          { correlationId: request.correlationId, url: request.url },
          'capability route has no organizationId path parameter',
        );
        await sendNotFound(request, reply);
        return reply;
      }
      await sendContextMalformed(request, reply, declaration.problem);
      return reply;
    }
    const declared: DeclaredContext = declaration.declared;

    /* ── steps 1–5, against a snapshot read inside a unit of work (§3) ─────── */
    const snapshot = await resolveContextSnapshot(app.tenancy.runtime, declared);
    const verification = verifyDeclaredContext(declared, snapshot);

    if (!verification.ok) {
      await sendContextFailure(request, reply, verification.failure, {
        principalUserId: declared.principalUserId,
        organizationId: declared.expectedOrganizationId,
        groupId: declared.expectedGroupId,
      });
      return reply;
    }

    request.tenantContext = verification.context;
    request.commandContext = commandContext(declared, verification.context.membershipId);
    return;
  });

  /* ────────────────────────────────────────────────────────────────────────
   * The fail-closed guard: a capability route cannot SUCCEED without having
   * evaluated its policy.
   *
   * I-02: "an operation with no policy fails closed and fails its automated
   * test". `scripts/gates/route-policy-check.mjs` proves every route DECLARES a
   * policy. Nothing proved that a handler actually EVALUATED it — a route could
   * declare `organization.membership.administer`, forget the
   * `evaluateInTransaction` call, and return 200 with the write committed. The
   * declaration would look correct in review and in the gate.
   *
   * So the guard is structural rather than editorial: a `capability` route that
   * returns a 2xx without `authorizationEvaluated` becomes a **500**, and the
   * defect is logged as a server error. It cannot be satisfied by remembering.
   *
   * It runs on `onSend` rather than `onResponse` because the response must be
   * REPLACED, not merely reported. And it deliberately does not touch 4xx or
   * 5xx: a request refused by the context sequence never reached a handler and
   * has nothing to evaluate.
   *
   * Proven by `apps/api/test/authz/fail-closed-guard.test.ts`, which registers a
   * deliberately non-evaluating capability route against this same middleware.
   * ──────────────────────────────────────────────────────────────────────── */
  app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    if (!declaresCapability(routeConfigOf(request))) return payload;
    if (reply.statusCode >= 400) return payload;
    if (request.authorizationEvaluated === true) return payload;

    request.log.error(
      { correlationId: request.correlationId, url: request.url, method: request.method },
      'a capability route produced a success response without evaluating its policy (I-02)',
    );
    reply.code(500).type('application/json');
    return JSON.stringify({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The request could not be completed.',
        correlationId: request.correlationId,
      },
    });
  });
}

/**
 * The verified context, or a throw.
 *
 * A handler that reaches this without a context has been reached without the
 * middleware, which cannot happen through the registered hook. It throws rather
 * than returning `undefined` so the failure is a 500 and not a silently
 * unauthenticated execution.
 */
export function requireTenantContext(request: FastifyRequest): {
  context: RequestContext;
  command: TenantContext;
  route: CapabilityRouteConfig;
} {
  const context = request.tenantContext;
  const command = request.commandContext;
  const route = request.routeCapability;
  if (context === undefined || command === undefined || route === undefined) {
    throw new Error(
      'handler reached without a verified tenant context — the SPEC-01 §2.3 middleware did not run',
    );
  }
  return { context, command, route };
}
