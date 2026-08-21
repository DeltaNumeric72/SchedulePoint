import { CONTEXT_HEADER } from '@schedulepoint/contracts';

/**
 * The client half of SPEC-01 §2.2 — the browser's context DECLARATION.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## What this module is, and what it deliberately is not
 *
 * SPEC-01 §2.2 requires two carriers on every capability request:
 *
 *  - the **path segment** `/organizations/{org}[/groups/{group}]`, which the
 *    router already puts in every URL this application builds;
 *  - the **`X-SchedulePoint-Context` header**, carrying the freshness counters.
 *    "The path segment is not sufficient on its own — it identifies the tenant
 *    but not the freshness. Both are required."
 *
 * The header had no sender. `apps/web/src/api/client.ts` sent `accept` and a
 * same-origin cookie and nothing else, so every capability request the shipped
 * bundle could make was refused with `CONTEXT_HEADER_MISSING` — which is why
 * every browser test had to intercept the API and the real join had never run
 * (EV-M4-005 §12, ruled in FAD-48). This module is that sender.
 *
 * **The declaration model is unchanged.** The client still DECLARES and the
 * server still VERIFIES. Nothing here is trusted by the server: the counters are
 * compared against ground truth inside the §2.3 sequence, and a wrong or stale
 * declaration is a `409`, not an admission. What changed is only that the client
 * can now learn what to declare — `GET /organizations/{org}/me/context`.
 *
 * ## I-10 — one user action, one request
 *
 * The context is read **once per (session, organization)** and cached for the
 * lifetime of the page. Concurrent callers share one in-flight read rather than
 * each issuing their own, which is why the cache holds the PROMISE and not the
 * value: two components mounting together must not produce two reads.
 *
 * So a user interaction gains one request only where the header must first be
 * established — in practice the first capability request of a page load, never
 * a click that follows it. The budgets in
 * `scripts/gates/request-budget/budgets.json` are measured against exactly that,
 * at both viewports.
 *
 * ## Which requests carry a declaration
 *
 * Derived from the path, by the same rule the server reads it with
 * (`apps/api/src/http/context/declared.ts`): an `/organizations/{uuid}` prefix
 * declares the organization, and a following `/groups/{uuid}` declares the
 * group. Two families are excluded, and each is excluded for a reason rather
 * than for convenience:
 *
 *  - `/organizations/{org}/authn/**` — the pre-auth class. These routes exist to
 *    ESTABLISH a session; there is no session to read a context with, and
 *    attempting one would make sign-in depend on being signed in.
 *  - `/organizations/{org}/me/context` — this module's own read. Anything else
 *    is an infinite regress.
 *
 * A path with no organization segment (`/health`) addresses no tenant and
 * declares nothing.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Same-origin API prefix. Mirrors `client.ts`; CAP-068 / T-23 — never absolute. */
const API_PREFIX = '/api';

/**
 * The one canonical UUID spelling, matching `declared.ts`'s regular expression
 * exactly. A lax pattern here would send a declaration for a path the server
 * parses differently, and the mismatch would surface as an unexplainable 404.
 */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TENANT_PATH = new RegExp(`^/organizations/(${UUID})(?:/groups/(${UUID}))?(?:/|$)`);

/** The scope a path declares, or `undefined` when it declares nothing. */
export interface DeclaredScope {
  readonly organizationId: string;
  readonly groupId: string | null;
}

export function scopeOf(path: string): DeclaredScope | undefined {
  const match = TENANT_PATH.exec(path);
  if (match === null) return undefined;
  const organizationId = match[1] as string;
  const rest = path.slice(`/organizations/${organizationId}`.length);
  if (rest.startsWith('/authn/') || rest === '/me/context') return undefined;
  return { organizationId, groupId: match[2] ?? null };
}

/** One membership of the caller, as `GET /me/context` returns it. */
export interface MeContextMembership {
  readonly membershipId: string;
  readonly kind: 'organization' | 'group';
  readonly groupId: string | null;
  readonly groupVersion: number | null;
}

export interface MeContext {
  readonly organizationId: string;
  readonly userId: string;
  readonly organizationVersion: number;
  readonly membershipSetVersion: number;
  readonly sessionEpoch: number;
  readonly memberships: readonly MeContextMembership[];
}

export class ContextUnavailableError extends Error {
  constructor(organizationId: string, cause: string) {
    super(`The tenant context for this organization could not be read (${cause}).`);
    this.name = 'ContextUnavailableError';
    this.organizationId = organizationId;
  }
  readonly organizationId: string;
}

/**
 * A narrow, hand-written guard rather than a zod schema.
 *
 * `packages/contracts` is where every other response shape is parsed, and this
 * one is not there on purpose: FAD-48's allowed-file extension names
 * `apps/web/src/api/client.ts` (+ this module) and the one API route file, and
 * nothing else. The server side says the same thing in
 * `apps/api/src/http/routes/me-context.route.ts`. When a packet owns
 * `packages/contracts/src/context.ts`, the two collapse into one schema there.
 *
 * It is a REJECTING guard, not a coercing one: an unexpected shape throws rather
 * than being partially read, because a partially read context becomes a
 * declaration that is wrong in a way the server can only answer with a 409.
 */
function parseMeContext(value: unknown): MeContext {
  const body = value as Partial<MeContext> | null | undefined;
  if (
    body === null ||
    body === undefined ||
    typeof body.organizationId !== 'string' ||
    typeof body.userId !== 'string' ||
    !Number.isSafeInteger(body.organizationVersion) ||
    !Number.isSafeInteger(body.membershipSetVersion) ||
    !Number.isSafeInteger(body.sessionEpoch) ||
    !Array.isArray(body.memberships)
  ) {
    throw new Error('the context response did not have the expected shape');
  }
  for (const membership of body.memberships) {
    if (
      typeof membership.membershipId !== 'string' ||
      (membership.kind !== 'organization' && membership.kind !== 'group') ||
      (membership.groupId !== null && typeof membership.groupId !== 'string') ||
      (membership.groupVersion !== null && !Number.isSafeInteger(membership.groupVersion))
    ) {
      throw new Error('the context response contained a malformed membership');
    }
  }
  return body as MeContext;
}

/** Keyed by organization. The value is the in-flight or settled read. */
const cache = new Map<string, Promise<MeContext>>();

async function readContext(organizationId: string): Promise<MeContext> {
  const response = await fetch(`${API_PREFIX}/organizations/${organizationId}/me/context`, {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new ContextUnavailableError(organizationId, `HTTP ${String(response.status)}`);
  }
  return parseMeContext(await response.json());
}

/**
 * The caller's context for an organization, read at most once per page.
 *
 * A FAILED read is not cached. Caching it would turn one transient failure into
 * a page that can never recover without a reload, and the recoverable-condition
 * design in SPEC-01 §2.3 is the opposite of that.
 */
export function contextFor(organizationId: string): Promise<MeContext> {
  const cached = cache.get(organizationId);
  if (cached !== undefined) return cached;
  const pending = readContext(organizationId).catch((error: unknown) => {
    cache.delete(organizationId);
    throw error;
  });
  cache.set(organizationId, pending);
  return pending;
}

/** Drops the cached context so the next declaration re-reads it. */
export function forgetContext(organizationId: string): void {
  cache.delete(organizationId);
}

/** Drops every cached context. Used by the sign-out path and by unit tests. */
export function resetContextCache(): void {
  cache.clear();
}

/**
 * The `X-SchedulePoint-Context` value for a path, or `undefined` when the path
 * declares no tenant.
 *
 * The counter selection mirrors `packages/domain/src/context/verification.ts`
 * exactly: an organization-scoped action declares `groupVersion: null` ("there
 * is no group to be fresh about"), and a group-scoped one declares that group's
 * counter. Sending an organization-scoped declaration on a group-scoped route
 * would be step 4's `CONTEXT_STALE`, which is the failure this mirroring exists
 * to avoid.
 */
export async function declarationHeaderFor(
  path: string,
): Promise<Record<string, string> | undefined> {
  const scope = scopeOf(path);
  if (scope === undefined) return undefined;

  const context = await contextFor(scope.organizationId);

  let groupVersion: number | null = null;
  if (scope.groupId !== null) {
    const membership = context.memberships.find(
      (candidate) => candidate.kind === 'group' && candidate.groupId === scope.groupId,
    );
    if (membership === undefined || membership.groupVersion === null) {
      // The caller holds no usable membership in the declared group. The request
      // is sent ANYWAY, with the group counter absent, so the server produces the
      // authoritative answer — a `404` byte-identical to a group that does not
      // exist (§2.4, T-05b). A client-side refusal here would be the client
      // deciding an authorization question, and a client that answers 404 on its
      // own is a client whose answer nobody verified.
      groupVersion = null;
    } else {
      groupVersion = membership.groupVersion;
    }
  }

  const declaration = {
    contextVersion: {
      organizationVersion: context.organizationVersion,
      groupVersion,
      membershipSetVersion: context.membershipSetVersion,
    },
    sessionEpoch: context.sessionEpoch,
  };

  return { [CONTEXT_HEADER]: JSON.stringify(declaration) };
}

/** The organization a path declares, for the 409 re-read path. */
export function organizationOf(path: string): string | undefined {
  return scopeOf(path)?.organizationId;
}
