import {
  activationRequestSchema,
  changeLoginEmailRequestSchema,
  isUuid,
  issueInvitationRequestSchema,
  mfaChallengeRequestSchema,
  mfaEnrolmentConfirmRequestSchema,
  passwordResetCompleteSchema,
  passwordResetRequestSchema,
  resetMfaRequestSchema,
  signInRequestSchema,
} from '@schedulepoint/contracts';
import type { TenantContext } from '@schedulepoint/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { AuthnError } from '../../authn/errors.js';
import { clearSessionCookie, setSessionCookie } from '../../authn/cookies.js';
import { sessionMatchesDeclaredOrganization } from '../../authn/principal-resolver.js';
import * as store from '../../authn/store.js';
import { evaluateInTransaction, respondToDenial } from '../../authz/authorize-request.js';
import { requireTenantContext } from '../context/middleware.js';
import { sendNotFound } from '../context/responses.js';
import {
  ADMINISTER_SESSIONS_CONFIG,
  CHANGE_LOGIN_EMAIL_CONFIG,
  INVITATION_CONFIG,
  RESET_MFA_CONFIG,
  preAuth,
} from '../../authn/policies.js';

/**
 * The authentication surface.
 *
 * ## Two classes of route, and the boundary between them is the point
 *
 * | Class | Declared | Guarded by |
 * |---|---|---|
 * | `preauth` | `policy: { kind: 'preauth', stage, reason }` | the middleware, from the declared stage |
 * | `capability` | `policy: { kind: 'capability', … } + action` | the SPEC-06 evaluator, in the same unit of work as the mutation |
 *
 * **No pre-auth route names another user.** Not one has a `:userId` segment and
 * no pre-auth body schema carries a user identifier, so there is no request in
 * this class that could act on somebody else's account — the subject is always
 * the session or the token that was presented.
 * `apps/api/test/authn/preauth-policy.test.ts` asserts that over the REGISTERED
 * route table rather than over a list kept here.
 *
 * ## The tenant context of a pre-auth route
 *
 * It comes from the `:organizationId` path segment, unverified, and it is used
 * as the DECLARED tenant of a unit of work. That is SPEC-01's client-declared /
 * server-verified pattern: RLS scopes everything the handler can see to the
 * declared organization, and the verification is the credential check itself.
 * Declaring another organization buys nothing — the credential is not there.
 *
 * The segment IS checked for shape first (`isUuid`), because a malformed one
 * would otherwise reach `set_config` and raise `22P02` inside the wrapper
 * (OPUS-M2-004 review finding V-02).
 *
 * ## Errors
 *
 * `AuthnError` carries a fixed message and a five-value code, and
 * `respondToAuthnError` writes exactly those. `internalReason` never reaches the
 * wire; it is logged for an operator and audited where an audited event exists.
 */

/** The declared organization, as a shape-checked path segment. */
function declaredOrganizationId(request: FastifyRequest): string | undefined {
  const value = (request.params as { organizationId?: unknown } | undefined)?.organizationId;
  return typeof value === 'string' && isUuid(value) ? value : undefined;
}

function preAuthCommand(request: FastifyRequest, organizationId: string): TenantContext {
  return {
    organizationId,
    groupId: null,
    // No membership is resolved on this surface. The audit recorder refuses to
    // attribute an event to an unresolved membership, so every audit write on
    // these paths declares `systemActor` and means it.
    membershipId: null,
    correlationId: request.correlationId,
  };
}

function respondToAuthnError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: AuthnError,
): FastifyReply {
  // Operator-facing only. The internal reason is the ONE place the distinction
  // 14 §2 refuses to put on the wire is recorded outside the audit chain.
  request.log.info(
    {
      correlationId: request.correlationId,
      authn: { code: error.code, internalReason: error.internalReason },
    },
    'authentication refused',
  );
  return reply.code(error.status).send({
    error: {
      code: error.code,
      message: error.message,
      correlationId: request.correlationId,
    },
  });
}

/**
 * Runs a pre-auth command, and **commits the transaction even when the command
 * fails**.
 *
 * ## This shape is a defect fix, not a style
 *
 * The first version let `AuthnError` propagate out of `runtime.run`, which
 * rolled the transaction back — and took the FAILED-ATTEMPT RECORD with it.
 * Lockout counted to zero forever and `authn.sign_in.failed` was never
 * persisted: T-22's control and the audit trail of a credential-stuffing run
 * both silently absent, while every test that only checked the 401 passed.
 * Found by asserting `users.failed_sign_in_count` after six failures.
 *
 * So the error is caught INSIDE the unit of work and returned as a value. The
 * transaction commits with the failure recorded; the route then answers from the
 * error. Nothing else changes — a non-`AuthnError` still propagates and still
 * rolls back, because an unexpected fault must not commit a partial write.
 */
async function withAuthn<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string,
  run: (uow: Parameters<Parameters<FastifyInstance['tenancy']['runtime']['run']>[1]>[0]) => Promise<T>,
): Promise<T | undefined> {
  const outcome = await request.server.tenancy.runtime.run(
    preAuthCommand(request, organizationId),
    async (uow): Promise<{ ok: true; value: T } | { ok: false; error: AuthnError }> => {
      try {
        return { ok: true, value: await run(uow) };
      } catch (error) {
        if (error instanceof AuthnError) return { ok: false, error };
        throw error;
      }
    },
  );
  if (outcome.ok) return outcome.value;
  respondToAuthnError(request, reply, outcome.error);
  return undefined;
}

export default function registerAuthnRoutes(app: FastifyInstance): void {
  /* ────────────────────────────────────────────────────────────────────────
   * Sign in
   * ──────────────────────────────────────────────────────────────────────── */

  app.post(
    '/organizations/:organizationId/authn/sign-in',
    {
      config: {
        policy: preAuth(
          'anonymous',
          'Sign-in is what produces a principal; there is nothing yet for a capability to be ' +
            'evaluated against. The credential check IS the verification.',
        ),
      },
    },
    async (request, reply) => {
      const organizationId = declaredOrganizationId(request);
      if (organizationId === undefined) return sendNotFound(request, reply);

      const parsed = signInRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        // A malformed sign-in body answers exactly like a wrong credential.
        // Telling a caller which field they got wrong on THIS route is a free
        // probe of the account namespace.
        return reply.code(401).send({
          error: {
            code: 'AUTHN_FAILED',
            message: 'Those sign-in details were not accepted.',
            correlationId: request.correlationId,
          },
        });
      }

      const result = await withAuthn(request, reply, organizationId, (uow) =>
        app.authn.signIn(uow, {
          loginEmail: parsed.data.loginEmail,
          password: parsed.data.password,
          ...(parsed.data.persistent === undefined ? {} : { persistent: parsed.data.persistent }),
        }),
      );
      if (result === undefined) return reply;

      setSessionCookie(reply, {
        organizationId,
        secret: result.token,
        expiresAt: result.absoluteExpiresAt,
        persistent: parsed.data.persistent === true,
      });
      return reply.code(200).send({
        state: result.state,
        absoluteExpiresAt: result.absoluteExpiresAt.toISOString(),
      });
    },
  );

  /* ────────────────────────────────────────────────────────────────────────
   * Sign out
   * ──────────────────────────────────────────────────────────────────────── */

  app.post(
    '/organizations/:organizationId/authn/sign-out',
    {
      config: {
        policy: preAuth(
          'session-any',
          'Sign-out acts only on the presented session and must work for one that has not ' +
            'satisfied its challenge — a half-authenticated session that cannot be ended is a ' +
            'session that has to expire instead.',
        ),
      },
    },
    async (request, reply) => {
      const organizationId = declaredOrganizationId(request);
      const session = request.authnSession;
      if (organizationId === undefined || session === undefined) {
        return sendNotFound(request, reply);
      }
      if (!sessionMatchesDeclaredOrganization(session, organizationId)) {
        return sendNotFound(request, reply);
      }
      await withAuthn(request, reply, organizationId, (uow) => app.authn.signOut(uow, session.id));
      clearSessionCookie(reply);
      return reply.code(204).send();
    },
  );

  /* ────────────────────────────────────────────────────────────────────────
   * Multi-factor: enrolment and challenge, for the CALLER'S OWN account only
   * ──────────────────────────────────────────────────────────────────────── */

  app.post(
    '/organizations/:organizationId/authn/mfa/enrolment',
    {
      config: {
        policy: preAuth(
          'session-partial',
          "Enrolling one's own second factor is a step of authentication, not a tenant action: " +
            'an elevated role cannot complete sign-in until it has enrolled, so requiring a ' +
            'capability here would be a cycle. The subject is always the session holder.',
        ),
      },
    },
    async (request, reply) => {
      const organizationId = declaredOrganizationId(request);
      const session = request.authnSession;
      if (
        organizationId === undefined ||
        session === undefined ||
        !sessionMatchesDeclaredOrganization(session, organizationId)
      ) {
        return sendNotFound(request, reply);
      }
      const result = await withAuthn(request, reply, organizationId, async (uow) => {
        const credential = await store.findCredentialById(uow, session.userId);
        return app.authn.startMfaEnrolment(uow, {
          userId: session.userId,
          // The label is the login email, which is what an authenticator app
          // shows. It is the caller's OWN address; no other user's can be named.
          label: credential?.loginEmail ?? session.userId,
        });
      });
      if (result === undefined) return reply;
      return reply.code(200).send(result);
    },
  );

  app.post(
    '/organizations/:organizationId/authn/mfa/enrolment/confirmation',
    {
      config: {
        policy: preAuth(
          'session-partial',
          'Confirms the enrolment started on this session with a valid code. Same reasoning as ' +
            'the enrolment route; the subject is the session holder.',
        ),
      },
    },
    async (request, reply) => {
      const organizationId = declaredOrganizationId(request);
      const session = request.authnSession;
      if (
        organizationId === undefined ||
        session === undefined ||
        !sessionMatchesDeclaredOrganization(session, organizationId)
      ) {
        return sendNotFound(request, reply);
      }
      const parsed = mfaEnrolmentConfirmRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(401).send({
          error: {
            code: 'AUTHN_FAILED',
            message: 'Those sign-in details were not accepted.',
            correlationId: request.correlationId,
          },
        });
      }
      const result = await withAuthn(request, reply, organizationId, (uow) =>
        app.authn.confirmMfaEnrolment(uow, { userId: session.userId, code: parsed.data.code }),
      );
      if (result === undefined) return reply;
      return reply.code(200).send({ recoveryCodes: result.recoveryCodes });
    },
  );

  app.post(
    '/organizations/:organizationId/authn/mfa/challenge',
    {
      config: {
        policy: preAuth(
          'session-partial',
          'The second factor of a sign-in in progress. The session it marks is the one that ' +
            'presented it; there is no parameter naming another.',
        ),
      },
    },
    async (request, reply) => {
      const organizationId = declaredOrganizationId(request);
      const session = request.authnSession;
      if (
        organizationId === undefined ||
        session === undefined ||
        !sessionMatchesDeclaredOrganization(session, organizationId)
      ) {
        return sendNotFound(request, reply);
      }
      const parsed = mfaChallengeRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(401).send({
          error: {
            code: 'AUTHN_FAILED',
            message: 'Those sign-in details were not accepted.',
            correlationId: request.correlationId,
          },
        });
      }
      const done = await withAuthn(request, reply, organizationId, async (uow) => {
        await app.authn.challengeMfa(uow, {
          userId: session.userId,
          sessionId: session.id,
          ...(parsed.data.code === undefined ? {} : { code: parsed.data.code }),
          ...(parsed.data.recoveryCode === undefined
            ? {}
            : { recoveryCode: parsed.data.recoveryCode }),
        });
        return true;
      });
      if (done === undefined) return reply;
      return reply.code(200).send({
        state: 'authenticated',
        absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
      });
    },
  );

  /* ────────────────────────────────────────────────────────────────────────
   * Activation (STM-017/018) — a DIFFERENT namespace from password reset
   * ──────────────────────────────────────────────────────────────────────── */

  app.post(
    '/organizations/:organizationId/authn/activation',
    {
      config: {
        policy: preAuth(
          'anonymous',
          'Activation is performed by somebody who has no account yet, holding a single-use ' +
            'token. Requiring a session would make the flow impossible.',
        ),
      },
    },
    async (request, reply) => {
      const organizationId = declaredOrganizationId(request);
      if (organizationId === undefined) return sendNotFound(request, reply);
      const parsed = activationRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: {
            code: 'AUTHN_TOKEN_INVALID',
            message: 'That link is no longer valid. Please request a new one.',
            correlationId: request.correlationId,
          },
        });
      }
      const result = await withAuthn(request, reply, organizationId, (uow) =>
        app.authn.activateAccount(uow, {
          token: parsed.data.token,
          password: parsed.data.password,
        }),
      );
      if (result === undefined) return reply;
      // Deliberately NOT signed in afterwards. An activation that also issues a
      // session means the token both sets and uses a credential, which is the
      // conflation 14 §2 keeps apart.
      return reply.code(200).send({ acknowledged: true });
    },
  );

  /* ────────────────────────────────────────────────────────────────────────
   * Password reset — separate flow, separate token namespace
   * ──────────────────────────────────────────────────────────────────────── */

  app.post(
    '/organizations/:organizationId/authn/password-reset',
    {
      config: {
        policy: preAuth(
          'anonymous',
          'Requested by somebody who cannot sign in. The response is identical whatever the ' +
            'address turns out to be.',
        ),
      },
    },
    async (request, reply) => {
      const organizationId = declaredOrganizationId(request);
      if (organizationId === undefined) return sendNotFound(request, reply);
      const parsed = passwordResetRequestSchema.safeParse(request.body);
      // Even a malformed body acknowledges. A 422 here would answer "is that a
      // real address" for anything that parses and "no" for anything that does
      // not, which is half an oracle.
      if (!parsed.success) return reply.code(202).send({ acknowledged: true });

      await withAuthn(request, reply, organizationId, (uow) =>
        app.authn.requestPasswordReset(uow, {
          loginEmail: parsed.data.loginEmail,
          notificationRef: 'sink:password-reset',
        }),
      );
      return reply.code(202).send({ acknowledged: true });
    },
  );

  app.post(
    '/organizations/:organizationId/authn/password-reset/completion',
    {
      config: {
        policy: preAuth(
          'anonymous',
          'Completed by somebody who cannot sign in, holding a single-use token from a ' +
            'namespace that is not the invitation namespace.',
        ),
      },
    },
    async (request, reply) => {
      const organizationId = declaredOrganizationId(request);
      if (organizationId === undefined) return sendNotFound(request, reply);
      const parsed = passwordResetCompleteSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: {
            code: 'AUTHN_TOKEN_INVALID',
            message: 'That link is no longer valid. Please request a new one.',
            correlationId: request.correlationId,
          },
        });
      }
      const result = await withAuthn(request, reply, organizationId, (uow) =>
        app.authn.completePasswordReset(uow, {
          token: parsed.data.token,
          password: parsed.data.password,
          notificationRef: 'sink:password-changed',
        }),
      );
      if (result === undefined) return reply;
      clearSessionCookie(reply);
      return reply.code(200).send({ acknowledged: true });
    },
  );

  /* ────────────────────────────────────────────────────────────────────────
   * Administrative surfaces — capability-gated, evaluated in the SAME unit of
   * work as the mutation (FAD-12)
   * ──────────────────────────────────────────────────────────────────────── */

  app.post(
    '/organizations/:organizationId/invitations',
    { config: INVITATION_CONFIG },
    async (request, reply) => {
      const { context, command, route } = requireTenantContext(request);
      const parsed = issueInvitationRequestSchema.safeParse(request.body);

      const outcome = await app.tenancy.runtime.run(command, async (uow) => {
        const { decision } = await evaluateInTransaction(uow.query, { request, context, route });
        if (!decision.allowed) return { kind: 'denied' as const, decision };
        // Parsed AFTER the verdict, for the disclosure reason
        // `catalogue.route.ts` records: a 422 describing the expected body is a
        // free probe for an actor who holds nothing here.
        if (!parsed.success) return { kind: 'invalid' as const };
        const issued = await app.authn.issueInvitation(uow, {
          userId: parsed.data.userId,
          email: parsed.data.email,
          notificationRef: parsed.data.notificationRef,
        });
        return { kind: 'ok' as const, issued };
      });

      if (outcome.kind === 'denied') return respondToDenial(request, reply, outcome.decision);
      if (outcome.kind === 'invalid') {
        return reply.code(422).send({
          error: {
            code: 'AUTHN_INVALID_REQUEST',
            message: 'That invitation could not be issued as sent.',
            correlationId: request.correlationId,
          },
        });
      }
      // **The token is NOT in this response.** It reaches its recipient through
      // the outbox intent and nowhere else; returning it here would put a live
      // credential-setting token in an administrator's browser history.
      return reply.code(201).send({
        invitationId: outcome.issued.invitationId,
        expiresAt: outcome.issued.expiresAt.toISOString(),
      });
    },
  );

  app.post(
    '/organizations/:organizationId/invitations/:invitationId/revocation',
    { config: INVITATION_CONFIG },
    async (request, reply) => {
      const { context, command, route } = requireTenantContext(request);
      const invitationId = (request.params as { invitationId?: string }).invitationId;
      if (invitationId === undefined || !isUuid(invitationId)) {
        return sendNotFound(request, reply);
      }
      const outcome = await app.tenancy.runtime.run(command, async (uow) => {
        const { decision } = await evaluateInTransaction(uow.query, { request, context, route });
        if (!decision.allowed) return { kind: 'denied' as const, decision };
        const revoked = await app.authn.revokeInvitation(uow, invitationId);
        return { kind: 'ok' as const, revoked };
      });
      if (outcome.kind === 'denied') return respondToDenial(request, reply, outcome.decision);
      if (!outcome.revoked) return sendNotFound(request, reply);
      return reply.code(204).send();
    },
  );

  app.post(
    '/organizations/:organizationId/users/:userId/login-email',
    { config: CHANGE_LOGIN_EMAIL_CONFIG },
    async (request, reply) => {
      const { context, command, route } = requireTenantContext(request);
      const userId = (request.params as { userId?: string }).userId;
      if (userId === undefined || !isUuid(userId)) return sendNotFound(request, reply);
      const parsed = changeLoginEmailRequestSchema.safeParse(request.body);

      const outcome = await app.tenancy.runtime.run(command, async (uow) => {
        const { decision } = await evaluateInTransaction(uow.query, { request, context, route });
        if (!decision.allowed) return { kind: 'denied' as const, decision };
        if (!parsed.success) return { kind: 'invalid' as const };
        try {
          const result = await app.authn.changeLoginEmail(uow, {
            userId,
            loginEmail: parsed.data.loginEmail,
            notificationRef: parsed.data.notificationRef,
          });
          return { kind: 'ok' as const, result };
        } catch (error) {
          if (error instanceof AuthnError) return { kind: 'error' as const, error };
          throw error;
        }
      });

      if (outcome.kind === 'denied') return respondToDenial(request, reply, outcome.decision);
      if (outcome.kind === 'invalid') {
        return reply.code(422).send({
          error: {
            code: 'AUTHN_INVALID_REQUEST',
            message: 'That login email could not be set as sent.',
            correlationId: request.correlationId,
          },
        });
      }
      if (outcome.kind === 'error') return respondToAuthnError(request, reply, outcome.error);
      return reply.code(200).send(outcome.result);
    },
  );

  app.post(
    '/organizations/:organizationId/users/:userId/mfa-reset',
    { config: RESET_MFA_CONFIG },
    async (request, reply) => {
      const { context, command, route } = requireTenantContext(request);
      const userId = (request.params as { userId?: string }).userId;
      if (userId === undefined || !isUuid(userId)) return sendNotFound(request, reply);
      const parsed = resetMfaRequestSchema.safeParse(request.body);

      const outcome = await app.tenancy.runtime.run(command, async (uow) => {
        const { decision } = await evaluateInTransaction(uow.query, { request, context, route });
        if (!decision.allowed) return { kind: 'denied' as const, decision };
        if (!parsed.success) return { kind: 'invalid' as const };
        const result = await app.authn.resetMfa(uow, {
          userId,
          notificationRef: parsed.data.notificationRef,
        });
        return { kind: 'ok' as const, result };
      });

      if (outcome.kind === 'denied') return respondToDenial(request, reply, outcome.decision);
      if (outcome.kind === 'invalid') {
        return reply.code(422).send({
          error: {
            code: 'AUTHN_INVALID_REQUEST',
            message: 'That reset could not be performed as sent.',
            correlationId: request.correlationId,
          },
        });
      }
      return reply.code(200).send(outcome.result);
    },
  );

  app.post(
    '/organizations/:organizationId/users/:userId/session-revocation',
    { config: ADMINISTER_SESSIONS_CONFIG },
    async (request, reply) => {
      const { context, command, route } = requireTenantContext(request);
      const userId = (request.params as { userId?: string }).userId;
      if (userId === undefined || !isUuid(userId)) return sendNotFound(request, reply);

      const outcome = await app.tenancy.runtime.run(command, async (uow) => {
        const { decision } = await evaluateInTransaction(uow.query, { request, context, route });
        if (!decision.allowed) return { kind: 'denied' as const, decision };
        const sessionsRevoked = await app.authn.revokeAllSessions(uow, {
          userId,
          reason: 'administrative',
        });
        return { kind: 'ok' as const, sessionsRevoked };
      });

      if (outcome.kind === 'denied') return respondToDenial(request, reply, outcome.decision);
      return reply.code(200).send({ sessionsRevoked: outcome.sessionsRevoked });
    },
  );
}
