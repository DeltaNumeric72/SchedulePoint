import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Token minting and hashing — 14 §5: "Tokens **hash-stored** — calendar feed
 * tokens, session tokens, invitation tokens, push tokens".
 *
 * ## The token namespaces are separate, and separation is structural
 *
 * 14 §2: a password reset "**does not double as activation**", and the packet
 * requires "a separate flow and separate token namespace". Two mechanisms
 * together give that:
 *
 *  1. **separate tables** — `invitations`, `password_reset_tokens`, `sessions`;
 *  2. **a domain label mixed into the hash**. `hashToken('invitation', t)` and
 *     `hashToken('password_reset', t)` produce different digests for the same
 *     `t`, so even a token deliberately replayed into the wrong endpoint hashes
 *     to a value that table cannot contain.
 *
 * The second is what makes the first robust. Separate tables alone would still
 * be defeated by a future code path that looked a token up in both; a
 * domain-separated digest means the lookup itself cannot succeed.
 *
 * ## Why SHA-256 and not a password hash
 *
 * A token is 256 bits of `randomBytes`. There is no dictionary to attack and no
 * work factor worth paying: an adaptive hash here would add ~100 ms to every
 * authenticated request (the session lookup runs on all of them) and buy nothing
 * against a uniformly random 32-byte secret. This is the same reasoning that
 * makes `password_hash` adaptive and `token_hash` not.
 */

/**
 * The closed set of token namespaces.
 *
 * A string union rather than a free parameter: a typo in a domain label would
 * silently create a fourth namespace whose tokens verify against nothing, and
 * the failure would look like "the token expired".
 */
export type TokenNamespace = 'session' | 'invitation' | 'password_reset';

const TOKEN_BYTES = 32;

/** The `<organization>.<secret>` cookie shape. */
export interface SessionCookieValue {
  readonly organizationId: string;
  readonly secret: string;
}

/**
 * A fresh token, base64url, 256 bits.
 *
 * base64url rather than hex: the same entropy in 43 characters instead of 64,
 * and no character that needs escaping in a cookie, a URL, or an email.
 */
export function mintToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * The digest stored in `token_hash`.
 *
 * The domain separator is `\u0000`, spelled as a JS ESCAPE rather than a raw
 * NUL byte, for the reason `multi.ts`'s `mint` records: a raw NUL is
 * load-bearing and invisible — a reader cannot see it and grep cannot find
 * it, and an independent review flagged exactly that. It stops
 * `('a', 'b.c')` and `('a.b', 'c')` hashing alike, and nothing in a namespace
 * token or a token value can contain U+0000; do not "tidy" it to a visible
 * character.
 */
export function hashToken(namespace: TokenNamespace, token: string): Buffer {
  return createHash('sha256').update(`sp.authn.${namespace}.v1\u0000${token}`).digest();
}

/** Constant-time comparison of two digests. */
export function digestsEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The cookie value: `<organizationId>.<secret>`.
 *
 * The organization id travels with the token because the session table is
 * organization-tenanted (06 §3.2) and the resolver must know which tenant
 * context to open BEFORE it can look the token up. It is not a secret and not a
 * capability — declaring the wrong one simply matches no row, because RLS scopes
 * the lookup to the declared organization and the token hash is unguessable.
 *
 * This is SPEC-01's client-declared / server-verified pattern applied one step
 * earlier than usual: the declaration is in the cookie rather than the path, and
 * the verification is the token-hash match rather than a membership read.
 */
export function encodeSessionCookie(organizationId: string, secret: string): string {
  return `${organizationId}.${secret}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `undefined` for anything malformed. A malformed cookie is not authenticated. */
export function decodeSessionCookie(value: string): SessionCookieValue | undefined {
  const separator = value.indexOf('.');
  if (separator <= 0) return undefined;
  const organizationId = value.slice(0, separator);
  const secret = value.slice(separator + 1);
  if (!UUID.test(organizationId)) return undefined;
  // 32 bytes base64url is 43 characters. A shorter value is not a token that
  // happens to be wrong; it is not a token, and it must not reach a query.
  if (secret.length < 43 || secret.length > 64) return undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(secret)) return undefined;
  return { organizationId, secret };
}

/** The cookie's name. `__Host-` is deliberate: see `cookies.ts`. */
export const SESSION_COOKIE_NAME = '__Host-sp_session';
