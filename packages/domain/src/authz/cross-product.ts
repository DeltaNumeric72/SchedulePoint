/**
 * SPEC-06 §8.1 — the generated cross-product, and its independent oracle.
 *
 * > Dimensions: **action scope (2)** × org status (2) × entitlement state (5) ×
 * > effective window (3) × dependency satisfied (2) × availability (2) ×
 * > membership status (4) × role (6) × **organization membership status (4)** and
 * > **organization role (3)** × explicit grant (3) × object ownership (3) ×
 * > proxy state (4) × impersonation (2).
 * >
 * > **The scope dimension is not a free multiplier.** Group-scoped rows hold
 * > `org_membership = absent`; organization-scoped rows hold `membership = absent`
 * > and skip L0.2/L2.1. Both halves are generated and asserted; the generator
 * > fails if either half is empty for any capability.
 *
 * ## Why this lives in `packages/domain`
 *
 * Two test trees consume it — `packages/domain/test` evaluates every case
 * against the table, and `apps/api/test` replays a subset over HTTP and asserts
 * the two surfaces agree (§8.1: "A disagreement between surfaces is a hard
 * failure — it means more than one evaluator exists"). A generator in one test
 * tree cannot be imported by the other, and a copy in each is two generators.
 * It is pure data and pure functions, so it costs the domain package nothing.
 *
 * ## The oracle is written to disagree
 *
 * `expectedOutcome` is a **flat, ordered list of predicate → reason pairs**
 * transcribed from SPEC-06 §2's table. `authorize` is nested functions with
 * early returns. Two implementations of the same rule, written in deliberately
 * different shapes, from the same source text: a battery whose oracle is the
 * implementation proves only that the implementation is deterministic.
 */

import {
  CAPABILITIES,
  capabilityDefinition,
  moduleClosure,
  type CapabilityScope,
  type ModuleKey,
} from './catalogue.js';
import type { DenyReason, PolicyStep } from './decision.js';
import type { EntitlementInput, EntitlementState, PolicyInput } from './policy-input.js';

/* ────────────────────────────────────────────────────────────────────────────
 * The dimensions
 * ──────────────────────────────────────────────────────────────────────────── */

export const ORG_STATUSES = ['active', 'inactive'] as const;
/** Four stored states plus `absent` — L1.1's "no entitlement row exists". */
export const ENTITLEMENT_STATES = ['trial', 'active', 'suspended', 'revoked', 'absent'] as const;
export const EFFECTIVE_WINDOWS = ['before', 'within', 'after'] as const;
export const DEPENDENCY_SATISFIED = [true, false] as const;
export const AVAILABILITY = [true, false] as const;
/**
 * The four stored statuses plus `absent` — L3.1's "a membership exists".
 *
 * `absent` is not in SPEC-06 §8.1's four-valued list either, and it is here for
 * the same reason `MEMBERSHIP_WINDOWS` is: without it the generated battery never
 * produces `NO_MEMBERSHIP`, and L3.1's group branch would be a row of the table
 * the "every step is exercised" assertion silently skipped.
 */
export const MEMBERSHIP_STATUSES = ['absent', 'invited', 'active', 'suspended', 'ended'] as const;
export type MembershipStatusSlot = (typeof MEMBERSHIP_STATUSES)[number];
/** Six group roles: the five shipped keys plus `absent` (a membership with no role). */
export const GROUP_ROLE_SLOTS = [
  'member',
  'viewer',
  'telecom',
  'scheduler',
  'group_admin',
  'absent',
] as const;
export const ORGANIZATION_MEMBERSHIP_STATUSES = MEMBERSHIP_STATUSES;
/** Three organization role slots: the shipped key, an unprivileged one, and absent. */
export const ORGANIZATION_ROLE_SLOTS = ['org_admin', 'org_observer', 'absent'] as const;
export const GRANT_SLOTS = ['allow', 'deny', 'absent'] as const;
export const OWNERSHIP_SLOTS = ['owned', 'other', 'absent'] as const;
export const PROXY_SLOTS = [
  'none',
  'valid',
  'expired',
  'notifications-only',
  'grantor-denied',
] as const;
export const IMPERSONATION_SLOTS = [
  'none',
  'active',
  'expired',
  'credential-surface',
  'intersection-denied',
] as const;
/**
 * The membership's own validity window — L3.3.
 *
 * Not in SPEC-06 §8.1's dimension list, and added anyway: without it the
 * generated battery never produces `MEMBERSHIP_EXPIRED`, so L3.3 would have been
 * covered by named cases only while the coverage assertion below claimed every
 * row of the table was exercised. A dimension the spec's list omits is cheaper to
 * add than a coverage claim that is not true.
 */
export const MEMBERSHIP_WINDOWS = ['within', 'expired'] as const;
export type MembershipWindowSlot = (typeof MEMBERSHIP_WINDOWS)[number];

export type OrgStatusSlot = (typeof ORG_STATUSES)[number];
export type EntitlementSlot = (typeof ENTITLEMENT_STATES)[number];
export type WindowSlot = (typeof EFFECTIVE_WINDOWS)[number];
export type GroupRoleSlot = (typeof GROUP_ROLE_SLOTS)[number];
export type OrganizationRoleSlot = (typeof ORGANIZATION_ROLE_SLOTS)[number];
export type GrantSlot = (typeof GRANT_SLOTS)[number];
export type OwnershipSlot = (typeof OWNERSHIP_SLOTS)[number];
export type ProxySlot = (typeof PROXY_SLOTS)[number];
export type ImpersonationSlot = (typeof IMPERSONATION_SLOTS)[number];

export interface CrossProductCase {
  readonly capabilityKey: string;
  readonly scope: CapabilityScope;
  readonly orgStatus: OrgStatusSlot;
  readonly groupStatus: OrgStatusSlot;
  readonly entitlement: EntitlementSlot;
  readonly window: WindowSlot;
  readonly dependencySatisfied: boolean;
  readonly available: boolean;
  readonly membershipStatus: MembershipStatusSlot;
  readonly membershipWindow: MembershipWindowSlot;
  readonly role: GroupRoleSlot;
  readonly organizationMembershipStatus: MembershipStatusSlot;
  readonly organizationRole: OrganizationRoleSlot;
  readonly grant: GrantSlot;
  readonly ownership: OwnershipSlot;
  readonly proxy: ProxySlot;
  readonly impersonation: ImpersonationSlot;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The default role→capability map the battery evaluates against
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The system roles' capability sets, from
 * [08](../../../../docs/fable/08-roles-and-permissions.md) §6.
 *
 * This is the **seed** the provisioning path writes into `role_capabilities` for
 * a new organization, and it is the same constant the battery reasons about, so
 * a change to one is a change to both. A `G` cell in doc 08 §6 means the
 * capability is **grant-only** and appears in no role's set — `schedule.publish`,
 * `vacation.commit`, `picklist.administer`, `messaging.bulk_send`,
 * `identity.*` and `audit.export` are all absent below for that reason.
 */
export const SYSTEM_ROLE_CAPABILITIES: Readonly<Record<string, readonly string[]>> = {
  /* group roles */
  member: [],
  viewer: [],
  telecom: [],
  /* OPUS-M2-002 adds `schedule.catalogue.administer` to both, from doc 08 §6's
   * "Author catalogue & rules" row (scheduler ✓, group admin ✓). The two
   * group-SETTINGS keys go to `group_admin` alone, from the "Group settings"
   * row, where scheduler is `—`. Neither is a `G` cell, so both are role-implied
   * rather than grant-only. */
  /* OPUS-M3-003 adds the two schedule-authoring keys (SPEC-05) to both, from
   * doc 08 §6's "author the schedule" row (scheduler ✓, group admin ✓). They are
   * role-implied, not `G` cells. `schedule.publish`/`schedule.revert` stay OFF
   * every role — they are grant-only (doc 08 §4), so a scheduler drafts freely
   * but publication is a named, granted act. */
  scheduler: [
    'membership.touch_self',
    'schedule.catalogue.administer',
    'schedule.period.administer',
    'schedule.version.edit',
  ],
  group_admin: [
    'membership.touch_self',
    'documents.manage',
    'schedule.catalogue.administer',
    'schedule.period.administer',
    'schedule.version.edit',
    'group.holiday_calendar.administer',
    'group.pick_positions.administer',
  ],
  /* organization roles */
  org_admin: [
    'organization.membership.touch_self',
    'organization.membership.administer',
    'organization.group.administer',
    'organization.role.administer',
    'organization.entitlement.administer',
    'organization.profile.administer',
  ],
  /**
   * A deliberately unprivileged organization role.
   *
   * It exists so the organization half of the battery has a role that holds
   * **nothing** — without it every organization-scoped `NO_CAPABILITY` row would
   * come from `absent`, and "no role at all" fails at L3.1 rather than L4.2, so
   * L4.2's organization branch would never be exercised.
   */
  org_observer: [],
};

export const SYSTEM_GROUP_ROLES = ['member', 'viewer', 'telecom', 'scheduler', 'group_admin'] as const;
export const SYSTEM_ORGANIZATION_ROLES = ['org_admin', 'org_observer'] as const;

/* ────────────────────────────────────────────────────────────────────────────
 * Fixed instants — no clock anywhere
 * ──────────────────────────────────────────────────────────────────────────── */

export const NOW = '2026-08-02T12:00:00.000Z';
const LONG_AGO = '2020-01-01T00:00:00.000Z';
const RECENT_PAST = '2026-08-01T00:00:00.000Z';
const NEAR_FUTURE = '2026-08-03T00:00:00.000Z';
const FAR_FUTURE = '2030-01-01T00:00:00.000Z';

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
const GROUP_ID = '1a1a1a1a-1111-4111-8111-a1a1a1a1a1a1';
const MEMBERSHIP_ID = 'ac000001-1111-4111-8111-000000000001';
const OTHER_MEMBERSHIP_ID = 'ac000002-1111-4111-8111-000000000002';
const PRINCIPAL_ID = 'a0000001-1111-4111-8111-000000000001';
const OPERATOR_ID = '00000000-0000-4000-8000-00000000000f';

function windowFor(slot: WindowSlot): { from: string; to: string | null } {
  switch (slot) {
    case 'before':
      return { from: NEAR_FUTURE, to: FAR_FUTURE };
    case 'within':
      return { from: RECENT_PAST, to: FAR_FUTURE };
    case 'after':
      return { from: LONG_AGO, to: RECENT_PAST };
  }
}

function entitlementFor(slot: EntitlementSlot, window: WindowSlot, moduleKey: ModuleKey):
  | EntitlementInput
  | null {
  if (slot === 'absent') return null;
  const { from, to } = windowFor(window);
  return {
    moduleKey,
    state: slot satisfies Exclude<EntitlementSlot, 'absent'> as EntitlementState,
    effectiveFrom: from,
    effectiveTo: to,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Case → PolicyInput
 * ──────────────────────────────────────────────────────────────────────────── */

export function policyInputFor(testCase: CrossProductCase): PolicyInput {
  const definition = capabilityDefinition(testCase.capabilityKey);
  if (definition === undefined) {
    throw new Error(`cross-product case names an unknown capability: ${testCase.capabilityKey}`);
  }
  const moduleKey = definition.module;
  const groupScoped = testCase.scope === 'group';
  /** The window grants and proxies live in — always current, so only the dimension under test moves. */
  const openWindow = windowFor('within');
  const membershipWindow = windowFor(testCase.membershipWindow === 'within' ? 'within' : 'after');

  const dependencies = moduleClosure(moduleKey)
    .filter((key) => key !== moduleKey)
    .map((key) => ({
      moduleKey: key,
      entitlement: testCase.dependencySatisfied
        ? entitlementFor('active', 'within', key)
        : entitlementFor('revoked', 'within', key),
    }));

  const grants =
    testCase.grant === 'absent'
      ? []
      : [
          {
            capabilityKey: testCase.capabilityKey,
            granted: testCase.grant === 'allow',
            validFrom: openWindow.from,
            validTo: openWindow.to,
          },
        ];

  const roleKey = testCase.role === 'absent' ? null : testCase.role;
  const organizationRoleKey =
    testCase.organizationRole === 'absent' ? null : testCase.organizationRole;

  const target =
    testCase.ownership === 'absent'
      ? null
      : {
          organizationId: ORGANIZATION_ID,
          groupId: groupScoped ? GROUP_ID : null,
          type: 'membership',
          ownerMembershipId:
            testCase.ownership === 'owned' ? MEMBERSHIP_ID : OTHER_MEMBERSHIP_ID,
          state: null,
        };

  const proxy = (():
    | PolicyInput['proxy']
    | null => {
    switch (testCase.proxy) {
      case 'none':
        return null;
      case 'valid':
        return {
          grantorMembershipId: OTHER_MEMBERSHIP_ID,
          scope: 'act-on-behalf',
          status: 'active',
          validFrom: openWindow.from,
          validTo: openWindow.to,
          grantorPassed: true,
        };
      case 'expired':
        return {
          grantorMembershipId: OTHER_MEMBERSHIP_ID,
          scope: 'act-on-behalf',
          status: 'active',
          validFrom: LONG_AGO,
          validTo: RECENT_PAST,
          grantorPassed: true,
        };
      case 'notifications-only':
        return {
          grantorMembershipId: OTHER_MEMBERSHIP_ID,
          scope: 'notifications-only',
          status: 'active',
          validFrom: openWindow.from,
          validTo: openWindow.to,
          grantorPassed: true,
        };
      case 'grantor-denied':
        return {
          grantorMembershipId: OTHER_MEMBERSHIP_ID,
          scope: 'act-on-behalf',
          status: 'active',
          validFrom: openWindow.from,
          validTo: openWindow.to,
          grantorPassed: false,
        };
    }
  })();

  const impersonation = ((): PolicyInput['impersonation'] => {
    switch (testCase.impersonation) {
      case 'none':
        return null;
      case 'active':
        return {
          operatorUserId: OPERATOR_ID,
          expiresAt: FAR_FUTURE,
          targetIsCredentialSurface: false,
          operatorHoldsCapability: true,
        };
      case 'expired':
        return {
          operatorUserId: OPERATOR_ID,
          expiresAt: RECENT_PAST,
          targetIsCredentialSurface: false,
          operatorHoldsCapability: true,
        };
      case 'credential-surface':
        return {
          operatorUserId: OPERATOR_ID,
          expiresAt: FAR_FUTURE,
          targetIsCredentialSurface: true,
          operatorHoldsCapability: true,
        };
      case 'intersection-denied':
        return {
          operatorUserId: OPERATOR_ID,
          expiresAt: FAR_FUTURE,
          targetIsCredentialSurface: false,
          operatorHoldsCapability: false,
        };
    }
  })();

  return {
    context: {
      principalUserId: PRINCIPAL_ID,
      expectedOrganizationId: ORGANIZATION_ID,
      expectedGroupId: groupScoped ? GROUP_ID : null,
      membershipId: MEMBERSHIP_ID,
    },
    organization: { id: ORGANIZATION_ID, status: testCase.orgStatus },
    group: groupScoped ? { id: GROUP_ID, status: testCase.groupStatus } : null,
    entitlement: entitlementFor(testCase.entitlement, testCase.window, moduleKey),
    moduleDependencies: dependencies,
    availability: groupScoped ? { moduleKey, available: testCase.available } : null,
    membership:
      groupScoped && testCase.membershipStatus !== 'absent'
        ? {
            id: MEMBERSHIP_ID,
            status: testCase.membershipStatus,
            roleId: roleKey,
            validFrom: membershipWindow.from,
            validTo: membershipWindow.to,
          }
        : null,
    role: groupScoped && roleKey !== null ? { id: roleKey, isSystemRole: true } : null,
    roleCapabilities: groupScoped && roleKey !== null ? (SYSTEM_ROLE_CAPABILITIES[roleKey] ?? []) : [],
    organizationMembership:
      groupScoped || testCase.organizationMembershipStatus === 'absent'
        ? null
        : {
            id: MEMBERSHIP_ID,
            status: testCase.organizationMembershipStatus,
            roleId: organizationRoleKey,
            validFrom: membershipWindow.from,
            validTo: membershipWindow.to,
          },
    organizationRole:
      !groupScoped && organizationRoleKey !== null
        ? { id: organizationRoleKey, isSystemRole: true }
        : null,
    organizationRoleCapabilities:
      !groupScoped && organizationRoleKey !== null
        ? (SYSTEM_ROLE_CAPABILITIES[organizationRoleKey] ?? [])
        : [],
    grants,
    proxy,
    impersonation,
    target,
    action: {
      key: testCase.capabilityKey,
      moduleKey,
      scope: testCase.scope,
      requiresObjectPolicy: testCase.ownership !== 'absent',
      ownershipRequired: testCase.ownership !== 'absent',
    },
    now: NOW,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * The oracle
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ExpectedOutcome {
  readonly allowed: boolean;
  readonly step?: PolicyStep;
  readonly reason?: DenyReason;
}

const ALLOWED: ExpectedOutcome = { allowed: true };

/**
 * SPEC-06 §2's table, read top to bottom as a list of guards.
 *
 * Written flat and in one function on purpose: it is the second reading of the
 * spec, and a second reading that reuses the first one's abstractions is not an
 * independent check.
 */
export function expectedOutcome(testCase: CrossProductCase): ExpectedOutcome {
  const definition = capabilityDefinition(testCase.capabilityKey);
  if (definition === undefined) return { allowed: false, step: 'P-4', reason: 'UNDECLARED_ACTION' };
  const groupScoped = testCase.scope === 'group';

  /* L0.1 */
  if (testCase.orgStatus !== 'active') return { allowed: false, step: 'L0.1', reason: 'ORG_INACTIVE' };
  /* L0.2 — group scope only */
  if (groupScoped && testCase.groupStatus !== 'active') {
    return { allowed: false, step: 'L0.2', reason: 'GROUP_INACTIVE' };
  }

  /* L1.1 */
  if (testCase.entitlement === 'absent') {
    return { allowed: false, step: 'L1.1', reason: 'NOT_ENTITLED' };
  }
  /* L1.2 */
  if (testCase.entitlement === 'suspended') {
    return { allowed: false, step: 'L1.2', reason: 'ENTITLEMENT_SUSPENDED' };
  }
  if (testCase.entitlement === 'revoked') {
    return { allowed: false, step: 'L1.2', reason: 'ENTITLEMENT_REVOKED' };
  }
  /* L1.3 */
  if (testCase.window !== 'within') {
    return { allowed: false, step: 'L1.3', reason: 'ENTITLEMENT_EXPIRED' };
  }
  /* L1.4 — only bites when the module HAS a dependency. `core_scheduling` has
   * none, so the dimension is inert for capabilities in it, which is why the
   * generator asserts every capability's module coverage separately. */
  const hasDependencies = moduleClosure(definition.module).length > 1;
  if (hasDependencies && !testCase.dependencySatisfied) {
    return { allowed: false, step: 'L1.4', reason: 'MODULE_DEPENDENCY_UNSATISFIED' };
  }

  /* L2.1 — group scope only */
  if (groupScoped && !testCase.available) {
    return { allowed: false, step: 'L2.1', reason: 'MODULE_UNAVAILABLE_IN_GROUP' };
  }

  /* L3.1 / L3.2 / L3.3 */
  const status = groupScoped ? testCase.membershipStatus : testCase.organizationMembershipStatus;
  if (status === 'absent') {
    return {
      allowed: false,
      step: 'L3.1',
      reason: groupScoped ? 'NO_MEMBERSHIP' : 'NO_ORG_MEMBERSHIP',
    };
  }
  if (!groupScoped && testCase.organizationRole === 'absent') {
    // "…and carries an organization role" is part of L3.1, not of L4.2.
    return { allowed: false, step: 'L3.1', reason: 'NO_ORG_MEMBERSHIP' };
  }
  if (status !== 'active') {
    return {
      allowed: false,
      step: 'L3.2',
      reason:
        status === 'suspended'
          ? 'MEMBERSHIP_SUSPENDED'
          : status === 'invited'
            ? 'MEMBERSHIP_INVITED'
            : 'MEMBERSHIP_ENDED',
    };
  }
  /* L3.3 */
  if (testCase.membershipWindow !== 'within') {
    return { allowed: false, step: 'L3.3', reason: 'MEMBERSHIP_EXPIRED' };
  }

  /* L4.1 — explicit deny beats everything */
  if (testCase.grant === 'deny') return { allowed: false, step: 'L4.1', reason: 'EXPLICIT_DENY' };

  /* L4.2 */
  const roleKey = groupScoped
    ? testCase.role === 'absent'
      ? null
      : testCase.role
    : testCase.organizationRole === 'absent'
      ? null
      : testCase.organizationRole;
  const roleHolds =
    roleKey !== null && (SYSTEM_ROLE_CAPABILITIES[roleKey] ?? []).includes(testCase.capabilityKey);
  if (testCase.grant !== 'allow' && !roleHolds) {
    return { allowed: false, step: 'L4.2', reason: 'NO_CAPABILITY' };
  }

  /* L5.1 — ownership. The generated action is self-scoped whenever a target
   * exists, and declares no override capability, so `other` always fails. */
  if (testCase.ownership === 'other') {
    return { allowed: false, step: 'L5.1', reason: 'OBJECT_POLICY' };
  }

  /* L6.1 */
  if (testCase.proxy === 'expired') return { allowed: false, step: 'L6.1', reason: 'PROXY_INVALID' };
  if (testCase.proxy === 'notifications-only') {
    return { allowed: false, step: 'L6.1', reason: 'PROXY_SCOPE' };
  }
  if (testCase.proxy === 'grantor-denied') {
    return { allowed: false, step: 'L6.1', reason: 'PROXY_GRANTOR_DENIED' };
  }

  /* L6.2 */
  if (testCase.impersonation === 'expired') {
    return { allowed: false, step: 'L6.2', reason: 'IMPERSONATION_EXPIRED' };
  }
  if (
    testCase.impersonation === 'credential-surface' ||
    testCase.impersonation === 'intersection-denied'
  ) {
    return { allowed: false, step: 'L6.2', reason: 'IMPERSONATION_FORBIDDEN_SURFACE' };
  }

  return ALLOWED;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Generation
 * ──────────────────────────────────────────────────────────────────────────── */

export interface GenerationOptions {
  /**
   * `full` enumerates every dimension for every capability.
   * `representative` enumerates every dimension for ONE capability per scope and
   * a reduced product for the rest — see `describeCoverage`.
   */
  readonly mode: 'full' | 'representative';
}

const REPRESENTATIVE: Readonly<Record<CapabilityScope, string>> = {
  group: 'membership.touch_self',
  organization: 'organization.membership.touch_self',
};

/**
 * Every case, as a generator so 10^5–10^6 cases never exist at once.
 *
 * The reduced product used for non-representative capabilities holds the
 * **capability-independent** dimensions at their allowing values and sweeps the
 * ones that can differ per capability: entitlement state, effective window,
 * dependency satisfaction, availability, role and grant. Organization status,
 * group status, membership status, ownership, proxy and impersonation are
 * evaluated by layers that never read the capability key, so a second capability
 * cannot make them behave differently — and the representative sweep covers them
 * exhaustively for each scope.
 */
export function* generateCases(options: GenerationOptions): Generator<CrossProductCase> {
  for (const definition of CAPABILITIES) {
    const isRepresentative =
      options.mode === 'full' || REPRESENTATIVE[definition.scope] === definition.key;
    const groupScoped = definition.scope === 'group';

    const orgStatuses = isRepresentative ? ORG_STATUSES : (['active'] as const);
    const groupStatuses = isRepresentative && groupScoped ? ORG_STATUSES : (['active'] as const);
    const membershipStatuses = isRepresentative
      ? MEMBERSHIP_STATUSES
      : (['active'] as const);
    const membershipWindows = isRepresentative ? MEMBERSHIP_WINDOWS : (['within'] as const);
    const ownerships = isRepresentative ? OWNERSHIP_SLOTS : (['absent'] as const);
    const proxies = isRepresentative ? PROXY_SLOTS : (['none'] as const);
    const impersonations = isRepresentative ? IMPERSONATION_SLOTS : (['none'] as const);

    const roles: readonly GroupRoleSlot[] = groupScoped ? GROUP_ROLE_SLOTS : (['absent'] as const);
    const organizationRoles: readonly OrganizationRoleSlot[] = groupScoped
      ? (['absent'] as const)
      : ORGANIZATION_ROLE_SLOTS;

    for (const orgStatus of orgStatuses) {
      for (const groupStatus of groupStatuses) {
        for (const entitlement of ENTITLEMENT_STATES) {
          for (const window of EFFECTIVE_WINDOWS) {
            for (const dependencySatisfied of DEPENDENCY_SATISFIED) {
              for (const available of groupScoped ? AVAILABILITY : ([true] as const)) {
                for (const membershipStatus of groupScoped ? membershipStatuses : (['active'] as const)) {
                  for (const membershipWindow of membershipWindows) {
                    for (const role of roles) {
                      for (const organizationMembershipStatus of groupScoped
                        ? (['active'] as const)
                        : membershipStatuses) {
                        for (const organizationRole of organizationRoles) {
                          for (const grant of GRANT_SLOTS) {
                            for (const ownership of ownerships) {
                              for (const proxy of proxies) {
                                for (const impersonation of impersonations) {
                                  yield {
                                    capabilityKey: definition.key,
                                    scope: definition.scope,
                                    orgStatus,
                                    groupStatus,
                                    entitlement,
                                    window,
                                    dependencySatisfied,
                                    available,
                                    membershipStatus,
                                    membershipWindow,
                                    role,
                                    organizationMembershipStatus,
                                    organizationRole,
                                    grant,
                                    ownership,
                                    proxy,
                                    impersonation,
                                  };
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

/** A one-line, loggable description of what a case is, for a failure message. */
export function describeCase(testCase: CrossProductCase): string {
  return [
    testCase.capabilityKey,
    testCase.scope,
    `org=${testCase.orgStatus}`,
    `group=${testCase.groupStatus}`,
    `ent=${testCase.entitlement}/${testCase.window}`,
    `dep=${String(testCase.dependencySatisfied)}`,
    `avail=${String(testCase.available)}`,
    `mem=${testCase.membershipStatus}/${testCase.membershipWindow}`,
    `role=${testCase.role}`,
    `orgmem=${testCase.organizationMembershipStatus}`,
    `orgrole=${testCase.organizationRole}`,
    `grant=${testCase.grant}`,
    `own=${testCase.ownership}`,
    `proxy=${testCase.proxy}`,
    `imp=${testCase.impersonation}`,
  ].join(' ');
}
