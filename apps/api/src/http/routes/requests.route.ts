import {
  appendSchedulerCommentSchema,
  approveRequestSchema,
  attachReasonCodeSchema,
  batchDecisionResultSchema,
  batchDecisionSchema,
  commentRefusalBodySchema,
  conflictBodySchema,
  decisionRefusalBodySchema,
  decisionResultSchema,
  denyRequestSchema,
  idempotencyKeyReusedBodySchema,
  isUuid,
  requestCommentResultSchema,
  requestCommentThreadSchema,
  requestDeadlineRefusalBodySchema,
  requestDeadlineSchema,
  requestDetailSchema,
  requestIllegalOperationBodySchema,
  requestListSchema,
  requestQueueSchema,
  requestSchema,
  reverseDecisionSchema,
  submitRequestSchema,
  validationProblemBodySchema,
  vacationSelectionRefusalBodySchema,
  withdrawRequestResultSchema,
  withdrawRequestSchema,
  type RequestWire,
} from '@schedulepoint/contracts';
import {
  REQUEST_STATUSES,
  REQUEST_SUBTYPES,
  type Approval,
  type Decision,
  type RequestComment,
  type DecisionItemFailure,
  type FieldProblem,
  type Request as DomainRequest,
} from '@schedulepoint/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  evaluateAction,
  evaluateInTransaction,
  evaluationContextOf,
  respondToDenial,
} from '../../authz/authorize-request.js';
import { isPostgresError } from '../../db/pg-errors.js';
import { deadlineFor, loadGroupDeadlineContext } from '../../requests/deadlines.js';
import {
  appendSchedulerComment,
  attachReasonCode,
  listComments,
  listOwnComments,
  type CommentFailure,
} from '../../requests/comments.js';
import {
  decideRequest,
  decideRequestsBatch,
  reverseDecision,
} from '../../requests/decisions.js';
import {
  submitRequest,
  withdrawRequest,
  type RequestFailure,
  type RequestOutcome,
  type SubmitResult,
} from '../../requests/service.js';
import { requestStore } from '../../requests/store.js';
import {
  loadVacationRequest,
  submitVacationSelection,
  type VacationSelectionServiceFailure,
} from '../../requests/vacation-selection.js';
import { requireTenantContext } from '../context/middleware.js';
import { sendNotFound } from '../context/responses.js';
import { MEMBERSHIP_AGGREGATE } from '../context/target-resolution.js';
import type { RouteConfigWithPolicy } from '../policy.js';

/**
 * The staff request surface — SPEC-08 §§3–4, CAP-021 (OPUS-M5-001, doc 42 §5c
 * Part D).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ## Four routes, and what each one is
 *
 * | Route | Is | Is not |
 * |---|---|---|
 * | `POST …/requests` | ONE staff submission, idempotent by D-7 | a draft-creating endpoint — see I-13 below |
 * | `POST …/requests/:requestId/withdraw` | the REQUESTER taking their own request back (§4) | an administrator withdrawing for somebody — that is a DENIAL with a reason, M5-002's |
 * | `GET …/requests/mine` | one's own requests | a lookup for a named colleague's — see the self-scoping section |
 * | `GET …/requests/deadline` | §3's effective deadline for this group | a client-computed deadline; the client never computes one |
 *
 * **There is no scheduler queue route in this packet**, and its absence is
 * deliberate rather than an omission. `requests.read_any` exists — it is the RLS
 * key the SENSITIVE-PII narrowing needs, and the sweeper and M5-002 need it —
 * but a queue is a surface with filters, sorting, batch selection and an
 * approval affordance beside every row, and §4's decision verbs are M5-002's.
 * Shipping a read-only queue now would fix the shape of a surface whose whole
 * purpose is the actions it does not yet have.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## OPUS-M5-002 — the queue arrived, with the affordances it was waiting for
 *
 * The paragraph above is M5-001's and is kept, because it is the REASON the
 * queue waited and the reason it is shaped the way it is now: it was moved to
 * this packet as a ratified scope MOVE, on the argument that *a queue's shape IS
 * its decision affordances*. Six routes join the four:
 *
 * | Route | Is | Key |
 * |---|---|---|
 * | `GET …/requests/queue` | the pending-review queue, filterable | `requests.read_any` |
 * | `GET …/requests/:requestId` | one request in full, with its decision history | `requests.read_any` |
 * | `POST …/requests/:requestId/approve` | §4's approval | `requests.approve` |
 * | `POST …/requests/:requestId/deny` | §4's denial, with a MANDATORY reason | `requests.deny` |
 * | `POST …/requests/:requestId/reverse` | §4's reversal — a NEW decision record | `requests.approve` |
 * | `POST …/requests/decisions` | a batch, with PER-ITEM outcomes | `requests.batch_approve` |
 *
 * **The filter's "group" is the path parameter itself**, and saying so is more
 * honest than adding a query field: doc 42 §5d asks for a queue "filterable by
 * subtype/status/group", and `:groupId` already selects the group while RLS
 * scopes the rows to it. A `group` query parameter would be a second, weaker copy
 * of a control that already holds, and it is the copy a later reader would trust.
 *
 * **`approved` is reachable through the four decision routes and nowhere else on
 * this surface**, which is the §5c binding note discharged at the layer that
 * decides operations. See migration 0024's header §4 for the full ruling and the
 * residue it deliberately leaves, and `test/requests/decision-authority.test.ts`
 * for the proof.
 *
 * ## §4's COMMENTS are not here, and the absence is a ruled scope MOVE
 *
 * SPEC-08 §4 has five rows and this surface now carries four of them: approve,
 * deny with a mandatory reason, reversal as a new record, and — through
 * `requests.own.withdraw` — withdrawal. **Comments are the fifth, and they moved
 * to a dedicated packet by escalation** (doc 42 §5d pre-authorized exactly this:
 * *"if the implementer judges the I-07 boundary needs its own packet, escalate
 * rather than squeeze"*), ruled and recorded at this packet's landing.
 *
 * The reason in one sentence, because a reader who comes looking for a comment
 * endpoint deserves it here rather than in a register: **every bounded-free-text
 * precedent this repository holds is SCHEDULER-authored administrative text about
 * a scheduling act** — `schedule_versions.change_summary`,
 * `vacation_selections.override_reason`, and `approvals.reason` in this packet.
 * §4's comments are REQUESTER-authored text about the requester's own
 * circumstances, on a `SENSITIVE-PII` aggregate, in a product where the honest
 * answer to "why that Friday?" is frequently a medical one. I-07 is not
 * patient-scoped — *"no patient-identifying information **or clinical free text**
 * enters the system"* — and a length bound bounds SIZE, not KIND.
 *
 * The working default until that packet's decision lands: the requester-side
 * channel is a CONTROLLED VOCABULARY (I-17's spirit), with free text confined to
 * the scheduler-side administrative class the precedents already cover. **No
 * column exists before it is ruled on.**
 *
 * ## OPUS-M5-00C — the ruling landed, and the working default became the rule
 *
 * **FAD-58 (2026-08-27)** resolved the escalation above, adopting its reasoning
 * verbatim as the ruling's basis. Three routes join the ten, and the paragraphs
 * above are kept because they are the REASON these three are shaped the way they
 * are:
 *
 * | Route | Is | Key |
 * |---|---|---|
 * | `POST …/requests/:requestId/reason-codes` | the REQUESTER attaching ONE controlled-vocabulary code to their OWN request | `requests.own.comment` |
 * | `POST …/requests/:requestId/comments` | a DECIDER appending bounded administrative text to a request in their queue | `requests.comment_any` |
 * | `GET …/requests/:requestId/comments` | the REQUESTER reading their OWN request's thread, both channels | `requests.own.read` |
 *
 * **The two resources have different names because the two acts are different
 * things.** A requester does not write a comment; they attach a code from a
 * curated non-clinical list in which `other` is TERMINAL, because I-07 forbids
 * clinical free text and not merely patient identifiers, and in this product the
 * honest answer to "why that Friday?" is frequently a medical one. There is no
 * text field on `POST …/reason-codes` at any layer — the body schema is
 * `.strict()` with no such member, so a body carrying one is refused
 * STRUCTURALLY rather than having its value dropped.
 *
 * **`GET` and `POST` on `…/comments` carry different keys, and that is the
 * design rather than an inconsistency.** Reading one's own thread and appending
 * an administrative note to somebody else's request are different acts by
 * different people; the route table decides per method, and pretending
 * otherwise would mean giving one of them the other's population.
 *
 * ## The reader table, and where each cell is enforced
 *
 * The governing sentence, ratified for this packet and taken from migration
 * 0024's header §3 where it was already shipped for a decision reason: **a
 * comment is visible exactly where the REQUEST it is on is visible, and no
 * wider.** §4 says "visible per capability" and names no reader; the capability
 * that decides whether somebody may see a request is the capability that decides
 * whether they may see what is attached to it, and a separate comment-read key
 * would be a second visibility rule that can drift from the first.
 *
 * | Role (doc 08 §6) | Read own thread | Read a colleague's | Attach a code to own | Attach a code to a colleague's | Append a scheduler comment |
 * |---|---|---|---|---|---|
 * | Member | ✓ `requests.own.read` | — 404 | ✓ `requests.own.comment` | — 404 | — |
 * | Viewer | — | — | — | — | — |
 * | Telecom | — | — | — | — | — |
 * | Scheduler | ✓ (as requester) | ✓ `requests.read_any`, through the DETAIL read | ✓ own only | — 404 | ✓ `requests.comment_any` |
 * | Group Admin | — | — | — | — | — |
 * | Org Admin | — | — | — | — | — |
 *
 * **Group Admin and Org Admin are `—` on every write cell because doc 08 §6's
 * two rows say `—` — the document deciding, not this file.** "Submit
 * requests/vacation" is `✓` for Member and Scheduler only; "Approve
 * requests/vacation" is `✓` for Scheduler only. Both roles reach a comment
 * surface the way any role does that a document marks `—`: by taking a grant.
 *
 * **A decider reads comments through `GET …/requests/:requestId`**, the detail
 * read, which now carries the thread beside the decision history. That is the
 * reader table's second forced cell implemented without a fourth route: the key
 * that already decides that read (`requests.read_any`) is the key that decides
 * the thread.
 *
 * ## Two absences, both ruled rather than overlooked
 *
 * **There is no internal-note class.** Both channels are visible to everyone who
 * may see the request, including the requester — 0024's `approvals_own` exists
 * precisely so a denial's reason reaches the person it is for, and FAD-58.4 says
 * "their own request's comments", not one channel of them. If deciders ever need
 * private deliberation notes, **that is a NEW CONCEPT and needs its own recorded
 * decision**; it is not something a later packet may add by widening a policy.
 *
 * **There is no status gate and no `expectedVersion`.** §4's comments row states
 * four properties and a lifecycle predicate is not among them, so a code can be
 * attached to a withdrawn, denied or expired request; and a comment is an APPEND,
 * which conflicts with nothing, so there is no version to send and no conflict to
 * report. Appending one leaves the root byte-identical.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## I-13 and I-10 — one action, one request, nothing persisted before Save
 *
 * The initial-INSERT ruling makes `draft` the status every row is born at. That
 * is a statement about the database, and this surface deliberately does not
 * expose it: **there is no route that creates a draft.** A staff member fills in
 * a form and presses Submit; that is ONE action, it produces ONE request (I-10),
 * and the `draft` row exists only inside the server's transaction, between two
 * statements, visible to nobody.
 *
 * I-13 exists because a control labelled Add created a live record on click in a
 * real system. The shape that cannot do that is the one here: no endpoint
 * persists anything until a completed, validated body arrives.
 *
 * ## Self-scoping, and what it means on this surface
 *
 * All three staff routes declare `requiresObjectPolicy: true` with
 * `ownershipRequired: true` and **no `ownershipOverrideCapability`**. The
 * omission is the ruling, exactly as it is on `schedule.own_published.read`:
 * **no administrative capability lifts the ownership requirement**, so
 * "withdraw somebody else's request" is not a power that exists. §4 says
 * withdrawal is requester-initiated only and that an administrator
 * "withdrawing" for somebody is a denial with a reason — an ownership override
 * here would be precisely the confusion §4 forbids, spelled as a config field.
 *
 * The target is resolved INSIDE the unit of work, so a sibling group's
 * membership is invisible to RLS, the target is `null`, and the denial is
 * `OBJECT_POLICY` → the single `404` body every tenant not-found produces.
 * Member A asking about member B, a member of another group, and a membership id
 * that names nothing therefore produce byte-identical replies.
 *
 * **And the queries are self-scoped too**, on `uow.context.membershipId` rather
 * than on any path parameter. The authorization decides the request; the
 * predicate decides the rows; migration 0023's `requests_own` policy decides
 * them a third time. If the policy declaration were ever disarmed, the rows
 * would still be the caller's own — and if the query were disarmed too, RLS
 * would still refuse.
 *
 * ## Parsing happens AFTER the verdict, never before
 *
 * The SBX-001 disclosure finding, applied here as it is on the schedule read
 * surface: parsing first would let an actor who holds nothing in this group send
 * a malformed body and receive a `422` describing the field, while a genuinely
 * absent route answers `404`. Those two must be indistinguishable.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Policies. Three action keys, none of them an override
 * ──────────────────────────────────────────────────────────────────────────── */

/** Submit one's OWN request — `requests.own.submit`, CAP-021. */
export const SUBMIT_REQUEST_CONFIG = {
  policy: { kind: 'capability', capability: 'CAP-021' },
  actionScope: 'group',
  action: {
    key: 'requests.own.submit',
    moduleKey: 'requests_vacation',
    requiresObjectPolicy: true,
    ownershipRequired: true,
  },
} as const satisfies RouteConfigWithPolicy;

/**
 * Withdraw one's OWN request — `requests.own.withdraw`, CAP-021.
 *
 * No `ownershipOverrideCapability`, and that is §4 enforced by the type system
 * rather than by a reviewer noticing: an administrator cannot reach this route
 * for somebody else's request at all, so the only way an administrator ends a
 * request is the denial-with-a-reason §4 names, which M5-002 implements under
 * its own key.
 */
export const WITHDRAW_REQUEST_CONFIG = {
  policy: { kind: 'capability', capability: 'CAP-021' },
  actionScope: 'group',
  action: {
    key: 'requests.own.withdraw',
    moduleKey: 'requests_vacation',
    requiresObjectPolicy: true,
    ownershipRequired: true,
  },
} as const satisfies RouteConfigWithPolicy;

/** Read one's OWN requests, and the group's deadline — `requests.own.read`, CAP-021. */
export const OWN_REQUESTS_CONFIG = {
  policy: { kind: 'capability', capability: 'CAP-021' },
  actionScope: 'group',
  action: {
    key: 'requests.own.read',
    moduleKey: 'requests_vacation',
    requiresObjectPolicy: true,
    ownershipRequired: true,
  },
} as const satisfies RouteConfigWithPolicy;

/* ────────────────────────────────────────────────────────────────────────────
 * OPUS-M5-002 — the SCHEDULER's half of this surface
 *
 * ## Why these four declarations are shaped differently from the three above
 *
 * The three above are self-scoped: `ownershipRequired: true` with no override, so
 * "act on somebody else's request" is not a power that exists on them. The four
 * below are the opposite by design — a queue that could only show the reader's own
 * requests would not be a queue — so they declare `requiresObjectPolicy: false`
 * and no ownership at all.
 *
 * **That is not a hole where the self-scoping used to be.** What decides which
 * rows a scheduler may see and write is migration 0023's narrowing:
 * `requests_group_read_any` (`FOR SELECT`, behind `requests.read_any`) and
 * `requests_group_administration` (`FOR ALL`, behind `requests.administer`). A
 * caller holding neither sees zero rows whatever this declaration says, because
 * RLS is not a function of which URL was called. L5.1 is switched off here
 * precisely because the ownership question it asks — "does the target belong to
 * the actor" — has the answer "no, deliberately", and leaving it on with an
 * OVERRIDE capability would be spelling that as an exception rather than as the
 * design.
 *
 * ## Two keys for the decision, and a third for the batch
 *
 * `requests.approve` and `requests.deny` are separately grantable, so the power to
 * refuse and the power to commit the group can be held apart. `requests.batch_approve`
 * is an ADDITIONAL grant on the batch route — doc 08 §6, "batch requires a grant"
 * — and the handler re-evaluates the per-item decision key inside the same
 * transaction, so a holder of the batch key alone decides nothing.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The pending-review queue and the request detail read — `requests.read_any`. */
export const SCHEDULER_READ_CONFIG = {
  policy: { kind: 'capability', capability: 'CAP-021' },
  actionScope: 'group',
  action: {
    key: 'requests.read_any',
    moduleKey: 'requests_vacation',
    requiresObjectPolicy: false,
  },
} as const satisfies RouteConfigWithPolicy;

/**
 * Approve a request, and reverse an approval — `requests.approve`, CAP-021.
 *
 * The reversal shares this key rather than taking a fourth: it acts ON an
 * approval, and the authority to approve is the authority to un-approve. A
 * separate key would be a new grant nobody asked for, and rule 11 cuts in both
 * directions — never narrow a capability, and never invent one either.
 */
export const APPROVE_REQUEST_CONFIG = {
  policy: { kind: 'capability', capability: 'CAP-021' },
  actionScope: 'group',
  action: {
    key: 'requests.approve',
    moduleKey: 'requests_vacation',
    requiresObjectPolicy: false,
  },
} as const satisfies RouteConfigWithPolicy;

/**
 * Deny a request — `requests.deny`, CAP-021.
 *
 * **This is what §4 means by "an administrator 'withdrawing' for someone is a
 * denial with a reason, recorded as such".** It is the only door an administrator
 * has to end somebody else's request, which is why `WITHDRAW_REQUEST_CONFIG`
 * carries no ownership override — the two facts are one design and each is
 * unsafe without the other.
 */
export const DENY_REQUEST_CONFIG = {
  policy: { kind: 'capability', capability: 'CAP-021' },
  actionScope: 'group',
  action: {
    key: 'requests.deny',
    moduleKey: 'requests_vacation',
    requiresObjectPolicy: false,
  },
} as const satisfies RouteConfigWithPolicy;

/** Decide many at once — `requests.batch_approve`, an ADDITIONAL grant. */
export const BATCH_DECISION_CONFIG = {
  policy: { kind: 'capability', capability: 'CAP-021' },
  actionScope: 'group',
  action: {
    key: 'requests.batch_approve',
    moduleKey: 'requests_vacation',
    requiresObjectPolicy: false,
  },
} as const satisfies RouteConfigWithPolicy;

/* ────────────────────────────────────────────────────────────────────────────
 * OPUS-M5-00C — §4's fifth row, under FAD-58
 *
 * TWO declarations for three routes, because the own-thread READ rides
 * `OWN_REQUESTS_CONFIG` above. That reuse IS the ruling: a comment is visible
 * exactly where the request it is on is visible, and `requests.own.read` already
 * means "read one's own requests and their status history". A third key would be
 * a second visibility rule to keep in step with the first.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Attach ONE reason code to one's OWN request — `requests.own.comment`, CAP-021.
 *
 * Shaped exactly like `SUBMIT_REQUEST_CONFIG` and `WITHDRAW_REQUEST_CONFIG`,
 * with **no `ownershipOverrideCapability`**, and the omission is the ruling
 * rather than a default: a reason code is a statement about the requester's own
 * circumstances, so "attach a code to somebody else's request" is not a power
 * that exists. An administrator with something to say about a colleague's
 * request says it on the scheduler channel below, under their own name and in
 * their own words.
 *
 * L5.1 passes here BY CONSTRUCTION, as it does on every route of this
 * self-scoped surface, so the declaration is not what keeps a scheduler off a
 * colleague's request — `attachReasonCode`'s ownership predicate is. See its
 * docblock, and `test/requests/own-write-ownership.test.ts` for the class.
 */
export const ATTACH_REASON_CODE_CONFIG = {
  policy: { kind: 'capability', capability: 'CAP-021' },
  actionScope: 'group',
  action: {
    key: 'requests.own.comment',
    moduleKey: 'requests_vacation',
    requiresObjectPolicy: true,
    ownershipRequired: true,
  },
} as const satisfies RouteConfigWithPolicy;

/**
 * Append an administrative comment to a request in the queue —
 * `requests.comment_any`, CAP-021.
 *
 * Shaped like the four decision declarations rather than the three staff ones:
 * `requiresObjectPolicy: false` and no ownership at all, because a decider who
 * could only comment on their own requests would not be a decider. What scopes
 * the rows is migration 0026's group-scoped policy arms, and what decides the
 * OPERATION is this key.
 *
 * **A separate key from `requests.approve`/`requests.deny`, deliberately.**
 * Commenting on a request is not deciding it, and a scheduler who may annotate a
 * queue is not thereby a scheduler who may approve out of it. That is a
 * narrowing, in the same direction M5-002's two-keys-not-one split was.
 */
export const APPEND_COMMENT_CONFIG = {
  policy: { kind: 'capability', capability: 'CAP-021' },
  actionScope: 'group',
  action: {
    key: 'requests.comment_any',
    moduleKey: 'requests_vacation',
    requiresObjectPolicy: false,
  },
} as const satisfies RouteConfigWithPolicy;

/* ────────────────────────────────────────────────────────────────────────────
 * Outcomes
 * ──────────────────────────────────────────────────────────────────────────── */

type Uow = Parameters<Parameters<FastifyRequest['server']['tenancy']['runtime']['run']>[1]>[0];

type Outcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'denied'; readonly decision: Decision }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'invalid'; readonly problems: readonly FieldProblem[] }
  | { readonly kind: 'deadline'; readonly failure: Extract<RequestFailure, { kind: 'deadline' }> }
  | {
      readonly kind: 'illegal-operation';
      readonly failure: Extract<RequestFailure, { kind: 'illegal-operation' }>;
    }
  /** OPUS-M5-002 — §4's decision refusals, whose codes are their own vocabulary. */
  | {
      readonly kind: 'decision-refused';
      readonly code:
        | 'REQUEST_OPERATION_ILLEGAL'
        | 'DECISION_REASON_REQUIRED'
        | 'SUBTYPE_NOT_DECIDABLE';
    }
  /**
   * OPUS-M5-003 — FU-23's named ending. This member's key already names a
   * request of a DIFFERENT subtype: not a replay, and not something reloading
   * fixes. The subtype it names discloses nothing — D-7's uniqueness is scoped to
   * `membership_id`, so the row is the caller's own.
   */
  | { readonly kind: 'key-reused'; readonly existingSubtype: RequestSubtypeName }
  /**
   * OPUS-M5-00C — §4's comment refusals (FAD-58).
   *
   * ONE code, because there is one way to be refused that is not already a 404:
   * the content did not satisfy the domain's exactly-one-of rule or the
   * controlled vocabulary. There is deliberately no conflict member — a comment
   * is an append and conflicts with nothing.
   */
  | { readonly kind: 'comment-refused' }
  /** OPUS-M5-003 — §5.3's member-side refusals on the vacation round. */
  | {
      readonly kind: 'vacation-refused';
      readonly code:
        | 'SELECTION_NOT_PENDING'
        | 'VACATION_ROUND_NOT_OPEN'
        | 'VACATION_WEEK_ALREADY_SELECTED';
    };

/** The subtype vocabulary, named locally so the union above reads as one line. */
type RequestSubtypeName = (typeof REQUEST_SUBTYPES)[number];

const MAX_PROBLEM_MESSAGE = 300;

function parseBody<T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: unknown } },
  body: unknown,
): Outcome<T> {
  const parsed = schema.safeParse(body);
  if (parsed.success && parsed.data !== undefined) return { kind: 'ok', value: parsed.data };

  const issues =
    (parsed.error as { issues?: { path: (string | number)[]; message: string }[] } | undefined)
      ?.issues ?? [];
  const problems = issues.slice(0, 40).map((issue) => ({
    field: (issue.path.length > 0 ? issue.path.join('.') : 'body').slice(0, 64),
    message:
      issue.message.length > MAX_PROBLEM_MESSAGE
        ? `${issue.message.slice(0, MAX_PROBLEM_MESSAGE - 1)}…`
        : issue.message,
  }));
  return {
    kind: 'invalid',
    problems:
      problems.length > 0
        ? problems
        : [{ field: 'body', message: 'The request body is not valid.' }],
  };
}

/** A service outcome, translated to the route's shape. One mapping, used by both writers. */
function fromService<T>(outcome: RequestOutcome<T>): Outcome<T> {
  if (outcome.ok) return { kind: 'ok', value: outcome.value };
  switch (outcome.failure.kind) {
    case 'not-found':
      return { kind: 'not-found' };
    case 'conflict':
      return { kind: 'conflict' };
    case 'deadline':
      return { kind: 'deadline', failure: outcome.failure };
    case 'illegal-operation':
      return { kind: 'illegal-operation', failure: outcome.failure };
    case 'idempotency-key-reused':
      return { kind: 'key-reused', existingSubtype: outcome.failure.existingSubtype };
  }
}

/**
 * A vacation selection service failure, as the route's shape.
 *
 * The three vacation codes are their own vocabulary for the reason the decision
 * codes are: each has a different remedy, and a caller that could not tell
 * "this round is not open" from "you already hold this week" is a caller that
 * cannot act on either.
 */
function fromVacationSelection<T>(failure: VacationSelectionServiceFailure): Outcome<T> {
  switch (failure.kind) {
    case 'not-found':
      return { kind: 'not-found' };
    case 'reused':
      return { kind: 'key-reused', existingSubtype: failure.existingSubtype };
    case 'refused':
      return { kind: 'vacation-refused', code: failure.code };
    case 'deadline':
      return {
        kind: 'deadline',
        failure: { kind: 'deadline', detail: failure.detail, effective: failure.effective },
      };
  }
}

/**
 * One unit of work, one authorization verdict, with the target resolved inside
 * it.
 *
 * The target is always the ACTING membership, because every route on this
 * surface is self-scoped and none of them names a subject in its path. That is
 * not a shortcut around L5.1 — it is what makes the declaration have
 * consequences: `ownershipRequired` compares the target's owner to the acting
 * membership, and here they are the same by construction, so a route that ever
 * gained a subject parameter would fail this comparison rather than silently
 * start authorizing it.
 */
async function withRequests<T>(
  request: FastifyRequest,
  run: (uow: Uow) => Promise<Outcome<T>>,
): Promise<Outcome<T>> {
  const { context, command, route } = requireTenantContext(request);

  return request.server.tenancy.runtime.run(command, async (uow): Promise<Outcome<T>> => {
    try {
      const { decision } = await evaluateInTransaction(uow.query, {
        request,
        context,
        route,
        target: {
          /* The VERIFIED context's own tenant, never a path parameter. SPEC-01
           * §2.3 derives `membershipId` server-side at step 2 and the expected
           * organization and group are the declared-and-verified pair, so this
           * target is the acting membership by construction rather than by a
           * lookup that could resolve to somebody else. */
          organizationId: context.expectedOrganizationId,
          groupId: context.expectedGroupId,
          type: MEMBERSHIP_AGGREGATE,
          ownerMembershipId: context.membershipId,
          state: null,
        },
      });
      if (!decision.allowed) return { kind: 'denied', decision };

      return await run(uow);
    } catch (error) {
      /* A non-database fault is re-thrown to `setErrorHandler`, which logs it
       * with its stack and answers 500 with the fixed message. Catching
       * everything would turn a bug in this process into a 404 whose log line
       * asserted "refused by the database" about an unexamined cause. */
      if (!isPostgresError(error)) throw error;
      /* Every guard in migrations 0021 and 0023 raises `restrict_violation` —
       * an illegal transition, a creation at the wrong status, a missing
       * revision flag, a lifecycle flag set at creation. The DOMAIN refuses all
       * of these first, with a reason the caller can branch on; reaching here
       * means the domain check was bypassed and the database refused.
       *
       * **Such a refusal becomes a 404, not a 409, and that is deliberate.**
       * Only the two concurrency classes below — `23505`/`23P01` unique and
       * exclusion violations, and `2BP01` — map to `conflict`, because those
       * genuinely mean "you were authorized and the world moved". A
       * `restrict_violation` reaching this far is a row whose state the caller
       * was not supposed to be able to observe, and answering `409` would
       * confirm that the row exists and what state it is in — the disclosure the
       * self-scoped 404 exists to prevent. An earlier version of this comment
       * said "a conflict and never a 500", which described neither branch. */
      request.log.warn(
        { correlationId: request.correlationId, sqlstate: error.code },
        'request statement refused by the database',
      );
      return error.code === '23505' || error.code === '23P01' || error.code === '2BP01'
        ? { kind: 'conflict' }
        : { kind: 'not-found' };
    }
  });
}

/**
 * The SCHEDULER's wrapper — one unit of work, one verdict, **no ownership
 * target**.
 *
 * The one difference from `withRequests` is `target: null`, and it is the
 * declaration above expressed at the call site: these routes act on other
 * people's rows on purpose, L5.1 is off, and what scopes the rows is migration
 * 0023's narrowing rather than an object policy. Passing the acting membership as
 * a target here would make `ownershipRequired: false` look like an oversight in a
 * declaration that intended it.
 *
 * The error handling is `withRequests`'s, verbatim in behaviour and for the same
 * reasons — a `restrict_violation` reaching the catch is a 404 rather than a 409,
 * because a 409 would confirm the row exists and what state it is in.
 */
async function withScheduler<T>(
  request: FastifyRequest,
  run: (uow: Uow) => Promise<Outcome<T>>,
): Promise<Outcome<T>> {
  const { context, command, route } = requireTenantContext(request);

  return request.server.tenancy.runtime.run(command, async (uow): Promise<Outcome<T>> => {
    try {
      const { decision } = await evaluateInTransaction(uow.query, {
        request,
        context,
        route,
        target: null,
      });
      if (!decision.allowed) return { kind: 'denied', decision };

      return await run(uow);
    } catch (error) {
      if (!isPostgresError(error)) throw error;
      request.log.warn(
        { correlationId: request.correlationId, sqlstate: error.code },
        'request decision refused by the database',
      );
      return error.code === '23505' || error.code === '23P01' || error.code === '2BP01'
        ? { kind: 'conflict' }
        : { kind: 'not-found' };
    }
  });
}

/**
 * A decision service failure, as the route's shape. One mapping for all four
 * verbs.
 *
 * Generic in `T` although it never produces an `ok`: the callers are handlers
 * whose success type is `DecisionResult`, and a non-generic `Outcome<never>`
 * would narrow their inferred return type to one that cannot carry a result.
 */
function fromDecision<T>(failure: DecisionItemFailure): Outcome<T> {
  switch (failure) {
    case 'not-found':
      return { kind: 'not-found' };
    case 'version-conflict':
      return { kind: 'conflict' };
    case 'illegal-operation':
      return { kind: 'decision-refused', code: 'REQUEST_OPERATION_ILLEGAL' };
    case 'reason-required':
      return { kind: 'decision-refused', code: 'DECISION_REASON_REQUIRED' };
    case 'subtype-not-decidable-here':
      return { kind: 'decision-refused', code: 'SUBTYPE_NOT_DECIDABLE' };
  }
}

/**
 * A comment service failure, as the route's shape. One mapping for both verbs.
 *
 * Generic in `T` for the reason `fromDecision` is: the callers' success type is
 * a `RequestComment`, and a non-generic `Outcome<never>` would narrow their
 * inferred return type to one that cannot carry a result.
 */
function fromComment<T>(failure: CommentFailure): Outcome<T> {
  switch (failure) {
    case 'not-found':
      return { kind: 'not-found' };
    case 'content-refused':
      return { kind: 'comment-refused' };
  }
}

function respond<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  outcome: Outcome<T>,
  body: (value: T) => unknown,
): FastifyReply | unknown {
  switch (outcome.kind) {
    case 'denied':
      return respondToDenial(request, reply, outcome.decision);
    case 'not-found':
      return sendNotFound(request, reply);
    case 'conflict':
      return reply.code(409).send(
        conflictBodySchema.parse({
          error: {
            code: 'CONFLICT',
            message:
              'This request moved while you were looking at it. Nothing was changed — reload and try again.',
            correlationId: request.correlationId,
          },
        }),
      );
    case 'invalid':
      return reply.code(422).send(
        validationProblemBodySchema.parse({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'The request body is not valid.',
            correlationId: request.correlationId,
            problems: outcome.problems,
          },
        }),
      );
    case 'deadline':
      /* §3: "Rejected with the effective deadline STATED". The date is in the
       * body because the specification puts it there — a refusal that will not
       * say what the deadline was is one the requester cannot act on. */
      return reply.code(409).send(
        requestDeadlineRefusalBodySchema.parse({
          error: {
            code:
              outcome.failure.detail === 'window-closed'
                ? 'REQUEST_WINDOW_CLOSED'
                : 'REQUEST_SUBMISSION_LATE',
            message:
              outcome.failure.detail === 'window-closed'
                ? 'This group is not accepting requests.'
                : 'This request is later than the group’s deadline.',
            correlationId: request.correlationId,
            effectiveDeadline: outcome.failure.effective,
          },
        }),
      );
    case 'illegal-operation':
      return reply.code(409).send(
        requestIllegalOperationBodySchema.parse({
          error: {
            code: 'REQUEST_OPERATION_ILLEGAL',
            message: 'This request can no longer be changed in that way.',
            correlationId: request.correlationId,
            status: outcome.failure.status,
          },
        }),
      );
    case 'decision-refused':
      /* 409 for the two that mean "the world is not as you believed", 422 for the
       * one that means "your body was incomplete". The distinction is the same one
       * `validationProblemBodySchema` draws, and it matters to a client deciding
       * whether to reload or to re-prompt. The current status is deliberately NOT
       * carried here as it is on the row above: these refusals answer a SCHEDULER,
       * who can already read the row through the queue, so nothing is disclosed —
       * but the reason a scheduler is refused is about their COMMAND, and echoing
       * a status would invite a client to branch on the wrong fact. */
      return reply.code(outcome.code === 'DECISION_REASON_REQUIRED' ? 422 : 409).send(
        decisionRefusalBodySchema.parse({
          error: {
            code: outcome.code,
            message:
              outcome.code === 'DECISION_REASON_REQUIRED'
                ? 'A decision reason is required, and an approval carries none.'
                : outcome.code === 'SUBTYPE_NOT_DECIDABLE'
                  ? 'This kind of request is not decided here.'
                  : 'This request can no longer be decided in that way.',
            correlationId: request.correlationId,
          },
        }),
      );
    case 'key-reused':
      /* `409`, and not `422`: the body was well-formed and the route was reached —
       * what is wrong is the state of the caller's own key namespace, which is a
       * fact about the world rather than about this document. The remedy is
       * neither reload nor re-prompt but a DIFFERENT key, which is why the code is
       * its own and the subtype it already names is stated. */
      return reply.code(409).send(
        idempotencyKeyReusedBodySchema.parse({
          error: {
            code: 'IDEMPOTENCY_KEY_REUSED',
            message:
              'This idempotency key already names one of your requests of another kind. ' +
              'Use a different key.',
            correlationId: request.correlationId,
            existingSubtype: outcome.existingSubtype,
          },
        }),
      );
    case 'comment-refused':
      /* `422`, because it is a statement about the BODY — the same distinction
       * `DECISION_REASON_REQUIRED` draws, and it tells a client to re-prompt
       * rather than to reload. The message names neither the rejected text nor
       * the rejected code: non-bypass rule 9 applies to an error body exactly as
       * it applies to a log line, and echoing what was refused would put it in
       * whatever the client writes its errors to. */
      return reply.code(422).send(
        commentRefusalBodySchema.parse({
          error: {
            code: 'COMMENT_CONTENT_REFUSED',
            message: 'That comment is not a shape this request accepts.',
            correlationId: request.correlationId,
          },
        }),
      );
    case 'vacation-refused':
      return reply.code(409).send(
        vacationSelectionRefusalBodySchema.parse({
          error: {
            code: outcome.code,
            message:
              outcome.code === 'VACATION_ROUND_NOT_OPEN'
                ? 'This vacation round is not accepting selections.'
                : outcome.code === 'VACATION_WEEK_ALREADY_SELECTED'
                  ? 'You already hold a selection for that week.'
                  : 'This selection is no longer awaiting a decision.',
            correlationId: request.correlationId,
          },
        }),
      );
    case 'ok':
      return body(outcome.value);
  }
}

/**
 * The domain aggregate on the wire.
 *
 * ## `requestId` is DROPPED from the record — a DEFECT found and cured here
 *
 * Every subtype record in `packages/domain` carries `requestId`, and every
 * subtype schema in `packages/contracts` is `.strict()` **without** it — so
 * passing the domain record through unchanged makes `requestSchema.parse` throw
 * `unrecognized_keys`, and the route answers `500` on every SUCCESSFUL response.
 *
 * That was true of `POST …/requests` and `GET …/requests/mine` as shipped by
 * OPUS-M5-001, and it survived because **no test drove a request route over
 * HTTP** — `route-policy.test.ts` builds the server with no database and
 * `lifecycle-service.test.ts` calls the service below the routes. OPUS-M5-002's
 * queue read hit it on its first ALLOW control.
 *
 * **The fix is to project rather than to widen the schemas**, because the wire
 * shape is right and the pass-through was wrong: `root.id` IS the request id, so
 * `record.requestId` would be a second copy of it on the same object — and a
 * second copy is a thing that can disagree. `apps/api/test/requests/
 * decision-authority.test.ts` now drives the queue and the detail read over HTTP,
 * so the regression has a test rather than only a fix.
 */
function requestView(request: DomainRequest): RequestWire {
  const { root, record } = request;
  /* ── OPUS-M5-003: the vacation record is PROJECTED, not stripped ────────────
   *
   * The other five records differ from their wire shapes by exactly one field —
   * `requestId`, dropped above for the reason this docblock gives. The selection
   * record differs by eleven: it carries its own id, status, version, grant,
   * override and both idempotency keys, and `vacationSelectionRecordSchema` is
   * `.strict()` over three fields. A rest-spread would therefore answer `500` on
   * every successful vacation response — the identical defect this docblock
   * records for M5-001, arriving by a different route.
   *
   * The dropped fields are not lost: `GET …/vacation/rounds/:periodId` carries
   * the selection in full, with the root status R-15 derives from. What a
   * SUBMISSION answers is the aggregate, and the aggregate's record is §1.2's
   * three fields. */
  if (record.subtype === 'vacation-selection') {
    return {
      root: rootView(root),
      record: {
        subtype: 'vacation-selection',
        vacationPeriodId: record.vacationPeriodId,
        weekStart: record.weekStart,
      },
    } as RequestWire;
  }
  const { requestId: _requestId, ...wireRecord } = record;
  return { root: rootView(root), record: wireRecord } as RequestWire;
}

/** The aggregate root on the wire. One projection, used by both record branches. */
function rootView(root: DomainRequest['root']): RequestWire['root'] {
  return {
    id: root.id,
    membershipId: root.membershipId,
    subtype: root.subtype,
    status: root.status,
    submittedAt: root.submittedAt?.toISOString() ?? null,
    decidedAt: root.decidedAt?.toISOString() ?? null,
    decidedBy: root.decidedBy,
    withdrawnAt: root.withdrawnAt?.toISOString() ?? null,
    expiresAt: root.expiresAt.toISOString(),
    idempotencyKey: root.idempotencyKey,
    version: root.version,
    isLate: root.isLate,
    revisionRequested: root.revisionRequested,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Registration
 * ──────────────────────────────────────────────────────────────────────────── */

export default function requestRoutes(app: FastifyInstance): void {
  const base = '/organizations/:organizationId/groups/:groupId/requests';

  /* ── submit ─────────────────────────────────────────────────── CAP-021 ── */

  app.post(base, { config: SUBMIT_REQUEST_CONFIG }, async (request, reply) => {
    const outcome = await withRequests(request, async (uow) => {
      const parsed = parseBody(submitRequestSchema, request.body);
      if (parsed.kind !== 'ok') return parsed;

      const membershipId = uow.context.membershipId;
      if (membershipId === null) return { kind: 'not-found' as const };

      /* ── A vacation selection IS submitted here ────────────────────────────
       *
       * **The `422` refusal that stood here is RETIRED** (doc 42 §5f Part A). It
       * read "A vacation selection is not submitted through this route", and it
       * was true of M5-001 and M5-002, whose reason it stated correctly: §5.3
       * gives that lifecycle ONE writer, and a second writer on this route would
       * make "the vacation module never writes one without the other" untrue.
       *
       * **That reason is satisfied rather than abandoned.** This branch does not
       * write anything — it DISPATCHES to `submitVacationSelection`, which is the
       * vacation module and which moves the selection and the derived root in one
       * transaction. What changes is the door, not the writer: a staff member
       * asking for a week off and a staff member asking for a vacation week are
       * doing the same thing from the same form, and I-10's "one user action, one
       * request" is better served by one submission endpoint than by two that
       * differ only in which table the server ends up in.
       *
       * The type system still draws the boundary underneath: `NewRequest.record`
       * — what `PgRequestStore.create` accepts — has no vacation member, so the
       * request store remains structurally unable to write one. */
      const record = parsed.value.record;
      if (record.subtype === 'vacation-selection') {
        const selected = await submitVacationSelection(uow, {
          membershipId,
          vacationPeriodId: record.vacationPeriodId,
          weekStart: record.weekStart,
          idempotencyKey: parsed.value.idempotencyKey,
          now: new Date(),
        });
        if (!selected.ok) return fromVacationSelection<SubmitResult>(selected.failure);

        /* The aggregate is composed from BOTH stores — `loadVacationRequest` —
         * because `PgRequestStore.load` answers `null` for a vacation root by
         * design. The reply shape is the same `requestSchema` the other five
         * return, so a client that submits six kinds parses one answer. */
        const created = await loadVacationRequest(uow, selected.value.requestId);
        if (created === null) return { kind: 'not-found' as const };
        return {
          kind: 'ok' as const,
          value: {
            request: created,
            replayed: selected.value.replayed,
            isLate: selected.value.isLate,
          },
        };
      }

      const result = await submitRequest(uow, {
        membershipId,
        subtype: record.subtype,
        record,
        idempotencyKey: parsed.value.idempotencyKey,
        periodStart: parsed.value.periodStart ?? null,
        now: new Date(),
      });
      return fromService(result);
    });

    /* R-11: a replay returns the EXISTING row with 200, a first submission
     * returns 201. Both carry the same body, so a client that retried an
     * ambiguous response gets the request it asked for either way — which is
     * what makes the retry safe rather than merely tolerated. */
    if (outcome.kind === 'ok' && !outcome.value.replayed) reply.code(201);
    return respond(request, reply, outcome, (value) =>
      requestSchema.parse(requestView(value.request)),
    );
  });

  /* ── withdraw ───────────────────────────────────────────────── CAP-021 ── */

  app.post(`${base}/:requestId/withdraw`, { config: WITHDRAW_REQUEST_CONFIG }, async (request, reply) => {
    const outcome = await withRequests(request, async (uow) => {
      const { requestId } = request.params as { requestId: string };
      if (!isUuid(requestId)) return { kind: 'not-found' as const };

      const parsed = parseBody(withdrawRequestSchema, request.body);
      if (parsed.kind !== 'ok') return parsed;

      const membershipId = uow.context.membershipId;
      if (membershipId === null) return { kind: 'not-found' as const };

      const result = await withdrawRequest(uow, {
        requestId,
        expectedVersion: parsed.value.expectedVersion,
        /* The VERIFIED context's own membership (SPEC-01 §2.3 derives it
         * server-side), never a path parameter and never a body field. §4's
         * requester-initiated-only rule is decided on this value — see
         * `withdrawRequest`'s docblock for why the route declaration and RLS
         * between them do not decide it. */
        membershipId,
        now: new Date(),
      });
      return fromService(result);
    });

    return respond(request, reply, outcome, (value) =>
      withdrawRequestResultSchema.parse({
        requestId: value.requestId,
        version: value.version,
        revisionRequested: value.revisionRequested,
      }),
    );
  });

  /* ── one's own requests ─────────────────────────────────────── CAP-021 ── */

  app.get(`${base}/mine`, { config: OWN_REQUESTS_CONFIG }, async (request, reply) => {
    const outcome = await withRequests(request, async (uow) => {
      const membershipId = uow.context.membershipId;
      if (membershipId === null) return { kind: 'not-found' as const };
      const rows = await requestStore.listForMembership(uow, membershipId);
      return { kind: 'ok' as const, value: rows };
    });

    return respond(request, reply, outcome, (rows) =>
      requestListSchema.parse({ requests: rows.map(requestView) }),
    );
  });

  /* ── the group's effective deadline ─────────────────────────── CAP-021 ── */

  app.get(`${base}/deadline`, { config: OWN_REQUESTS_CONFIG }, async (request, reply) => {
    const outcome = await withRequests(request, async (uow) => {
      const context = await loadGroupDeadlineContext(uow);
      if (context === null) return { kind: 'not-found' as const };

      /* `periodStart` comes from the query only because the
       * `days_before_period_start` mode needs one to have an answer at all. It
       * is not a deadline and cannot be used as one: every other mode ignores
       * it, and in this mode it selects WHICH period's deadline to report, not
       * what that deadline is. */
      const raw = (request.query as { periodStart?: unknown } | undefined)?.periodStart;
      const periodStart = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;

      return { kind: 'ok' as const, value: deadlineFor(context, periodStart) };
    });

    return respond(request, reply, outcome, (deadline) => requestDeadlineSchema.parse(deadline));
  });

  /* ════════════════════════════════════════════════════════════════════════════
   * OPUS-M5-002 — the scheduler's queue and §4's decisions
   *
   * Registered AFTER the three static staff paths above, and Fastify's radix
   * router prefers a static segment over a parametric one regardless of order —
   * so `GET …/mine`, `…/deadline` and `…/queue` are never captured by
   * `GET …/:requestId`. Order-independence is a property of find-my-way rather
   * than of this file, and `test/requests/route-policy.test.ts` asserts the
   * registered table rather than trusting it.
   * ════════════════════════════════════════════════════════════════════════════ */

  /* ── the pending-review queue ────────────────────────── requests.read_any ── */

  app.get(`${base}/queue`, { config: SCHEDULER_READ_CONFIG }, async (request, reply) => {
    const outcome = await withScheduler(request, async (uow) => {
      const query = (request.query ?? {}) as { subtype?: unknown; status?: unknown };

      /* Filters are PARSED, never trusted: an unrecognised subtype or status is
       * dropped rather than passed to the store, so a caller cannot widen the
       * query by naming something the vocabulary does not contain. Both are closed
       * sets, which is why this is a filter and not a search. */
      const subtypes = parseCsvEnum(query.subtype, REQUEST_SUBTYPES);
      const statuses = parseCsvEnum(query.status, REQUEST_STATUSES);

      const rows = await requestStore.listPendingReview(uow, {
        ...(subtypes.length > 0 ? { subtypes } : {}),
        ...(statuses.length > 0 ? { statuses } : {}),
        limit: QUEUE_PAGE_LIMIT,
      });
      return { kind: 'ok' as const, value: rows };
    });

    return respond(request, reply, outcome, (rows) =>
      requestQueueSchema.parse({ requests: rows.map(requestView) }),
    );
  });

  /* ── one request in full, with its decision history ─── requests.read_any ── */

  app.get(`${base}/:requestId`, { config: SCHEDULER_READ_CONFIG }, async (request, reply) => {
    const outcome = await withScheduler(request, async (uow) => {
      const { requestId } = request.params as { requestId: string };
      if (!isUuid(requestId)) return { kind: 'not-found' as const };

      const found = await requestStore.load(uow, requestId);
      if (found === null) return { kind: 'not-found' as const };
      const approvals = await requestStore.listApprovals(uow, requestId);
      /* OPUS-M5-00C: §4's thread, beside §4's decision history. This is where a
       * DECIDER reads comments — the reader table's second forced cell, served
       * by the key that already decides this read rather than by a fourth
       * route. `listComments` applies no visibility predicate of its own;
       * migration 0026's arms scope the rows. */
      const comments = await listComments(uow, requestId);
      return { kind: 'ok' as const, value: { request: found, approvals, comments } };
    });

    return respond(request, reply, outcome, (value) =>
      requestDetailSchema.parse({
        request: requestView(value.request),
        approvals: value.approvals.map(approvalView),
        comments: value.comments.map(commentView),
      }),
    );
  });

  /* ── approve ──────────────────────────────────────────── requests.approve ── */

  app.post(
    `${base}/:requestId/approve`,
    { config: APPROVE_REQUEST_CONFIG },
    async (request, reply) => {
      const outcome = await withScheduler(request, async (uow) => {
        const { requestId } = request.params as { requestId: string };
        if (!isUuid(requestId)) return { kind: 'not-found' as const };

        const parsed = parseBody(approveRequestSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;

        const membershipId = uow.context.membershipId;
        if (membershipId === null) return { kind: 'not-found' as const };

        const result = await decideRequest(uow, {
          requestId,
          expectedVersion: parsed.value.expectedVersion,
          decision: 'approved',
          /* §4 asks for no reason on an approval and migration 0024 refuses one.
           * `null` is not a default that could be overridden — the body schema has
           * no reason field at all. */
          reason: null,
          decidedBy: membershipId,
          now: new Date(),
        });
        return result.ok
          ? { kind: 'ok' as const, value: result.value }
          : fromDecision(result.failure);
      });

      return respond(request, reply, outcome, (value) => decisionResultSchema.parse(value));
    },
  );

  /* ── deny ────────────────────────────────────────────────── requests.deny ── */

  app.post(`${base}/:requestId/deny`, { config: DENY_REQUEST_CONFIG }, async (request, reply) => {
    const outcome = await withScheduler(request, async (uow) => {
      const { requestId } = request.params as { requestId: string };
      if (!isUuid(requestId)) return { kind: 'not-found' as const };

      const parsed = parseBody(denyRequestSchema, request.body);
      if (parsed.kind !== 'ok') return parsed;

      const membershipId = uow.context.membershipId;
      if (membershipId === null) return { kind: 'not-found' as const };

      const result = await decideRequest(uow, {
        requestId,
        expectedVersion: parsed.value.expectedVersion,
        decision: 'denied',
        reason: parsed.value.reason,
        decidedBy: membershipId,
        now: new Date(),
      });
      return result.ok ? { kind: 'ok' as const, value: result.value } : fromDecision(result.failure);
    });

    return respond(request, reply, outcome, (value) => decisionResultSchema.parse(value));
  });

  /* ── reverse an approval ──────────────────────────────── requests.approve ── */

  app.post(
    `${base}/:requestId/reverse`,
    { config: APPROVE_REQUEST_CONFIG },
    async (request, reply) => {
      const outcome = await withScheduler(request, async (uow) => {
        const { requestId } = request.params as { requestId: string };
        if (!isUuid(requestId)) return { kind: 'not-found' as const };

        const parsed = parseBody(reverseDecisionSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;

        const membershipId = uow.context.membershipId;
        if (membershipId === null) return { kind: 'not-found' as const };

        const result = await reverseDecision(uow, {
          requestId,
          expectedVersion: parsed.value.expectedVersion,
          reason: parsed.value.reason,
          reversedBy: membershipId,
          now: new Date(),
        });
        return result.ok
          ? { kind: 'ok' as const, value: result.value }
          : fromDecision(result.failure);
      });

      return respond(request, reply, outcome, (value) => decisionResultSchema.parse(value));
    },
  );

  /* ── the batch ────────────────────────────────── requests.batch_approve ── */

  app.post(`${base}/decisions`, { config: BATCH_DECISION_CONFIG }, async (request, reply) => {
    const outcome = await withScheduler(request, async (uow) => {
      const parsed = parseBody(batchDecisionSchema, request.body);
      if (parsed.kind !== 'ok') return parsed;

      const membershipId = uow.context.membershipId;
      if (membershipId === null) return { kind: 'not-found' as const };

      /* ── The batch key is not the decision key ─────────────────────────────
       *
       * This route declares `requests.batch_approve` — doc 08 §6's "batch requires
       * a grant" — and the per-item decision key is evaluated HERE, in the same
       * transaction and against the same snapshot as the writes (I-19, FAD-12).
       * Without this second evaluation a holder of the batch grant alone could
       * decide, which would make `requests.approve` a key that can be walked
       * around by choosing a different URL. One evaluator on every path (SPEC-06
       * §7): this is `evaluateAction`, the same function the HTTP wrapper above and
       * the job worker call. */
      const decisionKey =
        parsed.value.decision === 'approved' ? 'requests.approve' : 'requests.deny';
      const { decision } = await evaluateAction(uow.query, {
        context: evaluationContextOf(requireTenantContext(request).context),
        action: {
          key: decisionKey,
          moduleKey: 'requests_vacation',
          scope: 'group',
          requiresObjectPolicy: false,
        },
        target: null,
      });
      if (!decision.allowed) return { kind: 'denied' as const, decision };

      const outcomes = await decideRequestsBatch(uow, {
        items: parsed.value.items,
        decision: parsed.value.decision,
        reason: parsed.value.reason,
        decidedBy: membershipId,
        now: new Date(),
      });
      return { kind: 'ok' as const, value: outcomes };
    });

    return respond(request, reply, outcome, (outcomes) =>
      batchDecisionResultSchema.parse({ outcomes }),
    );
  });

  /* ════════════════════════════════════════════════════════════════════════════
   * OPUS-M5-00C — §4's fifth row: COMMENTS, under FAD-58
   *
   * Registered after the parametric decision routes above; Fastify's radix
   * router prefers a static segment over a parametric one regardless of order,
   * and `test/requests/route-policy.test.ts` asserts the registered table rather
   * than trusting it.
   * ════════════════════════════════════════════════════════════════════════════ */

  /* ── the REQUESTER attaches ONE code ──────────────── requests.own.comment ── */

  app.post(
    `${base}/:requestId/reason-codes`,
    { config: ATTACH_REASON_CODE_CONFIG },
    async (request, reply) => {
      const outcome = await withRequests(request, async (uow) => {
        const { requestId } = request.params as { requestId: string };
        if (!isUuid(requestId)) return { kind: 'not-found' as const };

        /* `.strict()` with no text member, so a body carrying `text`, `note` or
         * `otherText` is refused HERE with `unrecognized_keys` — structurally,
         * before any handler sees it. FAD-58.1's "no 'other, specify' field"
         * is this line plus the schema it names, and
         * `test/requests/request-comments.test.ts` POSTs one and reads the
         * refusal. */
        const parsed = parseBody(attachReasonCodeSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;

        const membershipId = uow.context.membershipId;
        if (membershipId === null) return { kind: 'not-found' as const };

        const result = await attachReasonCode(uow, {
          requestId,
          /* The VERIFIED context's own membership, never a path parameter and
           * never a body field — the by-id-write ownership class (M5-003), whose
           * predicate lives in the service because L5.1 passes by construction
           * on this surface and RLS decides rows rather than operations. */
          membershipId,
          reasonCode: parsed.value.reasonCode,
        });
        return result.ok
          ? { kind: 'ok' as const, value: result.value }
          : fromComment<RequestComment>(result.failure);
      });

      if (outcome.kind === 'ok') reply.code(201);
      return respond(request, reply, outcome, (comment) =>
        requestCommentResultSchema.parse({ comment: commentView(comment) }),
      );
    },
  );

  /* ── a DECIDER appends a comment ─────────────────── requests.comment_any ── */

  app.post(
    `${base}/:requestId/comments`,
    { config: APPEND_COMMENT_CONFIG },
    async (request, reply) => {
      const outcome = await withScheduler(request, async (uow) => {
        const { requestId } = request.params as { requestId: string };
        if (!isUuid(requestId)) return { kind: 'not-found' as const };

        const parsed = parseBody(appendSchedulerCommentSchema, request.body);
        if (parsed.kind !== 'ok') return parsed;

        const membershipId = uow.context.membershipId;
        if (membershipId === null) return { kind: 'not-found' as const };

        const result = await appendSchedulerComment(uow, {
          requestId,
          membershipId,
          body: parsed.value.body,
        });
        return result.ok
          ? { kind: 'ok' as const, value: result.value }
          : fromComment<RequestComment>(result.failure);
      });

      if (outcome.kind === 'ok') reply.code(201);
      return respond(request, reply, outcome, (comment) =>
        requestCommentResultSchema.parse({ comment: commentView(comment) }),
      );
    },
  );

  /* ── the REQUESTER reads their OWN thread ───────────── requests.own.read ── */

  app.get(
    `${base}/:requestId/comments`,
    { config: OWN_REQUESTS_CONFIG },
    async (request, reply) => {
      const outcome = await withRequests(request, async (uow) => {
        const { requestId } = request.params as { requestId: string };
        if (!isUuid(requestId)) return { kind: 'not-found' as const };

        const membershipId = uow.context.membershipId;
        if (membershipId === null) return { kind: 'not-found' as const };

        /* Self-scoped on the VERIFIED context's membership, exactly as
         * `GET …/requests/mine` is and for the reason that route's docblock
         * gives: the authorization decides the request, this predicate decides
         * the rows, and migration 0026's `request_comments_own` arm decides them
         * a third time. `null` — not an empty list — so a colleague's request,
         * another group's, and an id that names nothing all answer `404`. */
        const thread = await listOwnComments(uow, requestId, membershipId);
        if (thread === null) return { kind: 'not-found' as const };
        return { kind: 'ok' as const, value: thread };
      });

      return respond(request, reply, outcome, (comments) =>
        requestCommentThreadSchema.parse({ comments: comments.map(commentView) }),
      );
    },
  );
}

/**
 * How many rows one queue page carries.
 *
 * A bound rather than a client parameter, for the reason `claimExpirable`'s limit
 * is a bound: a queue that returned everything would hold a read proportional to
 * how long nobody worked it, and the longer the backlog the heavier the recovery.
 * Ordered by deadline, so the page a scheduler gets is the most urgent one.
 */
const QUEUE_PAGE_LIMIT = 200;

/**
 * One comment on the wire (OPUS-M5-00C).
 *
 * Both content columns travel, each `null` on the channel that does not carry
 * it — the row's own shape, and the exclusivity is enforced by migration 0026's
 * two CHECKs and the domain's `commentContentIsWellFormed` rather than by a
 * projection here that could disagree with either.
 */
function commentView(comment: RequestComment): unknown {
  return {
    id: comment.id,
    requestId: comment.requestId,
    channel: comment.channel,
    reasonCode: comment.reasonCode,
    body: comment.body,
    authorMembershipId: comment.authorMembershipId,
    createdAt: comment.createdAt.toISOString(),
  };
}

/** One decision on the wire. */
function approvalView(approval: Approval): unknown {
  return {
    id: approval.id,
    requestId: approval.requestId,
    decision: approval.decision,
    decidedBy: approval.decidedBy,
    decidedAt: approval.decidedAt.toISOString(),
    reason: approval.reason,
    isOverride: approval.isOverride,
    vacationSelectionId: approval.vacationSelectionId,
    supersedesApprovalId: approval.supersedesApprovalId,
  };
}

/**
 * A comma-separated query filter, narrowed to a closed vocabulary.
 *
 * Unrecognised members are DROPPED rather than refused, and the choice is
 * deliberate: a filter is a narrowing convenience, and a `422` for an unknown
 * subtype would make the queue's error surface depend on a client's stale
 * vocabulary. What must not happen is a value reaching the store that the
 * vocabulary does not contain, and dropping is the stronger guarantee of the two
 * — the store's `IN` list is built only from members of the closed set.
 */
function parseCsvEnum<T extends string>(raw: unknown, allowed: readonly T[]): T[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  const wanted = new Set(raw.split(',').map((part) => part.trim()));
  return allowed.filter((value) => wanted.has(value));
}
