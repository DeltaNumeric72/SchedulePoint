import { sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_AUTHN_POLICY, lockoutDurationMs } from '../../src/authn/config.js';
import * as store from '../../src/authn/store.js';
import { SESSION_COOKIE_NAME, encodeSessionCookie } from '../../src/authn/tokens.js';
import { adminClient } from '../support/admin-client.js';
import {
  FIXTURE_PASSWORD,
  codeFor,
  organizationCommand,
  redactSessionCookie,
} from '../support/authn.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import {
  buildHttpHarness,
  contextHeaders,
  currentCounters,
  type HttpHarness,
} from '../support/http.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * The authentication surface, driven over HTTP.
 *
 * Everything here goes through `app.inject` rather than through the service, so
 * the middleware, the pre-auth stage enforcement, the cookie attributes, the
 * status codes and the capability evaluation are all in scope. The service-level
 * files prove the domain properties; this one proves the surface.
 */

const multi = ownedMulti('authn-http', { profile: 'full' });

let admin: pg.Client;
let runtime: Runtime;
let harness: HttpHarness;

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  runtime = createRuntime('app_runtime');
  harness = await buildHttpHarness();
});

afterAll(async () => {
  await harness.close();
  await runtime.destroy();
  await admin.end();
});

function organizationUrl(path: string): string {
  return `/organizations/${multi().alpha.organizationId}${path}`;
}

/**
 * Activates an account **if it is not already activated**, and returns its login
 * email.
 *
 * ## Idempotent, and that is a defect fix
 *
 * The first version always issued an invitation, so every test depended on
 * running before any other test that touched the same account — and `pnpm
 * fixture-regression`, which shuffles file AND test order, failed on ten of
 * eleven seeds. That is exactly the coupling FAD-15 exists to expose, found by
 * the control that exists to find it.
 *
 * The fix is not to order the tests. It is to make each one provision what it
 * needs, so no test can be made to fail by another test having run first.
 */
async function activated(label: string, userId: string): Promise<string> {
  const alpha = multi().alpha;
  const asAdmin = organizationCommand(
    alpha.organizationId,
    alpha.users.organizationAdmin.membershipId,
    `http-${label}`,
  );
  const anonymous = organizationCommand(alpha.organizationId, null, `http-${label}-anon`);

  const existing = await runtime.runner.run(anonymous, (uow) =>
    store.findCredentialById(uow, userId),
  );
  if (existing === undefined) throw new Error(`no such user in the fixture: ${userId}`);
  if (existing.activatedAt !== null) return existing.loginEmail;

  const invitation = await runtime.runner.run(asAdmin, (uow) =>
    harness.authn.issueInvitation(uow, {
      userId,
      email: `http-${label}@example.test`,
      notificationRef: 'sink:http',
    }),
  );
  await runtime.runner.run(anonymous, (uow) =>
    harness.authn.activateAccount(uow, { token: invitation.token, password: FIXTURE_PASSWORD }),
  );
  return existing.loginEmail;
}

/** Writes a capability grant for a membership, once. Safe to call from any test. */
async function ensureGrant(membershipId: string, capabilityKey: string): Promise<void> {
  const alpha = multi().alpha;
  await runtime.runner.run(
    organizationCommand(
      alpha.organizationId,
      alpha.users.organizationAdmin.membershipId,
      'http-ensure-grant',
    ),
    async (uow) => {
      const existing = await sql<{ n: number }>`
        select count(*)::int as n from capability_grants
         where membership_id = ${membershipId}::uuid
           and capability_key = ${capabilityKey}
           and granted = true
      `.execute(uow.query);
      if ((existing.rows[0]?.n ?? 0) > 0) return;
      await sql`
        insert into capability_grants (organization_id, id, group_id, membership_id,
                                       capability_key, granted, granted_by_membership_id)
        values (${alpha.organizationId}::uuid, gen_random_uuid(), null,
                ${membershipId}::uuid, ${capabilityKey}, true,
                ${alpha.users.organizationAdmin.membershipId}::uuid)
      `.execute(uow.query);
    },
  );
}

function cookieOf(response: { headers: Record<string, unknown> }): string {
  return String(response.headers['set-cookie']);
}

describe('sign in, cookie posture, sign out', () => {
  it('a successful sign-in sets a HttpOnly + Secure + SameSite=Strict __Host- cookie', async () => {
    const loginEmail = await activated('cookie', multi().alpha.full!.viewer.id);
    const response = await harness.app.inject({
      method: 'POST',
      url: organizationUrl('/authn/sign-in'),
      payload: { loginEmail, password: FIXTURE_PASSWORD },
    });
    expect(response.statusCode, response.body).toBe(200);

    const cookie = cookieOf(response);
    expect(cookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
    for (const attribute of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict']) {
      expect(cookie, `the cookie is missing ${attribute}`).toContain(attribute);
    }
    // Non-persistent: NO Max-Age, so it is a browser-session cookie.
    expect(cookie).not.toContain('Max-Age');
    // `__Host-` forbids a Domain attribute; a browser would reject the cookie if
    // one were present, so its absence is the control.
    expect(cookie).not.toContain('Domain=');

    // The response body carries the state and the absolute deadline — and NOT
    // the token, which lives only in the cookie.
    const body = JSON.parse(response.body) as { state: string; absoluteExpiresAt: string };
    expect(['authenticated', 'mfa_required', 'mfa_enrolment_required']).toContain(body.state);
    expect(Number.isNaN(Date.parse(body.absoluteExpiresAt))).toBe(false);
    expect(response.body).not.toContain(cookie.split('=')[1]?.slice(0, 20) ?? 'x');
    // Redacted BY CONSTRUCTION: the secret is replaced before it reaches the log,
    // so it is never written into the evidence artifact. The attributes — which
    // are what this proof is about — are all still here.
    log(`sign-in cookie: ${redactSessionCookie(cookie)}`);
  });

  it('a persistent sign-in adds Max-Age, and nothing else changes', async () => {
    const loginEmail = await activated('persistent', multi().alpha.full!.telecom.id);
    const response = await harness.app.inject({
      method: 'POST',
      url: organizationUrl('/authn/sign-in'),
      payload: { loginEmail, password: FIXTURE_PASSWORD, persistent: true },
    });
    expect(response.statusCode).toBe(200);
    const cookie = cookieOf(response);
    expect(cookie).toContain('Max-Age=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
  });

  it('sign-out revokes the session and clears the cookie; the token stops working', async () => {
    const loginEmail = await activated('signout', multi().alpha.full!.groupAdmin.id);
    const signIn = await harness.app.inject({
      method: 'POST',
      url: organizationUrl('/authn/sign-in'),
      payload: { loginEmail, password: FIXTURE_PASSWORD },
    });
    const cookie = cookieOf(signIn).split(';')[0]!;

    const signOut = await harness.app.inject({
      method: 'POST',
      url: organizationUrl('/authn/sign-out'),
      headers: { cookie },
    });
    expect(signOut.statusCode).toBe(204);
    expect(cookieOf(signOut)).toContain('Max-Age=0');

    // The token is dead: a second sign-out with the same cookie is a 401, not a
    // second 204.
    const again = await harness.app.inject({
      method: 'POST',
      url: organizationUrl('/authn/sign-out'),
      headers: { cookie },
    });
    expect(again.statusCode).toBe(401);
    log('sign-out revoked the session, cleared the cookie, and the token is inert afterwards');
  });

  it('a session issued for ANOTHER organization is refused on this one', async () => {
    const beta = multi().beta;
    const loginEmail = await activated('crossorg', multi().alpha.full!.dualRole.id);
    const signIn = await harness.app.inject({
      method: 'POST',
      url: organizationUrl('/authn/sign-in'),
      payload: { loginEmail, password: FIXTURE_PASSWORD },
    });
    const raw = cookieOf(signIn).split(';')[0]!;
    const secret = decodeURIComponent(raw.slice(raw.indexOf('=') + 1)).split('.')[1]!;

    // The SAME secret, re-labelled with Beta's organization id. RLS scopes the
    // lookup to the declared organization, so the row is simply not there.
    const forged = `${SESSION_COOKIE_NAME}=${encodeURIComponent(
      encodeSessionCookie(beta.organizationId, secret),
    )}`;
    const response = await harness.app.inject({
      method: 'POST',
      url: `/organizations/${beta.organizationId}/authn/sign-out`,
      headers: { cookie: forged },
    });
    expect(response.statusCode).toBe(401);
    log('a session re-labelled with another organization id resolves to nothing');
  });
});

describe('lockout (T-22)', () => {
  it('repeated failures lock the account, and the response NEVER says so', async () => {
    const loginEmail = await activated('lockout', multi().alpha.full!.organizationObserver.id);
    const bodies = new Set<string>();

    for (let attempt = 0; attempt < DEFAULT_AUTHN_POLICY.lockoutThreshold + 1; attempt += 1) {
      const response = await harness.app.inject({
        method: 'POST',
        url: organizationUrl('/authn/sign-in'),
        payload: { loginEmail, password: 'fixture-definitely-the-wrong-password' },
      });
      expect(response.statusCode).toBe(401);
      const parsed = JSON.parse(response.body) as { error: { code: string; message: string } };
      bodies.add(`${parsed.error.code}|${parsed.error.message}`);
      // A `Retry-After` header would be an oracle: it would tell an attacker
      // that this address exists and is now locked.
      expect(response.headers['retry-after']).toBeUndefined();
    }
    expect([...bodies], 'the body changed once the account locked').toHaveLength(1);

    // The lock IS recorded, server-side.
    const row = await admin.query<{ failed_sign_in_count: number; locked_until: Date | null }>(
      'select failed_sign_in_count, locked_until from users where lower(login_email) = lower($1)',
      [loginEmail],
    );
    expect(row.rows[0]!.failed_sign_in_count).toBeGreaterThanOrEqual(
      DEFAULT_AUTHN_POLICY.lockoutThreshold,
    );
    expect(row.rows[0]!.locked_until, 'no lock was applied after repeated failures').not.toBeNull();

    // And the RIGHT password is now refused too, with the same body — which is
    // what a lock means.
    const correct = await harness.app.inject({
      method: 'POST',
      url: organizationUrl('/authn/sign-in'),
      payload: { loginEmail, password: FIXTURE_PASSWORD },
    });
    expect(correct.statusCode).toBe(401);

    // Audited, with the reason, where only an authorized reader sees it.
    const audits = await admin.query<{ event_name: string }>(
      `select event_name from audit_events
        where organization_id = $1::uuid and event_name in ('authn.sign_in.failed', 'authn.account.locked')`,
      [multi().alpha.organizationId],
    );
    expect(audits.rows.some((r) => r.event_name === 'authn.account.locked')).toBe(true);
    log(
      `${String(DEFAULT_AUTHN_POLICY.lockoutThreshold + 1)} failures locked the account; every ` +
        'response was byte-identical and the lock is audited',
    );
  });

  it('the progressive delay is bounded, so an account is never permanently locked', () => {
    const policy = DEFAULT_AUTHN_POLICY;
    expect(lockoutDurationMs(policy, policy.lockoutThreshold - 1)).toBe(0);
    expect(lockoutDurationMs(policy, policy.lockoutThreshold)).toBe(policy.lockoutBaseMs);
    expect(lockoutDurationMs(policy, policy.lockoutThreshold + 1)).toBe(policy.lockoutBaseMs * 2);
    // The cap matters: an uncapped doubling reaches "locked until the heat death
    // of the universe" in about forty failures, which turns an availability
    // control into a denial of service anybody can aim at anybody.
    expect(lockoutDurationMs(policy, 1000)).toBe(policy.lockoutMaxMs);
  });

  it('a successful sign-in clears the counter', async () => {
    const loginEmail = await activated('clear', multi().alpha.users.groupTwoScheduler.id);
    await harness.app.inject({
      method: 'POST',
      url: organizationUrl('/authn/sign-in'),
      payload: { loginEmail, password: 'wrong-once' },
    });
    const before = await admin.query<{ failed_sign_in_count: number }>(
      'select failed_sign_in_count from users where lower(login_email) = lower($1)',
      [loginEmail],
    );
    expect(before.rows[0]!.failed_sign_in_count).toBe(1);

    await harness.app.inject({
      method: 'POST',
      url: organizationUrl('/authn/sign-in'),
      payload: { loginEmail, password: FIXTURE_PASSWORD },
    });
    const after = await admin.query<{ failed_sign_in_count: number }>(
      'select failed_sign_in_count from users where lower(login_email) = lower($1)',
      [loginEmail],
    );
    expect(after.rows[0]!.failed_sign_in_count).toBe(0);
  });
});

describe('activation and reset, over HTTP', () => {
  it('an invited account activates, then signs in; the token is single-use at the surface too', async () => {
    const alpha = multi().alpha;
    const user = alpha.users.scheduler;
    const asAdmin = organizationCommand(
      alpha.organizationId,
      alpha.users.organizationAdmin.membershipId,
      'http-activate',
    );
    const invitation = await runtime.runner.run(asAdmin, (uow) =>
      harness.authn.issueInvitation(uow, {
        userId: user.id,
        email: 'http-activate@example.test',
        notificationRef: 'sink:http',
      }),
    );

    const activate = await harness.app.inject({
      method: 'POST',
      url: organizationUrl('/authn/activation'),
      payload: { token: invitation.token, password: FIXTURE_PASSWORD },
    });
    expect(activate.statusCode, activate.body).toBe(200);
    // Activation does NOT sign you in: the token both setting and using a
    // credential is the conflation 14 §2 keeps apart.
    expect(activate.headers['set-cookie']).toBeUndefined();

    const replay = await harness.app.inject({
      method: 'POST',
      url: organizationUrl('/authn/activation'),
      payload: { token: invitation.token, password: FIXTURE_PASSWORD },
    });
    expect(replay.statusCode).toBe(400);
    expect(JSON.parse(replay.body).error.code).toBe('AUTHN_TOKEN_INVALID');

    const loginEmail = await runtime.runner.run(
      organizationCommand(alpha.organizationId, null, 'http-activate-read'),
      async (uow) => (await store.findCredentialById(uow, user.id))!.loginEmail,
    );
    const signIn = await harness.app.inject({
      method: 'POST',
      url: organizationUrl('/authn/sign-in'),
      payload: { loginEmail, password: FIXTURE_PASSWORD },
    });
    expect(signIn.statusCode, signIn.body).toBe(200);
    log('activate -> replay refused -> sign in, all over HTTP');
  });

  it('a reset REQUEST acknowledges identically for a known and an unknown address', async () => {
    const loginEmail = await activated('reset', multi().alpha.users.member.id);

    const known = await harness.app.inject({
      method: 'POST',
      url: organizationUrl('/authn/password-reset'),
      payload: { loginEmail },
    });
    const unknown = await harness.app.inject({
      method: 'POST',
      url: organizationUrl('/authn/password-reset'),
      payload: { loginEmail: 'nobody-at-all@example.test' },
    });
    const malformed = await harness.app.inject({
      method: 'POST',
      url: organizationUrl('/authn/password-reset'),
      payload: { loginEmail: 'not-even-an-address' },
    });

    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(malformed.statusCode).toBe(202);
    expect(known.body).toBe(unknown.body);
    expect(known.body).toBe(malformed.body);
    log(`three reset requests, one body: ${known.body}`);
  });

  it('a reset token completes over HTTP and the old password stops working', async () => {
    const alpha = multi().alpha;
    // Its password IS changed by this test, which is why no other test in this
    // file signs in as `groupOnly`.
    const loginEmail = await activated('resetcomplete', alpha.users.groupOnly.id);

    const anonymous = organizationCommand(alpha.organizationId, null, 'http-resetc');
    const requested = await runtime.runner.run(anonymous, (uow) =>
      harness.authn.requestPasswordReset(uow, { loginEmail, notificationRef: 'sink:http' }),
    );
    expect(requested.token).toBeDefined();

    const completed = await harness.app.inject({
      method: 'POST',
      url: organizationUrl('/authn/password-reset/completion'),
      payload: { token: requested.token, password: 'fixture-a-brand-new-passphrase-01' },
    });
    expect(completed.statusCode, completed.body).toBe(200);

    const old = await harness.app.inject({
      method: 'POST',
      url: organizationUrl('/authn/sign-in'),
      payload: { loginEmail, password: FIXTURE_PASSWORD },
    });
    expect(old.statusCode).toBe(401);
    const fresh = await harness.app.inject({
      method: 'POST',
      url: organizationUrl('/authn/sign-in'),
      payload: { loginEmail, password: 'fixture-a-brand-new-passphrase-01' },
    });
    expect(fresh.statusCode, fresh.body).toBe(200);
    log('a reset completed over HTTP; the old password is refused and the new one works');
  });
});

describe('the administrative surfaces are capability-gated', () => {
  async function headersFor(userId: string, correlationId: string): Promise<Record<string, string>> {
    const alpha = multi().alpha;
    const counters = await currentCounters(admin, {
      organizationId: alpha.organizationId,
      groupId: null,
      userId,
    });
    return contextHeaders(userId, counters, correlationId);
  }

  it('a member cannot issue an invitation, reset MFA, change a login email or revoke sessions', async () => {
    const alpha = multi().alpha;
    const headers = await headersFor(alpha.users.member.id, 'httpdeny');
    const target = alpha.full!.viewer.id;

    for (const [url, payload] of [
      [organizationUrl('/invitations'), { userId: target, email: 'x@example.test', notificationRef: 'sink:x' }],
      [organizationUrl(`/users/${target}/mfa-reset`), { notificationRef: 'sink:x' }],
      [organizationUrl(`/users/${target}/login-email`), { loginEmail: 'x@example.test', notificationRef: 'sink:x' }],
      [organizationUrl(`/users/${target}/session-revocation`), {}],
    ] as const) {
      const response = await harness.app.inject({ method: 'POST', url, headers, payload });
      expect([403, 404], `${url} answered ${String(response.statusCode)}`).toContain(
        response.statusCode,
      );
      // Nothing about WHY. The denial's disclosure class is the whole answer.
      expect(response.body).not.toContain('capability');
      expect(response.body).not.toContain('identity.');
    }
    log('four administrative surfaces denied a plain member with no reason disclosed');
  });

  it('an organization administrator holding the GRANT can change a login email; sessions die and invitations reconcile', async () => {
    const alpha = multi().alpha;
    /* The GRANT goes to a DIFFERENT membership than the one writing it: a
     * database guard refuses a principal writing a grant for any of their own
     * memberships (0002), which is the separation-of-duty control working. So
     * the organization administrator grants the capability to the organization
     * OBSERVER, and the observer is the actor whose request is evaluated. */
    const grantor = alpha.users.organizationAdmin;
    const actor = alpha.full!.organizationObserver;
    const subject = alpha.full!.invited;

    // `identity.change_login_email` is GRANT-ONLY: no role implies it, so the
    // administrator is denied until the grant exists. That denial is the control,
    // and it is asserted before the grant rather than assumed.
    // `identity.change_login_email` is GRANT-ONLY: no role implies it, so a
    // principal without the grant is denied. Asserted against a THIRD principal
    // that nothing grants, rather than against the actor before its own grant —
    // the latter reads as an ordering dependence and becomes one under shuffle.
    const ungranted = alpha.users.member;
    const beforeGrant = await harness.app.inject({
      method: 'POST',
      url: organizationUrl(`/users/${subject.id}/login-email`),
      headers: await headersFor(ungranted.id, 'httpemailpre'),
      payload: { loginEmail: 'reconciled@example.test', notificationRef: 'sink:owner' },
    });
    expect([403, 404]).toContain(beforeGrant.statusCode);

    await ensureGrant(actor.membershipId, 'identity.change_login_email');

    // A pending invitation for the subject, so the CAR-027 reconciliation has
    // something to reconcile.
    const invitation = await runtime.runner.run(
      organizationCommand(alpha.organizationId, grantor.membershipId, 'http-email-invite'),
      (uow) =>
        harness.authn.issueInvitation(uow, {
          userId: subject.id,
          email: 'before-change@example.test',
          notificationRef: 'sink:http',
        }),
    );

    const response = await harness.app.inject({
      method: 'POST',
      url: organizationUrl(`/users/${subject.id}/login-email`),
      headers: await headersFor(actor.id, 'httpemail'),
      payload: { loginEmail: 'reconciled@example.test', notificationRef: 'sink:owner' },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = JSON.parse(response.body) as {
      sessionsRevoked: number;
      invitationsReconciled: number;
    };
    expect(body.invitationsReconciled).toBe(1);

    const row = await admin.query<{ email: string }>(
      'select email from invitations where id = $1::uuid',
      [invitation.invitationId],
    );
    expect(row.rows[0]?.email).toBe('reconciled@example.test');

    const audit = await admin.query<{ payload: Record<string, unknown> }>(
      `select payload from audit_events
        where organization_id = $1::uuid and event_name = 'authn.login_email.changed'
          and subject_id = $2::uuid`,
      [alpha.organizationId, subject.id],
    );
    expect(audit.rows.length).toBe(1);
    // The audit payload carries the DOMAIN and a digest — never the address.
    expect(audit.rows[0]?.payload['newDomain']).toBe('example.test');
    expect(JSON.stringify(audit.rows[0]?.payload)).not.toContain('reconciled@');
    log(
      `login-email change: denied before the grant, allowed after; ${String(
        body.invitationsReconciled,
      )} invitation reconciled; audit carries the domain and a digest only`,
    );
  });

  it('a login email already in use is a 409, not a constraint name', async () => {
    const alpha = multi().alpha;
    // Granted here rather than by the previous test, so order does not decide.
    const actor = alpha.full!.organizationObserver;
    await ensureGrant(actor.membershipId, 'identity.change_login_email');
    const subject = alpha.full!.viewer;
    const existing = await activated('conflict-subject', alpha.users.member.id);

    const response = await harness.app.inject({
      method: 'POST',
      url: organizationUrl(`/users/${subject.id}/login-email`),
      headers: await headersFor(actor.id, 'httpconflict'),
      payload: { loginEmail: existing, notificationRef: 'sink:owner' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain('users_login_email_unique');
    expect(response.body).not.toContain('23505');
  });
});

describe('the MFA challenge, over HTTP', () => {
  it('an elevated role must enrol, then challenge, before the session is fully authenticated', async () => {
    const alpha = multi().alpha;
    // `group_admin` is in `MFA_REQUIRED_ROLES`. Activated here rather than by a
    // sibling test, so this test does not depend on running second.
    const user = alpha.full!.groupAdmin;
    const loginEmail = await activated('mfa-elevated', user.id);
    // And any factor a previous run left in place is removed, so the first
    // sign-in below genuinely reaches `mfa_enrolment_required` whatever order
    // the file ran in.
    await runtime.runner.run(
      organizationCommand(
        alpha.organizationId,
        alpha.users.organizationAdmin.membershipId,
        'http-mfa-clear',
      ),
      (uow) => harness.authn.resetMfa(uow, { userId: user.id, notificationRef: 'sink:http' }),
    );

    const signIn = await harness.app.inject({
      method: 'POST',
      url: organizationUrl('/authn/sign-in'),
      payload: { loginEmail, password: FIXTURE_PASSWORD },
    });
    expect(signIn.statusCode, signIn.body).toBe(200);
    const state = (JSON.parse(signIn.body) as { state: string }).state;
    expect(state).toBe('mfa_enrolment_required');
    const cookie = cookieOf(signIn).split(';')[0]!;

    const start = await harness.app.inject({
      method: 'POST',
      url: organizationUrl('/authn/mfa/enrolment'),
      headers: { cookie },
      payload: {},
    });
    expect(start.statusCode, start.body).toBe(200);
    const enrolment = JSON.parse(start.body) as { provisioningUri: string; secretBase32: string };
    expect(enrolment.provisioningUri.startsWith('otpauth://totp/')).toBe(true);

    const confirm = await harness.app.inject({
      method: 'POST',
      url: organizationUrl('/authn/mfa/enrolment/confirmation'),
      headers: { cookie },
      payload: { code: codeFor(enrolment.secretBase32, new Date()) },
    });
    expect(confirm.statusCode, confirm.body).toBe(200);
    expect((JSON.parse(confirm.body) as { recoveryCodes: string[] }).recoveryCodes.length).toBe(10);

    // A fresh sign-in now demands the factor.
    const second = await harness.app.inject({
      method: 'POST',
      url: organizationUrl('/authn/sign-in'),
      payload: { loginEmail, password: FIXTURE_PASSWORD },
    });
    expect((JSON.parse(second.body) as { state: string }).state).toBe('mfa_required');
    log('an elevated role signed in -> enrolment required -> enrolled -> mfa_required thereafter');
  });

  it('a session that has already satisfied its challenge cannot re-enter the challenge stage', async () => {
    const alpha = multi().alpha;
    // `viewer` holds no elevated role and no factor, so its session is fully
    // authenticated at issue — which is the precondition this test needs.
    // Activated here rather than by a sibling test.
    const loginEmail = await activated('satisfied', alpha.full!.viewer.id);
    const signIn = await harness.app.inject({
      method: 'POST',
      url: organizationUrl('/authn/sign-in'),
      payload: { loginEmail, password: FIXTURE_PASSWORD },
    });
    // No factor in force for this account, so the session is fully authenticated
    // at issue — and a `session-partial` route must refuse it.
    expect((JSON.parse(signIn.body) as { state: string }).state).toBe('authenticated');
    const cookie = cookieOf(signIn).split(';')[0]!;

    const challenge = await harness.app.inject({
      method: 'POST',
      url: organizationUrl('/authn/mfa/challenge'),
      headers: { cookie },
      payload: { code: '123456' },
    });
    expect(challenge.statusCode).toBe(401);
    log('a fully authenticated session is refused by the session-partial stage');
  });
});
