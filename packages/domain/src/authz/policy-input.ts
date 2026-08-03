/**
 * SPEC-06 §1's `PolicyInput`, in TypeScript.
 *
 * The shape is transcribed field-for-field from the spec, including the V-24
 * additions (`org_membership`, `org_role`, `org_role_caps`, `action.scope`) and
 * the nullability the spec states — `group?` is null for organization-scoped
 * actions, `membership?` is null when org-scoped.
 *
 * **The caller assembles this snapshot; the evaluator performs no I/O.** In
 * `apps/api` the assembly happens inside the same unit of work as the mutation
 * it authorizes (FAD-12, I-19) — see `apps/api/src/authz/load-policy-input.ts`.
 */

import type { CapabilityScope, ModuleKey } from './catalogue.js';

/** An ISO-8601 instant. Every window comparison in the table uses these. */
export type Instant = string;

export type EntitlementState = 'trial' | 'active' | 'suspended' | 'revoked';

export interface OrganizationInput {
  readonly id: string;
  readonly status: 'active' | 'inactive';
}

export interface GroupInput {
  readonly id: string;
  readonly status: 'active' | 'inactive';
}

export interface EntitlementInput {
  readonly moduleKey: ModuleKey;
  readonly state: EntitlementState;
  readonly effectiveFrom: Instant;
  /** `null` = open-ended. `now ∈ [effective_from, effective_to)` (L1.3). */
  readonly effectiveTo: Instant | null;
}

export interface AvailabilityInput {
  readonly moduleKey: ModuleKey;
  readonly available: boolean;
}

export type MembershipInputStatus = 'invited' | 'active' | 'suspended' | 'ended';

export interface MembershipInput {
  readonly id: string;
  readonly status: MembershipInputStatus;
  /**
   * The role **KEY** the membership carries — `scheduler`, `org_admin` — not the
   * `roles` row's UUID.
   *
   * Stated because it was ambiguous and the two callers disagreed: the loader
   * passed the UUID while the cross-product generator passed the key, and
   * nothing compared them until S-07's cross-check landed. It is the key because
   * that is what `memberships.group_role` / `.organization_role` actually store,
   * and what P-10's namespace rule is expressed over.
   */
  readonly roleId: string | null;
  readonly validFrom: Instant;
  readonly validTo: Instant | null;
}

export interface RoleInput {
  /** The role KEY, matching `MembershipInput.roleId`. See the note there. */
  readonly id: string;
  readonly isSystemRole: boolean;
}

export interface GrantInput {
  readonly capabilityKey: string;
  /** `false` is an EXPLICIT DENY and beats every allow within its window (P-1). */
  readonly granted: boolean;
  readonly validFrom: Instant;
  readonly validTo: Instant | null;
}

export type ProxyScope = 'act-on-behalf' | 'notifications-only';

export interface ProxyInput {
  readonly grantorMembershipId: string;
  readonly scope: ProxyScope;
  readonly status: 'active' | 'revoked' | 'expired';
  readonly validFrom: Instant;
  readonly validTo: Instant | null;
  /**
   * The grantor's own verdict for the SAME action, evaluated independently.
   *
   * > **The grantor must independently pass L0–L5 for the same action.** A proxy
   * > can never exceed the grantor — `PROXY_GRANTOR_DENIED`
   *
   * It is an input rather than a recursive call because the evaluator is pure:
   * the caller runs `authorize` a second time with the grantor's snapshot and
   * passes the boolean in. A recursive call would need the grantor's snapshot,
   * which is I/O.
   */
  readonly grantorPassed: boolean;
}

export interface ImpersonationInput {
  readonly operatorUserId: string;
  readonly expiresAt: Instant;
  /**
   * SPEC-06 §3.3: "**credential, MFA, and token surfaces unreachable**". Declared
   * by the action, evaluated here.
   */
  readonly targetIsCredentialSurface: boolean;
  /**
   * > An impersonating operator's effective capability set is the **intersection**
   * > of their own and the impersonated user's.
   *
   * The caller evaluates the operator's own verdict for the same action and
   * passes it in, for the same purity reason as `grantorPassed`.
   */
  readonly operatorHoldsCapability: boolean;
}

export interface TargetInput {
  readonly organizationId: string;
  readonly groupId: string | null;
  readonly type: string;
  readonly ownerMembershipId: string | null;
  readonly state: string | null;
}

export interface ActionInput {
  readonly key: string;
  readonly moduleKey: ModuleKey;
  readonly scope: CapabilityScope;
  readonly requiresObjectPolicy: boolean;
  /**
   * Self-scoped actions (own profile, own request, own assignment) require
   * `target.owner_membership_id = ctx.membership_id` **unless** a distinct
   * administrative capability is held (SPEC-06 §3.1, Ownership).
   */
  readonly ownershipRequired?: boolean;
  /** The administrative capability that lifts `ownershipRequired`, if any. */
  readonly ownershipOverrideCapability?: string;
  /** Target states in which the action is legal (SPEC-06 §3.1, State). */
  readonly permittedTargetStates?: readonly string[];
}

/**
 * The context the evaluator needs. A subset of SPEC-01 §2.1's tuple — the fields
 * the truth table reads, and no others.
 */
export interface EvaluationContext {
  readonly principalUserId: string;
  readonly expectedOrganizationId: string;
  readonly expectedGroupId: string | null;
  /** The acting membership resolved at SPEC-01 §2.3 step 2. */
  readonly membershipId: string;
}

export interface PolicyInput {
  readonly context: EvaluationContext;
  readonly organization: OrganizationInput | null;
  /** `null` for organization-scoped actions — there is no group (V-24). */
  readonly group: GroupInput | null;
  /** The entitlement for the action's module, or `null` when no row exists (L1.1). */
  readonly entitlement: EntitlementInput | null;
  /**
   * One row per **transitive** dependency of the action's module, excluding the
   * module itself. `null` in `entitlement` means no row exists for that
   * dependency, which fails L1.4 exactly as it fails L1.1.
   */
  readonly moduleDependencies: readonly {
    readonly moduleKey: ModuleKey;
    readonly entitlement: EntitlementInput | null;
  }[];
  readonly availability: AvailabilityInput | null;
  /** GROUP membership; `null` when the action is organization-scoped. */
  readonly membership: MembershipInput | null;
  readonly role: RoleInput | null;
  readonly roleCapabilities: readonly string[];
  /** ORGANIZATION membership; `null` when the action is group-scoped (V-24). */
  readonly organizationMembership: MembershipInput | null;
  readonly organizationRole: RoleInput | null;
  readonly organizationRoleCapabilities: readonly string[];
  /** Grants on the membership selected at L3.1, for the action's capability key. */
  readonly grants: readonly GrantInput[];
  readonly proxy: ProxyInput | null;
  readonly impersonation: ImpersonationInput | null;
  readonly target: TargetInput | null;
  readonly action: ActionInput;
  readonly now: Instant;
}
