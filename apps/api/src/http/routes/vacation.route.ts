import {
  approveVacationSelectionSchema,
  denyVacationSelectionSchema,
  isUuid,
  vacationDecisionRefusalBodySchema,
  vacationDecisionResultSchema,
  validationProblemBodySchema,
} from '@schedulepoint/contracts';
import type { Decision, VacationApprovalFailure } from '@schedulepoint/domain';
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
import { requireTenantContext } from '../context/middleware.js';
import { sendNotFound } from '../context/responses.js';
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
}
