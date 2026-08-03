import {
  authorize,
  authorizeWithoutObjectPolicy,
  denialDisclosure,
  passedCapabilityLayer,
  type ActionInput,
  type Decision,
  type EvaluationContext,
  type ModuleKey,
  type RequestContext,
  type TargetInput,
} from '@schedulepoint/domain';
import type { Kysely } from 'kysely';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { Database } from '../db/schema.js';
import { sendForbidden, sendNotFound } from '../http/context/responses.js';
import type { CapabilityRouteConfig, DeclaredAction } from '../http/policy.js';
import { loadPolicyInput } from './load-policy-input.js';

/**
 * The HTTP surface's entry point into the evaluator.
 *
 * ## Everything here happens inside the caller's transaction
 *
 * `evaluateInTransaction` takes the `Kysely` handle the unit of work gave the
 * handler, so the snapshot it reads and the write the handler performs share one
 * transaction (FAD-12) and the verdict is against current state (I-19). There is
 * deliberately no variant that takes a runner.
 *
 * ## The explanation never reaches the client
 *
 * `respondToDenial` chooses the response from `denialDisclosure(reason)` alone —
 * an enum, not a string — and sends one of exactly two bodies, both fixed. The
 * `Deny.explanation` goes to `request.log` and nowhere else.
 * `apps/api/test/authz/no-explanation-leaks.test.ts` drives denials from every
 * layer through the real server and asserts the explanation text appears in no
 * body and no header.
 */

/** The evaluation context the truth table needs, taken from SPEC-01's verified tuple. */
export function evaluationContextOf(context: RequestContext): EvaluationContext {
  return {
    principalUserId: context.principalUserId,
    expectedOrganizationId: context.expectedOrganizationId,
    expectedGroupId: context.expectedGroupId,
    membershipId: context.membershipId,
  };
}

/** A declaration's action, as the evaluator's `action`. */
export function actionInputOf(route: DeclaredAction): ActionInput {
  // The optional fields are spread in only when present. Under
  // `exactOptionalPropertyTypes` an explicit `undefined` is a different thing
  // from an absent key, and "declared, value undefined" is the shape a reader
  // would mistake for "declared false".
  return {
    key: route.action.key,
    moduleKey: route.action.moduleKey as ModuleKey,
    scope: route.actionScope,
    requiresObjectPolicy: route.action.requiresObjectPolicy,
    ...(route.action.ownershipRequired === undefined
      ? {}
      : { ownershipRequired: route.action.ownershipRequired }),
    ...(route.action.ownershipOverrideCapability === undefined
      ? {}
      : { ownershipOverrideCapability: route.action.ownershipOverrideCapability }),
    ...(route.action.permittedTargetStates === undefined
      ? {}
      : { permittedTargetStates: route.action.permittedTargetStates }),
  };
}

export interface EvaluateOptions {
  /**
   * The request being authorized.
   *
   * Required, and only for one reason: `evaluateInTransaction` marks it as
   * evaluated, and the middleware's `onSend` guard turns a capability route that
   * returns 2xx WITHOUT that mark into a 500. Taking the request as a parameter
   * is what makes "every capability route evaluates" a property of the type
   * rather than of everybody's memory.
   */
  readonly request: FastifyRequest;
  readonly context: RequestContext;
  readonly route: CapabilityRouteConfig;
  readonly target?: TargetInput | null;
  readonly now?: Date;
}

export interface RequestVerdict {
  readonly decision: Decision;
  /**
   * SPEC-01 §2.3 step 6 (V-07): "the ordinary SPEC-06 capability evaluation for
   * the declared tenant, evaluated **without** the object-policy layer".
   *
   * Computed in the same transaction as `decision`, from the same snapshot, so
   * the two cannot disagree about anything except L5.1 — which is the only
   * difference step 6 is entitled to observe.
   */
  readonly authorizedInDeclaredTenant: boolean;
}

/**
 * The transport-neutral evaluation — everything `evaluateInTransaction` does
 * except the Fastify-specific mark.
 *
 * ## Why this exists (OPUS-M1-004, FAD-13 item 1)
 *
 * SPEC-06 §7: **"One evaluator, every path. A surface with its own authorization
 * logic is a defect."** Until this task, `evaluateInTransaction` was the only way
 * in and it demanded a `FastifyRequest`, so the job surface could not use it and
 * authorized on OPUS-M1-001's role allow-list instead — a second evaluator that
 * could not see entitlements, module availability or grants.
 *
 * A worker has no request and no reply, so the fix is not to fake one: it is to
 * separate the evaluation from the HTTP bookkeeping. `apps/api/src/jobs/worker.ts`
 * calls **this**, with the frozen context's tuple; the HTTP wrapper below calls it
 * too. There is one truth table and one loader on both paths.
 *
 * The `Kysely` handle is still the caller's, so FAD-12 holds on the job surface
 * exactly as it does on the HTTP one: the authorization snapshot, the mutation and
 * the audit row are one transaction.
 */
export async function evaluateAction(
  query: Kysely<Database>,
  options: {
    readonly context: EvaluationContext;
    readonly action: ActionInput;
    readonly target?: TargetInput | null;
    readonly now?: Date;
  },
): Promise<RequestVerdict> {
  const input = await loadPolicyInput(query, {
    context: options.context,
    action: options.action,
    target: options.target ?? null,
    now: options.now ?? new Date(),
  });

  const decision = authorize(input);
  // When L5.1 never ran, the two answers are the same evaluation and the second
  // call is redundant — but it is cheap (pure, no I/O) and computing it
  // unconditionally means no caller has to know which case it is in.
  const authorizedInDeclaredTenant = passedCapabilityLayer(decision)
    ? true
    : authorizeWithoutObjectPolicy(input).allowed;

  return { decision, authorizedInDeclaredTenant };
}

/**
 * Evaluate the route's action for this request, in the caller's transaction.
 *
 * Both verdicts come from ONE snapshot read. Reading twice would be two
 * snapshots and a window between them, which is the same class of race FAD-12
 * exists to close.
 */
export async function evaluateInTransaction(
  query: Kysely<Database>,
  options: EvaluateOptions,
): Promise<RequestVerdict> {
  // Marked BEFORE the read rather than after the verdict: the guard's question
  // is "did this route consult its policy", and a route whose evaluation threw
  // must surface that error rather than a 500 about a missing evaluation.
  options.request.authorizationEvaluated = true;
  return evaluateAction(query, {
    context: evaluationContextOf(options.context),
    action: actionInputOf(options.route),
    target: options.target ?? null,
    // Under `exactOptionalPropertyTypes` an explicit `undefined` is not the same
    // thing as an absent key, and `evaluateAction` reads the absence.
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

/**
 * Turn a denial into a response, disclosing nothing beyond the disclosure class.
 *
 * P-5: L0–L2 → `404`. P-6: L3 → `404` (a non-member must not learn the tenant
 * exists), L4–L6 → `403` (the actor already holds an active membership here).
 */
export function respondToDenial(
  request: FastifyRequest,
  reply: FastifyReply,
  decision: Decision,
): FastifyReply {
  if (decision.allowed) {
    throw new Error('respondToDenial called with an ALLOW — the caller has inverted a branch');
  }

  // Operator-facing only. Tenant identifiers and the step are metadata; no
  // payload body and nothing a user typed appears here (I-07, I-17).
  request.log.info(
    {
      correlationId: request.correlationId,
      authorization: {
        step: decision.step,
        reason: decision.reason,
        explanation: decision.explanation,
        disclosure: denialDisclosure(decision.reason),
      },
    },
    'authorization denied',
  );

  return denialDisclosure(decision.reason) === 'forbidden'
    ? // `sendForbidden`'s `reason` argument is also log-only; it takes the REASON
      // code rather than the explanation so that even the log line a future
      // change might accidentally echo carries no free text.
      sendForbidden(request, reply, decision.reason)
    : sendNotFound(request, reply);
}
