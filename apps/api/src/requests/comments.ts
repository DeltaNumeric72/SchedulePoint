import {
  commentContentIsWellFormed,
  type CommentChannel,
  type RequestComment,
  type RequestReasonCode,
  type UnitOfWork,
} from '@schedulepoint/domain';
import type { Kysely } from 'kysely';

import { recordAuditEvent } from '../audit/recorder.js';
import type { Database } from '../db/schema.js';

import { requestStore } from './store.js';

/**
 * SPEC-08 §4's fifth row — the COMMENT service, under **FAD-58**
 * (OPUS-M5-00C, doc 42 §5g).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## Two verbs, because FAD-58 rules two channels
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `attachReasonCode` is the REQUESTER's: at most one code per turn from the
 * controlled vocabulary, on their OWN request. `appendSchedulerComment` is the
 * DECIDER's: bounded administrative text, on a request in their queue.
 *
 * They are two functions rather than one taking a channel, and the reason is the
 * same one that gives them two capability keys: they are different acts by
 * different people with different authority, and a single entry point taking a
 * channel would be one place where the wrong branch is one argument away.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## The OWNERSHIP predicate, and why it lives HERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `attachReasonCode` writes a row BY ID from an own-scoped surface, which is the
 * class M5-003's register entry names — and the class exists because the two
 * controls anybody would cite are BOTH individually correct while their
 * composition leaves the rule undefended:
 *
 *  1. **L5.1 (`ownershipRequired: true`) passes BY CONSTRUCTION** on a
 *     self-scoped surface: the route names the ACTING MEMBERSHIP as its own
 *     target, because there is no subject in its path. So L5.1 cannot be the
 *     control that decides whose request this is.
 *  2. **RLS's ADMINISTRATION arm is not the control either.** Migration 0026's
 *     `request_comments_group_administration` is `FOR ALL` behind
 *     `requests.administer`, and 0023 is explicit that this is the design: "RLS
 *     decides which ROWS, never which OPERATIONS."
 *
 * So the operation-layer ownership predicate belongs here, and it is the line
 * below comparing `root.membershipId` to the VERIFIED context's membership. A
 * colleague's request answers `not-found`, byte-identically to a request that
 * does not exist — X-11's rule, and the same answer the withdrawal routes give.
 *
 * ### It is A control, not THE control — corrected at review, by mutation
 *
 * *(An earlier version of this paragraph said the service predicate is "the only
 * place" the rule can live. That overstates it, and the review proved so by
 * mutation: dropping the predicate alone does NOT open the hole, because
 * migration 0026's `request_comments_own` arm carries the SAME ownership
 * question in its `WITH CHECK` — the row must be on a request the acting
 * membership owns — so the forged INSERT is refused by the database with
 * `42501`, and `withRequests` maps that to the IDENTICAL `404`. Killing the
 * property required removing BOTH layers.)*
 *
 * The two are genuinely different controls and each is worth keeping. The
 * service predicate refuses BEFORE any statement issues and gives the route a
 * reason it can name; the RLS arm refuses on every path, including one that
 * never came through this module. **That they produce the same 404 is by
 * design, not by coincidence** — X-11 requires "not yours", "another group's"
 * and "no such request" to be one answer, so a reader cannot tell from outside
 * which layer refused, and neither can an attacker.
 *
 * The `_own` arm is therefore the second reason the ADMINISTRATION arm above is
 * not a hole: a holder of `requests.administer` reaching for a requester-channel
 * row meets that arm's `channel = 'requester'` pin, which admits only the
 * own-arm's shape.
 *
 * `appendSchedulerComment` has NO such predicate, deliberately: a decider
 * commenting only on their own requests would not be a decider. What scopes it
 * is the route's `requests.comment_any` key and 0026's group-scoped policy arms.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## I-16 — one turn, one accepted code, one transaction
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `AttachReasonCodeCommand` carries ONE `reasonCode`, not a list, and the wire
 * schema does not admit a list either. One append, one row, one unit of work
 * whose boundary the runner owns.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## I-07 — what a comment publishes, and the two absences that are NOT alike
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `publishComment` below emits `{ requestId, commentId, channel }` and nothing
 * else — every value a token or a uuid, which is what `assertClosedAuditPayload`
 * requires.
 *
 *  * **The body could not be there anyway.** `auditPayloadViolations` rejects any
 *    payload string containing a space or over 64 characters, and
 *    `app_audit_payload_is_closed` rejects the same in SQL. Prose contains
 *    spaces. Mechanical, and it holds for a writer nobody has written.
 *  * **The reason code COULD be there and deliberately is not.** `childcare` is a
 *    token; the validator would admit it. Its absence is a RULED choice: the
 *    audit chain is immutable and has its own reader population behind
 *    `audit.export`, so a code in a payload would put a fact about the
 *    requester's circumstances somewhere the comment table's own RLS does not
 *    reach. Narrower-never-wider. The chain records THAT a code was attached, by
 *    whom, and when — never WHICH.
 *
 * `apps/api/test/requests/comment-body-closure.test.ts` proves both halves, and
 * proves the second is not vacuous by feeding the code to the validator and
 * watching it pass.
 *
 * ## And NO OUTBOX ROW AT ALL
 *
 * FAD-58.5: "comment events may enqueue nothing in this packet". There is no
 * `publishOutboxEvent` call in this file and no import of one — the absence is
 * structural rather than remembered. I-11's posture is untouched because nothing
 * here notifies anybody; an outbound surface is a later packet against SPEC-07.
 *
 * ## Nothing here logs a comment
 *
 * Non-bypass rule 9. This module emits no log line at all, so there is no
 * formatter anywhere that could interpolate a body or a code into one.
 */

type Uow = UnitOfWork<Kysely<Database>>;

/* ────────────────────────────────────────────────────────────────────────────
 * Commands and outcomes
 * ──────────────────────────────────────────────────────────────────────────── */

export interface AttachReasonCodeCommand {
  readonly requestId: string;
  /**
   * The VERIFIED context's own membership — SPEC-01 §2.3 derives it server-side
   * — never a path parameter and never a body field. FAD-58.1's
   * "their own request" is decided on this value; see the header.
   */
  readonly membershipId: string;
  /** ONE code (I-16). The domain decides whether it is in the vocabulary. */
  readonly reasonCode: string;
}

export interface AppendSchedulerCommentCommand {
  readonly requestId: string;
  /** The acting membership; 0026's write policy requires the stored author to BE it. */
  readonly membershipId: string;
  readonly body: string;
}

/**
 * Why a comment was not appended — a closed vocabulary, so a caller can branch.
 *
 * Two members, and there is deliberately no version conflict: **a comment is an
 * append and conflicts with nothing**, which is what append-only buys. A caller
 * never has to reload before commenting, and there is no `expectedVersion` on
 * either command for the same reason.
 */
export const COMMENT_FAILURES = [
  /** No such request, or not visible in this tenant context, or not the caller's own. */
  'not-found',
  /** The domain's exactly-one-of rule, or the vocabulary, refused the content. */
  'content-refused',
] as const;

export type CommentFailure = (typeof COMMENT_FAILURES)[number];

export type CommentOutcome =
  | { readonly ok: true; readonly value: RequestComment }
  | { readonly ok: false; readonly failure: CommentFailure };

const refuse = (failure: CommentFailure): CommentOutcome => ({ ok: false, failure });

/**
 * How many comments one thread read returns.
 *
 * A bound rather than a client parameter, for the reason `QUEUE_PAGE_LIMIT` is a
 * bound: an unbounded read is one whose cost grows with how long a conversation
 * ran. **This is a bound on the READ and not on the WRITE** — neither §4 nor
 * FAD-58 bounds how many comments a request may carry, and inventing a cap would
 * be a rule §4 does not have. That asymmetry is recorded as an observation for
 * M5-006's integration sweep rather than closed here.
 */
export const COMMENT_THREAD_LIMIT = 200;

/* ────────────────────────────────────────────────────────────────────────────
 * The requester's channel — FAD-58.1
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * **Attach one reason code to one's OWN request.**
 *
 * Three steps, and the order matters:
 *
 *  1. **load the root and check it is the caller's own** — the ownership
 *     predicate the header explains, answering `not-found` for a colleague's
 *     request so that "not yours" and "no such request" are one answer;
 *  2. **ask the DOMAIN** whether the content is well-formed — the channel rule
 *     and the vocabulary, from `commentContentIsWellFormed`;
 *  3. **write through the store**, where migration 0026's CHECKs ask (2) again
 *     and refuse it independently, and where the RLS `WITH CHECK` additionally
 *     pins the channel and the author.
 *
 * **There is no status predicate**, and the omission is a ruled decision: §4's
 * comments row states four properties and a lifecycle gate is not among them,
 * and FAD-58.3's "correction is a new comment" wants headroom rather than a
 * gate. A code can therefore be attached to a withdrawn, denied or expired
 * request — and appending one moves nothing, which
 * `apps/api/test/requests/request-comments.test.ts` proves by reading the root
 * back byte-identically.
 */
export async function attachReasonCode(
  uow: Uow,
  command: AttachReasonCodeCommand,
): Promise<CommentOutcome> {
  const root = await requestStore.loadRoot(uow, command.requestId);
  if (root === null) return refuse('not-found');

  /* The by-id-write ownership class, cured at the layer that decides
   * operations. See the header for why neither L5.1 nor RLS decides it. */
  if (root.membershipId !== command.membershipId) return refuse('not-found');

  const verdict = commentContentIsWellFormed({
    channel: 'requester',
    reasonCode: command.reasonCode,
    body: null,
  });
  if (!verdict.ok) return refuse('content-refused');
  if (verdict.content.channel !== 'requester') return refuse('content-refused');

  return append(uow, {
    requestId: command.requestId,
    authorMembershipId: command.membershipId,
    channel: 'requester',
    reasonCode: verdict.content.reasonCode,
    body: null,
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * The decider's channel — FAD-58.2
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * **Append one bounded administrative comment to a request in the queue.**
 *
 * The same three steps without step 1's ownership half: a decider acts on other
 * people's rows on purpose. What scopes this is the route's declared
 * `requests.comment_any` key, evaluated against current state inside this same
 * transaction (I-19), and migration 0026's group-scoped policy arms — which also
 * refuse a `requester`-channel row from this path, so a decider cannot attach a
 * CODE to somebody else's request and thereby attribute a circumstance to them.
 *
 * The root is still loaded, and not only to be polite about `not-found`: a
 * comment on a request this context cannot see must answer exactly as a comment
 * on a request that does not exist, and letting the foreign-key violation decide
 * would produce a `409` that confirms the row exists somewhere.
 */
export async function appendSchedulerComment(
  uow: Uow,
  command: AppendSchedulerCommentCommand,
): Promise<CommentOutcome> {
  const root = await requestStore.loadRoot(uow, command.requestId);
  if (root === null) return refuse('not-found');

  const verdict = commentContentIsWellFormed({
    channel: 'scheduler',
    reasonCode: null,
    body: command.body,
  });
  if (!verdict.ok) return refuse('content-refused');
  if (verdict.content.channel !== 'scheduler') return refuse('content-refused');

  return append(uow, {
    requestId: command.requestId,
    authorMembershipId: command.membershipId,
    channel: 'scheduler',
    reasonCode: null,
    body: verdict.content.body,
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * The read
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * One request's comment thread, oldest first, bounded.
 *
 * **This function applies no visibility rule of its own**, and saying so is the
 * point: the ratified reader table is implemented by migration 0026's three
 * policy arms plus the calling route's declared key, and a predicate here would
 * be a third copy that can drift from both. A caller who may not see the rows
 * gets an empty list from RLS; a caller who may not call the route at all never
 * reaches this function.
 */
export async function listComments(uow: Uow, requestId: string): Promise<readonly RequestComment[]> {
  return requestStore.listComments(uow, requestId, COMMENT_THREAD_LIMIT);
}

/**
 * **The REQUESTER's own thread**, or `null` when the request is not theirs.
 *
 * The read counterpart of `attachReasonCode`'s ownership predicate, and it
 * exists for the reason `requests.route.ts` gives for querying on
 * `uow.context.membershipId` rather than on a path parameter: *"the
 * authorization decides the request; the predicate decides the rows; the policy
 * decides them a third time."*
 *
 * Without it the own-thread route would still be correct and would still be
 * WEAKER: a scheduler holds `requests.own.read` by role (FAD-57) and also holds
 * `requests.read_any`, so on a colleague's request migration 0026's
 * `request_comments_group_read_any` arm would answer with rows on a route whose
 * whole declaration says "one's own". That is not a widening — the ratified
 * table already lets a decider read the queue's comments through the detail read
 * — but it would make the route's own predicate decide nothing, and a control
 * that decides nothing is one nobody notices losing.
 *
 * `null` rather than an empty list, so the route can answer `404` and make "not
 * yours", "another group's" and "no such request" byte-identical (X-11).
 */
export async function listOwnComments(
  uow: Uow,
  requestId: string,
  membershipId: string,
): Promise<readonly RequestComment[] | null> {
  const root = await requestStore.loadRoot(uow, requestId);
  if (root === null || root.membershipId !== membershipId) return null;
  return requestStore.listComments(uow, requestId, COMMENT_THREAD_LIMIT);
}

/* ────────────────────────────────────────────────────────────────────────────
 * The one write path, and the audit row it emits
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The insert and its audit row, in the caller's transaction.
 *
 * One private function for both channels, because the DIFFERENCES between them
 * are all upstream — who may act, what the content is, whose request it must be —
 * and the write itself is identical. A second copy would be the one that
 * forgot the audit row.
 */
async function append(
  uow: Uow,
  row: {
    readonly requestId: string;
    readonly authorMembershipId: string;
    readonly channel: CommentChannel;
    readonly reasonCode: RequestReasonCode | null;
    readonly body: string | null;
  },
): Promise<CommentOutcome> {
  const commentId = await requestStore.appendComment(uow, row);
  await publishComment(uow, {
    requestId: row.requestId,
    commentId,
    channel: row.channel,
  });

  const thread = await requestStore.listComments(uow, row.requestId, COMMENT_THREAD_LIMIT);
  const written = thread.find((comment) => comment.id === commentId);
  if (written === undefined) {
    /* Unreachable: the row was just inserted in this transaction and both write
     * policies' `USING` clauses admit what their `WITH CHECK` clauses allowed in.
     * Kept for the reason the store keeps its twin — "the insert produced a row
     * nobody can read" must never become "the comment was recorded". */
    throw new Error('COMMENT_NOT_READABLE_AFTER_INSERT: the appended comment could not be read.');
  }
  return { ok: true, value: written };
}

/**
 * One comment's audit row. **There is no outbox counterpart** (FAD-58.5).
 *
 * **Every value below is a token or a uuid**, and the function's own signature is
 * the boundary: there is no parameter that could carry a body or a code, so a
 * future caller cannot add one without editing this declaration and meeting the
 * test that reads it. That is the same shape `publishDecision` uses for the same
 * reason, with one difference worth stating — a decision's reason is
 * structurally inexpressible in a payload, while a comment's CODE is perfectly
 * expressible and is left out by ruling. See the header.
 */
async function publishComment(
  uow: Uow,
  facts: {
    readonly requestId: string;
    readonly commentId: string;
    readonly channel: CommentChannel;
  },
): Promise<void> {
  await recordAuditEvent(uow, {
    eventName:
      facts.channel === 'requester'
        ? 'requests.request.reason_code_attached'
        : 'requests.request.comment_appended',
    subjectType: 'request',
    subjectId: facts.requestId,
    payload: {
      requestId: facts.requestId,
      commentId: facts.commentId,
      channel: facts.channel,
    },
  });
}
