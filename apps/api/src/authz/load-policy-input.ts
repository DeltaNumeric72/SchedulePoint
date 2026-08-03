import {
  moduleClosure,
  type ActionInput,
  type AvailabilityInput,
  type EntitlementInput,
  type EntitlementState,
  type EvaluationContext,
  type GrantInput,
  type GroupInput,
  type MembershipInput,
  type MembershipInputStatus,
  type ModuleKey,
  type OrganizationInput,
  type PolicyInput,
  type RoleInput,
  type TargetInput,
} from '@schedulepoint/domain';
import type { Kysely } from 'kysely';

import type { Database } from '../db/schema.js';

/**
 * Assembling SPEC-06 §1's `PolicyInput` — **inside the caller's transaction**.
 *
 * ## The single most important property of this module
 *
 * **It takes a `Kysely` handle, never a runner.** That is not a style choice: it
 * is what makes FAD-12 structurally true rather than a convention. A function
 * that took the runner could open its own unit of work, and then the
 * authorization snapshot and the mutation it authorizes would sit in two
 * transactions with a committable window between them — a revocation landing in
 * that window would authorize a write that was already stale when it committed,
 * and the write would look perfectly authorized in the log.
 *
 * > FAD-12: authorization re-evaluation and the mutation it authorizes share ONE
 * > unit of work on every surface.
 *
 * Because the handle is the caller's, the reads take the same snapshot the write
 * commits against. `apps/api/test/authz/http-authorization.test.ts` asserts the
 * transaction count structurally, so a future split back into two fails before
 * anyone has to reason about the race again.
 *
 * ## I-19: nothing is cached
 *
 * Every field below is read on every request. There is no memo, no TTL and no
 * `authorization_version` short-circuit anywhere in this file — SPEC-06 §4's
 * cache design describes a cache this milestone does not have, which is the
 * safest possible state to be in and is recorded as such in EV-M1-AUTHZ §5.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Row shapes. Kysely's inference is bypassed with `as unknown as` at the call
 * sites, exactly as the M1-001 modules do, because the generated select types
 * are noisy and the cast is checked by these interfaces.
 * ──────────────────────────────────────────────────────────────────────────── */

interface OrganizationRow {
  id: string;
  status: string;
}

interface GroupRow {
  id: string;
  status: string;
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

interface EntitlementRow {
  module_key: string;
  state: string;
  effective_from: Date;
  effective_to: Date | null;
}

/**
 * An instant as an ISO string, or `null` when the value is not a usable date.
 *
 * `timestamptz` accepts `infinity` and `-infinity`, and node-postgres returns
 * those as the JavaScript numbers `Infinity` / `-Infinity`, not `Date`s — so a
 * bare `.toISOString()` throws a `TypeError` and turns a row into a 500. It
 * returns `null` instead, and every consumer treats `null` as **not parsable**,
 * which the evaluator fails closed on.
 *
 * `0002_authorization.sql` **now** forbids infinite bounds at the CHECK level on
 * `memberships`, `capability_grants` and `entitlements` — it did not when this
 * docblock first claimed it did, and a reviewer wrote infinite bounds to all
 * three. The control exists now; this guard is what survives a row written
 * before it.
 *
 * **This is not the only place the conversion happens, and the first version of
 * this comment implied it was.** `apps/api/src/http/context/snapshot.ts` runs
 * FIRST, on every request, and has its own copy of the guard for the same
 * reason. `apps/api/src/jobs/worker.ts` has the same shape and is OPUS-M1-003's
 * file scope — routed to the post-merge integration task, not fixed here.
 */
function instantOf(value: Date | null): string | null {
  if (value === null) return null;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  return value.toISOString();
}

/** The sentinel handed to the evaluator for an unusable stored instant. */
const UNPARSABLE_INSTANT = 'unparsable-instant';

/**
 * SPEC-06 L1 reads **the entitlement in force at `now`**, not an arbitrary row.
 *
 * `entitlements` is deliberately effective-dated with a `[)` EXCLUDE constraint,
 * so **multiple rows per (organization, module) is the designed steady state** —
 * one closed historical window plus the live one is what re-windowing produces.
 * The first version of this loader had no window predicate and no `ORDER BY`, so
 * whichever row PostgreSQL returned last won. An independent review reproduced
 * the consequence through the shipped runner: **one legitimate administrative
 * write makes every action in that module 404 organization-wide**, with no error
 * anywhere and nothing in the logs to point at the entitlement table.
 *
 * The rule, in order:
 *
 *  1. the row in force at `now` — the EXCLUDE constraint guarantees at most one;
 *  2. failing that, the most recently ENDED row, so L1.3 reports
 *     `ENTITLEMENT_EXPIRED` against the window the caller most likely means;
 *  3. failing that, the earliest FUTURE row, for the same reason;
 *  4. failing that, `null` — L1.1 `NOT_ENTITLED`.
 *
 * Steps 2–4 matter because L1.3 has to be reachable: filtering out-of-window rows
 * in SQL would turn every expired entitlement into `NOT_ENTITLED` and delete a
 * row of the truth table. **L4 has always done this correctly** through
 * `inWindowGrants`; this makes L1 symmetric with it.
 */
export function pickEntitlementInForce(
  rows: readonly EntitlementInput[],
  now: Date,
): EntitlementInput | null {
  if (rows.length === 0) return null;
  const at = now.getTime();

  const parsedFrom = (row: EntitlementInput): number => Date.parse(row.effectiveFrom);
  const isInForce = (row: EntitlementInput): boolean => {
    const from = parsedFrom(row);
    if (Number.isNaN(from) || at < from) return false;
    if (row.effectiveTo === null) return true;
    const to = Date.parse(row.effectiveTo);
    // An unparsable upper bound is NOT treated as open-ended: that would make a
    // corrupt row grant unlimited entitlement.
    return !Number.isNaN(to) && at < to;
  };

  const inForce = rows.filter(isInForce);
  if (inForce.length > 0) {
    // At most one by construction. If the constraint were ever dropped, the
    // latest-starting row wins deterministically rather than by row order.
    return [...inForce].sort((a, b) => parsedFrom(b) - parsedFrom(a))[0] ?? null;
  }

  const ended = rows.filter((row) => {
    const from = parsedFrom(row);
    return !Number.isNaN(from) && from <= at;
  });
  if (ended.length > 0) {
    return [...ended].sort((a, b) => parsedFrom(b) - parsedFrom(a))[0] ?? null;
  }

  return [...rows].sort((a, b) => parsedFrom(a) - parsedFrom(b))[0] ?? null;
}

interface AvailabilityRow {
  module_key: string;
  available: boolean;
}

interface RoleRow {
  id: string;
  key: string;
  is_system_role: boolean;
}

interface RoleCapabilityRow {
  capability_key: string;
}

interface GrantRow {
  capability_key: string;
  granted: boolean;
  valid_from: Date;
  valid_to: Date | null;
}

function asMembershipStatus(value: string): MembershipInputStatus {
  // Anything unrecognised is `ended`, the most restrictive of the four. A status
  // this code does not know must not read as `active`.
  return value === 'invited' || value === 'active' || value === 'suspended' ? value : 'ended';
}

function asEntitlementState(value: string): EntitlementState {
  // Same rule: an unknown state is `revoked`, not `active`.
  return value === 'trial' || value === 'active' || value === 'suspended' ? value : 'revoked';
}

export interface LoadPolicyInputOptions {
  readonly context: EvaluationContext;
  readonly action: ActionInput;
  /** SPEC-06 §3.1's object policy. `undefined` when the action names no object. */
  readonly target?: TargetInput | null;
  /** The evaluation instant. Passed in so the whole request shares one. */
  readonly now: Date;
}

/**
 * Reads every fact the truth table needs, in the caller's transaction, under RLS.
 *
 * Each query carries an explicit predicate **as well as** the RLS policy. The
 * redundancy is the same one M1-001 chose for the context snapshot: RLS is the
 * control, the predicate is what makes the query's intent legible to a reader
 * who has not memorised the policies.
 */
export async function loadPolicyInput(
  query: Kysely<Database>,
  options: LoadPolicyInputOptions,
): Promise<PolicyInput> {
  const { context, action, now } = options;
  const groupScoped = action.scope === 'group';
  const nowIso = now.toISOString();

  /* ── L0.1 ─────────────────────────────────────────────────────────────── */
  const organizationRows = (await query
    .selectFrom('organizations')
    .select(['id', 'status'])
    .where('id', '=', context.expectedOrganizationId)
    .execute()) as unknown as OrganizationRow[];
  const organizationRow = organizationRows[0];
  const organization: OrganizationInput | null =
    organizationRow === undefined
      ? null
      : {
          id: organizationRow.id,
          status: organizationRow.status === 'active' ? 'active' : 'inactive',
        };

  /* ── L0.2 (group scope only) ──────────────────────────────────────────── */
  let group: GroupInput | null = null;
  if (groupScoped && context.expectedGroupId !== null) {
    const groupRows = (await query
      .selectFrom('groups')
      .select(['id', 'status'])
      .where('id', '=', context.expectedGroupId)
      .execute()) as unknown as GroupRow[];
    const groupRow = groupRows[0];
    group =
      groupRow === undefined
        ? null
        : { id: groupRow.id, status: groupRow.status === 'active' ? 'active' : 'inactive' };
  }

  /* ── L1: the action's module AND its transitive dependency closure ─────── */
  //
  // One query for the whole closure rather than one per module: L1.4 asks about
  // every dependency, and N queries would be N round trips inside the request's
  // only transaction.
  const closure = moduleClosure(action.moduleKey);
  const entitlementRows = (await query
    .selectFrom('entitlements')
    .select(['module_key', 'state', 'effective_from', 'effective_to'])
    .where('organization_id', '=', context.expectedOrganizationId)
    .where('module_key', 'in', [...closure])
    // Deterministic input to `pickEntitlementInForce`. The selection rule does
    // not depend on this order, and the order exists so that a failure is
    // reproducible rather than dependent on the plan.
    .orderBy('module_key')
    .orderBy('effective_from')
    .execute()) as unknown as EntitlementRow[];

  // ALL rows per module, then the one in force. Keyed by module rather than
  // overwritten in a loop — the loop was the bug.
  const entitlementsByModule = new Map<string, EntitlementInput[]>();
  for (const row of entitlementRows) {
    const candidates = entitlementsByModule.get(row.module_key) ?? [];
    candidates.push({
      moduleKey: row.module_key as ModuleKey,
      state: asEntitlementState(row.state),
      effectiveFrom: instantOf(row.effective_from) ?? UNPARSABLE_INSTANT,
      effectiveTo: row.effective_to === null ? null : (instantOf(row.effective_to) ?? UNPARSABLE_INSTANT),
    });
    entitlementsByModule.set(row.module_key, candidates);
  }

  const inForce = (moduleKey: string): EntitlementInput | null =>
    pickEntitlementInForce(entitlementsByModule.get(moduleKey) ?? [], now);

  const entitlement = inForce(action.moduleKey);
  // L1.4's dependency map is built from the SAME selection, so a dependency with
  // a historical row cannot be read as the live one either.
  const moduleDependencies = closure
    .filter((key) => key !== action.moduleKey)
    .map((key) => ({ moduleKey: key, entitlement: inForce(key) }));

  /* ── L2.1 (group scope only) ──────────────────────────────────────────── */
  let availability: AvailabilityInput | null = null;
  if (groupScoped && context.expectedGroupId !== null) {
    const availabilityRows = (await query
      .selectFrom('group_module_availability')
      .select(['module_key', 'available'])
      .where('group_id', '=', context.expectedGroupId)
      .where('module_key', '=', action.moduleKey)
      .execute()) as unknown as AvailabilityRow[];
    const availabilityRow = availabilityRows[0];
    availability =
      availabilityRow === undefined
        ? null
        : { moduleKey: availabilityRow.module_key as ModuleKey, available: availabilityRow.available };
  }

  /* ── L3: the ACTING membership, re-read against current state (I-19) ───── */
  //
  // By id, not by (principal, group): the middleware already resolved which
  // membership is acting at SPEC-01 §2.3 step 2, and re-deriving it here would
  // be a second resolution that could disagree with the one in `app.membership_id`.
  const membershipRows = (await query
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
    .where('id', '=', context.membershipId)
    .execute()) as unknown as MembershipRow[];
  const membershipRow = membershipRows[0];

  // A membership of the WRONG KIND for the action's scope is discarded here
  // rather than handed to the evaluator, which is P-8/P-9 applied at the point
  // the snapshot is built: the group slot only ever holds a group membership and
  // the organization slot only ever an organization membership, so no later code
  // can accidentally read across.
  const kindMatches =
    membershipRow !== undefined &&
    membershipRow.kind === (groupScoped ? 'group' : 'organization') &&
    membershipRow.user_id === context.principalUserId &&
    membershipRow.organization_id === context.expectedOrganizationId &&
    (groupScoped ? membershipRow.group_id === context.expectedGroupId : membershipRow.group_id === null);

  const roleKey =
    membershipRow === undefined || !kindMatches
      ? null
      : groupScoped
        ? membershipRow.group_role
        : membershipRow.organization_role;

  const membership: MembershipInput | null =
    membershipRow === undefined || !kindMatches
      ? null
      : {
          id: membershipRow.id,
          status: asMembershipStatus(membershipRow.status),
          roleId: roleKey,
          validFrom: instantOf(membershipRow.valid_from) ?? UNPARSABLE_INSTANT,
          validTo:
            membershipRow.valid_to === null
              ? null
              : (instantOf(membershipRow.valid_to) ?? UNPARSABLE_INSTANT),
        };

  /* ── L4.2 (b): the role and its capability set ─────────────────────────── */
  let role: RoleInput | null = null;
  let roleCapabilities: readonly string[] = [];
  if (roleKey !== null) {
    const roleRows = (await query
      .selectFrom('roles')
      .select(['id', 'key', 'is_system_role'])
      .where('organization_id', '=', context.expectedOrganizationId)
      .where('scope', '=', groupScoped ? 'group' : 'organization')
      .where('key', '=', roleKey)
      .where('status', '=', 'active')
      .execute()) as unknown as RoleRow[];
    const roleRow = roleRows[0];
    if (roleRow !== undefined) {
      // `RoleInput.id` is the role KEY, not the `roles` row's UUID — the same
      // value `membership.roleId` carries, because S-07's cross-check compares
      // them. Handing the UUID here made every request deny at L3.1 the moment
      // that check landed, which is the check doing its job: the loader and the
      // cross-product generator had disagreed about what `roleId` meant since
      // they were written, and nothing had ever compared the two.
      role = { id: roleRow.key, isSystemRole: roleRow.is_system_role };
      const capabilityRows = (await query
        .selectFrom('role_capabilities')
        .select(['capability_key'])
        .where('organization_id', '=', context.expectedOrganizationId)
        .where('role_id', '=', roleRow.id)
        .execute()) as unknown as RoleCapabilityRow[];
      roleCapabilities = capabilityRows.map((row) => row.capability_key);
    }
    // A role key on the membership with no matching `roles` row resolves to NO
    // capabilities, not to an error. An organization that has not been
    // provisioned with its system roles therefore denies everything, which is
    // the correct direction for a half-configured tenant.
  }

  /* ── L4.1 / L4.2 (a): grants on the acting membership ──────────────────── */
  //
  // Every grant for this membership is read, not only the action's key: the
  // ownership-override capability in SPEC-06 §3.1 is a DIFFERENT key evaluated
  // at L5.1, and a query filtered to `action.key` would silently make every
  // grant-based override fail.
  const grantRows = (await query
    .selectFrom('capability_grants')
    .select(['capability_key', 'granted', 'valid_from', 'valid_to'])
    .where('organization_id', '=', context.expectedOrganizationId)
    .where('membership_id', '=', context.membershipId)
    .execute()) as unknown as GrantRow[];

  const grants: readonly GrantInput[] = grantRows.map((row) => ({
    capabilityKey: row.capability_key,
    granted: row.granted,
    validFrom: instantOf(row.valid_from) ?? UNPARSABLE_INSTANT,
    validTo: row.valid_to === null ? null : (instantOf(row.valid_to) ?? UNPARSABLE_INSTANT),
  }));

  return {
    context,
    organization,
    group,
    entitlement,
    moduleDependencies,
    availability,
    membership: groupScoped ? membership : null,
    role: groupScoped ? role : null,
    roleCapabilities: groupScoped ? roleCapabilities : [],
    organizationMembership: groupScoped ? null : membership,
    organizationRole: groupScoped ? null : role,
    organizationRoleCapabilities: groupScoped ? [] : roleCapabilities,
    grants,
    // SPEC-06 §3.2 and §3.3. `onBehalfOfMembershipId` is always null in this
    // milestone (SPEC-01 §2.2's declaration carries no proxy or impersonation
    // channel yet), so passing `null` here is the accurate snapshot rather than
    // a stub — and the evaluator's L6 is exercised by the pure battery, which
    // does not need a wire format to reach it.
    proxy: null,
    impersonation: null,
    target: options.target ?? null,
    action,
    now: nowIso,
  };
}
