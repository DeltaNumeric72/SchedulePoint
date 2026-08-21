import type { FastifyReply, FastifyRequest } from 'fastify';

import { SESSION_COOKIE_NAME, decodeSessionCookie, encodeSessionCookie } from './tokens.js';

/**
 * The session cookie — 14 §3: `HttpOnly` + `Secure` + `SameSite`.
 *
 * ## Why the name starts with `__Host-`
 *
 * The `__Host-` prefix is enforced by the BROWSER, not by us: a cookie with that
 * prefix is only accepted if it is `Secure`, has `Path=/`, and carries **no
 * `Domain` attribute**. The last one is the property that matters — a cookie
 * scoped to a parent domain is readable by every sibling subdomain, and a
 * subdomain takeover then becomes a session-theft primitive (T-07). Naming it
 * this way means a future change that adds a `Domain` attribute is rejected by
 * every browser rather than shipped.
 *
 * The cost is stated rather than discovered: `__Host-` cookies cannot be set
 * over plain HTTP, so local development must be served over TLS or the cookie is
 * silently dropped. That is the correct trade — the alternative is a cookie that
 * works in development because it is less safe.
 *
 * ## `SameSite=Strict`, not `Lax`
 *
 * `Lax` sends the cookie on top-level GET navigations from another site, which
 * is exactly the shape of a link in an email. This application has no cross-site
 * entry point that needs the session — the activation and reset links land on a
 * page that then makes its own same-site request — so `Strict` costs nothing and
 * closes the CSRF surface `SameSite` is there to close (14 §4).
 *
 * ## The cookie is written by exactly these two functions
 *
 * `apps/api/test/authn/http-flows.test.ts` drives the sign-in and sign-out
 * routes through the real server and asserts the attributes ON THE WIRE, so a
 * handler that hand-rolled a `Set-Cookie` would be caught rather than reviewed.
 *
 * Scope, stated exactly rather than rounded up (OPUS-M4-005): these functions
 * have three call sites in `http/routes/authn.route.ts` — sign-in, sign-out and
 * the password-reset completion — and the wire assertions cover the first two.
 * The reset path is exercised end to end but its `Set-Cookie` is not asserted.
 * The previous wording said "every route", which was a claim wider than the
 * coverage, and that is the same defect class as the citation it replaces.
 */

/** Fastify's minimal cookie parse. No dependency: one header, one split. */
export function readSessionCookie(request: FastifyRequest): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const equals = part.indexOf('=');
    if (equals < 0) continue;
    if (part.slice(0, equals).trim() !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(equals + 1).trim();
    return value.length === 0 ? undefined : decodeURIComponent(value);
  }
  return undefined;
}

export function setSessionCookie(
  reply: FastifyReply,
  options: {
    readonly organizationId: string;
    readonly secret: string;
    readonly expiresAt: Date;
    readonly persistent: boolean;
  },
): void {
  const value = encodeSessionCookie(options.organizationId, options.secret);
  const attributes = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
  ];
  // A non-persistent session gets NO `Max-Age`, so it is a browser-session
  // cookie and disappears when the browser closes. A persistent one gets an
  // expiry, and the server-side absolute deadline still bounds it — the cookie's
  // lifetime is a convenience and never the authority.
  if (options.persistent) {
    const maxAge = Math.max(0, Math.floor((options.expiresAt.getTime() - Date.now()) / 1000));
    attributes.push(`Max-Age=${String(maxAge)}`);
  }
  reply.header('set-cookie', attributes.join('; '));
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.header(
    'set-cookie',
    `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
  );
}

export { SESSION_COOKIE_NAME, decodeSessionCookie };
