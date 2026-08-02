import type { TenantContext } from '@schedulepoint/domain';

import type { PgUnitOfWorkRunner } from '../../src/db/unit-of-work.js';

/**
 * The MULTI fixture: **two organizations, two groups each, synthetic throughout.**
 *
 * Two organizations rather than one because a single-tenant fixture cannot fail
 * a cross-tenant assertion — every probe would report "0 wrong rows" for the
 * boring reason. Two groups per organization because CAR-001 is a *cross-group,
 * same-organization* defect, and an organization-only fixture cannot detect it
 * either.
 *
 * ## Synthetic data, and what that means here
 *
 * No real organization, site, or person name appears — not from the research
 * corpus, not from anywhere. Organizations are "Organization Alpha/Beta
 * (synthetic)"; people are role-descriptive labels; every email is at
 * `example.invalid`, the RFC 2606 reserved TLD that **cannot** resolve, so no
 * test can reach a real destination even by accident.
 *
 * ## Everything is seeded THROUGH the unit of work
 *
 * Not with a superuser, not with RLS disabled. If the wrapper did not work, the
 * fixture would not exist and every test in the suite would fail loudly on its
 * first assertion — which is a far better failure than a green suite built on a
 * fixture that bypassed the thing under test.
 */

export const FIXTURE = {
  alpha: {
    organizationId: '11111111-1111-4111-8111-111111111111',
    name: 'Organization Alpha (synthetic)',
    groupOne: {
      id: '1a1a1a1a-1111-4111-8111-a1a1a1a1a1a1',
      name: 'Alpha Group One',
    },
    groupTwo: {
      id: '1b1b1b1b-1111-4111-8111-b1b1b1b1b1b1',
      name: 'Alpha Group Two',
    },
    users: {
      /**
       * Role `scheduler` in **BOTH** Alpha groups — authorized for the probe
       * capability in each.
       *
       * One principal holding two group memberships is what makes T-01 a real
       * test. With one principal per group, a server that kept a session-global
       * "active group" would still route each request to the only group that
       * principal had, and the test would pass while the CAR-001 defect was
       * present. With ONE principal and TWO declared contexts, a session-global
       * implementation must retarget one of them — and T-01 checks both
       * directions of that.
       *
       * The research corpus's "a person may hold different roles in different
       * groups" is the same shape, so the fixture is also the realistic one.
       */
      scheduler: {
        id: 'a0000001-1111-4111-8111-000000000001',
        email: 'alpha-scheduler@example.invalid',
        displayName: 'Alpha Scheduler (synthetic)',
        membershipId: 'ac000001-1111-4111-8111-000000000001',
        groupTwoMembershipId: 'ac00000a-1111-4111-8111-00000000000a',
      },
      /** Group One, role `member` — NOT authorized. T-05b's actor. */
      member: {
        id: 'a0000002-1111-4111-8111-000000000002',
        email: 'alpha-member@example.invalid',
        displayName: 'Alpha Member (synthetic)',
        membershipId: 'ac000002-1111-4111-8111-000000000002',
      },
      /** Group TWO, role `scheduler` — owns the cross-group target for T-05. */
      groupTwoScheduler: {
        id: 'a0000003-1111-4111-8111-000000000003',
        email: 'alpha-group-two-scheduler@example.invalid',
        displayName: 'Alpha Group Two Scheduler (synthetic)',
        membershipId: 'ac000003-1111-4111-8111-000000000003',
      },
      /** ORGANIZATION membership, role `org_admin`. T-06b's actor. */
      organizationAdmin: {
        id: 'a0000004-1111-4111-8111-000000000004',
        email: 'alpha-org-admin@example.invalid',
        displayName: 'Alpha Organization Admin (synthetic)',
        membershipId: 'ac000004-1111-4111-8111-000000000004',
      },
      /** Group One only, no organization membership. T-06c's actor. */
      groupOnly: {
        id: 'a0000005-1111-4111-8111-000000000005',
        email: 'alpha-group-only@example.invalid',
        displayName: 'Alpha Group Only (synthetic)',
        membershipId: 'ac000005-1111-4111-8111-000000000005',
      },
      /** Group One, membership `ended`. T-02's actor: a departed member. */
      departed: {
        id: 'a0000006-1111-4111-8111-000000000006',
        email: 'alpha-departed@example.invalid',
        displayName: 'Alpha Departed (synthetic)',
        membershipId: 'ac000006-1111-4111-8111-000000000006',
      },
    },
  },
  beta: {
    organizationId: '22222222-2222-4222-8222-222222222222',
    name: 'Organization Beta (synthetic)',
    groupOne: {
      id: '2a2a2a2a-2222-4222-8222-a2a2a2a2a2a2',
      name: 'Beta Group One',
    },
    groupTwo: {
      id: '2b2b2b2b-2222-4222-8222-b2b2b2b2b2b2',
      name: 'Beta Group Two',
    },
    users: {
      scheduler: {
        id: 'b0000001-2222-4222-8222-000000000001',
        email: 'beta-scheduler@example.invalid',
        displayName: 'Beta Scheduler (synthetic)',
        membershipId: 'bc000001-2222-4222-8222-000000000001',
      },
      organizationAdmin: {
        id: 'b0000004-2222-4222-8222-000000000004',
        email: 'beta-org-admin@example.invalid',
        displayName: 'Beta Organization Admin (synthetic)',
        membershipId: 'bc000004-2222-4222-8222-000000000004',
      },
    },
  },
} as const;

/** A UUID that belongs to nothing. Used for forged-id and non-existent-id probes. */
export const NONEXISTENT_ID = '00000000-0000-4000-8000-000000000000';

export function organizationContext(
  organizationId: string,
  correlationId = 'fixture-organization-seed',
): TenantContext {
  return { organizationId, groupId: null, membershipId: null, correlationId };
}

export function groupContext(
  organizationId: string,
  groupId: string,
  membershipId: string | null = null,
  correlationId = 'fixture-group-seed',
): TenantContext {
  return { organizationId, groupId, membershipId, correlationId };
}

/** The four legitimate (organization, group) partitions. Ground truth for the census. */
export const VALID_PARTITIONS: ReadonlySet<string> = new Set([
  `${FIXTURE.alpha.organizationId}|${FIXTURE.alpha.groupOne.id}`,
  `${FIXTURE.alpha.organizationId}|${FIXTURE.alpha.groupTwo.id}`,
  `${FIXTURE.beta.organizationId}|${FIXTURE.beta.groupOne.id}`,
  `${FIXTURE.beta.organizationId}|${FIXTURE.beta.groupTwo.id}`,
]);

export const VALID_ORGANIZATIONS: ReadonlySet<string> = new Set([
  FIXTURE.alpha.organizationId,
  FIXTURE.beta.organizationId,
]);

interface SeedGroupMembership {
  readonly membershipId: string;
  readonly userId: string;
  readonly groupId: string;
  readonly role: string;
  readonly status?: 'invited' | 'active' | 'suspended' | 'ended';
}

async function seedOrganization(
  runner: PgUnitOfWorkRunner,
  organization: {
    id: string;
    name: string;
    groups: readonly { id: string; name: string }[];
    users: readonly { id: string; email: string; displayName: string }[];
    organizationMemberships: readonly { membershipId: string; userId: string; role: string }[];
    groupMemberships: readonly SeedGroupMembership[];
  },
): Promise<void> {
  // ── organization-scoped unit of work ──────────────────────────────────────
  //
  // organizations, groups, users and ORGANIZATION memberships. Every one of
  // these writes is admitted by a `WITH CHECK` that requires the declared
  // organization to match, so a mis-declared seed would be rejected rather than
  // landing in the wrong tenant.
  await runner.run(organizationContext(organization.id), async ({ query }) => {
    await query
      .insertInto('organizations')
      .values({ id: organization.id, name: organization.name })
      .execute();

    await query
      .insertInto('groups')
      .values(
        organization.groups.map((group) => ({
          id: group.id,
          organization_id: organization.id,
          name: group.name,
        })),
      )
      .execute();

    await query
      .insertInto('users')
      .values(
        organization.users.map((user) => ({
          id: user.id,
          login_email: user.email,
          display_name: user.displayName,
        })),
      )
      .execute();

    if (organization.organizationMemberships.length > 0) {
      await query
        .insertInto('memberships')
        .values(
          organization.organizationMemberships.map((membership) => ({
            id: membership.membershipId,
            organization_id: organization.id,
            group_id: null,
            user_id: membership.userId,
            kind: 'organization' as const,
            organization_role: membership.role,
            group_role: null,
          })),
        )
        .execute();
    }
  });

  // ── one group-scoped unit of work per group ───────────────────────────────
  //
  // A group membership can only be written under that group's context: the
  // `memberships_group_scope` WITH CHECK requires `group_id = app.group_id`. A
  // seed that tried to write Group Two's memberships from a Group One context
  // would be rejected by the database, which is the same protection production
  // code gets.
  for (const group of organization.groups) {
    const memberships = organization.groupMemberships.filter((m) => m.groupId === group.id);
    if (memberships.length === 0) continue;

    await runner.run(groupContext(organization.id, group.id), async ({ query }) => {
      await query
        .insertInto('memberships')
        .values(
          memberships.map((membership) => ({
            id: membership.membershipId,
            organization_id: organization.id,
            group_id: group.id,
            user_id: membership.userId,
            kind: 'group' as const,
            group_role: membership.role,
            organization_role: null,
            status: membership.status ?? ('active' as const),
          })),
        )
        .execute();
    });
  }
}

export async function seedFixture(runner: PgUnitOfWorkRunner): Promise<void> {
  const alpha = FIXTURE.alpha;
  await seedOrganization(runner, {
    id: alpha.organizationId,
    name: alpha.name,
    groups: [alpha.groupOne, alpha.groupTwo],
    users: Object.values(alpha.users).map((u) => ({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
    })),
    organizationMemberships: [
      {
        membershipId: alpha.users.organizationAdmin.membershipId,
        userId: alpha.users.organizationAdmin.id,
        role: 'org_admin',
      },
    ],
    groupMemberships: [
      {
        membershipId: alpha.users.scheduler.membershipId,
        userId: alpha.users.scheduler.id,
        groupId: alpha.groupOne.id,
        role: 'scheduler',
      },
      {
        membershipId: alpha.users.member.membershipId,
        userId: alpha.users.member.id,
        groupId: alpha.groupOne.id,
        role: 'member',
      },
      {
        membershipId: alpha.users.groupOnly.membershipId,
        userId: alpha.users.groupOnly.id,
        groupId: alpha.groupOne.id,
        role: 'scheduler',
      },
      {
        membershipId: alpha.users.departed.membershipId,
        userId: alpha.users.departed.id,
        groupId: alpha.groupOne.id,
        role: 'scheduler',
        status: 'ended',
      },
      {
        membershipId: alpha.users.groupTwoScheduler.membershipId,
        userId: alpha.users.groupTwoScheduler.id,
        groupId: alpha.groupTwo.id,
        role: 'scheduler',
      },
      // The SAME principal as the Group One scheduler above. T-01 depends on it.
      {
        membershipId: alpha.users.scheduler.groupTwoMembershipId,
        userId: alpha.users.scheduler.id,
        groupId: alpha.groupTwo.id,
        role: 'scheduler',
      },
    ],
  });

  const beta = FIXTURE.beta;
  await seedOrganization(runner, {
    id: beta.organizationId,
    name: beta.name,
    groups: [beta.groupOne, beta.groupTwo],
    users: Object.values(beta.users).map((u) => ({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
    })),
    organizationMemberships: [
      {
        membershipId: beta.users.organizationAdmin.membershipId,
        userId: beta.users.organizationAdmin.id,
        role: 'org_admin',
      },
    ],
    groupMemberships: [
      {
        membershipId: beta.users.scheduler.membershipId,
        userId: beta.users.scheduler.id,
        groupId: beta.groupOne.id,
        role: 'scheduler',
      },
      // Beta Group Two exists but holds only this one membership, so the
      // group-scoped probe over it is non-vacuous.
      {
        membershipId: 'bc000002-2222-4222-8222-000000000002',
        userId: beta.users.scheduler.id,
        groupId: beta.groupTwo.id,
        role: 'member',
      },
    ],
  });
}
