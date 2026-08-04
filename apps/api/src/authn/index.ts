/**
 * OPUS-M3-001 — authentication, sessions, invitation/activation, password reset,
 * TOTP multi-factor, login-email change (CAR-027) and SPEC-11 §3.2 privileged-
 * session auditing.
 *
 * Read `service.ts`'s header first: it states the FAD-12 ordering every mutating
 * method follows and the one property this whole subsystem exists to keep — that
 * no token, password, hash, TOTP secret or recovery code reaches a log, an
 * error, a trace, a queue payload, an audit payload or an evidence artifact.
 */

export { ControllableClock, systemClock, type Clock, DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS } from './clock.js';
export { accountStateOf, canAuthenticate, transitionIsLegal, type AccountState } from './account-state.js';
export {
  DEFAULT_AUTHN_POLICY,
  MFA_REQUIRED_ROLES,
  lockoutDurationMs,
  type AuthnPolicy,
} from './config.js';
export {
  AUTHN_FAILED_MESSAGE,
  AuthnError,
  SESSION_INVALID_MESSAGE,
  TOKEN_INVALID_MESSAGE,
  type AuthnClientCode,
} from './errors.js';
export {
  CURRENT_SCRYPT_PARAMETERS,
  MINIMUM_PASSWORD_LENGTH,
  hashPassword,
  passwordPolicyProblem,
  verifyPassword,
} from './passwords.js';
export { SecretBox, createSecretBox, type SealedSecret } from './secret-box.js';
export {
  SESSION_COOKIE_NAME,
  decodeSessionCookie,
  encodeSessionCookie,
  hashToken,
  mintToken,
  type TokenNamespace,
} from './tokens.js';
export {
  DEFAULT_TOTP_PARAMETERS,
  TOTP_SKEW_STEPS,
  base32Encode,
  hotp,
  mintRecoveryCodes,
  mintTotpSecret,
  normalizeRecoveryCode,
  provisioningUri,
  timeStepAt,
  totpAt,
  verifyTotp,
  type TotpParameters,
} from './totp.js';
export {
  AuthnService,
  createAuthnService,
  hashRecoveryCode,
  type SignInResult,
  type SignInState,
} from './service.js';
export { SessionPrincipalResolver, sessionMatchesDeclaredOrganization } from './principal-resolver.js';
export {
  PRIVILEGED_MARKER_PREFIX,
  PRIVILEGED_ROLES,
  PrivilegedSessionAuditor,
  detectUnauditedPrivilegedBackends,
  type UnauditedBackend,
} from './break-glass.js';
export * as authnStore from './store.js';
export { AUTHN_AUDIT_EVENTS, preAuth } from './policies.js';
