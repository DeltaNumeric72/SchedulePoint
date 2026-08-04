import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as store from '../../src/authn/store.js';
import { SESSION_COOKIE_NAME, encodeSessionCookie } from '../../src/authn/tokens.js';
import { adminClient } from '../support/admin-client.js';
import { FIXTURE_PASSWORD, organizationCommand } from '../support/authn.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import {
  buildHttpHarness,
  contextHeaders,
  currentCounters,
  type HttpHarness,
} from '../support/http.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * **NAMED-CONDITION PROOF 5 — `session_epoch` and the SPEC-06 freshness
 * evaluation.**
 *
 * SPEC-06 §4:
 *
 * > | `session_epoch` | Authentication, privilege change, impersonation start/end |
 * >
 * > `authorization_version = hash(organization_version, group_version,
 * > membership_set_version, session_epoch)`
 * >
 * > **Bump is transactional.** The counter increments **in the same transaction**
 * > as the change that caused it. A committed privilege change with an unbumped
 * > counter is impossible.
 *
 * ## What this file proves, and in what order
 *
 * 1. **Authentication bumps it, structurally.** Issuing a session bumps
 *    `users.session_epoch`, because a BEFORE INSERT trigger on `sessions` does
 *    it — not because the sign-in handler remembers to. The counter is not in
 *    any runtime role's UPDATE grant, so there is no statement the application
 *    could use to move it by itself.
 * 2. **A stale declared epoch is refused, and recoverably.** SPEC-01 §2.3 step 5
 *    answers `409 SESSION_STALE`, which the shell turns into "your context
 *    changed — reload" (doc 28 §1 rule 4). Not a 401: the session is fine, the
 *    client's picture of it is not.
 * 3. **The re-evaluation is against CURRENT state (I-19).** After the reload the
 *    same session works, and the authorization decision is taken from the new
 *    counters rather than from anything cached.
 * 4. **A credential change bumps it AND revokes**, which are two different
 *    controls: the epoch bump makes every client's cached picture stale, and the
 *    revocation makes the session itself unusable. Either alone leaves a hole.
 */

const multi = ownedMulti('authn-epoch', { profile: 'full' });

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

async function epochOf(userId: string): Promise<number> {
  const row = await admin.query<{ session_epoch: string }>(
    'select session_epoch::text as session_epoch from users where id = $1::uuid',
    [userId],
  );
  return Number(row.rows[0]?.session_epoch ?? '0');
}

async function activateAndSignIn(
  label: string,
  userId: string,
): Promise<{ token: string; loginEmail: string }> {
  const alpha = multi().alpha;
  const asAdmin = organizationCommand(
    alpha.organizationId,
    alpha.users.organizationAdmin.membershipId,
    `epoch-${label}`,
  );
  const anonymous = organizationCommand(alpha.organizationId, null, `epoch-${label}-anon`);
  const invitation = await runtime.runner.run(asAdmin, (uow) =>
    harness.authn.issueInvitation(uow, {
      userId,
      email: `epoch-${label}@example.test`,
      notificationRef: 'sink:epoch',
    }),
  );
  await runtime.runner.run(anonymous, (uow) =>
    harness.authn.activateAccount(uow, { token: invitation.token, password: FIXTURE_PASSWORD }),
  );
  const loginEmail = await runtime.runner.run(anonymous, async (uow) => {
    const row = await store.findCredentialById(uow, userId);
    return row!.loginEmail;
  });
  const signedIn = await runtime.runner.run(anonymous, (uow) =>
    harness.authn.signIn(uow, { loginEmail, password: FIXTURE_PASSWORD }),
  );
  return { token: signedIn.token, loginEmail };
}

function cookieHeaders(organizationId: string, token: string): Record<string, string> {
  return {
    cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(
      encodeSessionCookie(organizationId, token),
    )}`,
  };
}

describe('authentication bumps the epoch, and the database is what does it', () => {
  it('every issued session advances `users.session_epoch` by exactly one', async () => {
    const alpha = multi().alpha;
    const user = alpha.full!.viewer;
    const before = await epochOf(user.id);

    const { loginEmail } = await activateAndSignIn('bump', user.id);
    const afterFirst = await epochOf(user.id);
    expect(afterFirst, 'issuing a session did not advance session_epoch').toBe(before + 1);

    const anonymous = organizationCommand(alpha.organizationId, null, 'epoch-bump-second');
    await runtime.runner.run(anonymous, (uow) =>
      harness.authn.signIn(uow, { loginEmail, password: FIXTURE_PASSWORD }),
    );
    expect(await epochOf(user.id)).toBe(before + 2);

    // The session ROW records the epoch it was issued under, and that value is
    // assigned by the trigger rather than supplied by the application.
    const rows = await admin.query<{ session_epoch_at_issue: string }>(
      `select session_epoch_at_issue::text as session_epoch_at_issue from sessions
        where user_id = $1::uuid and organization_id = $2::uuid order by issued_at`,
      [user.id, alpha.organizationId],
    );
    expect(rows.rows.map((r) => Number(r.session_epoch_at_issue))).toEqual([
      before + 1,
      before + 2,
    ]);
    log(`session_epoch advanced ${String(before)} -> ${String(before + 2)} across two sign-ins`);
  });

  it('the application holds no UPDATE grant on the counter — the bump is not something it can fake', async () => {
    for (const role of ['app_runtime', 'app_worker'] as const) {
      const result = await admin.query<{ allowed: boolean }>(
        `select has_column_privilege($1, 'users', 'session_epoch', 'UPDATE') as allowed`,
        [role],
      );
      expect(
        result.rows[0]?.allowed,
        `${role} can name users.session_epoch in a SET clause`,
      ).toBe(false);
    }
    log('neither runtime role holds UPDATE on users.session_epoch');
  });
});

describe('a stale declared epoch is refused RECOVERABLY, and the retry re-evaluates', () => {
  it('409 SESSION_STALE on the stale declaration, 200 after the client reloads its counters', async () => {
    const alpha = multi().alpha;
    const user = alpha.full!.groupAdmin;
    const { token, loginEmail } = await activateAndSignIn('stale', user.id);

    const counters = await currentCounters(admin, {
      organizationId: alpha.organizationId,
      groupId: alpha.groupOne.id,
      userId: user.id,
    });
    const headers = {
      ...contextHeaders(user.id, counters, 'epochstale'),
      ...cookieHeaders(alpha.organizationId, token),
    };
    delete (headers as Record<string, string>)['x-test-principal'];

    const url = `/organizations/${alpha.organizationId}/groups/${alpha.groupOne.id}/context-probe/touch`;

    // Control: the declaration is fresh and the request succeeds. Without this,
    // a 409 below is consistent with the request never having worked.
    const before = await harness.app.inject({ method: 'POST', url, headers, payload: {} });
    expect(before.statusCode, before.body).toBe(200);

    // A second sign-in elsewhere — another device, the ordinary case — bumps the
    // epoch and makes THIS client's declaration stale.
    const anonymous = organizationCommand(alpha.organizationId, null, 'epoch-stale-second');
    await runtime.runner.run(anonymous, (uow) =>
      harness.authn.signIn(uow, { loginEmail, password: FIXTURE_PASSWORD }),
    );

    const stale = await harness.app.inject({ method: 'POST', url, headers, payload: {} });
    expect(stale.statusCode, `a stale epoch answered ${String(stale.statusCode)}`).toBe(409);
    expect(JSON.parse(stale.body).error.code).toBe('SESSION_STALE');

    // The SESSION is still fine — it is the client's picture that is stale. This
    // is the distinction the two mechanisms exist to keep: a 409 asks for a
    // reload, a 401 asks for a sign-in, and conflating them would sign a user out
    // of one device every time they signed in on another.
    const reloaded = await currentCounters(admin, {
      organizationId: alpha.organizationId,
      groupId: alpha.groupOne.id,
      userId: user.id,
    });
    const refreshed = {
      ...contextHeaders(user.id, reloaded, 'epochstale'),
      ...cookieHeaders(alpha.organizationId, token),
    };
    delete (refreshed as Record<string, string>)['x-test-principal'];
    const after = await harness.app.inject({
      method: 'POST',
      url,
      headers: refreshed,
      payload: {},
    });
    expect(after.statusCode, after.body).toBe(200);
    log('stale epoch -> 409 SESSION_STALE; the same session works again once the client reloads');
  });
});

describe('a credential change bumps the epoch AND revokes — two controls, both checked', () => {
  it('a login-email change (CAR-027) advances the epoch and kills every session', async () => {
    const alpha = multi().alpha;
    const user = alpha.full!.dualRole;
    const { token } = await activateAndSignIn('email', user.id);
    const beforeEpoch = await epochOf(user.id);

    const asAdmin = organizationCommand(
      alpha.organizationId,
      alpha.users.organizationAdmin.membershipId,
      'epoch-email-change',
    );
    const result = await runtime.runner.run(asAdmin, (uow) =>
      harness.authn.changeLoginEmail(uow, {
        userId: user.id,
        loginEmail: 'epoch-email-changed@example.test',
        notificationRef: 'sink:owner',
      }),
    );
    expect(result.sessionsRevoked).toBeGreaterThanOrEqual(1);
    expect(await epochOf(user.id), 'the epoch did not advance on a login-email change').toBe(
      beforeEpoch + 1,
    );

    const anonymous = organizationCommand(alpha.organizationId, null, 'epoch-email-check');
    expect(
      await runtime.runner.run(anonymous, (uow) => harness.authn.resolveSession(uow, token)),
      'a session survived a login-email change',
    ).toBeUndefined();
    log('a login-email change advanced session_epoch and revoked every live session');
  });

  it('a password reset does the same, through its own path', async () => {
    const alpha = multi().alpha;
    const user = alpha.full!.organizationObserver;
    const { token, loginEmail } = await activateAndSignIn('password', user.id);
    const beforeEpoch = await epochOf(user.id);
    const anonymous = organizationCommand(alpha.organizationId, null, 'epoch-password');

    const requested = await runtime.runner.run(anonymous, (uow) =>
      harness.authn.requestPasswordReset(uow, { loginEmail, notificationRef: 'sink:reset' }),
    );
    expect(requested.token, 'no reset token was issued for an activated account').toBeDefined();

    await runtime.runner.run(anonymous, (uow) =>
      harness.authn.completePasswordReset(uow, {
        token: requested.token!,
        password: 'fixture-another-perfectly-fine-passphrase',
        notificationRef: 'sink:owner',
      }),
    );

    expect(await epochOf(user.id)).toBe(beforeEpoch + 1);
    expect(
      await runtime.runner.run(anonymous, (uow) => harness.authn.resolveSession(uow, token)),
      'a session survived a password change',
    ).toBeUndefined();
    log('a completed password reset advanced session_epoch and revoked every live session');
  });
});
