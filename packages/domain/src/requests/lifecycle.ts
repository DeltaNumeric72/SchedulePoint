/**
 * SPEC-08 §4 and §7 R-01 — the request lifecycle OPERATIONS, and what each one
 * is legal on (OPUS-M5-001, doc 42 §5c Parts A and C).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## Operations, not edges
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `./transitions.ts` answers "may a row move from here to there". This file
 * answers "may this ACTOR perform THIS OPERATION on a row standing here" — which
 * is R-01's question, and R-01 is a cross-product over
 * *(subtype × status × operation)* rather than over *(subtype × from × to)*.
 *
 * The two are not the same question, and the difference is where the interesting
 * refusals live. `approved → withdrawn` is one edge; **withdrawal** is an
 * operation with a requester, a boundary (R-22) and a consequence at the far end
 * of it (R-10). A caller that only had the edge would have to know which edge a
 * withdrawal is for each subtype, which is exactly the knowledge that goes stale.
 *
 * ## The three operations THIS packet owns
 *
 * | Operation | Owner | This packet |
 * |---|---|---|
 * | `submit` | M5-001 | ✓ Part B |
 * | `withdraw` | M5-001 | ✓ Part C |
 * | `expire` | M5-001 | ✓ Part B's sweeper |
 * | `approve` / `deny` / `reverse_decision` | **M5-002** | ✓ — see below |
 * | `consume` / `reflect` / `mark_unsatisfied` | M5-004 | absent, deliberately |
 *
 * **The absences are the point.** A `REQUEST_OPERATIONS` list containing
 * `approve` with no implementation would make the cross-product test assert
 * something about a verb nobody has written, and the first person to write it
 * would find a matrix already deciding their design. The list grows with its
 * implementations, exactly as `packages/domain/src/requests/port.ts` says the
 * store's verbs do.
 *
 * ## OPUS-M5-002 — the three decision operations, added with their writers
 *
 * `approve`, `deny` and `reverse_decision` land here because doc 42 §5d lands
 * their transaction, their routes and their capability keys in the same change.
 * The table above is amended rather than rewritten, so a reader can still see
 * that these were once absent and why.
 *
 * The cross-product test (R-01) widens with them automatically: it enumerates
 * `REQUEST_OPERATIONS`, so every (subtype × status) pair now gets a verdict for
 * six operations rather than three, and the database half — 0021's transition
 * predicate — answers on the same edges.
 *
 * ## Nothing here decides WHO may act
 *
 * Authorization is SPEC-06's, evaluated per request against current state inside
 * the unit of work (I-19). This file decides whether an operation is legal on a
 * row in a given state — a question about the ROW. "Is this person allowed" is a
 * question about the PRINCIPAL and it is answered somewhere else, on purpose: a
 * module that answered both would be a module where a state check could be
 * mistaken for a permission check.
 *
 * The one place the two touch is `withdraw`, and only to record that §4 settles a
 * question the state cannot: **withdrawal is requester-initiated only.** An
 * administrator "withdrawing" for somebody is a DENIAL with a reason, recorded as
 * such. That is enforced by the route's `ownershipRequired: true` with no
 * ownership override — the same mechanism `schedule.own_published.read` uses —
 * and it is stated here so a reader of the lifecycle meets it.
 */

import {
  REQUEST_STATUSES_BY_SUBTYPE,
  type RequestStatus,
  type RequestSubtype,
} from './subtypes.js';
import { REVIEWED_SUBTYPES, transitionIsLegal } from './transitions.js';

/* ────────────────────────────────────────────────────────────────────────────
 * The operations
 * ──────────────────────────────────────────────────────────────────────────── */

/** The lifecycle operations implemented so far. See the header on absences. */
export const REQUEST_OPERATIONS = [
  'submit',
  'withdraw',
  'expire',
  /* OPUS-M5-002 — §4's decisions, added with their transaction and their keys. */
  'approve',
  'deny',
  'reverse_decision',
] as const;

export type RequestOperation = (typeof REQUEST_OPERATIONS)[number];

/**
 * Why an operation was refused — a closed vocabulary, because a refusal a caller
 * cannot branch on is a refusal that becomes a 500.
 */
export const REQUEST_REFUSAL_REASONS = [
  /** The status is not one this subtype can ever hold (D-20). */
  'status-not-in-subtype-domain',
  /** The operation has no meaning from this status — R-22's refusal, and R-23's. */
  'operation-not-legal-from-status',
  /** The operation exists for other subtypes but not this one. */
  'operation-not-available-for-subtype',
] as const;

export type RequestRefusalReason = (typeof REQUEST_REFUSAL_REASONS)[number];

/** The verdict, with the status the operation would move the row to when allowed. */
export type OperationVerdict =
  | { readonly allowed: true; readonly to: RequestStatus }
  | { readonly allowed: false; readonly reason: RequestRefusalReason };

/* ────────────────────────────────────────────────────────────────────────────
 * Where each operation is legal
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * **`submit` — `draft → submitted`, and only that.**
 *
 * Submission is a TRANSITION, never an insert state (the initial-INSERT ruling in
 * `./transitions.ts`). So the only status a submission acts on is `draft`, and
 * `vacation-selection` — whose root is CREATED at `submitted` — has no `submit`
 * operation on an existing root at all. Its submission is the creation of the
 * root, and it belongs to M5-002/003 with the rest of the vacation writers.
 */
function submitVerdict(subtype: RequestSubtype, from: RequestStatus): OperationVerdict {
  if (subtype === 'vacation-selection') {
    return { allowed: false, reason: 'operation-not-available-for-subtype' };
  }
  if (from !== 'draft') return { allowed: false, reason: 'operation-not-legal-from-status' };
  return { allowed: true, to: 'submitted' };
}

/**
 * **`withdraw` — R-22's boundaries, and R-10's far end.**
 *
 * The ordinary case is the matrix: withdrawal succeeds from `submitted`,
 * `under_review`, `approved` and `accepted_as_input`, per subtype, and is
 * REFUSED from `consumed_by_build` — which is R-22 exactly. A build has taken the
 * request as input; pulling it out from under the run is not a withdrawal, it is
 * a corruption of the run's inputs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## `reflected_in_version → withdrawn` — a DECLARED DECISION, escalated and
 *    ratified in-round. Read this before comparing the matrix to §2's printed
 *    table.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * SPEC-08 §4 and R-10 require a withdrawal after `reflected_in_version` to move
 * the request to `withdrawn` with `revision_requested = true`. **§2's printed
 * matrix has no such cell**, for any subtype, and migration 0021 implemented §2
 * literally — so the edge R-10 needs was refused by the database. That is a
 * SPEC-08 internal conflict, the fourth in the class M5-000b found three of, and
 * it was escalated rather than resolved unilaterally.
 *
 * The resolution is additive and narrows nothing: **one cell**,
 * `reflected_in_version → withdrawn`, for the five NON-vacation subtypes, usable
 * only when the same statement sets `revision_requested`. Migration 0023 carries
 * both halves — the cell and the guard that makes it unusable without the flag.
 *
 * **Why the pairing with R-22 is coherent rather than odd.** Refusal at
 * `consumed_by_build` and permission at the later `reflected_in_version` look
 * inverted until you ask what has been PROMISED. At `consumed_by_build` a solver
 * run has taken the request as input and nothing has been promised to anybody;
 * there is nothing to revise and a live run to protect. At
 * `reflected_in_version` a PUBLISHED version honours the request — a promise
 * exists — and a person asking out of a promise must produce a visible revision
 * request rather than either silence or a refusal. **The published version is
 * never touched** (I-18: a published version is immutable in the database); what
 * the withdrawal produces is a `ScheduleRevisionRequested` event and a scheduler
 * decision.
 *
 * **Vacation is deliberately excluded.** A committed vacation week's undo is
 * §5.6's REVERSAL — `reflected_in_version → reversed`, which §2 already carries
 * and 0021 already permits. Giving vacation the withdrawal cell as well would
 * create two spellings for one act, and §5.3's mapping would then have to say
 * which one a `withdrawn` selection meant.
 */
function withdrawVerdict(subtype: RequestSubtype, from: RequestStatus): OperationVerdict {
  /* ── OPUS-M5-003: `vacation-selection` is withdrawn by the vacation module ──
   *
   * **§2's matrix is NOT narrowed by this branch.** Every vacation withdrawal
   * cell §2 carries stays legal, in the domain matrix and in the database, and
   * `apps/api/test/requests/transition-matrix-agreement.test.ts` still holds the
   * two copies to each other cell by cell. What moves is MODULE OWNERSHIP, not a
   * transition: §5.3's "**One writer.** Only the vacation module updates either
   * status" means a withdrawal must move the SELECTION and the derived root in
   * one transaction, and this operation's writer (`withdrawRequest` in
   * `apps/api/src/requests/service.ts`, through `RequestStore.withdraw`) moves
   * only the root. Reaching it with a vacation request would produce a root the
   * mapping cannot explain, and deferred D-27 would refuse the whole transaction
   * at COMMIT with a message about a mapping rather than about a mistaken caller.
   *
   * The refusal is house-consistent rather than novel: `submitVerdict` above
   * already refuses this subtype with this reason — its root is CREATED at
   * `submitted`, by the vacation writers — and `decisionVerdict` below refuses it
   * through `DECIDABLE_SUBTYPES` on §5.3's one-writer rule verbatim. This is the
   * third face of one rule, and the withdrawal that DOES exist is
   * `selectionOperationVerdict(…, 'withdraw')` in `./vacation-selection.ts`,
   * whose writer moves both rows.
   */
  if (subtype === 'vacation-selection') {
    return { allowed: false, reason: 'operation-not-available-for-subtype' };
  }
  /* The matrix carries FAD-55's cell, so this consults it exactly as the other
   * two operations do. There is deliberately no special case here: an operation
   * that reasoned about `reflected_in_version` on its own would be a second copy
   * of the rule, in the place the agreement test does not look. */
  if (!transitionIsLegal(subtype, from, 'withdrawn')) {
    return { allowed: false, reason: 'operation-not-legal-from-status' };
  }
  return { allowed: true, to: 'withdrawn' };
}

/**
 * **`expire` — V-31's three sources, and nothing else (R-23).**
 *
 * `submitted`, `under_review`, `accepted_as_input`: the undecided states. The
 * superseded spelling was a literal `*`, which as a rule permits
 * `reflected_in_version → expired` — expiring a request a published version
 * already honours — and `approved → expired`, which silently un-decides a
 * decision. Both are R-23's named attempts and both are refused here, by
 * consulting the same matrix the database consults.
 */
function expireVerdict(subtype: RequestSubtype, from: RequestStatus): OperationVerdict {
  if (!transitionIsLegal(subtype, from, 'expired')) {
    return { allowed: false, reason: 'operation-not-legal-from-status' };
  }
  return { allowed: true, to: 'expired' };
}

/* ────────────────────────────────────────────────────────────────────────────
 * OPUS-M5-002 — §4's decisions
 *
 * ## The subtypes a scheduler may decide, and the two that are not on this list
 *
 * §2's `under_review → approved` and `under_review → denied` cells are ✓ for
 * `REVIEWED_SUBTYPES`, which is five: the four non-vacation reviewed subtypes
 * plus `vacation-selection`. This surface decides FOUR of them.
 *
 *  * **`shift-preference` is never approved**, and that is §2.1's design rather
 *    than a restriction on it: a preference is NON-BINDING, so nobody approves or
 *    denies it. It has no `under_review`, no `approved` and no `denied` in its
 *    D-20 domain at all, and its acceptance is `submitted → accepted_as_input`,
 *    which M5-001 already implements. Forcing it through a decision would invent
 *    an approval that does not happen — the exact defect `accepted_as_input`
 *    exists to avoid, and SPEC-08 R-03's named failure.
 *  * **`vacation-selection` is decided somewhere else.** §5.3: "**One writer.**
 *    Only the vacation module updates either status", and §5.4's
 *    `APPROVE-VACATION` is that writer — it consumes a quota unit, guards the
 *    selection on its own version, and writes the derived root status in the same
 *    transaction. A generic decision path reaching a vacation root would be the
 *    second writer §5.3 forbids, and it would move the root without moving the
 *    selection, which D-27 would then refuse at COMMIT with a message about a
 *    mapping rather than about a mistaken caller.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The four subtypes §4's generic decision surface acts on.
 *
 * Derived from `REVIEWED_SUBTYPES` by removing the one §5.3 gives its own
 * writer, rather than listed independently: a second hand-written list is the
 * one that drifts when §2's columns change.
 */
export const DECIDABLE_SUBTYPES: readonly RequestSubtype[] = REVIEWED_SUBTYPES.filter(
  (subtype) => subtype !== 'vacation-selection',
);

/**
 * The statuses a decision may act FROM.
 *
 * `submitted` and `under_review` — the two undecided states a reviewed request
 * can be standing in when a scheduler opens the queue. **Both, and this is the
 * two-step's domain half.**
 *
 * §2 carries no `submitted → approved` cell for any subtype, so a request the
 * queue shows at `submitted` reaches `approved` by way of `under_review`:
 * `submitted → under_review → approved`, two statements inside ONE transaction
 * (M5-000b finding #1, binding). A caller sees one operation; the matrix sees two
 * legal edges; the deferred D-27 mapping trigger, which reads CURRENT rows at
 * commit, never sees the intermediate at all.
 *
 * A request already at `under_review` — moved there by an earlier reviewer, or by
 * a surface this packet does not ship — takes the second edge only.
 */
export const DECIDABLE_FROM_STATUSES: readonly RequestStatus[] = ['submitted', 'under_review'];

/**
 * **The status path a decision walks**, from the row's current status to the
 * decision's terminal status, in order, EXCLUDING the starting status.
 *
 * Returns `null` when the decision is not legal from `from` — which is the same
 * answer `approveVerdict`/`denyVerdict` give, computed the same way, because
 * both consult `transitionIsLegal` rather than either one restating §2.
 *
 * The service writes each element as its own statement, for the reason
 * `test/support/requests.ts`'s seeding walk gives: **each is a separate EDGE and
 * the guard evaluates one edge at a time.** A writer that tried to express the
 * pair as one statement would be writing the spelling §2 refuses.
 */
export function decisionStatusPath(
  subtype: RequestSubtype,
  from: RequestStatus,
  to: RequestStatus,
): readonly RequestStatus[] | null {
  if (transitionIsLegal(subtype, from, to)) return [to];
  /* The one intermediate §2 admits between an undecided state and a decision.
   * Spelled as a search over the matrix rather than as the literal
   * `['under_review', to]`, so a matrix that ever gained or lost the cell
   * changes this answer instead of leaving it stale. */
  if (transitionIsLegal(subtype, from, 'under_review') && transitionIsLegal(subtype, 'under_review', to)) {
    return ['under_review', to];
  }
  return null;
}

/** One decision verdict, shared by `approve` and `deny` — the only difference is `to`. */
function decisionVerdict(
  subtype: RequestSubtype,
  from: RequestStatus,
  to: RequestStatus,
): OperationVerdict {
  if (!DECIDABLE_SUBTYPES.includes(subtype)) {
    return { allowed: false, reason: 'operation-not-available-for-subtype' };
  }
  if (decisionStatusPath(subtype, from, to) === null) {
    return { allowed: false, reason: 'operation-not-legal-from-status' };
  }
  return { allowed: true, to };
}

/**
 * **`approve` — §4's approval, through `under_review`.**
 *
 * Requires the approval capability, which is the ROUTE's question and not this
 * module's: this file decides whether the ROW may move (see the header). §4's
 * "conditional update on `expected_version`; **first decision wins**, the second
 * gets an explicit conflict — never a silent overwrite" is likewise the store's,
 * because a version is a fact about a row rather than about a matrix.
 */
function approveVerdict(subtype: RequestSubtype, from: RequestStatus): OperationVerdict {
  return decisionVerdict(subtype, from, 'approved');
}

/**
 * **`deny` — §4's denial, which carries a MANDATORY reason.**
 *
 * The reason is not a parameter here, and the omission is deliberate: whether a
 * reason was supplied is a question about a COMMAND, not about a row standing in
 * a status, and answering both in one verdict would be a place where a missing
 * reason could be mistaken for an illegal transition. `decisionRequiresReason`
 * in `./decisions.ts` is the reason rule; migration 0024's
 * `approvals_reason_mandatory_where_stated` is its database half.
 *
 * §4's other sentence lands on the ROUTE rather than here: an administrator
 * "withdrawing" for somebody **is** this operation, under this key, with this
 * reason — which is why `requests.own.withdraw` has no ownership override.
 */
function denyVerdict(subtype: RequestSubtype, from: RequestStatus): OperationVerdict {
  return decisionVerdict(subtype, from, 'denied');
}

/**
 * **`reverse_decision` — §4's "a new `approvals` record; the prior decision is
 * never overwritten".**
 *
 * Legal from `approved` only, and it moves the row to `superseded_by_revision` —
 * the one edge §2 carries out of `approved` that is not the requester's
 * withdrawal or a build consuming it.
 *
 * **A DENIAL is not reversible here, and the gap is recorded rather than closed.**
 * §2 gives `denied` no outgoing edge for any subtype, so reversing a denial would
 * need a cell the matrix does not have. §4's reversal sentence does not name a
 * denied-side edge, and a denied request's remedy is a fresh submission under a
 * new idempotency key — so unlike FAD-55, where §4 and R-10 named the missing
 * transition in terms that admitted no other reading, nothing in SPEC-08 requires
 * this one. Inventing it would be the opposite error. Sixth item on the M5 exit
 * sweep's SPEC-08 clarification docket.
 *
 * **The prior decision is untouched by construction**, not by care: migration
 * 0024 grants no runtime role UPDATE or DELETE on `approvals`, so a reversal can
 * only ever be a second row.
 */
function reverseDecisionVerdict(subtype: RequestSubtype, from: RequestStatus): OperationVerdict {
  if (!DECIDABLE_SUBTYPES.includes(subtype)) {
    return { allowed: false, reason: 'operation-not-available-for-subtype' };
  }
  if (from !== 'approved') return { allowed: false, reason: 'operation-not-legal-from-status' };
  if (!transitionIsLegal(subtype, from, 'superseded_by_revision')) {
    return { allowed: false, reason: 'operation-not-legal-from-status' };
  }
  return { allowed: true, to: 'superseded_by_revision' };
}

/**
 * **R-01's cell.** Whether `operation` is legal on a `subtype` request standing
 * in `status`, and where it would move it.
 *
 * The D-20 check comes first and is not redundant: a caller holding a status
 * outside the subtype's domain is holding a row that cannot exist, and answering
 * "the operation is not legal from that status" would describe the wrong problem.
 * The database answers the same way — D-20's CHECK refuses the value before the
 * transition trigger ever sees an edge.
 */
export function operationVerdict(
  subtype: RequestSubtype,
  status: RequestStatus,
  operation: RequestOperation,
): OperationVerdict {
  if (!REQUEST_STATUSES_BY_SUBTYPE[subtype].includes(status)) {
    return { allowed: false, reason: 'status-not-in-subtype-domain' };
  }
  switch (operation) {
    case 'submit':
      return submitVerdict(subtype, status);
    case 'withdraw':
      return withdrawVerdict(subtype, status);
    case 'expire':
      return expireVerdict(subtype, status);
    case 'approve':
      return approveVerdict(subtype, status);
    case 'deny':
      return denyVerdict(subtype, status);
    case 'reverse_decision':
      return reverseDecisionVerdict(subtype, status);
  }
}

/**
 * **Every §2 edge an operation walks, in order, excluding the starting status.**
 *
 * `null` when the operation is not legal from `from`.
 *
 * This exists because R-01's cross-product asserts that *"a permitted operation
 * must land somewhere §2 actually permits — so the operation layer cannot invent
 * an edge the matrix lacks"*, and until OPUS-M5-002 every operation was ONE edge,
 * so `transitionIsLegal(subtype, from, verdict.to)` said exactly that.
 *
 * **The two-step made a one-edge check the wrong question, not a weaker one.** A
 * decision from `submitted` lands on `approved`, and §2 has no
 * `submitted → approved` cell for any subtype — that is M5-000b finding #1, and it
 * is the reason the writer walks `submitted → under_review → approved` inside one
 * transaction. Checking the endpoint alone would fail a correct implementation;
 * checking nothing would let the operation layer invent the very thing the
 * assertion guards against.
 *
 * So the cross-product now asserts EVERY HOP of this path is in §2 and that its
 * last element is the verdict's target. That is strictly stronger than the
 * one-edge check it replaces: it still forbids inventing an edge, and it
 * additionally forbids inventing an intermediate.
 */
export function operationStatusPath(
  subtype: RequestSubtype,
  from: RequestStatus,
  operation: RequestOperation,
): readonly RequestStatus[] | null {
  const verdict = operationVerdict(subtype, from, operation);
  if (!verdict.allowed) return null;
  return operation === 'approve' || operation === 'deny'
    ? decisionStatusPath(subtype, from, verdict.to)
    : [verdict.to];
}

/** `operationVerdict`, reduced to its boolean. For the cross-product tests. */
export function operationIsLegal(
  subtype: RequestSubtype,
  status: RequestStatus,
  operation: RequestOperation,
): boolean {
  return operationVerdict(subtype, status, operation).allowed;
}

/**
 * **R-10's flag.** Whether a withdrawal from `from` requires a schedule revision.
 *
 * True for exactly one source state — `reflected_in_version` — because that is
 * the only state in which a PUBLISHED version already honours the request. A
 * withdrawal from `approved` needs no revision: nothing has been published about
 * it yet.
 *
 * The request row records the answer as `revision_requested`, and the service
 * raises `ScheduleRevisionRequested` through the outbox in the same transaction
 * as the status change. **The published version is not touched** (I-18), and the
 * event is what the scheduler acts on.
 */
export function withdrawalRequiresRevision(from: RequestStatus): boolean {
  return from === 'reflected_in_version';
}
