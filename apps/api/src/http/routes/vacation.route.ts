import {
  approveVacationSelectionSchema,
  commitVacationRoundResultSchema,
  commitVacationRoundSchema,
  denyVacationSelectionSchema,
  idempotencyKeyReusedBodySchema,
  isUuid,
  requestDeadlineRefusalBodySchema,
  reverseVacationCommitResultSchema,
  reverseVacationCommitSchema,
  vacationCommitRefusalBodySchema,
  vacationDecisionRefusalBodySchema,
  vacationDecisionResultSchema,
  vacationRoundListSchema,
  vacationRoundSchema,
  vacationSelectionRefusalBodySchema,
  vacationSelectionResultSchema,
  validationProblemBodySchema,
  withdrawVacationSelectionSchema,
} from '@schedulepoint/contracts';
import {
  derivedRequestStatus,
  type Decision,
  type RequestStatus,
  type VacationApprovalFailure,
  type VacationCommitFailure,
  type VacationReversalFailure,
  type VacationSelectionStatus,
} from '@schedulepoint/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  evaluateInTransaction,
  evaluationContextOf,
  respondToDenial,
} from '../../authz/authorize-request.js';
import { isPostgresError } from '../../db/pg-errors.js';
import {
  VacationApprovalRolledBack,
  approveVacationSelection,
  denyVacationSelection,
  type VacationDecisionResult,
} from '../../requests/vacation-approval.js';
import {
  VacationCommitRolledBack,
  VacationReversalRolledBack,
  commitVacationRound,
  reverseVacationCommit,
  type CommitVacationRoundResult,
  type ReverseVacationCommitResult,
} from '../../requests/vacation-commit.js';
import {
  VacationSelectionRolledBack,
  readVacationRound,
  withdrawVacationSelection,
  type VacationRound,
  type VacationSelectionServiceFailure,
  type VacationSelectionWriteResult,
} from '../../requests/vacation-selection.js';
import { vacationStore } from '../../requests/vacation-store.js';
import { requireTenantContext } from '../context/middleware.js';
import { sendNotFound } from '../context/responses.js';
import { MEMBERSHIP_AGGREGATE } from '../context/target-resolution.js';
import type { RouteConfigWithPolicy } from '../policy.js';

/**
 * The vacation DECISION surface — SPEC-08 §5.4/§5.5, CAP-021 (OPUS-M5-002,
 * doc 42 §5d Part B).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ## Two routes, and why this file exists rather than two more on `/requests`
 *
 * | Route | Is | Key |
 * |---|---|---|
 * | `POST …/vacation/selections/:selectionId/approve` | §5.4's `APPROVE-VACATION` | `requests.approve` |
 * | `POST …/vacation/selections/:selectionId/deny` | the same transaction, denying | `requests.deny` |
 *
 * A vacation request IS a request — §5.1's linkage is real, and §5 says vacation
 * "shares the request infrastructure (audit, comments, approvals, idempotency)",
 * which is why both routes declare the SAME two decision keys the request surface
 * uses and why both write an `approvals` row into the same table.
 *
 * What is not shared is the COMMAND. A vacation decision takes D-26's idempotency
 * key, the SELECTION's version (V-29 — the version §5.4 originally checked was
 * the grant's), an optional grant and its version, and §5.5's override reason.
 * Folding that into `POST …/requests/:requestId/approve` would mean one body with
 * four fields that are meaningless for five of the six subtypes, and a handler
 * that branched on the discriminator to decide which half of its own contract
 * applied. The route addresses the SELECTION because that is what §5.3 makes
 * authoritative.
 *
 * **`requests.read_any` has no route here.** The vacation round's read surface —
 * the selection grid, the variance display, the grants — is M5-003's, which owns
 * grants and selection UX. What lands here is the decision, because doc 42 §5d
 * Part B lands the transaction and a transaction with no caller is dead code.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## `:selectionId` names a SELECTION, never a person
 *
 * The same structural property the request surface asserts about its own paths:
 * there is no `:membershipId`, no `:userId`, no subject parameter of any kind. A
 * selection belongs to a member, and migration 0023's `vacation_selections_own` /
 * `_group_read_any` / `_group_administration` arms decide which selections this
 * caller can see or write. A caller holding neither read nor administration key
 * gets zero rows and a `404`, identical to a selection that does not exist.
 *
 * ## The transaction rolls back, and the route reports what it rolled back FROM
 *
 * §5.4 requires the whole transaction to roll back when the guarded selection
 * update matches nothing, so the unit consumed at step 1 is released with it.
 * `VacationApprovalRolledBack` is how the service spells that — the unit-of-work
 * runner owns the transaction boundary (I-15, non-bypass rule 1) and a service
 * that ended one early would be the thing rule 1 forbids. This file catches the
 * typed error OUTSIDE `runtime.run`, after the rollback has happened, and answers
 * from its `failure`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** §5.4's approval — the same key the request surface's approval declares. */
export const APPROVE_VACATION_CONFIG = {
  policy: { kind: 'capability', capability: 'CAP-021' },
  actionScope: 'group',
  action: {
    key: 'requests.approve',
    moduleKey: 'requests_vacation',
    requiresObjectPolicy: false,
  },
} as const satisfies RouteConfigWithPolicy;

/** §5.4's denial. A denial consumes nothing, and carries a mandatory reason. */
export const DENY_VACATION_CONFIG = {
  policy: { kind: 'capability', capability: 'CAP-021' },
  actionScope: 'group',
  action: {
    key: 'requests.deny',
    moduleKey: 'requests_vacation',
    requiresObjectPolicy: false,
  },
} as const satisfies RouteConfigWithPolicy;

type Outcome =
  | { readonly kind: 'ok'; readonly value: VacationDecisionResult }
  | { readonly kind: 'denied'; readonly decision: Decision }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'refused'; readonly failure: VacationApprovalFailure };

/**
 * One unit of work, one verdict, and the rollback surfaced as an outcome.
 *
 * The `try` around `runtime.run` is OUTSIDE the transaction, which is the whole
 * point: by the time `VacationApprovalRolledBack` reaches here the runner has
 * already rolled the transaction back, so any unit consumed at §5.4 step 1 is
 * released and the D-26 command row is gone with it — which is what makes the
 * same key retryable after a failure.
 */
async function withVacationDecision(
  request: FastifyRequest,
  run: (uow: Parameters<Parameters<FastifyRequest['server']['tenancy']['runtime']['run']>[1]>[0]) => Promise<Outcome>,
): Promise<Outcome> {
  const { context, command, route } = requireTenantContext(request);

  try {
    return await request.server.tenancy.runtime.run(command, async (uow): Promise<Outcome> => {
      const { decision } = await evaluateInTransaction(uow.query, {
        request,
        context,
        route,
        target: null,
      });
      if (!decision.allowed) return { kind: 'denied', decision };
      return await run(uow);
    });
  } catch (error) {
    if (error instanceof VacationApprovalRolledBack) {
      request.log.info(
        { correlationId: request.correlationId, failure: error.failure },
        'vacation decision rolled back',
      );
      return { kind: 'refused', failure: error.failure };
    }
    /* A non-database fault is re-thrown to `setErrorHandler`, which logs it with
     * its stack and answers 500 with the fixed message. Catching everything would
     * turn a bug in this process into a 404 whose log line asserted "refused by
     * the database" about an unexamined cause. */
    if (!isPostgresError(error)) throw error;
    request.log.warn(
      { correlationId: request.correlationId, sqlstate: error.code },
      'vacation decision refused by the database',
    );
    return { kind: 'not-found' };
  }
}

/**
 * The refusal's status code.
 *
 * `409` for the three that mean "the world is not as you believed" — a conflict a
 * caller resolves by reloading or by accepting that there is nothing left to take
 * — and `403` for the two that are about this actor's AUTHORITY. `OVERRIDE_REQUIRED`
 * is a genuine authorization refusal (R-06: over-quota approval without the
 * capability is DENIED) and answering `409` would suggest a retry could work.
 *
 * The bodies are fixed strings and carry no row content: a scheduler already sees
 * the selection through the round's own surface, and a refusal that echoed a
 * member's quota would be putting one member's allowance into another's error.
 */
function refusalStatus(failure: VacationApprovalFailure): number {
  return failure === 'OVERRIDE_REQUIRED' ? 403 : failure === 'OVERRIDE_REASON_REQUIRED' ? 422 : 409;
}

const REFUSAL_MESSAGE: Readonly<Record<VacationApprovalFailure, string>> = {
  QUOTA_EXHAUSTED: 'There is no vacation allowance left for this selection.',
  VERSION_CONFLICT: 'This selection moved while you were looking at it. Nothing was changed.',
  SELECTION_NOT_PENDING: 'This selection is no longer awaiting a decision.',
  OVERRIDE_REQUIRED: 'Approving beyond the allowance requires the override capability.',
  OVERRIDE_REASON_REQUIRED: 'An override states its reason.',
};

function respond(request: FastifyRequest, reply: FastifyReply, outcome: Outcome): unknown {
  switch (outcome.kind) {
    case 'denied':
      return respondToDenial(request, reply, outcome.decision);
    case 'not-found':
      return sendNotFound(request, reply);
    case 'invalid':
      return reply.code(422).send(
        validationProblemBodySchema.parse({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'The request body is not valid.',
            correlationId: request.correlationId,
            problems: [{ field: 'body', message: outcome.message }],
          },
        }),
      );
    case 'refused':
      return reply.code(refusalStatus(outcome.failure)).send(
        vacationDecisionRefusalBodySchema.parse({
          error: {
            code: outcome.failure,
            message: REFUSAL_MESSAGE[outcome.failure],
            correlationId: request.correlationId,
          },
        }),
      );
    case 'ok':
      return reply.send(vacationDecisionResultSchema.parse(outcome.value));
  }
}


/* ────────────────────────────────────────────────────────────────────────────
 * OPUS-M5-003 — the MEMBER's half of the round (doc 42 §5f Part B)
 *
 * ## Three routes, and why they are self-scoped where the two above are not
 *
 * | Route | Is | Key |
 * |---|---|---|
 * | `GET …/vacation/rounds` | the group's rounds | `requests.own.read` |
 * | `GET …/vacation/rounds/:periodId` | ONE round: the period, the caller's selections, the variance | `requests.own.read` |
 * | `POST …/vacation/selections/:selectionId/withdraw` | the requester taking their own week back | `requests.own.withdraw` |
 *
 * The two decision routes above declare `requiresObjectPolicy: false` — a queue
 * that could only show the reader's own rows would not be a queue. These three
 * are the opposite and declare `ownershipRequired: true` with **no ownership
 * override**, exactly as the staff request surface does: §4's withdrawal is
 * requester-initiated only, an administrator "withdrawing" for somebody is a
 * DENIAL with a reason, and that denial is `POST …/:selectionId/deny` above under
 * its own key. An ownership override here would be that confusion spelled as a
 * config field.
 *
 * **The keys are M5-001's, not new ones.** FAD-57 made `requests.own.submit` /
 * `.own.withdraw` / `.own.read` role-implied for member and scheduler on doc 08
 * §6's "Submit requests/**vacation**" row, so vacation riding them is the row
 * being honoured rather than a scope widened. Rule 11 cuts both ways: never
 * narrow a capability, and never invent one either.
 *
 * ## Where "edit this week" is, for a future packet that comes looking
 *
 * There is no route that MOVES a selection to another week, and the absence is
 * structural rather than an omission: 0022's column-level UPDATE grant on
 * `vacation_selections` does not include `week_start`, so no runtime role can
 * re-point a selection at a different week at all. The mechanism is WITHDRAW AND
 * RESELECT — two deliberate acts, each with its own audit row, rather than one
 * silent move — and a packet that wants to change that must change the grant
 * first, with the reasoning that a week is what a selection IS.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Read one's OWN vacation round — `requests.own.read`, CAP-021. */
export const OWN_VACATION_ROUND_CONFIG = {
  policy: { kind: 'capability', capability: 'CAP-021' },
  actionScope: 'group',
  action: {
    key: 'requests.own.read',
    moduleKey: 'requests_vacation',
    requiresObjectPolicy: true,
    ownershipRequired: true,
  },
} as const satisfies RouteConfigWithPolicy;

/** Withdraw one's OWN selection — `requests.own.withdraw`, CAP-021. No override. */
export const WITHDRAW_VACATION_SELECTION_CONFIG = {
  policy: { kind: 'capability', capability: 'CAP-021' },
  actionScope: 'group',
  action: {
    key: 'requests.own.withdraw',
    moduleKey: 'requests_vacation',
    requiresObjectPolicy: true,
    ownershipRequired: true,
  },
} as const satisfies RouteConfigWithPolicy;

/** What a member's route answers with. The decision routes' `Outcome` is separate. */
type MemberOutcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'denied'; readonly decision: Decision }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'refused'; readonly failure: VacationSelectionServiceFailure };

/**
 * One unit of work, one verdict, with the target resolved INSIDE it.
 *
 * The target is always the ACTING membership, because none of these three routes
 * names a subject in its path — `:selectionId` names a selection, and which
 * selections this caller can see at all is migration 0023's
 * `vacation_selections_own` policy rather than a path parameter. So
 * `ownershipRequired` compares the acting membership to itself by construction,
 * and a route that ever gained a subject parameter would fail that comparison
 * rather than silently start authorizing it.
 *
 * The rollback is caught OUTSIDE `runtime.run`, for the reason
 * `withVacationDecision` above gives: by the time the error arrives the runner
 * has already rolled back, so a released quota unit is released and a root
 * inserted for a failed link is gone.
 */
async function withOwnVacation<T>(
  request: FastifyRequest,
  run: (
    uow: Parameters<Parameters<FastifyRequest['server']['tenancy']['runtime']['run']>[1]>[0],
  ) => Promise<MemberOutcome<T>>,
): Promise<MemberOutcome<T>> {
  const { context, command, route } = requireTenantContext(request);

  try {
    return await request.server.tenancy.runtime.run(
      command,
      async (uow): Promise<MemberOutcome<T>> => {
        const { decision } = await evaluateInTransaction(uow.query, {
          request,
          context,
          route,
          target: {
            organizationId: context.expectedOrganizationId,
            groupId: context.expectedGroupId,
            type: MEMBERSHIP_AGGREGATE,
            ownerMembershipId: context.membershipId,
            state: null,
          },
        });
        if (!decision.allowed) return { kind: 'denied', decision };
        return await run(uow);
      },
    );
  } catch (error) {
    if (error instanceof VacationSelectionRolledBack) {
      request.log.info(
        { correlationId: request.correlationId, failure: error.failure },
        'vacation selection rolled back',
      );
      return { kind: 'refused', failure: { kind: 'refused', code: error.failure } };
    }
    if (!isPostgresError(error)) throw error;
    /* A `restrict_violation` reaching here is a row whose state the caller was
     * not supposed to be able to observe — 0022's week-in-period guard, 0025's
     * bounds guard, D-27's mapping. `404`, never `409`, for the reason the staff
     * request surface records: a `409` would confirm the row exists and what
     * state it is in. */
    request.log.warn(
      { correlationId: request.correlationId, sqlstate: error.code },
      'vacation selection refused by the database',
    );
    return { kind: 'not-found' };
  }
}

/** The member routes' replies. One mapping, three routes. */
function respondToMember<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  outcome: MemberOutcome<T>,
  body: (value: T) => unknown,
): unknown {
  switch (outcome.kind) {
    case 'denied':
      return respondToDenial(request, reply, outcome.decision);
    case 'not-found':
      return sendNotFound(request, reply);
    case 'invalid':
      return reply.code(422).send(
        validationProblemBodySchema.parse({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'The request body is not valid.',
            correlationId: request.correlationId,
            problems: [{ field: 'body', message: outcome.message }],
          },
        }),
      );
    case 'refused':
      switch (outcome.failure.kind) {
        case 'not-found':
          return sendNotFound(request, reply);
        case 'reused':
          return reply.code(409).send(
            idempotencyKeyReusedBodySchema.parse({
              error: {
                code: 'IDEMPOTENCY_KEY_REUSED',
                message:
                  'This idempotency key already names one of your requests of another kind. ' +
                  'Use a different key.',
                correlationId: request.correlationId,
                existingSubtype: outcome.failure.existingSubtype,
              },
            }),
          );
        case 'deadline':
          /* §3: "Rejected with the effective deadline STATED". */
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
                    : 'This selection is later than the group\u2019s deadline.',
                correlationId: request.correlationId,
                effectiveDeadline: outcome.failure.effective,
              },
            }),
          );
        case 'refused':
          return reply.code(409).send(
            vacationSelectionRefusalBodySchema.parse({
              error: {
                code: outcome.failure.code,
                message:
                  outcome.failure.code === 'VACATION_ROUND_NOT_OPEN'
                    ? 'This vacation round is not accepting selections.'
                    : outcome.failure.code === 'VACATION_WEEK_ALREADY_SELECTED'
                      ? 'You already hold a selection for that week.'
                      : 'This selection is no longer awaiting a decision.',
                correlationId: request.correlationId,
              },
            }),
          );
      }
      break;
    case 'ok':
      return body(outcome.value);
  }
  /* Unreachable: every `MemberOutcome` member is handled above, and the inner
   * switch is exhaustive over `VacationSelectionServiceFailure`. Written rather
   * than cast away, because a cast is what turns a widened union into a silent
   * fall-through. */
  return sendNotFound(request, reply);
}

/**
 * §5.3's derived root status for a selection status that must have one.
 *
 * Throws rather than defaulting: the only status the mapping refuses is
 * `available`, which by §5.3 has no request row at all — so reaching this with
 * one would mean answering a caller about a request that does not exist. A
 * default would invent it.
 */
function derivedRootStatusOf(status: VacationSelectionStatus): RequestStatus {
  const root = derivedRequestStatus(status);
  if (root === null) {
    throw new Error(
      `VACATION_ROOT_STATUS_UNDERIVABLE: §5.3 derives no request status from '${status}'`,
    );
  }
  return root;
}

/** One round on the wire — the period, the selections, and §5.5's variance. */
function roundView(round: VacationRound): unknown {
  return {
    period: {
      id: round.period.id,
      startDate: round.period.startDate,
      endDate: round.period.endDate,
      mode: round.period.mode,
      state: round.period.state,
      version: round.period.version,
    },
    selections: round.selections.map((view) => ({
      selection: {
        id: view.selection.id,
        requestId: view.selection.requestId,
        membershipId: view.selection.membershipId,
        vacationPeriodId: view.selection.vacationPeriodId,
        weekStart: view.selection.weekStart,
        status: view.selection.status,
        version: view.selection.version,
        grantId: view.selection.grantId,
        /* C-3: `isOverride` is carried and `overrideReason` is NOT. The FACT
         * that a week was approved over the allowance is a fact about the
         * member's own week; the REASON is a scheduler's administrative note of
         * the `change_summary` class, and widening who reads that class is a
         * decision nobody has taken. See `vacationSelectionSummarySchema`. */
        isOverride: view.selection.isOverride,
        committedToVersionId: view.selection.committedToVersionId,
      },
      rootStatus: view.rootStatus,
      rootVersion: view.rootVersion,
      submittedAt: view.submittedAt?.toISOString() ?? null,
      expiresAt: view.expiresAt?.toISOString() ?? null,
      isLate: view.isLate,
    })),
    variance: round.variance.map((row) => ({
      grantId: row.grantId,
      kind: row.kind,
      membershipId: row.membershipId,
      weekStart: row.weekStart,
      unitsTotal: row.unitsTotal,
      unitsConsumed: row.unitsConsumed,
      overrideUnits: row.overrideUnits,
      bound: row.bound,
      remaining: row.remaining,
      overEntitlement: row.overEntitlement,
      state: row.state,
    })),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * OPUS-M5-004 — §5.6's commit and reversal (doc 42 §5h, FAD-59)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * §5.6's commit AND its reversal — `vacation.commit`, CAP-023.
 *
 * Not own-scoped: `requiresObjectPolicy: false` and no `ownershipRequired`. A
 * commit is an act on the group's round and a reversal an act on a week a
 * published version carries; neither has an owning subject for L5.1 to ask
 * about. CAP-023 is the baseline capability doc 18 names "Vacation commit to
 * schedule", and this route is what it traces to.
 */
export const COMMIT_VACATION_CONFIG = {
  policy: { kind: 'capability', capability: 'CAP-023' },
  actionScope: 'group',
  action: {
    key: 'vacation.commit',
    moduleKey: 'requests_vacation',
    requiresObjectPolicy: false,
  },
} as const satisfies RouteConfigWithPolicy;

type CommitOutcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'denied'; readonly decision: Decision }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'refused'; readonly failure: VacationCommitFailure | VacationReversalFailure };

/**
 * One unit of work, one verdict, both rollbacks surfaced as outcomes.
 *
 * The `try` is OUTSIDE `runtime.run` for the reason `withVacationDecision`
 * gives: by the time either typed error arrives the runner has already rolled
 * back, so a half-committed round does not exist and the FAD-59 ledger row is
 * gone with it — which is what keeps the same idempotency key retryable after a
 * failure.
 */
async function withVacationCommit<T>(
  request: FastifyRequest,
  run: (
    uow: Parameters<Parameters<FastifyRequest['server']['tenancy']['runtime']['run']>[1]>[0],
  ) => Promise<CommitOutcome<T>>,
): Promise<CommitOutcome<T>> {
  const { context, command, route } = requireTenantContext(request);

  try {
    return await request.server.tenancy.runtime.run(
      command,
      async (uow): Promise<CommitOutcome<T>> => {
        const { decision } = await evaluateInTransaction(uow.query, {
          request,
          context,
          route,
          target: null,
        });
        if (!decision.allowed) return { kind: 'denied', decision };
        return await run(uow);
      },
    );
  } catch (error) {
    if (error instanceof VacationCommitRolledBack || error instanceof VacationReversalRolledBack) {
      request.log.info(
        { correlationId: request.correlationId, failure: error.failure },
        'vacation commit rolled back',
      );
      return { kind: 'refused', failure: error.failure };
    }
    if (!isPostgresError(error)) throw error;
    request.log.warn(
      {
        correlationId: request.correlationId,
        sqlstate: error.code,
        constraint: (error as { constraint?: string }).constraint ?? null,
      },
      'vacation commit refused by the database',
    );
    return { kind: 'not-found' };
  }
}

/** One commit attempt. Separated so R-12's convergence can run it twice. */
async function runCommit(
  request: FastifyRequest,
  periodId: string,
  parsed: ReturnType<typeof commitVacationRoundSchema.safeParse>,
): Promise<CommitOutcome<CommitVacationRoundResult>> {
  return withVacationCommit<CommitVacationRoundResult>(request, async (uow) => {
    if (!isUuid(periodId)) return { kind: 'not-found' as const };
    if (!parsed.success) {
      return { kind: 'invalid' as const, message: 'The commit body is not valid.' };
    }
    const membershipId = uow.context.membershipId;
    if (membershipId === null) return { kind: 'not-found' as const };

    const value = await commitVacationRound(uow, {
      vacationPeriodId: periodId,
      targetVersionId: parsed.data.targetVersionId,
      idempotencyKey: parsed.data.idempotencyKey,
      actingMembershipId: membershipId,
      principalUserId: requireTenantContext(request).context.principalUserId,
      now: new Date(),
    });
    return { kind: 'ok' as const, value };
  });
}

/**
 * The refusal's status code.
 *
 * `403` for the one that is about AUTHORITY — `REVERSAL_OVERRIDE_REQUIRED` is a
 * genuine authorization refusal and a `409` would suggest a retry could work —
 * `422` for the one that is about the BODY, `404` for a period nobody can see,
 * and `409` for the rest, which all mean "the world is not as you believed".
 *
 * Every message is a fixed string carrying no row content: a refusal that echoed
 * a member's week or a version's state would put one person's schedule into
 * another's error.
 */
function commitRefusalStatus(failure: VacationCommitFailure | VacationReversalFailure): number {
  if (failure === 'REVERSAL_OVERRIDE_REQUIRED') return 403;
  if (failure === 'REVERSAL_REASON_REQUIRED') return 422;
  if (failure === 'COMMIT_PERIOD_NOT_FOUND') return 404;
  return 409;
}

const COMMIT_REFUSAL_MESSAGE: Readonly<
  Record<Exclude<VacationCommitFailure, 'COMMIT_RACE_LOST'> | VacationReversalFailure, string>
> = {
  COMMIT_TARGET_NOT_DRAFT:
    'A vacation round is committed into a draft schedule version. A published version is ' +
    'immutable — clone it and publish forward instead.',
  COMMIT_PERIOD_NOT_FOUND: 'No such vacation round.',
  COMMIT_PERIOD_VERSION_MISMATCH:
    'That schedule version does not cover this vacation round\'s dates.',
  COMMIT_NO_OFF_SHIFT_TYPE:
    'This group has no leave-of-absence shift type, so there is nothing for a vacation day to ' +
    'be. Add one to the shift catalogue first.',
  COMMIT_SELECTION_NOT_APPROVED:
    'A selection in this round moved while it was being committed. Nothing was changed.',
  COMMIT_NOTHING_TO_COMMIT: 'There is no approved selection in this round to commit.',
  REVERSAL_SELECTION_NOT_COMMITTED: 'This selection is not committed to a schedule version.',
  REVERSAL_OVERRIDE_REQUIRED: 'Reversing a committed week requires the override capability.',
  REVERSAL_REASON_REQUIRED: 'A reversal states its reason.',
  REVERSAL_GRANT_CONFLICT:
    'The vacation allowance moved while this reversal was running. Nothing was changed.',
};

function respondToCommit<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  outcome: CommitOutcome<T>,
  body: (value: T) => unknown,
): unknown {
  switch (outcome.kind) {
    case 'denied':
      return respondToDenial(request, reply, outcome.decision);
    case 'not-found':
      return sendNotFound(request, reply);
    case 'invalid':
      return reply.code(422).send(
        validationProblemBodySchema.parse({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'The request body is not valid.',
            correlationId: request.correlationId,
            problems: [{ field: 'body', message: outcome.message }],
          },
        }),
      );
    case 'refused': {
      if (outcome.failure === 'COMMIT_RACE_LOST') {
        /* Unreachable through the route: the commit handler retries once and the
         * second attempt replays the winner's ledger row. Written rather than
         * cast away — if it ever DID surface, answering 409 is the honest thing,
         * and a `never`-typed lookup would be a 500 instead. */
        return sendNotFound(request, reply);
      }
      return reply.code(commitRefusalStatus(outcome.failure)).send(
        vacationCommitRefusalBodySchema.parse({
          error: {
            code: outcome.failure,
            message: COMMIT_REFUSAL_MESSAGE[outcome.failure],
            correlationId: request.correlationId,
          },
        }),
      );
    }
    case 'ok':
      return reply.send(body(outcome.value));
  }
}

export default function vacationRoutes(app: FastifyInstance): void {
  const base = '/organizations/:organizationId/groups/:groupId/vacation/selections';

  /* ── approve (§5.4) ───────────────────────────────────── requests.approve ── */

  app.post(`${base}/:selectionId/approve`, { config: APPROVE_VACATION_CONFIG }, async (request, reply) => {
    const outcome = await withVacationDecision(request, async (uow) => {
      const { selectionId } = request.params as { selectionId: string };
      if (!isUuid(selectionId)) return { kind: 'not-found' as const };

      const parsed = approveVacationSelectionSchema.safeParse(request.body);
      if (!parsed.success) {
        return { kind: 'invalid' as const, message: 'The approval body is not valid.' };
      }

      const membershipId = uow.context.membershipId;
      if (membershipId === null) return { kind: 'not-found' as const };

      const value = await approveVacationSelection(uow, {
        selectionId,
        approvalIdempotencyKey: parsed.data.approvalIdempotencyKey,
        expectedSelectionVersion: parsed.data.expectedSelectionVersion,
        ...(parsed.data.grantId === undefined ? {} : { grantId: parsed.data.grantId }),
        ...(parsed.data.expectedGrantVersion === undefined
          ? {}
          : { expectedGrantVersion: parsed.data.expectedGrantVersion }),
        ...(parsed.data.overrideReason === undefined
          ? {}
          : { overrideReason: parsed.data.overrideReason }),
        decidedBy: membershipId,
        now: new Date(),
        /* The override's second evaluation reads the VERIFIED tuple, not anything
         * the body said. Supplying `overrideReason` authorises nothing: without
         * `vacation.override_quota` the approval is refused (R-06) whatever the
         * body carries. */
        actor: evaluationContextOf(requireTenantContext(request).context),
      });
      return { kind: 'ok' as const, value };
    });

    return respond(request, reply, outcome);
  });

  /* ── deny (§5.4, the denial half) ─────────────────────────── requests.deny ── */

  app.post(`${base}/:selectionId/deny`, { config: DENY_VACATION_CONFIG }, async (request, reply) => {
    const outcome = await withVacationDecision(request, async (uow) => {
      const { selectionId } = request.params as { selectionId: string };
      if (!isUuid(selectionId)) return { kind: 'not-found' as const };

      const parsed = denyVacationSelectionSchema.safeParse(request.body);
      if (!parsed.success) {
        return { kind: 'invalid' as const, message: 'The denial body is not valid.' };
      }

      const membershipId = uow.context.membershipId;
      if (membershipId === null) return { kind: 'not-found' as const };

      const value = await denyVacationSelection(uow, {
        selectionId,
        approvalIdempotencyKey: parsed.data.approvalIdempotencyKey,
        expectedSelectionVersion: parsed.data.expectedSelectionVersion,
        reason: parsed.data.reason,
        decidedBy: membershipId,
        now: new Date(),
        actor: evaluationContextOf(requireTenantContext(request).context),
      });
      return { kind: 'ok' as const, value };
    });

    return respond(request, reply, outcome);
  });
  /* ── the group's rounds ────────────────────────────────── requests.own.read ── */

  const rounds = '/organizations/:organizationId/groups/:groupId/vacation/rounds';

  app.get(rounds, { config: OWN_VACATION_ROUND_CONFIG }, async (request, reply) => {
    const outcome = await withOwnVacation(request, async (uow) => ({
      kind: 'ok' as const,
      value: await vacationStore.listPeriods(uow),
    }));

    return respondToMember(request, reply, outcome, (periods) =>
      vacationRoundListSchema.parse({
        periods: periods.map((period) => ({
          id: period.id,
          startDate: period.startDate,
          endDate: period.endDate,
          mode: period.mode,
          state: period.state,
          version: period.version,
        })),
      }),
    );
  });

  /* ── ONE round: period + own selections + variance ─────── requests.own.read ──
   *
   * One request for one surface (I-10). The period, the caller's selections in it
   * and the variance rows come back together because a member opening the round
   * takes ONE action, and three fetches for it is the amplification the
   * request-budget gate counts. */

  app.get(`${rounds}/:periodId`, { config: OWN_VACATION_ROUND_CONFIG }, async (request, reply) => {
    const outcome = await withOwnVacation(request, async (uow) => {
      const { periodId } = request.params as { periodId: string };
      if (!isUuid(periodId)) return { kind: 'not-found' as const };

      const membershipId = uow.context.membershipId;
      if (membershipId === null) return { kind: 'not-found' as const };

      const round = await readVacationRound(uow, { periodId, scope: 'own', membershipId });
      return round.ok
        ? { kind: 'ok' as const, value: round.value }
        : { kind: 'refused' as const, failure: round.failure };
    });

    return respondToMember(request, reply, outcome, (round) =>
      vacationRoundSchema.parse(roundView(round)),
    );
  });

  /* ── withdraw one's own selection ─────────────────── requests.own.withdraw ── */

  app.post(
    `${base}/:selectionId/withdraw`,
    { config: WITHDRAW_VACATION_SELECTION_CONFIG },
    async (request, reply) => {
      const outcome = await withOwnVacation(request, async (uow) => {
        const { selectionId } = request.params as { selectionId: string };
        if (!isUuid(selectionId)) return { kind: 'not-found' as const };

        const parsed = withdrawVacationSelectionSchema.safeParse(request.body);
        if (!parsed.success) {
          return { kind: 'invalid' as const, message: 'The withdrawal body is not valid.' };
        }

        const membershipId = uow.context.membershipId;
        if (membershipId === null) return { kind: 'not-found' as const };

        const result = await withdrawVacationSelection(uow, {
          selectionId,
          expectedSelectionVersion: parsed.data.expectedSelectionVersion,
          /* The VERIFIED context's own membership (SPEC-01 §2.3 derives it
           * server-side), never a path parameter and never a body field. §4's
           * requester-initiated-only rule is decided on this value. */
          membershipId,
          now: new Date(),
        });
        return result.ok
          ? { kind: 'ok' as const, value: result.value }
          : { kind: 'refused' as const, failure: result.failure };
      });

      return respondToMember(request, reply, outcome, (value: VacationSelectionWriteResult) =>
        vacationSelectionResultSchema.parse({
          selectionId: value.selectionId,
          requestId: value.requestId,
          selectionStatus: value.selectionStatus,
          /* C-7: DERIVED through §5.3's table, not written as the literal
           * `'withdrawn'`. The module derives everywhere else — the read model,
           * the surface, the agreement test — and a literal here would be the one
           * place a reader could change the mapping and leave this reply saying
           * the old thing. `null` is unreachable: `derivedRequestStatus` returns
           * null only for `available`, and no withdrawal starts or ends there. */
          rootStatus: derivedRootStatusOf(value.selectionStatus),
          selectionVersion: value.selectionVersion,
          unitReleased: value.unitReleased,
        }),
      );
    },
  );

  /* ── OPUS-M5-004 — §5.6's commit and reversal (doc 42 §5h, FAD-59) ─────────
   *
   * | Route | Is | Key |
   * |---|---|---|
   * | `POST …/vacation/rounds/:periodId/commit` | §5.6's commit to a DRAFT version | `vacation.commit` |
   * | `POST …/vacation/selections/:selectionId/reverse` | §5.6's reversal of one committed week | `vacation.commit` + the override, evaluated inside |
   *
   * **Both are scheduler/administrative, NOT own-scoped**, and that is the whole
   * difference from the three member routes above. `requiresObjectPolicy: false`
   * and no `ownershipRequired`: a commit is an act on the GROUP's round, and a
   * reversal is an act on a week a PUBLISHED version carries. Neither is a
   * statement a person makes about their own circumstances, so L5.1's ownership
   * question has no subject to ask about — which is exactly the M5-003 finding's
   * criterion, applied at declaration rather than after a defect.
   *
   * The M5-003 by-id-write ownership class does not take either of them, and the
   * enumeration test re-derives its set from the route table so this claim is
   * checked rather than asserted: the class is "self-scoped by-id WRITE routes",
   * and these two declare no ownership at all.
   *
   * **No new capability key.** `vacation.commit` already exists (CAP-023, doc 08
   * §4, grant-only) and has had NO EVALUATOR since M1 — it gains one here, in the
   * same change as its surface, which is the rule M5-001 recorded and M5-002
   * applied to `requests.batch_approve` and `vacation.override_quota`.
   *
   * **Reversal declares `vacation.commit` too, and the override is a SECOND
   * evaluation inside the transaction** — the shape §5.5's over-quota override
   * already uses. §5.6's "requires the override capability" is a condition the
   * transaction discovers about an act whose route-level power is the commit
   * surface; splitting it into a third key would invent a capability §5.6 does
   * not name and rule 11 forbids inventing.
   * ────────────────────────────────────────────────────────────────────────── */

  app.post(`${rounds}/:periodId/commit`, { config: COMMIT_VACATION_CONFIG }, async (request, reply) => {
    const { periodId } = request.params as { periodId: string };
    const parsed = commitVacationRoundSchema.safeParse(request.body);

    /* R-12's convergence, and the reason it is a LOOP of exactly two attempts.
     * `COMMIT_RACE_LOST` means another transaction recorded this key while this
     * one was working; everything this one did has rolled back, and the second
     * attempt's step 0 finds the winner's ledger row and replays it. Two
     * attempts and no more: the second cannot lose the race, because the row it
     * would have lost to is already committed and its own step 0 reads it. */
    let outcome = await runCommit(request, periodId, parsed);
    if (outcome.kind === 'refused' && outcome.failure === 'COMMIT_RACE_LOST') {
      outcome = await runCommit(request, periodId, parsed);
    }
    return respondToCommit(request, reply, outcome, (value) =>
      commitVacationRoundResultSchema.parse({
        vacationPeriodId: value.vacationPeriodId,
        targetVersionId: value.targetVersionId,
        committedSelectionIds: [...value.committedSelectionIds],
        assignmentsCreated: value.assignmentSnapshotIds.length,
        replayed: value.replayed,
      }),
    );
  });

  app.post(`${base}/:selectionId/reverse`, { config: COMMIT_VACATION_CONFIG }, async (request, reply) => {
    const outcome = await withVacationCommit<ReverseVacationCommitResult>(request, async (uow) => {
      const { selectionId } = request.params as { selectionId: string };
      if (!isUuid(selectionId)) return { kind: 'not-found' as const };

      const parsed = reverseVacationCommitSchema.safeParse(request.body);
      if (!parsed.success) {
        /* §5.6's reason is MANDATORY, and a body without one never reaches the
         * service: the wire refuses it first, the domain refuses it second
         * (`reversalReasonIsWellFormed`), and 0022's
         * `vacation_selections_override_reason_len` refuses it third. */
        return { kind: 'invalid' as const, message: 'A reversal states its reason.' };
      }

      const membershipId = uow.context.membershipId;
      if (membershipId === null) return { kind: 'not-found' as const };

      const value = await reverseVacationCommit(uow, {
        selectionId,
        reason: parsed.data.reason,
        actingMembershipId: membershipId,
        now: new Date(),
        /* The override's second evaluation reads the VERIFIED tuple, never the
         * body. Supplying a reason authorises nothing. */
        actor: evaluationContextOf(requireTenantContext(request).context),
      });
      return { kind: 'ok' as const, value };
    });

    return respondToCommit(request, reply, outcome, (value) =>
      reverseVacationCommitResultSchema.parse({
        selectionId: value.selectionId,
        requestId: value.requestId,
        selectionVersion: value.selectionVersion,
        unitReleased: value.unitReleased,
        revisionRequested: value.revisionRequested,
      }),
    );
  });
}
