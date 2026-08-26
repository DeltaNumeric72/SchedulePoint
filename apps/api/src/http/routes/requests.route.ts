import {
  approveRequestSchema,
  batchDecisionResultSchema,
  batchDecisionSchema,
  conflictBodySchema,
  decisionRefusalBodySchema,
  decisionResultSchema,
  denyRequestSchema,
  isUuid,
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
  withdrawRequestResultSchema,
  withdrawRequestSchema,
  type RequestWire,
} from '@schedulepoint/contracts';
import {
  REQUEST_STATUSES,
  REQUEST_SUBTYPES,
  type Approval,
  type Decision,
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
  decideRequest,
  decideRequestsBatch,
  reverseDecision,
} from '../../requests/decisions.js';
import {
  submitRequest,
  withdrawRequest,
  type RequestFailure,
  type RequestOutcome,
} from '../../requests/service.js';
import { requestStore } from '../../requests/store.js';
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
    };

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
  const { requestId: _requestId, ...wireRecord } = record;
  return {
    root: {
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
    },
    record: wireRecord,
  } as RequestWire;
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

      /* ── A vacation selection is not submitted here ────────────────────────
       *
       * Doc 42 §5c: "nothing here writes `vacation_selections`". §5.3 gives that
       * lifecycle ONE writer and it is the vacation module's (M5-002/003), and a
       * second writer on this route is exactly what would make "the vacation
       * module never writes one without the other" untrue.
       *
       * `422` and not `404`: the route exists, the caller was authorized to
       * reach it, and the body is well-formed against `requestRecordSchema` —
       * what is wrong is that this subtype is not submitted through this
       * surface. A `404` would say the route is absent, which is false, and
       * would send a client looking for a URL rather than for the right one.
       *
       * The narrowing is also what satisfies the type system: the store's
       * creation union has no vacation member at all, so this check is the
       * runtime half of a boundary the compiler already draws. */
      const record = parsed.value.record;
      if (record.subtype === 'vacation-selection') {
        return {
          kind: 'invalid' as const,
          problems: [
            {
              field: 'record.subtype',
              message:
                'A vacation selection is not submitted through this route. Vacation has its own ' +
                'quota and commitment lifecycle (SPEC-08 §5).',
            },
          ],
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

      const result = await withdrawRequest(uow, {
        requestId,
        expectedVersion: parsed.value.expectedVersion,
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
      return { kind: 'ok' as const, value: { request: found, approvals } };
    });

    return respond(request, reply, outcome, (value) =>
      requestDetailSchema.parse({
        request: requestView(value.request),
        approvals: value.approvals.map(approvalView),
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
