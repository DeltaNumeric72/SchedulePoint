import {
  conflictBodySchema,
  isUuid,
  requestDeadlineRefusalBodySchema,
  requestDeadlineSchema,
  requestIllegalOperationBodySchema,
  requestListSchema,
  requestSchema,
  submitRequestSchema,
  validationProblemBodySchema,
  withdrawRequestResultSchema,
  withdrawRequestSchema,
  type RequestWire,
} from '@schedulepoint/contracts';
import type { Decision, FieldProblem, Request as DomainRequest } from '@schedulepoint/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { evaluateInTransaction, respondToDenial } from '../../authz/authorize-request.js';
import { isPostgresError } from '../../db/pg-errors.js';
import { deadlineFor, loadGroupDeadlineContext } from '../../requests/deadlines.js';
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
    case 'ok':
      return body(outcome.value);
  }
}

/** The domain aggregate on the wire. */
function requestView(request: DomainRequest): RequestWire {
  const { root, record } = request;
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
    record,
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
}
