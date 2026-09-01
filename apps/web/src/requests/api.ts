import {
  approveRequestSchema,
  attachReasonCodeSchema,
  appendSchedulerCommentSchema,
  batchDecisionResultSchema,
  batchDecisionSchema,
  denyRequestSchema,
  decisionResultSchema,
  requestCommentResultSchema,
  requestCommentThreadSchema,
  requestDeadlineSchema,
  requestDetailSchema,
  requestListSchema,
  requestQueueSchema,
  requestSchema,
  reverseDecisionSchema,
  submitRequestSchema,
  withdrawRequestSchema,
  withdrawRequestResultSchema,
  type BatchDecisionResult,
  type DecisionResultWire,
  type RequestCommentResult,
  type RequestCommentThread,
  type RequestDeadlineWire,
  type RequestDetail,
  type RequestList,
  type RequestQueue,
  type RequestReasonCodeWire,
  type RequestRecordWire,
  type RequestStatusWire,
  type RequestSubtypeWire,
  type RequestWire,
  type WithdrawRequestResult,
} from '@schedulepoint/contracts';

import { ApiError, apiRequest } from '../api/client.js';

/**
 * The request-lifecycle client — both sides of SPEC-08 §4 (OPUS-M5-005).
 *
 * The three rules every client in this app states, unchanged:
 *
 *  1. **every URL is same-origin and relative** — CAP-068 / T-23, and the
 *     client-host allowlist is empty. No third-party host appears in this module
 *     or on any surface it serves.
 *  2. **every response is parsed through the shared zod contract** — an unparsed
 *     response is an untyped response whatever the TypeScript signature claims.
 *  3. **requests are parsed on the way OUT too**, so the server receives the body
 *     the contract describes rather than whatever fields a form happened to fill.
 *
 * Rule 3 is doing unusually specific work here. `attachReasonCodeSchema` is
 * `.strict()` and declares exactly ONE field, so a body carrying `text`, `note`,
 * `detail` or `otherText` is refused STRUCTURALLY on the way out, before it ever
 * reaches the wire — the client cannot become the free-text channel FAD-58
 * closed, even by accident, because there is no field for one to travel in.
 *
 * ## Two audiences, one module
 *
 * The requester's four calls and the scheduler's seven live together because
 * they are one lifecycle and the contracts are one file. What is NOT shared is
 * the KEY: the requester's calls ride `requests.own.*` and the scheduler's ride
 * `requests.read_any` / `.approve` / `.deny` / `.comment_any`, and the server
 * decides that per route. Nothing in this module widens anything — a client that
 * calls a route it may not call is refused, which is the only outcome a client
 * is entitled to arrange.
 */

/** A refusal that names a code the surface can explain and act on. */
export class RequestRefusal extends ApiError {
  constructor(code: string, message: string, correlationId?: string) {
    super(code, message, correlationId);
    this.name = 'RequestRefusal';
  }
}

export interface GroupScope {
  readonly organizationId: string;
  readonly groupId: string;
}

const base = (scope: GroupScope): string =>
  `/organizations/${scope.organizationId}/groups/${scope.groupId}/requests`;

const jsonHeaders = { 'content-type': 'application/json' } as const;

/**
 * Re-throws a server refusal with its CODE intact.
 *
 * Every refusal vocabulary on this surface is CLOSED and each member has a
 * different remedy — `VERSION_CONFLICT` means reload, `REQUEST_OPERATION_ILLEGAL`
 * means somebody already decided it and there is nothing to retry,
 * `IDEMPOTENCY_KEY_REUSED` means choose another key, `REQUEST_WINDOW_CLOSED`
 * means the deadline has passed. Matching on the body's `error.code` rather than
 * on the HTTP status is what lets the surface say which one happened; the status
 * is the same for several of them.
 */
function rethrow(error: unknown): never {
  if (error instanceof ApiError) {
    const body = error.body as { error?: { code?: unknown; message?: unknown } } | undefined;
    const code = body?.error?.code;
    const message = body?.error?.message;
    if (typeof code === 'string' && typeof message === 'string') {
      throw new RequestRefusal(code, message, error.correlationId);
    }
  }
  throw error;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The REQUESTER's half — `requests.own.*`
 * ──────────────────────────────────────────────────────────────────────────── */

/** A member's own requests, newest first. */
export async function fetchOwnRequests(scope: GroupScope): Promise<RequestList> {
  return requestListSchema.parse(await apiRequest(`${base(scope)}/mine`));
}

/**
 * §3's effective deadline — BOTH dates, because the pair is the point.
 *
 * A surface showing only the effective date cannot explain why "requests close
 * on the 15th" is showing the 14th. The contract carries `nominal` and
 * `effective` together and this client does not collapse them.
 */
export async function fetchDeadline(scope: GroupScope): Promise<RequestDeadlineWire> {
  return requestDeadlineSchema.parse(await apiRequest(`${base(scope)}/deadline`));
}

/**
 * Submit ONE request — one action, one row, one request (I-10, I-13).
 *
 * There is no "create draft" call and no separate submit, because the contract
 * offers none: the `draft` status exists inside the server's transaction and is
 * never a state a client has seen or can address. So a surface cannot persist
 * anything before the completed, validated body arrives here, which is I-13
 * enforced by the shape of the API rather than by the discipline of a component.
 */
export async function submitRequest(
  scope: GroupScope,
  input: {
    readonly idempotencyKey: string;
    readonly record: RequestRecordWire;
    readonly periodStart?: string;
  },
): Promise<RequestWire> {
  const body = submitRequestSchema.parse({
    idempotencyKey: input.idempotencyKey,
    record: input.record,
    ...(input.periodStart === undefined ? {} : { periodStart: input.periodStart }),
  });
  try {
    return requestSchema.parse(
      await apiRequest(base(scope), {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(body),
      }),
    );
  } catch (error) {
    rethrow(error);
  }
}

/**
 * Take back one's own request. The ROOT's version, guarded (§4's conditional
 * rule is not weaker for a withdrawal than for a decision).
 *
 * There is deliberately no reason parameter: the contract has no field for one,
 * and an administrator ending somebody else's request is a DENIAL with a
 * mandatory reason — a different operation on a different key.
 */
export async function withdrawRequest(
  scope: GroupScope,
  requestId: string,
  expectedVersion: number,
): Promise<WithdrawRequestResult> {
  const body = withdrawRequestSchema.parse({ expectedVersion });
  try {
    return withdrawRequestResultSchema.parse(
      await apiRequest(`${base(scope)}/${requestId}/withdraw`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(body),
      }),
    );
  } catch (error) {
    rethrow(error);
  }
}

/**
 * Attach ONE reason code to one's own request (FAD-58.1).
 *
 * One code, never an array: I-16 — one turn, at most one accepted selection,
 * through one transaction. The parameter is typed as the contract's enum, so a
 * caller cannot pass a string the vocabulary does not contain, and the outgoing
 * `.strict()` parse refuses any companion field on top of that.
 */
export async function attachReasonCode(
  scope: GroupScope,
  requestId: string,
  reasonCode: RequestReasonCodeWire,
): Promise<RequestCommentResult> {
  const body = attachReasonCodeSchema.parse({ reasonCode });
  try {
    return requestCommentResultSchema.parse(
      await apiRequest(`${base(scope)}/${requestId}/reason-codes`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(body),
      }),
    );
  } catch (error) {
    rethrow(error);
  }
}

/** The requester's own thread — self-scoped, `requests.own.read`. Oldest first. */
export async function fetchOwnComments(
  scope: GroupScope,
  requestId: string,
): Promise<RequestCommentThread> {
  return requestCommentThreadSchema.parse(await apiRequest(`${base(scope)}/${requestId}/comments`));
}

/* ────────────────────────────────────────────────────────────────────────────
 * The SCHEDULER's half — `requests.read_any`, `.approve`, `.deny`, `.comment_any`
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The pending-review queue.
 *
 * Both filters are CLOSED vocabularies and are typed as such, so this client
 * cannot ask for a subtype or a status that does not exist; the server parses
 * them again and drops anything it does not recognise, which is the control that
 * actually holds.
 *
 * **The queue is the five non-vacation subtypes.** That is the server's rule,
 * not a filter applied here: `listPendingReview` skips vacation roots because
 * §5.3 gives that lifecycle one reader, and the vacation round has its own
 * surface. A caller that passed `subtype=vacation-selection` would get an empty
 * list, which is why the surface does not offer it as a choice.
 */
export async function fetchQueue(
  scope: GroupScope,
  filter: {
    readonly subtypes?: readonly RequestSubtypeWire[];
    readonly statuses?: readonly RequestStatusWire[];
  } = {},
): Promise<RequestQueue> {
  const params = new URLSearchParams();
  if (filter.subtypes !== undefined && filter.subtypes.length > 0) {
    params.set('subtype', filter.subtypes.join(','));
  }
  if (filter.statuses !== undefined && filter.statuses.length > 0) {
    params.set('status', filter.statuses.join(','));
  }
  const query = params.toString();
  return requestQueueSchema.parse(
    await apiRequest(`${base(scope)}/queue${query === '' ? '' : `?${query}`}`),
  );
}

/** One request in full: the aggregate, its record, every decision, and the thread. */
export async function fetchRequestDetail(
  scope: GroupScope,
  requestId: string,
): Promise<RequestDetail> {
  return requestDetailSchema.parse(await apiRequest(`${base(scope)}/${requestId}`));
}

/**
 * Approve one request. The version and nothing else.
 *
 * No reason parameter, and the absence is the rule rather than an omission: §4
 * makes a reason mandatory on a DENIAL and §5.5 on an override, and neither asks
 * for one on an ordinary approval. Migration 0024's CHECK refuses one in that
 * direction too.
 */
export async function approveRequest(
  scope: GroupScope,
  requestId: string,
  expectedVersion: number,
): Promise<DecisionResultWire> {
  const body = approveRequestSchema.parse({ expectedVersion });
  try {
    return decisionResultSchema.parse(
      await apiRequest(`${base(scope)}/${requestId}/approve`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(body),
      }),
    );
  } catch (error) {
    rethrow(error);
  }
}

/** Deny one request — the version, and §4's MANDATORY reason. */
export async function denyRequest(
  scope: GroupScope,
  requestId: string,
  input: { readonly expectedVersion: number; readonly reason: string },
): Promise<DecisionResultWire> {
  const body = denyRequestSchema.parse(input);
  try {
    return decisionResultSchema.parse(
      await apiRequest(`${base(scope)}/${requestId}/deny`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(body),
      }),
    );
  } catch (error) {
    rethrow(error);
  }
}

/**
 * Reverse an approval — the version, and a MANDATORY reason.
 *
 * The prior decision is not named in the body, deliberately: the server finds
 * it, because a client naming which decision it believes it is reversing would
 * be a client that could name the wrong one.
 */
export async function reverseDecision(
  scope: GroupScope,
  requestId: string,
  input: { readonly expectedVersion: number; readonly reason: string },
): Promise<DecisionResultWire> {
  const body = reverseDecisionSchema.parse(input);
  try {
    return decisionResultSchema.parse(
      await apiRequest(`${base(scope)}/${requestId}/reverse`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(body),
      }),
    );
  } catch (error) {
    rethrow(error);
  }
}

/**
 * Decide MANY requests in ONE request (I-10).
 *
 * One decision and one reason for the whole batch, and a list of
 * `(requestId, expectedVersion)` pairs — per-item reasons are deliberately not
 * offered by the contract, because a scheduler denying twenty requests has one
 * reason and twenty boxes get filled with the same sentence or with nothing.
 *
 * The answer is ONE OUTCOME PER ITEM, in the order sent, discriminated on `ok`.
 * A partial failure is per-item and never all-or-nothing silent, and the surface
 * renders every outcome rather than a count — a batch that half-succeeded and
 * reported "done" would be the failure this shape exists to prevent.
 */
export async function decideBatch(
  scope: GroupScope,
  input: {
    readonly decision: 'approved' | 'denied';
    readonly reason: string | null;
    readonly items: readonly { readonly requestId: string; readonly expectedVersion: number }[];
  },
): Promise<BatchDecisionResult> {
  const body = batchDecisionSchema.parse(input);
  try {
    return batchDecisionResultSchema.parse(
      await apiRequest(`${base(scope)}/decisions`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(body),
      }),
    );
  } catch (error) {
    rethrow(error);
  }
}

/**
 * Append a scheduler comment — bounded administrative text (FAD-58.2).
 *
 * The bound is the contract's, trimmed: 1..1000 after trimming, so a comment of
 * pure whitespace is refused on the way out rather than at a database
 * constraint. The surface SHOWS the bound rather than enforcing a different one
 * of its own.
 */
export async function appendComment(
  scope: GroupScope,
  requestId: string,
  commentBody: string,
): Promise<RequestCommentResult> {
  const body = appendSchedulerCommentSchema.parse({ body: commentBody });
  try {
    return requestCommentResultSchema.parse(
      await apiRequest(`${base(scope)}/${requestId}/comments`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(body),
      }),
    );
  } catch (error) {
    rethrow(error);
  }
}
