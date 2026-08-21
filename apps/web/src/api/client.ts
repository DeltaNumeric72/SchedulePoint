import {
  contextStaleBodySchema,
  errorEnvelopeSchema,
  healthStatusSchema,
  type HealthStatus,
} from '@schedulepoint/contracts';

import { declarationHeaderFor, forgetContext, organizationOf } from './context.js';

/**
 * The API client.
 *
 * Two rules the network-assertion guard enforces mechanically, stated here so
 * the reason is visible at the call site:
 *
 *  1. **Every URL is same-origin and relative.** CAP-068 / T-23: the browser
 *     never talks to a third-party host. Not analytics, not a font CDN, not an
 *     error reporter. A gate fails the build on any absolute external URL in
 *     `apps/web`, and the allowlist is empty.
 *  2. **Every response is parsed through the shared zod contract.** An
 *     unparsed response is an untyped response no matter what the TypeScript
 *     signature claims.
 *
 * ## Since FAD-48: every capability request DECLARES its context
 *
 * SPEC-01 §2.2's declaration has two carriers, and this client sent only one of
 * them — the path segment — for the whole of M1..M4. The `X-SchedulePoint-Context`
 * header had no sender anywhere under `apps/web/**`, so the shipped bundle could
 * not make a single authorized request against a real server and every browser
 * test intercepted the API instead (EV-M4-005 §12). `./context.ts` is the sender;
 * this module attaches what it produces and handles the one recoverable failure.
 */

/** Same-origin API prefix. The reverse proxy (ingress image) routes it to the API. */
const API_PREFIX = '/api';

export class ApiError extends Error {
  readonly code: string;
  readonly correlationId: string | undefined;
  /**
   * The parsed response body, when there was one.
   *
   * Carried so a caller that knows a particular code has a richer shape can
   * re-parse it through its own contract — the catalogue's `422`, which names
   * the fields that failed validation, is the only such case today. It is
   * `unknown` on purpose: nothing may read a field off it without parsing.
   */
  readonly body: unknown;

  constructor(code: string, message: string, correlationId?: string, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.correlationId = correlationId;
    this.body = body;
  }
}

/**
 * One request, one parse of the error envelope.
 *
 * Exported since OPUS-M2-002 so the catalogue client shares it rather than
 * reimplementing the same three rules. A second copy of "parse the envelope,
 * throw an ApiError" is a second place for the fixed 5xx text to get expanded
 * into something more helpful and less true.
 */
interface RawResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
}

async function send(
  path: string,
  init: RequestInit | undefined,
  declaration: Record<string, string> | undefined,
): Promise<RawResponse> {
  const response = await fetch(`${API_PREFIX}${path}`, {
    ...init,
    /* FAD-50 N-8. The DECLARATION spreads LAST. It used to come before
     * `init?.headers`, so any caller passing a header bag could overwrite the
     * SPEC-01 §2.2 context declaration — silently, and with the server then
     * verifying whatever the caller substituted. Nothing in the tree did it, and
     * nothing should be able to: the declaration is the client's half of a
     * declare/verify contract, not a default a request may adjust. */
    headers: { accept: 'application/json', ...init?.headers, ...declaration },
    credentials: 'same-origin',
  });
  return {
    ok: response.ok,
    status: response.status,
    body: (await response.json().catch(() => undefined)) as unknown,
  };
}

/**
 * The error envelope, in either of its two shapes.
 *
 * ## A pre-existing defect, found by building the sender
 *
 * `errorEnvelopeSchema` is `.strict()` and knows three fields. SPEC-01 §2.3's
 * recoverable refusals carry a **fourth** — `recover: 'refetch-context' |
 * 'reauthenticate'`, the directive that tells a client what to do — so
 * `contextStaleBodySchema` is a different, wider shape. The consequence was
 * silent and total: every `409 CONTEXT_STALE` and `409 SESSION_STALE` the server
 * has ever sent would have failed the strict parse here and reached the caller
 * as `UNEXPECTED_RESPONSE` with the code erased. Nothing noticed, because no
 * browser request had ever got far enough to be told its context was stale.
 *
 * Both shapes are tried, widest last, and the CODE is preserved either way. The
 * strict schema is not loosened — `packages/contracts` is not this packet's file
 * and, more to the point, the strictness is correct: two different bodies is what
 * the server actually sends.
 */
function envelopeOf(
  body: unknown,
): { code: string; message: string; correlationId: string } | undefined {
  const envelope = errorEnvelopeSchema.safeParse(body);
  if (envelope.success) return envelope.data.error;
  const stale = contextStaleBodySchema.safeParse(body);
  if (stale.success) return stale.data.error;
  return undefined;
}

function throwFor(response: RawResponse): never {
  const error = envelopeOf(response.body);
  if (error !== undefined) {
    throw new ApiError(error.code, error.message, error.correlationId, response.body);
  }
  throw new ApiError(
    'UNEXPECTED_RESPONSE',
    `Request failed (${String(response.status)}).`,
    undefined,
    response.body,
  );
}

/** The one recoverable declaration failure a retry can fix (SPEC-01 §2.3 step 4). */
function isContextStale(response: RawResponse): boolean {
  return response.status === 409 && envelopeOf(response.body)?.code === 'CONTEXT_STALE';
}

export async function apiRequest(path: string, init?: RequestInit): Promise<unknown> {
  const declaration = await declarationHeaderFor(path);
  const first = await send(path, init, declaration);

  /* ── the one retry, and why it is exactly one ────────────────────────────
   *
   * `409 CONTEXT_STALE` means the counters this client declared are behind the
   * server's — somebody changed the organization or the group since this page
   * read its context. SPEC-01 §2.3 calls it "a recoverable user-interface
   * condition, not an attack", and the response says so in words: `recover:
   * 'refetch-context'`.
   *
   * So the client does exactly that, ONCE: drop the cached context, re-read it,
   * and replay the request. A second retry would be a retry loop against a
   * counter that is being advanced by somebody else, which turns one stale tab
   * into sustained load — and I-10's "one user action produces one request"
   * tolerates a bounded recovery, not an unbounded one. A still-stale second
   * answer is surfaced to the caller as the `ApiError` it is.
   *
   * `SESSION_STALE` is deliberately NOT retried. Its directive is
   * `reauthenticate`, not `refetch-context`: the session epoch advanced, which
   * means credentials or memberships changed underneath this session, and
   * replaying the request with fresh counters would paper over exactly the
   * event the epoch exists to surface.
   *
   * A retry is attempted only for a request that CARRIED a declaration — a
   * `/health` call has nothing to re-read.
   * ──────────────────────────────────────────────────────────────────────── */
  if (!first.ok && declaration !== undefined && isContextStale(first)) {
    const organizationId = organizationOf(path);
    if (organizationId !== undefined) forgetContext(organizationId);
    const retried = await send(path, init, await declarationHeaderFor(path));
    if (!retried.ok) throwFor(retried);
    return retried.body;
  }

  if (!first.ok) throwFor(first);
  return first.body;
}

export async function fetchHealth(): Promise<HealthStatus> {
  return healthStatusSchema.parse(await apiRequest('/health'));
}
