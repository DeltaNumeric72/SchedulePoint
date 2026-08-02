/**
 * SPEC-01 §2.3 — the validation sequence, and §3 — target aggregate binding.
 *
 * Both are **pure functions over a snapshot**. The caller resolves the snapshot
 * inside a unit of work (so RLS applies to the resolution query itself, §3) and
 * passes it in. That split is what lets the §7.1 harness enumerate every branch
 * without a database, and it is why there is exactly one implementation of the
 * sequence rather than one per surface.
 *
 * > Executed in order; **the first failure aborts before any write and before
 * > any event.**
 */

import {
  authorizationVersionOf,
  contextVersionsMatch,
  type ContextVersion,
  type DeclaredContext,
  type RequestContext,
} from './request-context.js';

/* ────────────────────────────────────────────────────────────────────────────
 * The snapshot: what the server knows, read under RLS in the declared tenant.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface OrganizationSnapshot {
  readonly id: string;
  readonly status: 'active' | 'inactive';
  readonly organizationVersion: number;
}

export interface GroupSnapshot {
  readonly id: string;
  readonly organizationId: string;
  readonly status: 'active' | 'inactive';
  readonly groupVersion: number;
}

export type MembershipKind = 'organization' | 'group';
export type MembershipStatus = 'invited' | 'active' | 'suspended' | 'ended';

export interface MembershipSnapshot {
  readonly id: string;
  readonly kind: MembershipKind;
  readonly organizationId: string;
  readonly groupId: string | null;
  readonly userId: string;
  readonly status: MembershipStatus;
  readonly organizationRole: string | null;
  readonly groupRole: string | null;
  readonly validFrom: string;
  readonly validTo: string | null;
}

export interface PrincipalSnapshot {
  readonly id: string;
  readonly status: 'active' | 'deactivated';
  readonly membershipSetVersion: number;
  readonly sessionEpoch: number;
}

/**
 * Everything §2.3 needs, resolved once, inside one unit of work.
 *
 * A `null` field means "not visible in the declared tenant", which under RLS is
 * indistinguishable from "does not exist" — and that indistinguishability is the
 * point: §2.3's first three steps all answer `404`.
 */
export interface ContextSnapshot {
  readonly organization: OrganizationSnapshot | null;
  readonly group: GroupSnapshot | null;
  readonly membership: MembershipSnapshot | null;
  readonly principal: PrincipalSnapshot | null;
  /** ISO-8601 instant the snapshot was taken, for the membership validity window. */
  readonly now: string;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Outcomes
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The failure codes §2.3 can produce.
 *
 * `NOT_FOUND` is the response for **every** step 1–3 failure, deliberately: a
 * forged organization, a forged group, a group in another organization, a
 * revoked membership and a non-existent id are byte-identical to the caller
 * (§2.4). Distinguishing them is the disclosure.
 */
export type ContextFailureCode =
  | 'NOT_FOUND'
  | 'CONTEXT_STALE'
  | 'SESSION_STALE'
  | 'CONTEXT_TARGET_MISMATCH';

/** Which numbered step produced the failure. Server-side diagnostics only. */
export type ContextStep = 1 | 2 | 3 | 4 | 5 | 6;

export interface ContextFailure {
  readonly code: ContextFailureCode;
  readonly step: ContextStep;
  /**
   * Server-side reason, for the log and the security event. **Never sent to a
   * client** — it is exactly the disclosure §2.4 is preventing.
   */
  readonly reason: string;
  /** §7.1 T-04: a forged declaration is logged as a security event. */
  readonly securityEvent: boolean;
}

export type ContextVerification =
  | { readonly ok: true; readonly context: RequestContext }
  | { readonly ok: false; readonly failure: ContextFailure };

function deny(
  step: ContextStep,
  reason: string,
  options: { code?: ContextFailureCode; securityEvent?: boolean } = {},
): ContextVerification {
  return {
    ok: false,
    failure: {
      code: options.code ?? 'NOT_FOUND',
      step,
      reason,
      securityEvent: options.securityEvent ?? false,
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * §2.3 — the validation sequence
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Is a membership usable right now? SPEC-06 L3.2 (`status = active`) and L3.3
 * (`now ∈ [valid_from, valid_to)`), which together are what SPEC-01 §2.3 step 2
 * means by "is `active`".
 */
export function membershipIsActive(membership: MembershipSnapshot, now: string): boolean {
  if (membership.status !== 'active') return false;
  const at = Date.parse(now);
  if (Number.isNaN(at)) return false;
  if (at < Date.parse(membership.validFrom)) return false;
  if (membership.validTo !== null && at >= Date.parse(membership.validTo)) return false;
  return true;
}

/**
 * SPEC-01 §2.3, steps 1–5, in order.
 *
 * Step 6 (target aggregate binding) needs the target, which the caller resolves
 * separately — see `bindTarget`. Step 7 (authorization) is SPEC-06's evaluator.
 */
export function verifyDeclaredContext(
  declared: DeclaredContext,
  snapshot: ContextSnapshot,
): ContextVerification {
  /* ── 1. `expected_organization_id` exists and is active ─────────────────── */
  const organization = snapshot.organization;
  if (organization === null) {
    return deny(1, 'declared organization is not visible in its own tenant context', {
      securityEvent: true,
    });
  }
  if (organization.id !== declared.expectedOrganizationId) {
    // Defence against a resolver bug: the snapshot must be *of* the declared
    // tenant. Substituting a different organization is precisely what I-14 bans.
    return deny(1, 'resolved organization does not match the declared organization');
  }
  if (organization.status !== 'active') {
    return deny(1, 'declared organization is not active');
  }

  /* ── 2. membership exists and is active, per the declared scope ─────────── */
  const membership = snapshot.membership;
  if (membership === null) {
    return deny(
      2,
      `no ${declared.actionScope} membership for the principal in the declared tenant`,
      { securityEvent: true },
    );
  }
  if (membership.userId !== declared.principalUserId) {
    return deny(2, 'resolved membership belongs to a different principal');
  }
  if (membership.organizationId !== declared.expectedOrganizationId) {
    return deny(2, 'resolved membership belongs to a different organization');
  }
  if (!membershipIsActive(membership, snapshot.now)) {
    return deny(2, `membership is ${membership.status} or outside its validity window`);
  }

  if (declared.actionScope === 'group') {
    // The group branch: a GROUP membership, of the declared group.
    if (membership.kind !== 'group') {
      return deny(2, 'an organization membership never satisfies a group-scoped action (P-8)');
    }
    if (membership.groupId === null || membership.groupId !== declared.expectedGroupId) {
      return deny(2, 'membership is not in the declared group');
    }
    if (membership.groupRole === null) {
      return deny(2, 'group membership carries no group role');
    }
  } else {
    // The organization branch: an ORGANIZATION membership carrying an
    // organization role. SPEC-06 P-9: a group role never satisfies an
    // organization-scoped action. T-06c is exactly this line.
    if (membership.kind !== 'organization') {
      return deny(2, 'a group membership never satisfies an organization-scoped action (P-9)');
    }
    if (membership.groupId !== null) {
      return deny(2, 'organization membership must not name a group');
    }
    if (membership.organizationRole === null) {
      return deny(2, 'organization membership carries no organization role');
    }
  }

  /* ── 3. the group declaration matches the declared scope ────────────────── */
  if (declared.actionScope === 'group') {
    // T-06d: the branch is selected by the route's declared scope, never by the
    // presence or absence of the field. A group-scoped action with no group is a
    // 404, not an implicit organization-scoped action.
    if (declared.expectedGroupId === null) {
      return deny(3, 'group-scoped action declared no group');
    }
    const group = snapshot.group;
    if (group === null) {
      return deny(3, 'declared group is not visible in the declared organization', {
        securityEvent: true,
      });
    }
    if (group.id !== declared.expectedGroupId) {
      return deny(3, 'resolved group does not match the declared group');
    }
    if (group.organizationId !== declared.expectedOrganizationId) {
      return deny(3, 'declared group belongs to a different organization');
    }
    if (group.status !== 'active') {
      return deny(3, 'declared group is not active');
    }
  } else if (declared.expectedGroupId !== null) {
    return deny(3, 'organization-scoped action declared a group');
  }

  /* ── the principal must exist and be usable ─────────────────────────────── */
  const principal = snapshot.principal;
  if (principal === null || principal.id !== declared.principalUserId) {
    return deny(2, 'principal is not visible in the declared tenant');
  }
  if (principal.status !== 'active') {
    return deny(2, 'principal is deactivated');
  }

  const current: ContextVersion = {
    organizationVersion: organization.organizationVersion,
    groupVersion: declared.actionScope === 'group' ? (snapshot.group?.groupVersion ?? null) : null,
    membershipSetVersion: principal.membershipSetVersion,
  };

  /* ── 4. context_version matches ─────────────────────────────────────────── */
  //
  // A missing declaration is stale, not exempt. "The path segment is not
  // sufficient on its own — it identifies the tenant but not the freshness.
  // Both are required." (§2.2)
  if (declared.contextVersion === null) {
    return deny(4, 'no context version declared', { code: 'CONTEXT_STALE' });
  }
  if (!contextVersionsMatch(declared.contextVersion, current)) {
    return deny(4, 'declared context version does not match current counters', {
      code: 'CONTEXT_STALE',
    });
  }

  /* ── 5. session_epoch matches ───────────────────────────────────────────── */
  if (declared.sessionEpoch === null) {
    return deny(5, 'no session epoch declared', { code: 'SESSION_STALE' });
  }
  if (declared.sessionEpoch !== principal.sessionEpoch) {
    return deny(5, 'declared session epoch does not match the current epoch', {
      code: 'SESSION_STALE',
    });
  }

  return {
    ok: true,
    context: {
      principalUserId: declared.principalUserId,
      actionScope: declared.actionScope,
      expectedOrganizationId: declared.expectedOrganizationId,
      expectedGroupId: declared.expectedGroupId,
      membershipId: membership.id,
      contextVersion: current,
      sessionEpoch: principal.sessionEpoch,
      authorizationVersion: authorizationVersionOf(current, principal.sessionEpoch),
      correlationId: declared.correlationId,
      onBehalfOfMembershipId: declared.onBehalfOfMembershipId,
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * §3 — target aggregate binding (§2.3 step 6)
 * ──────────────────────────────────────────────────────────────────────────── */

export interface TargetDescriptor {
  readonly organizationId: string;
  readonly groupId: string | null;
  readonly aggregateType: string;
}

export type TargetBinding =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: ContextFailure };

/**
 * SPEC-01 §3 / §2.3 step 6, with the V-07 disclosure rule.
 *
 * > | Actor is authorized for this action in the **declared** tenant | Response |
 * > | Yes | **`409 CONTEXT_TARGET_MISMATCH`** — a genuine stale-tab condition |
 * > | No  | **`404`** — identical to "does not exist" |
 *
 * `authorizedInDeclaredTenant` is the ordinary SPEC-06 capability evaluation for
 * the declared tenant **without** the object-policy layer — L5.1 cannot run
 * against an object in another tenant, which is exactly why SPEC-06 places
 * tenant binding at L5.1, after L4.
 *
 * @param target `null` when the id resolved to nothing the caller can see. That
 *               is a plain `404` whatever the actor holds: there is nothing to
 *               mismatch against, and saying otherwise would confirm existence.
 */
export function bindTarget(
  context: RequestContext,
  target: TargetDescriptor | null,
  expectedAggregateType: string,
  authorizedInDeclaredTenant: boolean,
): TargetBinding {
  const mismatch = (reason: string): TargetBinding => ({
    ok: false,
    failure: {
      code: authorizedInDeclaredTenant ? 'CONTEXT_TARGET_MISMATCH' : 'NOT_FOUND',
      step: 6,
      reason,
      // A holder of a UUID from a tenant they have no capability in is probing.
      securityEvent: !authorizedInDeclaredTenant,
    },
  });

  if (target === null) {
    return {
      ok: false,
      failure: { code: 'NOT_FOUND', step: 6, reason: 'target does not resolve', securityEvent: false },
    };
  }
  if (target.aggregateType !== expectedAggregateType) {
    return mismatch('target is not the aggregate type this route operates on');
  }
  if (target.organizationId !== context.expectedOrganizationId) {
    return mismatch('target belongs to a different organization');
  }
  if (context.actionScope === 'group' && target.groupId !== context.expectedGroupId) {
    return mismatch('target belongs to a different group');
  }
  return { ok: true };
}
