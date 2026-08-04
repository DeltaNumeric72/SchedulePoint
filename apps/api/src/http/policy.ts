import {
  capabilityDefinition,
  type CapabilityScope,
  type ModuleKey,
} from '@schedulepoint/domain';

/**
 * Route policy declarations.
 *
 * I-02: authorization is deny-by-default; **an operation with no policy fails
 * closed and fails its automated test.** `scripts/gates/route-policy-check.mjs`
 * enumerates every route Fastify actually registered and fails the build if any
 * of them lacks a policy.
 *
 * ## What OPUS-M1-002 changed
 *
 * OPUS-M1-001 shipped a **provisional** declaration: a per-route list of role
 * keys, exact-match, deny-by-default, no wildcard. Its own docblock said it
 * "must not grow into one" — an evaluator — and it has not: it is **gone**,
 * replaced by an `action` declaration that names the SPEC-06 capability key the
 * route's operation requires. The verdict now comes from
 * `packages/domain/src/authz`'s truth table, evaluated per request against
 * current state inside the same unit of work as the mutation (I-19, FAD-12).
 *
 * ## What OPUS-M1-004 changed
 *
 * OPUS-M1-002 had to leave `provisionallyAuthorized` alive for exactly one
 * caller — `apps/api/src/jobs/worker.ts`, which was OPUS-M1-003's parallel file
 * scope — so the job surface authorized on a role allow-list while HTTP
 * authorized on the truth table, and SPEC-06 §7's "one evaluator, every path"
 * was not true. FAD-13 item 1 closed that: the worker calls `evaluateAction`,
 * and **the provisional mechanism is deleted.** There is no second
 * authorization path left to drift from this one.
 *
 * `DeclaredAction` is what let the two surfaces converge without either owning a
 * private notion of what it authorizes: a route config and a job handler declare
 * the same pair of fields and `actionInputOf` reads both.
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
 * `capability` is the **baseline** id (`CAP-###`) and is traceability, not
 * evaluation input: several actions belong to one baseline capability. What the
 * evaluator reads is `action.key`.
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

/**
 * The authentication stage a `preauth` route requires. **Deny-by-default within
 * the class**: there is no "any" value, and a route must name exactly one.
 *
 * | Stage | Requires |
 * |---|---|
 * | `anonymous` | nothing. Sign-in, activation, reset request/complete |
 * | `session-partial` | a live session whose MFA challenge is NOT yet satisfied |
 * | `session-any` | a live session, satisfied or not. Sign-out only |
 */
export type AuthnStage = 'anonymous' | 'session-partial' | 'session-any';

/**
 * A route that PARTICIPATES IN ESTABLISHING OR ENDING AUTHENTICATION ITSELF.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## Why this class exists, and why it does not weaken I-02
 *
 * A capability route asks "may this principal perform this action in this
 * tenant?". Sign-in has no principal yet, so it cannot ask; the MFA challenge
 * has a partial one; sign-out acts on the presented cookie and must work for a
 * session that is already half-dead. Declaring these `public` would be a lie —
 * `public` means "addresses no tenant", and these address one — and giving them
 * a capability would mean inventing a capability nobody can hold before they
 * authenticate.
 *
 * **Deny-by-default is untouched.** I-02's mechanism is that a route with NO
 * policy fails the build, and that is still exactly what happens: this is a
 * fourth `kind` in the union `isRoutePolicy` accepts, not a bypass around it. A
 * route that declares nothing still has `policy === undefined` and still fails
 * `scripts/gates/route-policy-check.mjs`, which is proven by the existing red
 * case (`apps/api/test/red-cases/fixtures/undeclared-route-entry.ts`) and by
 * `apps/api/test/authn/preauth-policy.test.ts`, which registers an undeclared
 * route against the SAME gate analyzer and asserts it is still rejected.
 *
 * **No gate script was modified.** `route-policy-check.mjs` reads
 * `config.policy` and asks whether `isRoutePolicy` accepted it; the vocabulary
 * of policies lives here, in `apps/api/src/http/policy.ts`, which is this
 * packet's file. That is why the packet's escalation condition ("the gate cannot
 * express the pre-auth class without modification") did not fire.
 *
 * ## Three structural constraints, each tested rather than promised
 *
 *  1. **No pre-auth route names another user.** Not one of them has a subject
 *     parameter — no `:userId`, no user identifier in any body schema — so there
 *     is no request that could act on somebody else's account. Asserted over the
 *     REGISTERED route table, not over a list.
 *  2. **The stage is enforced by the middleware**, from this declaration, before
 *     the handler runs. A `session-partial` route reached without a session is a
 *     401 and never reaches a handler.
 *  3. **`reason` is required**, and it is reviewed on every change, exactly as
 *     `PublicPolicy.reason` is.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export interface PreAuthPolicy {
  readonly kind: 'preauth';
  /** Why this route cannot be capability-gated. Reviewed on every change. */
  readonly reason: string;
  readonly stage: AuthnStage;
}

export type RoutePolicy = PublicPolicy | CapabilityPolicy | InternalPolicy | PreAuthPolicy;

const AUTHN_STAGES: readonly string[] = ['anonymous', 'session-partial', 'session-any'];

/** Narrows a route's config to the pre-auth arm. `undefined` for anything else. */
export function preAuthRouteConfig(config: unknown): PreAuthPolicy | undefined {
  if (typeof config !== 'object' || config === null) return undefined;
  const policy = (config as { policy?: unknown }).policy;
  if (!isRoutePolicy(policy) || policy.kind !== 'preauth') return undefined;
  return policy;
}

/**
 * The SPEC-06 action a route performs.
 *
 * > **Every action declares `scope` in its policy declaration.** P-4's
 * > deny-by-default and A-14's build-time check apply to the scope declaration
 * > exactly as they apply to the capability: an action with no declared scope
 * > fails the build. (SPEC-06 §1.1)
 *
 * `scope` lives on the route config as `actionScope` (SPEC-01 §2.1 V-06 named it
 * that, and the middleware selects its validation branch from it), so it is not
 * repeated here — one field, one source of truth. The catalogue already knows
 * each capability's scope, and `routeActionProblems` fails the build when the
 * two disagree, which is A-14 and A-16 in one check.
 */
export interface RouteAction {
  /** The capability key SPEC-06 L4 evaluates. Must exist in the catalogue. */
  readonly key: string;
  /** The module L1 evaluates the entitlement for. Must match the catalogue. */
  readonly moduleKey: ModuleKey;
  /** SPEC-06 L5.1 runs only when this is true. */
  readonly requiresObjectPolicy: boolean;
  /** Self-scoped actions require `target.owner_membership_id = ctx.membership_id`. */
  readonly ownershipRequired?: boolean;
  /** The administrative capability that lifts `ownershipRequired`, if any. */
  readonly ownershipOverrideCapability?: string;
  /** Target states in which the action is legal (SPEC-06 §3.1, State). */
  readonly permittedTargetStates?: readonly string[];
}

/**
 * A declared SPEC-06 action, independent of the surface that performs it.
 *
 * The two fields the evaluator needs and nothing else. An HTTP route declares
 * them in its Fastify config; a job handler declares them in its policy. Both
 * are handed to the same `actionInputOf`, which is how SPEC-06 §7's "one
 * evaluator, every path" is kept true by the type system rather than by
 * everybody remembering (OPUS-M1-004, FAD-13 item 1).
 */
export interface DeclaredAction {
  /** SPEC-01 §2.1 (V-06): declared by the surface, never inferred from the URL. */
  readonly actionScope: CapabilityScope;
  readonly action: RouteAction;
}

/**
 * Fastify's per-route `config` object.
 *
 * The union is the point: a **capability** route must also declare its
 * `actionScope` (SPEC-01 §2.1 / SPEC-06 §1.1) and its `action`, while a `public`
 * or `internal` route addresses no tenant and declares neither.
 *
 * The type is not the enforcement. A type-level-only guarantee is satisfiable
 * with a cast, so `scripts/gates/route-policy-check.mjs` checks the *registered*
 * route table at runtime and `apps/api/test/http/route-declarations.test.ts` runs
 * `routeActionProblems` over every route the server actually registers.
 */
export type RouteConfigWithPolicy =
  | { readonly policy: PublicPolicy | InternalPolicy }
  | {
      readonly policy: CapabilityPolicy;
      /** SPEC-01 §2.1 (V-06): declared by the route, never inferred from the URL. */
      readonly actionScope: CapabilityScope;
      readonly action: RouteAction;
    };

/** The capability arm of `RouteConfigWithPolicy`, for code that has narrowed it. */
export interface CapabilityRouteConfig extends DeclaredAction {
  readonly policy: CapabilityPolicy;
}

/**
 * Narrows an unknown route config to the capability arm.
 *
 * Returns `undefined` for a public or internal route — and for a capability
 * route whose scope or action declaration is missing or malformed, which the
 * middleware treats as a hard failure rather than as "no context needed". A
 * route that declares a capability and forgets its scope must fail closed.
 */
export function capabilityRouteConfig(config: unknown): CapabilityRouteConfig | undefined {
  if (typeof config !== 'object' || config === null) return undefined;
  const candidate = config as {
    policy?: unknown;
    actionScope?: unknown;
    action?: unknown;
  };
  if (!isRoutePolicy(candidate.policy) || candidate.policy.kind !== 'capability') return undefined;
  if (candidate.actionScope !== 'group' && candidate.actionScope !== 'organization') {
    return undefined;
  }
  const action = candidate.action as RouteAction | undefined;
  if (
    typeof action !== 'object' ||
    action === null ||
    typeof action.key !== 'string' ||
    action.key.length === 0 ||
    typeof action.moduleKey !== 'string' ||
    typeof action.requiresObjectPolicy !== 'boolean'
  ) {
    return undefined;
  }
  return {
    policy: candidate.policy,
    actionScope: candidate.actionScope,
    action,
  };
}

/** True when the route declares a capability policy, however well-formed. */
export function declaresCapability(config: unknown): boolean {
  if (typeof config !== 'object' || config === null) return false;
  const policy = (config as { policy?: unknown }).policy;
  return isRoutePolicy(policy) && policy.kind === 'capability';
}

/**
 * SPEC-06 A-14 and A-16, as a build-failing check.
 *
 * > | A-14 | Route with no declared policy — **or no declared `scope`** | **Build fails** |
 * > | A-16 | A capability key declared in **both** the group and organization namespaces | **Build fails** (P-10) |
 *
 * The route-policy gate already fails the build for a missing policy. This adds
 * the three things it cannot see:
 *
 *  1. a capability route with no well-formed `actionScope` or `action`;
 *  2. an `action.key` the **catalogue does not know** — the packet's new
 *     build-failing check;
 *  3. an `action` whose declared scope or module disagrees with the catalogue,
 *     which is A-16's failure mode reached from the route side: a route claiming
 *     a key belongs to the other namespace is exactly "a key declared in both".
 *
 * Returns a list of human-readable problems rather than throwing, so the caller
 * can report all of them at once instead of one per run.
 */
export function routeActionProblems(route: {
  readonly method: string;
  readonly url: string;
  readonly config: unknown;
}): readonly string[] {
  if (!declaresCapability(route.config)) return [];
  const where = `${route.method} ${route.url}`;
  const narrowed = capabilityRouteConfig(route.config);
  if (narrowed === undefined) {
    return [`${where}: declares a capability but no well-formed actionScope/action (A-14)`];
  }

  const problems: string[] = [];
  const definition = capabilityDefinition(narrowed.action.key);
  if (definition === undefined) {
    problems.push(
      `${where}: action key "${narrowed.action.key}" is not in the capability catalogue`,
    );
    return problems;
  }
  if (definition.scope !== narrowed.actionScope) {
    problems.push(
      `${where}: "${narrowed.action.key}" is ${definition.scope}-scoped in the catalogue but the ` +
        `route declares ${narrowed.actionScope} (P-10 / A-16)`,
    );
  }
  if (definition.module !== narrowed.action.moduleKey) {
    problems.push(
      `${where}: "${narrowed.action.key}" belongs to module ${definition.module} but the route ` +
        `declares ${narrowed.action.moduleKey}`,
    );
  }
  // The override gets the SAME three checks as `action.key`, and it did not
  // before: an independent review pointed out that a group-scoped route could
  // name `organization.membership.administer` as its override, pass A-14/A-16,
  // and have the evaluator look that organization key up in the GROUP role's
  // capability set — a P-10 crossing reached through the one field the check
  // forgot.
  const override = narrowed.action.ownershipOverrideCapability;
  if (override !== undefined) {
    const overrideDefinition = capabilityDefinition(override);
    if (overrideDefinition === undefined) {
      problems.push(`${where}: ownership override "${override}" is not in the capability catalogue`);
    } else if (overrideDefinition.scope !== narrowed.actionScope) {
      problems.push(
        `${where}: ownership override "${override}" is ${overrideDefinition.scope}-scoped but the ` +
          `route is ${narrowed.actionScope}-scoped (P-10 / A-16)`,
      );
    }
  }
  return problems;
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
  if (kind === 'preauth') {
    // BOTH fields, and the stage from a closed set. A pre-auth route that
    // forgot its stage would otherwise be admitted here and then have no
    // requirement the middleware could enforce — which is the fail-open shape
    // this whole class has to avoid.
    const candidate = value as { reason?: unknown; stage?: unknown };
    return (
      typeof candidate.reason === 'string' &&
      candidate.reason.length > 0 &&
      typeof candidate.stage === 'string' &&
      AUTHN_STAGES.includes(candidate.stage)
    );
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
    case 'preauth':
      return `preauth/${policy.stage} (${policy.reason})`;
  }
}
