import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { evaluateInTransaction } from '../../src/authz/authorize-request.js';
import { registerContextMiddleware, requireTenantContext } from '../../src/http/context/middleware.js';
import { registerCorrelationId } from '../../src/http/correlation-id.js';
import { registerErrorEnvelope } from '../../src/http/errors.js';
import type { RouteConfigWithPolicy } from '../../src/http/policy.js';
import { adminClient } from '../support/admin-client.js';
import { FIXTURE } from '../support/fixtures.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { contextHeaders, currentCounters, testPrincipalResolver } from '../support/http.js';

/**
 * **I-02, made structural: a capability route cannot SUCCEED without evaluating.**
 *
 * `scripts/gates/route-policy-check.mjs` proves every route *declares* a policy.
 * Nothing proved a handler *evaluated* it — a route could declare
 * `organization.membership.administer`, forget the `evaluateInTransaction` call,
 * and return 200 with the write committed. The declaration would look correct in
 * review, in the gate, and in the route table.
 *
 * `registerContextMiddleware`'s `onSend` guard turns exactly that into a 500. And
 * a guard that has only ever been observed **not** firing is not evidence of
 * anything, so this file registers a **deliberately non-evaluating capability
 * route** against the same middleware and drives a real, fully-authorized request
 * through it.
 *
 * ## Why a local Fastify app rather than a flag on `buildServer`
 *
 * The production server has no test seam and must not grow one — `unit-of-work.ts`
 * makes the same point about its own hot path. So the app below is assembled from
 * the same exported pieces the production server uses (`registerCorrelationId`,
 * `registerErrorEnvelope`, `registerContextMiddleware`) with two extra routes that
 * exist only here. The middleware under test is the shipped one; nothing about it
 * is stubbed.
 */

const GUARD_CONFIG = {
  policy: { kind: 'capability', capability: 'CAP-003' },
  actionScope: 'group',
  action: {
    key: 'membership.touch_self',
    moduleKey: 'core_scheduling',
    requiresObjectPolicy: false,
  },
} as const satisfies RouteConfigWithPolicy;

let app: FastifyInstance;
let runtime: Runtime;
let admin: pg.Client;

const alpha = FIXTURE.alpha;

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  runtime = createRuntime('app_runtime', { max: 3 });

  app = Fastify({ logger: false, genReqId: () => '', disableRequestLogging: true });
  registerCorrelationId(app);
  registerErrorEnvelope(app);
  registerContextMiddleware(app, {
    runtime: runtime.runner,
    principals: testPrincipalResolver,
  });

  /* The defect, shipped on purpose: a capability route whose handler never
   * consults its policy and returns a success body anyway. */
  app.post(
    '/organizations/:organizationId/groups/:groupId/guard/forgetful',
    { config: GUARD_CONFIG },
    () => ({ ok: true }),
  );

  /* Its correct twin, so the guard is shown to permit what it should. */
  app.post(
    '/organizations/:organizationId/groups/:groupId/guard/correct',
    { config: GUARD_CONFIG },
    async (request) => {
      const { context, command, route } = requireTenantContext(request);
      const decision = await request.server.tenancy.runtime.run(
        command,
        async ({ query }) => (await evaluateInTransaction(query, { request, context, route })).decision,
      );
      return { ok: decision.allowed };
    },
  );

  /* A public route: the guard's first line is `declaresCapability`, so this must
   * be untouched even though it evaluates nothing. */
  app.get('/guard/public', { config: { policy: { kind: 'public', reason: 'guard test' } } }, () => ({
    ok: true,
  }));

  await app.ready();
});

afterAll(async () => {
  await app.close();
  await runtime.destroy();
  await admin.end();
});

async function authorizedHeaders(): Promise<Record<string, string>> {
  return contextHeaders(
    alpha.users.scheduler.id,
    await currentCounters(admin, {
      organizationId: alpha.organizationId,
      groupId: alpha.groupOne.id,
      userId: alpha.users.scheduler.id,
    }),
  );
}

describe('a capability route that forgets to evaluate cannot return success', () => {
  it('the FORGETFUL route answers 500, not 200, for a fully authorized request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/groups/${alpha.groupOne.id}/guard/forgetful`,
      headers: await authorizedHeaders(),
    });

    expect(
      response.statusCode,
      'a capability route returned success without evaluating its policy (I-02)',
    ).toBe(500);
    // And the body is the fixed internal-error envelope: the guard discloses the
    // defect to the operator log, never to the caller.
    const body = response.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('The request could not be completed.');
    expect(response.body).not.toContain('membership.touch_self');
    log('a capability route that skips evaluation is converted to 500 by the onSend guard');
  });

  it('the CORRECT route answers 200 — the guard is not simply refusing everything', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/groups/${alpha.groupOne.id}/guard/correct`,
      headers: await authorizedHeaders(),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ ok: boolean }>().ok).toBe(true);
  });

  it('the guard does not touch a 4xx — a context refusal has nothing to evaluate', async () => {
    // No principal header at all: the middleware answers 401 long before any
    // handler. Converting that to a 500 would turn every unauthenticated request
    // into a server error.
    const response = await app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/groups/${alpha.groupOne.id}/guard/forgetful`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('and it does not touch a PUBLIC route, which evaluates nothing by design', async () => {
    // The guard's first line is `declaresCapability`. A guard that fired on
    // every route would break `/health` and every other public surface, so the
    // negative case is asserted rather than argued.
    const response = await app.inject({ method: 'GET', url: '/guard/public' });
    expect(response.statusCode, 'the guard broke every public route').toBe(200);
    expect(response.json<{ ok: boolean }>().ok).toBe(true);
  });
});
