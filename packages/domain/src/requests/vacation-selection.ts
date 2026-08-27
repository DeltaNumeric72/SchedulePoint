/**
 * SPEC-08 §5.3 — the SELECTION's own lifecycle, the derived-status mapping in
 * both directions, and the order a selection list is presented in
 * (OPUS-M5-003, doc 42 §5f Part A).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## Three things live here, and they are one subject
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  1. **§5.3's lifecycle as a matrix** — `available → pending → approved →
 *     committed`, with `denied`, `withdrawn`, `expired` and `reversed`.
 *     `./transitions.ts` answers the same question for the ROOT; this answers it
 *     for the authoritative row.
 *  2. **The §5.3 mapping, both ways.** `./subtypes.ts` already carries the
 *     forward table (selection → root) that D-27 enforces. What this adds is the
 *     INVERSE, because R-15 as doc 42 §5f states it is a claim about a DISPLAY:
 *     *"the selection's displayed status is DERIVED from the root's SPEC-08 §2
 *     status by the §5.3 table — never stored separately, never divergent"*.
 *     One table, read in the other direction, is what makes that derivation
 *     possible without a second stored column.
 *  3. **The presentation order**, as a comparator rather than as an accident of
 *     whichever `ORDER BY` a query happened to carry.
 *
 * ## Why the inverse is safe to take at all
 *
 * The forward table is INJECTIVE on the seven statuses that produce a root
 * status — no two selection statuses map to the same root status — so the
 * inverse is a function rather than a choice. `available` maps to nothing (there
 * is no root row yet), and three root statuses in §2's vacation column —
 * `draft`, `under_review` and `superseded_by_revision` — are produced by no
 * selection status at all. Those are the same three migration 0022's header §2
 * records as the declared tension between D-20 and D-27: D-20 admits them and
 * D-27 refuses the row. The inverse returns `null` for them, which is the honest
 * answer and not a silent default.
 *
 * **Injectivity is asserted, not assumed** — `packages/domain/test/requests/
 * vacation-selection.test.ts` proves the round trip in both directions, and
 * `apps/api/test/requests/vacation-status-mapping-agreement.test.ts` proves the
 * same table against the DATABASE's `app_vacation_derived_request_status`.
 *
 * ## Nothing here enforces anything
 *
 * D-27's deferred constraint triggers do (migration 0022 §5), from both sides of
 * the pair, at commit. This module is what a caller consults to know what to
 * write and what a surface consults to know what to show.
 */

import type { RequestStatus, VacationSelectionStatus } from './subtypes.js';
import { VACATION_STATUS_TO_REQUEST_STATUS } from './subtypes.js';
import { transitionIsLegal } from './transitions.js';

/* ────────────────────────────────────────────────────────────────────────────
 * §5.3's lifecycle
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * **§5.3's edges, transcribed from the specification.**
 *
 * §5.3: *"`vacation_selections.status`: `available → pending → approved →
 * committed`, with `denied`, `withdrawn`, and `expired` terminals, plus
 * `reversed`"*; §5.6 names the last one exactly — `committed → reversed`; and
 * doc 09 §2.2's state diagram supplies `approved → withdrawn`
 * (*"withdrawn before commit"*), which §5.3's prose leaves implicit and §2's
 * vacation column carries as `approved → withdrawn`.
 *
 * **Transcribed rather than derived from the root matrix, deliberately.** A
 * derivation would be wrong in a way that is easy to miss: `pending → approved`
 * maps to `submitted → approved`, and §2 has no such cell for any subtype — the
 * root reaches `approved` by the BINDING TWO-STEP through `under_review`
 * (M5-000b finding #1). So the two matrices are related by a PATH, not by a
 * cell, and `selectionEdgeHasRootPath` below is the relation, asserted by test
 * rather than assumed by construction.
 */
export const VACATION_SELECTION_TRANSITIONS: readonly {
  readonly from: VacationSelectionStatus;
  readonly to: VacationSelectionStatus;
}[] = [
  { from: 'available', to: 'pending' },
  { from: 'pending', to: 'approved' },
  { from: 'pending', to: 'denied' },
  { from: 'pending', to: 'withdrawn' },
  { from: 'pending', to: 'expired' },
  { from: 'approved', to: 'committed' },
  { from: 'approved', to: 'withdrawn' },
  { from: 'committed', to: 'reversed' },
];

const SELECTION_EDGES: ReadonlySet<string> = new Set(
  VACATION_SELECTION_TRANSITIONS.map((edge) => `${edge.from}|${edge.to}`),
);

/** Whether §5.3's lifecycle carries this edge. */
export function selectionTransitionIsLegal(
  from: VacationSelectionStatus,
  to: VacationSelectionStatus,
): boolean {
  return SELECTION_EDGES.has(`${from}|${to}`);
}

/**
 * **The root PATH a selection edge implies**, in order, excluding the starting
 * status — or `null` when §2's vacation column carries no path for it.
 *
 * `available → pending` is the one edge with no path at all, and that is not a
 * gap: `available` has no root row, so what the edge produces is the root's
 * CREATION, at the status 0023's `app_request_initial_status` names for this
 * subtype. It returns an empty path, which the caller reads as "create, do not
 * transition".
 *
 * Everything else walks §2. Two hops where a decision is involved (the binding
 * two-step), one hop otherwise. The search is over the matrix rather than a
 * literal list, so a matrix that ever gained or lost a cell changes this answer
 * instead of leaving it stale — the same construction `decisionStatusPath` uses
 * in `./lifecycle.ts`, and for the same reason.
 */
export function selectionEdgeRootPath(
  from: VacationSelectionStatus,
  to: VacationSelectionStatus,
): readonly RequestStatus[] | null {
  if (!selectionTransitionIsLegal(from, to)) return null;

  const fromRoot = VACATION_STATUS_TO_REQUEST_STATUS[from];
  const toRoot = VACATION_STATUS_TO_REQUEST_STATUS[to];
  /* `to` always has a root status: `available` is the only status that maps to
   * null, and no edge enters it. */
  if (toRoot === null) return null;
  /* The creation edge. An empty path, and the emptiness is the instruction. */
  if (fromRoot === null) return [];

  if (transitionIsLegal('vacation-selection', fromRoot, toRoot)) return [toRoot];
  if (
    transitionIsLegal('vacation-selection', fromRoot, 'under_review') &&
    transitionIsLegal('vacation-selection', 'under_review', toRoot)
  ) {
    return ['under_review', toRoot];
  }
  return null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The operations a MEMBER performs on their own selection
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The selection operations this packet implements.
 *
 * `approve`, `deny`, `commit` and `reverse` are deliberately absent, exactly as
 * `REQUEST_OPERATIONS` in `./lifecycle.ts` grew with its implementations:
 * approval and denial are M5-002's `APPROVE-VACATION` and already have their
 * own module; commit and reversal are M5-004's. **The absences are the point** —
 * a list containing a verb nobody has written makes the cross-product assert
 * something about a design that does not exist yet.
 */
export const VACATION_SELECTION_OPERATIONS = ['submit', 'withdraw'] as const;

export type VacationSelectionOperation = (typeof VACATION_SELECTION_OPERATIONS)[number];

/** Why a selection operation was refused. A closed set, for the same reason `./lifecycle.ts`'s is. */
export const VACATION_SELECTION_REFUSAL_REASONS = [
  /** §5.3 carries no such edge from where the selection is standing. */
  'operation-not-legal-from-status',
] as const;

export type VacationSelectionRefusalReason = (typeof VACATION_SELECTION_REFUSAL_REASONS)[number];

export type VacationSelectionVerdict =
  | { readonly allowed: true; readonly to: VacationSelectionStatus }
  | { readonly allowed: false; readonly reason: VacationSelectionRefusalReason };

/**
 * **Whether a member may perform `operation` on a selection standing in
 * `status`**, and where it would move it.
 *
 * As in `./lifecycle.ts`, nothing here decides WHO may act — that is SPEC-06's
 * question, re-evaluated against current state inside the unit of work (I-19).
 * This decides whether the ROW may move.
 *
 * **`withdraw` is legal from `pending` AND from `approved`.** §5.3's prose names
 * only the terminals; doc 09 §2.2's diagram states `approved --> withdrawn:
 * withdrawn before commit` explicitly, and §2's vacation column carries the root
 * edge. The approved case releases the quota unit the approval consumed, which
 * is the write path §5.5 describes for a reversal and which
 * `VacationStore.releaseGrantUnits` already implements. It is NOT §5.6's
 * reversal: that is `committed → reversed`, a different act on a week a
 * published version already carries, and it stays M5-004's.
 */
export function selectionOperationVerdict(
  status: VacationSelectionStatus,
  operation: VacationSelectionOperation,
): VacationSelectionVerdict {
  const to: VacationSelectionStatus = operation === 'submit' ? 'pending' : 'withdrawn';
  if (!selectionTransitionIsLegal(status, to)) {
    return { allowed: false, reason: 'operation-not-legal-from-status' };
  }
  return { allowed: true, to };
}

/** `selectionOperationVerdict`, reduced to its boolean. For the cross-product tests. */
export function selectionOperationIsLegal(
  status: VacationSelectionStatus,
  operation: VacationSelectionOperation,
): boolean {
  return selectionOperationVerdict(status, operation).allowed;
}

/* ────────────────────────────────────────────────────────────────────────────
 * R-15 — the mapping, read in the other direction
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * **The §5.3 table, inverted: the selection status a root status implies.**
 *
 * Built FROM `VACATION_STATUS_TO_REQUEST_STATUS` rather than written out, so
 * there is exactly one table in this repository and the inverse cannot drift
 * from the forward direction by an edit to one of them. A hand-written second
 * table is the copy that goes stale, and here it would go stale in the direction
 * a SURFACE reads — which is the least visible place for it to happen.
 *
 * `undefined` for a root status no selection status produces (`draft`,
 * `under_review`, `superseded_by_revision`, and every status outside the vacation
 * column). `selectionStatusForRootStatus` turns that into an explicit `null`.
 */
const REQUEST_STATUS_TO_VACATION_STATUS: ReadonlyMap<RequestStatus, VacationSelectionStatus> =
  new Map(
    (Object.entries(VACATION_STATUS_TO_REQUEST_STATUS) as [
      VacationSelectionStatus,
      RequestStatus | null,
    ][])
      .filter((entry): entry is [VacationSelectionStatus, RequestStatus] => entry[1] !== null)
      .map(([selection, root]) => [root, selection]),
  );

/**
 * **R-15's derivation.** The selection status a `vacation-selection` root in
 * `status` must be standing in, or `null` when §5.3's mapping produces no such
 * root status.
 *
 * This is what a display consults. **No displayed status is stored anywhere** —
 * not on the root, not on the selection, not in a view — because a stored copy
 * is a third value that can disagree with two rows D-27 already holds together,
 * and §5.3's whole complaint was two statuses with no stated relationship.
 *
 * A `null` here is a genuine finding rather than a rendering problem: it means a
 * vacation root is standing in a status the mapping cannot explain, which D-27
 * refuses at commit. A surface that met one would be looking at a row the
 * database says cannot exist.
 */
export function selectionStatusForRootStatus(
  status: RequestStatus,
): VacationSelectionStatus | null {
  return REQUEST_STATUS_TO_VACATION_STATUS.get(status) ?? null;
}

/**
 * **The agreement R-15 asks for, as a predicate over one pair.**
 *
 * True when the root status is exactly what §5.3 derives from the selection
 * status. Written once and used by the service, by the read model and by the
 * tests, so "the mapping holds" means the same thing in all three.
 */
export function vacationStatusPairAgrees(
  selectionStatus: VacationSelectionStatus,
  rootStatus: RequestStatus | null,
): boolean {
  return VACATION_STATUS_TO_REQUEST_STATUS[selectionStatus] === rootStatus;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The presentation order
 * ──────────────────────────────────────────────────────────────────────────── */

/** The three fields the display order reads, and nothing else about a selection. */
export interface SelectionOrderKey {
  /** A Monday inside the period. The calendar axis the round is presented on. */
  readonly weekStart: string;
  /** The instant the root was submitted, or `null` for a selection with no root. */
  readonly submittedAt: Date | null;
  /** The selection's own id — the stable tiebreak. */
  readonly id: string;
}

/**
 * **The selection list's ORDER, pinned as a rule rather than left to a query.**
 *
 * `weekStart` ascending, then submission instant ascending, then `id` ascending.
 *
 * ## Why the deadline does not lead, although doc 42 §5f suggests it might
 *
 * The packet offers *"deadline, then submission instant, then stable id — or as
 * SPEC-08 §5.3 rules"*, and §5.3 rules nothing: it states a lifecycle and no
 * ordering. So this is a judgment, and it is recorded here rather than only in a
 * report.
 *
 * **Within one vacation round the deadline cannot discriminate.** Every
 * selection in a period is measured against the same group deadline for the same
 * period, so `expires_at` is one value repeated down the list and leading with it
 * would produce whatever the tiebreak produced anyway. What CAN discriminate,
 * and what the surface is actually about, is the WEEK: a vacation round is
 * presented as a calendar of weeks, and ordering it by anything else scrambles
 * the thing the reader came to read.
 *
 * The other two levels are the packet's, unchanged and in its order. Submission
 * instant separates two selections in the same week — which happens on a
 * scheduler's period-wide list, where several members compete for one week — and
 * it puts the earlier claim first, which is the only ordering a person who
 * submitted first would accept. A selection with **no root** (§5.3's `available`)
 * sorts AFTER every submitted one in its week: an unclaimed slot is not
 * competing with a claim, and sorting a `null` first would put the empty row
 * above the people waiting on it.
 *
 * `id` is last and is what makes the order TOTAL. Without it two rows equal on
 * both earlier levels would be returned in whatever order the database found
 * them, and a list that reorders itself between two reads is a list a person
 * cannot use.
 */
export function compareSelectionsForDisplay(a: SelectionOrderKey, b: SelectionOrderKey): number {
  if (a.weekStart !== b.weekStart) return a.weekStart < b.weekStart ? -1 : 1;

  const aAt = a.submittedAt?.getTime() ?? null;
  const bAt = b.submittedAt?.getTime() ?? null;
  if (aAt !== bAt) {
    /* Nulls last, explicitly. `null` compared numerically would sort as 0 and
     * put an unsubmitted selection at the FRONT of its week, above the claims. */
    if (aAt === null) return 1;
    if (bAt === null) return -1;
    return aAt < bAt ? -1 : 1;
  }

  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** `compareSelectionsForDisplay` applied to a list, without mutating the input. */
export function orderSelectionsForDisplay<T extends SelectionOrderKey>(
  selections: readonly T[],
): readonly T[] {
  return [...selections].sort(compareSelectionsForDisplay);
}
