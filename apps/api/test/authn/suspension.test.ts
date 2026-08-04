import { sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as store from '../../src/authn/store.js';
import { SESSION_COOKIE_NAME, encodeSessionCookie } from '../../src/authn/tokens.js';
import { adminClient } from '../support/admin-client.js';
import { NONEXISTENT_ID } from '../support/fixtures.js';
import { FIXTURE_PASSWORD, organizationCommand, testAuthnService } from '../support/authn.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { buildHttpHarness, contextHeaders, currentCounters, type HttpHarness } from '../support/http.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * **NAMED-CONDITION PROOF 2 — suspension invalidates live sessions IMMEDIATELY.**
 *
 * 14 §3: "suspension or deactivation **invalidates live sessions immediately**".
 * T-07 names session theft as the threat and this as its defence in depth.
 *
 * ## "Immediately" is proven at the database, not at the service
 *
 * The revocation is a trigger on `memberships`
 * (`memberships_revoke_sessions_on_status_change`), so it fires on the
 * transition itself. That matters for a reason a service-level implementation
 * cannot match: there is **no code path that can suspend without revoking**,
 * including a migration, a maintenance script, and a future admin surface nobody
 * has written yet. The first test below therefore suspends by writing the
 * membership row directly — the weakest possible caller — and checks the
 * sessions anyway.
 *
 * ## RED CASE 4 — mid-flight denial
 *
 * The second test suspends a membership **between** the middleware's context
 * resolution and the handler's command, using the harness's `InterleavingRunner`
 * hook, so the interleaving is exact rather than hopeful. The request must be
 * refused, and it must be refused as a `404` — a suspended member must not learn
 * that the tenant exists (SPEC-06 P-6).
 */

const multi = ownedMulti('authn-suspension', { profile: 'full' });

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

/**
 * `authn` is a PARAMETER because the clock is.
 *
 * The database arms drive a `ControllableClock`; the HTTP arms must use the
 * server's own service, whose clock is the system clock — a session issued under
 * a fixed 2026-03-01 clock is already expired to a server reading the wall
 * clock, and the resulting 401 looks exactly like an authentication defect.
 * Found by running it.
 */
async function activateAndSignIn(
  label: string,
  userId: string,
  authn = testAuthnService().authn,
): Promise<{ token: string; sessionId: string; loginEmail: string }> {
  const alpha = multi().alpha;
  const asAdmin = organizationCommand(
    alpha.organizationId,
    alpha.users.organizationAdmin.membershipId,
    `suspend-${label}`,
  );
  const anonymous = organizationCommand(alpha.organizationId, null, `suspend-${label}-anon`);

  const invitation = await runtime.runner.run(asAdmin, (uow) =>
    authn.issueInvitation(uow, {
      userId,
      email: `suspend-${label}@example.test`,
      notificationRef: 'sink:suspension',
    }),
  );
  await runtime.runner.run(anonymous, (uow) =>
    authn.activateAccount(uow, { token: invitation.token, password: FIXTURE_PASSWORD }),
  );
  const loginEmail = await runtime.runner.run(anonymous, async (uow) => {
    const row = await store.findCredentialById(uow, userId);
    if (row === undefined) throw new Error('user vanished');
    return row.loginEmail;
  });
  const signedIn = await runtime.runner.run(anonymous, (uow) =>
    authn.signIn(uow, { loginEmail, password: FIXTURE_PASSWORD }),
  );
  return { token: signedIn.token, sessionId: signedIn.sessionId, loginEmail };
}

describe('suspension revokes live sessions in the database', () => {
  it('a membership moved to `suspended` by a RAW row write still kills its sessions', async () => {
    const alpha = multi().alpha;
    const user = alpha.full!.viewer;
    const { token, sessionId } = await activateAndSignIn('raw', user.id);
    const { authn } = testAuthnService();
    const anonymous = organizationCommand(alpha.organizationId, null, 'suspend-raw-check');

    // Alive before.
    expect(
      await runtime.runner.run(anonymous, (uow) => authn.resolveSession(uow, token)),
      'the session was not alive before the suspension — the test proves nothing',
    ).toBeDefined();

    // The weakest possible caller: a direct UPDATE on `memberships` inside a
    // unit of work, with no service method involved at all.
    await runtime.runner.run(
      organizationCommand(
        alpha.organizationId,
        alpha.users.organizationAdmin.membershipId,
        'suspend-raw-write',
      ),
      async (uow) => {
        await sql`
          update memberships set status = 'suspended', updated_at = now()
           where id = ${user.membershipId}::uuid
        `.execute(uow.query);
      },
    );

    expect(
      await runtime.runner.run(anonymous, (uow) => authn.resolveSession(uow, token)),
      'the session survived a suspension written straight at the membership row',
    ).toBeUndefined();

    const row = await admin.query<{ state: string; revoked_reason: string }>(
      'select state, revoked_reason from sessions where id = $1::uuid',
      [sessionId],
    );
    expect(row.rows[0]?.state).toBe('revoked');
    expect(row.rows[0]?.revoked_reason).toBe('membership_suspended');
    log('a raw membership UPDATE revoked the live session with reason `membership_suspended`');
  });

  it('`ended` does the same, with its own reason, and every live session goes', async () => {
    const alpha = multi().alpha;
    const user = alpha.full!.telecom;
    const { token } = await activateAndSignIn('ended-a', user.id);
    const { authn } = testAuthnService();
    const anonymous = organizationCommand(alpha.organizationId, null, 'suspend-ended-check');

    // A SECOND device for the same person, so "every live session" is a claim
    // with more than one subject.
    const second = await runtime.runner.run(anonymous, async (uow) => {
      const credential = await store.findCredentialById(uow, user.id);
      return authn.signIn(uow, {
        loginEmail: credential!.loginEmail,
        password: FIXTURE_PASSWORD,
      });
    });

    await runtime.runner.run(
      organizationCommand(
        alpha.organizationId,
        alpha.users.organizationAdmin.membershipId,
        'suspend-ended-write',
      ),
      async (uow) => {
        await sql`
          update memberships set status = 'ended', valid_to = now(), updated_at = now()
           where id = ${user.membershipId}::uuid
        `.execute(uow.query);
      },
    );

    for (const [label, value] of [
      ['first device', token],
      ['second device', second.token],
    ] as const) {
      expect(
        await runtime.runner.run(anonymous, (uow) => authn.resolveSession(uow, value)),
        `${label}'s session survived the membership ending`,
      ).toBeUndefined();
    }
    const reasons = await admin.query<{ revoked_reason: string }>(
      `select distinct revoked_reason from sessions
        where user_id = $1::uuid and organization_id = $2::uuid and state = 'revoked'`,
      [user.id, alpha.organizationId],
    );
    expect(reasons.rows.map((r) => r.revoked_reason)).toContain('membership_ended');
    log('both devices were revoked with reason `membership_ended`');
  });
});

describe('RED CASE 4 — a suspended user is denied MID-FLIGHT', () => {
  it('a suspension committed between context resolution and the command denies the request as 404', async () => {
    const alpha = multi().alpha;
    const user = alpha.full!.groupAdmin;
    const { token } = await activateAndSignIn('midflight', user.id, harness.authn);

    const counters = await currentCounters(admin, {
      organizationId: alpha.organizationId,
      groupId: alpha.groupOne.id,
      userId: user.id,
    });
    const headers = {
      ...contextHeaders(user.id, counters, 'suspendmidflight'),
      cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(
        encodeSessionCookie(alpha.organizationId, token),
      )}`,
    };
    // The REAL session, not the surrogate: the test principal header is removed
    // so the server resolves the cookie through `SessionPrincipalResolver`.
    delete (headers as Record<string, string>)['x-test-principal'];

    // A control run first: without the suspension, this route succeeds. Without
    // it, "404" is consistent with the request never having been able to work.
    const before = await harness.app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/groups/${alpha.groupOne.id}/context-probe/touch`,
      headers,
      payload: {},
    });
    expect(before.statusCode, `the control run failed: ${before.body}`).toBe(200);

    /* The byte-identity BASELINE, taken while the session is still healthy: the
     * same principal addressing a group that does not exist. Taken now rather
     * than after the suspension, because after it the session is gone and the
     * answer would be 401 — which is a different (and also correct) refusal, and
     * comparing against it would prove nothing about disclosure. */
    const absent = await harness.app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/groups/${NONEXISTENT_ID}/context-probe/touch`,
      headers,
      payload: {},
    });
    expect(absent.statusCode).toBe(404);

    // Now suspend BETWEEN the middleware's resolution transaction and the
    // handler's command transaction. `InterleavingRunner.beforeRun` fires at a
    // known point, so the interleaving is exact and the test cannot be flaky.
    harness.runner.resetCalls();
    harness.runner.beforeRun = async (callIndex) => {
      if (callIndex !== 2) return;
      harness.runner.beforeRun = undefined;
      await runtime.runner.run(
        organizationCommand(
          alpha.organizationId,
          alpha.users.organizationAdmin.membershipId,
          'suspend-midflight-write',
        ),
        async (uow) => {
          await sql`
            update memberships set status = 'suspended', updated_at = now()
             where id = ${user.membershipId}::uuid
          `.execute(uow.query);
        },
      );
    };

    const during = await harness.app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/groups/${alpha.groupOne.id}/context-probe/touch`,
      headers,
      payload: {},
    });
    harness.runner.beforeRun = undefined;

    expect(
      during.statusCode,
      `a request whose principal was suspended mid-flight answered ${String(during.statusCode)}`,
    ).toBe(404);
    /* P-6: a non-member must not learn the tenant exists — and the strong form
     * of that is BYTE-IDENTITY, not the absence of a keyword. The same request
     * against a group that does not exist must produce the same body, modulo the
     * correlation id the client itself chose. */
    expect(
      during.body,
      'a mid-flight suspension and a non-existent group produce different bodies — the pair ' +
        'tells an attacker which is which',
    ).toBe(absent.body);
    expect(during.body).not.toContain(user.id);
    expect(during.body).not.toContain(user.membershipId);

    // And the next request is refused before it reaches a handler at all,
    // because the session itself is gone.
    const after = await harness.app.inject({
      method: 'POST',
      url: `/organizations/${alpha.organizationId}/groups/${alpha.groupOne.id}/context-probe/touch`,
      headers,
      payload: {},
    });
    expect(after.statusCode).toBe(401);
    log(
      'mid-flight suspension: 200 before, 404 during (no disclosure), 401 after — the session ' +
        'was revoked by the same transaction that suspended the membership',
    );
  });
});
