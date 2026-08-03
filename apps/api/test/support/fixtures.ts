import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@schedulepoint/domain';
import { sql } from 'kysely';

import { LocalCheckpointSigner } from '../../src/audit/checkpoint-signer.js';
import { writeCheckpoint } from '../../src/audit/checkpoints.js';
import { recordAuditEvent } from '../../src/audit/recorder.js';
import { provisionAuthorization } from '../../src/authz/provisioning.js';
import type { PgUnitOfWorkRunner } from '../../src/db/unit-of-work.js';
import { publishOutboxEvent } from '../../src/outbox/publisher.js';

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

/**
 * An organization-scoped context acting as that organization's administrator.
 *
 * Since OPUS-M1-002 a privilege-bearing membership change — role, status, kind,
 * group, validity window — is refused by
 * `memberships_guard_administration_on_privilege_change` unless the acting
 * membership holds `organization.membership.administer`. A test that wants to
 * revoke a role therefore has to do it the way production does, and this is that
 * context. Using `membershipId: null` is now a **refusal**, which is the point of
 * the change.
 */
export function administratorContext(
  organizationId: string,
  correlationId = 'fixture-administration',
): TenantContext {
  const membershipId =
    organizationId === FIXTURE.beta.organizationId
      ? FIXTURE.beta.users.organizationAdmin.membershipId
      : FIXTURE.alpha.users.organizationAdmin.membershipId;
  return { organizationId, groupId: null, membershipId, correlationId };
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

/**
 * A seeded `capability_grants` row.
 *
 * Every group in the fixture gets exactly one, and that is not decoration: the
 * T-15 storm and the red-case probe both assert that **every** tenant table is
 * observed with at least one visible row, because a probe over an empty table
 * reports "0 wrong" for the most boring possible reason. A `capability_grants`
 * table with no rows would make the isolation claim for it vacuous.
 *
 * The grants are also the ones doc 08 §6 says should exist: `schedule.publish`
 * is a `G` cell — grant-only, never role-implied — so an explicit allow is how a
 * scheduler gets it, and an explicit deny is how a particular person is kept
 * away from it whatever their role (SPEC-06 P-1).
 */
interface SeedGrant {
  readonly grantId: string;
  readonly membershipId: string;
  readonly groupId: string | null;
  readonly capabilityKey: string;
  readonly granted: boolean;
}

async function seedOrganization(
  runner: PgUnitOfWorkRunner,
  organization: {
    id: string;
    name: string;
    groups: readonly { id: string; name: string }[];
    users: readonly { id: string; email: string; displayName: string }[];
    /** The FIRST of these is the bootstrap administrator. Order matters — see below. */
    organizationMemberships: readonly { membershipId: string; userId: string; role: string }[];
    groupMemberships: readonly SeedGroupMembership[];
    grants: readonly SeedGrant[];
  },
): Promise<void> {
  const bootstrapAdmin = organization.organizationMemberships[0];
  if (bootstrapAdmin === undefined) {
    throw new Error(
      `fixture organization ${organization.id} has no organization membership — since ` +
        'OPUS-M1-002 there is no other way to authorize the rest of the seed',
    );
  }

  /* ────────────────────────────────────────────────────────────────────────
   * PASS 1 — through the provisioning door.
   *
   * `0002_authorization.sql`'s `app_require_capability` waives the capability
   * check for an ORGANIZATION-scoped context in an organization that has **no
   * memberships at all**. That door is the only way a tenant can come into
   * existence, and it shuts the instant the first membership row lands.
   *
   * So everything that needs it goes first, in one transaction, and the first
   * organization membership goes LAST inside that transaction — its BEFORE
   * INSERT trigger runs while `memberships` is still empty, which is the last
   * moment the door is open.
   * ──────────────────────────────────────────────────────────────────────── */
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

    // Roles, role capabilities, the `core_scheduling` entitlement, and
    // per-group availability. Without these the evaluator denies every request
    // at L1.1 or L4.2 — which is the correct behaviour for an unprovisioned
    // organization and is asserted separately.
    await provisionAuthorization(query, {
      organizationId: organization.id,
      groupIds: organization.groups.map((group) => group.id),
    });

    await query
      .insertInto('memberships')
      .values({
        id: bootstrapAdmin.membershipId,
        organization_id: organization.id,
        group_id: null,
        user_id: bootstrapAdmin.userId,
        kind: 'organization' as const,
        organization_role: bootstrapAdmin.role,
        group_role: null,
      })
      .execute();
  });

  /* ────────────────────────────────────────────────────────────────────────
   * PASS 2 — the door is shut; everything else is authorized.
   *
   * The acting membership is the bootstrap administrator, whose `org_admin`
   * role carries `organization.membership.administer` through
   * `role_capabilities`. Every membership below is created the way production
   * creates one: an organization-scoped unit of work, an acting membership, and
   * a capability the database checks in a BEFORE INSERT trigger.
   *
   * Group memberships are written from the ORGANIZATION context, which is what
   * SPEC-06 §1.1 says "assign a group role" is, and what
   * `memberships_organization_administration` (0002) admits. The cross-group
   * write protection this seed used to demonstrate is asserted directly instead,
   * by T-13b in `roles-and-schema.test.ts`.
   * ──────────────────────────────────────────────────────────────────────── */
  const rest = organization.organizationMemberships.slice(1);

  await runner.run(
    { ...organizationContext(organization.id), membershipId: bootstrapAdmin.membershipId },
    async ({ query }) => {
      if (rest.length > 0) {
        await query
          .insertInto('memberships')
          .values(
            rest.map((membership) => ({
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

      if (organization.groupMemberships.length > 0) {
        await query
          .insertInto('memberships')
          .values(
            organization.groupMemberships.map((membership) => ({
              id: membership.membershipId,
              organization_id: organization.id,
              group_id: membership.groupId,
              user_id: membership.userId,
              kind: 'group' as const,
              group_role: membership.role,
              organization_role: null,
              status: membership.status ?? ('active' as const),
            })),
          )
          .execute();
      }

      // Grants come last, because `capability_grants` has a composite FK to
      // `memberships` and the membership must exist first. Written from the
      // ORGANIZATION context, which is where SPEC-06 §1.1 puts capability
      // administration — and admitted by `capability_grants_organization_administration`.
      if (organization.grants.length > 0) {
        await query
          .insertInto('capability_grants')
          .values(
            organization.grants.map((grant) => ({
              id: grant.grantId,
              organization_id: organization.id,
              group_id: grant.groupId,
              membership_id: grant.membershipId,
              capability_key: grant.capabilityKey,
              granted: grant.granted,
              granted_by_membership_id: bootstrapAdmin.membershipId,
            })),
          )
          .execute();
      }
    },
  );
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
    grants: [
      // One per group, so `capability_grants` is non-vacuous under every group
      // context the storm and the red-case probe use.
      {
        grantId: '9a000001-1111-4111-8111-000000000001',
        membershipId: alpha.users.scheduler.membershipId,
        groupId: alpha.groupOne.id,
        capabilityKey: 'schedule.publish',
        granted: true,
      },
      {
        grantId: '9a000002-1111-4111-8111-000000000002',
        membershipId: alpha.users.groupTwoScheduler.membershipId,
        groupId: alpha.groupTwo.id,
        capabilityKey: 'schedule.publish',
        granted: true,
      },
      // An EXPLICIT DENY on a capability the role already carries. P-1's
      // precedence has a live row to be tested against rather than only a
      // constructed one, and this membership is the one T-05b uses.
      {
        grantId: '9a000003-1111-4111-8111-000000000003',
        membershipId: alpha.users.member.membershipId,
        groupId: alpha.groupOne.id,
        capabilityKey: 'documents.manage',
        granted: false,
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
    grants: [
      {
        grantId: '9b000001-2222-4222-8222-000000000001',
        membershipId: beta.users.scheduler.membershipId,
        groupId: beta.groupOne.id,
        capabilityKey: 'schedule.publish',
        granted: true,
      },
      {
        grantId: '9b000002-2222-4222-8222-000000000002',
        membershipId: 'bc000002-2222-4222-8222-000000000002',
        groupId: beta.groupTwo.id,
        capabilityKey: 'schedule.publish',
        granted: false,
      },
    ],
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * The audit and outbox partitions (OPUS-M1-004)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Seeds `audit_events`, `outbox_events`, `outbox_effects` and
 * `audit_checkpoints` in **both** organizations and **every** group.
 *
 * ## Why the fixture has to grow for this
 *
 * FAD-13 item 3 put migration 0003's four tenant tables into `TENANT_TABLES`,
 * which is what the wrong-tenant probe, the T-15 storm, the pool-cleanliness
 * check and the (role, table) matrix all iterate. **A probe over an empty table
 * reports "0 wrong rows" for the boring reason** — it is the vacuous pass the
 * whole probe design exists to avoid, and `probe-is-not-vacuous.test.ts` asserts
 * against exactly that. The grants above carry the same note for the same
 * reason.
 *
 * ## Every row here is written by the production path
 *
 * Not by hand-built INSERTs. The audit rows come from `recordAuditEvent` after a
 * real `last_active_at` touch, the outbox rows from `publishOutboxEvent`, the
 * checkpoints from `writeCheckpoint` with the local signer. A fixture that
 * hand-wrote these would seed rows the application could not have produced, and
 * the isolation claim would then be about rows nothing writes.
 *
 * The touch is real, so the audit row is true: `membership.activity_touched`
 * names something that actually happened in that transaction.
 *
 * ## Two roles, because the grants say so
 *
 * `app_runtime` may append audit events and publish outbox events.
 * `outbox_effects` and `audit_checkpoints` are `app_worker`'s alone (0003's
 * grants, and SPEC-11 §2's rule that a request path must not be able to sign a
 * checkpoint over a chain it just wrote). So this takes both runners, and using
 * the wrong one raises `42501` rather than quietly succeeding.
 */
export async function seedAuditAndOutbox(
  runtime: PgUnitOfWorkRunner,
  worker: PgUnitOfWorkRunner,
): Promise<void> {
  const signer = new LocalCheckpointSigner({ keyId: 'fixture-seed-key' });

  const organizations = [
    {
      id: FIXTURE.alpha.organizationId,
      adminMembershipId: FIXTURE.alpha.users.organizationAdmin.membershipId,
      groups: [
        { id: FIXTURE.alpha.groupOne.id, membershipId: FIXTURE.alpha.users.scheduler.membershipId },
        {
          id: FIXTURE.alpha.groupTwo.id,
          membershipId: FIXTURE.alpha.users.groupTwoScheduler.membershipId,
        },
      ],
    },
    {
      id: FIXTURE.beta.organizationId,
      adminMembershipId: FIXTURE.beta.users.organizationAdmin.membershipId,
      groups: [
        { id: FIXTURE.beta.groupOne.id, membershipId: FIXTURE.beta.users.scheduler.membershipId },
        {
          id: FIXTURE.beta.groupTwo.id,
          membershipId: 'bc000002-2222-4222-8222-000000000002',
        },
      ],
    },
  ] as const;

  for (const organization of organizations) {
    for (const group of organization.groups) {
      const correlationId = `fixture-audit-${group.id.slice(0, 8)}`;

      const outboxEventId = await runtime.run(
        groupContext(organization.id, group.id, group.membershipId, correlationId),
        async (uow) => {
          await uow.query
            .updateTable('memberships')
            .set({ last_active_at: new Date() })
            .where('id', '=', group.membershipId)
            .execute();

          const recorded = await recordAuditEvent(uow, {
            eventName: 'membership.activity_touched',
            subjectType: 'membership',
            subjectId: group.membershipId,
          });

          const published = await publishOutboxEvent(uow, recorded, {
            kind: 'membership.activity_touched',
            idempotencyKey: `fixture-touch:${recorded.sequence}`,
          });
          return published.id;
        },
      );

      // `outbox_effects` is app_worker's. The effect row IS the effect and its
      // primary key IS the deduplication, so this is the same shape
      // `DatabaseOutboxSink` writes — with the worker's own credential, in the
      // group whose outbox row it belongs to.
      await worker.run(
        groupContext(organization.id, group.id, null, correlationId),
        async ({ query }) => {
          await sql`
            insert into outbox_effects (
              organization_id, idempotency_key, group_id, outbox_event_id, kind,
              correlation_id, attempt
            ) values (
              ${organization.id}::uuid,
              ${`fixture-effect:${randomUUID()}`},
              ${group.id}::uuid,
              ${outboxEventId}::uuid,
              ${'membership.activity_touched'},
              ${correlationId},
              1
            )
          `.execute(query);
        },
      );
    }

    // An ORGANIZATION-scoped audit row as well as the group ones: `audit_events`
    // has separate group and organization INSERT policies, and the organization
    // one requires `group_id IS NULL`. Seeding only group rows would leave that
    // policy unexercised by every generic probe.
    await runtime.run(
      { ...organizationContext(organization.id, 'fixture-audit-org'), membershipId: organization.adminMembershipId },
      async (uow) => {
        await uow.query
          .updateTable('memberships')
          .set({ last_active_at: new Date() })
          .where('id', '=', organization.adminMembershipId)
          .execute();
        await recordAuditEvent(uow, {
          eventName: 'membership.activity_touched',
          subjectType: 'membership',
          subjectId: organization.adminMembershipId,
        });
      },
    );

    // The checkpoint, last, so it signs a head that already has every row above
    // under it. Organization-scoped by construction — `writeCheckpoint` throws
    // on a group-scoped context, because a group-scoped read sees a subset of
    // the chain and would checkpoint a head that is not the head.
    const written = await worker.run(
      organizationContext(organization.id, 'fixture-checkpoint'),
      (uow) => writeCheckpoint(uow, signer),
    );
    if (written === null) {
      throw new Error(
        `fixture: no checkpoint was written for ${organization.id} — audit_checkpoints would be ` +
          'empty and every probe over it vacuous',
      );
    }
  }
}
