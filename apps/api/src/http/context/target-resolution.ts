import type { RequestContext, TargetDescriptor } from '@schedulepoint/domain';

import type { PgUnitOfWorkRunner } from '../../db/unit-of-work.js';

/**
 * SPEC-01 §3 — resolving a named target's tenant coordinates.
 *
 * ## The tension this module resolves, and how
 *
 * §3 says two things that look incompatible:
 *
 * > **Identifiers are globally unique** — UUIDs. An identifier from Group A is
 * > *resolvable* but never *usable* under Group B's context.
 *
 * > **Resolution happens inside the unit of work** — so RLS applies to the
 * > resolution query itself.
 *
 * Under a group-scoped unit of work RLS makes a sibling group's row invisible,
 * so a literal reading makes `409 CONTEXT_TARGET_MISMATCH` unreachable and every
 * mismatch a `404`. The reading that satisfies both, and that §2.4 confirms, is
 * that **the organization is the boundary RLS never lets you cross, and the
 * group is the scope step 6 policies**:
 *
 *  - target in a sibling **group**, same organization → resolvable →
 *    `409 CONTEXT_TARGET_MISMATCH` for an authorized actor, `404` otherwise;
 *  - target in another **organization** → not resolvable, ever → `404`, and no
 *    cross-tenant existence is disclosed (§2.4).
 *
 * ## Why the ordering below is the disclosure control
 *
 * The cross-group read happens **only after** the actor has passed the
 * capability check in their declared tenant (V-07), and only when the target was
 * not already visible in the declared scope. An unauthorized prober therefore
 * causes **no cross-group query at all**: their request does exactly the same
 * work as a request naming an id that does not exist — one scoped lookup that
 * misses, then a `404`. That is what makes T-05b's "no timing or body
 * difference" a property of the code path rather than a hope.
 *
 * This is also EX-1's shape from SPEC-01 §4.3: an organization-scoped context
 * (`app.group_id IS NULL`) plus a cross-group read capability. The read is
 * `SELECT`-only, returns **tenant coordinates only**, and never leaves this
 * module.
 */

/** The aggregate type this milestone can name as a target. */
export const MEMBERSHIP_AGGREGATE = 'membership';

interface CoordinateRow {
  organization_id: string;
  group_id: string | null;
}

/**
 * Resolves a membership id to its tenant coordinates within the declared
 * organization, in a **separate, read-only, organization-scoped** unit of work.
 *
 * It must be called *outside* the command's unit of work: a nested call with a
 * different tenant tuple is a `NestedTenantChangeError` by construction, which
 * is the correct behaviour and the reason this is a distinct step rather than a
 * convenience inside the handler's transaction.
 *
 * @returns the coordinates, or `null` when the id names nothing in the declared
 *          organization — including when it names a row in another organization,
 *          which is indistinguishable and must stay that way.
 */
export async function resolveMembershipCoordinates(
  runner: PgUnitOfWorkRunner,
  context: RequestContext,
  targetMembershipId: string,
): Promise<TargetDescriptor | null> {
  return runner.run(
    {
      organizationId: context.expectedOrganizationId,
      // Organization-scoped: this is the EX-2 read, and the only reason the
      // sibling group's row is visible at all.
      groupId: null,
      // No acting membership: this transaction attributes nothing and writes
      // nothing. A null membership matches no ownership policy.
      membershipId: null,
      correlationId: context.correlationId,
    },
    async ({ query }) => {
      const rows = (await query
        .selectFrom('memberships')
        .select(['organization_id', 'group_id'])
        .where('id', '=', targetMembershipId)
        .execute()) as unknown as CoordinateRow[];

      const row = rows[0];
      if (row === undefined) return null;
      return {
        organizationId: row.organization_id,
        groupId: row.group_id,
        aggregateType: MEMBERSHIP_AGGREGATE,
      };
    },
  );
}
