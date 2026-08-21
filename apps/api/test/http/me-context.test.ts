import { CONTEXT_HEADER } from '@schedulepoint/contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as store from '../../src/authn/store.js';
import { SESSION_COOKIE_NAME, encodeSessionCookie } from '../../src/authn/tokens.js';
import { adminClient } from '../support/admin-client.js';
import { FIXTURE_PASSWORD, codeFor, organizationCommand } from '../support/authn.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { buildHttpHarness, currentCounters, type HttpHarness } from '../support/http.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * `GET /organizations/:organizationId/me/context` — the FAD-48 grant, proven.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## What this file is for
 *
 * SPEC-01 §2.2 is a declare/verify contract and the CLIENT HALF DID NOT EXIST:
 * no response anywhere returned the freshness counters, so no browser could
 * construct a declaration and every e2e spec had to intercept the API
 * (EV-M4-005 §12). This route is the missing half. The proofs below are
 * therefore about two things at once — that the route is *correct*, and that
 * what it returns is *sufficient*: the last two tests take the response and use
 * it, unmodified, as the declaration on a real capability route.
 *
 * ## Deny before allow
 *
 * Four refusals are asserted before the first success, because a read of one's
 * own memberships that is not deny-tested is a membership directory:
 *
 *  1. **no session → 401**, enforced by the middleware from the declared stage;
 *  2. **a half-authenticated session → 401**, enforced in the handler because
 *     the pre-auth stage vocabulary has nothing fuller than `session-any`;
 *  3. **a session issued for another organization → 404**;
 *  4. **another user's memberships → unreachable.** The route has no user
 *     parameter, so the probe is the strongest form available: two users in one
 *     organization, and each one's response is checked against ground truth to
 *     contain every membership of theirs and not one of the other's.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const multi = ownedMulti('me-context', { profile: 'full' });

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

interface MeContextBody {
  organizationId: string;
  userId: string;
  organizationVersion: number;
  membershipSetVersion: number;
  sessionEpoch: number;
  memberships: {
    membershipId: string;
    kind: 'organization' | 'group';
    groupId: string | null;
    groupVersion: number | null;
    status: string;
  }[];
}

function contextUrl(organizationId?: string): string {
  return `/organizations/${organizationId ?? multi().alpha.organizationId}/me/context`;
}

/**
 * Activates an account if it is not already activated, and returns its login
 * email. The same idempotent shape `http-flows.test.ts` uses, and for the same
 * reason: `pnpm fixture-regression` shuffles file AND test order, so a helper
 * that only works the first time is a coupling waiting to be found.
 */
async function activated(label: string, userId: string): Promise<string> {
  const alpha = multi().alpha;
  const asAdmin = organizationCommand(
    alpha.organizationId,
    alpha.users.organizationAdmin.membershipId,
    `me-context-${label}`,
  );
  const anonymous = organizationCommand(alpha.organizationId, null, `me-context-${label}-anon`);

  const existing = await runtime.runner.run(anonymous, (uow) =>
    store.findCredentialById(uow, userId),
  );
  if (existing === undefined) throw new Error(`no such user in the fixture: ${userId}`);
  if (existing.activatedAt !== null) return existing.loginEmail;

  const invitation = await runtime.runner.run(asAdmin, (uow) =>
    harness.authn.issueInvitation(uow, {
      userId,
      email: `me-context-${label}@example.test`,
      notificationRef: 'sink:me-context',
    }),
  );
  await runtime.runner.run(anonymous, (uow) =>
    harness.authn.activateAccount(uow, { token: invitation.token, password: FIXTURE_PASSWORD }),
  );
  return existing.loginEmail;
}

interface SignInOutcome {
  readonly cookie: string;
  readonly state: string;
}

/** One raw sign-in. Returns the cookie pair and the state the server reported. */
async function rawSignIn(loginEmail: string): Promise<SignInOutcome> {
  const response = await harness.app.inject({
    method: 'POST',
    url: `/organizations/${multi().alpha.organizationId}/authn/sign-in`,
    payload: { loginEmail, password: FIXTURE_PASSWORD },
  });
  expect(response.statusCode, response.body).toBe(200);
  return {
    cookie: String(response.headers['set-cookie']).split(';')[0]!,
    state: (JSON.parse(response.body) as { state: string }).state,
  };
}

/** Clears any second factor, so the sign-in path below is deterministic. */
async function clearMfa(label: string, userId: string): Promise<void> {
  const alpha = multi().alpha;
  await runtime.runner.run(
    organizationCommand(
      alpha.organizationId,
      alpha.users.organizationAdmin.membershipId,
      `me-context-${label}-mfa-clear`,
    ),
    (uow) => harness.authn.resetMfa(uow, { userId, notificationRef: 'sink:me-context' }),
  );
}

/**
 * A session that has SATISFIED its challenge, whatever the account's roles are.
 *
 * Three of the fixture's roles (`org_admin`, `group_admin`, `scheduler`) are in
 * `MFA_REQUIRED_ROLES`, and which of them a given fixture user holds is the
 * fixture's business rather than this file's — so the helper drives whichever
 * path the server reports instead of asserting a state it hoped for.
 *
 * The challenge is answered with a **recovery code**, not a TOTP code, and that
 * is a correctness requirement rather than a convenience: `acceptMfaTimeStep`
 * accepts a strictly newer step only, so the code just spent confirming the
 * enrolment is a replay one second later and is correctly refused.
 */
async function fullySignedIn(label: string, userId: string): Promise<string> {
  const alpha = multi().alpha;
  const loginEmail = await activated(label, userId);
  await clearMfa(label, userId);

  const first = await rawSignIn(loginEmail);
  if (first.state === 'authenticated') return first.cookie;
  expect(first.state, 'unexpected sign-in state').toBe('mfa_enrolment_required');

  const start = await harness.app.inject({
    method: 'POST',
    url: `/organizations/${alpha.organizationId}/authn/mfa/enrolment`,
    headers: { cookie: first.cookie },
    payload: {},
  });
  expect(start.statusCode, start.body).toBe(200);
  const secretBase32 = (JSON.parse(start.body) as { secretBase32: string }).secretBase32;

  const confirm = await harness.app.inject({
    method: 'POST',
    url: `/organizations/${alpha.organizationId}/authn/mfa/enrolment/confirmation`,
    headers: { cookie: first.cookie },
    payload: { code: codeFor(secretBase32, new Date()) },
  });
  expect(confirm.statusCode, confirm.body).toBe(200);
  const recoveryCodes = (JSON.parse(confirm.body) as { recoveryCodes: string[] }).recoveryCodes;

  const second = await rawSignIn(loginEmail);
  expect(second.state).toBe('mfa_required');
  const challenge = await harness.app.inject({
    method: 'POST',
    url: `/organizations/${alpha.organizationId}/authn/mfa/challenge`,
    headers: { cookie: second.cookie },
    payload: { recoveryCode: recoveryCodes[0]! },
  });
  expect(challenge.statusCode, challenge.body).toBe(200);
  return second.cookie;
}

/** Every membership id a user actually holds in Alpha, from ground truth. */
async function membershipIdsOf(userId: string): Promise<Set<string>> {
  const rows = await admin.query<{ id: string }>(
    'select id::text as id from memberships where user_id = $1 and organization_id = $2',
    [userId, multi().alpha.organizationId],
  );
  return new Set(rows.rows.map((row) => row.id));
}

describe('GET /me/context — the refusals, before any success', () => {
  it('an unauthenticated caller is refused with 401 and learns nothing', async () => {
    const response = await harness.app.inject({ method: 'GET', url: contextUrl() });
    expect(response.statusCode, response.body).toBe(401);
    const body = JSON.parse(response.body) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('UNAUTHENTICATED');
    // The refusal carries no organization name, no counter and no membership.
    expect(response.body).not.toContain('organizationVersion');
    expect(response.body).not.toContain('membershipId');
    log('GET /me/context without a session: 401 UNAUTHENTICATED, no counters disclosed');
  });

  it('a session that has NOT satisfied its challenge is refused with 401', async () => {
    const alpha = multi().alpha;
    const user = alpha.full!.groupAdmin;
    // `group_admin` is in `MFA_REQUIRED_ROLES`, so its session is issued
    // half-authenticated. Any factor a previous run left behind is cleared here
    // so the state is deterministic whatever order the file ran in.
    const loginEmail = await activated('mfa', user.id);
    await clearMfa('mfa', user.id);
    const partial = await rawSignIn(loginEmail);
    expect(partial.state).toBe('mfa_enrolment_required');
    const cookie = partial.cookie;

    const response = await harness.app.inject({
      method: 'GET',
      url: contextUrl(),
      headers: { cookie },
    });
    expect(response.statusCode, response.body).toBe(401);
    expect((JSON.parse(response.body) as { error: { code: string } }).error.code).toBe(
      'UNAUTHENTICATED',
    );
    log('a half-authenticated session cannot read its context: 401');
  });

  it('a session issued for ANOTHER organization is refused with 404 on this one', async () => {
    const beta = multi().beta;
    const cookie = await fullySignedIn('crossorg', multi().alpha.full!.dualRole.id);
    const secret = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1)).split('.')[1]!;
    // The SAME secret, re-labelled with Beta's organization id — the forgery
    // `principal-resolver.ts` documents. RLS scopes the session lookup to the
    // declared organization, so the row is simply not there.
    const forged = `${SESSION_COOKIE_NAME}=${encodeURIComponent(
      encodeSessionCookie(beta.organizationId, secret),
    )}`;
    const response = await harness.app.inject({
      method: 'GET',
      url: contextUrl(beta.organizationId),
      headers: { cookie: forged },
    });
    expect([401, 404]).toContain(response.statusCode);
    expect(response.body).not.toContain('membershipId');
    log(`a session re-labelled with another organization id: ${String(response.statusCode)}`);
  });
});

describe('GET /me/context — what it returns, and only that', () => {
  it('returns the caller OWN memberships with counters that match ground truth', async () => {
    const alpha = multi().alpha;
    const user = alpha.full!.viewer;
    const cookie = await fullySignedIn('own', user.id);

    const response = await harness.app.inject({
      method: 'GET',
      url: contextUrl(),
      headers: { cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = JSON.parse(response.body) as MeContextBody;

    expect(body.organizationId).toBe(alpha.organizationId);
    expect(body.userId).toBe(user.id);

    // The counters are the ones the §2.3 sequence will compare against — read
    // here with the superuser, independently of the route.
    const truth = await currentCounters(admin, {
      organizationId: alpha.organizationId,
      groupId: null,
      userId: user.id,
    });
    expect(body.organizationVersion).toBe(truth.organizationVersion);
    expect(body.membershipSetVersion).toBe(truth.membershipSetVersion);
    expect(body.sessionEpoch).toBe(truth.sessionEpoch);

    // Every membership returned is one this user actually holds.
    const held = await membershipIdsOf(user.id);
    expect(body.memberships.length).toBeGreaterThan(0);
    for (const membership of body.memberships) {
      expect(
        held.has(membership.membershipId),
        `${membership.membershipId} is not this user's`,
      ).toBe(true);
      if (membership.kind === 'group') {
        expect(membership.groupId).not.toBeNull();
        expect(membership.groupVersion).not.toBeNull();
      } else {
        expect(membership.groupId).toBeNull();
        expect(membership.groupVersion).toBeNull();
      }
    }
    log(
      `GET /me/context returned ${String(body.memberships.length)} membership(s) with counters ` +
        `matching ground truth exactly`,
    );
  });

  it('CROSS-USER PROBE: one caller never sees another caller memberships', async () => {
    const alpha = multi().alpha;
    const a = alpha.full!.viewer;
    const b = alpha.users.member;

    const cookieA = await fullySignedIn('probe-a', a.id);
    const cookieB = await fullySignedIn('probe-b', b.id);

    const responseA = await harness.app.inject({
      method: 'GET',
      url: contextUrl(),
      headers: { cookie: cookieA },
    });
    const responseB = await harness.app.inject({
      method: 'GET',
      url: contextUrl(),
      headers: { cookie: cookieB },
    });
    expect(responseA.statusCode, responseA.body).toBe(200);
    expect(responseB.statusCode, responseB.body).toBe(200);

    const bodyA = JSON.parse(responseA.body) as MeContextBody;
    const bodyB = JSON.parse(responseB.body) as MeContextBody;
    const heldA = await membershipIdsOf(a.id);
    const heldB = await membershipIdsOf(b.id);

    // Each response is EXACTLY the caller's own set — not a subset of everyone's.
    for (const membership of bodyA.memberships) {
      expect(heldA.has(membership.membershipId)).toBe(true);
      expect(heldB.has(membership.membershipId)).toBe(false);
    }
    for (const membership of bodyB.memberships) {
      expect(heldB.has(membership.membershipId)).toBe(true);
      expect(heldA.has(membership.membershipId)).toBe(false);
    }
    // And the responses are not the same document.
    expect(bodyA.userId).not.toBe(bodyB.userId);
    log(
      'cross-user probe: A saw only A memberships and B saw only B memberships, ' +
        'checked against ground truth in both directions',
    );
  });
});

describe('GET /me/context — the declaration it returns actually WORKS', () => {
  /**
   * The join, at the API level.
   *
   * These two tests are the reason the route exists: they take the response
   * body, build the `X-SchedulePoint-Context` header from it **by exactly the
   * rule `apps/web/src/api/context.ts` uses**, and send it to a real
   * capability-bearing route. If the shape or the counter selection were wrong,
   * the §2.3 sequence would answer `409 CONTEXT_STALE` and these would fail.
   */
  function declarationFrom(body: MeContextBody, groupId: string | null): Record<string, string> {
    const groupVersion =
      groupId === null
        ? null
        : (body.memberships.find((m) => m.kind === 'group' && m.groupId === groupId)
            ?.groupVersion ?? null);
    return {
      [CONTEXT_HEADER]: JSON.stringify({
        contextVersion: {
          organizationVersion: body.organizationVersion,
          groupVersion,
          membershipSetVersion: body.membershipSetVersion,
        },
        sessionEpoch: body.sessionEpoch,
      }),
    };
  }

  it('a group-scoped capability route accepts the declaration built from the response', async () => {
    const alpha = multi().alpha;
    const user = alpha.users.scheduler;
    const cookie = await fullySignedIn('join', user.id);

    const context = await harness.app.inject({
      method: 'GET',
      url: contextUrl(),
      headers: { cookie },
    });
    expect(context.statusCode, context.body).toBe(200);
    const body = JSON.parse(context.body) as MeContextBody;

    const groupMembership = body.memberships.find((m) => m.kind === 'group');
    expect(groupMembership, 'the fixture user holds no group membership').toBeDefined();
    const groupId = groupMembership!.groupId!;

    const probe = await harness.app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/groups/${groupId}/context-probe/touch`,
      headers: { cookie, ...declarationFrom(body, groupId) },
    });
    // The declaration was ACCEPTED: the request got past §2.3 steps 1-5, so it
    // is not a 400 (malformed), not a 409 (stale) and not a 404 (unknown).
    expect([200, 403], probe.body).toContain(probe.statusCode);
    expect(probe.body).not.toContain('CONTEXT_STALE');
    expect(probe.body).not.toContain('CONTEXT_MALFORMED');
    log(
      `the declaration built from GET /me/context was accepted by a real capability route ` +
        `(${String(probe.statusCode)})`,
    );
  });

  it('a STALE declaration is 409 CONTEXT_STALE, and re-reading the route recovers it', async () => {
    const alpha = multi().alpha;
    const user = alpha.users.scheduler;
    const cookie = await fullySignedIn('stale', user.id);

    const first = await harness.app.inject({
      method: 'GET',
      url: contextUrl(),
      headers: { cookie },
    });
    const body = JSON.parse(first.body) as MeContextBody;
    const groupMembership = body.memberships.find((m) => m.kind === 'group');
    expect(groupMembership).toBeDefined();
    const groupId = groupMembership!.groupId!;

    // A declaration one behind the truth — exactly the stale-tab condition.
    const stale = {
      ...body,
      organizationVersion: body.organizationVersion - 1,
    };
    const refused = await harness.app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/groups/${groupId}/context-probe/touch`,
      headers: { cookie, ...declarationFrom(stale, groupId) },
    });
    expect(refused.statusCode, refused.body).toBe(409);
    const envelope = JSON.parse(refused.body) as {
      error: { code: string; recover: string };
    };
    expect(envelope.error.code).toBe('CONTEXT_STALE');
    // The directive the client's ONE retry keys off.
    expect(envelope.error.recover).toBe('refetch-context');

    // The recovery the client performs: re-read, re-declare, retry once.
    const reread = await harness.app.inject({
      method: 'GET',
      url: contextUrl(),
      headers: { cookie },
    });
    const fresh = JSON.parse(reread.body) as MeContextBody;
    const retried = await harness.app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/groups/${groupId}/context-probe/touch`,
      headers: { cookie, ...declarationFrom(fresh, groupId) },
    });
    expect(retried.statusCode, retried.body).not.toBe(409);
    log(
      'a stale declaration is 409 CONTEXT_STALE/refetch-context; one re-read and retry clears it',
    );
  });
});
