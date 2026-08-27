import {
  countersAfterReversal,
  grantVariance,
  orderSelectionsForDisplay,
  selectionOperationVerdict,
  vacationStatusPairAgrees,
  type CalendarDate,
  type GrantVariance,
  type Request as DomainRequest,
  type RequestSubtype,
  type UnitOfWork,
  type VacationGrant,
  type VacationPeriod,
  type VacationSelectionStatus,
  type VacationSelectionView,
} from '@schedulepoint/domain';
import type { Kysely } from 'kysely';

import { recordAuditEvent } from '../audit/recorder.js';
import type { Database } from '../db/schema.js';
import { publishOutboxEvent } from '../outbox/publisher.js';

import { classifyAt, deadlineFor, deadlineInstant, loadGroupDeadlineContext } from './deadlines.js';
import { classifyIdempotencyKey } from './idempotency.js';
import { requestStore } from './store.js';
import { vacationStore } from './vacation-store.js';

/**
 * SPEC-08 §5's SUBMISSION side — a member selects a week, and takes it back
 * (OPUS-M5-003, doc 42 §5f Part A).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## What this file is, beside `./vacation-approval.ts`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The two files are the two halves of ONE lifecycle and neither restates the
 * other. `./vacation-approval.ts` is §5.4's `APPROVE-VACATION` — the scheduler's
 * act, which consumes a quota unit under D-21. This is the member's: §5.3's
 * `available → pending` and `pending | approved → withdrawn`.
 *
 * They share every structural rule, and the sharing is deliberate rather than
 * incidental:
 *
 *  * **§5.3's ONE WRITER.** Every statement either file issues against
 *    `vacation_selections.status` or against a vacation root's `requests.status`
 *    goes through `PgVacationStore`, and both rows move in the SAME transaction.
 *    `PgRequestStore` still has no verb that can produce a vacation root.
 *  * **The guarded update (V-29).** `status = :expected AND version = :expected`
 *    on every selection write, which is R-18/R-19's shape. A second delivery of
 *    the same command finds the row already moved and is refused rather than
 *    succeeding twice.
 *  * **Rollback by THROWING.** The unit-of-work runner owns the transaction
 *    boundary (I-15, non-bypass rule 1), so a service cannot end one early and
 *    must not try. `VacationSelectionRolledBack` is how a failure after a first
 *    effect is spelled, exactly as `VacationApprovalRolledBack` is.
 *
 * ## R-15 is a property this file MAINTAINS, not one it hopes for
 *
 * Every write below moves the selection and the derived root in one transaction,
 * and every read below asserts `vacationStatusPairAgrees` before answering. The
 * enforcement is D-27's deferred triggers, from both sides, at commit; the
 * assertion here is what turns a violated mapping into a named failure at the
 * place that caused it rather than a `restrict_violation` at commit.
 *
 * ## I-07
 *
 * No payload below carries a date, a week, a reason or any free text. Ids,
 * booleans and closed-vocabulary tokens only, and the recorder refuses anything
 * else before a statement issues. **This packet adds no free-text field
 * anywhere** — a withdrawal is requester-initiated and needs no reason (§4), and
 * §4's comments remain M5-00C's.
 */

type Uow = UnitOfWork<Kysely<Database>>;

/* ────────────────────────────────────────────────────────────────────────────
 * Outcomes
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Why a selection command did not happen. A closed set — a caller must be able
 * to branch, and each member has a different remedy.
 *
 * `SELECTION_NOT_PENDING` is R-18/R-19's code, reused rather than duplicated: it
 * means the same thing here as on the decision side — the selection is not
 * standing where the command believed, or the version is stale — and a second
 * code with the same remedy would be a vocabulary that grew without meaning.
 */
export type VacationSelectionFailure =
  | 'SELECTION_NOT_PENDING'
  | 'VACATION_ROUND_NOT_OPEN'
  | 'VACATION_WEEK_ALREADY_SELECTED';

/**
 * Raised to roll the transaction back after an effect has been written.
 *
 * The submission inserts a ROOT before it can guard the selection link — the
 * link needs a request id, and the id does not exist until the insert returns.
 * So a failed link must undo the root, and the only thing that undoes it is the
 * transaction not committing.
 */
export class VacationSelectionRolledBack extends Error {
  readonly code = 'VACATION_SELECTION_ROLLED_BACK';

  constructor(readonly failure: VacationSelectionFailure) {
    super(`VACATION_SELECTION_ROLLED_BACK: ${failure}`);
  }
}

export interface SubmitVacationSelectionCommand {
  readonly membershipId: string;
  readonly vacationPeriodId: string;
  /** A Monday inside the period. The database enforces both (0022 §6). */
  readonly weekStart: string;
  readonly idempotencyKey: string;
  readonly now: Date;
}

export interface VacationSelectionWriteResult {
  readonly selectionId: string;
  readonly requestId: string;
  readonly selectionStatus: VacationSelectionStatus;
  readonly selectionVersion: number;
  readonly isLate: boolean;
  /** True when a quota unit was returned to its grant — a withdrawal from `approved`. */
  readonly unitReleased: boolean;
  /** R-11: this call found an existing request under the key rather than creating one. */
  readonly replayed: boolean;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Submission — §5.3's `available → pending`, and the root that carries it
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * **A member selects a vacation week (§5.3, §5.1).**
 *
 * ## Why the root is CREATED rather than submitted
 *
 * `app_request_initial_status('vacation-selection')` is `'submitted'`, and
 * `requests_guard_initial_status` refuses any other value. So unlike the five
 * non-vacation subtypes there is no `draft` row and no `draft → submitted` hop —
 * which is exactly what `submitVerdict` in the domain records when it refuses
 * `submit` for this subtype: *"its submission is the creation of the root"*.
 *
 * ## The order of the four statements, and why it is the only order
 *
 * ```
 *   1. the selection row exists in `available`  (created here, or already there)
 *   2. INSERT the root, at `submitted`
 *   3. UPDATE the selection: request_id, status = 'pending'   [guarded]
 *   4. (late only) UPDATE the root: is_late = true
 * ```
 *
 * The link cannot precede the root, because it needs the id. The root cannot
 * carry `is_late` at birth, because 0023's creation guard refuses a row born with
 * a lifecycle flag true — "a row created with it has been measured against
 * nothing". And D-18's zero-row guard is DEFERRED, so between statements 2 and 3
 * the root legitimately has no subtype row; at commit it has exactly one.
 *
 * At commit D-27 sees `pending` beside `submitted`, which is §5.3's mapping. The
 * intermediate instant in which the root exists and the selection is still
 * `available` is inside one transaction, which is what §5.3's "there is no window
 * in which they disagree" means — no other transaction can see an uncommitted
 * row.
 *
 * ## §3 applies, and the period's own window applies too
 *
 * They are different questions and both are asked. The PERIOD's `state` decides
 * whether this round is accepting selections at all; §3's group deadline decides
 * whether this submission is on time, computed server-side from the group's
 * policy against the period's start — a client value is never consulted, because
 * there is no parameter for one.
 */
export async function submitVacationSelection(
  uow: Uow,
  command: SubmitVacationSelectionCommand,
): Promise<VacationSelectionOutcome<VacationSelectionWriteResult>> {
  /* ── R-11 and FU-23, before any effect ────────────────────────────────────
   *
   * The same three-case decision the five non-vacation subtypes take, through the
   * same function: a key already naming a vacation request of this member's is a
   * REPLAY and returns the recorded row; a key naming a request of another
   * subtype is `IDEMPOTENCY_KEY_REUSED`. This branch is the half of FU-23 that
   * did not exist before — a vacation submission had no replay read at all,
   * because it had no submission path. */
  const known = await classifyIdempotencyKey(
    uow,
    command.membershipId,
    command.idempotencyKey,
    'vacation-selection',
  );
  if (known.kind === 'reused') {
    return { ok: false, failure: { kind: 'reused', existingSubtype: known.existingSubtype } };
  }
  if (known.kind === 'replay') {
    const recorded = await vacationStore.findSelectionByRequest(uow, known.root.id);
    if (recorded === null) return { ok: false, failure: { kind: 'not-found' } };
    /* Nothing is written and nothing is emitted — the same rule R-17's replay
     * follows on the approval side, and the same reason: a replay that emitted an
     * event would make "how many times did this person select this week"
     * unanswerable. */
    return {
      ok: true,
      value: {
        selectionId: recorded.id,
        requestId: known.root.id,
        selectionStatus: recorded.status,
        selectionVersion: recorded.version,
        isLate: known.root.isLate,
        unitReleased: false,
        replayed: true,
      },
    };
  }

  const period = await vacationStore.loadPeriod(uow, command.vacationPeriodId);
  if (period === null) return { ok: false, failure: { kind: 'not-found' } };

  /* The round's own window. A `draft` round has not opened, and `closed` and
   * `archived` ones have shut — none of the three admits a new selection, and
   * saying so here is what keeps §3's deadline refusal meaning what it says. */
  if (period.state !== 'open') {
    return { ok: false, failure: { kind: 'refused', code: 'VACATION_ROUND_NOT_OPEN' } };
  }

  const deadlineContext = await loadGroupDeadlineContext(uow);
  if (deadlineContext === null) return { ok: false, failure: { kind: 'not-found' } };

  const timing = classifyAt(deadlineContext, period.startDate, command.now);
  if (timing.kind === 'window-closed') {
    return {
      ok: false,
      failure: { kind: 'deadline', detail: 'window-closed', effective: null },
    };
  }
  if (timing.kind === 'late-rejected') {
    return {
      ok: false,
      failure: { kind: 'deadline', detail: 'late-rejected', effective: timing.effective },
    };
  }
  const isLate = timing.kind === 'late-accepted';

  /* D-22's read side: one selection per (membership, period, week). A row that is
   * already past `available` is this member's own existing claim on the week, and
   * a second submission for it is refused with its own code — the unique index
   * would refuse a second ROW, but here there is only one row and what is being
   * refused is a second CLAIM on it. */
  const existing = await vacationStore.findSelection(
    uow,
    command.membershipId,
    command.vacationPeriodId,
    command.weekStart,
  );
  if (existing !== null && existing.status !== 'available') {
    return { ok: false, failure: { kind: 'refused', code: 'VACATION_WEEK_ALREADY_SELECTED' } };
  }

  let selectionId: string;
  let selectionVersion: number;
  if (existing === null) {
    selectionId = await vacationStore.createSelection(uow, {
      membershipId: command.membershipId,
      vacationPeriodId: command.vacationPeriodId,
      weekStart: command.weekStart,
    });
    /* Re-read rather than assume `version = 1`. The column's default is 1 and
     * nothing else writes the row in this transaction — but a service that
     * depended on a default would not notice the day the default changed, which
     * is the same reason `submitRequest` asserts the initial status it was given
     * rather than trusting it. */
    const created = await vacationStore.loadSelection(uow, selectionId);
    if (created === null) return { ok: false, failure: { kind: 'not-found' } };
    selectionVersion = created.version;
  } else {
    selectionId = existing.id;
    selectionVersion = existing.version;
  }

  /* §5.3's domain verdict, before the write. The database's transition guard
   * refuses an illegal ROOT edge independently; this is the layer that can say
   * WHY, and R-01's discipline is that both are asked and both are asserted to
   * agree. */
  const verdict = selectionOperationVerdict(
    existing?.status ?? 'available',
    'submit',
  );
  if (!verdict.allowed) {
    return { ok: false, failure: { kind: 'refused', code: 'SELECTION_NOT_PENDING' } };
  }

  const expiresAt = expiryInstant(deadlineContext, period.startDate, command.now);

  const requestId = await vacationStore.createRoot(uow, {
    membershipId: command.membershipId,
    expiresAt,
    idempotencyKey: command.idempotencyKey,
    submittedAt: command.now,
  });

  const linked = await vacationStore.linkSelectionToRoot(uow, {
    selectionId,
    expectedSelectionVersion: selectionVersion,
    requestId,
  });
  if (linked === null) {
    /* The selection moved between the read and this statement — a second tab, a
     * second delivery, or a scheduler acting on it. The root inserted above is
     * released by the rollback, so no orphan root is ever left behind and the
     * idempotency key stays free for a retry. */
    throw new VacationSelectionRolledBack('SELECTION_NOT_PENDING');
  }

  if (isLate) await vacationStore.markRootLate(uow, requestId);

  const audit = await recordAuditEvent(uow, {
    eventName: 'requests.request.submitted',
    subjectType: 'request',
    subjectId: requestId,
    /* The same payload shape a non-vacation submission emits, so "when did this
     * person ask to be off" is one query across all six subtypes. Tokens only. */
    payload: {
      subtype: 'vacation-selection',
      isLate,
      requestId,
      selectionId,
    },
  });
  await publishOutboxEvent(uow, audit, {
    kind: 'requests.request.submitted',
    idempotencyKey: `request-submitted:${requestId}`,
    payload: { requestId, subtype: 'vacation-selection' },
  });

  return {
    ok: true,
    value: {
      selectionId,
      requestId,
      selectionStatus: 'pending',
      selectionVersion: linked,
      isLate,
      unitReleased: false,
      replayed: false,
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Withdrawal — §5.3's `pending | approved → withdrawn` (R-18, R-19)
 * ──────────────────────────────────────────────────────────────────────────── */

export interface WithdrawVacationSelectionCommand {
  readonly selectionId: string;
  /** V-29: the SELECTION's version, never the grant's and never the root's. */
  readonly expectedSelectionVersion: number;
  /**
   * The ACTING membership — §4's "requester-initiated only", made true here.
   *
   * See the ownership section of `withdrawVacationSelection`'s docblock: RLS
   * alone does not decide this, so the predicate is explicit and it reads the
   * VERIFIED context rather than anything the caller sent.
   */
  readonly membershipId: string;
  readonly now: Date;
}

/**
 * **A member withdraws their own vacation selection (§5.3, §4).**
 *
 * ## Two source statuses, and the second one returns a quota unit
 *
 * `pending → withdrawn` is the ordinary case and consumes nothing.
 * `approved → withdrawn` is doc 09 §2.2's *"withdrawn before commit"*, and it
 * RELEASES the unit the approval consumed — otherwise a member could withdraw
 * every approved week and their allowance would stay spent, which is the quota
 * error V-29 fixed on the other side of the same transaction.
 *
 * The release is §5.5's own arithmetic: `countersAfterReversal` decrements
 * `units_consumed` **and** `override_units` together, so an override "cannot
 * silently persist as headroom for a later approval". The floor is the database's
 * — `CHECK (units_consumed >= 0)` is unconditional and refuses the row rather
 * than clamping it, which is §5.5's instruction verbatim.
 *
 * **This is not §5.6's reversal.** That is `committed → reversed`, on a week a
 * PUBLISHED version already carries, it requires the override capability and a
 * reason, and it raises a revision request against the schedule. It stays
 * M5-004's. What they share is the release write path, which is why
 * `releaseGrantUnits` was built with both callers in view.
 *
 * ## Requester-initiated only — and WHY it takes an explicit predicate
 *
 * §4: *"Withdrawal is **requester-initiated only.** An administrator
 * 'withdrawing' for someone is a **denial with a reason**, recorded as such."*
 *
 * The route declares `requests.own.withdraw` with `ownershipRequired: true` and
 * no ownership override, and that is necessary but **not sufficient**, which a
 * test found rather than a reviewer:
 *
 *  * SPEC-06 L5.1 compares a TARGET's owner to the acting membership, and every
 *    route on this self-scoped surface names the acting membership as its own
 *    target — there is no subject in the path. So L5.1 is satisfied by
 *    construction and cannot be the control that decides whose selection this is.
 *  * Migration 0023's `vacation_selections_own` is not the only arm.
 *    `vacation_selections_group_administration` is `FOR ALL` behind
 *    `requests.administer`, which FAD-57's sibling row makes ROLE-IMPLIED for
 *    `scheduler` — so RLS admits a scheduler's write to a colleague's selection,
 *    exactly as migration 0023 says it should (*"RLS decides which ROWS, never
 *    which OPERATIONS"*).
 *
 * Both statements are correct and their COMPOSITION left §4's rule undefended.
 * So the predicate is written here, on the VERIFIED context's own membership —
 * the same "the queries are self-scoped too" discipline `requests.route.ts`
 * records for `GET …/requests/mine`, applied to a route that addresses a row by
 * id and therefore cannot get it from a `WHERE membership_id = me` on a list.
 *
 * A colleague's selection answers `not-found`, byte-identical to a selection that
 * does not exist — the X-11 posture this surface takes everywhere. An
 * administrator ending a member's vacation week is `denyVacationSelection`, under
 * `requests.deny`, with a mandatory reason, which is what §4 says it is.
 */
export async function withdrawVacationSelection(
  uow: Uow,
  command: WithdrawVacationSelectionCommand,
): Promise<VacationSelectionOutcome<VacationSelectionWriteResult>> {
  const selection = await vacationStore.loadSelection(uow, command.selectionId);
  if (selection === null) return { ok: false, failure: { kind: 'not-found' } };

  /* §4's requester-initiated-only rule. See the ownership section above for why
   * neither L5.1 nor RLS decides this one, and why the answer is `not-found`
   * rather than a refusal that would confirm the row exists. */
  if (selection.membershipId !== command.membershipId) {
    return { ok: false, failure: { kind: 'not-found' } };
  }

  const verdict = selectionOperationVerdict(selection.status, 'withdraw');
  if (!verdict.allowed) {
    return { ok: false, failure: { kind: 'refused', code: 'SELECTION_NOT_PENDING' } };
  }

  const sourceStatus = selection.status;
  const releasesUnit = sourceStatus === 'approved' && selection.grantId !== null;

  const withdrawn = await vacationStore.withdrawSelection(uow, {
    selectionId: command.selectionId,
    expectedSelectionVersion: command.expectedSelectionVersion,
    expectedStatus: sourceStatus,
  });
  if (withdrawn === null) {
    /* R-18/R-19: already withdrawn, already decided, or a stale version. Nothing
     * has been written yet, so this is a returned failure rather than a rollback. */
    return { ok: false, failure: { kind: 'refused', code: 'SELECTION_NOT_PENDING' } };
  }

  const requestId = selection.requestId;
  if (requestId === null) {
    /* Unreachable: `vacation_selections_request_present_unless_available` makes
     * `available` the only status with no root, and `available` has no withdrawal
     * edge. Written rather than cast away, for the reason the approval side gives
     * about its twin — a cast is what turns "the constraint was dropped" into an
     * undiagnosable field error. */
    throw new VacationSelectionRolledBack('SELECTION_NOT_PENDING');
  }

  const rootVersion = await vacationStore.writeRootWithdrawal(uow, {
    requestId,
    withdrawnAt: command.now,
  });
  if (rootVersion === null) throw new VacationSelectionRolledBack('SELECTION_NOT_PENDING');

  let released = false;
  if (releasesUnit && selection.grantId !== null) {
    const grants = await vacationStore.listGrants(uow, selection.vacationPeriodId);
    const grant = grants.find((candidate) => candidate.id === selection.grantId);
    if (grant !== undefined) {
      /* One unit, and the override it was authorised under. `countersAfterReversal`
       * is the arithmetic; what the store writes are the DELTAS it implies, so the
       * pure function and the statement cannot disagree about the result. */
      const after = countersAfterReversal(grant, 1);
      const releasedOverride = grant.overrideUnits - after.overrideUnits;
      const newVersion = await vacationStore.releaseGrantUnits(uow, {
        grantId: grant.id,
        expectedVersion: grant.version,
        units: 1,
        overrideUnits: selection.isOverride ? releasedOverride : 0,
      });
      if (newVersion === null) {
        /* The grant moved under us — another approval or reversal in flight. The
         * whole transaction rolls back, so the withdrawal does not commit without
         * its release and the member's allowance is never left spent. */
        throw new VacationSelectionRolledBack('SELECTION_NOT_PENDING');
      }
      released = true;
    }
  }

  const audit = await recordAuditEvent(uow, {
    eventName: 'requests.vacation_selection.withdrawn',
    subjectType: 'request',
    subjectId: requestId,
    payload: {
      requestId,
      selectionId: command.selectionId,
      fromStatus: sourceStatus,
      unitReleased: released,
    },
  });
  await publishOutboxEvent(uow, audit, {
    kind: 'requests.vacation_selection.withdrawn',
    idempotencyKey: `vacation-withdrawn:${command.selectionId}:${String(withdrawn)}`,
    payload: { requestId, selectionId: command.selectionId, unitReleased: released },
  });

  return {
    ok: true,
    value: {
      selectionId: command.selectionId,
      requestId,
      selectionStatus: 'withdrawn',
      selectionVersion: withdrawn,
      isLate: false,
      unitReleased: released,
      replayed: false,
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * The round, as a surface reads it
 * ──────────────────────────────────────────────────────────────────────────── */

export interface VacationRound {
  readonly period: VacationPeriod;
  /** Ordered by `compareSelectionsForDisplay` — the domain's rule, not a query's. */
  readonly selections: readonly VacationSelectionView[];
  /** §5.5's advisory indicator per grant. EMPTY in open mode (V-30), not an error. */
  readonly variance: readonly (GrantVariance & {
    readonly grantId: string;
    readonly kind: VacationGrant['kind'];
    readonly membershipId: string | null;
    readonly weekStart: string | null;
  })[];
}

/**
 * **One round, one read** (I-10: one user action, one request).
 *
 * The period, the caller's selections in it, and the variance rows for its
 * grants — a surface that fetched these separately would be three requests for
 * one action, and the request-budget gate counts exactly that.
 *
 * ## `scope`
 *
 * `'own'` narrows to one membership's selections, which is what the staff
 * surface shows and what migration 0023's `vacation_selections_own` policy would
 * narrow it to anyway. `'period'` returns every selection in the round, which is
 * the scheduler's view and which RLS answers with zero rows for a caller holding
 * neither `requests.read_any` nor `requests.administer`. The predicate is the
 * second control, never the only one.
 *
 * ## R-15 is asserted here, not assumed
 *
 * Every view row is checked with `vacationStatusPairAgrees` before it is
 * returned. D-27 makes a disagreeing pair impossible to COMMIT; this makes one
 * impossible to DISPLAY, and the two are different guarantees — a read that
 * showed a pair the database could not have written would be a surface inventing
 * a state, and the honest response is to fail rather than to render it.
 */
export async function readVacationRound(
  uow: Uow,
  request: {
    readonly periodId: string;
    readonly scope: 'own' | 'period';
    readonly membershipId: string;
  },
): Promise<VacationSelectionOutcome<VacationRound>> {
  const period = await vacationStore.loadPeriod(uow, request.periodId);
  if (period === null) return { ok: false, failure: { kind: 'not-found' } };

  const views =
    request.scope === 'own'
      ? (await vacationStore.listSelectionsForMembership(uow, request.membershipId)).filter(
          (view) => view.selection.vacationPeriodId === request.periodId,
        )
      : await vacationStore.listSelectionsInPeriod(uow, request.periodId);

  for (const view of views) {
    if (!vacationStatusPairAgrees(view.selection.status, view.rootStatus)) {
      throw new Error(
        'VACATION_STATUS_PAIR_DISAGREES: a selection and its request are in states SPEC-08 ' +
          '§5.3 does not pair (D-27), and this read will not render one.',
      );
    }
  }

  const grants = await vacationStore.listGrants(uow, request.periodId);

  return {
    ok: true,
    value: {
      period,
      selections: orderSelectionsForDisplay(
        views.map((view) => ({
          ...view,
          weekStart: view.selection.weekStart,
          id: view.selection.id,
        })),
      ).map(({ weekStart: _weekStart, id: _id, ...view }) => view),
      variance: grants.map((grant) => ({
        ...grantVariance(grant),
        grantId: grant.id,
        kind: grant.kind,
        membershipId: grant.kind === 'personal-entitlement' ? grant.membershipId : null,
        weekStart: grant.kind === 'weekly-capacity' ? grant.weekStart : null,
      })),
    },
  };
}

/**
 * **A vacation request as the aggregate shape, composed from BOTH stores.**
 *
 * `PgRequestStore.load` answers `null` for a vacation root, deliberately: its
 * `loadRecord` does not read `vacation_selections`, because §5.3 gives that
 * lifecycle one reader and it is `VacationStore`. So the composition happens
 * HERE, in the module that already holds both handles, rather than by teaching
 * the request store to read a table §5.3 keeps away from it.
 *
 * D-18 makes the pair total: a `vacation-selection` root has exactly one
 * selection row, so a `null` selection beside a visible root is a broken
 * invariant rather than an empty case — and answering `null` is what makes the
 * caller's `404` say "not visible here" for both the tenancy reason and this one,
 * which are indistinguishable to a caller by design (X-11).
 */
export async function loadVacationRequest(
  uow: Uow,
  requestId: string,
): Promise<DomainRequest | null> {
  const root = await requestStore.loadRoot(uow, requestId);
  if (root === null || root.subtype !== 'vacation-selection') return null;
  const record = await vacationStore.findSelectionByRequest(uow, requestId);
  if (record === null) return null;
  if (!vacationStatusPairAgrees(record.status, root.status)) {
    throw new Error(
      'VACATION_STATUS_PAIR_DISAGREES: a selection and its request are in states SPEC-08 ' +
        '§5.3 does not pair (D-27), and this read will not render one.',
    );
  }
  return { root, record };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Shared shapes
 * ──────────────────────────────────────────────────────────────────────────── */

/** Why a selection command did not happen, in the shape a route answers from. */
export type VacationSelectionServiceFailure =
  | { readonly kind: 'not-found' }
  | { readonly kind: 'refused'; readonly code: VacationSelectionFailure }
  /** FU-23: this member's key already names a request of a different subtype. */
  | { readonly kind: 'reused'; readonly existingSubtype: RequestSubtype }
  | {
      readonly kind: 'deadline';
      readonly detail: 'window-closed' | 'late-rejected';
      readonly effective: CalendarDate | null;
    };

export type VacationSelectionOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: VacationSelectionServiceFailure };

/**
 * The instant `expires_at` carries, computed server-side from the group's policy.
 *
 * The same function `submitRequest` uses and for the same reason: §3's deadline
 * is the group's, a client value is never consulted, and a `closed` window has no
 * date at all. The submission is refused before this is reached in that case, so
 * the fallback is unreachable on this path — it exists because the column is NOT
 * NULL and `now` is the only instant that is certainly not in the future.
 */
function expiryInstant(
  context: Parameters<typeof deadlineFor>[0],
  periodStart: CalendarDate | null,
  now: Date,
): Date {
  const deadline = deadlineFor(context, periodStart);
  return deadline.kind === 'closed' ? now : deadlineInstant(deadline.effective, context.timezone);
}
