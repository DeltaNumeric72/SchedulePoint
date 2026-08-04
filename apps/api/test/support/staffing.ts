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

/* ────────────────────────────────────────────────────────────────────────────
 * `seedStaffingRows` used to live here. It now lives in `multi.ts`.
 *
 * The **D-1** ruling: `provisionMulti` is the single fixture owner again, and a
 * file that needs staffing rows declares them —
 * `ownedMulti('<slug>', { seed: { staffing: true } })` — instead of calling a
 * seeding function after provisioning. What remains in this module is the two
 * GRANT helpers above, which are not fixture seeding: they are what a test calls
 * mid-flight to give a membership a capability and take it away again.
 * ──────────────────────────────────────────────────────────────────────────── */
