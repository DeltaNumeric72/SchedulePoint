import { createHash } from 'node:crypto';

import type { AuditPayload, UnitOfWork } from '@schedulepoint/domain';
import type { Kysely } from 'kysely';

import { recordAuditEvent } from '../audit/recorder.js';
import { publishOutboxEvent } from '../outbox/publisher.js';
import type { Database, SessionRevokedReason } from '../db/schema.js';
import { accountStateOf, canAuthenticate } from './account-state.js';
import { systemClock, type Clock } from './clock.js';
import { DEFAULT_AUTHN_POLICY, MFA_REQUIRED_ROLES, lockoutDurationMs, type AuthnPolicy } from './config.js';
import {
  authnFailed,
  conflict,
  invalidRequest,
  tokenInvalid,
  type MfaFailureReason,
  type SignInFailureReason,
} from './errors.js';
import {
  CURRENT_SCRYPT_PARAMETERS,
  hashPassword,
  passwordPolicyProblem,
  verifyPassword,
  type ScryptParameters,
} from './passwords.js';
import { createSecretBox, type SecretBox } from './secret-box.js';
import * as store from './store.js';
import { hashToken, mintToken } from './tokens.js';
import {
  DEFAULT_TOTP_PARAMETERS,
  base32Encode,
  mintRecoveryCodes,
  mintTotpSecret,
  normalizeRecoveryCode,
  provisioningUri,
  verifyTotp,
  type TotpParameters,
} from './totp.js';

/**
 * The authentication service — every credential decision in the system.
 *
 * ## FAD-12 ordering, on every method that mutates
 *
 *     evaluate -> deny -> mutate -> audit
 *
 * all inside the caller's unit of work. The capability evaluation for the
 * administrative methods happens in the route, in the same transaction, before
 * the call; the methods here assume it has and say so in their docblocks. That
 * split is deliberate: the evaluator's input is HTTP-shaped (a route
 * declaration) and this module has no business knowing what a route is.
 *
 * ## The clock is a constructor parameter and there is no other way in
 *
 * See `clock.ts`. `createAuthnService()` passes `systemClock` unconditionally;
 * there is no setter, no environment branch and no `withClock`.
 *
 * ## Nothing here returns, logs, or audits secret material
 *
 * A token is returned to the CALLER exactly once, from the method that minted
 * it, and the caller's only sanctioned use is to put it in a cookie or an outbox
 * intent. Audit payloads carry identifiers, hashes and closed enum tokens — the
 * payload validator would reject anything else (I-07), and
 * `apps/api/test/authn/secrecy.test.ts` plants a known token and greps every
 * log line, error body, audit payload and outbox payload for it.
 */

type Uow = UnitOfWork<Kysely<Database>>;

export interface AuthnServiceOptions {
  readonly clock?: Clock;
  readonly policy?: AuthnPolicy;
  readonly secretBox?: SecretBox;
  readonly totp?: TotpParameters;
  /**
   * The issuer name in a TOTP provisioning URI. **Synthetic in every test.**
   * Never a real organization name — the value ends up in a QR code that gets
   * screenshotted.
   */
  readonly totpIssuer?: string;
  /**
   * The scrypt parameters NEW hashes are written with.
   *
   * A constructor parameter for the same reason the clock is one, and with the
   * same production default: `createAuthnService()` never passes it, so a
   * production process always uses `CURRENT_SCRYPT_PARAMETERS`.
   *
   * It exists because the test fixtures provision ~35 tenants per
   * `fixture-regression` run and each one activates accounts through the
   * PRODUCTION path. At production parameters that is ~100 ms of deliberate work
   * per hash; a fixture that paid it would push the acceptance battery past any
   * useful runtime, and a fixture that avoided it by hand-writing a hash would
   * stop exercising the path it is supposed to seed.
   *
   * **A reduced parameter set does not weaken any assertion.** The encoded hash
   * carries its own parameters, so verification is exercised identically; the
   * cost is what changes, and the cost is measured against the PRODUCTION
   * parameters in `apps/api/test/authn/password-hashing.test.ts`.
   */
  readonly scrypt?: ScryptParameters;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Results
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * What a successful credential presentation produces.
 *
 * `mfa_required` and `mfa_enrolment_required` both carry a session — a PARTIAL
 * one, whose `mfa_satisfied` is false. A partial session reaches the MFA
 * endpoints and nothing else; the route layer enforces that from the route's
 * declared `authnStage`, so it is a property of the declaration rather than of
 * each handler remembering.
 */
export type SignInState = 'authenticated' | 'mfa_required' | 'mfa_enrolment_required';

export interface SignInResult {
  readonly state: SignInState;
  readonly sessionId: string;
  /** The token, ONCE. The caller puts it in a cookie and never stores it. */
  readonly token: string;
  readonly expiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly userId: string;
}

export interface EnrolmentStartResult {
  readonly provisioningUri: string;
  /** Base32 of the secret, for a client that cannot scan. Shown once, never stored. */
  readonly secretBase32: string;
}

export interface EnrolmentConfirmResult {
  /** Shown ONCE. Only their hashes are stored. */
  readonly recoveryCodes: readonly string[];
}

export interface InvitationIssueResult {
  readonly invitationId: string;
  /** The token, ONCE, for the outbox intent. Never logged, never returned by a route. */
  readonly token: string;
  readonly expiresAt: Date;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Small helpers
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A non-identifying fingerprint of an address, for an audit payload.
 *
 * 14 §6: "`before`/`after` payloads must never embed PII or clinical content."
 * A login email IS PII (06 §3.2 classifies `users` `PII`/`SECRET`), so a
 * login-email change records the DOMAIN — which is the fact CAR-027's
 * hospital-domain-change case is about and is not personally identifying — and a
 * truncated digest of the whole address, which is enough to prove two entries
 * refer to the same address without disclosing it.
 */
function emailFingerprint(email: string): { domain: string; hash: string } {
  const at = email.lastIndexOf('@');
  const domain = at < 0 ? 'unknown' : email.slice(at + 1).toLowerCase();
  const hash = createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16);
  // A domain longer than the payload validator's 64-character limit is truncated
  // rather than rejected: an over-long domain must not make an audit write fail.
  return { domain: domain.slice(0, 60), hash };
}

export class AuthnService {
  readonly #clock: Clock;
  readonly #policy: AuthnPolicy;
  readonly #secretBox: SecretBox;
  readonly #totp: TotpParameters;
  readonly #issuer: string;
  readonly #scrypt: ScryptParameters;

  constructor(options: AuthnServiceOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#policy = options.policy ?? DEFAULT_AUTHN_POLICY;
    this.#secretBox = options.secretBox ?? createSecretBox();
    this.#totp = options.totp ?? DEFAULT_TOTP_PARAMETERS;
    this.#issuer = options.totpIssuer ?? 'SchedulePoint';
    this.#scrypt = options.scrypt ?? CURRENT_SCRYPT_PARAMETERS;
  }

  get clock(): Clock {
    return this.#clock;
  }

  get policy(): AuthnPolicy {
    return this.#policy;
  }

  /* ──────────────────────────────────────────────────────────────────────────
   * Sign in
   * ────────────────────────────────────────────────────────────────────────── */

  /**
   * Verify a credential and issue a session.
   *
   * **Every failure throws the same error with the same body** (`errors.ts`),
   * whatever went wrong, because 14 §2 requires that lockout "does not
   * distinguish 'no such account' from 'wrong password'". The distinction is
   * recorded in the audit payload, which only an authorized reader sees.
   *
   * The unknown-account path still pays for a password verification against a
   * fixed dummy hash, so the response time does not answer the question the
   * response body refuses to.
   */
  async signIn(
    uow: Uow,
    options: {
      readonly loginEmail: string;
      readonly password: string;
      readonly persistent?: boolean;
    },
  ): Promise<SignInResult> {
    const now = this.#clock.now();
    const credential = await store.findCredentialByLoginEmail(uow, options.loginEmail);

    if (credential === undefined) {
      // Constant work for an unknown address. Without this, "no such account"
      // returns in a millisecond and "wrong password" in a hundred, and the
      // uniform body is undone by the clock.
      await verifyPassword(options.password, DUMMY_HASH);
      await this.#auditSignInFailure(uow, null, 'unknown_login_email');
      throw authnFailed('unknown_login_email');
    }

    const reason = await this.#refuseCredential(uow, credential, options.password, now);
    if (reason !== undefined) {
      await this.#recordFailure(uow, credential, reason, now);
      throw authnFailed(reason);
    }

    await store.clearSignInFailures(uow, credential.id);

    const roles = await store.rolesHeldByUser(uow, credential.id);
    const mfaRequired = roles.some((role) => MFA_REQUIRED_ROLES.has(role));
    const enrolment = await store.findMfaForUser(uow, credential.id);
    const enrolled = enrolment !== undefined && enrolment.state === 'active';

    const state: SignInState = enrolled
      ? 'mfa_required'
      : mfaRequired
        ? 'mfa_enrolment_required'
        : 'authenticated';

    const issued = await this.#issueSession(uow, {
      userId: credential.id,
      persistent: options.persistent === true,
      now,
      // A session is fully authenticated at issue only when no second factor is
      // in play. Anything else starts partial.
      mfaSatisfied: state === 'authenticated',
    });

    const audit = await recordAuditEvent(uow, {
      eventName: 'authn.sign_in.succeeded',
      subjectType: 'user',
      subjectId: credential.id,
      payload: {
        sessionId: issued.session.id,
        state,
        mfaRequired,
        enrolled,
        persistent: options.persistent === true,
      },
      systemActor: uow.context.membershipId === null,
    });
    void audit;

    return {
      state,
      sessionId: issued.session.id,
      token: issued.token,
      expiresAt: issued.session.expiresAt,
      absoluteExpiresAt: issued.session.absoluteExpiresAt,
      userId: credential.id,
    };
  }

  /**
   * Everything that refuses a credential, in one place and in a fixed order.
   *
   * The order is not arbitrary: the password is verified even for an account
   * that is locked or deactivated, so those states do not become a faster path
   * than a wrong password.
   */
  async #refuseCredential(
    uow: Uow,
    credential: store.CredentialRow,
    password: string,
    now: Date,
  ): Promise<SignInFailureReason | undefined> {
    const passwordOk =
      credential.passwordHash === null
        ? (await verifyPassword(password, DUMMY_HASH), false)
        : await verifyPassword(password, credential.passwordHash);

    if (credential.lockedUntil !== null && credential.lockedUntil.getTime() > now.getTime()) {
      return 'account_locked';
    }
    if (credential.passwordHash === null) return 'no_password_set';
    if (!passwordOk) return 'wrong_password';
    if (credential.status === 'deactivated') return 'account_deactivated';
    if (!canAuthenticate({ status: credential.status, activatedAt: credential.activatedAt })) {
      return 'no_password_set';
    }
    if (!(await store.hasActiveMembership(uow, credential.id))) return 'membership_not_active';
    return undefined;
  }

  async #recordFailure(
    uow: Uow,
    credential: store.CredentialRow,
    reason: SignInFailureReason,
    now: Date,
  ): Promise<void> {
    const decayBefore = new Date(now.getTime() - this.#policy.failureDecayMs);
    const count = await store.recordSignInFailure(uow, {
      userId: credential.id,
      now,
      decayBefore,
      lockUntil: null,
    });
    const duration = lockoutDurationMs(this.#policy, count);
    if (duration > 0) {
      const until = new Date(now.getTime() + duration);
      await store.applyLock(uow, credential.id, until);
      await recordAuditEvent(uow, {
        eventName: 'authn.account.locked',
        subjectType: 'user',
        subjectId: credential.id,
        payload: { failures: count, lockedForMs: duration },
        systemActor: uow.context.membershipId === null,
      });
    }
    await this.#auditSignInFailure(uow, credential.id, reason);
  }

  /**
   * A failure for an address nobody holds still produces an audit row, with the
   * organization as its subject.
   *
   * Not recording it would make credential-stuffing against unknown addresses
   * the one attack with no trace, which is the opposite of what the audit trail
   * is for.
   */
  async #auditSignInFailure(
    uow: Uow,
    userId: string | null,
    reason: SignInFailureReason,
  ): Promise<void> {
    await recordAuditEvent(uow, {
      eventName: 'authn.sign_in.failed',
      subjectType: userId === null ? 'organization' : 'user',
      subjectId: userId ?? uow.context.organizationId,
      payload: { reason },
      // Nobody is signed in yet, so there is no acting membership to attribute
      // this to. `systemActor` is the honest answer; attributing it to the
      // account being attacked would read as that account doing something.
      systemActor: true,
    });
  }

  async #issueSession(
    uow: Uow,
    options: {
      readonly userId: string;
      readonly persistent: boolean;
      readonly now: Date;
      readonly mfaSatisfied: boolean;
      readonly rotatedFromSessionId?: string | null;
    },
  ): Promise<{ session: store.SessionRow; token: string }> {
    const token = mintToken();
    const idleMs = options.persistent
      ? this.#policy.persistentIdleLifetimeMs
      : this.#policy.idleLifetimeMs;
    const absoluteExpiresAt = new Date(options.now.getTime() + this.#policy.absoluteLifetimeMs);
    // The idle deadline never exceeds the absolute one — a persistent session's
    // fourteen-day idle window is bounded by the twelve-hour absolute window,
    // which is the whole reason "persistent" is not a second session class.
    const expiresAt = new Date(
      Math.min(options.now.getTime() + idleMs, absoluteExpiresAt.getTime()),
    );

    const session = await store.insertSession(uow, {
      userId: options.userId,
      tokenHash: hashToken('session', token),
      issuedAt: options.now,
      expiresAt,
      absoluteExpiresAt,
      persistent: options.persistent,
      rotatedFromSessionId: options.rotatedFromSessionId ?? null,
    });
    if (options.mfaSatisfied) await store.markMfaSatisfied(uow, session.id);
    return { session: { ...session, mfaSatisfied: options.mfaSatisfied }, token };
  }

  /* ──────────────────────────────────────────────────────────────────────────
   * Session lifecycle
   * ────────────────────────────────────────────────────────────────────────── */

  /**
   * Resolve a presented token to a live session, sliding its idle deadline.
   *
   * `undefined` for absent, unknown, expired (either deadline) and revoked
   * alike. The caller cannot branch on which, and no timing difference between
   * the cases exists here.
   */
  async resolveSession(uow: Uow, token: string): Promise<store.SessionRow | undefined> {
    const now = this.#clock.now();
    const session = await store.findLiveSessionByTokenHash(uow, hashToken('session', token), now);
    if (session === undefined) return undefined;

    const idleMs = session.persistent
      ? this.#policy.persistentIdleLifetimeMs
      : this.#policy.idleLifetimeMs;
    await store.slideSession(uow, {
      sessionId: session.id,
      now,
      expiresAt: new Date(now.getTime() + idleMs),
    });
    return session;
  }

  async signOut(uow: Uow, sessionId: string): Promise<void> {
    const now = this.#clock.now();
    const revoked = await store.revokeSession(uow, { sessionId, reason: 'sign_out', now });
    if (!revoked) return;
    await recordAuditEvent(uow, {
      eventName: 'authn.session.revoked',
      subjectType: 'session',
      subjectId: sessionId,
      payload: { reason: 'sign_out' },
      systemActor: uow.context.membershipId === null,
    });
  }

  /**
   * 14 §3's "rotation on privilege change": the old session is revoked and a new
   * token issued in the same transaction.
   *
   * Rotation rather than "keep the session and re-read the privileges" because a
   * session identifier captured before a privilege change is exactly what a
   * fixation attack replays afterwards.
   */
  async rotateSession(
    uow: Uow,
    options: { readonly sessionId: string; readonly userId: string; readonly persistent: boolean },
  ): Promise<{ readonly token: string; readonly sessionId: string }> {
    const now = this.#clock.now();
    await store.revokeSession(uow, { sessionId: options.sessionId, reason: 'rotated', now });
    const issued = await this.#issueSession(uow, {
      userId: options.userId,
      persistent: options.persistent,
      now,
      mfaSatisfied: true,
      rotatedFromSessionId: options.sessionId,
    });
    await recordAuditEvent(uow, {
      eventName: 'authn.session.rotated',
      subjectType: 'session',
      subjectId: issued.session.id,
      payload: { replaced: options.sessionId },
      systemActor: uow.context.membershipId === null,
    });
    return { token: issued.token, sessionId: issued.session.id };
  }

  /**
   * Revoke every live session for a user. The administrative eviction, and the
   * mechanism behind MFA reset, password change and login-email change.
   *
   * **Capability-gated by the caller** (`identity.administer_sessions` for the
   * administrative surface); the credential-change callers below reach it as a
   * consequence of a change the actor was already authorized to make.
   */
  async revokeAllSessions(
    uow: Uow,
    options: {
      readonly userId: string;
      readonly reason: SessionRevokedReason;
      readonly exceptSessionId?: string | null;
    },
  ): Promise<number> {
    const now = this.#clock.now();
    const count = await store.revokeAllSessionsForUser(uow, {
      userId: options.userId,
      reason: options.reason,
      now,
      exceptSessionId: options.exceptSessionId ?? null,
    });
    if (count > 0) {
      await recordAuditEvent(uow, {
        eventName: 'authn.session.revoked',
        subjectType: 'user',
        subjectId: options.userId,
        payload: { reason: options.reason, sessions: count },
        systemActor: uow.context.membershipId === null,
      });
    }
    return count;
  }

  /* ──────────────────────────────────────────────────────────────────────────
   * Multi-factor
   * ────────────────────────────────────────────────────────────────────────── */

  /** Provisions a secret. The factor is NOT in force until a code confirms it. */
  async startMfaEnrolment(
    uow: Uow,
    options: { readonly userId: string; readonly label: string },
  ): Promise<EnrolmentStartResult> {
    const secret = mintTotpSecret();
    const sealed = this.#secretBox.seal(secret, {
      organizationId: uow.context.organizationId,
      userId: options.userId,
    });
    const row = await store.upsertMfaProvisioning(uow, {
      userId: options.userId,
      ciphertext: sealed.ciphertext,
      nonce: sealed.nonce,
      tag: sealed.tag,
      keyVersion: sealed.keyVersion,
      algorithm: this.#totp.algorithm,
      digits: this.#totp.digits,
      periodSeconds: this.#totp.periodSeconds,
    });

    await recordAuditEvent(uow, {
      eventName: 'authn.mfa.enrolment_started',
      subjectType: 'mfa_enrolment',
      subjectId: row.id,
      payload: {
        algorithm: this.#totp.algorithm,
        digits: this.#totp.digits,
        period: this.#totp.periodSeconds,
        keyVersion: sealed.keyVersion,
      },
      systemActor: uow.context.membershipId === null,
    });

    return {
      provisioningUri: provisioningUri({
        secret,
        label: options.label,
        issuer: this.#issuer,
        parameters: this.#totp,
      }),
      secretBase32: base32Encode(secret),
    };
  }

  async confirmMfaEnrolment(
    uow: Uow,
    options: { readonly userId: string; readonly code: string },
  ): Promise<EnrolmentConfirmResult> {
    const now = this.#clock.now();
    const row = await store.findMfaForUser(uow, options.userId);
    if (row === undefined || row.state !== 'provisioned') {
      throw invalidRequest('There is no enrolment awaiting confirmation.');
    }
    const secret = this.#openSecret(uow, row);
    if (secret === undefined) throw authnFailed('no_enrolment');

    const verified = verifyTotp(secret, options.code, now, this.#parametersOf(row));
    if (verified === undefined) {
      await this.#auditMfaFailure(uow, row.id, 'wrong_code');
      throw authnFailed('wrong_code');
    }

    const codes = mintRecoveryCodes();
    const confirmed = await store.confirmMfaEnrolment(uow, {
      mfaId: row.id,
      timeStep: verified.timeStep,
      now,
      recoveryCodeHashes: codes.map((code) => hashRecoveryCode(code)),
    });
    if (!confirmed) throw invalidRequest('There is no enrolment awaiting confirmation.');

    await recordAuditEvent(uow, {
      eventName: 'authn.mfa.enrolled',
      subjectType: 'mfa_enrolment',
      subjectId: row.id,
      payload: { recoveryCodes: codes.length },
      systemActor: uow.context.membershipId === null,
    });

    return { recoveryCodes: codes };
  }

  /**
   * The sign-in challenge. Accepts a TOTP code OR a recovery code, never both.
   *
   * A successful challenge marks the SESSION, not the user: a second device
   * still has to present its own code, which is the whole point of a per-session
   * factor.
   */
  async challengeMfa(
    uow: Uow,
    options: {
      readonly userId: string;
      readonly sessionId: string;
      readonly code?: string;
      readonly recoveryCode?: string;
    },
  ): Promise<void> {
    const now = this.#clock.now();
    if ((options.code === undefined) === (options.recoveryCode === undefined)) {
      throw invalidRequest('Present exactly one of a code or a recovery code.');
    }
    const row = await store.findMfaForUser(uow, options.userId);
    if (row === undefined || row.state !== 'active') {
      await this.#auditMfaFailure(uow, options.userId, 'no_enrolment');
      throw authnFailed('no_enrolment');
    }

    if (options.recoveryCode !== undefined) {
      await this.#consumeRecoveryCode(uow, row, options.recoveryCode, now);
    } else {
      const secret = this.#openSecret(uow, row);
      if (secret === undefined) {
        await this.#auditMfaFailure(uow, row.id, 'no_enrolment');
        throw authnFailed('no_enrolment');
      }
      const verified = verifyTotp(secret, options.code ?? '', now, this.#parametersOf(row));
      if (verified === undefined) {
        await this.#auditMfaFailure(uow, row.id, 'wrong_code');
        throw authnFailed('wrong_code');
      }
      // The REPLAY check is the statement, not this branch: `acceptMfaTimeStep`
      // updates only when the step is strictly newer, so a second presentation
      // of the same code affects no row and is refused here.
      const accepted = await store.acceptMfaTimeStep(uow, {
        mfaId: row.id,
        timeStep: verified.timeStep,
      });
      if (!accepted) {
        await this.#auditMfaFailure(uow, row.id, 'replayed_time_step');
        throw authnFailed('replayed_time_step');
      }
    }

    await store.markMfaSatisfied(uow, options.sessionId);
    await recordAuditEvent(uow, {
      eventName: 'authn.mfa.challenge_succeeded',
      subjectType: 'session',
      subjectId: options.sessionId,
      payload: { method: options.recoveryCode === undefined ? 'totp' : 'recovery_code' },
      systemActor: uow.context.membershipId === null,
    });
  }

  async #consumeRecoveryCode(
    uow: Uow,
    row: store.MfaRow,
    presented: string,
    now: Date,
  ): Promise<void> {
    const digest = hashRecoveryCode(presented);
    // Every element is examined; the loop does not stop at the first match, so
    // the time taken does not reveal the code's position.
    let index = -1;
    let consumed = false;
    row.recoveryCodes.forEach((entry, position) => {
      if (entry.h === digest) {
        index = position;
        consumed = entry.c !== null;
      }
    });
    if (index < 0) {
      await this.#auditMfaFailure(uow, row.id, 'unknown_recovery_code');
      throw authnFailed('unknown_recovery_code');
    }
    if (consumed) {
      await this.#auditMfaFailure(uow, row.id, 'consumed_recovery_code');
      throw authnFailed('consumed_recovery_code');
    }
    const ok = await store.consumeRecoveryCode(uow, { mfaId: row.id, index, now });
    if (!ok) {
      await this.#auditMfaFailure(uow, row.id, 'consumed_recovery_code');
      throw authnFailed('consumed_recovery_code');
    }
    await recordAuditEvent(uow, {
      eventName: 'authn.mfa.recovery_code_consumed',
      subjectType: 'mfa_enrolment',
      subjectId: row.id,
      payload: { position: index },
      systemActor: uow.context.membershipId === null,
    });
  }

  /**
   * SPEC-11 X-12 — "MFA reset: **audited, notified, sessions invalidated**".
   *
   * All three, in one transaction, in that order, and none of them optional:
   * the audit row is recorded before the outbox intent because the outbox row
   * carries the audit sequence it belongs to, and the sessions are revoked in
   * the same transaction so there is no window in which the reset has happened
   * and the old sessions are still usable.
   *
   * **Capability-gated by the caller** on `identity.reset_mfa`.
   */
  async resetMfa(
    uow: Uow,
    options: { readonly userId: string; readonly notificationRef: string },
  ): Promise<{ readonly removed: boolean; readonly sessionsRevoked: number }> {
    const now = this.#clock.now();
    const existing = await store.findMfaForUser(uow, options.userId);
    const removed = await store.deleteMfaEnrolment(uow, options.userId);
    const sessionsRevoked = await store.revokeAllSessionsForUser(uow, {
      userId: options.userId,
      reason: 'mfa_reset',
      now,
    });

    const audit = await recordAuditEvent(uow, {
      eventName: 'authn.mfa.reset',
      subjectType: 'user',
      subjectId: options.userId,
      payload: {
        removed,
        sessionsRevoked,
        hadEnrolment: existing !== undefined,
        wasActive: existing?.state === 'active',
      },
      systemActor: uow.context.membershipId === null,
    });

    // 14 §2's "notification to the owner on credential change", as an INTENT
    // only (I-11). Nothing here delivers, and a delivery failure downstream can
    // never unwind the reset — the reset has already committed by the time the
    // dispatcher runs.
    await publishOutboxEvent(uow, audit, {
      kind: 'authn.mfa.reset',
      idempotencyKey: `authn.mfa.reset:${audit.id}`,
      payload: { userId: options.userId, destination: options.notificationRef },
    });

    return { removed, sessionsRevoked };
  }

  #parametersOf(row: store.MfaRow): TotpParameters {
    return {
      algorithm: row.algorithm,
      digits: row.digits,
      periodSeconds: row.periodSeconds,
    };
  }

  #openSecret(uow: Uow, row: store.MfaRow): Buffer | undefined {
    return this.#secretBox.open(
      {
        ciphertext: row.secretCiphertext,
        nonce: row.secretNonce,
        tag: row.secretTag,
        keyVersion: row.keyVersion,
      },
      { organizationId: uow.context.organizationId, userId: row.userId },
    );
  }

  async #auditMfaFailure(uow: Uow, subjectId: string, reason: MfaFailureReason): Promise<void> {
    await recordAuditEvent(uow, {
      eventName: 'authn.mfa.challenge_failed',
      subjectType: 'mfa_enrolment',
      subjectId,
      payload: { reason },
      systemActor: uow.context.membershipId === null,
    });
  }

  /* ──────────────────────────────────────────────────────────────────────────
   * Invitation and activation (STM-017 / STM-018)
   * ────────────────────────────────────────────────────────────────────────── */

  /**
   * Issue an invitation for an existing user row in the `invited` account state.
   *
   * **Capability-gated by the caller** on `organization.membership.administer`,
   * whose catalogue description is literally "invite a user to the organization".
   *
   * The token is returned to the caller ONCE, and its only sanctioned use is the
   * outbox intent. It is not logged, not audited and not in the HTTP response —
   * `apps/api/test/authn/secrecy.test.ts` proves that by planting it.
   */
  async issueInvitation(
    uow: Uow,
    options: { readonly userId: string; readonly email: string; readonly notificationRef: string },
  ): Promise<InvitationIssueResult> {
    const now = this.#clock.now();
    const credential = await store.findCredentialById(uow, options.userId);
    if (credential === undefined) throw invalidRequest('No such user in this organization.');
    if (accountStateOf({ status: credential.status, activatedAt: credential.activatedAt }) !== 'invited') {
      // Re-inviting an activated account would issue a live credential-setting
      // token for somebody who already has a credential — which is a password
      // reset wearing an invitation's clothes, and 14 §2 keeps the two apart.
      throw conflict('That account has already been activated. Use a password reset instead.');
    }

    const token = mintToken();
    const invitation = await store.insertInvitation(uow, {
      userId: options.userId,
      email: options.email,
      tokenHash: hashToken('invitation', token),
      expiresAt: new Date(now.getTime() + this.#policy.invitationLifetimeMs),
      issuedByMembershipId: uow.context.membershipId,
    });

    const audit = await recordAuditEvent(uow, {
      eventName: 'authn.invitation.issued',
      subjectType: 'invitation',
      subjectId: invitation.id,
      payload: {
        userId: options.userId,
        emailDomain: emailFingerprint(options.email).domain,
        emailHash: emailFingerprint(options.email).hash,
      },
      systemActor: uow.context.membershipId === null,
    });

    await publishOutboxEvent(uow, audit, {
      kind: 'authn.invitation.issued',
      idempotencyKey: `authn.invitation.issued:${invitation.id}`,
      payload: { invitationId: invitation.id, destination: options.notificationRef },
    });

    return { invitationId: invitation.id, token, expiresAt: invitation.expiresAt };
  }

  async revokeInvitation(uow: Uow, invitationId: string): Promise<boolean> {
    const now = this.#clock.now();
    const revoked = await store.revokeInvitation(uow, { invitationId, now });
    if (!revoked) return false;
    await recordAuditEvent(uow, {
      eventName: 'authn.invitation.revoked',
      subjectType: 'invitation',
      subjectId: invitationId,
      payload: {},
      systemActor: uow.context.membershipId === null,
    });
    return true;
  }

  /**
   * Consume an invitation token and set the account's first password.
   *
   * The consumption is a CONDITIONAL UPDATE and it happens BEFORE the account is
   * touched, so a second consumer of the same token affects no row and is
   * refused — even when the two arrive in the same millisecond, because they
   * contend on the row lock. Exactly one activation happens.
   */
  async activateAccount(
    uow: Uow,
    options: { readonly token: string; readonly password: string },
  ): Promise<{ readonly userId: string }> {
    const now = this.#clock.now();
    const problem = passwordPolicyProblem(options.password);
    if (problem !== undefined) throw invalidRequest(problem);

    const invitation = await store.findInvitationByTokenHash(
      uow,
      hashToken('invitation', options.token),
    );
    if (invitation === undefined) throw tokenInvalid('unknown_token');
    if (invitation.state === 'revoked') throw tokenInvalid('revoked');
    if (invitation.consumedAt !== null) throw tokenInvalid('already_consumed');
    if (invitation.expiresAt.getTime() <= now.getTime()) throw tokenInvalid('expired');

    const consumed = await store.consumeInvitation(uow, { invitationId: invitation.id, now });
    if (!consumed) throw tokenInvalid('already_consumed');

    const hash = await hashPassword(options.password, this.#scrypt);
    const activated = await store.activateAccount(uow, {
      userId: invitation.userId,
      passwordHash: hash,
      now,
    });
    // The token was consumed above, so reaching here means the ACCOUNT had
    // already activated — a different fact from a replayed token, and the two
    // must not share an internal reason or an audit payload.
    if (!activated) throw tokenInvalid('account_already_active');

    // `systemActor`, and it is the honest answer rather than a convenience: the
    // person activating has no membership in context because they have no
    // session yet. Attributing the event to the membership being activated would
    // read as that membership doing something, which is exactly the ambiguity
    // the recorder refuses to let a caller create by accident.
    await recordAuditEvent(uow, {
      eventName: 'authn.invitation.accepted',
      subjectType: 'invitation',
      subjectId: invitation.id,
      payload: { userId: invitation.userId },
      systemActor: uow.context.membershipId === null,
    });
    await recordAuditEvent(uow, {
      eventName: 'authn.account.activated',
      subjectType: 'user',
      subjectId: invitation.userId,
      payload: { via: 'invitation' },
      systemActor: uow.context.membershipId === null,
    });

    return { userId: invitation.userId };
  }

  /* ──────────────────────────────────────────────────────────────────────────
   * Password reset — a SEPARATE flow and a SEPARATE token namespace
   * ────────────────────────────────────────────────────────────────────────── */

  /**
   * Request a reset. **Always succeeds from the client's point of view.**
   *
   * An address nobody holds produces no token, no outbox intent, and the same
   * response — otherwise the endpoint is an account-enumeration oracle, which is
   * the same disclosure 14 §2 refuses on the sign-in path.
   */
  async requestPasswordReset(
    uow: Uow,
    options: { readonly loginEmail: string; readonly notificationRef: string },
  ): Promise<{ readonly token: string | undefined }> {
    const now = this.#clock.now();
    const credential = await store.findCredentialByLoginEmail(uow, options.loginEmail);

    if (credential === undefined) {
      // Audited even though nothing was issued: a burst of reset requests for
      // addresses nobody holds is exactly the signal an incident review wants,
      // and it is invisible if only successful requests are recorded.
      await recordAuditEvent(uow, {
        eventName: 'authn.password_reset.requested',
        subjectType: 'organization',
        subjectId: uow.context.organizationId,
        payload: { issued: false, emailDomain: emailFingerprint(options.loginEmail).domain },
        systemActor: true,
      });
      return { token: undefined };
    }
    // An account that has never activated must use its INVITATION. Issuing a
    // reset token here would be the second token namespace doing the first
    // one's job, which is exactly what 14 §2 separates them to prevent.
    if (accountStateOf({ status: credential.status, activatedAt: credential.activatedAt }) !== 'active') {
      await recordAuditEvent(uow, {
        eventName: 'authn.password_reset.requested',
        subjectType: 'user',
        subjectId: credential.id,
        payload: { issued: false, reason: 'not_activated' },
        systemActor: true,
      });
      return { token: undefined };
    }

    const token = mintToken();
    const row = await store.insertPasswordReset(uow, {
      userId: credential.id,
      tokenHash: hashToken('password_reset', token),
      expiresAt: new Date(now.getTime() + this.#policy.passwordResetLifetimeMs),
    });

    const audit = await recordAuditEvent(uow, {
      eventName: 'authn.password_reset.requested',
      subjectType: 'user',
      subjectId: credential.id,
      payload: { tokenId: row.id, issued: true },
      systemActor: true,
    });
    await publishOutboxEvent(uow, audit, {
      kind: 'authn.password_reset.requested',
      idempotencyKey: `authn.password_reset.requested:${row.id}`,
      payload: { userId: credential.id, destination: options.notificationRef },
    });

    return { token };
  }

  async completePasswordReset(
    uow: Uow,
    options: { readonly token: string; readonly password: string; readonly notificationRef: string },
  ): Promise<{ readonly userId: string; readonly sessionsRevoked: number }> {
    const now = this.#clock.now();
    const problem = passwordPolicyProblem(options.password);
    if (problem !== undefined) throw invalidRequest(problem);

    const row = await store.findPasswordResetByTokenHash(
      uow,
      hashToken('password_reset', options.token),
    );
    if (row === undefined) throw tokenInvalid('unknown_token');
    if (row.state === 'revoked') throw tokenInvalid('revoked');
    if (row.consumedAt !== null) throw tokenInvalid('already_consumed');
    if (row.expiresAt.getTime() <= now.getTime()) throw tokenInvalid('expired');

    const consumed = await store.consumePasswordReset(uow, { tokenId: row.id, now });
    if (!consumed) throw tokenInvalid('already_consumed');

    const hash = await hashPassword(options.password, this.#scrypt);
    await store.setPassword(uow, { userId: row.userId, passwordHash: hash, now });
    await store.revokeOutstandingPasswordResets(uow, { userId: row.userId, now });
    const sessionsRevoked = await store.revokeAllSessionsForUser(uow, {
      userId: row.userId,
      reason: 'password_changed',
      now,
    });
    await store.bumpSessionEpoch(uow, row.userId);

    const audit = await recordAuditEvent(uow, {
      eventName: 'authn.password.changed',
      subjectType: 'user',
      subjectId: row.userId,
      payload: { via: 'reset', sessionsRevoked },
      systemActor: uow.context.membershipId === null,
    });
    await publishOutboxEvent(uow, audit, {
      kind: 'authn.password.changed',
      idempotencyKey: `authn.password.changed:${audit.id}`,
      payload: { userId: row.userId, destination: options.notificationRef },
    });

    return { userId: row.userId, sessionsRevoked };
  }

  /* ──────────────────────────────────────────────────────────────────────────
   * Login-email change (CAR-027)
   * ────────────────────────────────────────────────────────────────────────── */

  /**
   * Change a user's login email. **Never self-service** (06 §3.2).
   *
   * **Capability-gated by the caller** on `identity.change_login_email`, and the
   * route additionally refuses a request whose subject is the actor — a grant is
   * a grant, and an administrator who holds it could otherwise change their own
   * address, which is the one case CAR-027 explicitly does not open.
   *
   * Four things happen together, in one transaction:
   *   1. the address changes;
   *   2. every live session is revoked and `session_epoch` bumped;
   *   3. pending invitations are re-addressed (the mistyped-address case);
   *   4. it is audited, and the owner is notified through the outbox.
   */
  async changeLoginEmail(
    uow: Uow,
    options: {
      readonly userId: string;
      readonly loginEmail: string;
      readonly notificationRef: string;
    },
  ): Promise<{ readonly sessionsRevoked: number; readonly invitationsReconciled: number }> {
    const now = this.#clock.now();
    const trimmed = options.loginEmail.trim();
    if (trimmed.length === 0 || !trimmed.includes('@')) {
      throw invalidRequest('That is not a usable login email.');
    }

    const before = await store.findCredentialById(uow, options.userId);
    if (before === undefined) throw invalidRequest('No such user in this organization.');

    const outcome = await store.changeLoginEmail(uow, {
      userId: options.userId,
      loginEmail: trimmed,
    });
    if (outcome === 'in_use') throw conflict('That login email is already in use.');
    if (outcome === 'not_found') throw invalidRequest('No such user in this organization.');

    const invitationsReconciled = await store.reconcileInvitationsForUser(uow, {
      userId: options.userId,
      email: trimmed,
    });
    const sessionsRevoked = await store.revokeAllSessionsForUser(uow, {
      userId: options.userId,
      reason: 'login_email_changed',
      now,
    });
    await store.bumpSessionEpoch(uow, options.userId);

    const previous = emailFingerprint(before.loginEmail);
    const next = emailFingerprint(trimmed);
    const payload: AuditPayload = {
      previousDomain: previous.domain,
      previousHash: previous.hash,
      newDomain: next.domain,
      newHash: next.hash,
      sessionsRevoked,
      invitationsReconciled,
    };
    const audit = await recordAuditEvent(uow, {
      eventName: 'authn.login_email.changed',
      subjectType: 'user',
      subjectId: options.userId,
      payload,
      systemActor: uow.context.membershipId === null,
    });

    if (invitationsReconciled > 0) {
      await recordAuditEvent(uow, {
        eventName: 'authn.invitation.reconciled',
        subjectType: 'user',
        subjectId: options.userId,
        payload: { invitations: invitationsReconciled, newDomain: next.domain },
        systemActor: uow.context.membershipId === null,
      });
    }

    await publishOutboxEvent(uow, audit, {
      kind: 'authn.login_email.changed',
      idempotencyKey: `authn.login_email.changed:${audit.id}`,
      payload: { userId: options.userId, destination: options.notificationRef },
    });

    return { sessionsRevoked, invitationsReconciled };
  }
}

/**
 * A hash of a value nobody's password is, used to keep the unknown-account path
 * as expensive as the wrong-password path.
 *
 * Computed once at module load with the current parameters. It is not a secret
 * and not a credential: no account carries it, and `users_password_hash_encoded`
 * would accept it only as somebody's actual stored hash, which it never is.
 */
const DUMMY_HASH =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** Recovery codes are hashed, never stored. Normalised first, so case does not decide. */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256')
    .update(`sp.authn.recovery.v1\u0000${normalizeRecoveryCode(code)}`)
    .digest('hex');
}

/**
 * The production constructor.
 *
 * `systemClock` unconditionally: there is no branch here that could select
 * another clock, and no environment variable that could ask for one.
 */
export function createAuthnService(): AuthnService {
  return new AuthnService({ clock: systemClock });
}
