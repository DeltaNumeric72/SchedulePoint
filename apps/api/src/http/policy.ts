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
 * Fastify's per-route `config` object, narrowed to the field the gate reads.
 *
 * Declaring a route without this is exactly the failure the gate exists to
 * catch, so the type is intentionally not enforced at the framework level: a
 * type-level-only guarantee would be silently satisfiable with a cast, and the
 * point is to check the *registered* route table at runtime.
 */
export interface RouteConfigWithPolicy {
  readonly policy: RoutePolicy;
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
