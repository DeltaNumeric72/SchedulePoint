import {
  DECISION_BATCH_MAX_ITEMS,
  decisionRequiresReason,
  decisionStatusPath,
  operationVerdict,
  type DecisionItemFailure,
  type DecisionItemOutcome,
  type RequestAggregate,
  type RequestDecision,
  type UnitOfWork,
} from '@schedulepoint/domain';
import type { Kysely } from 'kysely';

import { recordAuditEvent } from '../audit/recorder.js';
import type { Database } from '../db/schema.js';
import { publishOutboxEvent } from '../outbox/publisher.js';

import { requestStore } from './store.js';

/**
 * SPEC-08 §4 — the DECISION service: approve, deny, reverse, individually and in
 * a batch (OPUS-M5-002, doc 42 §5d Parts A and C).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## The same three steps `service.ts` records, plus one
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   1. **ask the DOMAIN** whether the operation is legal on this
 *      (subtype × status) — `operationVerdict`, from §2's matrices;
 *   2. **check the reason rule** — §4 makes a reason MANDATORY on a denial and
 *      §5.5 on an override, and migration 0024's
 *      `approvals_reason_mandatory_where_stated` says the same thing in both
 *      directions as a CHECK;
 *   3. **write through the store**, where the DATABASE asks (1) again in
 *      `app_guard_request_transition` and refuses it independently;
 *   4. **append the decision** to `approvals`, which nothing can overwrite.
 *
 * ## Nothing here decides WHO may act
 *
 * The route's declared action key — `requests.approve` or `requests.deny` — is
 * evaluated against current state inside this same transaction (I-19, SPEC-06
 * §7) before this service is reached, and migration 0023's
 * `requests_group_administration` is what admits the write to another member's
 * row at all. This service decides whether the ROW may move.
 *
 * **That division is the whole of the §5c binding note.** 0023's `requests_own`
 * is `FOR ALL` with `status` in the column grant, so at the SQL layer a member's
 * own row can walk every §2 edge; what makes `approved` unreachable except
 * through a decision path is that every route which can call this service
 * declares a decision key. RLS decides which ROWS; PO-DEC-02's layers decide
 * which OPERATIONS. See migration 0024's header §4 for the residue that division
 * deliberately leaves, and `test/requests/decision-authority.test.ts` for the
 * proof at the layer that does decide operations.
 *
 * ## I-07 — the reason is stored, and goes nowhere else
 *
 * Every payload below is `DecisionAuditFacts`-shaped: ids, subtypes and
 * statuses, all tokens. **No payload names a reason**, and the payload validator
 * would refuse one anyway — `auditPayloadViolations` rejects any string with a
 * space or over 64 characters, and `app_audit_payload_is_closed` rejects the same
 * in SQL. `test/requests/decision-reason-closure.test.ts` proves both halves
 * rather than leaving this paragraph as the only control.
 *
 * ## I-11 — a notification failure never rolls back a decision
 *
 * Every notification goes through the OUTBOX in the same transaction as the
 * write. The row commits with the decision or with neither; delivery happens
 * afterwards, from a dispatcher that cannot reach back into this transaction.
 */

type Uow = UnitOfWork<Kysely<Database>>;

/* ────────────────────────────────────────────────────────────────────────────
 * Commands and outcomes
 * ──────────────────────────────────────────────────────────────────────────── */

export interface DecideCommand {
  readonly requestId: string;
  /** §4: "conditional update on `expected_version`; **first decision wins**". */
  readonly expectedVersion: number;
  readonly decision: Extract<RequestDecision, 'approved' | 'denied'>;
  /** MANDATORY for a denial (§4). `null` for an approval, and refused if present. */
  readonly reason: string | null;
  readonly decidedBy: string;
  readonly now: Date;
}

export interface ReverseCommand {
  readonly requestId: string;
  readonly expectedVersion: number;
  /** MANDATORY (§4/§5.6's discipline: taking something back is always explained). */
  readonly reason: string;
  readonly reversedBy: string;
  readonly now: Date;
}

export interface DecisionResult {
  readonly requestId: string;
  readonly decision: RequestDecision;
  readonly status: RequestAggregate['status'];
  readonly version: number;
  readonly approvalId: string;
}

export type DecisionOutcome =
  | { readonly ok: true; readonly value: DecisionResult }
  | { readonly ok: false; readonly failure: DecisionItemFailure };

const refuse = (failure: DecisionItemFailure): DecisionOutcome => ({ ok: false, failure });

/* ────────────────────────────────────────────────────────────────────────────
 * One decision — §4
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * **Approve or deny one request.**
 *
 * ## The two-step is not optional and not visible from outside
 *
 * A request the queue shows at `submitted` reaches `approved` by way of
 * `under_review`: §2 carries no `submitted → approved` cell for any subtype, and
 * 0021's transition guard implements §2 literally, so the single-statement
 * spelling is refused by the database (M5-000b finding #1, binding). The path
 * comes from `decisionStatusPath` — the same matrix the guard consults — and the
 * store walks it one edge at a time inside ONE transaction. A caller performs one
 * operation (I-10); the row is never observable at the intermediate.
 *
 * ## `shift-preference` and `vacation-selection` are refused here, differently
 *
 * A shift preference is **never approved** (§2.1): it is non-binding, has no
 * `under_review`/`approved`/`denied` in its D-20 domain at all, and its
 * acceptance is `submitted → accepted_as_input`. A vacation selection is decided
 * by §5.4's transaction, because §5.3 gives that lifecycle ONE writer and a
 * second one here would move the root without moving the selection — which D-27
 * would then refuse at COMMIT with a message about a mapping rather than about a
 * mistaken caller. Both come back as `subtype-not-decidable-here`, from the
 * domain's own verdict rather than from a list in this file.
 */
export async function decideRequest(uow: Uow, command: DecideCommand): Promise<DecisionOutcome> {
  const root = await requestStore.loadRoot(uow, command.requestId);
  if (root === null) return refuse('not-found');

  const operation = command.decision === 'approved' ? 'approve' : 'deny';
  const verdict = operationVerdict(root.subtype, root.status, operation);
  if (!verdict.allowed) {
    return refuse(
      verdict.reason === 'operation-not-available-for-subtype'
        ? 'subtype-not-decidable-here'
        : 'illegal-operation',
    );
  }

  /* §4's mandatory reason, in BOTH directions. `isOverride` is false on this
   * surface — an override is a quota act and only a vacation approval consumes
   * quota — so the rule reduces to "a denial states a reason, an approval states
   * none". Migration 0024's CHECK refuses the same shapes. */
  const reasonRequired = decisionRequiresReason(command.decision, false);
  if (reasonRequired && (command.reason === null || command.reason.trim().length === 0)) {
    return refuse('reason-required');
  }
  if (!reasonRequired && command.reason !== null) return refuse('reason-required');

  const path = decisionStatusPath(root.subtype, root.status, verdict.to);
  if (path === null) return refuse('illegal-operation');

  const version = await requestStore.decide(uow, {
    requestId: command.requestId,
    expectedVersion: command.expectedVersion,
    path,
    decidedBy: command.decidedBy,
    decidedAt: command.now,
  });
  /* §4's loser. A zero-row conditional update is an explicit conflict, never a
   * silent overwrite — and it is deliberately the same answer as "this row is
   * not visible in this tenant context", for the X-11 reason the store's header
   * gives. */
  if (version === null) return refuse('version-conflict');

  const approvalId = await requestStore.recordApproval(uow, {
    requestId: command.requestId,
    decision: command.decision,
    decidedBy: command.decidedBy,
    decidedAt: command.now,
    reason: command.reason,
    isOverride: false,
    vacationSelectionId: null,
    supersedesApprovalId: null,
  });

  await publishDecision(uow, {
    eventName: command.decision === 'approved' ? 'approved' : 'denied',
    requestId: command.requestId,
    subtype: root.subtype,
    decision: command.decision,
    fromStatus: root.status,
    toStatus: verdict.to,
    version,
  });

  return {
    ok: true,
    value: {
      requestId: command.requestId,
      decision: command.decision,
      status: verdict.to,
      version,
      approvalId,
    },
  };
}

/**
 * **Reverse an approval — §4's "a new `approvals` record; the prior decision is
 * never overwritten".**
 *
 * The prior row is not read in order to be protected from: no runtime role holds
 * UPDATE or DELETE on `approvals`, so it could not be touched by any statement
 * this process can issue. It is read in order to be NAMED — `supersedes_approval_id`
 * is what makes the chain readable in both directions, and migration 0024's
 * `approvals_reversal_names_its_predecessor` refuses a reversal that names
 * nothing.
 *
 * A request standing at `approved` with no approval row is possible only for a
 * row decided before this packet existed. It is refused rather than reversed with
 * a null predecessor, because a reversal that cannot say what it reverses is a
 * status change wearing a decision's name.
 */
export async function reverseDecision(
  uow: Uow,
  command: ReverseCommand,
): Promise<DecisionOutcome> {
  const root = await requestStore.loadRoot(uow, command.requestId);
  if (root === null) return refuse('not-found');

  const verdict = operationVerdict(root.subtype, root.status, 'reverse_decision');
  if (!verdict.allowed) {
    return refuse(
      verdict.reason === 'operation-not-available-for-subtype'
        ? 'subtype-not-decidable-here'
        : 'illegal-operation',
    );
  }

  if (command.reason.trim().length === 0) return refuse('reason-required');

  const history = await requestStore.listApprovals(uow, command.requestId);
  const priorApproval = history.find((entry) => entry.decision === 'approved');
  if (priorApproval === undefined) return refuse('illegal-operation');

  const version = await requestStore.reverseDecision(uow, {
    requestId: command.requestId,
    expectedVersion: command.expectedVersion,
    reversedAt: command.now,
    reversedBy: command.reversedBy,
  });
  if (version === null) return refuse('version-conflict');

  const approvalId = await requestStore.recordApproval(uow, {
    requestId: command.requestId,
    decision: 'reversed',
    decidedBy: command.reversedBy,
    decidedAt: command.now,
    reason: command.reason,
    isOverride: false,
    vacationSelectionId: null,
    supersedesApprovalId: priorApproval.id,
  });

  await publishDecision(uow, {
    eventName: 'decision_reversed',
    requestId: command.requestId,
    subtype: root.subtype,
    decision: 'reversed',
    fromStatus: root.status,
    toStatus: verdict.to,
    version,
  });

  return {
    ok: true,
    value: {
      requestId: command.requestId,
      decision: 'reversed',
      status: verdict.to,
      version,
      approvalId,
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Batch — per-item outcomes (doc 42 §5d Part C)
 * ──────────────────────────────────────────────────────────────────────────── */

export interface BatchDecisionItem {
  readonly requestId: string;
  readonly expectedVersion: number;
}

export interface BatchDecisionCommand {
  readonly items: readonly BatchDecisionItem[];
  readonly decision: Extract<RequestDecision, 'approved' | 'denied'>;
  /**
   * One reason for the whole batch, mandatory when the batch is a denial.
   *
   * Per-item reasons are deliberately not offered. A scheduler denying twenty
   * requests at once has ONE reason — the shift is covered, the period is full —
   * and a per-item field would be twenty boxes that get filled with the same
   * sentence or with nothing. The single reason is stored on every one of the
   * twenty `approvals` rows, so each decision still carries its own explanation
   * when it is read back individually.
   */
  readonly reason: string | null;
  readonly decidedBy: string;
  readonly now: Date;
}

/**
 * **Decide many requests, with an answer for EVERY item.**
 *
 * ## Per-item, never all-or-nothing silent
 *
 * Each item gets its own outcome in the order it was sent, and one item's
 * refusal does not touch its neighbours. Every refusal this loop can produce is a
 * DOMAIN refusal or a zero-row conditional update — neither raises — so a batch
 * in which half the rows moved under somebody else returns half successes and
 * half `version-conflict`s, all of which commit.
 *
 * ## What is NOT per-item, stated rather than discovered
 *
 * An unexpected DATABASE refusal — a guard raising `restrict_violation`, a
 * constraint violation — aborts the whole transaction, and the caller answers
 * accordingly. It does not become a per-item failure with the others reported as
 * successes, because those successes did not commit and reporting them would be
 * the "silent all-or-nothing" this design exists to avoid, told backwards. The
 * batch is one unit of work by construction (the runner owns the boundary), and
 * that is the honest boundary to report at.
 *
 * ## The bound
 *
 * `DECISION_BATCH_MAX_ITEMS`. A batch decision IS one user action (I-10), and the
 * bound is what keeps one action from holding row locks proportional to how many
 * rows somebody selected — the same reasoning `claimExpirable`'s limit records.
 * Duplicate ids within one batch are answered independently, and the second
 * occurrence loses on `expectedVersion` because the first moved the row: the
 * conflict is real and reporting it is correct.
 */
export async function decideRequestsBatch(
  uow: Uow,
  command: BatchDecisionCommand,
): Promise<readonly DecisionItemOutcome[]> {
  if (command.items.length > DECISION_BATCH_MAX_ITEMS) {
    throw new Error(
      `DECISION_BATCH_TOO_LARGE: ${String(command.items.length)} items exceeds the bound of ` +
        `${String(DECISION_BATCH_MAX_ITEMS)}`,
    );
  }

  const outcomes: DecisionItemOutcome[] = [];
  for (const item of command.items) {
    const outcome = await decideRequest(uow, {
      requestId: item.requestId,
      expectedVersion: item.expectedVersion,
      decision: command.decision,
      reason: command.reason,
      decidedBy: command.decidedBy,
      now: command.now,
    });
    outcomes.push(
      outcome.ok
        ? {
            requestId: item.requestId,
            ok: true,
            decision: outcome.value.decision,
            status: outcome.value.status,
            version: outcome.value.version,
          }
        : { requestId: item.requestId, ok: false, failure: outcome.failure },
    );
  }
  return outcomes;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The audit and outbox pair
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * One decision's audit row and its outbox row, in the caller's transaction.
 *
 * **Every value below is a token or a uuid**, which is what
 * `assertClosedAuditPayload` requires and what I-07 is about. There is no
 * `reason` key here and there is no parameter that could carry one — the
 * function's own signature is the boundary, so a future caller cannot add one
 * without editing this declaration and meeting the test that reads it.
 */
async function publishDecision(
  uow: Uow,
  facts: {
    readonly eventName: 'approved' | 'denied' | 'decision_reversed';
    readonly requestId: string;
    readonly subtype: RequestAggregate['subtype'];
    readonly decision: RequestDecision;
    readonly fromStatus: RequestAggregate['status'];
    readonly toStatus: RequestAggregate['status'];
    readonly version: number;
  },
): Promise<void> {
  const audit = await recordAuditEvent(uow, {
    eventName: `requests.request.${facts.eventName}`,
    subjectType: 'request',
    subjectId: facts.requestId,
    payload: {
      requestId: facts.requestId,
      subtype: facts.subtype,
      decision: facts.decision,
      fromStatus: facts.fromStatus,
      toStatus: facts.toStatus,
    },
  });
  await publishOutboxEvent(uow, audit, {
    kind: `requests.request.${facts.eventName}`,
    idempotencyKey: `request-${facts.eventName}:${facts.requestId}:${String(facts.version)}`,
    payload: {
      requestId: facts.requestId,
      subtype: facts.subtype,
      decision: facts.decision,
    },
  });
}
