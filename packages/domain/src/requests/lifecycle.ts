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
 * | `approve` / `deny` | **M5-002** | absent, deliberately |
 * | `consume` / `reflect` / `mark_unsatisfied` | M5-004 | absent, deliberately |
 *
 * **The absences are the point.** A `REQUEST_OPERATIONS` list containing
 * `approve` with no implementation would make the cross-product test assert
 * something about a verb nobody has written, and the first person to write it
 * would find a matrix already deciding their design. The list grows with its
 * implementations, exactly as `packages/domain/src/requests/port.ts` says the
 * store's verbs do.
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
import { transitionIsLegal } from './transitions.js';

/* ────────────────────────────────────────────────────────────────────────────
 * The operations
 * ──────────────────────────────────────────────────────────────────────────── */

/** The lifecycle operations this packet implements. See the header on absences. */
export const REQUEST_OPERATIONS = ['submit', 'withdraw', 'expire'] as const;

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
  }
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
