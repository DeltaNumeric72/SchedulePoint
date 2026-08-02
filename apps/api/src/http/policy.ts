/**
 * Route policy declarations.
 *
 * I-02: authorization is deny-by-default; **an operation with no policy fails
 * closed and fails its automated test.** The scaffold implements the second half
 * of that sentence: `scripts/gates/route-policy-check.ts` enumerates every route
 * Fastify actually registered and fails the build if any of them lacks a policy.
 *
 * There is no authorization *evaluator* here — that is SPEC-06 work for a later
 * packet. What exists now is the declaration slot and the gate that proves the
 * slot is always filled.
 */

/** A route reachable without an authenticated principal. Requires a written reason. */
export interface PublicPolicy {
  readonly kind: 'public';
  /** Why this route may be anonymous. Reviewed on every change. */
  readonly reason: string;
}

/**
 * A route gated by a capability from the 58-capability baseline.
 *
 * Not yet reachable in the scaffold — no product routes exist. The variant is
 * declared so the policy union is closed from the start and the gate has a real
 * shape to check against.
 */
export interface CapabilityPolicy {
  readonly kind: 'capability';
  /** `CAP-###` from the capability baseline. */
  readonly capability: string;
}

/** A route reachable only from inside the deployment boundary (never via the ALB). */
export interface InternalPolicy {
  readonly kind: 'internal';
  readonly reason: string;
}

export type RoutePolicy = PublicPolicy | CapabilityPolicy | InternalPolicy;

/**
 * **PROVISIONAL authorization, replaced wholesale by OPUS-M1-002.**
 *
 * OPUS-M1-001's packet says this task "may register routes with explicit
 * placeholder policies that **deny** everything except the context-verification
 * paths under test". This is that placeholder, and it is written so that it can
 * only ever be more restrictive than the real thing:
 *
 *  - the **only** input is the acting membership's role;
 *  - the **only** allow is an exact match against an explicitly listed role;
 *  - an absent or empty list denies (I-02, deny-by-default);
 *  - there is no wildcard, no "admin implies everything", and no negation.
 *
 * It is not an evaluator and must not grow into one. SPEC-06's fourteen-step
 * truth table — entitlements, module availability, grants, explicit deny,
 * object policy, proxy, impersonation — is a separate packet, and every one of
 * those layers can only *remove* access relative to this list.
 */
export interface ProvisionalAuthorization {
  /**
   * Roles permitted to perform this action, pending the SPEC-06 evaluator.
   *
   * A group-scoped route lists group roles; an organization-scoped route lists
   * organization roles. The two namespaces do not overlap (SPEC-06 P-10).
   */
  readonly allowRoles: readonly string[];
  /** Why these roles, in one sentence. Reviewed on every change. */
  readonly rationale: string;
}

/**
 * Fastify's per-route `config` object.
 *
 * The union is the point: a **capability** route must also declare its
 * `actionScope` (SPEC-01 §2.1 / SPEC-06 §1.1) and its provisional authorization,
 * while a `public` or `internal` route addresses no tenant and declares neither.
 *
 * The type is not the enforcement. A type-level-only guarantee is satisfiable
 * with a cast, so `scripts/gates/route-policy-check.mjs` checks the *registered*
 * route table at runtime, and `apps/api/test/http/route-declarations.test.ts`
 * asserts the scope half of the same rule against every route the server
 * actually registers.
 */
export type RouteConfigWithPolicy =
  | { readonly policy: PublicPolicy | InternalPolicy }
  | {
      readonly policy: CapabilityPolicy;
      /** SPEC-01 §2.1 (V-06): declared by the route, never inferred from the URL. */
      readonly actionScope: 'group' | 'organization';
      readonly provisional: ProvisionalAuthorization;
    };

/** The capability arm of `RouteConfigWithPolicy`, for code that has narrowed it. */
export interface CapabilityRouteConfig {
  readonly policy: CapabilityPolicy;
  readonly actionScope: 'group' | 'organization';
  readonly provisional: ProvisionalAuthorization;
}

/**
 * Narrows an unknown route config to the capability arm.
 *
 * Returns `undefined` for a public or internal route — and for a capability
 * route whose scope or provisional declaration is missing, which the middleware
 * treats as a hard failure rather than as "no context needed". A route that
 * declares a capability and forgets its scope must fail closed.
 */
export function capabilityRouteConfig(config: unknown): CapabilityRouteConfig | undefined {
  if (typeof config !== 'object' || config === null) return undefined;
  const candidate = config as {
    policy?: unknown;
    actionScope?: unknown;
    provisional?: unknown;
  };
  if (!isRoutePolicy(candidate.policy) || candidate.policy.kind !== 'capability') return undefined;
  if (candidate.actionScope !== 'group' && candidate.actionScope !== 'organization') {
    return undefined;
  }
  const provisional = candidate.provisional as ProvisionalAuthorization | undefined;
  if (
    typeof provisional !== 'object' ||
    provisional === null ||
    !Array.isArray(provisional.allowRoles)
  ) {
    return undefined;
  }
  return {
    policy: candidate.policy,
    actionScope: candidate.actionScope,
    provisional,
  };
}

/** True when the route declares a capability policy, however well-formed. */
export function declaresCapability(config: unknown): boolean {
  if (typeof config !== 'object' || config === null) return false;
  const policy = (config as { policy?: unknown }).policy;
  return isRoutePolicy(policy) && policy.kind === 'capability';
}

/**
 * The provisional verdict: does the acting membership's role appear in the
 * route's list?
 *
 * This is SPEC-06 L4.2's *shape* and nothing else. It is deliberately not called
 * `authorize`, because a function called `authorize` that skips L0–L3 is a trap
 * for the next reader.
 */
export function provisionallyAuthorized(
  config: CapabilityRouteConfig,
  membership: { readonly kind: 'organization' | 'group'; readonly role: string | null },
): boolean {
  if (membership.role === null) return false;
  // P-8/P-9: the scopes are disjoint. A group role can only satisfy a
  // group-scoped route, and an organization role only an organization-scoped one.
  if (config.actionScope === 'group' && membership.kind !== 'group') return false;
  if (config.actionScope === 'organization' && membership.kind !== 'organization') return false;
  return config.provisional.allowRoles.includes(membership.role);
}

export function isRoutePolicy(value: unknown): value is RoutePolicy {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'public' || kind === 'internal') {
    return typeof (value as { reason?: unknown }).reason === 'string';
  }
  if (kind === 'capability') {
    return /^CAP-\d{3}$/.test(String((value as { capability?: unknown }).capability));
  }
  return false;
}

export function describePolicy(policy: RoutePolicy): string {
  switch (policy.kind) {
    case 'public':
      return `public (${policy.reason})`;
    case 'internal':
      return `internal (${policy.reason})`;
    case 'capability':
      return `capability ${policy.capability}`;
  }
}
