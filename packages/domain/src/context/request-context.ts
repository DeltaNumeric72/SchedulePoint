/**
 * SPEC-01 §2 — the request-context tuple.
 *
 * > **I-14 — The client declares which tenant it believes it is addressing. The
 * > server verifies that declaration against server-side membership and against
 * > the target aggregate, and rejects a mismatch. It never substitutes its own
 * > current value.**
 *
 * This file holds the *values*; `./verification.ts` holds the pure §2.3
 * validation sequence and §3 target binding. Nothing here performs I/O, so the
 * whole validation sequence is testable without a database — which is what makes
 * the SPEC-01 §7.1 table-driven harness possible at all.
 *
 * **Context is constructed once per request, job, or socket command, and never
 * mutated thereafter.** There is no setter anywhere in this package, and no code
 * reads a session-global "active group" — §3.1 removed that concept, and the
 * absence is the CAR-001 remediation.
 */

/**
 * SPEC-01 §2.1 (V-06) — every route and command declares its scope.
 *
 * The organization-scoped set is **enumerated in SPEC-06 §1.1** and is closed.
 * An action absent from that enumeration is group-scoped by default: the default
 * is the narrower scope, deliberately.
 */
export type ActionScope = 'group' | 'organization';

/**
 * SPEC-06 §4's freshness counters. SPEC-01 §2.1 (V-08) states no independent
 * list — this is the single source of the definition.
 *
 * `groupVersion` is `null` for an organization-scoped action, which has no group
 * to be fresh about.
 *
 * **Staff availability is not an input.** Bumping a counter on a routine,
 * high-frequency, privilege-free self-service edit would make `409
 * CONTEXT_STALE` an everyday occurrence and train users and implementers alike
 * to engineer around it (SPEC-01 §2.1, V-08).
 */
export interface ContextVersion {
  readonly organizationVersion: number;
  readonly groupVersion: number | null;
  readonly membershipSetVersion: number;
}

/**
 * What the client declared, before any verification.
 *
 * Every `expected*` field is **client-declared and server-verified** — never
 * trusted, and never silently replaced. A forged value fails membership
 * verification exactly as it always did; a *stale* value now fails too, instead
 * of being retargeted at whatever the session currently points to.
 */
export interface DeclaredContext {
  readonly principalUserId: string;
  /** Declared by the route/command definition, never inferred from the payload. */
  readonly actionScope: ActionScope;
  readonly expectedOrganizationId: string;
  /**
   * Required when `actionScope = 'group'`; **null** when
   * `actionScope = 'organization'` (SPEC-01 §2.1, V-06).
   */
  readonly expectedGroupId: string | null;
  /** `null` when the client sent no context header — a stale-by-omission client. */
  readonly contextVersion: ContextVersion | null;
  readonly sessionEpoch: number | null;
  readonly correlationId: string;
  readonly onBehalfOfMembershipId: string | null;
}

/**
 * The verified, immutable tuple a command handler receives.
 *
 * Constructed only by `verifyDeclaredContext`. There is no other constructor,
 * and no field is optional-and-defaulted: a value that could not be verified
 * means the request was rejected, not that the tuple carries a placeholder.
 */
export interface RequestContext {
  readonly principalUserId: string;
  readonly actionScope: ActionScope;
  readonly expectedOrganizationId: string;
  readonly expectedGroupId: string | null;
  /** Derived server-side at §2.3 step 2. Never client-supplied. */
  readonly membershipId: string;
  readonly contextVersion: ContextVersion;
  readonly sessionEpoch: number;
  /** `hash(organization_version, group_version, membership_set_version, session_epoch)`. */
  readonly authorizationVersion: string;
  readonly correlationId: string;
  readonly onBehalfOfMembershipId: string | null;
}

/**
 * SPEC-06 §4: `authorization_version = hash(organization_version, group_version,
 * membership_set_version, session_epoch)`.
 *
 * A canonical, injective encoding rather than a digest. The property the spec
 * needs is "differs whenever any input differs", and an encoding gives that
 * exactly, with no collision risk and no hash dependency in a package that
 * imports nothing. The `av1:` prefix leaves room to change the scheme without
 * two schemes being mistaken for each other.
 */
export function authorizationVersionOf(version: ContextVersion, sessionEpoch: number): string {
  return `av1:${String(version.organizationVersion)}.${
    version.groupVersion === null ? '-' : String(version.groupVersion)
  }.${String(version.membershipSetVersion)}.${String(sessionEpoch)}`;
}

/** Two declared versions are equal only if every counter matches exactly. */
export function contextVersionsMatch(declared: ContextVersion, current: ContextVersion): boolean {
  return (
    declared.organizationVersion === current.organizationVersion &&
    (declared.groupVersion ?? null) === (current.groupVersion ?? null) &&
    declared.membershipSetVersion === current.membershipSetVersion
  );
}
