import type { AuthnStage, PreAuthPolicy, RouteConfigWithPolicy } from '../http/policy.js';

/**
 * The route declarations for the authentication surface, in one place.
 *
 * Declarations live beside the slice rather than inside the route file for the
 * reason `apps/api/src/catalogue/policies.ts` gives: a test can then assert
 * against the DECLARATION — that this action key exists in the catalogue, that
 * the scope matches, that the baseline capability is the one the traceability
 * matrix names — without booting a server.
 *
 * ## The `CAP-###` values are traceability, not evaluation input
 *
 * `policy.capability` names the baseline capability from report 19; the
 * evaluator reads `action.key`. Several action keys belong to one baseline
 * capability, which is why `identity.reset_mfa` and
 * `organization.membership.administer` can both sit under CAP-009: the baseline
 * capability is "invitation and credential lifecycle", and inviting, resetting a
 * factor and changing a login email are three actions within it.
 */

/** A `preauth` declaration. The stage is required; `isRoutePolicy` refuses one without. */
export function preAuth(stage: AuthnStage, reason: string): PreAuthPolicy {
  return { kind: 'preauth', reason, stage };
}

/**
 * Invitation issue and revoke.
 *
 * `organization.membership.administer`, whose catalogue description is literally
 * "invite a user to the organization, end a membership, assign a group role". A
 * new key would have been a second name for an action the catalogue already has.
 */
export const INVITATION_CONFIG: RouteConfigWithPolicy = {
  policy: { kind: 'capability', capability: 'CAP-009' },
  actionScope: 'organization',
  action: {
    key: 'organization.membership.administer',
    moduleKey: 'organization_administration',
    requiresObjectPolicy: false,
  },
};

/** CAR-027. Grant-only, and never self-service (06 §3.2). */
export const CHANGE_LOGIN_EMAIL_CONFIG: RouteConfigWithPolicy = {
  policy: { kind: 'capability', capability: 'CAP-009' },
  actionScope: 'organization',
  action: {
    key: 'identity.change_login_email',
    moduleKey: 'organization_administration',
    requiresObjectPolicy: false,
  },
};

/** SPEC-11 X-12. Grant-only, and deliberately not implied by membership administration. */
export const RESET_MFA_CONFIG: RouteConfigWithPolicy = {
  policy: { kind: 'capability', capability: 'CAP-009' },
  actionScope: 'organization',
  action: {
    key: 'identity.reset_mfa',
    moduleKey: 'organization_administration',
    requiresObjectPolicy: false,
  },
};

/** Administrative eviction. Grant-only: an incident control, not a default power. */
export const ADMINISTER_SESSIONS_CONFIG: RouteConfigWithPolicy = {
  policy: { kind: 'capability', capability: 'CAP-009' },
  actionScope: 'organization',
  action: {
    key: 'identity.administer_sessions',
    moduleKey: 'organization_administration',
    requiresObjectPolicy: false,
  },
};

/** Every audit event this slice emits, as a contract with the domain vocabulary. */
export const AUTHN_AUDIT_EVENTS = [
  'authn.sign_in.succeeded',
  'authn.sign_in.failed',
  'authn.account.locked',
  'authn.session.revoked',
  'authn.session.rotated',
  'authn.mfa.enrolment_started',
  'authn.mfa.enrolled',
  'authn.mfa.challenge_succeeded',
  'authn.mfa.challenge_failed',
  'authn.mfa.reset',
  'authn.mfa.recovery_code_consumed',
  'authn.invitation.issued',
  'authn.invitation.accepted',
  'authn.invitation.revoked',
  'authn.invitation.reconciled',
  'authn.account.activated',
  'authn.password_reset.requested',
  'authn.password.changed',
  'authn.login_email.changed',
] as const;
