/**
 * SPEC-08 §4 — the DECISION vocabulary: what a decision is, when it carries a
 * reason, and what a batch of them answers (OPUS-M5-002, doc 42 §5d Parts A
 * and C).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## This file states VOCABULARY and RULES. It enforces nothing
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `packages/domain` imports NOTHING — no clock, no database handle, no
 * configuration — so every function here is a pure question about values. The
 * enforcement of the same rules lives in migration 0024's CHECK constraints and
 * in `apps/api/src/requests/decisions.ts`, and the agreement between the layers
 * is asserted by test rather than assumed, exactly as `./transitions.ts` and
 * `app_request_transition_is_legal` are.
 *
 * ## The reason, and the three places it may not go
 *
 * §4 makes a reason MANDATORY on a denial, and §5.5 makes one mandatory on an
 * audited over-quota override. `decisionRequiresReason` is that rule as a
 * predicate, and migration 0024's `approvals_reason_mandatory_where_stated` is
 * the same rule as a CHECK, in both directions.
 *
 * **The reason never enters an audit payload, an outbox payload, or a
 * notification** (I-07, ADR-0019, non-bypass rules 8 and 9). That is not a
 * convention this module asks callers to honour: `auditPayloadViolations` in
 * `../audit/payload.ts` refuses any payload string containing a space or longer
 * than 64 characters, and `app_audit_payload_is_closed` refuses the same in SQL,
 * so a payload carrying prose is rejected before any statement issues. This
 * module deliberately provides no helper that would put a reason into a payload
 * shape, and `DecisionAuditFacts` below is the closed set of things a decision
 * DOES publish — every member a token or an identifier.
 */

import type { RequestStatus, RequestSubtype } from './subtypes.js';

/* ────────────────────────────────────────────────────────────────────────────
 * The decisions
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * §4's three acts.
 *
 * `reversed` is the APPROVAL-side reversal — "a new `approvals` record; the
 * prior decision is never overwritten". It is not §5.6's vacation
 * `committed → reversed`, which is a different act on a different lifecycle and
 * belongs to M5-004.
 *
 * **There is no reversal of a DENIAL, and the absence is a recorded observation
 * rather than an oversight.** §2's matrix gives `denied` no outgoing edge for
 * any subtype, so a denial-side reversal would need a status move the matrix
 * forbids. §4's reversal sentence does not name a denied-side edge and a denied
 * request's remedy is a fresh submission under a new idempotency key, so nothing
 * in SPEC-08 requires the cell — which is what distinguishes this from FAD-55,
 * where §4 and R-10 named the missing transition in terms that admitted no other
 * reading. It is the sixth item on the M5 exit sweep's SPEC-08 clarification
 * docket.
 */
export const REQUEST_DECISIONS = ['approved', 'denied', 'reversed'] as const;

export type RequestDecision = (typeof REQUEST_DECISIONS)[number];

/**
 * The bound on a decision reason, matching migration 0024's CHECK and
 * `vacation_selections.override_reason` before it.
 *
 * A bound is what keeps "an administrative note" from becoming a document store,
 * and it is the same number `schedule_versions.change_summary` uses because it
 * is the same class of text — scheduler-authored, bounded, never clinical, never
 * an ingestion path (non-bypass rule 8).
 */
export const DECISION_REASON_MAX_LENGTH = 1000;

/**
 * **§4 and §5.5's mandatory-reason rule, in both directions.**
 *
 * A reason is required for a denial, for a reversal, and for an audited
 * over-quota override — and PROHIBITED for an ordinary approval. Migration
 * 0024's `approvals_reason_mandatory_where_stated` is the same predicate as a
 * CHECK.
 *
 * The prohibition half is the part worth defending. An optional note on an
 * ordinary approval would be new bounded free text on a `SENSITIVE-PII`
 * aggregate that no specification asks for, and the moment it exists somebody
 * will put something in it that the classification did not anticipate. Neither
 * §4 nor §5.5 asks for it, so it does not exist.
 */
export function decisionRequiresReason(decision: RequestDecision, isOverride: boolean): boolean {
  return decision !== 'approved' || isOverride;
}

/** Whether a reason is a shape migration 0024 will accept. Trimmed, bounded, non-empty. */
export function decisionReasonIsWellFormed(reason: string): boolean {
  const trimmed = reason.trim();
  return trimmed.length >= 1 && trimmed.length <= DECISION_REASON_MAX_LENGTH;
}

/* ────────────────────────────────────────────────────────────────────────────
 * What a decision PUBLISHES — the closed set (I-07)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Everything a decision puts into an audit or outbox payload.
 *
 * **The type is the boundary.** There is no `reason` member and there is no
 * index signature, so a caller cannot widen it without editing this declaration
 * — and a reader auditing "what does a decision disclose" reads one type rather
 * than four call sites. Every member is a token or a uuid, which is what
 * `auditPayloadViolations` requires.
 *
 * `apps/api/test/requests/decision-reason-closure.test.ts` asserts BOTH halves:
 * that a realistic reason is refused by the payload validator and by its SQL
 * mirror, and that the payloads this packet actually emits carry no reason field.
 */
export interface DecisionAuditFacts {
  readonly requestId: string;
  readonly subtype: RequestSubtype;
  readonly decision: RequestDecision;
  readonly fromStatus: RequestStatus;
  readonly toStatus: RequestStatus;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Batch — per-item outcomes, never all-or-nothing silence
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Why one item of a batch did not get its decision.
 *
 * A closed vocabulary, because doc 42 §5d requires "per-item outcomes (a partial
 * batch failure is per-item, never all-or-nothing silent)" — and an outcome a
 * caller cannot branch on is an outcome that becomes "some of them worked".
 *
 * `version-conflict` is §4's first-decision-wins loser: "the second gets an
 * explicit conflict — never a silent overwrite". It is deliberately distinct
 * from `already-decided`, which is the domain matrix refusing the operation from
 * a status that has already moved. The two look alike from outside and have
 * different remedies: a conflict means reload and retry, an already-decided
 * means somebody else got there first and there is nothing to retry.
 */
export const DECISION_ITEM_FAILURES = [
  /** Not visible in this tenant context, or no such request. One answer (X-11). */
  'not-found',
  /** The domain matrix refuses this decision from the row's current status. */
  'illegal-operation',
  /** §4: the conditional update on `expected_version` matched nothing. */
  'version-conflict',
  /** A denial or a reversal arrived without the reason §4 makes mandatory. */
  'reason-required',
  /** The subtype is decided somewhere else — vacation, through §5.4's transaction. */
  'subtype-not-decidable-here',
] as const;

export type DecisionItemFailure = (typeof DECISION_ITEM_FAILURES)[number];

/** One item's answer. A batch returns one of these per item, in the order sent. */
export type DecisionItemOutcome =
  | {
      readonly requestId: string;
      readonly ok: true;
      readonly decision: RequestDecision;
      readonly status: RequestStatus;
      readonly version: number;
    }
  | {
      readonly requestId: string;
      readonly ok: false;
      readonly failure: DecisionItemFailure;
    };

/**
 * The bound on one batch.
 *
 * I-10 says one user action produces one request, and a batch decision IS one
 * user action — a scheduler selecting rows in a queue and deciding them
 * together. The bound is what keeps that from becoming a way to hold locks
 * proportional to how many rows somebody selected: the same reasoning
 * `claimExpirable`'s `limit` records, from the other end.
 */
export const DECISION_BATCH_MAX_ITEMS = 100;
