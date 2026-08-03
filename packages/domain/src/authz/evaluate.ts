/**
 * SPEC-06 §2 — the normative truth table, as one pure function.
 *
 * > **Evaluated strictly in order. The first `DENY` terminates evaluation. There
 * > is no later layer that can rescue an earlier denial.**
 *
 * ## The rows, and where each one is
 *
 * | Row | Here |
 * |---|---|
 * | L0.1 organization active | `step0` |
 * | L0.2 group active (group scope only) | `step0` |
 * | L1.1 entitlement row exists | `step1` |
 * | L1.2 state ∈ {trial, active} | `step1` |
 * | L1.3 now ∈ window | `step1` |
 * | L1.4 every declared dependency satisfied by L1.1–L1.3 | `step1` |
 * | L2.1 module available in group (group scope only) | `step2` |
 * | L3.1 membership exists, per scope | `step3` |
 * | L3.2 membership active | `step3` |
 * | L3.3 now ∈ membership window | `step3` |
 * | L4.1 in-window explicit deny | `step4` |
 * | L4.2 in-window explicit allow **or** role capability | `step4` |
 * | L5.1 object policy | `step5` |
 * | L6.1 proxy constraints | `step6` |
 * | L6.2 impersonation constraints | `step6` |
 *
 * **Fifteen rows, not fourteen.** The packet and the objective line call this
 * "the fourteen-step truth table"; SPEC-06 §2's table as amended 2026-08-01
 * (V-24, V-26) has fifteen numbered rows plus the terminal ALLOW. All fifteen are
 * implemented and all fifteen are asserted; the count discrepancy is recorded in
 * `docs/evidence/EV-M1-AUTHZ/INDEX.md` §6 rather than resolved by dropping a row
 * to make the number match.
 *
 * ## Purity, and why it is not decoration
 *
 * No I/O, no clock, no randomness: `now` is an input. That is what makes SPEC-06
 * §8.1's generated cross-product possible — every combination can be evaluated
 * without a database, so the battery is exhaustive rather than sampled, and it
 * runs in milliseconds so nobody is tempted to sample it later.
 */

import {
  capabilityDefinition,
  moduleClosure,
  type ModuleKey,
} from './catalogue.js';
import {
  allow,
  deny,
  type Decision,
  type Deny,
  type DenyReason,
} from './decision.js';
import type {
  EntitlementInput,
  GrantInput,
  Instant,
  MembershipInput,
  PolicyInput,
} from './policy-input.js';

/* ────────────────────────────────────────────────────────────────────────────
 * Window arithmetic — `now ∈ [from, to)`, half-open, in every layer.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Half-open containment, with an unparseable instant treated as **outside**.
 *
 * Fail-closed on a malformed date rather than throwing: a throw from a pure
 * evaluator becomes a 500, and a 500 on a malformed stored timestamp is an
 * availability bug where a denial is the safe answer.
 */
export function withinWindow(now: Instant, from: Instant, to: Instant | null): boolean {
  const at = Date.parse(now);
  const start = Date.parse(from);
  if (Number.isNaN(at) || Number.isNaN(start)) return false;
  if (at < start) return false;
  if (to === null) return true;
  const end = Date.parse(to);
  if (Number.isNaN(end)) return false;
  return at < end;
}

/* ────────────────────────────────────────────────────────────────────────────
 * L0 — organization and group status
 * ──────────────────────────────────────────────────────────────────────────── */

function step0(input: PolicyInput): Deny | undefined {
  /* L0.1 */
  const organization = input.organization;
  if (organization === null) {
    // Not visible in its own tenant context. Indistinguishable from inactive to
    // the caller, and both answer 404 — but the reasons are kept apart in the
    // log because one is a data problem and the other is an attack signature.
    return deny('L0.1', 'ORG_INACTIVE', 'the declared organization is not visible');
  }
  if (organization.id !== input.context.expectedOrganizationId) {
    return deny(
      'L0.1',
      'ORG_INACTIVE',
      'the organization in the snapshot is not the declared organization',
    );
  }
  if (organization.status !== 'active') {
    return deny('L0.1', 'ORG_INACTIVE', `organization status is ${organization.status}`);
  }

  /* L0.2 — group scope only. "`scope = organization`: skipped" (V-24). */
  if (input.action.scope === 'group') {
    const group = input.group;
    if (group === null) {
      return deny('L0.2', 'GROUP_INACTIVE', 'the declared group is not visible');
    }
    if (group.id !== input.context.expectedGroupId) {
      return deny('L0.2', 'GROUP_INACTIVE', 'the group in the snapshot is not the declared group');
    }
    if (group.status !== 'active') {
      return deny('L0.2', 'GROUP_INACTIVE', `group status is ${group.status}`);
    }
  }
  return undefined;
}

/* ────────────────────────────────────────────────────────────────────────────
 * L1 — entitlement, and the dependency closure
 * ──────────────────────────────────────────────────────────────────────────── */

const ENTITLED_STATES: readonly EntitlementInput['state'][] = ['trial', 'active'];

/** L1.1–L1.3 for one module. Returns the failing reason, or `undefined`. */
function entitlementFailure(
  entitlement: EntitlementInput | null,
  now: Instant,
): { reason: DenyReason; detail: string } | undefined {
  if (entitlement === null) return { reason: 'NOT_ENTITLED', detail: 'no entitlement row exists' };
  if (!ENTITLED_STATES.includes(entitlement.state)) {
    return {
      reason: entitlement.state === 'revoked' ? 'ENTITLEMENT_REVOKED' : 'ENTITLEMENT_SUSPENDED',
      detail: `entitlement state is ${entitlement.state}`,
    };
  }
  if (!withinWindow(now, entitlement.effectiveFrom, entitlement.effectiveTo)) {
    return { reason: 'ENTITLEMENT_EXPIRED', detail: 'now is outside the effective window' };
  }
  return undefined;
}

function step1(input: PolicyInput): Deny | undefined {
  /* The snapshot must be OF the action's module.
   *
   * `load-policy-input.ts` keys the entitlement by module and picks the row in
   * force, but the evaluator is handed a plain object and cannot see that. A
   * caller that assembled the snapshot for a different module would have every
   * L1 layer answer about the wrong thing, and ALLOW. An independent review made
   * exactly that substitution and nothing noticed — and S-01 had already proved
   * the loader is where snapshot bugs live. */
  if (input.entitlement !== null && input.entitlement.moduleKey !== input.action.moduleKey) {
    return deny(
      'L1.1',
      'NOT_ENTITLED',
      `the entitlement in the snapshot is for ${input.entitlement.moduleKey}, not ${input.action.moduleKey}`,
    );
  }
  for (const dependency of input.moduleDependencies) {
    if (
      dependency.entitlement !== null &&
      dependency.entitlement.moduleKey !== dependency.moduleKey
    ) {
      return deny(
        'L1.4',
        'MODULE_DEPENDENCY_UNSATISFIED',
        `the entitlement supplied for ${dependency.moduleKey} is for ${dependency.entitlement.moduleKey}`,
      );
    }
  }

  const own = entitlementFailure(input.entitlement, input.now);
  if (own !== undefined) {
    const step = own.reason === 'NOT_ENTITLED' ? 'L1.1' : own.reason === 'ENTITLEMENT_EXPIRED' ? 'L1.3' : 'L1.2';
    return deny(step, own.reason, `${input.action.moduleKey}: ${own.detail}`);
  }

  /* L1.4 — "Every declared dependency of the module is itself satisfied by
   * L1.1–L1.3". The caller supplies the TRANSITIVE closure; this asserts it did,
   * so a caller that supplied only the direct dependencies fails closed rather
   * than passing a module whose grandparent is revoked. */
  const required = moduleClosure(input.action.moduleKey).filter(
    (key) => key !== input.action.moduleKey,
  );
  const supplied = new Set(input.moduleDependencies.map((d) => d.moduleKey));
  const missing = required.filter((key) => !supplied.has(key));
  if (missing.length > 0) {
    return deny(
      'L1.4',
      'MODULE_DEPENDENCY_UNSATISFIED',
      `the snapshot omits the transitive dependencies ${missing.join(', ')}`,
    );
  }

  for (const dependency of input.moduleDependencies) {
    const failure = entitlementFailure(dependency.entitlement, input.now);
    if (failure !== undefined) {
      return deny(
        'L1.4',
        'MODULE_DEPENDENCY_UNSATISFIED',
        `dependency ${dependency.moduleKey}: ${failure.detail}`,
      );
    }
  }
  return undefined;
}

/* ────────────────────────────────────────────────────────────────────────────
 * L2 — group module availability
 * ──────────────────────────────────────────────────────────────────────────── */

function step2(input: PolicyInput): Deny | undefined {
  /* "`scope = organization`: skipped — availability is a group-level setting" (V-24). */
  if (input.action.scope !== 'group') return undefined;

  const availability = input.availability;
  if (availability === null) {
    // An absent row is NOT available. PO-DEC-04's group-level availability is an
    // explicit enablement, so "no row" means "not enabled here" — the opposite
    // reading would make every new group silently entitled to every module.
    return deny(
      'L2.1',
      'MODULE_UNAVAILABLE_IN_GROUP',
      `no availability row for ${input.action.moduleKey} in this group`,
    );
  }
  if (availability.moduleKey !== input.action.moduleKey) {
    return deny(
      'L2.1',
      'MODULE_UNAVAILABLE_IN_GROUP',
      'the availability row is for a different module',
    );
  }
  if (!availability.available) {
    return deny(
      'L2.1',
      'MODULE_UNAVAILABLE_IN_GROUP',
      `${input.action.moduleKey} is disabled in this group`,
    );
  }
  return undefined;
}

/* ────────────────────────────────────────────────────────────────────────────
 * L3 — the membership selected by the action's scope
 * ──────────────────────────────────────────────────────────────────────────── */

interface SelectedMembership {
  readonly membership: MembershipInput;
  readonly capabilities: readonly string[];
}

type MembershipSelection =
  | { readonly ok: true; readonly selected: SelectedMembership }
  | { readonly ok: false; readonly denial: Deny };

function step3(input: PolicyInput): MembershipSelection {
  const organizationScoped = input.action.scope === 'organization';

  /* L3.1 — which membership, and the P-8/P-9 disjointness. */
  const membership = organizationScoped ? input.organizationMembership : input.membership;
  const role = organizationScoped ? input.organizationRole : input.role;
  const capabilities = organizationScoped
    ? input.organizationRoleCapabilities
    : input.roleCapabilities;
  const absent: DenyReason = organizationScoped ? 'NO_ORG_MEMBERSHIP' : 'NO_MEMBERSHIP';

  if (membership === null) {
    return {
      ok: false,
      denial: deny(
        'L3.1',
        absent,
        organizationScoped
          ? 'no organization membership for the principal in the declared organization (P-9)'
          : 'no group membership for the principal in the declared group (P-8)',
      ),
    };
  }
  if (membership.id !== input.context.membershipId) {
    return {
      ok: false,
      denial: deny(
        'L3.1',
        absent,
        'the membership in the snapshot is not the acting membership resolved at SPEC-01 §2.3 step 2',
      ),
    };
  }
  if (organizationScoped) {
    // "…**and carries an organization role**" (V-24). An organization membership
    // without one does not satisfy L3.1 at all — it is not a role-capability
    // failure at L4.2, and the distinction matters because L3 answers 404 while
    // L4 answers 403.
    if (membership.roleId === null || role === null) {
      return {
        ok: false,
        denial: deny(
          'L3.1',
          'NO_ORG_MEMBERSHIP',
          'the organization membership carries no organization role',
        ),
      };
    }
  }

  /* L3.2 */
  if (membership.status !== 'active') {
    const reason: DenyReason =
      membership.status === 'suspended'
        ? 'MEMBERSHIP_SUSPENDED'
        : membership.status === 'invited'
          ? 'MEMBERSHIP_INVITED'
          : 'MEMBERSHIP_ENDED';
    return {
      ok: false,
      denial: deny('L3.2', reason, `membership status is ${membership.status}`),
    };
  }

  /* L3.3 */
  if (!withinWindow(input.now, membership.validFrom, membership.validTo)) {
    return {
      ok: false,
      denial: deny('L3.3', 'MEMBERSHIP_EXPIRED', 'now is outside the membership validity window'),
    };
  }

  /* The role in the snapshot must be the one the membership names.
   *
   * `role.id` and `membership.roleId` are both the P-10-namespaced role KEY (see
   * `policy-input.ts`). A snapshot pairing one membership's role id with another
   * role's capability set would hand L4.2 the wrong capabilities, and the third
   * inconsistent-snapshot ALLOW an independent review constructed. */
  if (role !== null && membership.roleId !== null && role.id !== membership.roleId) {
    return {
      ok: false,
      denial: deny(
        'L3.1',
        absent,
        `the role in the snapshot (${role.id}) is not the one the membership names (${membership.roleId})`,
      ),
    };
  }
  if (role !== null && membership.roleId === null) {
    return {
      ok: false,
      denial: deny('L3.1', absent, 'a role was supplied for a membership that carries none'),
    };
  }

  return { ok: true, selected: { membership, capabilities: role === null ? [] : capabilities } };
}

/* ────────────────────────────────────────────────────────────────────────────
 * L4 — explicit deny, then explicit allow or role capability
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Is a grant's window expressed in instants this code can compare at all?
 *
 * `timestamptz` accepts `infinity` and `-infinity`, and a stored value can be
 * corrupt for other reasons; `apps/api/src/authz/load-policy-input.ts` maps
 * anything it cannot turn into an ISO string to a sentinel. Either way the
 * comparison is undecidable, and the two layers must treat that **differently
 * depending on which direction the grant points**.
 */
function windowIsComparable(grant: GrantInput): boolean {
  if (Number.isNaN(Date.parse(grant.validFrom))) return false;
  if (grant.validTo === null) return true;
  return !Number.isNaN(Date.parse(grant.validTo));
}

/**
 * In-window ALLOW grants — the positive layer, so an undecidable window is
 * simply not in window. Fail-closed by omission.
 */
function inWindowGrants(
  grants: readonly GrantInput[],
  capabilityKey: string,
  now: Instant,
): readonly GrantInput[] {
  return grants.filter(
    (grant) =>
      grant.capabilityKey === capabilityKey &&
      windowIsComparable(grant) &&
      withinWindow(now, grant.validFrom, grant.validTo),
  );
}

/**
 * Is there an EXPLICIT DENY for this capability that must be honoured?
 *
 * **A deny is a negative layer, and dropping it is fail-OPEN.** `inWindowGrants`
 * filters out a grant whose window cannot be compared; applied to a `granted =
 * false` row that DELETES the denial and the actor keeps the capability. An
 * independent review found it: the same class as L6.2's malformed `expiresAt`,
 * which had already been fixed, on the layer where it matters most.
 *
 * So an undecidable window on a deny **counts as in force**. P-1 says the row is
 * absolute within its validity window; if the window cannot be read, the safe
 * reading of "within" is yes.
 */
function hasExplicitDeny(
  grants: readonly GrantInput[],
  capabilityKey: string,
  now: Instant,
): boolean {
  return grants.some(
    (grant) =>
      grant.capabilityKey === capabilityKey &&
      !grant.granted &&
      (!windowIsComparable(grant) || withinWindow(now, grant.validFrom, grant.validTo)),
  );
}

/**
 * "Does the acting membership hold `capabilityKey` right now", with L4's
 * precedence: **an in-window explicit deny beats an explicit allow and beats the
 * role** (P-1).
 *
 * Shared by L4.2 and by L5.1's ownership override, so the two cannot answer the
 * same question differently — which is exactly what they did before an
 * independent review found it.
 */
function holdsCapability(
  input: PolicyInput,
  selected: SelectedMembership,
  capabilityKey: string,
): boolean {
  if (hasExplicitDeny(input.grants, capabilityKey, input.now)) return false;
  if (inWindowGrants(input.grants, capabilityKey, input.now).some((grant) => grant.granted)) {
    return true;
  }
  return selected.capabilities.includes(capabilityKey);
}

function step4(
  input: PolicyInput,
  selected: SelectedMembership,
): { readonly denial: Deny } | { readonly via: 'role' | 'grant' } {
  /* L4.1 — "explicit deny beats every allow" (P-1). Evaluated FIRST, and it is
   * the only reason P-7's exclusion constraint has to exist: with two overlapping
   * rows the answer would depend on row order. */
  if (hasExplicitDeny(input.grants, input.action.key, input.now)) {
    return {
      denial: deny('L4.1', 'EXPLICIT_DENY', `an in-force deny grant exists for ${input.action.key}`),
    };
  }

  /* L4.2 */
  const relevant = inWindowGrants(input.grants, input.action.key, input.now);
  if (relevant.some((grant) => grant.granted)) return { via: 'grant' };
  if (selected.capabilities.includes(input.action.key)) return { via: 'role' };

  return {
    denial: deny(
      'L4.2',
      'NO_CAPABILITY',
      `neither an in-window allow grant nor the role carries ${input.action.key}`,
    ),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * L5 — object policy
 * ──────────────────────────────────────────────────────────────────────────── */

function step5(input: PolicyInput, selected: SelectedMembership): Deny | undefined {
  if (!input.action.requiresObjectPolicy) return undefined;

  const target = input.target;
  if (target === null) {
    return deny('L5.1', 'OBJECT_POLICY', 'the action requires an object policy but no target was resolved');
  }

  /* Tenant binding — SPEC-06 §3.1, evaluated HERE at L5.1, after L4. */
  if (target.organizationId !== input.context.expectedOrganizationId) {
    return deny('L5.1', 'OBJECT_POLICY', 'the target belongs to a different organization');
  }
  if (input.action.scope === 'group' && target.groupId !== input.context.expectedGroupId) {
    return deny('L5.1', 'OBJECT_POLICY', 'the target belongs to a different group');
  }

  /* Ownership — self-scoped unless a distinct administrative capability is held.
   *
   * **The override is resolved with L4's precedence, not with a bare lookup.**
   * The first version of this branch asked only "does the role list it, or is
   * there an in-window allow grant" — and an independent review pointed out that
   * an in-window `granted = false` row for the override key was read straight
   * past. An administrator who explicitly revokes the override capability from
   * someone whose ROLE also carries it would have seen the revocation land in
   * `capability_grants`, look complete, and change nothing here: the holder kept
   * the override's effect and could still act on objects they do not own.
   *
   * P-1 says an explicit deny is absolute within its validity window. It does not
   * become advisory because the key is being consulted at L5.1 instead of L4.1.
   */
  if (input.action.ownershipRequired === true) {
    const override = input.action.ownershipOverrideCapability;
    const holdsOverride = override !== undefined && holdsCapability(input, selected, override);
    if (!holdsOverride && target.ownerMembershipId !== input.context.membershipId) {
      return deny('L5.1', 'OBJECT_POLICY', 'the target is not owned by the acting membership');
    }
  }

  /* State — "publish requires `approved`; claim requires `posted`". */
  const permitted = input.action.permittedTargetStates;
  if (permitted !== undefined && (target.state === null || !permitted.includes(target.state))) {
    return deny(
      'L5.1',
      'OBJECT_POLICY',
      `target state ${String(target.state)} is not one of ${permitted.join(', ')}`,
    );
  }

  return undefined;
}

/* ────────────────────────────────────────────────────────────────────────────
 * L6 — proxy, then impersonation
 * ──────────────────────────────────────────────────────────────────────────── */

function step6(input: PolicyInput): Deny | undefined {
  /* L6.1 — SPEC-06 §3.2. Only when acting as proxy. */
  const proxy = input.proxy;
  if (proxy !== null) {
    if (proxy.status !== 'active' || !withinWindow(input.now, proxy.validFrom, proxy.validTo)) {
      return deny('L6.1', 'PROXY_INVALID', 'the proxy grant is not active and in window');
    }
    if (proxy.scope !== 'act-on-behalf') {
      return deny('L6.1', 'PROXY_SCOPE', `a ${proxy.scope} proxy cannot act`);
    }
    // SPEC-06 §3.2's fourth row — "The proxy must pass L0–L3 in their own right"
    // — has **no branch here, and cannot have one**. Reaching L6.1 means L3.2 and
    // L3.3 already passed for the acting membership, which IS the proxy; a
    // `PROXY_MEMBERSHIP` denial is unreachable by construction. The first version
    // of this function tested `selected.membership.status !== 'active'` anyway,
    // which read as a control and was dead code. An independent review pointed
    // out that asserting a reason the evaluator cannot produce is worse than not
    // having it, so the branch is gone and the unreachability is asserted
    // instead (`named-cases.test.ts`, "PROXY_MEMBERSHIP is unreachable").
    if (!proxy.grantorPassed) {
      return deny(
        'L6.1',
        'PROXY_GRANTOR_DENIED',
        'the grantor does not independently pass L0–L5 for this action',
      );
    }
  }

  /* L6.2 — SPEC-06 §3.3. */
  const impersonation = input.impersonation;
  if (impersonation !== null) {
    // `withinWindow`, not a bare `Date.parse` comparison. `Date.parse` on a
    // malformed instant yields NaN, and `x >= NaN` is false — so the original
    // spelling treated an unparseable `expiresAt` as STILL VALID. Every other
    // window comparison in this file is fail-closed by construction and this one
    // was the exception; an independent review found it while it was still
    // unreachable, which is the only good time to find it.
    if (!withinWindow(input.now, '1970-01-01T00:00:00.000Z', impersonation.expiresAt)) {
      return deny('L6.2', 'IMPERSONATION_EXPIRED', 'the impersonation window is not open');
    }
    if (impersonation.targetIsCredentialSurface) {
      return deny(
        'L6.2',
        'IMPERSONATION_FORBIDDEN_SURFACE',
        'credential, MFA and token surfaces are unreachable while impersonating',
      );
    }
    // The INTERSECTION rule: impersonation reproduces what a user sees, it does
    // not acquire their access.
    if (!impersonation.operatorHoldsCapability) {
      return deny(
        'L6.2',
        'IMPERSONATION_FORBIDDEN_SURFACE',
        'the operator does not hold this capability in their own right (intersection rule)',
      );
    }
  }

  return undefined;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The evaluator
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * P-4's runtime backstop.
 *
 * A-14 and A-16 make an undeclared action, an unknown capability key and a
 * scope/namespace disagreement **build** failures. This runs anyway, because a
 * build check protects the repository and this protects the request: if a key
 * ever reaches the evaluator that the catalogue does not know, the answer is a
 * denial that discloses nothing, not an exception and not an allow.
 */
function step4Precondition(input: PolicyInput): Deny | undefined {
  const definition = capabilityDefinition(input.action.key);
  if (definition === undefined) {
    return deny('P-4', 'UNDECLARED_ACTION', `${input.action.key} is not in the capability catalogue`);
  }
  if (definition.scope !== input.action.scope) {
    return deny(
      'P-4',
      'UNDECLARED_ACTION',
      `${input.action.key} is declared ${definition.scope}-scoped but the action says ${input.action.scope}`,
    );
  }
  if (definition.module !== (input.action.moduleKey as ModuleKey)) {
    return deny(
      'P-4',
      'UNDECLARED_ACTION',
      `${input.action.key} belongs to module ${definition.module}, not ${input.action.moduleKey}`,
    );
  }
  return undefined;
}

/**
 * `authorize(ctx, action, target?) -> Allow | Deny(reason)`.
 *
 * One evaluator, every surface (SPEC-06 §7, I-19). **A surface with its own
 * authorization logic is a defect.**
 */
export function authorize(input: PolicyInput): Decision {
  const precondition = step4Precondition(input);
  if (precondition !== undefined) return precondition;

  const l0 = step0(input);
  if (l0 !== undefined) return l0;

  const l1 = step1(input);
  if (l1 !== undefined) return l1;

  const l2 = step2(input);
  if (l2 !== undefined) return l2;

  const l3 = step3(input);
  if (!l3.ok) return l3.denial;

  const l4 = step4(input, l3.selected);
  if ('denial' in l4) return l4.denial;

  const l5 = step5(input, l3.selected);
  if (l5 !== undefined) return l5;

  const l6 = step6(input);
  if (l6 !== undefined) return l6;

  return allow(l4.via);
}

/**
 * The same evaluation with the object-policy layer **removed**.
 *
 * SPEC-01 §2.3 step 6 (V-07) needs exactly this: "the ordinary SPEC-06
 * capability evaluation for the declared tenant, evaluated **without** the
 * object-policy layer (which is exactly SPEC-06's L5.1 and cannot run against an
 * object in another tenant)". It is a distinct entry point rather than a flag on
 * `authorize`, so no ordinary caller can accidentally skip L5.1.
 */
export function authorizeWithoutObjectPolicy(input: PolicyInput): Decision {
  return authorize({
    ...input,
    action: { ...input.action, requiresObjectPolicy: false },
    target: null,
  });
}
