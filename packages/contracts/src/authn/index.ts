import { z } from 'zod';

/**
 * OPUS-M3-001 — the authentication wire shapes.
 *
 * ## What is NOT here, and never will be
 *
 * No schema in this file describes a password hash, a token hash, a TOTP secret,
 * or a recovery-code hash. The only secret-shaped values that appear are the ones
 * a client MUST send (a password, a code, a token from a link) or receive exactly
 * once (the enrolment secret, the recovery codes) — and each of those is marked
 * as such where it appears.
 *
 * ## Every response is deliberately uninformative about failure
 *
 * There is one failure body (`authnErrorSchema`) and its `code` comes from a
 * five-value set that makes no distinction between "no such account", "wrong
 * password" and "locked" (14 §2). A richer error type is exactly the thing this
 * surface must not have, so it does not exist to be reached for.
 *
 * `.strict()` on every object, per the package rules: an unknown key is
 * rejected rather than carried.
 */

/** 14 §2's minimum. Stated here so the client can say so before a round trip. */
export const MINIMUM_PASSWORD_LENGTH = 12;

export const loginEmailSchema = z
  .string()
  .trim()
  .min(3)
  .max(320)
  // Deliberately not an RFC 5322 parser. The only property this surface needs is
  // "has a local part and a domain"; anything stricter rejects addresses that
  // work, and anything looser is not worth the check.
  .refine((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), {
    message: 'That is not a usable login email.',
  });

export const passwordSchema = z.string().min(MINIMUM_PASSWORD_LENGTH).max(1024);

/** A six- or eight-digit TOTP code. Whitespace is tolerated; apps insert it. */
export const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{6}([0-9]{2})?$/, 'A code is six or eight digits.');

export const recoveryCodeSchema = z.string().trim().min(8).max(32);

/** A token from an activation or reset link. base64url, 43 characters. */
export const authnTokenSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{43,64}$/, 'That link is not valid.');

export const AUTHN_ERROR_CODES = [
  'AUTHN_FAILED',
  'AUTHN_SESSION_INVALID',
  'AUTHN_TOKEN_INVALID',
  'AUTHN_INVALID_REQUEST',
  'AUTHN_CONFLICT',
] as const;

export type AuthnErrorCode = (typeof AUTHN_ERROR_CODES)[number];

export const authnErrorSchema = z
  .object({
    error: z
      .object({
        code: z.enum(AUTHN_ERROR_CODES),
        message: z.string(),
        correlationId: z.string(),
      })
      .strict(),
  })
  .strict();

export type AuthnError = z.infer<typeof authnErrorSchema>;

/* ── sign in ──────────────────────────────────────────────────────────────── */

export const signInRequestSchema = z
  .object({
    loginEmail: loginEmailSchema,
    /** Sent, never stored, never echoed. */
    password: z.string().min(1).max(1024),
    /** 14 §3's "persistent option scoped to personal devices". */
    persistent: z.boolean().optional(),
  })
  .strict();

export type SignInRequest = z.infer<typeof signInRequestSchema>;

export const SIGN_IN_STATES = ['authenticated', 'mfa_required', 'mfa_enrolment_required'] as const;

export const signInResultSchema = z
  .object({
    state: z.enum(SIGN_IN_STATES),
    /**
     * The absolute deadline, so a client can show it. **Not** the idle one: an
     * idle deadline a client displays is a countdown that lies the moment
     * anything else uses the session.
     */
    absoluteExpiresAt: z.string(),
  })
  .strict();

export type SignInResult = z.infer<typeof signInResultSchema>;

/* ── multi-factor ─────────────────────────────────────────────────────────── */

export const mfaChallengeRequestSchema = z
  .object({
    code: totpCodeSchema.optional(),
    recoveryCode: recoveryCodeSchema.optional(),
  })
  .strict()
  .refine((value) => (value.code === undefined) !== (value.recoveryCode === undefined), {
    message: 'Present exactly one of a code or a recovery code.',
  });

export type MfaChallengeRequest = z.infer<typeof mfaChallengeRequestSchema>;

export const mfaEnrolmentStartResultSchema = z
  .object({
    /** `otpauth://` — carries the secret. Shown once, never persisted client-side. */
    provisioningUri: z.string(),
    /** The same secret in base32, for a client that cannot scan a QR code. */
    secretBase32: z.string(),
  })
  .strict();

export type MfaEnrolmentStartResult = z.infer<typeof mfaEnrolmentStartResultSchema>;

export const mfaEnrolmentConfirmRequestSchema = z.object({ code: totpCodeSchema }).strict();

export type MfaEnrolmentConfirmRequest = z.infer<typeof mfaEnrolmentConfirmRequestSchema>;

export const mfaEnrolmentConfirmResultSchema = z
  .object({
    /** Shown ONCE. Only their hashes are stored; there is no endpoint that re-reads them. */
    recoveryCodes: z.array(z.string()).min(1),
  })
  .strict();

export type MfaEnrolmentConfirmResult = z.infer<typeof mfaEnrolmentConfirmResultSchema>;

/* ── activation and reset — separate shapes for separate namespaces ───────── */

export const activationRequestSchema = z
  .object({ token: authnTokenSchema, password: passwordSchema })
  .strict();

export type ActivationRequest = z.infer<typeof activationRequestSchema>;

export const passwordResetRequestSchema = z.object({ loginEmail: loginEmailSchema }).strict();

export type PasswordResetRequest = z.infer<typeof passwordResetRequestSchema>;

export const passwordResetCompleteSchema = z
  .object({ token: authnTokenSchema, password: passwordSchema })
  .strict();

export type PasswordResetComplete = z.infer<typeof passwordResetCompleteSchema>;

/**
 * The response to a reset REQUEST, and it is the same whatever happened.
 *
 * An address nobody holds, an address that has not activated, and an address
 * that received a token all produce this, byte for byte. Anything else is an
 * account-enumeration oracle.
 */
export const acknowledgementSchema = z.object({ acknowledged: z.literal(true) }).strict();

export type Acknowledgement = z.infer<typeof acknowledgementSchema>;

/* ── administrative surfaces (capability-gated) ───────────────────────────── */

export const issueInvitationRequestSchema = z
  .object({
    userId: z.string().uuid(),
    email: loginEmailSchema,
    /**
     * The controlled synthetic destination the outbox intent names.
     *
     * A REFERENCE, never an address to deliver to: SPEC-07 routes from the
     * connection record and never from payload content, and the safety rules
     * forbid a test reaching a real person. `sink:` is the only accepted scheme
     * and the API refuses anything else.
     */
    notificationRef: z.string().regex(/^sink:[a-z0-9][a-z0-9._-]{0,60}$/),
  })
  .strict();

export type IssueInvitationRequest = z.infer<typeof issueInvitationRequestSchema>;

export const issueInvitationResultSchema = z
  .object({ invitationId: z.string().uuid(), expiresAt: z.string() })
  .strict();

export type IssueInvitationResult = z.infer<typeof issueInvitationResultSchema>;

export const changeLoginEmailRequestSchema = z
  .object({
    loginEmail: loginEmailSchema,
    notificationRef: z.string().regex(/^sink:[a-z0-9][a-z0-9._-]{0,60}$/),
  })
  .strict();

export type ChangeLoginEmailRequest = z.infer<typeof changeLoginEmailRequestSchema>;

export const changeLoginEmailResultSchema = z
  .object({ sessionsRevoked: z.number().int(), invitationsReconciled: z.number().int() })
  .strict();

export type ChangeLoginEmailResult = z.infer<typeof changeLoginEmailResultSchema>;

export const resetMfaRequestSchema = z
  .object({ notificationRef: z.string().regex(/^sink:[a-z0-9][a-z0-9._-]{0,60}$/) })
  .strict();

export type ResetMfaRequest = z.infer<typeof resetMfaRequestSchema>;

export const resetMfaResultSchema = z
  .object({ removed: z.boolean(), sessionsRevoked: z.number().int() })
  .strict();

export type ResetMfaResult = z.infer<typeof resetMfaResultSchema>;

export const revokeSessionsResultSchema = z
  .object({ sessionsRevoked: z.number().int() })
  .strict();

export type RevokeSessionsResult = z.infer<typeof revokeSessionsResultSchema>;

/** The current principal's own summary, for the shell to render. Never another user's. */
export const authnMeSchema = z
  .object({
    userId: z.string().uuid(),
    displayName: z.string(),
    loginEmail: z.string(),
    mfaSatisfied: z.boolean(),
    mfaEnrolled: z.boolean(),
  })
  .strict();

export type AuthnMe = z.infer<typeof authnMeSchema>;
