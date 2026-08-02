/**
 * The principal port — where `principal_user_id` comes from.
 *
 * SPEC-01 §2.1 sources `principal_user_id` from the **server-side session**, and
 * §3.1 fixes what a session may hold:
 *
 * > The session stores `principal_user_id`, `session_epoch`, and authentication
 * > facts. **It stores no active organization and no active group.**
 *
 * Authentication itself is not in OPUS-M1-001's scope, so this milestone ships
 * the port and a resolver that **denies every request** (`apps/api` —
 * `denyAllPrincipalResolver`). That is the deliberate fail-closed default: a
 * server with no session backend configured serves no authenticated traffic
 * rather than inventing a principal. The test harness injects its own resolver;
 * production replaces it when the session store lands.
 *
 * There is no header-based principal shortcut anywhere in the shipped code. A
 * "trust this header in dev" resolver is exactly how an authentication bypass
 * reaches production, and it is not written here so that it cannot be enabled by
 * a configuration mistake.
 */

/** What a resolved session asserts. Never includes a tenant selection. */
export interface Principal {
  readonly userId: string;
  /** SPEC-01 §2.1: bumped on privilege change, impersonation start/end, re-auth. */
  readonly sessionEpoch: number;
}

export type PrincipalResolution =
  | { readonly authenticated: true; readonly principal: Principal }
  | { readonly authenticated: false; readonly reason: string };

/**
 * `request` is deliberately `unknown`: the domain declares the port and does not
 * know what a request is. The adapter narrows it.
 */
export interface PrincipalResolver {
  resolve(request: unknown): Promise<PrincipalResolution>;
}
