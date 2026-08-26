import {
  deadlineBindsInStatus,
  initialRequestStatus,
  operationVerdict,
  withdrawalRequiresRevision,
  type CalendarDate,
  type Request,
  type RequestAggregate,
  type NewRequestSubtypeRecord,
  type RequestSubtype,
  type SubmissionTiming,
  type UnitOfWork,
} from '@schedulepoint/domain';
import type { Kysely } from 'kysely';

import { recordAuditEvent } from '../audit/recorder.js';
import type { Database } from '../db/schema.js';
import { publishOutboxEvent } from '../outbox/publisher.js';

import {
  classifyAt,
  deadlineFor,
  deadlineInstant,
  loadGroupDeadlineContext,
  type GroupDeadlineContext,
} from './deadlines.js';
import { requestStore } from './store.js';

/**
 * The request lifecycle service — SPEC-08 §§2–4 (OPUS-M5-001, doc 42 §5c
 * Parts A, B and C).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## R-01's two layers, in this order, every time
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every operation below does the same three things in the same sequence:
 *
 *   1. **ask the DOMAIN** whether the operation is legal on this
 *      (subtype × status) — `operationVerdict`, from the §2 matrices;
 *   2. **re-validate the deadline** (§3: "Re-validated at every transition. Not
 *      only at submission");
 *   3. **write through the store**, where the DATABASE asks the same question
 *      again in `app_guard_request_transition` and refuses it independently.
 *
 * Step 1 is what lets a refusal say why. Step 3 is what makes the refusal true
 * of every writer, including one nobody has written yet. **Neither is a spare
 * copy of the other**, and the agreement between them is asserted by test rather
 * than assumed.
 *
 * ## Nothing here decides WHO may act
 *
 * Authorization is evaluated per request against current state inside the same
 * unit of work as the mutation (I-19, SPEC-06 §7), by the route and the job
 * handler. This service is handed a unit of work whose context is already
 * verified, and it decides whether the ROW may move. §4's
 * "**Requester-initiated only**" is enforced by the route's
 * `ownershipRequired: true` with no ownership override — an administrator
 * "withdrawing" for somebody is a DENIAL with a reason, which is a different
 * operation with a different key and belongs to M5-002.
 *
 * ## I-11 — a notification failure never rolls back a domain change
 *
 * Every notification here goes through the OUTBOX, in the same transaction as
 * the domain write. The row commits with the change or with neither; the
 * DELIVERY happens afterwards, from a dispatcher that cannot reach back into
 * this transaction. There is no path in this file where a send failure could
 * undo an expiry or a withdrawal.
 *
 * ## I-07 — payloads carry identifiers and tokens only
 *
 * No audit or outbox payload below carries a date, a reason, or any free text.
 * The recorder enforces it before any statement issues, and this service does
 * not test that boundary: it passes ids, subtypes and statuses, all of which are
 * closed vocabularies or uuids. **There is no `reason` field anywhere in this
 * packet** — withdrawal is requester-initiated and needs none, and §4's denial
 * reason is M5-002's, where the I-07 posture question for bounded free text
 * already lives.
 */

type Uow = UnitOfWork<Kysely<Database>>;

/* ────────────────────────────────────────────────────────────────────────────
 * Outcomes
 * ──────────────────────────────────────────────────────────────────────────── */

/** Why an operation did not happen. A closed set: a caller must be able to branch. */
export type RequestFailure =
  /** The row is not visible in this tenant context, or does not exist. One answer. */
  | { readonly kind: 'not-found' }
  /** The domain matrix refuses this operation from this status (R-22, R-23). */
  | {
      readonly kind: 'illegal-operation';
      readonly status: RequestAggregate['status'];
      readonly reason: string;
    }
  /** The conditional update matched nothing: somebody else moved first. */
  | { readonly kind: 'conflict' }
  /** §3: the group's window is shut, or this submission is late and policy rejects it. */
  | {
      readonly kind: 'deadline';
      readonly detail: 'window-closed' | 'late-rejected';
      /** The effective deadline, STATED — §3 requires the refusal to carry it. */
      readonly effective: CalendarDate | null;
    };

export type RequestOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: RequestFailure };

const fail = <T>(failure: RequestFailure): RequestOutcome<T> => ({ ok: false, failure });
const succeed = <T>(value: T): RequestOutcome<T> => ({ ok: true, value });

/* ────────────────────────────────────────────────────────────────────────────
 * Submission — R-11, §3
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The five subtypes this packet submits.
 *
 * Derived from the record union rather than listed, so it cannot drift from what
 * the store can actually write: `NewRequestSubtypeRecord` excludes
 * `vacation-selection` because §5.3's `available` selection has no root row, and
 * that exclusion is doc 42 §5c's "nothing here writes `vacation_selections`"
 * expressed in the type system.
 */
export type SubmittableSubtype = NewRequestSubtypeRecord['subtype'];

export interface SubmitCommand {
  readonly membershipId: string;
  readonly subtype: SubmittableSubtype;
  readonly record: NewRequestSubtypeRecord;
  readonly idempotencyKey: string;
  /** The schedule period the request is for, when the caller has one. */
  readonly periodStart: CalendarDate | null;
  readonly now: Date;
}

export interface SubmitResult {
  readonly request: Request;
  /** `true` when this call found an existing row rather than creating one (R-11). */
  readonly replayed: boolean;
  readonly isLate: boolean;
}

/**
 * **Create and submit, idempotently (D-7, R-11).**
 *
 * ## Why creation and submission are one call and two statements
 *
 * The initial-INSERT ruling makes `draft` the only status a row is born at, and
 * submission a TRANSITION. That is a statement about the DATABASE, not about the
 * API: a staff member pressing Submit performs one action and I-10 requires it
 * to produce one request. So this method inserts at `draft` and transitions to
 * `submitted` **inside one unit of work** — one action, one request, one
 * transaction, and a row that was never visible to anybody in `draft`.
 *
 * It also keeps the §5.4 finding honoured from the other side: nothing here
 * assumes a single-statement root transition. The pair is two statements in one
 * transaction, which is exactly the shape M5-002's two-step writer needs.
 *
 * ## R-11 — the same key twice yields one row
 *
 * The read comes first and the `UNIQUE (membership_id, idempotency_key,
 * organization_id)` constraint arbitrates when two callers race it. A duplicate
 * returns the EXISTING request with `replayed: true` and writes nothing — no
 * second row, no second audit event, no second notification. A replay that
 * emitted an event would make "how many times did this person submit" unanswerable.
 *
 * ## §3, and the refusal that states the deadline
 *
 * The deadline is computed server-side from the group's policy. A client value
 * is never consulted — there is no parameter for one, which is the strongest
 * form of "a client-side deadline is not a deadline". A late submission is
 * refused WITH the effective deadline when policy is `reject`, or accepted with
 * `is_late = true` when policy is `accept_as_late`. Configured, never implicit.
 */
export async function submitRequest(
  uow: Uow,
  command: SubmitCommand,
): Promise<RequestOutcome<SubmitResult>> {
  const existing = await requestStore.findByIdempotencyKey(
    uow,
    command.membershipId,
    command.idempotencyKey,
  );
  if (existing !== null) {
    return succeed({ request: existing, replayed: true, isLate: existing.root.isLate });
  }

  const deadlineContext = await loadGroupDeadlineContext(uow);
  if (deadlineContext === null) return fail({ kind: 'not-found' });

  const timing = classifyAt(deadlineContext, command.periodStart, command.now);
  const refusal = refuseOnTiming(timing);
  if (refusal !== null) return fail(refusal);

  const expiresAt = expiryInstant(deadlineContext, command.periodStart, command.now);
  const isLate = timing.kind === 'late-accepted';

  /* Created at the subtype's initial status — the store takes no status
   * parameter, and migration 0023's guard refuses any other. Asserted here as
   * well, because a service that silently depended on a default would not notice
   * the day the default changed. */
  if (initialRequestStatus(command.subtype) !== 'draft') {
    return fail({
      kind: 'illegal-operation',
      status: 'draft',
      reason: 'operation-not-available-for-subtype',
    });
  }

  const requestId = await requestStore.create(uow, {
    membershipId: command.membershipId,
    subtype: command.subtype,
    expiresAt,
    idempotencyKey: command.idempotencyKey,
    record: command.record,
  });

  const verdict = operationVerdict(command.subtype, 'draft', 'submit');
  if (!verdict.allowed) {
    return fail({ kind: 'illegal-operation', status: 'draft', reason: verdict.reason });
  }

  const version = await requestStore.submit(uow, {
    requestId,
    expectedVersion: 1,
    expiresAt,
    isLate,
    submittedAt: command.now,
  });
  if (version === null) return fail({ kind: 'conflict' });

  const audit = await recordAuditEvent(uow, {
    eventName: 'requests.request.submitted',
    subjectType: 'request',
    subjectId: requestId,
    /* Keys are camelCase identifiers and values are tokens — `AUDIT_PAYLOAD`'s
     * closed shape (I-07), asserted by `assertClosedAuditPayload` before any
     * statement issues. No date, no reason, no free text anywhere below. */
    payload: {
      subtype: command.subtype,
      isLate,
      requestId,
    },
  });
  await publishOutboxEvent(uow, audit, {
    kind: 'requests.request.submitted',
    idempotencyKey: `request-submitted:${requestId}`,
    payload: { requestId, subtype: command.subtype },
  });

  const created = await requestStore.load(uow, requestId);
  if (created === null) return fail({ kind: 'not-found' });
  return succeed({ request: created, replayed: false, isLate });
}

/** §3's refusals, as a `RequestFailure` or `null` when the submission may proceed. */
function refuseOnTiming(timing: SubmissionTiming): RequestFailure | null {
  switch (timing.kind) {
    case 'window-closed':
      return { kind: 'deadline', detail: 'window-closed', effective: null };
    case 'late-rejected':
      return { kind: 'deadline', detail: 'late-rejected', effective: timing.effective };
    case 'on-time':
    case 'late-accepted':
      return null;
  }
}

/**
 * The instant `expires_at` carries.
 *
 * A `closed` window has no deadline date, and the column is NOT NULL. The
 * submission is refused before this is reached in that case, so the fallback is
 * unreachable on the submission path — it exists because `expires_at` must
 * always be a value, and `now` is the only instant that is certainly not in the
 * future. A row that somehow reached here would be immediately expirable, which
 * is the safe direction.
 */
function expiryInstant(
  context: GroupDeadlineContext,
  periodStart: CalendarDate | null,
  now: Date,
): Date {
  const deadline = deadlineFor(context, periodStart);
  return deadline.kind === 'closed'
    ? now
    : deadlineInstant(deadline.effective, context.timezone);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Withdrawal — R-22, R-10
 * ──────────────────────────────────────────────────────────────────────────── */

export interface WithdrawCommand {
  readonly requestId: string;
  readonly expectedVersion: number;
  readonly now: Date;
}

export interface WithdrawResult {
  readonly requestId: string;
  readonly version: number;
  /** R-10: a published version honoured this, so a revision was requested. */
  readonly revisionRequested: boolean;
}

/**
 * **Withdraw a request — requester-initiated only (§4).**
 *
 * ## R-22's boundaries come from the matrix, not from a list here
 *
 * Withdrawal succeeds from `submitted`, `under_review`, `approved` and
 * `accepted_as_input` (per subtype), and is REFUSED from `consumed_by_build`. A
 * hard-coded list of statuses in this function would be a third copy of §2, in
 * the place no test compares to anything — so the verdict is asked of the domain
 * matrix, which the agreement test holds to the database's copy cell by cell.
 *
 * ## R-10 — withdrawal after a published version already honoured it
 *
 * `reflected_in_version → withdrawn` is FAD-55's cell. The withdrawal succeeds,
 * `revision_requested` is set, and a `ScheduleRevisionRequested` event is raised
 * through the outbox in the same transaction. **The published version is not
 * touched** — I-18 makes it immutable in the database, and this service issues
 * no statement against `schedule_versions` at all. What the scheduler receives is
 * a request to revise, and the decision is theirs.
 *
 * The flag is computed from the SOURCE status by
 * `withdrawalRequiresRevision`, and migration 0023's guard refuses the pairing in
 * either wrong direction — so a service that computed it incorrectly is refused
 * by the database rather than believed.
 *
 * ## §3's re-validation, and why a passed deadline does NOT block a withdrawal
 *
 * §3 requires the deadline to be re-validated at every transition, and
 * `deadlineBindsInStatus` is where that question is answered: the deadline binds
 * in the three undecided states and nowhere else. It is deliberately not a
 * refusal here. A member whose request is sitting past its deadline waiting for
 * the sweeper must still be able to take it back — refusing would leave them
 * holding a request they cannot withdraw and nobody has decided. What the passed
 * deadline changes is that the SWEEPER may also act on it, and whichever gets
 * there first wins the conditional update.
 */
export async function withdrawRequest(
  uow: Uow,
  command: WithdrawCommand,
): Promise<RequestOutcome<WithdrawResult>> {
  const root = await requestStore.loadRoot(uow, command.requestId);
  if (root === null) return fail({ kind: 'not-found' });

  const verdict = operationVerdict(root.subtype, root.status, 'withdraw');
  if (!verdict.allowed) {
    return fail({ kind: 'illegal-operation', status: root.status, reason: verdict.reason });
  }

  const revisionRequested = withdrawalRequiresRevision(root.status);
  const sourceStatus = root.status;

  const version = await requestStore.withdraw(uow, {
    requestId: command.requestId,
    expectedVersion: command.expectedVersion,
    withdrawnAt: command.now,
    revisionRequested,
  });
  if (version === null) return fail({ kind: 'conflict' });

  const audit = await recordAuditEvent(uow, {
    eventName: 'requests.request.withdrawn',
    subjectType: 'request',
    subjectId: command.requestId,
    payload: {
      subtype: root.subtype,
      fromStatus: sourceStatus,
      revisionRequested,
      requestId: command.requestId,
    },
  });
  await publishOutboxEvent(uow, audit, {
    kind: 'requests.request.withdrawn',
    idempotencyKey: `request-withdrawn:${command.requestId}:${String(version)}`,
    payload: { requestId: command.requestId, subtype: root.subtype },
  });

  /* R-10's second event. Its OWN audit name and its OWN outbox kind, for the
   * reason `build.run.cancelled` has one beside `build.run.state_changed`:
   * "which published schedules have outstanding revision requests" must be a
   * query, not a payload scan. */
  if (revisionRequested) {
    const revisionAudit = await recordAuditEvent(uow, {
      eventName: 'requests.request.revision_requested',
      subjectType: 'request',
      subjectId: command.requestId,
      payload: { subtype: root.subtype, requestId: command.requestId },
    });
    await publishOutboxEvent(uow, revisionAudit, {
      kind: 'schedule.revision_requested',
      idempotencyKey: `schedule-revision-requested:${command.requestId}:${String(version)}`,
      payload: { requestId: command.requestId, subtype: root.subtype },
    });
  }

  return succeed({ requestId: command.requestId, version, revisionRequested });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Expiry — §3's sweeper, R-23's domain half
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ExpiredRequest {
  readonly requestId: string;
  readonly subtype: RequestSubtype;
  readonly membershipId: string;
  readonly fromStatus: RequestAggregate['status'];
}

/**
 * **Expire one claimed request.** The sweeper's per-row body.
 *
 * The domain verdict is consulted even though `claimExpirable` selected on the
 * three statuses: the claim is a QUERY and the verdict is a RULE, and a query
 * that drifted from the rule is exactly the failure V-31 documents. Both must
 * agree, and if they ever do not, this returns a refusal rather than expiring a
 * row §2 says is not expirable.
 *
 * **I-11 in one sentence:** the audit row, the status change and the outbox row
 * commit together; the requester's notification is DELIVERED afterwards by a
 * dispatcher that cannot reach back into this transaction, so a send failure
 * cannot undo the expiry.
 */
export async function expireRequest(
  uow: Uow,
  root: RequestAggregate,
  now: Date,
): Promise<RequestOutcome<ExpiredRequest>> {
  const verdict = operationVerdict(root.subtype, root.status, 'expire');
  if (!verdict.allowed) {
    return fail({ kind: 'illegal-operation', status: root.status, reason: verdict.reason });
  }
  if (!deadlineBindsInStatus(root.status)) {
    return fail({
      kind: 'illegal-operation',
      status: root.status,
      reason: 'operation-not-legal-from-status',
    });
  }

  const version = await requestStore.expire(uow, { requestId: root.id, expiredAt: now });
  if (version === null) return fail({ kind: 'conflict' });

  const audit = await recordAuditEvent(uow, {
    eventName: 'requests.request.expired',
    subjectType: 'request',
    subjectId: root.id,
    payload: {
      subtype: root.subtype,
      fromStatus: root.status,
      requestId: root.id,
      membershipId: root.membershipId,
    },
    /* The sweeper is a job. Its context names a real acting membership — the
     * worker refuses a job that does not — but nobody DECIDED to expire this
     * request; a deadline passed. `systemActor` is how "nobody was acting" and
     * "we failed to resolve who was acting" are kept from looking the same. */
    systemActor: true,
  });
  await publishOutboxEvent(uow, audit, {
    kind: 'requests.request.expired',
    idempotencyKey: `request-expired:${root.id}`,
    payload: {
      requestId: root.id,
      subtype: root.subtype,
      membershipId: root.membershipId,
    },
  });

  return succeed({
    requestId: root.id,
    subtype: root.subtype,
    membershipId: root.membershipId,
    fromStatus: root.status,
  });
}
