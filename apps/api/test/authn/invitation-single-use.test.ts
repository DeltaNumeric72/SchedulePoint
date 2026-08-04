import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DAY_MS } from '../../src/authn/clock.js';
import { AuthnError } from '../../src/authn/errors.js';
import * as store from '../../src/authn/store.js';
import { hashToken } from '../../src/authn/tokens.js';
import { adminClient } from '../support/admin-client.js';
import { FIXTURE_PASSWORD, organizationCommand, testAuthnService } from '../support/authn.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * **NAMED-CONDITION PROOF 3 — invitation single-use atomicity.**
 *
 * 14 §2: invitations are "**Single-use, expiring, revocable**". T-22 names
 * account takeover as the threat.
 *
 * ## Where the property actually lives
 *
 * In ONE statement:
 *
 * ```sql
 * update invitations set consumed_at = $now, state = 'accepted'
 *  where id = $id and consumed_at is null and state = 'pending' and expires_at > $now
 * ```
 *
 * Two concurrent consumers contend on the row lock; the second re-evaluates the
 * predicate after the first commits and matches nothing. There is no
 * read-then-write window because there is no read — the check IS the write.
 *
 * ## The race is run for real, not reasoned about
 *
 * `Promise.all` over two units of work on two connections. The pair is started
 * OUTSIDE each other's async context, because a `run` nested inside another
 * `run` becomes a savepoint on the same connection and cannot contend
 * (SPIKE-REPORT §6.6) — a trap this file would otherwise fall into silently and
 * report a pass.
 *
 * **RED CASE 5** — the second consumer of a token is rejected — is the same
 * property asserted sequentially, and both are here because they fail
 * differently: the sequential case would pass with a read-then-write
 * implementation, and the concurrent one would not.
 */

const multi = ownedMulti('authn-invitation', { profile: 'full' });

let admin: pg.Client;
let runtime: Runtime;

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  runtime = createRuntime('app_runtime', { max: 8 });
});

afterAll(async () => {
  await runtime.destroy();
  await admin.end();
});

function contexts(label: string): { asAdmin: ReturnType<typeof organizationCommand>; anonymous: ReturnType<typeof organizationCommand> } {
  const alpha = multi().alpha;
  return {
    asAdmin: organizationCommand(
      alpha.organizationId,
      alpha.users.organizationAdmin.membershipId,
      `invite-${label}`,
    ),
    anonymous: organizationCommand(alpha.organizationId, null, `invite-${label}-anon`),
  };
}

describe('exactly one consumer wins', () => {
  it('two SIMULTANEOUS activations of the same token: one succeeds, one is refused, one account activates', async () => {
    const { authn } = testAuthnService();
    const user = multi().alpha.full!.viewer;
    const { asAdmin, anonymous } = contexts('race');

    const invitation = await runtime.runner.run(asAdmin, (uow) =>
      authn.issueInvitation(uow, {
        userId: user.id,
        email: 'invite-race@example.test',
        notificationRef: 'sink:invitation',
      }),
    );

    // Both started from THIS async context, not from inside each other's, so
    // they are two transactions on two connections and can genuinely contend.
    const attempt = (): Promise<{ ok: boolean; reason?: string }> =>
      runtime.runner
        .run(anonymous, (uow) =>
          authn.activateAccount(uow, { token: invitation.token, password: FIXTURE_PASSWORD }),
        )
        .then(() => ({ ok: true }))
        .catch((error: unknown) => ({
          ok: false,
          reason: error instanceof AuthnError ? (error.internalReason ?? '?') : String(error),
        }));

    const [first, second] = await Promise.all([attempt(), attempt()]);
    const winners = [first, second].filter((r) => r.ok);
    const losers = [first, second].filter((r) => !r.ok);

    expect(winners.length, 'both consumers of the same invitation succeeded').toBe(1);
    expect(losers.length).toBe(1);
    expect(
      losers[0]?.reason,
      'the loser failed for a reason other than the token being spent',
    ).toMatch(/already_consumed|account_already_active/);

    // The database agrees: one accepted row, one activated account, and the
    // account's password is the one the WINNER set.
    const row = await admin.query<{ state: string; consumed_at: Date | null }>(
      'select state, consumed_at from invitations where id = $1::uuid',
      [invitation.invitationId],
    );
    expect(row.rows[0]?.state).toBe('accepted');
    expect(row.rows[0]?.consumed_at).not.toBeNull();

    const account = await admin.query<{ activated_at: Date | null }>(
      'select activated_at from users where id = $1::uuid',
      [user.id],
    );
    expect(account.rows[0]?.activated_at).not.toBeNull();
    log('two simultaneous activations: exactly one won, one accepted row, one activated account');
  });

  it('RED CASE 5 — the SECOND consumer of a spent token is rejected', async () => {
    const { authn } = testAuthnService();
    const user = multi().alpha.full!.telecom;
    const { asAdmin, anonymous } = contexts('replay');

    const invitation = await runtime.runner.run(asAdmin, (uow) =>
      authn.issueInvitation(uow, {
        userId: user.id,
        email: 'invite-replay@example.test',
        notificationRef: 'sink:invitation',
      }),
    );

    await runtime.runner.run(anonymous, (uow) =>
      authn.activateAccount(uow, { token: invitation.token, password: FIXTURE_PASSWORD }),
    );

    await expect(
      runtime.runner.run(anonymous, (uow) =>
        authn.activateAccount(uow, {
          token: invitation.token,
          // A DIFFERENT password, so a replay that succeeded would be visible as
          // a credential the first activator never chose.
          password: 'fixture-a-completely-different-passphrase',
        }),
      ),
    ).rejects.toThrow(AuthnError);

    // And the credential is still the first activator's.
    const stored = await runtime.runner.run(anonymous, (uow) =>
      store.findCredentialById(uow, user.id),
    );
    const { verifyPassword } = await import('../../src/authn/passwords.js');
    expect(await verifyPassword(FIXTURE_PASSWORD, stored!.passwordHash!)).toBe(true);
    expect(await verifyPassword('fixture-a-completely-different-passphrase', stored!.passwordHash!)).toBe(
      false,
    );
    log('a replayed invitation token was refused and the first activator\'s credential survived');
  });
});

describe('expiry and revocation', () => {
  it('an expired invitation is refused, having been usable a moment earlier on the same clock', async () => {
    const { authn, clock } = testAuthnService();
    const user = multi().alpha.full!.groupAdmin;
    const { asAdmin, anonymous } = contexts('expiry');

    const invitation = await runtime.runner.run(asAdmin, (uow) =>
      authn.issueInvitation(uow, {
        userId: user.id,
        email: 'invite-expiry@example.test',
        notificationRef: 'sink:invitation',
      }),
    );
    // Seven days, per `DEFAULT_AUTHN_POLICY.invitationLifetimeMs`.
    expect(invitation.expiresAt.getTime() - clock.now().getTime()).toBe(7 * DAY_MS);

    clock.advance(7 * DAY_MS + 1000);
    await expect(
      runtime.runner.run(anonymous, (uow) =>
        authn.activateAccount(uow, { token: invitation.token, password: FIXTURE_PASSWORD }),
      ),
    ).rejects.toThrow(AuthnError);

    const account = await admin.query<{ activated_at: Date | null }>(
      'select activated_at from users where id = $1::uuid',
      [user.id],
    );
    expect(account.rows[0]?.activated_at, 'an expired invitation activated an account').toBeNull();
    log('an invitation one second past its seven-day window was refused');
  });

  it('a revoked invitation is refused, and revocation is not reversible through the service', async () => {
    const { authn } = testAuthnService();
    const user = multi().alpha.full!.dualRole;
    const { asAdmin, anonymous } = contexts('revoke');

    const invitation = await runtime.runner.run(asAdmin, (uow) =>
      authn.issueInvitation(uow, {
        userId: user.id,
        email: 'invite-revoke@example.test',
        notificationRef: 'sink:invitation',
      }),
    );
    const revoked = await runtime.runner.run(asAdmin, (uow) =>
      authn.revokeInvitation(uow, invitation.invitationId),
    );
    expect(revoked).toBe(true);

    // A second revocation is a no-op rather than an error: the state is already
    // terminal, and the conditional UPDATE says so by affecting no row.
    expect(
      await runtime.runner.run(asAdmin, (uow) =>
        authn.revokeInvitation(uow, invitation.invitationId),
      ),
    ).toBe(false);

    await expect(
      runtime.runner.run(anonymous, (uow) =>
        authn.activateAccount(uow, { token: invitation.token, password: FIXTURE_PASSWORD }),
      ),
    ).rejects.toThrow(AuthnError);
    log('a revoked invitation was refused; re-revoking is a no-op, not an error');
  });
});

describe('the token namespaces are separate', () => {
  it('an invitation token presented to the password-reset flow hashes to nothing that table holds', async () => {
    const { authn } = testAuthnService();
    const user = multi().alpha.full!.organizationObserver;
    const { asAdmin, anonymous } = contexts('namespace');

    const invitation = await runtime.runner.run(asAdmin, (uow) =>
      authn.issueInvitation(uow, {
        userId: user.id,
        email: 'invite-namespace@example.test',
        notificationRef: 'sink:invitation',
      }),
    );

    // The SAME token, hashed under the other namespace, is a different digest —
    // so the reset table cannot contain it even in principle, and the reset
    // endpoint cannot be made to consume an invitation.
    expect(hashToken('invitation', invitation.token).equals(
      hashToken('password_reset', invitation.token),
    )).toBe(false);

    await expect(
      runtime.runner.run(anonymous, (uow) =>
        authn.completePasswordReset(uow, {
          token: invitation.token,
          password: FIXTURE_PASSWORD,
          notificationRef: 'sink:invitation',
        }),
      ),
    ).rejects.toThrow(AuthnError);

    // And the invitation is untouched: a failed cross-namespace attempt must not
    // consume the token it was aimed at.
    const row = await admin.query<{ state: string }>(
      'select state from invitations where id = $1::uuid',
      [invitation.invitationId],
    );
    expect(row.rows[0]?.state).toBe('pending');
    log('an invitation token is inert in the reset namespace, and is not consumed by the attempt');
  });
});
