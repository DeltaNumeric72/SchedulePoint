import { sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SECOND_MS } from '../../src/authn/clock.js';
import { AuthnError } from '../../src/authn/errors.js';
import { hashRecoveryCode } from '../../src/authn/service.js';
import * as store from '../../src/authn/store.js';
import { DEFAULT_TOTP_PARAMETERS, hotp, verifyTotp } from '../../src/authn/totp.js';
import { adminClient } from '../support/admin-client.js';
import {
  FIXTURE_PASSWORD,
  base32Decode,
  codeFor,
  organizationCommand,
  testAuthnService,
} from '../support/authn.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * TOTP: the algorithm against the RFC's own vectors, and **RED CASE 6** — a
 * replayed time step is refused.
 *
 * ## The algorithm is checked against RFC 6238 appendix B, not against itself
 *
 * A hand-written HOTP that is wrong in a consistent way passes every test
 * written from the same implementation. The vectors below come from the RFC and
 * are the only reason to trust `hotp` at all.
 *
 * ## Replay is refused at TWO layers, and both are exercised
 *
 * A code is valid for a whole time step (30 s), so "the code was right" is not
 * enough — the same right code is right again a second later, which is exactly
 * long enough for a shoulder-surfed code to be reused.
 *
 *  - the STATEMENT: `acceptMfaTimeStep` updates only when the step is strictly
 *    newer, so a second presentation affects no row and is refused;
 *  - the TRIGGER: `user_mfa_guard_step_monotonic` raises for any caller that
 *    reaches the table another way, including the table owner.
 */

const multi = ownedMulti('authn-mfa', { profile: 'full' });

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

describe('RFC 6238 appendix B', () => {
  // The RFC's shared secret: the ASCII string "12345678901234567890",
  // repeated/truncated to the algorithm's key length.
  const SHA1_SECRET = Buffer.from('12345678901234567890', 'ascii');
  const SHA256_SECRET = Buffer.from('12345678901234567890123456789012', 'ascii');

  it('reproduces the published 8-digit vectors for SHA-1', () => {
    const parameters = { algorithm: 'SHA1' as const, digits: 8, periodSeconds: 30 };
    const vectors: [number, string][] = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [seconds, expected] of vectors) {
      const step = Math.floor(seconds / parameters.periodSeconds);
      expect(hotp(SHA1_SECRET, step, parameters), `T=${String(seconds)}`).toBe(expected);
    }
    log(`${String(vectors.length)} RFC 6238 SHA-1 vectors reproduced`);
  });

  it('reproduces the published 8-digit vectors for SHA-256', () => {
    const parameters = { algorithm: 'SHA256' as const, digits: 8, periodSeconds: 30 };
    const vectors: [number, string][] = [
      [59, '46119246'],
      [1111111109, '68084774'],
      [1111111111, '67062674'],
      [1234567890, '91819424'],
      [2000000000, '90698825'],
      [20000000000, '77737706'],
    ];
    for (const [seconds, expected] of vectors) {
      const step = Math.floor(seconds / parameters.periodSeconds);
      expect(hotp(SHA256_SECRET, step, parameters), `T=${String(seconds)}`).toBe(expected);
    }
    log(`${String(vectors.length)} RFC 6238 SHA-256 vectors reproduced`);
  });

  it('the skew window is one step either side, and nothing wider', () => {
    const at = new Date('2026-03-01T09:00:15.000Z');
    const step = Math.floor(at.getTime() / 1000 / 30);
    for (const offset of [-1, 0, 1]) {
      const code = hotp(SHA1_SECRET, step + offset, DEFAULT_TOTP_PARAMETERS);
      expect(
        verifyTotp(SHA1_SECRET, code, at, DEFAULT_TOTP_PARAMETERS),
        `offset ${String(offset)} was rejected`,
      ).toEqual({ timeStep: step + offset });
    }
    for (const offset of [-2, 2, 10]) {
      const code = hotp(SHA1_SECRET, step + offset, DEFAULT_TOTP_PARAMETERS);
      expect(
        verifyTotp(SHA1_SECRET, code, at, DEFAULT_TOTP_PARAMETERS),
        `offset ${String(offset)} was ACCEPTED — the window is wider than one step`,
      ).toBeUndefined();
    }
  });
});

interface Enrolled {
  readonly userId: string;
  readonly loginEmail: string;
  readonly secretBase32: string;
  readonly recoveryCodes: readonly string[];
  readonly mfaId: string;
}

async function enrol(
  authn: ReturnType<typeof testAuthnService>['authn'],
  clock: ReturnType<typeof testAuthnService>['clock'],
  label: string,
  userId: string,
): Promise<Enrolled> {
  const alpha = multi().alpha;
  const asAdmin = organizationCommand(
    alpha.organizationId,
    alpha.users.organizationAdmin.membershipId,
    `mfa-${label}`,
  );
  const anonymous = organizationCommand(alpha.organizationId, null, `mfa-${label}-anon`);

  const invitation = await runtime.runner.run(asAdmin, (uow) =>
    authn.issueInvitation(uow, {
      userId,
      email: `mfa-${label}@example.test`,
      notificationRef: 'sink:mfa',
    }),
  );
  await runtime.runner.run(anonymous, (uow) =>
    authn.activateAccount(uow, { token: invitation.token, password: FIXTURE_PASSWORD }),
  );
  const loginEmail = await runtime.runner.run(anonymous, async (uow) => {
    const row = await store.findCredentialById(uow, userId);
    return row!.loginEmail;
  });
  const start = await runtime.runner.run(anonymous, (uow) =>
    authn.startMfaEnrolment(uow, { userId, label: loginEmail }),
  );
  const confirmed = await runtime.runner.run(anonymous, (uow) =>
    authn.confirmMfaEnrolment(uow, { userId, code: codeFor(start.secretBase32, clock.now()) }),
  );
  // The confirmation CONSUMED the current time step — that is the replay
  // defence working, and it means a challenge in the same step would be refused
  // for the right reason at the wrong moment. Advancing one step is what a real
  // device does by waiting; here it is a number.
  clock.advance(31 * SECOND_MS);
  const row = await runtime.runner.run(anonymous, (uow) => store.findMfaForUser(uow, userId));
  return {
    userId,
    loginEmail,
    secretBase32: start.secretBase32,
    recoveryCodes: confirmed.recoveryCodes,
    mfaId: row!.id,
  };
}

describe('enrolment', () => {
  it('a provisioned factor is NOT in force until a valid code confirms it', async () => {
    const alpha = multi().alpha;
    const { authn, clock } = testAuthnService();
    const user = alpha.full!.viewer;
    const asAdmin = organizationCommand(
      alpha.organizationId,
      alpha.users.organizationAdmin.membershipId,
      'mfa-provision',
    );
    const anonymous = organizationCommand(alpha.organizationId, null, 'mfa-provision-anon');

    const invitation = await runtime.runner.run(asAdmin, (uow) =>
      authn.issueInvitation(uow, {
        userId: user.id,
        email: 'mfa-provision@example.test',
        notificationRef: 'sink:mfa',
      }),
    );
    await runtime.runner.run(anonymous, (uow) =>
      authn.activateAccount(uow, { token: invitation.token, password: FIXTURE_PASSWORD }),
    );
    const loginEmail = await runtime.runner.run(anonymous, async (uow) => {
      const row = await store.findCredentialById(uow, user.id);
      return row!.loginEmail;
    });

    const start = await runtime.runner.run(anonymous, (uow) =>
      authn.startMfaEnrolment(uow, { userId: user.id, label: loginEmail }),
    );
    const provisioned = await runtime.runner.run(anonymous, (uow) =>
      store.findMfaForUser(uow, user.id),
    );
    expect(provisioned?.state).toBe('provisioned');

    // Signing in now must NOT report `mfa_required`: the factor is not in force,
    // so demanding it would lock the account out of the only flow that could
    // confirm it.
    const signedIn = await runtime.runner.run(anonymous, (uow) =>
      authn.signIn(uow, { loginEmail, password: FIXTURE_PASSWORD }),
    );
    expect(signedIn.state).not.toBe('mfa_required');

    // A WRONG code does not confirm it.
    await expect(
      runtime.runner.run(anonymous, (uow) =>
        authn.confirmMfaEnrolment(uow, { userId: user.id, code: '000000' }),
      ),
    ).rejects.toThrow(AuthnError);
    expect(
      (await runtime.runner.run(anonymous, (uow) => store.findMfaForUser(uow, user.id)))?.state,
    ).toBe('provisioned');

    // The right one does, and hands back recovery codes ONCE.
    const confirmed = await runtime.runner.run(anonymous, (uow) =>
      authn.confirmMfaEnrolment(uow, {
        userId: user.id,
        code: codeFor(start.secretBase32, clock.now()),
      }),
    );
    expect(confirmed.recoveryCodes.length).toBe(10);
    const row = await runtime.runner.run(anonymous, (uow) => store.findMfaForUser(uow, user.id));
    expect(row?.state).toBe('active');

    // Only their HASHES are stored — the codes themselves appear nowhere.
    const stored = row!.recoveryCodes.map((entry) => entry.h);
    for (const code of confirmed.recoveryCodes) {
      expect(stored).toContain(hashRecoveryCode(code));
      expect(stored).not.toContain(code);
    }
    log('a provisioned factor is inert until confirmed; recovery codes are stored hashed only');
  });

  it('the stored secret is CIPHERTEXT: the raw bytes are nowhere in the row', async () => {
    const alpha = multi().alpha;
    const { authn, clock } = testAuthnService();
    const enrolled = await enrol(authn, clock, 'ciphertext', alpha.full!.telecom.id);

    const row = await admin.query<{
      secret_ciphertext: Buffer;
      secret_nonce: Buffer;
      secret_tag: Buffer;
      key_version: number;
    }>(
      `select secret_ciphertext, secret_nonce, secret_tag, key_version from user_mfa
        where id = $1::uuid`,
      [enrolled.mfaId],
    );
    const raw = base32Decode(enrolled.secretBase32);
    expect(row.rows[0]!.secret_ciphertext.includes(raw)).toBe(false);
    expect(row.rows[0]!.secret_nonce.length).toBe(12);
    expect(row.rows[0]!.secret_tag.length).toBe(16);
    expect(row.rows[0]!.key_version).toBeGreaterThan(0);

    // A tampered ciphertext AUTHENTICATES-FAILS rather than decrypting to
    // rubbish, so a challenge against it is refused rather than accepted by
    // accident.
    const { fixtureSecretBox } = await import('../support/authn.js');
    const box = fixtureSecretBox();
    const tampered = Buffer.from(row.rows[0]!.secret_ciphertext);
    tampered[0] = (tampered[0]! ^ 0xff) & 0xff;
    expect(
      box.open(
        {
          ciphertext: tampered,
          nonce: row.rows[0]!.secret_nonce,
          tag: row.rows[0]!.secret_tag,
          keyVersion: row.rows[0]!.key_version,
        },
        { organizationId: alpha.organizationId, userId: enrolled.userId },
      ),
    ).toBeUndefined();

    // And a ciphertext moved to ANOTHER user's row fails too — the binding is
    // authenticated, so a row swap is not a factor transplant.
    expect(
      box.open(
        {
          ciphertext: row.rows[0]!.secret_ciphertext,
          nonce: row.rows[0]!.secret_nonce,
          tag: row.rows[0]!.secret_tag,
          keyVersion: row.rows[0]!.key_version,
        },
        { organizationId: alpha.organizationId, userId: alpha.users.member.id },
      ),
    ).toBeUndefined();
    log('the TOTP secret is stored as AES-256-GCM ciphertext bound to (organization, user)');
  });
});

describe('RED CASE 6 — a replayed time step is refused', () => {
  it('the same code twice: accepted once, refused the second time, by the STATEMENT', async () => {
    const alpha = multi().alpha;
    const { authn, clock } = testAuthnService();
    const enrolled = await enrol(authn, clock, 'replay', alpha.full!.groupAdmin.id);
    const anonymous = organizationCommand(alpha.organizationId, null, 'mfa-replay');

    const first = await runtime.runner.run(anonymous, (uow) =>
      authn.signIn(uow, { loginEmail: enrolled.loginEmail, password: FIXTURE_PASSWORD }),
    );
    const second = await runtime.runner.run(anonymous, (uow) =>
      authn.signIn(uow, { loginEmail: enrolled.loginEmail, password: FIXTURE_PASSWORD }),
    );

    const code = codeFor(enrolled.secretBase32, clock.now());
    await runtime.runner.run(anonymous, (uow) =>
      authn.challengeMfa(uow, {
        userId: enrolled.userId,
        sessionId: first.sessionId,
        code,
      }),
    );

    // The SAME code, on a different session, within the same time step. This is
    // exactly the shoulder-surfing case, and it must fail.
    await expect(
      runtime.runner.run(anonymous, (uow) =>
        authn.challengeMfa(uow, {
          userId: enrolled.userId,
          sessionId: second.sessionId,
          code,
        }),
      ),
    ).rejects.toThrow(AuthnError);

    const sessions = await admin.query<{ mfa_satisfied: boolean; id: string }>(
      'select id::text as id, mfa_satisfied from sessions where id = any($1::uuid[])',
      [[first.sessionId, second.sessionId]],
    );
    const satisfied = new Map(sessions.rows.map((r) => [r.id, r.mfa_satisfied]));
    expect(satisfied.get(first.sessionId)).toBe(true);
    expect(
      satisfied.get(second.sessionId),
      'a replayed code satisfied a second session',
    ).toBe(false);

    // The NEXT step's code works, so the refusal was about the step and not
    // about the factor being broken.
    clock.advance(31 * SECOND_MS);
    await runtime.runner.run(anonymous, (uow) =>
      authn.challengeMfa(uow, {
        userId: enrolled.userId,
        sessionId: second.sessionId,
        code: codeFor(enrolled.secretBase32, clock.now()),
      }),
    );
    log('a code replayed within its time step was refused; the next step\'s code was accepted');
  });

  it('the TRIGGER refuses a replayed step for the OWNER too, not only for the application', async () => {
    const alpha = multi().alpha;
    const { authn, clock } = testAuthnService();
    const enrolled = await enrol(authn, clock, 'trigger', alpha.full!.dualRole.id);
    const anonymous = organizationCommand(alpha.organizationId, null, 'mfa-trigger');

    const row = await runtime.runner.run(anonymous, (uow) =>
      store.findMfaForUser(uow, enrolled.userId),
    );
    const accepted = Number(row!.lastAcceptedTimeStep);
    expect(accepted).toBeGreaterThan(0);

    /* The two layers refuse DIFFERENT things, and saying so precisely is the
     * point of splitting them:
     *
     *   the STATEMENT refuses a REPEAT — `acceptMfaTimeStep` updates only when
     *     the step is strictly newer, so re-presenting the accepted step affects
     *     no row. That is the replay case, and it is the one that happens.
     *   the TRIGGER refuses a REGRESSION — moving the accepted step BACKWARDS,
     *     which is what a caller reaching the table another way would have to do
     *     to make a spent code live again. It fires for the table OWNER, where a
     *     missing grant would not help.
     *
     * Writing the trigger to also raise on an unchanged value looked stricter
     * and was a defect: consuming a recovery code writes `recovery_codes` and
     * leaves the step alone, and it was refused with a replay error. Found by
     * running it. */
    expect(
      await runtime.runner.run(anonymous, (uow) =>
        store.acceptMfaTimeStep(uow, { mfaId: enrolled.mfaId, timeStep: accepted }),
      ),
      'the statement accepted the SAME time step twice',
    ).toBe(false);

    const owner = createRuntime('app_migrator');
    try {
      await expect(
        owner.runner.run(anonymous, async (uow) => {
          await sql`
            update user_mfa set last_accepted_time_step = ${accepted - 5}
             where id = ${enrolled.mfaId}::uuid
          `.execute(uow.query);
        }),
      ).rejects.toThrow(/MFA_TIME_STEP_REPLAY/);
    } finally {
      await owner.destroy();
    }
    log('the statement refuses a repeated step; the trigger refuses a regression, for the owner');
  });
});

describe('recovery codes', () => {
  it('a recovery code works exactly once, and the second presentation is refused', async () => {
    const alpha = multi().alpha;
    const { authn, clock } = testAuthnService();
    const enrolled = await enrol(authn, clock, 'recovery', alpha.full!.organizationObserver.id);
    const anonymous = organizationCommand(alpha.organizationId, null, 'mfa-recovery');
    const code = enrolled.recoveryCodes[0]!;

    const first = await runtime.runner.run(anonymous, (uow) =>
      authn.signIn(uow, { loginEmail: enrolled.loginEmail, password: FIXTURE_PASSWORD }),
    );
    await runtime.runner.run(anonymous, (uow) =>
      authn.challengeMfa(uow, {
        userId: enrolled.userId,
        sessionId: first.sessionId,
        recoveryCode: code,
      }),
    );

    const second = await runtime.runner.run(anonymous, (uow) =>
      authn.signIn(uow, { loginEmail: enrolled.loginEmail, password: FIXTURE_PASSWORD }),
    );
    await expect(
      runtime.runner.run(anonymous, (uow) =>
        authn.challengeMfa(uow, {
          userId: enrolled.userId,
          sessionId: second.sessionId,
          // Deliberately in a different case and without the separator: the
          // normalisation must not be what makes a consumed code work again.
          recoveryCode: code.toLowerCase().replace('-', ''),
        }),
      ),
    ).rejects.toThrow(AuthnError);

    // A DIFFERENT code still works, so the refusal was about that one code.
    await runtime.runner.run(anonymous, (uow) =>
      authn.challengeMfa(uow, {
        userId: enrolled.userId,
        sessionId: second.sessionId,
        recoveryCode: enrolled.recoveryCodes[1]!,
      }),
    );
    log('a recovery code is single-use under normalisation; a sibling code still works');
  });

  it('presenting BOTH a code and a recovery code is refused', async () => {
    const alpha = multi().alpha;
    const { authn, clock } = testAuthnService();
    const enrolled = await enrol(authn, clock, 'both', alpha.users.groupTwoScheduler.id);
    const anonymous = organizationCommand(alpha.organizationId, null, 'mfa-both');
    const session = await runtime.runner.run(anonymous, (uow) =>
      authn.signIn(uow, { loginEmail: enrolled.loginEmail, password: FIXTURE_PASSWORD }),
    );
    await expect(
      runtime.runner.run(anonymous, (uow) =>
        authn.challengeMfa(uow, {
          userId: enrolled.userId,
          sessionId: session.sessionId,
          code: codeFor(enrolled.secretBase32, clock.now()),
          recoveryCode: enrolled.recoveryCodes[0]!,
        }),
      ),
    ).rejects.toThrow(/exactly one/);
  });
});
