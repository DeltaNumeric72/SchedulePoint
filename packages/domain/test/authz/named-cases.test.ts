import { describe, expect, it } from 'vitest';

import {
  CAPABILITIES,
  MODULE_KEYS,
  authorize,
  authorizeWithoutObjectPolicy,
  capabilityDefinition,
  denialDisclosure,
  duplicateCapabilityKeys,
  moduleClosure,
  moduleDependencyCycles,
  overlappingCapabilityKeys,
  passedCapabilityLayer,
  policyInputFor,
  type CrossProductCase,
  type PolicyInput,
} from '../../src/authz/index.js';

/**
 * SPEC-06 §8.2 — the named cases.
 *
 * Every row of §8.2's table is either implemented here, implemented at the HTTP
 * surface (`apps/api/test/authz/`), or listed in the final `describe` as **not
 * covered by this milestone** with the reason. Nothing is silently absent: the
 * last test enumerates A-01..A-23 and fails if a row is neither claimed here nor
 * declared deferred, so adding a case to the spec without covering it breaks the
 * build rather than the reader's trust.
 */

/** A case that ALLOWS, as the starting point for each named scenario. */
const ALLOWING_GROUP: CrossProductCase = {
  capabilityKey: 'membership.touch_self',
  scope: 'group',
  orgStatus: 'active',
  groupStatus: 'active',
  entitlement: 'active',
  window: 'within',
  dependencySatisfied: true,
  available: true,
  membershipStatus: 'active',
  membershipWindow: 'within',
  role: 'scheduler',
  organizationMembershipStatus: 'active',
  organizationRole: 'absent',
  grant: 'absent',
  ownership: 'absent',
  proxy: 'none',
  impersonation: 'none',
};

const ALLOWING_ORGANIZATION: CrossProductCase = {
  ...ALLOWING_GROUP,
  capabilityKey: 'organization.membership.touch_self',
  scope: 'organization',
  role: 'absent',
  organizationRole: 'org_admin',
};

function decide(patch: Partial<CrossProductCase>, base = ALLOWING_GROUP): ReturnType<typeof authorize> {
  return authorize(policyInputFor({ ...base, ...patch }));
}

function reasonOf(decision: ReturnType<typeof authorize>): string {
  return decision.allowed ? 'ALLOW' : decision.reason;
}

describe('SPEC-06 §8.2 named cases decided by the pure evaluator', () => {
  it('A-01 explicit deny + role allow → DENY (P-1)', () => {
    // The role DOES carry the capability here, so this is the precedence test
    // rather than a plain absence test.
    expect(decide({ role: 'scheduler', grant: 'absent' }).allowed).toBe(true);
    const decision = decide({ role: 'scheduler', grant: 'deny' });
    expect(reasonOf(decision)).toBe('EXPLICIT_DENY');
    if (!decision.allowed) expect(decision.step).toBe('L4.1');
  });

  it('A-02 explicit allow + unentitled module → DENY NOT_ENTITLED (P-2, P-3)', () => {
    const decision = decide({ role: 'member', grant: 'allow', entitlement: 'absent' });
    expect(reasonOf(decision)).toBe('NOT_ENTITLED');
    // P-3: entitlement is evaluated BEFORE permission, so the grant never runs.
    if (!decision.allowed) expect(decision.step).toBe('L1.1');
  });

  it('A-03 dependency unsatisfied, module entitled → MODULE_DEPENDENCY_UNSATISFIED', () => {
    // `membership.touch_self` is in `core_scheduling`, which has no dependencies,
    // so the case needs a module that does. `connectors.manage` depends on
    // `picklist`, which depends on `core_scheduling` — a two-level chain, which
    // is the case a one-level dependency check would get wrong.
    expect(moduleClosure('hospital_integration')).toEqual([
      'hospital_integration',
      'picklist',
      'core_scheduling',
    ]);
    const decision = decide({
      capabilityKey: 'connectors.manage',
      grant: 'allow',
      dependencySatisfied: false,
    });
    expect(reasonOf(decision)).toBe('MODULE_DEPENDENCY_UNSATISFIED');
  });

  it('A-04 suspended membership + valid grant → MEMBERSHIP_SUSPENDED', () => {
    const decision = decide({ membershipStatus: 'suspended', grant: 'allow' });
    expect(reasonOf(decision)).toBe('MEMBERSHIP_SUSPENDED');
    if (!decision.allowed) expect(decision.step).toBe('L3.2');
  });

  it('A-05 entitlement expires mid-session → the next evaluation is denied', () => {
    // "Mid-session" is not a state the pure evaluator can hold; what it can do
    // is answer differently for two instants against the SAME stored row. That
    // is the property the HTTP test then exercises for real.
    const within = policyInputFor({ ...ALLOWING_GROUP, window: 'within' });
    const after = policyInputFor({ ...ALLOWING_GROUP, window: 'after' });
    expect(authorize(within).allowed).toBe(true);
    expect(reasonOf(authorize(after))).toBe('ENTITLEMENT_EXPIRED');
  });

  it('A-10 proxy acts; grantor lacks the capability → PROXY_GRANTOR_DENIED', () => {
    const decision = decide({ proxy: 'grantor-denied' });
    expect(reasonOf(decision)).toBe('PROXY_GRANTOR_DENIED');
    if (!decision.allowed) expect(decision.step).toBe('L6.1');
  });

  it('A-11 impersonation reaching a credential surface → DENY', () => {
    const decision = decide({ impersonation: 'credential-surface' });
    expect(reasonOf(decision)).toBe('IMPERSONATION_FORBIDDEN_SURFACE');
    if (!decision.allowed) expect(decision.step).toBe('L6.2');
  });

  it('A-11b the intersection rule: the operator must hold it in their own right', () => {
    expect(reasonOf(decide({ impersonation: 'intersection-denied' }))).toBe(
      'IMPERSONATION_FORBIDDEN_SURFACE',
    );
    expect(decide({ impersonation: 'active' }).allowed).toBe(true);
  });

  it('A-16 no capability key is declared in both namespaces (P-10)', () => {
    expect(overlappingCapabilityKeys()).toEqual([]);
    expect(duplicateCapabilityKeys()).toEqual([]);
  });

  it('A-17 organization-scoped action, organization role carries it → ALLOW, L0.2/L2.1 skipped', () => {
    const input = policyInputFor(ALLOWING_ORGANIZATION);
    // The skipping is structural rather than conditional: there is no group in
    // the snapshot at all, and no availability row.
    expect(input.group).toBeNull();
    expect(input.availability).toBeNull();
    expect(authorize(input).allowed).toBe(true);
  });

  it('A-18 organization-scoped action, actor holds ONLY a group membership → NO_ORG_MEMBERSHIP (P-9)', () => {
    // The disjointness, made concrete: the group role's capability set is
    // handed to the evaluator and the organization membership is absent.
    const input: PolicyInput = {
      ...policyInputFor(ALLOWING_ORGANIZATION),
      organizationMembership: null,
      organizationRole: null,
      organizationRoleCapabilities: [],
      membership: {
        id: policyInputFor(ALLOWING_ORGANIZATION).context.membershipId,
        status: 'active',
        roleId: 'group_admin',
        validFrom: '2026-08-01T00:00:00.000Z',
        validTo: null,
      },
      role: { id: 'group_admin', isSystemRole: true },
      // Even a same-named capability in the group namespace must not satisfy it.
      roleCapabilities: ['organization.membership.touch_self'],
    };
    const decision = authorize(input);
    expect(reasonOf(decision)).toBe('NO_ORG_MEMBERSHIP');
    if (!decision.allowed) expect(decision.step).toBe('L3.1');
  });

  it('A-19 group-scoped action, actor holds ONLY an organization role → NO_MEMBERSHIP (P-8)', () => {
    const input: PolicyInput = {
      ...policyInputFor(ALLOWING_GROUP),
      membership: null,
      role: null,
      roleCapabilities: [],
      organizationMembership: {
        id: policyInputFor(ALLOWING_GROUP).context.membershipId,
        status: 'active',
        roleId: 'org_admin',
        validFrom: '2026-08-01T00:00:00.000Z',
        validTo: null,
      },
      organizationRole: { id: 'org_admin', isSystemRole: true },
      organizationRoleCapabilities: ['membership.touch_self', 'schedule.publish'],
    };
    const decision = authorize(input);
    expect(reasonOf(decision)).toBe('NO_MEMBERSHIP');
    if (!decision.allowed) expect(decision.step).toBe('L3.1');
  });

  it('A-20 organization membership suspended / expired / roleless → L3.2 / L3.3 / L3.1', () => {
    expect(
      reasonOf(decide({ organizationMembershipStatus: 'suspended' }, ALLOWING_ORGANIZATION)),
    ).toBe('MEMBERSHIP_SUSPENDED');
    expect(reasonOf(decide({ membershipWindow: 'expired' }, ALLOWING_ORGANIZATION))).toBe(
      'MEMBERSHIP_EXPIRED',
    );
    expect(reasonOf(decide({ organizationRole: 'absent' }, ALLOWING_ORGANIZATION))).toBe(
      'NO_ORG_MEMBERSHIP',
    );
  });

  it('P-4 backstop: an action key the catalogue does not know DENIES rather than throwing', () => {
    const input = policyInputFor(ALLOWING_GROUP);
    const decision = authorize({
      ...input,
      action: { ...input.action, key: 'invented.capability' },
    });
    expect(reasonOf(decision)).toBe('UNDECLARED_ACTION');
    expect(denialDisclosure('UNDECLARED_ACTION')).toBe('not-found');
  });

  it('P-4 backstop: a route whose declared scope disagrees with the catalogue DENIES', () => {
    const input = policyInputFor(ALLOWING_GROUP);
    const decision = authorize({
      ...input,
      action: { ...input.action, scope: 'organization' },
    });
    expect(reasonOf(decision)).toBe('UNDECLARED_ACTION');
  });

  it('P-4 backstop: a route naming the wrong module for its capability DENIES', () => {
    const input = policyInputFor(ALLOWING_GROUP);
    const decision = authorize({
      ...input,
      action: { ...input.action, moduleKey: 'picklist' },
    });
    expect(reasonOf(decision)).toBe('UNDECLARED_ACTION');
  });
});

describe('L5.1 — the object-policy branch an independent review found untested', () => {
  /**
   * **Both of L5.1's non-tenant-binding rules were unexecuted code.**
   *
   * `policyInputFor` never sets `ownershipOverrideCapability` or
   * `permittedTargetStates`, so a 39-million-case battery presented as exhaustive
   * touched neither. The review that noticed also found a defect inside the
   * untested branch: the override lookup ignored an in-window explicit DENY, so
   * revoking the override capability from someone whose ROLE also carried it
   * changed nothing — the revocation landed in `capability_grants`, looked
   * complete, and the holder kept the override's effect.
   *
   * These are the cases the generator cannot reach, written by hand.
   */
  const OWNED = 'ac000001-1111-4111-8111-000000000001';
  const OTHER = 'ac000002-1111-4111-8111-000000000002';

  function withOwnership(overrides: {
    readonly owner: string;
    readonly roleCapabilities?: readonly string[];
    readonly grants?: PolicyInput['grants'];
    readonly override?: string;
    readonly permittedTargetStates?: readonly string[];
    readonly targetState?: string | null;
  }): PolicyInput {
    const base = policyInputFor(ALLOWING_GROUP);
    return {
      ...base,
      roleCapabilities: overrides.roleCapabilities ?? ['membership.touch_self'],
      grants: overrides.grants ?? [],
      target: {
        organizationId: base.context.expectedOrganizationId,
        groupId: base.context.expectedGroupId,
        type: 'membership',
        ownerMembershipId: overrides.owner,
        state: overrides.targetState ?? null,
      },
      action: {
        ...base.action,
        requiresObjectPolicy: true,
        ownershipRequired: true,
        ...(overrides.override === undefined
          ? {}
          : { ownershipOverrideCapability: overrides.override }),
        ...(overrides.permittedTargetStates === undefined
          ? {}
          : { permittedTargetStates: overrides.permittedTargetStates }),
      },
    };
  }

  it('own object: ALLOW. someone else\'s, with no override declared: OBJECT_POLICY', () => {
    expect(authorize(withOwnership({ owner: OWNED })).allowed).toBe(true);
    expect(reasonOf(authorize(withOwnership({ owner: OTHER })))).toBe('OBJECT_POLICY');
  });

  it('an override carried by the ROLE lifts ownership', () => {
    const decision = authorize(
      withOwnership({
        owner: OTHER,
        override: 'documents.manage',
        roleCapabilities: ['membership.touch_self', 'documents.manage'],
      }),
    );
    expect(decision.allowed, 'the override did not lift ownership').toBe(true);
  });

  it('an override carried by an in-window GRANT lifts ownership', () => {
    const decision = authorize(
      withOwnership({
        owner: OTHER,
        override: 'documents.manage',
        grants: [
          {
            capabilityKey: 'documents.manage',
            granted: true,
            validFrom: '2026-08-01T00:00:00.000Z',
            validTo: null,
          },
        ],
      }),
    );
    expect(decision.allowed).toBe(true);
  });

  it('P-1 AT L5.1: an in-window explicit DENY of the override beats the role', () => {
    // The defect. The role carries the override; an administrator has explicitly
    // revoked it. Before the fix this ALLOWED.
    const decision = authorize(
      withOwnership({
        owner: OTHER,
        override: 'documents.manage',
        roleCapabilities: ['membership.touch_self', 'documents.manage'],
        grants: [
          {
            capabilityKey: 'documents.manage',
            granted: false,
            validFrom: '2026-08-01T00:00:00.000Z',
            validTo: null,
          },
        ],
      }),
    );
    expect(
      decision.allowed,
      'an explicitly revoked override still lifted ownership — P-1 is not absolute at L5.1',
    ).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('OBJECT_POLICY');
  });

  it('an OUT-OF-WINDOW override does not lift ownership', () => {
    const decision = authorize(
      withOwnership({
        owner: OTHER,
        override: 'documents.manage',
        grants: [
          {
            capabilityKey: 'documents.manage',
            granted: true,
            validFrom: '2020-01-01T00:00:00.000Z',
            validTo: '2021-01-01T00:00:00.000Z',
          },
        ],
      }),
    );
    expect(decision.allowed).toBe(false);
  });

  it('SPEC-06 §3.1 State: an action legal only in some target states', () => {
    // "publish requires `approved`; claim requires `posted`."
    expect(
      authorize(
        withOwnership({
          owner: OWNED,
          permittedTargetStates: ['approved'],
          targetState: 'approved',
        }),
      ).allowed,
    ).toBe(true);
    expect(
      reasonOf(
        authorize(
          withOwnership({
            owner: OWNED,
            permittedTargetStates: ['approved'],
            targetState: 'draft',
          }),
        ),
      ),
    ).toBe('OBJECT_POLICY');
    // A NULL state is not a wildcard.
    expect(
      reasonOf(
        authorize(
          withOwnership({ owner: OWNED, permittedTargetStates: ['approved'], targetState: null }),
        ),
      ),
    ).toBe('OBJECT_POLICY');
  });

  it('an action that requires an object policy but resolved no target DENIES', () => {
    const base = policyInputFor(ALLOWING_GROUP);
    const decision = authorize({
      ...base,
      target: null,
      action: { ...base.action, requiresObjectPolicy: true },
    });
    expect(reasonOf(decision)).toBe('OBJECT_POLICY');
  });
});

describe('L6.2 — a malformed instant fails CLOSED', () => {
  it('an unparseable `expiresAt` denies rather than reading as still valid', () => {
    // `Date.parse` yields NaN and `x >= NaN` is false, so the original spelling
    // treated a malformed expiry as live. Every other window comparison in the
    // evaluator is fail-closed; this one was the exception.
    const base = policyInputFor(ALLOWING_GROUP);
    const decision = authorize({
      ...base,
      impersonation: {
        operatorUserId: '00000000-0000-4000-8000-00000000000f',
        expiresAt: 'not-a-date',
        targetIsCredentialSurface: false,
        operatorHoldsCapability: true,
      },
    });
    expect(decision.allowed, 'a malformed impersonation expiry read as still valid').toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('IMPERSONATION_EXPIRED');
  });
});

describe('S-03 — an EXPLICIT DENY with an undecidable window still denies', () => {
  /**
   * **Dropping a deny is fail-OPEN, and the first version dropped it.**
   *
   * `inWindowGrants` filtered out any grant whose window could not be compared.
   * For the positive layer that is fail-closed and correct. Applied to a
   * `granted = false` row it **deletes the denial** and the actor keeps the
   * capability — and `timestamptz` accepts `infinity`, which node-postgres
   * returns as the JavaScript number `Infinity`, so the row shape is reachable
   * rather than hypothetical. The same class as L6.2's malformed `expiresAt`,
   * on the layer where it matters most. Found by an independent review.
   */
  const undecidable = ['not-a-date', 'infinity', '-infinity', ''] as const;

  function withGrant(grant: PolicyInput['grants'][number]): PolicyInput {
    const base = policyInputFor(ALLOWING_GROUP);
    return { ...base, grants: [grant] };
  }

  it.each(undecidable)('a DENY whose validFrom is %o still denies', (instant) => {
    const decision = authorize(
      withGrant({
        capabilityKey: 'membership.touch_self',
        granted: false,
        validFrom: instant,
        validTo: null,
      }),
    );
    expect(decision.allowed, 'an undecidable window deleted an explicit deny').toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('EXPLICIT_DENY');
  });

  it.each(undecidable)('a DENY whose validTo is %o still denies', (instant) => {
    const decision = authorize(
      withGrant({
        capabilityKey: 'membership.touch_self',
        granted: false,
        validFrom: '2026-08-01T00:00:00.000Z',
        validTo: instant,
      }),
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('EXPLICIT_DENY');
  });

  it('an ALLOW with an undecidable window does NOT authorize — the positive layer stays fail-closed', () => {
    const base = policyInputFor({ ...ALLOWING_GROUP, role: 'member' });
    const decision = authorize({
      ...base,
      grants: [
        {
          capabilityKey: 'membership.touch_self',
          granted: true,
          validFrom: 'not-a-date',
          validTo: null,
        },
      ],
    });
    expect(decision.allowed, 'an undecidable window authorized a request').toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('NO_CAPABILITY');
  });

  it('the same rule governs L5.1\'s ownership override', () => {
    const base = policyInputFor(ALLOWING_GROUP);
    const decision = authorize({
      ...base,
      roleCapabilities: ['membership.touch_self', 'documents.manage'],
      grants: [
        {
          capabilityKey: 'documents.manage',
          granted: false,
          validFrom: 'not-a-date',
          validTo: null,
        },
      ],
      target: {
        organizationId: base.context.expectedOrganizationId,
        groupId: base.context.expectedGroupId,
        type: 'membership',
        ownerMembershipId: 'ac000002-1111-4111-8111-000000000002',
        state: null,
      },
      action: {
        ...base.action,
        requiresObjectPolicy: true,
        ownershipRequired: true,
        ownershipOverrideCapability: 'documents.manage',
      },
    });
    expect(decision.allowed, 'an undecidable deny let the override through at L5.1').toBe(false);
  });

  it('a DECIDABLE, out-of-window deny does NOT deny — the fix is not "deny always"', () => {
    // A rule that treated every deny as in force would satisfy the tests above
    // and break every legitimately end-dated revocation.
    const decision = authorize(
      withGrant({
        capabilityKey: 'membership.touch_self',
        granted: false,
        validFrom: '2020-01-01T00:00:00.000Z',
        validTo: '2021-01-01T00:00:00.000Z',
      }),
    );
    expect(decision.allowed, 'an expired deny still denied').toBe(true);
  });
});

describe('S-07 — an inconsistent snapshot DENIES rather than allowing', () => {
  /**
   * Three ways to hand the evaluator a snapshot that is internally incoherent.
   * An independent review constructed all three and every one produced ALLOW,
   * which is the wrong direction for a layer whose job is to refuse.
   */
  it('an entitlement for a DIFFERENT module than the action denies', () => {
    const base = policyInputFor(ALLOWING_GROUP);
    const decision = authorize({
      ...base,
      entitlement: {
        moduleKey: 'picklist',
        state: 'active',
        effectiveFrom: '2020-01-01T00:00:00.000Z',
        effectiveTo: null,
      },
    });
    expect(decision.allowed, 'the snapshot was for another module and still allowed').toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('NOT_ENTITLED');
  });

  it('a DEPENDENCY row for the wrong module denies', () => {
    const base = policyInputFor({ ...ALLOWING_GROUP, capabilityKey: 'connectors.manage', grant: 'allow' });
    expect(base.moduleDependencies.length).toBeGreaterThan(0);
    const decision = authorize({
      ...base,
      moduleDependencies: base.moduleDependencies.map((dependency) => ({
        ...dependency,
        entitlement:
          dependency.entitlement === null
            ? null
            : { ...dependency.entitlement, moduleKey: 'marketplace' },
      })),
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('MODULE_DEPENDENCY_UNSATISFIED');
  });

  it('a role that is not the one the membership names denies', () => {
    const base = policyInputFor(ALLOWING_GROUP);
    const decision = authorize({
      ...base,
      // The membership says `scheduler`; the snapshot pairs it with a role
      // object for `group_admin` and that role's capability set.
      role: { id: 'group_admin', isSystemRole: true },
      roleCapabilities: ['membership.touch_self', 'documents.manage'],
    });
    expect(decision.allowed, 'a mismatched role/membership pair allowed').toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('NO_MEMBERSHIP');
  });

  it('a role supplied for a membership carrying none denies', () => {
    const base = policyInputFor({ ...ALLOWING_GROUP, role: 'absent' });
    const decision = authorize({
      ...base,
      role: { id: 'scheduler', isSystemRole: true },
      roleCapabilities: ['membership.touch_self'],
    });
    expect(decision.allowed).toBe(false);
  });

  it('the CONSISTENT snapshot still allows — these are not blanket refusals', () => {
    expect(authorize(policyInputFor(ALLOWING_GROUP)).allowed).toBe(true);
  });
});

describe('S-13 — PROXY_MEMBERSHIP is unreachable, and that is asserted', () => {
  it('no proxy configuration produces it', () => {
    // Reaching L6.1 means L3.2 and L3.3 passed for the acting membership, which
    // IS the proxy. The reason survives in the union because SPEC-06 §3.2 names
    // it; the evaluator has no branch for it, and a dead branch that reads as a
    // control is worse than no branch.
    for (const proxy of ['none', 'valid', 'expired', 'notifications-only', 'grantor-denied'] as const) {
      for (const membershipStatus of ['active', 'suspended', 'ended', 'invited'] as const) {
        const decision = authorize(policyInputFor({ ...ALLOWING_GROUP, proxy, membershipStatus }));
        if (!decision.allowed) expect(decision.reason).not.toBe('PROXY_MEMBERSHIP');
      }
    }
  });

  it('its disclosure mapping is still defined, because the reason still exists', () => {
    expect(denialDisclosure('PROXY_MEMBERSHIP')).toBe('forbidden');
  });
});

describe('P-5 / P-6 — the 404-vs-403 discipline', () => {
  it('every L0, L1, L2 denial is 404 (P-5)', () => {
    for (const reason of [
      'ORG_INACTIVE',
      'GROUP_INACTIVE',
      'NOT_ENTITLED',
      'ENTITLEMENT_SUSPENDED',
      'ENTITLEMENT_REVOKED',
      'ENTITLEMENT_EXPIRED',
      'MODULE_DEPENDENCY_UNSATISFIED',
      'MODULE_UNAVAILABLE_IN_GROUP',
    ] as const) {
      expect(denialDisclosure(reason), reason).toBe('not-found');
    }
  });

  it('every L3 denial is 404 — a non-member learns nothing (SPEC-01 §2.4)', () => {
    for (const reason of [
      'NO_MEMBERSHIP',
      'NO_ORG_MEMBERSHIP',
      'MEMBERSHIP_INVITED',
      'MEMBERSHIP_SUSPENDED',
      'MEMBERSHIP_ENDED',
      'MEMBERSHIP_EXPIRED',
    ] as const) {
      expect(denialDisclosure(reason), reason).toBe('not-found');
    }
  });

  it('L4 and L6 denials are 403 — the actor already knows the tenant exists', () => {
    for (const reason of [
      'EXPLICIT_DENY',
      'NO_CAPABILITY',
      'PROXY_INVALID',
      'PROXY_SCOPE',
      'PROXY_GRANTOR_DENIED',
      'PROXY_MEMBERSHIP',
      'IMPERSONATION_EXPIRED',
      'IMPERSONATION_FORBIDDEN_SURFACE',
    ] as const) {
      expect(denialDisclosure(reason), reason).toBe('forbidden');
    }
  });

  it('L5.1 defaults to 404 so a caller that forgets `bindTarget` discloses nothing', () => {
    expect(denialDisclosure('OBJECT_POLICY')).toBe('not-found');
  });

  it('`passedCapabilityLayer` is true exactly when L4 was cleared — SPEC-01 §2.3 step 6', () => {
    expect(passedCapabilityLayer(authorize(policyInputFor(ALLOWING_GROUP)))).toBe(true);
    // Denied at L4.2: the actor did NOT pass the capability layer, so step 6
    // answers 404 rather than 409.
    expect(passedCapabilityLayer(decide({ role: 'member' }))).toBe(false);
    // Denied at L5.1: the capability layer WAS passed, so 409 is available.
    expect(passedCapabilityLayer(decide({ ownership: 'other' }))).toBe(true);
  });

  it('`authorizeWithoutObjectPolicy` allows exactly where L5.1 was the only failure', () => {
    const input = policyInputFor({ ...ALLOWING_GROUP, ownership: 'other' });
    expect(authorize(input).allowed).toBe(false);
    expect(authorizeWithoutObjectPolicy(input).allowed).toBe(true);
    // And it does NOT rescue a denial from any earlier layer.
    const unentitled = policyInputFor({ ...ALLOWING_GROUP, ownership: 'other', entitlement: 'absent' });
    expect(authorizeWithoutObjectPolicy(unentitled).allowed).toBe(false);
  });
});

describe('the catalogue', () => {
  it('every capability names a module that exists', () => {
    for (const capability of CAPABILITIES) {
      expect(MODULE_KEYS, capability.key).toContain(capability.module);
    }
  });

  it('no module depends on itself, directly or transitively', () => {
    expect(moduleDependencyCycles()).toEqual([]);
  });

  it('`moduleClosure` is transitive, not one level', () => {
    expect([...moduleClosure('hospital_integration')].sort()).toEqual([
      'core_scheduling',
      'hospital_integration',
      'picklist',
    ]);
    expect(moduleClosure('core_scheduling')).toEqual(['core_scheduling']);
  });

  it('every capability has a description a reviewer can read', () => {
    for (const capability of CAPABILITIES) {
      expect(capability.description.length, capability.key).toBeGreaterThan(30);
    }
    expect(capabilityDefinition('membership.touch_self')?.scope).toBe('group');
    expect(capabilityDefinition('nope')).toBeUndefined();
  });
});

describe('SPEC-06 §8.2 coverage ledger', () => {
  /**
   * Every row of §8.2, and where it is discharged.
   *
   * `deferred` rows carry the reason and the milestone that owns them. The test
   * asserts the ledger is COMPLETE — A-01 through A-23 with no gaps — so a row
   * that is neither covered nor consciously deferred cannot exist.
   */
  const LEDGER: Readonly<Record<string, string>> = {
    'A-01': 'here — explicit deny + role allow',
    'A-02': 'here — explicit allow + unentitled module',
    'A-03': 'here — two-level dependency chain',
    'A-04': 'here — suspended membership + valid grant',
    'A-05': 'here (two instants) and apps/api/test/authz/http-authorization.test.ts (mid-session)',
    'A-06': 'DEFERRED — no WebSocket surface exists (SPEC-01 §5 / SPEC-02 milestone)',
    'A-07':
      'DEFERRED (partial) — the job surface re-authorizes, but on OPUS-M1-001\'s role allow-list; ' +
      'apps/api/src/jobs/** is OPUS-M1-003\'s file scope. See EV-M1-AUTHZ §5 escalation 1',
    'A-08': 'DEFERRED — no report or artifact surface exists (SPEC-09 milestone)',
    'A-09': 'apps/api/test/authz/http-authorization.test.ts — disable, deny, re-enable, data intact',
    'A-10': 'here — PROXY_GRANTOR_DENIED',
    'A-11': 'here — credential surface, and the intersection rule',
    'A-12': 'apps/api/test/authz/schema.test.ts — the EXCLUDE constraint rejects the overlap',
    'A-13': 'DEFERRED — nothing caches an authorization decision in this milestone (see EV-M1-AUTHZ §5)',
    'A-14': 'apps/api/test/http/route-declarations.test.ts — `routeActionProblems` over the registered table',
    'A-15': 'packages/domain/test/authz/cross-product.test.ts — allow/deny pair per capability',
    'A-16': 'here — overlapping and duplicate capability keys',
    'A-17': 'here — organization role satisfies an organization-scoped action',
    'A-18': 'here — P-9: a group role never satisfies an organization-scoped action',
    'A-19': 'here — P-8: an organization role never reaches into a group',
    'A-20': 'here — organization membership suspended / expired / roleless',
    'A-21': 'DEFERRED — picklist fan-out does not exist (SPEC-02 milestone)',
    'A-22': 'DEFERRED — picklist fan-out does not exist (SPEC-02 milestone)',
    'A-23': 'DEFERRED — picklist fan-out does not exist (SPEC-02 milestone)',
  };

  it('the ledger covers A-01..A-23 with no gaps', () => {
    const expected = Array.from({ length: 23 }, (_, i) => `A-${String(i + 1).padStart(2, '0')}`);
    expect(Object.keys(LEDGER).sort()).toEqual(expected);
    for (const [id, where] of Object.entries(LEDGER)) {
      expect(where.length, `${id} has no recorded home`).toBeGreaterThan(10);
    }
  });

  it('prints the ledger, so the evidence bundle can quote it verbatim', () => {
    for (const [id, where] of Object.entries(LEDGER)) console.log(`      · ${id}: ${where}`);
    const deferred = Object.entries(LEDGER).filter(([, where]) => where.startsWith('DEFERRED'));
    console.log(`      · ${String(deferred.length)} of 23 deferred, each with a named reason`);
    expect(deferred.length).toBeLessThanOrEqual(7);
  });
});
