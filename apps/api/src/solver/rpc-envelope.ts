import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { canonicalStringify } from '@schedulepoint/domain';

/**
 * The platform half of the solver RPC's mutual authentication — SPEC-04 §1.1.
 *
 * The worker's half is `solver/schedulepoint_solver/auth.py`, and the two must
 * agree. `apps/api/test/solver/rpc-auth.test.ts` proves the agreement by running
 * the real worker rather than by comparing source, because two files that *look*
 * like they agree is precisely the state this repository treats as unproven.
 *
 * ## The MAC covers THE BYTES ON THE WIRE — not a re-derivation of them
 *
 * **This is the correction of a real defect, and the reason for the whole frame
 * design below.** The first version signed `canonicalStringify(message)` and then
 * sent `JSON.stringify(message)`; the worker re-derived its own canonical form
 * with Python's `json.dumps(..., ensure_ascii=True)` and MACed *that*. Three
 * serialisations of one message, and the MAC covered none of the bytes that
 * actually travelled.
 *
 * For pure ASCII the three happen to coincide, so every test passed. They
 * diverge the moment any non-ASCII character appears — an accented period name,
 * a CJK location, an en-dash in a rule name — because `ensure_ascii=True` emits
 * `\uXXXX` escapes where JavaScript emits raw UTF-8. The independent review
 * measured it: a period called "Février 2029" produced `SOLVER_RESPONSE_REJECTED`
 * every time, through the real production path. Nothing in the snapshot restricts
 * these fields to ASCII, and nothing should.
 *
 * Setting `ensure_ascii=False` would have closed *that* instance and left the
 * class open: `canonicalStringify` sorts keys in UTF-16 **code-unit** order and
 * Python sorts by **code point**, and those disagree for anything above the BMP.
 * Two independent canonicalisations that must agree byte-for-byte across two
 * language runtimes is a standing liability, not a bug to patch.
 *
 * So the MAC input is **the exact bytes of the body**, and the tag travels
 * *beside* the body rather than inside it:
 *
 * ```
 *   <auth line: one-line JSON, ASCII by construction>\n<body bytes, verbatim>
 * ```
 *
 * Neither side re-serialises anything to verify. The platform signs what it is
 * about to write; the worker verifies what it actually read. This is the
 * webhook-signature pattern (a signature over the raw request body) and it maps
 * to HTTP unchanged — the auth line becomes a header, the body becomes the body.
 * Canonical serialisation is still used to BUILD the body, because determinism
 * of the content remains valuable; correctness no longer depends on it.
 *
 * ## Three properties, each closing a specific attack
 *
 *  1. **Domain separation.** Request and response MACs cover different prefixes,
 *     so a captured request MAC can never be replayed as a response MAC.
 *  2. **The auth metadata is inside the MAC.** Scheme, principal, key id and
 *     nonce sit in the prefix, so moving the tag beside the body does not leave
 *     them editable — an attacker cannot swap the nonce to replay a response.
 *  3. **Constant-time comparison.** A byte-by-byte `===` on a tag is a timing
 *     oracle that recovers a valid MAC one byte at a time.
 *
 * **No secret is logged, echoed, or included in an error** (I-07, non-bypass
 * rule 9). A refusal says the message did not authenticate and stops.
 */

/** Versioned, so a future mechanism is a different string an old peer refuses. */
export const AUTH_SCHEME = 'sp-hmac-sha256-mutual-v1';

export const PRINCIPAL_PLATFORM = 'schedulepoint-api';
export const PRINCIPAL_WORKER = 'schedulepoint-solver';

const REQUEST_DOMAIN = 'SP-SOLVER-RPC-v1|request|';
const RESPONSE_DOMAIN = 'SP-SOLVER-RPC-v1|response|';

/** The separator between the auth line and the body. */
const FRAME_SEPARATOR = '\n';

/**
 * A MAC tag, as it appears on the wire: 64 lowercase hex characters.
 *
 * Validated as a SHAPE before any comparison. `timingSafeEqual` throws on a
 * length mismatch, and a non-hex tag is not a tag at all — refusing on shape
 * keeps every failure on the one `unauthenticated` path instead of surfacing a
 * `TypeError` from the crypto layer.
 */
const MAC_PATTERN = /^[0-9a-f]{64}$/;

export interface RpcAuthEnvelope {
  readonly scheme: string;
  readonly principal: string;
  readonly keyId: string;
  readonly nonce: string;
  readonly mac: string;
}

/**
 * A fresh nonce.
 *
 * From the CSPRNG rather than a counter or a timestamp: a predictable nonce lets
 * an attacker who observes one exchange precompute the binding for the next.
 */
export function freshNonce(): string {
  return randomBytes(32).toString('hex');
}

/**
 * The MAC input prefix — everything about the message that is not the body.
 *
 * Newline-delimited over fields that cannot themselves contain a newline (a
 * fixed scheme, a fixed principal, and two opaque identifiers validated on
 * receipt), so the framing is unambiguous without any escaping.
 */
function macPrefix(
  domain: string,
  parts: { scheme: string; principal: string; keyId: string; nonce: string },
): string {
  return `${domain}${parts.scheme}\n${parts.principal}\n${parts.keyId}\n${parts.nonce}\n`;
}

function computeMac(
  domain: string,
  parts: { scheme: string; principal: string; keyId: string; nonce: string },
  body: Buffer,
  secret: string,
): string {
  return createHmac('sha256', secret)
    .update(macPrefix(domain, parts), 'utf8')
    .update(body)
    .digest('hex');
}

/** A framed message: what goes on the wire, and the pieces it was built from. */
export interface RpcFrame {
  /** The complete bytes to write. */
  readonly wire: Buffer;
  /** The body alone — what the MAC covers. */
  readonly body: Buffer;
  readonly auth: RpcAuthEnvelope;
}

/**
 * Build and sign a request frame.
 *
 * The body is produced ONCE, and the MAC is taken over exactly those bytes.
 * There is deliberately no path by which a caller can sign one rendering and
 * send another — that was the defect.
 */
export function frameRequest(
  message: unknown,
  key: { readonly keyId: string; readonly secret: string },
  nonce: string,
): RpcFrame {
  const body = Buffer.from(canonicalStringify(message), 'utf8');
  const parts = {
    scheme: AUTH_SCHEME,
    principal: PRINCIPAL_PLATFORM,
    keyId: key.keyId,
    nonce,
  };
  const auth: RpcAuthEnvelope = {
    ...parts,
    mac: computeMac(REQUEST_DOMAIN, parts, body, key.secret),
  };
  /* The auth line is JSON over ASCII-only values (a fixed scheme and principal,
   * a hex key id and nonce, a hex tag), so it can never contain a raw newline
   * and the separator stays unambiguous. */
  const authLine = Buffer.from(JSON.stringify(auth), 'utf8');
  return {
    wire: Buffer.concat([authLine, Buffer.from(FRAME_SEPARATOR, 'utf8'), body]),
    body,
    auth,
  };
}

/** A response frame, split but not yet trusted. */
export interface ParsedFrame {
  readonly authLine: string;
  readonly body: Buffer;
}

/**
 * Split a frame at its FIRST newline. Returns `null` when there is no separator.
 *
 * The body is taken verbatim — no trimming, no re-encoding. Trimming would
 * change the bytes the MAC was computed over, which is the very mistake this
 * design exists to remove.
 */
export function splitFrame(raw: Buffer): ParsedFrame | null {
  const separator = raw.indexOf(0x0a);
  if (separator === -1) return null;
  return {
    authLine: raw.subarray(0, separator).toString('utf8'),
    body: raw.subarray(separator + 1),
  };
}

/**
 * Does this response frame authenticate as coming from **our** worker, for
 * **this** request?
 *
 * Every failure returns the same `false`. Distinguishing "wrong principal" from
 * "bad MAC" would hand an attacker a free oracle and helps no legitimate caller.
 */
export function verifyResponseFrame(
  frame: ParsedFrame,
  key: { readonly keyId: string; readonly secret: string },
  expectedNonce: string,
): boolean {
  let auth: unknown;
  try {
    auth = JSON.parse(frame.authLine) as unknown;
  } catch {
    return false;
  }
  if (typeof auth !== 'object' || auth === null || Array.isArray(auth)) return false;
  const envelope = auth as Record<string, unknown>;

  const scheme = envelope['scheme'];
  const principal = envelope['principal'];
  const keyId = envelope['keyId'];
  const nonce = envelope['nonce'];
  const presented = envelope['mac'];

  if (scheme !== AUTH_SCHEME) return false;
  if (principal !== PRINCIPAL_WORKER) return false;
  if (keyId !== key.keyId) return false;
  if (nonce !== expectedNonce) return false;
  if (typeof presented !== 'string' || !MAC_PATTERN.test(presented)) return false;

  const expected = computeMac(
    RESPONSE_DOMAIN,
    { scheme: AUTH_SCHEME, principal: PRINCIPAL_WORKER, keyId: key.keyId, nonce: expectedNonce },
    frame.body,
    key.secret,
  );
  /* Both are 64-character hex by construction and by the shape check above, so
   * the lengths always match and `timingSafeEqual` cannot throw. */
  return timingSafeEqual(Buffer.from(presented, 'utf8'), Buffer.from(expected, 'utf8'));
}
