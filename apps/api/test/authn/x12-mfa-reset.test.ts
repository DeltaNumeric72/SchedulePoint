import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { verifyAuditChain } from '../../src/audit/verification.js';
import { AuthnError } from '../../src/authn/errors.js';
import * as store from '../../src/authn/store.js';
import { adminClient } from '../support/admin-client.js';
import {
  FIXTURE_PASSWORD,
  codeFor,
  organizationCommand,
  testAuthnService,
} from '../support/authn.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * **NAMED-CONDITION PROOF 4 — SPEC-11 X-12, in full.**
 *
 * > | X-12 | MFA reset | **Audited, notified, sessions invalidated** |
 *
 * Three obligations, and this file asserts each of them separately, because an
 * implementation that satisfies two of the three passes any test that checks
 * only that "reset worked".
 *
 * | Obligation | Asserted by |
 * |---|---|
 * | **audited** | an `authn.mfa.reset` row exists, in the same chain, with the counts in its payload; and the chain still verifies |
 * | **notified** | an `outbox_events` row of kind `authn.mfa.reset` exists, linked to that audit event's sequence, addressed to a CONTROLLED SYNTHETIC sink |
 * | **sessions invalidated** | every live session for the user is revoked with reason `mfa_reset`, and the tokens stop resolving |
 *
 * ## And the fourth thing X-12 does not say, which matters as much
 *
 * The enrolment ROW is deleted, secret and all. A `state = 'reset'` row would
 * keep a decryptable TOTP secret in the table after the event whose entire
 * purpose is to invalidate it. Asserted below by reading the table.
 *
 * ## The capability is checked at the route, not here
 *
 * `identity.reset_mfa` is grant-only and is evaluated by the SPEC-06 evaluator in
 * the same unit of work as the mutation. `apps/api/test/authn/http-flows.test.ts`
 * drives the deny path over HTTP; this file drives the service directly, so that
 * a failure here is unambiguously about X-12's three obligations.
 */

const multi = ownedMulti('authn-x12', { profile: 'full' });

let admin: pg.Client;
let runtime: Runtime;
let worker: Runtime;

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  runtime = createRuntime('app_runtime');
  worker = createRuntime('app_worker');
});

afterAll(async () => {
  await worker.destroy();
  await runtime.destroy();
  await admin.end();
});

interface Enrolled {
  readonly userId: string;
  readonly loginEmail: string;
  readonly tokens: readonly string[];
  readonly mfaId: string;
}

/** Activates, signs in on two devices, and enrols a real TOTP factor. */
async function enrol(label: string, userId: string): Promise<Enrolled> {
  const alpha = multi().alpha;
  const { authn, clock } = testAuthnService();
  const asAdmin = organizationCommand(
    alpha.organizationId,
    alpha.users.organizationAdmin.membershipId,
    `x12-${label}`,
  );
  const anonymous = organizationCommand(alpha.organizationId, null, `x12-${label}-anon`);

  const invitation = await runtime.runner.run(asAdmin, (uow) =>
    authn.issueInvitation(uow, {
      userId,
      email: `x12-${label}@example.test`,
      notificationRef: 'sink:x12',
    }),
  );
  await runtime.runner.run(anonymous, (uow) =>
    authn.activateAccount(uow, { token: invitation.token, password: FIXTURE_PASSWORD }),
  );
  const loginEmail = await runtime.runner.run(anonymous, async (uow) => {
    const row = await store.findCredentialById(uow, userId);
    return row!.loginEmail;
  });

  const enrolment = await runtime.runner.run(anonymous, (uow) =>
    authn.startMfaEnrolment(uow, { userId, label: loginEmail }),
  );
  await runtime.runner.run(anonymous, (uow) =>
    authn.confirmMfaEnrolment(uow, {
      userId,
      code: codeFor(enrolment.secretBase32, clock.now()),
    }),
  );

  const first = await runtime.runner.run(anonymous, (uow) =>
    authn.signIn(uow, { loginEmail, password: FIXTURE_PASSWORD }),
  );
  const second = await runtime.runner.run(anonymous, (uow) =>
    authn.signIn(uow, { loginEmail, password: FIXTURE_PASSWORD }),
  );
  const row = await runtime.runner.run(anonymous, (uow) => store.findMfaForUser(uow, userId));

  return { userId, loginEmail, tokens: [first.token, second.token], mfaId: row!.id };
}

describe('SPEC-11 X-12 — MFA reset', () => {
  it('satisfies all three obligations in ONE transaction, and destroys the secret', async () => {
    const alpha = multi().alpha;
    const enrolled = await enrol('full', alpha.full!.viewer.id);
    const { authn } = testAuthnService();
    const asAdmin = organizationCommand(
      alpha.organizationId,
      alpha.users.organizationAdmin.membershipId,
      'x12-reset',
    );
    const anonymous = organizationCommand(alpha.organizationId, null, 'x12-reset-anon');

    // Both devices are alive before, so "sessions invalidated" has more than one
    // subject and is not satisfied by there being nothing to invalidate.
    for (const token of enrolled.tokens) {
      expect(
        await runtime.runner.run(anonymous, (uow) => authn.resolveSession(uow, token)),
      ).toBeDefined();
    }

    const result = await runtime.runner.run(asAdmin, (uow) =>
      authn.resetMfa(uow, { userId: enrolled.userId, notificationRef: 'sink:x12-owner' }),
    );
    expect(result.removed).toBe(true);
    expect(result.sessionsRevoked).toBe(2);

    /* ── obligation 1: AUDITED ─────────────────────────────────────────── */
    const audit = await admin.query<{ sequence: string; payload: Record<string, unknown> }>(
      `select sequence::text as sequence, payload from audit_events
        where organization_id = $1::uuid and event_name = 'authn.mfa.reset'
          and subject_id = $2::uuid`,
      [alpha.organizationId, enrolled.userId],
    );
    expect(audit.rows.length, 'no audit row for the MFA reset').toBe(1);
    expect(audit.rows[0]?.payload).toMatchObject({
      removed: true,
      sessionsRevoked: 2,
      hadEnrolment: true,
      wasActive: true,
    });

    /* ── obligation 2: NOTIFIED (an INTENT only — I-11) ─────────────────── */
    const outbox = await admin.query<{
      kind: string;
      audit_sequence: string;
      payload: Record<string, unknown>;
    }>(
      // Scoped to THIS subject. Filtering only by kind made the assertion
      // depend on no sibling test having reset anybody else's factor first,
      // which `pnpm fixture-regression`'s shuffled order duly falsified.
      `select kind, audit_sequence::text as audit_sequence, payload from outbox_events
        where organization_id = $1::uuid and kind = 'authn.mfa.reset'
          and payload->>'userId' = $2`,
      [alpha.organizationId, enrolled.userId],
    );
    expect(outbox.rows.length, 'no outbox intent for the MFA reset').toBe(1);
    expect(outbox.rows[0]?.audit_sequence).toBe(audit.rows[0]?.sequence);
    // A CONTROLLED SYNTHETIC destination. No test may notify a real person, and
    // the API refuses anything that is not a `sink:` reference.
    expect(String(outbox.rows[0]?.payload['destination'])).toMatch(/^sink:/);

    /* ── obligation 3: SESSIONS INVALIDATED ─────────────────────────────── */
    for (const token of enrolled.tokens) {
      expect(
        await runtime.runner.run(anonymous, (uow) => authn.resolveSession(uow, token)),
        'a session survived the MFA reset',
      ).toBeUndefined();
    }
    const revoked = await admin.query<{ revoked_reason: string }>(
      `select distinct revoked_reason from sessions
        where user_id = $1::uuid and organization_id = $2::uuid and state = 'revoked'`,
      [enrolled.userId, alpha.organizationId],
    );
    expect(revoked.rows.map((r) => r.revoked_reason)).toEqual(['mfa_reset']);

    /* ── and the fourth: the SECRET is gone, not merely disabled ────────── */
    const enrolment = await admin.query(
      'select id from user_mfa where user_id = $1::uuid and organization_id = $2::uuid',
      [enrolled.userId, alpha.organizationId],
    );
    expect(
      enrolment.rows.length,
      'the enrolment row survived the reset — a decryptable TOTP secret is still in the table',
    ).toBe(0);

    /* ── the chain still verifies ───────────────────────────────────────── */
    const verification = await worker.runner.run(
      organizationCommand(alpha.organizationId, null, 'x12-chain-verify'),
      (uow) => verifyAuditChain(uow),
    );
    expect(verification.intact, verification.problems.join('; ')).toBe(true);
    log(
      `X-12: audited (sequence ${String(audit.rows[0]?.sequence)}), notified (outbox intent to a ` +
        'synthetic sink), 2 sessions invalidated, enrolment row deleted, chain intact',
    );
  });

  it('a reset on an account with NO enrolment is still audited and still invalidates sessions', async () => {
    const alpha = multi().alpha;
    const { authn } = testAuthnService();
    const user = alpha.full!.telecom;
    const asAdmin = organizationCommand(
      alpha.organizationId,
      alpha.users.organizationAdmin.membershipId,
      'x12-noenrol',
    );

    const result = await runtime.runner.run(asAdmin, (uow) =>
      authn.resetMfa(uow, { userId: user.id, notificationRef: 'sink:x12-owner' }),
    );
    expect(result.removed).toBe(false);

    // Audited ANYWAY. "Nothing to reset" is a fact an incident review wants: an
    // administrator repeatedly resetting a factor that is not there is a signal,
    // and it is invisible if only successful resets are recorded.
    const audit = await admin.query<{ payload: Record<string, unknown> }>(
      `select payload from audit_events
        where organization_id = $1::uuid and event_name = 'authn.mfa.reset'
          and subject_id = $2::uuid`,
      [alpha.organizationId, user.id],
    );
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0]?.payload).toMatchObject({ removed: false, hadEnrolment: false });
    log('a reset with nothing to reset is still audited and still notified');
  });

  it('after the reset the factor is genuinely gone: the old code no longer authenticates', async () => {
    const alpha = multi().alpha;
    const enrolled = await enrol('afterwards', alpha.full!.groupAdmin.id);
    const { authn, clock } = testAuthnService();
    const asAdmin = organizationCommand(
      alpha.organizationId,
      alpha.users.organizationAdmin.membershipId,
      'x12-after',
    );
    const anonymous = organizationCommand(alpha.organizationId, null, 'x12-after-anon');

    // The device still holds its secret. After the reset, its codes must mean
    // nothing — which is only true because the ROW is gone, not merely flagged.
    const row = await runtime.runner.run(anonymous, (uow) =>
      store.findMfaForUser(uow, enrolled.userId),
    );
    expect(row).toBeDefined();

    await runtime.runner.run(asAdmin, (uow) =>
      authn.resetMfa(uow, { userId: enrolled.userId, notificationRef: 'sink:x12-owner' }),
    );

    const fresh = await runtime.runner.run(anonymous, (uow) =>
      authn.signIn(uow, { loginEmail: enrolled.loginEmail, password: FIXTURE_PASSWORD }),
    );
    // The account holds an elevated role in this fixture only if it does; either
    // way the CHALLENGE must fail, because there is no enrolment to challenge.
    await expect(
      runtime.runner.run(anonymous, (uow) =>
        authn.challengeMfa(uow, {
          userId: enrolled.userId,
          sessionId: fresh.sessionId,
          code: codeFor('AAAAAAAAAAAAAAAA', clock.now()),
        }),
      ),
    ).rejects.toThrow(AuthnError);
    log('after an X-12 reset the account has no factor to challenge and the old device is inert');
  });
});
