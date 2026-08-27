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
import type { CommentChannel, RequestReasonCode } from './comments.js';
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
   * **D-7's read side, ROOT ONLY — FU-23's closure** (OPUS-M5-003).
   *
   * `findByIdempotencyKey` above composes two reads: it finds the root, then
   * loads the subtype record, and answers `null` if either misses. For five of
   * the six subtypes those are the same question. For `vacation-selection` they
   * are not: `loadRecord` returns `null` for it BY DESIGN, because §5.3 gives
   * that lifecycle one reader and it is `VacationStore` — so the composition
   * answers "no request holds this key" about a request that does hold it.
   *
   * Harmless while no vacation root could exist. **This packet makes them
   * exist**, and then the composition means: a member holding a vacation request
   * under key `K` who submits a time-off under the same `K` gets `null` from the
   * replay read, proceeds to the insert, and is refused by
   * `UNIQUE (membership_id, idempotency_key, organization_id)` — a bare `23505`
   * conflict standing where a replay answer belongs.
   *
   * This method is the split FU-23's row names. It reads the ROOT and stops,
   * because D-7's uniqueness is a property of the root and of nothing else. Its
   * caller then decides, on the root's own `subtype`, whether this is a genuine
   * replay (load the full request through the reader that subtype has) or a
   * cross-subtype REUSE of one member's key — which is a real conflict, named as
   * such, rather than a database constraint surfacing as an accident.
   *
   * **Per-subtype idempotency namespacing was the row's other exit and is
   * rejected**: D-7 is `UNIQUE (membership_id, idempotency_key,
   * organization_id)`, so namespacing means altering a constraint 0021 declares
   * (this packet is additive), and it would make one key mean different things
   * depending on which body carried it — which is the opposite of what an
   * idempotency key is for.
   */
  findRootByIdempotencyKey(
    uow: UnitOfWork,
    membershipId: string,
    idempotencyKey: string,
  ): Promise<RequestAggregate | null>;

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
   * **Append one comment to `request_comments`** (§4's fifth row, FAD-58,
   * migration 0026).
   *
   * There is no update counterpart and there never will be one, for the reason
   * `recordApproval` gives one method above: `app_runtime` holds SELECT and
   * INSERT on that table and nothing else, so a method that tried to edit or
   * remove a comment would raise `42501` rather than silently succeed. §4's
   * "append-only" is a PRIVILEGE, not a promise, and FAD-58.3's "correction is a
   * new comment" is what a caller does instead.
   *
   * The verb lives on this port rather than on one of its own for the reason
   * `recordApproval` and `listApprovals` do: a comment is a child row of the
   * request aggregate, written in the same unit of work as everything else about
   * that aggregate, and a second port over the same root would be a second place
   * to remember the tenant columns.
   *
   * **`authorMembershipId` is the acting membership, always.** The store fills
   * the tenant columns; the caller supplies the author; and migration 0026's two
   * write policies additionally require the stored author to BE the acting
   * membership, so a caller that passed somebody else's id would be refused by
   * the database rather than believed. §4's "author recorded" is enforced twice
   * and assumed nowhere.
   */
  appendComment(uow: UnitOfWork, comment: NewRequestComment): Promise<string>;

  /**
   * One request's comment thread, OLDEST first.
   *
   * The opposite ordering to `listApprovals`, deliberately: a decision history
   * answers "what is the current decision", so it leads with the newest, and a
   * comment thread answers "how did this conversation go", so it reads from the
   * top.
   *
   * **No membership predicate and no channel filter.** Which rows a caller may
   * see is migration 0026's three policy arms — the ruling being that a comment
   * is visible exactly where the REQUEST it is on is visible, and no wider — and
   * a predicate here would be a second, weaker copy of a control that already
   * holds. Both channels come back together because §4 describes one comment
   * surface; there is no decider-private note class, and creating one would need
   * its own recorded decision.
   */
  listComments(
    uow: UnitOfWork,
    requestId: string,
    limit: number,
  ): Promise<readonly RequestComment[]>;

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

/* ────────────────────────────────────────────────────────────────────────────
 * §4's fifth row — comments (OPUS-M5-00C, FAD-58, migration 0026)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * What a caller supplies to append a comment. The store fills the tenant columns.
 *
 * ## This type is FLAT, and it does NOT make the illegal shapes unrepresentable
 *
 * `channel`, `reasonCode: RequestReasonCode | null` and `body: string | null`
 * are three independent members, so
 * `{ channel: 'requester', reasonCode: 'travel', body: 'prose' }` **compiles.**
 * Proven at review by compiling exactly that value under `tsc --strict`, exit 0.
 *
 * *(An earlier version of this docblock claimed the opposite — "the content is a
 * discriminated union on the channel … the two illegal shapes are not
 * expressible at this boundary at all". That is true of `CommentContent` in
 * `./comments.ts` and it is NOT true of this interface, which does not use it.
 * The sentence is corrected rather than deleted, because a docblock asserting a
 * guarantee the type does not carry is worse than no docblock at all: it is the
 * kind of claim a later reader relies on instead of checking, and this one was
 * caught by a compiler and not by a reader. The shape is deliberately NOT
 * re-worked to match the old claim — this interface's sole caller is the private
 * `append()` in `apps/api/src/requests/comments.ts`, which is reached only
 * through `attachReasonCode` / `appendSchedulerComment`, each of which has
 * already run the content through `commentContentIsWellFormed` and narrowed the
 * union; re-shaping a type to make a comment true is the tail wagging the dog.)*
 *
 * ## Where the guarantee actually lives — three live layers, none of them here
 *
 *  1. **`commentContentIsWellFormed`** (`./comments.ts`) refuses both illegal
 *     shapes with `channel-content-mismatch`, in both directions, and it is what
 *     the two service verbs call before they reach `append()`.
 *  2. **Migration 0026's two CHECKs** —
 *     `request_comments_requester_channel_is_a_code` and
 *     `request_comments_scheduler_channel_is_text`, each written in both
 *     directions — refuse the same two shapes in the DATABASE, on every path,
 *     including one that never touched this module.
 *  3. **Migration 0026's RLS `WITH CHECK` arms** pin the CHANNEL and the AUTHOR
 *     per arm, so a member cannot reach the free-text column by naming the other
 *     channel and a decider cannot attach a code to somebody else's request.
 *
 * Each was proven independently load-bearing by mutation: killing one leaves the
 * others refusing. That is a genuinely stronger position than a compile-time
 * union at this boundary would have been — a type cannot refuse a row that
 * arrives from `psql` — and it is the honest description of what is defended.
 *
 * There is deliberately no `createdAt`: the instant is the database's `now()`,
 * because "author and instant recorded" (FAD-58.2) is worth less if the instant
 * is whatever the caller said it was.
 */
export interface NewRequestComment {
  readonly requestId: string;
  /**
   * The ACTING membership, and migration 0026's write policies require it to be
   * exactly that. See `appendComment` for why the property is enforced twice.
   */
  readonly authorMembershipId: string;
  readonly channel: CommentChannel;
  /** Present exactly on the `requester` channel. FAD-58.1's controlled vocabulary. */
  readonly reasonCode: RequestReasonCode | null;
  /**
   * Present exactly on the `scheduler` channel — bounded administrative text of
   * the `approvals.reason` class.
   *
   * **This value never reaches an audit payload, an outbox payload or a
   * notification** (I-07, non-bypass rules 8 and 9), and neither does
   * `reasonCode` — the second for a ruled reason rather than a mechanical one.
   * `CommentAuditFacts` in `./comments.ts` is the closed set a comment does
   * publish, and it names neither.
   */
  readonly body: string | null;
}

/** A comment, as stored. */
export interface RequestComment extends NewRequestComment {
  readonly id: string;
  readonly createdAt: Date;
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

  /**
   * §5.1's linkage, read from the root: the selection a request carries.
   *
   * `null` when the request is not a `vacation-selection`, or is not visible
   * here. The R-11 replay path needs it (OPUS-M5-003): a replayed submission
   * returns the RECORDED request, and the recorded week is a fact about the
   * stored row rather than about the body that replayed it.
   */
  findSelectionByRequest(
    uow: UnitOfWork,
    requestId: string,
  ): Promise<VacationSelectionRecord | null>;

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

  /* ────────────────────────────────────────────────────────────────────────
   * OPUS-M5-003 — §5's SUBMISSION side (doc 42 §5f Part A)
   *
   * The five verbs above are §5.4's decision. These are the member's half of the
   * same lifecycle, and they are HERE for the same reason
   * `writeDerivedRootStatus` is: §5.3's "**One writer.** Only the vacation module
   * updates either status. No other module writes `requests.status` for a
   * `vacation-selection` row, and the vacation module never writes one without
   * the other."
   *
   * `RequestStore` therefore gains nothing for vacation and keeps its structural
   * inability to write one — its creation union has no vacation member and its
   * `decide`/`withdraw` are reachable only from services that refuse the subtype
   * before calling.
   * ──────────────────────────────────────────────────────────────────────── */

  /**
   * **The vacation ROOT, created at the status 0023 names for this subtype.**
   *
   * A vacation root is born `submitted` — `app_request_initial_status` returns it
   * and `requests_guard_initial_status` refuses anything else — so unlike the
   * five, there is no `draft` to transition out of and no `submit` verb here.
   * That is the same fact `submitVerdict` records in `./lifecycle.ts`.
   *
   * **No subtype record is inserted with it**, and the omission is D-18 working
   * rather than D-18 skipped: the subtype row for this root is the
   * `vacation_selections` row, which already exists in `available` and is LINKED
   * by `linkSelectionToRoot` in the same transaction. D-18's zero-row guard is
   * deferred and counts at commit, by which time there is exactly one.
   *
   * `isLate` is deliberately not a parameter. 0023's creation guard refuses a
   * row BORN with either lifecycle flag true — §3's late marker is a fact about
   * a submission measured against a deadline, and a row created with it has been
   * measured against nothing — so a late-accepted vacation submission sets it
   * with `markRootLate` as a second statement in the same transaction.
   */
  createRoot(
    uow: UnitOfWork,
    command: {
      readonly membershipId: string;
      readonly expiresAt: Date;
      readonly idempotencyKey: string;
      readonly submittedAt: Date;
    },
  ): Promise<string>;

  /**
   * §3's late marker, as the second statement 0023's creation guard forces.
   *
   * Same status, so `app_guard_request_transition`'s early return admits it —
   * "the matrix has no self-edges … stamping `decided_at`, recording
   * `expires_at` after a deadline recomputation, or bumping `version` are all
   * legitimate same-status work", and so is this.
   */
  markRootLate(uow: UnitOfWork, requestId: string): Promise<void>;

  /**
   * **§5.3's `available → pending`, guarded — the submission's second half.**
   *
   * ```
   *   UPDATE vacation_selections
   *      SET request_id = :requestId, status = 'pending', version = version + 1
   *    WHERE id = :selectionId
   *      AND status  = 'available'
   *      AND version = :expectedSelectionVersion
   * ```
   *
   * The guard is R-18/R-19's shape with `available` in place of `pending`, and
   * for the identical reason V-29 gives: an unguarded update lets a second
   * delivery of the same command move a selection that has already moved. Here
   * that would link a SECOND root to a selection that already has one — and the
   * `UNIQUE (request_id, organization_id)` D-18 declares would then refuse the
   * transaction from a long way away from the caller that caused it.
   *
   * `null` means the selection is not `available`, or the version is stale, or it
   * is not visible in this tenant context. One answer for the three, for the
   * X-11 reason this file's header gives.
   */
  linkSelectionToRoot(
    uow: UnitOfWork,
    command: {
      readonly selectionId: string;
      readonly expectedSelectionVersion: number;
      readonly requestId: string;
    },
  ): Promise<number | null>;

  /**
   * **§5.3's `pending | approved → withdrawn`, guarded (R-18, R-19).**
   *
   * `status = :expectedStatus AND version = :expectedSelectionVersion` — the
   * same two predicates §5.4 step 2 carries, and neither is redundant beside the
   * other: the status predicate is what makes a second withdrawal of an already
   * withdrawn selection an explicit refusal rather than a silent second success.
   *
   * The caller names the source status because a withdrawal from `approved`
   * additionally RELEASES the quota unit the approval consumed, and a store verb
   * that inferred which case it was in would be deciding that on its own.
   */
  withdrawSelection(
    uow: UnitOfWork,
    command: {
      readonly selectionId: string;
      readonly expectedSelectionVersion: number;
      readonly expectedStatus: VacationSelectionStatus;
    },
  ): Promise<number | null>;

  /**
   * **§5.3's derived root status for a WITHDRAWAL, same transaction.**
   *
   * Separate from `writeDerivedRootStatus` rather than a path through it: that
   * verb stamps `decided_at`/`decided_by`, and a withdrawal is not a decision —
   * §4 is explicit that an administrator "withdrawing" for somebody is a denial
   * instead, so a withdrawn request that named a decider would be recording the
   * confusion §4 exists to prevent. This one stamps `withdrawn_at`.
   *
   * No `expectedVersion`: the optimistic token for a vacation write is the
   * SELECTION's (V-29), checked by `withdrawSelection` in the same transaction,
   * and the root's version is nobody's to hold because §5.3 gives it one writer.
   * That is the same reasoning `writeDerivedRootStatus`'s first statement records.
   */
  writeRootWithdrawal(
    uow: UnitOfWork,
    command: { readonly requestId: string; readonly withdrawnAt: Date },
  ): Promise<number | null>;

  /**
   * A member's own selections in a group, with the root facts a display needs.
   *
   * **Not ordered by the query.** The order a selection list is PRESENTED in is
   * `compareSelectionsForDisplay` in `./vacation-selection.ts`, which is a stated
   * rule with a matrix test behind it; a second ordering in an `ORDER BY` here
   * would be the copy that drifts, and it would drift in the direction a surface
   * reads. What this returns is a set.
   */
  listSelectionsForMembership(
    uow: UnitOfWork,
    membershipId: string,
  ): Promise<readonly VacationSelectionView[]>;

  /**
   * Every selection in a period, with the same root facts — the scheduler's
   * period-wide view of the round. Unordered, for the reason above.
   */
  listSelectionsInPeriod(
    uow: UnitOfWork,
    periodId: string,
  ): Promise<readonly VacationSelectionView[]>;

  /** The group's vacation periods, newest first. The round a member selects in. */
  listPeriods(uow: UnitOfWork): Promise<readonly VacationPeriod[]>;
}

/**
 * A selection together with the root facts a display needs — **and the root
 * status R-15 derives the displayed status from** (doc 42 §5f).
 *
 * The root status is carried rather than the derived selection status, and that
 * is R-15's whole shape: nothing stores a display status, the surface calls
 * `selectionStatusForRootStatus`, and `vacationStatusPairAgrees` is what a test
 * (and the read model itself) uses to assert the two rows have not come apart.
 * `rootStatus` is `null` only for an `available` selection, which by §5.3 has no
 * root at all.
 */
export interface VacationSelectionView {
  readonly selection: VacationSelectionRecord;
  readonly rootStatus: RequestStatus | null;
  readonly rootVersion: number | null;
  readonly submittedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly isLate: boolean;
}
