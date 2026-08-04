import { randomUUID } from 'node:crypto';

import type { PgUnitOfWorkRunner } from '../../src/db/unit-of-work.js';
import { administratorContext } from './fixtures.js';
import type { MultiFixture } from './multi.js';

/**
 * Test support for OPUS-M2-003's six staffing capabilities.
 *
 * ## Why granting is a helper rather than a fixture change
 *
 * `staffing.work_profile.administer` and its four siblings are **grant-only** —
 * no system role carries them, exactly as `schedule.publish` and `audit.export`
 * are grant-only. `SYSTEM_ROLE_CAPABILITIES` lives in `packages/domain/src/authz/`,
 * which is OPUS-M1-002's kernel and not this task's to edit, and the MULTI
 * provisioning script is read-only shared substrate for both M2 packets (packet 30
 * §5). So a test that needs the capability writes the grant the way production
 * does, which is a better test than a seeded role would have been: the two-person
 * rule, the group binding and the `organization.role.administer` gate all apply.
 *
 * ## FAD-15, and what "owns its subject" means here
 *
 * Every caller passes its OWN fixture from `ownedMulti(...)`. Nothing in this
 * module reads the shared baseline, and nothing here mutates a row it did not
 * create: a grant is a new row with a fresh id, returned to the caller, and
 * removed by row id when the caller is finished (second-review finding E-01 —
 * restores go by id, never by predicate).
 */

export const STAFFING_CAPABILITIES = [
  'staffing.work_profile.administer',
  'staffing.work_profile.read',
  'staffing.qualification.administer',
  'staffing.qualification_holding.administer',
  'staffing.qualification_holding.read',
  'staffing.qualification_holding.read_any',
] as const;

export type StaffingCapability = (typeof STAFFING_CAPABILITIES)[number];

export interface GrantedCapabilities {
  /** The grant row ids, for a by-id cleanup. */
  readonly grantIds: readonly string[];
}

/**
 * Grants capabilities to a GROUP membership, through the production path.
 *
 * The acting context is the organization administrator, because
 * `app_guard_capability_grant_administration` requires
 * `organization.role.administer` under an organization-scoped context and refuses
 * a grant written for any membership belonging to the acting PRINCIPAL. Both
 * rules are load-bearing and neither is worked around here.
 */
export async function grantStaffingCapabilities(
  runtime: PgUnitOfWorkRunner,
  fixture: MultiFixture,
  options: {
    readonly organizationId: string;
    readonly groupId: string;
    readonly membershipId: string;
    readonly capabilities: readonly string[];
    /** `false` writes an EXPLICIT DENY (P-1), which beats every allow in its window. */
    readonly granted?: boolean;
  },
): Promise<GrantedCapabilities> {
  const grantIds: string[] = [];

  await runtime.run(
    administratorContext(options.organizationId, 'staffing-grant', fixture),
    async ({ query }) => {
      for (const capabilityKey of options.capabilities) {
        const id = randomUUID();
        grantIds.push(id);
        await query
          .insertInto('capability_grants')
          .values({
            id,
            organization_id: options.organizationId,
            group_id: options.groupId,
            membership_id: options.membershipId,
            capability_key: capabilityKey,
            granted: options.granted ?? true,
          })
          .execute();
      }
    },
  );

  return { grantIds };
}

/** Removes grants by ROW ID. Never by predicate — FAD-15 as corrected (E-01). */
export async function revokeGrantsById(
  runtime: PgUnitOfWorkRunner,
  fixture: MultiFixture,
  options: { readonly organizationId: string; readonly grantIds: readonly string[] },
): Promise<void> {
  if (options.grantIds.length === 0) return;
  // No runtime role holds DELETE on `capability_grants` (0002, deliberately: a
  // capability is taken away by an effective-dated `granted = false` row, which is
  // auditable). A test tidying up its own rows therefore closes their windows
  // instead — which is also what production would do.
  await runtime.run(
    administratorContext(options.organizationId, 'staffing-grant-revoke', fixture),
    async ({ query }) => {
      await query
        .updateTable('capability_grants')
        .set({ granted: false })
        .where('organization_id', '=', options.organizationId)
        .where('id', 'in', [...options.grantIds])
        .execute();
    },
  );
}

/**
 * Seeds one work profile, its weekday targets, one qualification and one holding
 * into a fixture's Alpha group one — enough that every new tenant table is
 * **observed with visible rows** by the SBX-004 sweep (packet 30 §7.2).
 *
 * The holding is issued to Alpha's `scheduler` membership on purpose: the sweep's
 * `runtime/group-one` probe acts as that membership, and `qualification_holdings`
 * has no organization-wide read policy — it is `SENSITIVE-PII` — so a holding
 * belonging to anybody else would be invisible to every probe context and the
 * table would report a vacuous zero.
 *
 * Returns the row ids so a caller can assert on them by id.
 */
export interface SeededStaffingRows {
  readonly workProfileId: string;
  readonly qualificationId: string;
  readonly holdingId: string;
  readonly grantIds: readonly string[];
}

export async function seedStaffingRows(
  runtime: PgUnitOfWorkRunner,
  fixture: MultiFixture,
): Promise<SeededStaffingRows> {
  const alpha = fixture.alpha;
  const groupId = alpha.groupOne.id;
  const actor = alpha.users.groupOnly.membershipId;
  const subject = alpha.users.scheduler.membershipId;

  // The actor is `groupOnly`, whose principal holds no other membership — so the
  // two-person rule the grant guard enforces is satisfied without contrivance.
  const { grantIds } = await grantStaffingCapabilities(runtime, fixture, {
    organizationId: alpha.organizationId,
    groupId,
    membershipId: actor,
    capabilities: [
      'staffing.work_profile.administer',
      'staffing.qualification.administer',
      'staffing.qualification_holding.administer',
    ],
  });

  const workProfileId = randomUUID();
  const qualificationId = randomUUID();
  const holdingId = randomUUID();

  await runtime.run(
    {
      organizationId: alpha.organizationId,
      groupId,
      membershipId: actor,
      correlationId: 'staffing-seed',
    },
    async ({ query }) => {
      await query
        .insertInto('membership_work_profiles')
        .values({
          id: workProfileId,
          organization_id: alpha.organizationId,
          group_id: groupId,
          membership_id: subject,
          work_percentage: '80.00',
          max_assignments_per_week: 4,
        })
        .execute();

      await query
        .insertInto('membership_weekday_fte')
        .values(
          (['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'holiday'] as const).map((day) => ({
            id: randomUUID(),
            organization_id: alpha.organizationId,
            group_id: groupId,
            work_profile_id: workProfileId,
            day,
            fte_fraction: day === 'sat' || day === 'sun' || day === 'holiday' ? '0.000' : '0.800',
          })),
        )
        .execute();

      await query
        .insertInto('qualifications')
        .values({
          id: qualificationId,
          organization_id: alpha.organizationId,
          group_id: groupId,
          key: 'advanced-life-support',
          name: 'Advanced Life Support',
          requires_expiry: true,
          issuing_body: 'Synthetic Certifying Body',
        })
        .execute();

      await query
        .insertInto('qualification_holdings')
        .values({
          id: holdingId,
          organization_id: alpha.organizationId,
          group_id: groupId,
          membership_id: subject,
          qualification_id: qualificationId,
          valid_until: new Date('2030-01-01T00:00:00.000Z'),
          evidence_ref: 'SYNTH-REF-0001',
          status: 'valid',
        })
        .execute();
    },
  );

  /* ── the seeding grants are CLOSED again, deliberately ────────────────────
   *
   * SBX-001 attempts every registered route as every role-bearing principal in
   * MULTI with an empty body, and requires each cell to be an explicit allow, a
   * clean deny, or a declared context refusal. `groupOnly` is one of those
   * principals, so leaving it holding `staffing.work_profile.administer` would
   * make its cell a `400 …_BODY_MALFORMED` — correct behaviour for an authorized
   * caller who sent nothing, and a state the matrix's oracle does not model.
   *
   * Weakening the oracle to accept a fourth class would be weakening a control to
   * fit new code (non-bypass rule 10). Closing the grants instead leaves the rows
   * in place for SBX-004's non-vacuity check while every SBX-001 cell on these
   * routes is a clean deny, which is exactly what the matrix is for. The allow
   * side is proven in `apps/api/test/profiles/authorization.test.ts`, per
   * capability, against a body that is not empty. */
  await revokeGrantsById(runtime, fixture, {
    organizationId: alpha.organizationId,
    grantIds,
  });

  return { workProfileId, qualificationId, holdingId, grantIds };
}
