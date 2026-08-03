/**
 * The evaluator's verdict, and the `404`-vs-`403` discipline that goes with it.
 *
 * ```
 * authorize(ctx, action, target?) -> Allow | Deny(reason)      -- SPEC-06 §1
 * ```
 *
 * ## The explanation never reaches a client
 *
 * A `Deny` carries the step that produced it and a human-readable `reason`. Both
 * are **server-side diagnostics**. SPEC-06 P-3 — "a user must not learn a
 * module's shape from a permission error" — and SPEC-01 §2.4 — every forgery and
 * cross-tenant probe answers a byte-identical `404` — mean the wire form of a
 * denial is a fixed body with a fixed code, chosen from `disclosure` alone.
 *
 * That is enforced rather than promised: `denialDisclosure` is the only function
 * that maps a reason to a wire outcome, it returns an enum rather than a string,
 * and `apps/api/test/authz/no-explanation-leaks.test.ts` drives every reason
 * through the HTTP surface and asserts the reason text appears in **no** response
 * body and in no header.
 */

/** Which numbered row of SPEC-06 §2 produced the verdict. */
export type PolicyStep =
  | 'L0.1'
  | 'L0.2'
  | 'L1.1'
  | 'L1.2'
  | 'L1.3'
  | 'L1.4'
  | 'L2.1'
  | 'L3.1'
  | 'L3.2'
  | 'L3.3'
  | 'L4.1'
  | 'L4.2'
  | 'L5.1'
  | 'L6.1'
  | 'L6.2'
  /**
   * Not a row of the table. It is the verdict for an input the table cannot be
   * evaluated against at all — an unknown capability key, or a declared scope
   * that disagrees with the catalogue. SPEC-06 P-4 makes those **build**
   * failures (A-14/A-16); this is the runtime backstop for the case where one
   * slips past the build, and it denies.
   */
  | 'P-4';

/**
 * The denial reasons SPEC-06 §2 names, plus `UNDECLARED_ACTION` for P-4's
 * fail-closed backstop.
 *
 * Every one of these is an internal identifier. None of them is a wire code.
 */
export type DenyReason =
  | 'ORG_INACTIVE'
  | 'GROUP_INACTIVE'
  | 'NOT_ENTITLED'
  | 'ENTITLEMENT_SUSPENDED'
  | 'ENTITLEMENT_REVOKED'
  | 'ENTITLEMENT_EXPIRED'
  | 'MODULE_DEPENDENCY_UNSATISFIED'
  | 'MODULE_UNAVAILABLE_IN_GROUP'
  | 'NO_MEMBERSHIP'
  | 'NO_ORG_MEMBERSHIP'
  | 'MEMBERSHIP_INVITED'
  | 'MEMBERSHIP_SUSPENDED'
  | 'MEMBERSHIP_ENDED'
  | 'MEMBERSHIP_EXPIRED'
  | 'EXPLICIT_DENY'
  | 'NO_CAPABILITY'
  | 'OBJECT_POLICY'
  | 'PROXY_INVALID'
  | 'PROXY_SCOPE'
  | 'PROXY_GRANTOR_DENIED'
  /**
   * SPEC-06 §3.2 lists it — "A suspended proxy cannot act". **The evaluator
   * cannot produce it, by construction:** reaching L6.1 means L3.2 and L3.3
   * already passed for the acting membership, which is the proxy. The reason is
   * kept because the spec names it and because a future proxy design that
   * evaluated the proxy's OTHER memberships would need it; `evaluate.ts` has no
   * branch for it, and `named-cases.test.ts` asserts that stays true.
   */
  | 'PROXY_MEMBERSHIP'
  | 'IMPERSONATION_EXPIRED'
  | 'IMPERSONATION_FORBIDDEN_SURFACE'
  | 'UNDECLARED_ACTION';

/**
 * What the caller may be told.
 *
 * `not-found` → the single, byte-identical `404` (SPEC-01 §2.4).
 * `forbidden` → `403` with a fixed body.
 */
export type Disclosure = 'not-found' | 'forbidden';

export interface Allow {
  readonly allowed: true;
  /**
   * The capability key that was satisfied, and how. Diagnostics and — once
   * OPUS-M1-003 lands — the audit payload's authorization attribution.
   */
  readonly via: 'role' | 'grant';
}

export interface Deny {
  readonly allowed: false;
  readonly step: PolicyStep;
  readonly reason: DenyReason;
  /** Server-side only. Never a response body, never a header. */
  readonly explanation: string;
}

export type Decision = Allow | Deny;

/**
 * P-5 and P-6, as one total function.
 *
 * > **P-5** A denial at L0–L2 is reported as `404`. Existence of an unentitled
 * > module is not disclosed.
 * >
 * > **P-6** A denial at L3–L6 is reported as `403` where the actor may know the
 * > object exists, and `404` where knowing that is itself disclosure.
 *
 * The L3 rows resolve to `404` and that is the load-bearing reading: a denial at
 * L3 means the actor holds **no usable membership in the declared tenant**, so
 * they are exactly the "departed member, leaked report, shared URL" actor
 * SPEC-01 §2.4 says must learn nothing. L4 onwards resolves to `403`, because
 * reaching L4 requires an active membership — the tenant's existence is already
 * known to them and `403` discloses nothing new.
 *
 * `OBJECT_POLICY` is `404` here **deliberately**. Its `409
 * CONTEXT_TARGET_MISMATCH` case is not a property of the reason but of the actor
 * (SPEC-01 §2.3 step 6, V-07: `409` only for an actor who passed L4 in their
 * declared tenant), so it is decided by `bindTarget`, which has that fact.
 * Defaulting the reason itself to `404` means a caller that forgets to route
 * through `bindTarget` discloses nothing.
 */
const DISCLOSURE_BY_REASON: Readonly<Record<DenyReason, Disclosure>> = {
  /* L0, L1, L2 — P-5. */
  ORG_INACTIVE: 'not-found',
  GROUP_INACTIVE: 'not-found',
  NOT_ENTITLED: 'not-found',
  ENTITLEMENT_SUSPENDED: 'not-found',
  ENTITLEMENT_REVOKED: 'not-found',
  ENTITLEMENT_EXPIRED: 'not-found',
  MODULE_DEPENDENCY_UNSATISFIED: 'not-found',
  MODULE_UNAVAILABLE_IN_GROUP: 'not-found',

  /* L3 — no usable membership: the actor must not learn the tenant exists. */
  NO_MEMBERSHIP: 'not-found',
  NO_ORG_MEMBERSHIP: 'not-found',
  MEMBERSHIP_INVITED: 'not-found',
  MEMBERSHIP_SUSPENDED: 'not-found',
  MEMBERSHIP_ENDED: 'not-found',
  MEMBERSHIP_EXPIRED: 'not-found',

  /* L5.1 — see the docblock above. */
  OBJECT_POLICY: 'not-found',

  /* P-4's backstop discloses nothing about why. */
  UNDECLARED_ACTION: 'not-found',

  /* L4, L6 — the actor holds an active membership here. */
  EXPLICIT_DENY: 'forbidden',
  NO_CAPABILITY: 'forbidden',
  PROXY_INVALID: 'forbidden',
  PROXY_SCOPE: 'forbidden',
  PROXY_GRANTOR_DENIED: 'forbidden',
  PROXY_MEMBERSHIP: 'forbidden',
  IMPERSONATION_EXPIRED: 'forbidden',
  IMPERSONATION_FORBIDDEN_SURFACE: 'forbidden',
};

/**
 * A `Record` rather than a `switch`, for one reason worth stating: `Record<
 * DenyReason, Disclosure>` makes TypeScript require an entry for **every**
 * reason, so adding a denial reason without deciding what it may disclose is a
 * compile error rather than an unreachable `switch` arm returning `undefined`.
 * A new reason must never default to anything.
 */
export function denialDisclosure(reason: DenyReason): Disclosure {
  return DISCLOSURE_BY_REASON[reason];
}

/**
 * True when the decision means "the actor holds the capability for this action
 * in the tenant they declared, evaluated **without** the object-policy layer".
 *
 * That is the exact predicate SPEC-01 §2.3 step 6 (V-07) needs to choose between
 * `409 CONTEXT_TARGET_MISMATCH` and `404`, and it is why SPEC-06 places tenant
 * binding at L5.1 **after** L4 rather than before it: L5.1 cannot run against an
 * object in another tenant, so the question has to be answerable without it.
 */
export function passedCapabilityLayer(decision: Decision): boolean {
  if (decision.allowed) return true;
  return decision.step === 'L5.1' || decision.step === 'L6.1' || decision.step === 'L6.2';
}

export function allow(via: Allow['via']): Allow {
  return { allowed: true, via };
}

export function deny(step: PolicyStep, reason: DenyReason, explanation: string): Deny {
  return { allowed: false, step, reason, explanation };
}
