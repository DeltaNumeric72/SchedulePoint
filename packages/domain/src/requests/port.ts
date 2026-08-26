/**
 * The request and vacation store — a PORT, declared here and implemented in
 * `apps/api` (SPEC-08 §1, §5).
 *
 * ## What this is, and what it deliberately is not
 *
 * It is the READ surface plus the two INSERT shapes the aggregate needs, and
 * nothing else. Doc 42 §5b gives this packet the schema, the types and the port
 * SIGNATURES; the lifecycle transactions are later packets and each owns its own
 * verb:
 *
 *   M5-001  submit · withdraw · expire · the §2 matrices' domain half
 *   M5-002  approve · deny · batch · the §5.4 `APPROVE-VACATION` transaction
 *   M5-003  the vacation round, quota vs open mode, selection
 *   M5-004  commit · reverse · the §6 solver projection
 *
 * Declaring `approveVacation` here with no implementation would be worse than
 * leaving it out: a port is a promise that something implements it, and
 * `apps/api/test/architecture` enumerates the registry to catch exactly that.
 *
 * ## Why no method takes a status
 *
 * There is no `setStatus`. Every status change is a transition, transitions are
 * per-subtype (§2), and a port method that took a status would be a way to move
 * a request without consulting the matrix — with the database's trigger as the
 * only thing left objecting. The transition verbs land with the packets that own
 * the matrices.
 */

import type { UnitOfWork } from '../ports/unit-of-work.js';

import type {
  Request,
  RequestAggregate,
  NewRequestSubtypeRecord,
  VacationApprovalCommand,
  VacationGrant,
  VacationPeriod,
  VacationSelectionRecord,
} from './records.js';
import type { RequestDecision } from './decisions.js';
import type {
  RequestStatus,
  RequestSubtype,
  VacationApprovalOutcome,
  VacationSelectionStatus,
} from './subtypes.js';

/**
 * What a caller supplies to create a request: the root's caller-owned fields and
 * the one subtype record, together.
 *
 * **Together is the point.** D-18's zero-row half is a deferred constraint
 * trigger evaluated at commit, so a store that let a caller insert a root now
 * and a record later would be handing out a transaction that aborts at the end
 * for a reason a long way from where it was caused. One argument, one insert
 * pair, one unit of work.
 */
export interface NewRequest {
  readonly membershipId: string;
  readonly subtype: RequestSubtype;
  /**
   * Server-computed (§3). The port takes it rather than computing it because
   * this package has no clock and no access to the group's policy — both are
   * `apps/api`'s, and M5-001 owns the computation.
   */
  readonly expiresAt: Date;
  readonly idempotencyKey: string;
  /**
   * Must carry the same `subtype` as the root. The composite foreign key
   * refuses the mismatch in the database; this field's type does not, because
   * the discriminator lives on both halves and TypeScript will not relate them
   * without a generic that buys nothing an implementation cannot already check.
   *
   * **`requestId` is absent** (OPUS-M5-001). The id does not exist when a caller
   * builds this argument — `create` inserts the root and then the record — so a
   * required `requestId` here was a field the implementation had to ignore, and
   * a caller who filled it in meaningfully would have been silently overruled.
   * See `NewRequestSubtypeRecord` in `./records.ts`.
   */
  readonly record: NewRequestSubtypeRecord;
}

/** What a caller supplies to record a vacation selection before submission. */
export interface NewVacationSelection {
  readonly membershipId: string;
  readonly vacationPeriodId: string;
  /** A Monday inside the period; the database enforces both. */
  readonly weekStart: string;
}

/**
 * The store.
 *
 * Every method takes the `UnitOfWork` explicitly rather than closing over one.
 * That is I-15 made visible at the type level: there is no way to reach this
 * store outside a unit of work, so there is no way to reach these tables outside
 * transaction-local tenant context, where RLS returns zero rows.
 */
export interface RequestStore {
  /** The root and its one subtype record, or `null` if it is not visible here. */
  load(uow: UnitOfWork, requestId: string): Promise<Request | null>;

  /** The root alone, for a caller that already knows the subtype record. */
  loadRoot(uow: UnitOfWork, requestId: string): Promise<RequestAggregate | null>;

  /**
   * D-7's read side: has this member already used this key?
   *
   * The idempotent submission path (R-11) asks this before it writes, and the
   * `UNIQUE (membership_id, idempotency_key)` constraint is what makes the
   * answer binding when two callers ask at once.
   */
  findByIdempotencyKey(
    uow: UnitOfWork,
    membershipId: string,
    idempotencyKey: string,
  ): Promise<Request | null>;

  /**
   * Creates the root and its subtype record in one unit of work, returning the
   * new request id.
   */
  create(uow: UnitOfWork, request: NewRequest): Promise<string>;

  /** A member's requests in a group, newest first. */
  listForMembership(uow: UnitOfWork, membershipId: string): Promise<readonly Request[]>;

  /* ────────────────────────────────────────────────────────────────────────
   * OPUS-M5-001 — the transition verbs this port reserved by name
   *
   * This file's header said the transition verbs "land with the packets that own
   * the matrices", and named M5-001's as "submit · withdraw · expire · the §2
   * matrices' domain half". These are they.
   *
   * **There is still no `setStatus`.** The header's reason is unchanged and is
   * the reason these three are separate verbs rather than one parameterised one:
   * a method that took a status would be a way to move a request without
   * consulting the matrix, with the database's trigger as the only thing left
   * objecting. Each verb below moves the row along ONE known edge, and the
   * service checks the domain matrix before calling it — R-01's two layers, in
   * that order.
   *
   * Every one takes `expectedVersion`. §4's rule is stated for decisions
   * ("conditional update on `expected_version`; **first decision wins**, the
   * second gets an explicit conflict — never a silent overwrite") and it is not
   * weaker for a withdrawal: two tabs open on the same request must not both
   * succeed, and the loser must be told rather than overwritten. A zero-row
   * result is a conflict, never a silent success.
   * ──────────────────────────────────────────────────────────────────────── */

  /**
   * `draft → submitted` (§3's submission).
   *
   * `expiresAt` and `isLate` are computed SERVER-SIDE by the caller from the
   * group's policy — this port takes them because `packages/domain` has neither
   * a clock nor access to the group's row, exactly as `NewRequest.expiresAt`
   * already records.
   *
   * Returns the new version, or `null` when the conditional update matched no
   * row — a stale `expectedVersion`, a row that has already moved, or a row this
   * tenant context cannot see. The three are deliberately one answer: telling
   * them apart across a tenancy boundary is the disclosure X-11 exists to close.
   */
  submit(
    uow: UnitOfWork,
    command: {
      readonly requestId: string;
      readonly expectedVersion: number;
      readonly expiresAt: Date;
      readonly isLate: boolean;
      readonly submittedAt: Date;
    },
  ): Promise<number | null>;

  /**
   * `… → withdrawn` (§4). **Requester-initiated only** — the port does not
   * enforce that and says so: WHO may withdraw is SPEC-06's question, answered
   * by the route's `ownershipRequired: true` with no override. This verb answers
   * only "may the row move".
   *
   * `revisionRequested` is R-10's flag and is `true` for exactly one source
   * state, `reflected_in_version`. Migration 0023's guard refuses the pairing in
   * either wrong direction, so a caller that computed it incorrectly is refused
   * rather than believed.
   */
  withdraw(
    uow: UnitOfWork,
    command: {
      readonly requestId: string;
      readonly expectedVersion: number;
      readonly withdrawnAt: Date;
      readonly revisionRequested: boolean;
    },
  ): Promise<number | null>;

  /**
   * `submitted | under_review | accepted_as_input → expired` (§3's sweeper).
   *
   * No `expectedVersion`: the sweeper claims its rows with `FOR UPDATE SKIP
   * LOCKED` and expires what it holds, so there is no read-then-write window for
   * a version to close. Passing one would be theatre — the row cannot have moved
   * between the claim and the write.
   */
  expire(
    uow: UnitOfWork,
    command: { readonly requestId: string; readonly expiredAt: Date },
  ): Promise<number | null>;

  /**
   * The sweeper's working set: undecided requests whose deadline has passed,
   * claimed for update.
   *
   * `limit` bounds one sweep. A sweeper that tried to expire every overdue
   * request in one transaction would hold locks proportional to how long nobody
   * ran it, which is exactly backwards — the longer the outage, the more damage
   * the recovery does.
   */
  claimExpirable(
    uow: UnitOfWork,
    now: Date,
    limit: number,
  ): Promise<readonly RequestAggregate[]>;

  /* ────────────────────────────────────────────────────────────────────────
   * OPUS-M5-002 — §4's decisions, and the queue that shows them
   *
   * This file's header names M5-002's verbs as "approve · deny · batch · the
   * §5.4 `APPROVE-VACATION` transaction". These are the request-side three; the
   * vacation transaction's verbs are on `VacationStore` below, where §5.3's ONE
   * WRITER rule puts them.
   *
   * **There is still no `setStatus`**, and `decide` is not one wearing a hat.
   * It moves a row along ONE named operation — §4's decision — and the caller
   * supplies the path because the number of EDGES depends on where the row is
   * standing, which is a question for the matrix (`decisionStatusPath` in
   * `./lifecycle.ts`) and not for a store. A store that computed the path itself
   * would be a third copy of §2, in the place no test compares to anything.
   * ──────────────────────────────────────────────────────────────────────── */

  /**
   * **§4's decision, and M5-000b finding #1's two-step.**
   *
   * `path` is the ordered list of statuses to walk, EXCLUDING the row's current
   * one — `['under_review', 'approved']` from `submitted`, `['approved']` from
   * `under_review`. Each element is written as its own statement, because each
   * is a separate EDGE and 0021's transition guard evaluates one edge at a time.
   * A single statement spelling `submitted → approved` is refused by §2's own
   * matrix, which is the finding this parameter exists to honour.
   *
   * The FIRST statement carries `expectedVersion`; §4's rule is "conditional
   * update on `expected_version`; **first decision wins**, the second gets an
   * explicit conflict — never a silent overwrite". Returns the final version, or
   * `null` when any statement in the walk matched no row — a stale version, a
   * row that has already moved, or a row this tenant context cannot see. One
   * answer for the three, for the X-11 reason the header gives.
   *
   * `decidedAt`/`decidedBy` are stamped on the LAST statement, so a row is never
   * momentarily "decided by somebody, status under review".
   */
  decide(
    uow: UnitOfWork,
    command: {
      readonly requestId: string;
      readonly expectedVersion: number;
      readonly path: readonly RequestStatus[];
      readonly decidedBy: string;
      readonly decidedAt: Date;
    },
  ): Promise<number | null>;

  /**
   * **§4's reversal — `approved → superseded_by_revision`.**
   *
   * A separate verb rather than `decide` with a different path, because a
   * reversal is a different ACT: it takes something back that a person was told
   * they had, it requires a mandatory reason, and it writes a second `approvals`
   * row pointing at the first. Collapsing the two would make "was this approved
   * and then reversed, or approved by somebody who then denied it" a question
   * about a path array.
   */
  reverseDecision(
    uow: UnitOfWork,
    command: {
      readonly requestId: string;
      readonly expectedVersion: number;
      readonly reversedAt: Date;
      readonly reversedBy: string;
    },
  ): Promise<number | null>;

  /**
   * Append one decision to `approvals` (§4, migration 0024).
   *
   * There is no update counterpart and there never will be one: no runtime role
   * holds UPDATE or DELETE on that table, so "the prior decision is never
   * overwritten" is a privilege rather than a promise. A reversal is a second
   * call to this method naming `supersedesApprovalId`.
   */
  recordApproval(uow: UnitOfWork, approval: NewApproval): Promise<string>;

  /** Every decision made about one request, newest first. §4's history. */
  listApprovals(uow: UnitOfWork, requestId: string): Promise<readonly Approval[]>;

  /**
   * **The scheduler's pending-review queue** (doc 42 §5d Part C).
   *
   * Undecided requests in the acting context's group, oldest first — a queue is
   * worked from the front, and a scheduler who sorts newest-first is a scheduler
   * whose oldest request ages forever.
   *
   * `subtypes` and `statuses` narrow it; an empty filter means "every undecided
   * request", which is what a queue opens on. **There is no `membershipId`
   * filter and no group parameter**: the group is the unit of work's own context
   * and RLS scopes the rows to it, so a filter would be a second, weaker copy of
   * a control that already holds. Which rows this caller may see at all is
   * `requests.read_any`'s question, answered by migration 0023's policy.
   */
  listPendingReview(
    uow: UnitOfWork,
    filter: {
      readonly subtypes?: readonly RequestSubtype[];
      readonly statuses?: readonly RequestStatus[];
      readonly limit: number;
    },
  ): Promise<readonly Request[]>;
}

/** What a caller supplies to append a decision. The store fills the tenant columns. */
export interface NewApproval {
  readonly requestId: string;
  readonly decision: RequestDecision;
  readonly decidedBy: string;
  readonly decidedAt: Date;
  /**
   * §4/§5.5's mandatory reason, or `null` for an ordinary approval.
   *
   * **This value never reaches an audit payload, an outbox payload or a
   * notification** (I-07, non-bypass rules 8 and 9). It is stored on this row and
   * read back only through `listApprovals`, whose callers are the queue's detail
   * read and the requester's own view of their decision.
   */
  readonly reason: string | null;
  readonly isOverride: boolean;
  /** The selection a vacation decision decided, or `null` for the other subtypes. */
  readonly vacationSelectionId: string | null;
  /** The approval a REVERSAL supersedes. `null` for an approval or a denial. */
  readonly supersedesApprovalId: string | null;
}

/** A decision, as stored. */
export interface Approval extends NewApproval {
  readonly id: string;
}

/** The vacation round's own store — §5's tables, which the root does not carry. */
export interface VacationStore {
  loadPeriod(uow: UnitOfWork, periodId: string): Promise<VacationPeriod | null>;

  /**
   * The grants for a period. **Empty in `open` mode, and that is not an error**
   * — V-30: open mode has no `vacation_grants` rows at all, and the previous
   * design's unconditional grant update is precisely why open-mode approval
   * always failed. A caller that treats "no grants" as "quota exhausted" is
   * reintroducing that defect.
   */
  listGrants(uow: UnitOfWork, periodId: string): Promise<readonly VacationGrant[]>;

  loadSelection(uow: UnitOfWork, selectionId: string): Promise<VacationSelectionRecord | null>;

  /** D-22's read side: one selection per (membership, period, week). */
  findSelection(
    uow: UnitOfWork,
    membershipId: string,
    periodId: string,
    weekStart: string,
  ): Promise<VacationSelectionRecord | null>;

  /** Records a selection in `available` — no request row yet (§5.3). */
  createSelection(uow: UnitOfWork, selection: NewVacationSelection): Promise<string>;

  /**
   * D-26's read side: the recorded outcome of an approval command, if this
   * `(selection, key)` pair has been seen.
   *
   * A replay returns what the first attempt recorded and consumes nothing. The
   * `UNIQUE (selection_id, approval_idempotency_key)` constraint is what makes
   * that binding under concurrency; this is how the winner's answer is found.
   */
  findApprovalCommand(
    uow: UnitOfWork,
    selectionId: string,
    approvalIdempotencyKey: string,
  ): Promise<VacationApprovalCommand | null>;

  /**
   * Every selection in a period with a given status — the round's working set.
   *
   * Named with the status rather than returning all of them because the two
   * callers that matter (§5.5's mode-change check and the round's variance
   * display) each want one status class, and the database has a partial-friendly
   * index for it.
   */
  listSelectionsByStatus(
    uow: UnitOfWork,
    periodId: string,
    status: VacationSelectionStatus,
  ): Promise<readonly VacationSelectionRecord[]>;

  /* ────────────────────────────────────────────────────────────────────────
   * OPUS-M5-002 — §5.4's `APPROVE-VACATION`, step by step
   *
   * Five verbs, in the order §5.4 prints them, and each one is exactly one
   * statement. That is deliberate: §5.4's correctness is entirely in WHICH
   * statement runs and in what its `WHERE` clause says, so a port that offered
   * one `approveVacation(...)` method would hide the very thing V-29 and V-30
   * fixed and would put the transaction's shape somewhere no test could examine
   * an edge of it.
   *
   * §5.3's "**One writer** — only the vacation module updates either status" is
   * what puts them HERE rather than on `RequestStore`, including
   * `writeDerivedRootStatus`: the vacation module writes both statuses, in the
   * same transaction, and the request store has no verb that could write the
   * root of a `vacation-selection` at all.
   * ──────────────────────────────────────────────────────────────────────── */

  /**
   * **Step 0 — D-26's idempotency, before any effect.**
   *
   * `INSERT … ON CONFLICT (selection_id, approval_idempotency_key) DO NOTHING`.
   * Returns the new command's id when the row was inserted, and `null` when it
   * was not — which is a REPLAY, and §5.4's own instruction for that case is
   * exact: "return the recorded outcome, **consume no unit, emit no event, write
   * no approval row**".
   *
   * The unique constraint is what makes the answer binding under concurrency.
   * `findApprovalCommand` is how the winner's recorded outcome is then read.
   */
  recordApprovalCommand(
    uow: UnitOfWork,
    command: {
      readonly selectionId: string;
      readonly approvalIdempotencyKey: string;
    },
  ): Promise<string | null>;

  /**
   * **Step 1 (quota mode only) — consume one unit under D-21's raised bound.**
   *
   * ```
   *   UPDATE vacation_grants
   *      SET units_consumed = units_consumed + 1, version = version + 1
   *    WHERE id = :grantId
   *      AND version = :expectedVersion
   *      AND units_consumed < units_total + override_units
   * ```
   *
   * Returns the new version, or `null` when the update matched nothing — which
   * is `QUOTA_EXHAUSTED` **or** `VERSION_CONFLICT`, and the caller distinguishes
   * them by re-reading the row. **The predicate is the arbiter of R-05's race**:
   * two concurrent approvals for the last unit both pass a pre-check, and
   * exactly one of them passes this `WHERE`. The unconditional CHECK is what
   * makes it true on paths that never ran this method.
   *
   * `open` mode never calls this. V-30: there are no `vacation_grants` rows at
   * all, the previous unconditional update matched zero of them, and §5.4
   * defined zero rows as `QUOTA_EXHAUSTED` — which is why open-mode approval
   * always failed.
   */
  consumeGrantUnit(
    uow: UnitOfWork,
    command: { readonly grantId: string; readonly expectedVersion: number },
  ): Promise<number | null>;

  /**
   * **§5.5's audited override — raise the BOUND, in the same transaction.**
   *
   * `UPDATE vacation_grants SET override_units = override_units + :units`. The
   * invariant is never suspended: `CHECK (units_consumed <= units_total +
   * override_units)` still holds at every instant, and what has changed is the
   * right-hand side. Every relaxation is therefore a visible, audited row **on
   * the grant itself**, which is what V-28 replaced the unimplementable
   * "relaxed only on the override path" with.
   *
   * Returns the new version, or `null` on a stale one.
   */
  raiseOverrideUnits(
    uow: UnitOfWork,
    command: {
      readonly grantId: string;
      readonly expectedVersion: number;
      readonly units: number;
    },
  ): Promise<number | null>;

  /**
   * **Step 2 — the GUARDED selection update (V-29).**
   *
   * ```
   *   UPDATE vacation_selections
   *      SET status = :status, grant_id = :grantId, version = version + 1, …
   *    WHERE id = :selectionId
   *      AND status  = 'pending'
   *      AND version = :expectedSelectionVersion
   * ```
   *
   * Both guards are V-29's fix and neither is redundant. Before them the update
   * ran unconditionally — no `status` predicate, and the version checked was the
   * GRANT's — so a duplicate approval, a retry after an ambiguous response, or an
   * approval of an already-withdrawn selection consumed a SECOND quota unit,
   * inside the transaction whose purpose is correct quota accounting.
   *
   * `null` means `SELECTION_NOT_PENDING` (R-18, R-19). The caller rolls the whole
   * transaction back, so a unit consumed at step 1 is released with it: **no unit
   * is ever consumed without an approval, and no approval ever consumes two.**
   *
   * `grantId` is `null` in open mode (V-30), and that is the recorded fact rather
   * than a missing one.
   */
  decideSelection(
    uow: UnitOfWork,
    command: {
      readonly selectionId: string;
      readonly expectedSelectionVersion: number;
      readonly status: VacationSelectionStatus;
      readonly grantId: string | null;
      readonly isOverride: boolean;
      readonly overrideReason: string | null;
      readonly approvalIdempotencyKey: string;
    },
  ): Promise<number | null>;

  /**
   * **Step 3 — §5.3's derived root status, in the SAME transaction.**
   *
   * `path` is the ordered list of root statuses to walk, and for a vacation
   * decision it is always TWO — `['under_review', 'approved']` or
   * `['under_review', 'denied']`. §5.4 prints one statement; §2 carries no
   * `submitted → approved` cell, so the printed spelling is refused by the
   * database and the two-step is the implementable writer (M5-000b finding #1,
   * binding on this packet).
   *
   * D-27's deferred constraint trigger reads CURRENT rows at COMMIT, so the
   * intermediate `under_review` — a status §5.3's mapping never produces — is
   * never seen by it. **Deferred D-27 is load-bearing for §5.4's
   * implementability**, and a non-deferred copy would make the transaction
   * impossible to write at all.
   *
   * Returns the new root version, or `null` if any step matched no row.
   */
  writeDerivedRootStatus(
    uow: UnitOfWork,
    command: {
      readonly requestId: string;
      readonly path: readonly RequestStatus[];
      readonly decidedBy: string;
      readonly decidedAt: Date;
    },
  ): Promise<number | null>;

  /** §5.4's last statement: stamp the ledger row with what the transaction decided. */
  setApprovalCommandOutcome(
    uow: UnitOfWork,
    command: { readonly commandId: string; readonly outcome: VacationApprovalOutcome },
  ): Promise<void>;

  /**
   * **§5.5's reversal write path (R-08, R-20).**
   *
   * Decrements `units_consumed` **and** `override_units` together, so the bound
   * returns to its pre-override value and an override cannot silently persist as
   * headroom for a later approval. The floor is `CHECK (units_consumed >= 0)`,
   * unconditional and applying on every path including this one — a reversal that
   * would go below zero is rejected as a data error rather than clamped.
   *
   * `countersAfterReversal` in `./vacation-approval.ts` is the same arithmetic as
   * a pure function, and the two are asserted to agree.
   */
  releaseGrantUnits(
    uow: UnitOfWork,
    command: {
      readonly grantId: string;
      readonly expectedVersion: number;
      readonly units: number;
      readonly overrideUnits: number;
    },
  ): Promise<number | null>;
}
