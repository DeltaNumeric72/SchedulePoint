import { DAY_MS, HOUR_MS, MINUTE_MS } from './clock.js';

/**
 * Every number this subsystem compares a clock against, in one place.
 *
 * They are configuration in the sense that a deployment may want different ones,
 * and they are **not** environment variables, because an authentication lifetime
 * that can be changed without a code review is an authentication lifetime that
 * will be. Changing one is a diff.
 *
 * 14 §3 requires "bounded idle **and** absolute lifetimes" and a "persistent
 * option scoped to personal devices". The persistent option widens the IDLE
 * window only — the absolute deadline is identical either way, which is what
 * makes "persistent" a convenience rather than a second, longer session class.
 */
export interface AuthnPolicy {
  /** Idle deadline for an ordinary session. */
  readonly idleLifetimeMs: number;
  /** Idle deadline when the client asked to stay signed in on a personal device. */
  readonly persistentIdleLifetimeMs: number;
  /** Absolute deadline. Identical for both, and frozen at issue by a trigger. */
  readonly absoluteLifetimeMs: number;
  /** How long a single-use invitation token is good for (14 §2). */
  readonly invitationLifetimeMs: number;
  /** How long a single-use password-reset token is good for. Shorter, deliberately. */
  readonly passwordResetLifetimeMs: number;
  /** Failures before the account is locked (T-22). */
  readonly lockoutThreshold: number;
  /** The base of the progressive delay. Doubles per failure beyond the threshold. */
  readonly lockoutBaseMs: number;
  /** The delay never exceeds this, so an account is never permanently locked out. */
  readonly lockoutMaxMs: number;
  /** A failure older than this no longer counts toward the threshold. */
  readonly failureDecayMs: number;
  /** Consecutive failed MFA challenges before the partial session is revoked. */
  readonly mfaAttemptLimit: number;
}

export const DEFAULT_AUTHN_POLICY: AuthnPolicy = {
  idleLifetimeMs: 30 * MINUTE_MS,
  persistentIdleLifetimeMs: 14 * DAY_MS,
  absoluteLifetimeMs: 12 * HOUR_MS,
  invitationLifetimeMs: 7 * DAY_MS,
  passwordResetLifetimeMs: HOUR_MS,
  lockoutThreshold: 5,
  lockoutBaseMs: MINUTE_MS,
  lockoutMaxMs: HOUR_MS,
  failureDecayMs: 24 * HOUR_MS,
  mfaAttemptLimit: 5,
};

/**
 * T-22's "progressive delay", as a function rather than as a boolean column.
 *
 * The first `lockoutThreshold` failures cost nothing; each one after that
 * doubles the delay, capped. The cap matters: an uncapped doubling reaches
 * "locked until the heat death of the universe" in about forty failures, which
 * turns an availability control into a denial of service anybody can trigger
 * against anybody by typing the wrong password.
 */
export function lockoutDurationMs(policy: AuthnPolicy, failureCount: number): number {
  if (failureCount < policy.lockoutThreshold) return 0;
  const excess = failureCount - policy.lockoutThreshold;
  const scaled = policy.lockoutBaseMs * 2 ** Math.min(excess, 20);
  return Math.min(scaled, policy.lockoutMaxMs);
}

/**
 * The roles for which 14 §2 requires MFA.
 *
 * "Elevated" is spelled out rather than inferred from a capability count: a role
 * that can author the schedule everybody works to, administer the organization,
 * or administer a group is elevated. `viewer`, `member`, `telecom` and
 * `org_observer` are not, and adding a role to this set is a deliberate diff.
 */
export const MFA_REQUIRED_ROLES: ReadonlySet<string> = new Set([
  'org_admin',
  'group_admin',
  'scheduler',
]);
