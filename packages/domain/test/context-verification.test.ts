import { describe, expect, it } from 'vitest';

import {
  isTenantChange,
  authorizationVersionOf,
  bindTarget,
  contextVersionsMatch,
  membershipIsActive,
  readBackMismatches,
  tenantSettingValues,
  verifyDeclaredContext,
  type ContextSnapshot,
  type DeclaredContext,
  type MembershipSnapshot,
  type RequestContext,
} from '../src/index.js';

/**
 * The SPEC-01 §2.3 validation sequence and §3 target binding, as **pure
 * functions**.
 *
 * These run with no database, no server and no fixtures, which is what lets
 * every branch be enumerated rather than sampled. The HTTP suite in
 * `apps/api/test/http/context-surface.test.ts` proves the same sequence through
 * the real middleware against the real schema; this proves the decision table
 * itself, including the branches that are hard to reach over the wire.
 *
 * There is exactly one implementation of the sequence, and both suites call it.
 * SPEC-06 §7: "a surface with its own authorization logic is a defect".
 */

const NOW = '2026-08-02T12:00:00.000Z';
const ORGANIZATION = '11111111-1111-4111-8111-111111111111';
const GROUP = '1a1a1a1a-1111-4111-8111-a1a1a1a1a1a1';
const OTHER_GROUP = '1b1b1b1b-1111-4111-8111-b1b1b1b1b1b1';
const USER = 'a0000001-1111-4111-8111-000000000001';
const GROUP_MEMBERSHIP = 'ac000001-1111-4111-8111-000000000001';
const ORGANIZATION_MEMBERSHIP = 'ac000004-1111-4111-8111-000000000004';

const groupMembership: MembershipSnapshot = {
  id: GROUP_MEMBERSHIP,
  kind: 'group',
  organizationId: ORGANIZATION,
  groupId: GROUP,
  userId: USER,
  status: 'active',
  organizationRole: null,
  groupRole: 'scheduler',
  validFrom: '2026-01-01T00:00:00.000Z',
  validTo: null,
};

const organizationMembership: MembershipSnapshot = {
  id: ORGANIZATION_MEMBERSHIP,
  kind: 'organization',
  organizationId: ORGANIZATION,
  groupId: null,
  userId: USER,
  status: 'active',
  organizationRole: 'org_admin',
  groupRole: null,
  validFrom: '2026-01-01T00:00:00.000Z',
  validTo: null,
};

function snapshot(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    organization: { id: ORGANIZATION, status: 'active', organizationVersion: 7 },
    group: { id: GROUP, organizationId: ORGANIZATION, status: 'active', groupVersion: 3 },
    membership: groupMembership,
    principal: { id: USER, status: 'active', membershipSetVersion: 11, sessionEpoch: 2 },
    now: NOW,
    ...overrides,
  };
}

function declared(overrides: Partial<DeclaredContext> = {}): DeclaredContext {
  return {
    principalUserId: USER,
    actionScope: 'group',
    expectedOrganizationId: ORGANIZATION,
    expectedGroupId: GROUP,
    contextVersion: { organizationVersion: 7, groupVersion: 3, membershipSetVersion: 11 },
    sessionEpoch: 2,
    correlationId: 'corr-0001',
    onBehalfOfMembershipId: null,
    ...overrides,
  };
}

describe('SPEC-01 §2.3 — the happy path', () => {
  it('produces the immutable tuple, with the membership derived server-side', () => {
    const result = verifyDeclaredContext(declared(), snapshot());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.context.membershipId).toBe(GROUP_MEMBERSHIP);
    expect(result.context.expectedGroupId).toBe(GROUP);
    expect(result.context.actionScope).toBe('group');
    expect(result.context.sessionEpoch).toBe(2);
    expect(result.context.authorizationVersion).toBe('av1:7.3.11.2');
  });

  it('the organization branch resolves the ORGANIZATION membership', () => {
    const result = verifyDeclaredContext(
      declared({ actionScope: 'organization', expectedGroupId: null, contextVersion: {
        organizationVersion: 7,
        groupVersion: null,
        membershipSetVersion: 11,
      } }),
      snapshot({ membership: organizationMembership, group: null }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.membershipId).toBe(ORGANIZATION_MEMBERSHIP);
    expect(result.context.expectedGroupId).toBeNull();
    expect(result.context.authorizationVersion).toBe('av1:7.-.11.2');
  });
});

describe('SPEC-01 §2.3 steps 1–3 — every failure is 404 and nothing else', () => {
  const cases: readonly {
    name: string;
    step: number;
    declared?: Partial<DeclaredContext>;
    snapshot?: Partial<ContextSnapshot>;
    securityEvent?: boolean;
  }[] = [
    { name: 'organization does not resolve', step: 1, snapshot: { organization: null }, securityEvent: true },
    {
      name: 'organization is inactive',
      step: 1,
      snapshot: { organization: { id: ORGANIZATION, status: 'inactive', organizationVersion: 7 } },
    },
    { name: 'no membership at all', step: 2, snapshot: { membership: null }, securityEvent: true },
    {
      name: 'membership is suspended',
      step: 2,
      snapshot: { membership: { ...groupMembership, status: 'suspended' } },
    },
    {
      name: 'membership is ended (a departed member)',
      step: 2,
      snapshot: { membership: { ...groupMembership, status: 'ended' } },
    },
    {
      name: 'membership window has closed',
      step: 2,
      snapshot: {
        membership: { ...groupMembership, validTo: '2026-07-01T00:00:00.000Z' },
      },
    },
    {
      name: 'membership window has not opened',
      step: 2,
      snapshot: {
        membership: { ...groupMembership, validFrom: '2026-09-01T00:00:00.000Z' },
      },
    },
    {
      name: 'membership belongs to a different principal',
      step: 2,
      snapshot: { membership: { ...groupMembership, userId: 'a0000009-1111-4111-8111-000000000009' } },
    },
    {
      name: 'an ORGANIZATION membership offered for a group-scoped action (P-8)',
      step: 2,
      snapshot: { membership: organizationMembership },
    },
    {
      name: 'group membership is in a different group',
      step: 2,
      snapshot: { membership: { ...groupMembership, groupId: OTHER_GROUP } },
    },
    {
      name: 'group-scoped action declaring no group (T-06d)',
      step: 2,
      declared: { expectedGroupId: null },
    },
    { name: 'group does not resolve', step: 3, snapshot: { group: null }, securityEvent: true },
    {
      name: 'group belongs to a different organization',
      step: 3,
      snapshot: {
        group: {
          id: GROUP,
          organizationId: '22222222-2222-4222-8222-222222222222',
          status: 'active',
          groupVersion: 3,
        },
      },
    },
    {
      name: 'group is inactive',
      step: 3,
      snapshot: { group: { id: GROUP, organizationId: ORGANIZATION, status: 'inactive', groupVersion: 3 } },
    },
    { name: 'principal is not visible', step: 2, snapshot: { principal: null } },
    {
      name: 'principal is deactivated',
      step: 2,
      snapshot: { principal: { id: USER, status: 'deactivated', membershipSetVersion: 11, sessionEpoch: 2 } },
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} -> NOT_FOUND`, () => {
      const result = verifyDeclaredContext(
        declared(testCase.declared ?? {}),
        snapshot(testCase.snapshot ?? {}),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.code, testCase.name).toBe('NOT_FOUND');
      if (testCase.securityEvent === true) expect(result.failure.securityEvent).toBe(true);
    });
  }

  it('T-06c a GROUP membership never satisfies an organization-scoped action (P-9)', () => {
    const result = verifyDeclaredContext(
      declared({
        actionScope: 'organization',
        expectedGroupId: null,
        contextVersion: { organizationVersion: 7, groupVersion: null, membershipSetVersion: 11 },
      }),
      snapshot({ membership: groupMembership, group: null }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_FOUND');
    expect(result.failure.reason).toMatch(/P-9/);
  });

  it('an organization-scoped action that declares a group is rejected at step 3', () => {
    const result = verifyDeclaredContext(
      declared({
        actionScope: 'organization',
        expectedGroupId: GROUP,
        contextVersion: { organizationVersion: 7, groupVersion: null, membershipSetVersion: 11 },
      }),
      snapshot({ membership: organizationMembership }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.step).toBe(3);
  });
});

describe('SPEC-01 §2.3 steps 4–5 — freshness is a separate, recoverable answer', () => {
  it('a mismatched organization_version is CONTEXT_STALE', () => {
    const result = verifyDeclaredContext(
      declared({ contextVersion: { organizationVersion: 6, groupVersion: 3, membershipSetVersion: 11 } }),
      snapshot(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('CONTEXT_STALE');
  });

  it('a mismatched group_version is CONTEXT_STALE', () => {
    const result = verifyDeclaredContext(
      declared({ contextVersion: { organizationVersion: 7, groupVersion: 2, membershipSetVersion: 11 } }),
      snapshot(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('CONTEXT_STALE');
  });

  it('a mismatched membership_set_version is CONTEXT_STALE', () => {
    const result = verifyDeclaredContext(
      declared({ contextVersion: { organizationVersion: 7, groupVersion: 3, membershipSetVersion: 10 } }),
      snapshot(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('CONTEXT_STALE');
  });

  it('NO declared version is stale, not exempt', () => {
    // §2.2: "The path segment is not sufficient on its own." A client that omits
    // the freshness declaration has not proven freshness, and the answer is the
    // same one a stale client gets.
    const result = verifyDeclaredContext(declared({ contextVersion: null }), snapshot());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('CONTEXT_STALE');
  });

  it('a mismatched session_epoch is SESSION_STALE, distinctly', () => {
    const result = verifyDeclaredContext(declared({ sessionEpoch: 1 }), snapshot());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('SESSION_STALE');
  });

  it('freshness is only reached AFTER membership — a departed member never sees 409', () => {
    // The ordering that makes §2.4 hold: "a departed member receives 404 and
    // learns nothing". Both the membership and the version are wrong here, and
    // the answer must be the one that discloses less.
    const result = verifyDeclaredContext(
      declared({ contextVersion: { organizationVersion: 1, groupVersion: 1, membershipSetVersion: 1 } }),
      snapshot({ membership: { ...groupMembership, status: 'ended' } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('NOT_FOUND');
      expect(result.failure.step).toBe(2);
    }
  });
});

describe('SPEC-01 §3 / §2.3 step 6 — target binding and the V-07 disclosure rule', () => {
  const context: RequestContext = {
    principalUserId: USER,
    actionScope: 'group',
    expectedOrganizationId: ORGANIZATION,
    expectedGroupId: GROUP,
    membershipId: GROUP_MEMBERSHIP,
    contextVersion: { organizationVersion: 7, groupVersion: 3, membershipSetVersion: 11 },
    sessionEpoch: 2,
    authorizationVersion: 'av1:7.3.11.2',
    correlationId: 'corr-0001',
    onBehalfOfMembershipId: null,
  };

  it('a target in the declared tenant binds', () => {
    const result = bindTarget(
      context,
      { organizationId: ORGANIZATION, groupId: GROUP, aggregateType: 'membership' },
      'membership',
      true,
    );
    expect(result.ok).toBe(true);
  });

  it('T-05 sibling group + AUTHORIZED -> CONTEXT_TARGET_MISMATCH', () => {
    const result = bindTarget(
      context,
      { organizationId: ORGANIZATION, groupId: OTHER_GROUP, aggregateType: 'membership' },
      'membership',
      true,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('CONTEXT_TARGET_MISMATCH');
      expect(result.failure.securityEvent).toBe(false);
    }
  });

  it('T-05b sibling group + NOT authorized -> NOT_FOUND, and a security event', () => {
    const result = bindTarget(
      context,
      { organizationId: ORGANIZATION, groupId: OTHER_GROUP, aggregateType: 'membership' },
      'membership',
      false,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('NOT_FOUND');
      expect(result.failure.securityEvent).toBe(true);
    }
  });

  it('a target that does not resolve is NOT_FOUND whatever the actor holds', () => {
    for (const authorized of [true, false]) {
      const result = bindTarget(context, null, 'membership', authorized);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.code).toBe('NOT_FOUND');
    }
  });

  it('the wrong aggregate type is a mismatch, not a silent accept', () => {
    const result = bindTarget(
      context,
      { organizationId: ORGANIZATION, groupId: GROUP, aggregateType: 'schedule_version' },
      'membership',
      true,
    );
    expect(result.ok).toBe(false);
  });

  it('an organization-scoped context does not compare the group', () => {
    const organizationScoped: RequestContext = {
      ...context,
      actionScope: 'organization',
      expectedGroupId: null,
    };
    const result = bindTarget(
      organizationScoped,
      { organizationId: ORGANIZATION, groupId: OTHER_GROUP, aggregateType: 'membership' },
      'membership',
      true,
    );
    expect(result.ok).toBe(true);
  });
});

describe('the unit-of-work read-back comparison', () => {
  const context = {
    organizationId: ORGANIZATION,
    groupId: GROUP,
    membershipId: GROUP_MEMBERSHIP,
    correlationId: 'corr-0001',
  };

  it('a null group and a null membership are the empty string on the wire', () => {
    const values = tenantSettingValues({ ...context, groupId: null, membershipId: null });
    expect(values['app.group_id']).toBe('');
    expect(values['app.membership_id']).toBe('');
  });

  it('an exact read-back reports no mismatch', () => {
    expect(readBackMismatches(context, tenantSettingValues(context))).toEqual([]);
  });

  it('T-14b a lost app.group_id is reported — a single-setting read-back would not see it', () => {
    const observed = { ...tenantSettingValues(context), 'app.group_id': '' as string | null };
    const mismatches = readBackMismatches(context, observed);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.setting).toBe('app.group_id');
  });

  it('every one of the four settings is compared', () => {
    const observed = {
      'app.organization_id': null,
      'app.group_id': null,
      'app.membership_id': null,
      'app.correlation_id': null,
    };
    expect(readBackMismatches(context, observed)).toHaveLength(4);
  });
});

describe('supporting pure functions', () => {
  it('authorizationVersionOf distinguishes every input', () => {
    const seen = new Set<string>();
    for (const organizationVersion of [1, 2]) {
      for (const groupVersion of [null, 1, 2]) {
        for (const membershipSetVersion of [1, 2]) {
          for (const sessionEpoch of [1, 2]) {
            seen.add(
              authorizationVersionOf(
                { organizationVersion, groupVersion, membershipSetVersion },
                sessionEpoch,
              ),
            );
          }
        }
      }
    }
    expect(seen.size).toBe(2 * 3 * 2 * 2);
  });

  it('contextVersionsMatch treats a null group version as distinct from a numeric one', () => {
    expect(
      contextVersionsMatch(
        { organizationVersion: 1, groupVersion: null, membershipSetVersion: 1 },
        { organizationVersion: 1, groupVersion: 0, membershipSetVersion: 1 },
      ),
    ).toBe(false);
  });

  it('membershipIsActive implements SPEC-06 L3.2 and L3.3', () => {
    expect(membershipIsActive(groupMembership, NOW)).toBe(true);
    expect(membershipIsActive({ ...groupMembership, status: 'invited' }, NOW)).toBe(false);
    // The window is half-open: [valid_from, valid_to).
    expect(membershipIsActive({ ...groupMembership, validTo: NOW }, NOW)).toBe(false);
    expect(membershipIsActive({ ...groupMembership, validFrom: NOW }, NOW)).toBe(true);
  });
});

describe('R-15 — a nested unit of work may not change tenant OR actor', () => {
  const outer = {
    organizationId: ORGANIZATION,
    groupId: GROUP,
    membershipId: GROUP_MEMBERSHIP,
    correlationId: 'corr-0001',
  };

  it('the same tuple is not a change', () => {
    expect(isTenantChange(outer, { ...outer })).toBe(false);
    // A different correlation id is not a re-tenanting; it is the same actor in
    // the same tenant, and the outer correlation id wins.
    expect(isTenantChange(outer, { ...outer, correlationId: 'corr-0002' })).toBe(false);
  });

  it('a different organization or group is a change', () => {
    expect(
      isTenantChange(outer, { ...outer, organizationId: '22222222-2222-4222-8222-222222222222' }),
    ).toBe(true);
    expect(isTenantChange(outer, { ...outer, groupId: OTHER_GROUP })).toBe(true);
    expect(isTenantChange(outer, { ...outer, groupId: null })).toBe(true);
  });

  it('a different NON-NULL acting membership is a change — attribution integrity', () => {
    // `app.membership_id` is established once per transaction and is what the
    // audit chain will attribute every row in it to (ADR-0019, OPUS-M1-003). A
    // nested call declaring a different membership would run under the OUTER
    // membership's setting while the caller believed it had switched actors —
    // the audit row would name the wrong person, convincingly. A savepoint
    // cannot carry its own setting, so refusing is the only honest option.
    expect(
      isTenantChange(outer, { ...outer, membershipId: ORGANIZATION_MEMBERSHIP }),
    ).toBe(true);
  });

  it('a NULL inner membership is NOT a change — it means "no actor of my own"', () => {
    // How the system-actor and context-resolution paths declare themselves.
    // Inheriting the outer attribution is correct for them.
    expect(isTenantChange(outer, { ...outer, membershipId: null })).toBe(false);
  });

  it('an outer with no actor and an inner that names one is still a change', () => {
    const anonymousOuter = { ...outer, membershipId: null };
    expect(isTenantChange(anonymousOuter, { ...outer, membershipId: GROUP_MEMBERSHIP })).toBe(true);
  });
});
