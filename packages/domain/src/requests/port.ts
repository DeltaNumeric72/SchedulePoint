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
  RequestSubtypeRecord,
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
   */
  readonly record: RequestSubtypeRecord;
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
