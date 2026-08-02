import type {
  ContextSnapshot,
  DeclaredContext,
  GroupSnapshot,
  MembershipSnapshot,
  OrganizationSnapshot,
  PrincipalSnapshot,
  TenantContext,
} from '@schedulepoint/domain';

import type { PgUnitOfWorkRunner } from '../../db/unit-of-work.js';

/**
 * Resolving the SPEC-01 §2.3 snapshot — **inside a unit of work**, so RLS
 * applies to the resolution query itself (§3).
 *
 * ## Why this is a separate, read-only unit of work
 *
 * `app.membership_id` is one of the four transaction-local settings, and it is
 * *derived server-side at step 2* — so it cannot be known when the transaction
 * that resolves it begins. The resolution therefore runs in its own unit of work
 * with the membership set to the system-actor marker (`null` → `''`), and the
 * command then runs in a second unit of work carrying the resolved membership.
 *
 * That split is safe, and it is safe for a specific reason rather than by
 * assumption: **`app.membership_id` participates in no RLS predicate.** Every
 * tenant predicate in `0001_tenancy_core.sql` reads `app.organization_id` and
 * `app.group_id` only, and both of those are the client's declaration, which is
 * known before the first transaction opens. The resolution transaction is
 * therefore confined to exactly the same tenant as the command transaction; all
 * it lacks is the actor attribution, which nothing it reads depends on.
 *
 * The resolution unit of work issues **only SELECTs**. If step 2 or step 3 is
 * going to reject the request, it must do so "before any write and before any
 * event" (§2.3), and the cheapest way to guarantee that is for the transaction
 * that decides it to be incapable of writing anything.
 */

/**
 * The resolution context: the declared tenant, with the membership not yet known.
 *
 * ⚠ **READ THIS BEFORE ADDING A QUERY TO `resolveContextSnapshot`.**
 *
 * This transaction runs with the client's **declared** organization in force and
 * has not yet decided anything. Step 2 has not run, so it is not yet known
 * whether the caller is a member at all; step 7 has not run, so no capability has
 * been checked. Any query added here therefore executes with the full
 * organization-scoped read grant — including EX-2's organization-wide
 * `memberships` read — **on behalf of an actor who may turn out to be nobody.**
 *
 * That is safe for exactly the four reads below, because each one is a read the
 * validation sequence needs in order to reject the request, and none of them
 * returns anything to the caller. It stops being safe the moment a query is
 * added whose result reaches a response body, a log line, or a timing
 * difference.
 *
 * If you need more data, resolve it in the COMMAND unit of work, after
 * `verifyDeclaredContext` has passed. The breadth of this grant is on
 * OPUS-M1-002's review list.
 */
export function resolutionContext(declared: DeclaredContext): TenantContext {
  return {
    organizationId: declared.expectedOrganizationId,
    groupId: declared.expectedGroupId,
    membershipId: null,
    correlationId: declared.correlationId,
  };
}

/** The command context: the membership resolved and verified at step 2. */
export function commandContext(
  declared: DeclaredContext,
  membershipId: string,
): TenantContext {
  return {
    organizationId: declared.expectedOrganizationId,
    groupId: declared.expectedGroupId,
    membershipId,
    correlationId: declared.correlationId,
  };
}

interface OrganizationRow {
  id: string;
  status: string;
  organization_version: string | number;
}

interface GroupRow {
  id: string;
  organization_id: string;
  status: string;
  group_version: string | number;
}

interface MembershipRow {
  id: string;
  kind: string;
  organization_id: string;
  group_id: string | null;
  user_id: string;
  status: string;
  organization_role: string | null;
  group_role: string | null;
  valid_from: Date;
  valid_to: Date | null;
}

interface UserRow {
  id: string;
  status: string;
  membership_set_version: string | number;
  session_epoch: string | number;
}

/** `bigint` arrives from `pg` as a string, because it does not fit a JS number. */
function counter(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error('a freshness counter exceeded the safe integer range');
  }
  return parsed;
}

function asStatus<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/**
 * Reads every fact §2.3 needs, in ONE transaction.
 *
 * Each query is scoped by an explicit predicate *as well as* by RLS. The
 * redundancy is deliberate: RLS is the control, and the predicate is what makes
 * the query's intent legible to a reader who has not memorised the policies.
 */
export async function resolveContextSnapshot(
  runner: PgUnitOfWorkRunner,
  declared: DeclaredContext,
): Promise<ContextSnapshot> {
  return runner.run(resolutionContext(declared), async ({ query }) => {
    const organizationRows = await query
      .selectFrom('organizations')
      .select(['id', 'status', 'organization_version'])
      .where('id', '=', declared.expectedOrganizationId)
      .execute();
    const organizationRow = organizationRows[0] as OrganizationRow | undefined;

    const organization: OrganizationSnapshot | null =
      organizationRow === undefined
        ? null
        : {
            id: organizationRow.id,
            status: asStatus(organizationRow.status, ['active', 'inactive'] as const, 'inactive'),
            organizationVersion: counter(organizationRow.organization_version),
          };

    let group: GroupSnapshot | null = null;
    if (declared.expectedGroupId !== null) {
      const groupRows = await query
        .selectFrom('groups')
        .select(['id', 'organization_id', 'status', 'group_version'])
        .where('id', '=', declared.expectedGroupId)
        .execute();
      const groupRow = groupRows[0] as GroupRow | undefined;
      group =
        groupRow === undefined
          ? null
          : {
              id: groupRow.id,
              organizationId: groupRow.organization_id,
              status: asStatus(groupRow.status, ['active', 'inactive'] as const, 'inactive'),
              groupVersion: counter(groupRow.group_version),
            };
    }

    // Step 2's two branches. Which KIND of membership satisfies the request is
    // decided by the route's declared scope, and the two are disjoint
    // (SPEC-06 P-8/P-9). The RLS policy already confines the visible rows to the
    // matching kind — under an organization-scoped context only `group_id IS
    // NULL` rows are visible, and under a group-scoped context only that group's
    // — so the explicit `kind` predicate here is defence in depth, not the
    // control.
    const membershipQuery = query
      .selectFrom('memberships')
      .select([
        'id',
        'kind',
        'organization_id',
        'group_id',
        'user_id',
        'status',
        'organization_role',
        'group_role',
        'valid_from',
        'valid_to',
      ])
      .where('user_id', '=', declared.principalUserId)
      .where('kind', '=', declared.actionScope === 'group' ? 'group' : 'organization');

    const membershipRows = await (declared.actionScope === 'group'
      ? membershipQuery.where('group_id', '=', declared.expectedGroupId)
      : membershipQuery.where('group_id', 'is', null)
    ).execute();

    const membershipRow = membershipRows[0] as MembershipRow | undefined;
    const membership: MembershipSnapshot | null =
      membershipRow === undefined
        ? null
        : {
            id: membershipRow.id,
            kind: membershipRow.kind === 'organization' ? 'organization' : 'group',
            organizationId: membershipRow.organization_id,
            groupId: membershipRow.group_id,
            userId: membershipRow.user_id,
            status: asStatus(
              membershipRow.status,
              ['invited', 'active', 'suspended', 'ended'] as const,
              'ended',
            ),
            organizationRole: membershipRow.organization_role,
            groupRole: membershipRow.group_role,
            validFrom: membershipRow.valid_from.toISOString(),
            validTo: membershipRow.valid_to?.toISOString() ?? null,
          };

    // The principal row is only reachable through a membership visible in this
    // context (`users_readable_through_membership`), so a non-member's counters
    // are unreadable — which is what keeps step 4 from becoming an oracle for
    // "does this user exist".
    const userRows = await query
      .selectFrom('users')
      .select(['id', 'status', 'membership_set_version', 'session_epoch'])
      .where('id', '=', declared.principalUserId)
      .execute();
    const userRow = userRows[0] as UserRow | undefined;

    const principal: PrincipalSnapshot | null =
      userRow === undefined
        ? null
        : {
            id: userRow.id,
            status: asStatus(userRow.status, ['active', 'deactivated'] as const, 'deactivated'),
            membershipSetVersion: counter(userRow.membership_set_version),
            sessionEpoch: counter(userRow.session_epoch),
          };

    return {
      organization,
      group,
      membership,
      principal,
      now: new Date().toISOString(),
    };
  });
}
