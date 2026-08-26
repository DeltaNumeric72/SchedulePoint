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
import type { RequestSubtype, VacationSelectionStatus } from './subtypes.js';

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
}
