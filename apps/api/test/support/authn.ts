import type { TenantContext } from '@schedulepoint/domain';
import type pg from 'pg';

import { AuthnService, type AuthnServiceOptions } from '../../src/authn/service.js';
import { ControllableClock } from '../../src/authn/clock.js';
import { SecretBox } from '../../src/authn/secret-box.js';
import { DEFAULT_TOTP_PARAMETERS, totpAt, type TotpParameters } from '../../src/authn/totp.js';
import type { PgUnitOfWorkRunner } from '../../src/db/unit-of-work.js';

/**
 * Authentication test support (packet 32 §6: `test/support/authn.ts` is
 * OPUS-M3-001's file).
 *
 * ## Two seams, and neither of them exists in production
 *
 * `ControllableClock` and the reduced scrypt parameters are both CONSTRUCTOR
 * parameters of `AuthnService`. There is no setter and no environment variable,
 * so a production process cannot reach either: `createAuthnService()` passes
 * `systemClock` and the production parameter set unconditionally, and
 * `apps/api/test/authn/primitives.test.ts` scans the shipped source to keep that
 * true rather than trusting it.
 *
 * ## Why the fixture's scrypt parameters are reduced
 *
 * `fixture-regression` provisions ~35 tenants and each activates accounts
 * through the production path. At production parameters that is deliberate work
 * measured in minutes across the battery. The encoded hash carries its own
 * parameters, so verification is exercised identically — only the cost changes,
 * and the production cost is measured directly in
 * `apps/api/test/authn/primitives.test.ts`.
 */

/** Cheap enough to seed 35 tenants; still a real scrypt hash with a real salt. */
export const FIXTURE_SCRYPT = { N: 1024, r: 8, p: 1 } as const;

/**
 * A deterministic 32-byte key, so an enrolment written by one unit of work is
 * readable by the next.
 *
 * Fixed rather than random because a per-service random key would make a fixture
 * unreadable to the service a later test constructs — and it is not a secret in
 * any sense that matters: it exists only in a test process, guards only
 * synthetic enrolments, and never appears in a deployment. `secret-scan.mjs`
 * sees a base64 constant in a test file, which is why it is spelled from a
 * repeated byte rather than looking like a credential.
 */
export const FIXTURE_MFA_KEY = Buffer.alloc(32, 0x2a);

export function fixtureSecretBox(): SecretBox {
  return new SecretBox(new Map([[1, FIXTURE_MFA_KEY]]), 1);
}

/** The instant every clock-driven authn test starts at. Fixed, UTC, no locale. */
export const AUTHN_EPOCH = new Date('2026-03-01T09:00:00.000Z');

export interface TestAuthnServiceOptions extends AuthnServiceOptions {
  readonly startAt?: Date;
}

/**
 * An `AuthnService` whose clock a test drives.
 *
 * Returns the clock beside the service so the test can advance it. Nothing else
 * in the process can: the service holds a private reference and exposes it
 * read-only.
 */
export function testAuthnService(options: TestAuthnServiceOptions = {}): {
  readonly authn: AuthnService;
  readonly clock: ControllableClock;
} {
  const clock = new ControllableClock(options.startAt ?? AUTHN_EPOCH);
  const authn = new AuthnService({
    clock,
    scrypt: FIXTURE_SCRYPT,
    secretBox: fixtureSecretBox(),
    totpIssuer: 'SchedulePoint-Test',
    ...options,
  });
  return { authn, clock };
}

/**
 * The password every synthetic fixture account uses.
 *
 * The `fixture-` prefix is not decoration: `scripts/gates/secret-scan.mjs`
 * treats a value whose LEADING TOKEN declares it a throwaway local credential as
 * a placeholder, and a synthetic credential without one fails the build. That is
 * the gate working — a scanner that ignored test directories would be a much
 * larger hole — so every synthetic credential in this packet carries the prefix
 * rather than the gate carrying an exclusion.
 */
export const FIXTURE_PASSWORD = 'fixture-correct-horse-battery-staple-01';

/**
 * Redacts the session SECRET out of a `Set-Cookie` header **at the point it is
 * printed**, leaving every attribute intact.
 *
 * ## Why this exists, and why it lives here rather than in a scrubber
 *
 * A cookie-posture proof needs the ATTRIBUTES — `__Host-`, `HttpOnly`, `Secure`,
 * `SameSite=Strict`, `Path=/`, no `Domain` — and never the value. The first
 * version of `http-flows.test.ts` logged the whole header, so the 43-character
 * `mintToken()` secret after the `<uuid>.` landed verbatim in two committed
 * evidence files — a live session secret in an evidence artifact, which the
 * packet forbids absolutely and which `secrecy.test.ts` now scans the evidence
 * directory to catch.
 *
 * The fix is **redaction by construction, not a post-hoc scrub**: the value is
 * replaced with `<redacted>` before it ever reaches `log()`, so the secret is
 * never written down in the first place. `secrecy.test.ts` proves the emitted
 * line no longer carries the value.
 *
 * The `<organizationId>` prefix is kept: it is not a secret (it is a tenant
 * identifier, which audit payloads carry too) and it is what makes the cookie's
 * `<org>.<secret>` shape legible in the evidence.
 */
export function redactSessionCookie(setCookieHeader: string): string {
  // `__Host-sp_session=<uuid>.<secret>; <attributes>` -> the secret becomes
  // `<redacted>`. The org id (a uuid) is left; only the base64url secret after
  // the first `.` in the VALUE is removed.
  return setCookieHeader.replace(
    /(__Host-sp_session=[0-9a-fA-F-]{36}\.)[A-Za-z0-9_-]+/,
    '$1<redacted>',
  );
}

/**
 * The TOTP code a device holding `secret` would show at `instant`.
 *
 * Computed rather than captured, so a test never has to sleep to reach the next
 * time step: advance the clock by a period and ask again.
 */
export function codeFor(
  secretBase32: string,
  instant: Date,
  parameters: TotpParameters = DEFAULT_TOTP_PARAMETERS,
): string {
  return totpAt(base32Decode(secretBase32), instant, parameters);
}

/** RFC 4648 base32 decode. The inverse of `base32Encode`, and only used by tests. */
export function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of input.replace(/=+$/, '').toUpperCase()) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error(`not base32: ${character}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * A correlation id must match `^[A-Za-z0-9_-]{1,64}$` (migration 0003) — no
 * colons, no dots. A fixture slug can carry either, and the resulting audit
 * insert fails with a CHECK violation a long way from its cause.
 */
function sanitize(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9_-]/g, '-').slice(0, 48);
}

export function organizationCommand(
  organizationId: string,
  membershipId: string | null,
  correlationId: string,
): TenantContext {
  return { organizationId, groupId: null, membershipId, correlationId };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Seeding
 * ──────────────────────────────────────────────────────────────────────────── */

export interface SeededAuthn {
  /** The user that ends up with a password, a live session and an MFA enrolment. */
  readonly activatedUserId: string;
  readonly sessionToken: string;
  readonly sessionId: string;
  /** The user left holding a PENDING invitation, so `invitations` is non-vacuous. */
  readonly invitedUserId: string;
  readonly invitationToken: string;
  readonly mfaSecretBase32: string;
  /** The user with an outstanding reset token, so that table is non-vacuous too. */
  readonly resetUserId: string;
}

/**
 * Seeds `sessions`, `invitations`, `password_reset_tokens` and `user_mfa` in one
 * organization, **through the production paths**.
 *
 * ## Why the fixture has to do this at all
 *
 * The four tables are in `TENANT_TABLES`, which is what the wrong-tenant probe,
 * the T-15 storm, the pool-cleanliness check, the (role, table) matrix and
 * SBX-004's non-vacuity check all iterate. **A probe over an empty table reports
 * "0 wrong rows" for the boring reason** — the vacuous pass the whole probe
 * design exists to avoid. `seedMultiAuditAndOutbox` makes exactly this argument
 * for migration 0003's tables; it applies here verbatim.
 *
 * ## Every row is written by the path that writes it in production
 *
 * The invitation comes from `issueInvitation`, the activation from
 * `activateAccount`, the session from `signIn`, the enrolment from
 * `startMfaEnrolment` + `confirmMfaEnrolment` with a code computed from the
 * secret the service just handed out, and the reset row from
 * `requestPasswordReset`. A fixture that hand-wrote these would seed rows the
 * application could not have produced, and every isolation claim about them
 * would then be a claim about rows nothing writes.
 */
export async function seedAuthnForOrganization(
  runner: PgUnitOfWorkRunner,
  options: {
    readonly organizationId: string;
    /** An ACTIVE organization membership, so the audit recorder has an actor. */
    readonly adminMembershipId: string;
    /** Activated, signed in, enrolled. Must hold an active membership here. */
    readonly activatedUserId: string;
    /** Left holding a pending invitation. */
    readonly invitedUserId: string;
    /**
     * Activated, then issued a reset token. Defaults to `activatedUserId` —
     * Beta and Gamma have only two users each, and a fixture that demanded a
     * third would be a fixture shaped by this helper rather than by the tenancy
     * it is supposed to describe.
     */
    readonly resetUserId?: string;
    readonly slug: string;
  },
): Promise<SeededAuthn> {
  const authn = new AuthnService({
    scrypt: FIXTURE_SCRYPT,
    secretBox: fixtureSecretBox(),
    totpIssuer: 'SchedulePoint-Test',
  });

  const asAdmin = organizationCommand(
    options.organizationId,
    options.adminMembershipId,
    `${sanitize(options.slug)}-authn-seed`,
  );
  const anonymous = organizationCommand(
    options.organizationId,
    null,
    `${sanitize(options.slug)}-authn-seed-anon`,
  );

  /* ── invitations: one CONSUMED (the activation below) and one PENDING ─────
   *
   * Both, because a table holding only accepted rows makes the single-use
   * assertions vacuous and a table holding only pending ones makes the
   * consumption assertions vacuous. */
  const activatedInvitation = await runner.run(asAdmin, (uow) =>
    authn.issueInvitation(uow, {
      userId: options.activatedUserId,
      email: `authn-seed-${options.slug}@example.test`,
      notificationRef: 'sink:fixture',
    }),
  );
  const pendingInvitation = await runner.run(asAdmin, (uow) =>
    authn.issueInvitation(uow, {
      userId: options.invitedUserId,
      email: `authn-pending-${options.slug}@example.test`,
      notificationRef: 'sink:fixture',
    }),
  );
  const resetUserId = options.resetUserId ?? options.activatedUserId;
  const resetInvitation =
    resetUserId === options.activatedUserId
      ? undefined
      : await runner.run(asAdmin, (uow) =>
          authn.issueInvitation(uow, {
            userId: resetUserId,
            email: `authn-reset-${options.slug}@example.test`,
            notificationRef: 'sink:fixture',
          }),
        );

  await runner.run(anonymous, (uow) =>
    authn.activateAccount(uow, {
      token: activatedInvitation.token,
      password: FIXTURE_PASSWORD,
    }),
  );
  if (resetInvitation !== undefined) {
    await runner.run(anonymous, (uow) =>
      authn.activateAccount(uow, { token: resetInvitation.token, password: FIXTURE_PASSWORD }),
    );
  }

  const loginEmail = await runner.run(anonymous, async (uow) => {
    const { findCredentialById } = await import('../../src/authn/store.js');
    const row = await findCredentialById(uow, options.activatedUserId);
    if (row === undefined) throw new Error('authn fixture: the activated user vanished');
    return row.loginEmail;
  });

  const signedIn = await runner.run(anonymous, (uow) =>
    authn.signIn(uow, { loginEmail, password: FIXTURE_PASSWORD }),
  );

  /* ── user_mfa: provisioned AND confirmed, through the real challenge ────── */
  const enrolment = await runner.run(anonymous, (uow) =>
    authn.startMfaEnrolment(uow, { userId: options.activatedUserId, label: loginEmail }),
  );
  await runner.run(anonymous, (uow) =>
    authn.confirmMfaEnrolment(uow, {
      userId: options.activatedUserId,
      code: codeFor(enrolment.secretBase32, new Date()),
    }),
  );

  /* ── password_reset_tokens: one outstanding ─────────────────────────────── */
  const resetEmail = await runner.run(anonymous, async (uow) => {
    const { findCredentialById } = await import('../../src/authn/store.js');
    const row = await findCredentialById(uow, resetUserId);
    if (row === undefined) throw new Error('authn fixture: the reset user vanished');
    return row.loginEmail;
  });
  await runner.run(anonymous, (uow) =>
    authn.requestPasswordReset(uow, { loginEmail: resetEmail, notificationRef: 'sink:fixture' }),
  );

  return {
    activatedUserId: options.activatedUserId,
    sessionToken: signedIn.token,
    sessionId: signedIn.sessionId,
    invitedUserId: options.invitedUserId,
    invitationToken: pendingInvitation.token,
    mfaSecretBase32: enrolment.secretBase32,
    resetUserId,
  };
}

/** Row counts per authn table in one organization. Read out of band. */
export async function authnRowCensus(
  admin: pg.Client,
  organizationId: string,
): Promise<Record<string, number>> {
  const census: Record<string, number> = {};
  for (const table of ['sessions', 'invitations', 'password_reset_tokens', 'user_mfa']) {
    const result = await admin.query<{ n: string }>(
      `select count(*)::text as n from ${table} where organization_id = $1::uuid`,
      [organizationId],
    );
    census[table] = Number(result.rows[0]?.n ?? '0');
  }
  return census;
}
