/**
 * The authentication failure vocabulary.
 *
 * ## One code for every credential failure, and that is the requirement
 *
 * 14 §2: lockout "**does not distinguish 'no such account' from 'wrong
 * password'**". The way to keep that true is not to remember it at each `return`
 * — it is to have one code. `AUTHN_FAILED` is what an unknown login email, a
 * wrong password, a deactivated account, an unactivated account and a locked
 * account all produce, with the same status and the same body.
 *
 * The distinction still exists where it is safe: in the AUDIT payload, which
 * only an authorized reader sees, and in the operator log. `signInFailureReason`
 * below is that internal vocabulary, and it is deliberately a different type
 * from the client-facing code so a refactor cannot leak one into the other.
 */

/** What a client is ever told. Two codes, both deliberately unspecific. */
export type AuthnClientCode =
  /** Any credential failure whatsoever. Never says which. */
  | 'AUTHN_FAILED'
  /** The presented session is absent, unknown, expired or revoked. */
  | 'AUTHN_SESSION_INVALID'
  /** A token (invitation or reset) was unknown, expired, consumed or revoked. */
  | 'AUTHN_TOKEN_INVALID'
  /** The submitted value failed a stated rule the client can act on. */
  | 'AUTHN_INVALID_REQUEST'
  /** The requested change conflicts with existing state (a login email in use). */
  | 'AUTHN_CONFLICT';

/**
 * The internal reason. Audit payloads and operator logs only.
 *
 * A closed set, and `apps/api/test/authn/secrecy.test.ts`'s "the error
 * vocabulary carries no reason that could be a credential" is what keeps it
 * honest — by a stronger oracle than the one this comment used to claim. It
 * drives four DISTINGUISHABLE sign-in failures and asserts they collapse to
 * exactly one `code|message` pair, so no reason can be inferred from the
 * response at all; the older wording claimed a string-by-string scan of bodies
 * and headers, which no test performs (OPUS-M4-005). The set stays closed
 * because a reason that is not in it is a reason nobody decided was safe to
 * record.
 */
export type SignInFailureReason =
  | 'unknown_login_email'
  | 'no_password_set'
  | 'wrong_password'
  | 'account_locked'
  | 'account_deactivated'
  | 'membership_not_active';

export type MfaFailureReason =
  | 'no_enrolment'
  | 'wrong_code'
  | 'replayed_time_step'
  | 'unknown_recovery_code'
  | 'consumed_recovery_code'
  | 'attempt_limit_reached';

export type TokenFailureReason =
  | 'unknown_token'
  | 'expired'
  | 'already_consumed'
  /** The token was fine; the ACCOUNT had already activated. A different fact. */
  | 'account_already_active'
  | 'revoked'
  | 'wrong_namespace';

export class AuthnError extends Error {
  readonly code: AuthnClientCode;
  readonly status: number;
  /** Never sent to a client. Logged and audited. */
  readonly internalReason: string | undefined;

  constructor(
    code: AuthnClientCode,
    status: number,
    message: string,
    internalReason?: string,
  ) {
    super(message);
    this.name = 'AuthnError';
    this.code = code;
    this.status = status;
    this.internalReason = internalReason;
  }
}

/**
 * The one message a credential failure ever carries.
 *
 * Fixed text, in the same spirit as `apps/api/src/http/errors.ts`'s fixed 5xx
 * body: a message that varied with the reason would be the oracle the code is
 * designed not to be, and the variation would arrive as somebody's helpful
 * improvement rather than as a decision.
 */
export const AUTHN_FAILED_MESSAGE = 'Those sign-in details were not accepted.';
export const SESSION_INVALID_MESSAGE = 'Your session is no longer valid. Please sign in again.';
export const TOKEN_INVALID_MESSAGE = 'That link is no longer valid. Please request a new one.';

export function authnFailed(internalReason: SignInFailureReason | MfaFailureReason): AuthnError {
  return new AuthnError('AUTHN_FAILED', 401, AUTHN_FAILED_MESSAGE, internalReason);
}

export function sessionInvalid(internalReason: string): AuthnError {
  return new AuthnError('AUTHN_SESSION_INVALID', 401, SESSION_INVALID_MESSAGE, internalReason);
}

export function tokenInvalid(internalReason: TokenFailureReason): AuthnError {
  return new AuthnError('AUTHN_TOKEN_INVALID', 400, TOKEN_INVALID_MESSAGE, internalReason);
}

export function invalidRequest(message: string): AuthnError {
  return new AuthnError('AUTHN_INVALID_REQUEST', 422, message);
}

export function conflict(message: string): AuthnError {
  return new AuthnError('AUTHN_CONFLICT', 409, message);
}
