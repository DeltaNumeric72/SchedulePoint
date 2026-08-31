import {
  countersAfterReversal,
  deadlineBindsInStatus,
  resolveShiftInterval,
  reversalReasonIsWellFormed,
  selectionEdgeRootPath,
  vacationWeekDates,
  versionAcceptsCommit,
  type EvaluationContext,
  type UnitOfWork,
  type VacationCommitFailure,
  type VacationReversalFailure,
  type VacationSelectionRecord,
} from '@schedulepoint/domain';
import { sql, type Kysely } from 'kysely';

import { recordAuditEvent } from '../audit/recorder.js';
import { evaluateAction } from '../authz/authorize-request.js';
import type { Database } from '../db/schema.js';
import { publishOutboxEvent } from '../outbox/publisher.js';
import { addManualAssignment } from '../schedule/service.js';
import { resolveRenderTimezone } from '../schedule/timezone.js';

import { vacationStore } from './vacation-store.js';

/**
 * SPEC-08 §5.6 — COMMIT and REVERSAL, the transactions (OPUS-M5-004, doc 42
 * §5h), under **FAD-59**.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## Commit — doc 09 §2.3's "the most consequential operation in this domain"
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```
 *   0. R-12's replay read     — the recorded outcome, writing nothing
 *   1. re-validation (I-19)   — the version is a DRAFT, the period is this one
 *   2. per selection: OFF assignment snapshots, one per working day
 *   3. per selection: `approved → committed` + `committed_to_version_id`
 *   4. per selection: the derived root status (§5.3), same transaction
 *   5. FAD-59's ledger row, INSERTed complete
 *      audit; outbox
 *   COMMIT                    — one transaction, all of it
 * ```
 *
 * ## Why the ledger row is LAST, and why that is FAD-59 read strictly
 *
 * `vacation_approval_commands` (D-26) writes at step 0 with a NULL outcome and
 * UPDATEs it at the end — which needs a column-level `GRANT UPDATE (outcome)`.
 * FAD-59's privilege sentence for THIS table is *"GRANT SELECT, INSERT and
 * nothing else"*, and "nothing else" forecloses that grant. So the row is
 * written once, complete, at the end.
 *
 * **The UNIQUE key is the race control, not the early INSERT.** Two concurrent
 * commands carrying one key both pass step 0's read; both do the work; the
 * second blocks on `vacation_commit_commands_idempotent` and receives zero rows
 * from its `ON CONFLICT DO NOTHING` when the first commits. It then CONVERGES —
 * re-reads the winner's row and returns the recorded outcome — so a concurrent
 * duplicate and a sequential replay give the caller the same answer. That is
 * what R-12's *"one commit"* means from outside, and it is why a `23505` never
 * reaches a caller.
 *
 * ## What re-validation at commit does and does NOT include (I-19)
 *
 * Three things are re-read inside the transaction and refused by name: the
 * target version is a `draft` (§5.6, SPEC-05 §3.2, I-18 — a published version is
 * immutable and committing INTO one is refused as `COMMIT_TARGET_NOT_DRAFT`
 * before anything is attempted), the version belongs to the same schedule period
 * the round covers, and every selection is still `approved` (the guard is in the
 * UPDATE's own WHERE, so it is the database that decides).
 *
 * **The request-until deadline is NOT one of them, and that is derived rather
 * than assumed.** SPEC-08 §3's *"re-validated at every transition — not only at
 * submission"* was ruled at OPUS-M5-001 and ships as `deadlineBindsInStatus`
 * (`packages/domain/src/requests/deadlines.ts`), which binds in `submitted`,
 * `under_review` and `accepted_as_input` and in nothing else — V-31's three
 * legal expiry sources, the undecided states. Commit acts FROM `approved`, so
 * the predicate answers `false`; and §2 forecloses the only consequence §3 names
 * in any case, because `approved → expired` is not an edge (R-23). doc 09 §2.3
 * says nothing about deadlines in either direction. So commit COMPOSES with the
 * shipped predicate — `assertDeadlineDoesNotGateCommit` below consults it rather
 * than restating the rule — and a commit after the request window has closed
 * succeeds, which is the normal case: the round closes, then it is committed.
 *
 * ## Quota accounting is UNTOUCHED by commit
 *
 * Consumption happened at approval (§5.4, M5-002's). A commit that consumed a
 * unit would consume a second one for every week, and a commit that checked the
 * quota would be re-deciding a decision. Reversal is where the counters move
 * again, downward.
 *
 * ## I-11 and I-07
 *
 * The outbox events are enqueued inside the transaction and dispatched outside
 * it, so a notification failure never rolls back the commit. Every payload is
 * ids and tokens: no reason text, no week, no date. The reversal's mandatory
 * reason lives on `vacation_selections.override_reason` and reaches no payload,
 * no outbox row and no log (non-bypass rule 9); the audit payload validator
 * would refuse prose regardless.
 */

type Uow = UnitOfWork<Kysely<Database>>;

/**
 * Raised to roll the transaction back after an effect has been written.
 *
 * The same device `VacationApprovalRolledBack` is, for the same reason: the
 * unit-of-work runner owns the transaction boundary (I-15, non-bypass rule 1),
 * so a service cannot end one early and must not try. §5.6's commit is
 * all-or-nothing — a partial commit would leave some weeks off the schedule and
 * some on it, with one ledger row claiming the round was committed.
 */
export class VacationCommitRolledBack extends Error {
  readonly code = 'VACATION_COMMIT_ROLLED_BACK';

  constructor(readonly failure: VacationCommitFailure) {
    super(`VACATION_COMMIT_ROLLED_BACK: ${failure}`);
  }
}

/** The reversal's twin. Separate class, separate closed vocabulary. */
export class VacationReversalRolledBack extends Error {
  readonly code = 'VACATION_REVERSAL_ROLLED_BACK';

  constructor(readonly failure: VacationReversalFailure) {
    super(`VACATION_REVERSAL_ROLLED_BACK: ${failure}`);
  }
}

export interface CommitVacationRoundCommand {
  readonly vacationPeriodId: string;
  /** SPEC-05's DRAFT version the OFF snapshots land in. */
  readonly targetVersionId: string;
  /** FAD-59's key. The same key twice commits nothing the second time. */
  readonly idempotencyKey: string;
  readonly actingMembershipId: string;
  readonly principalUserId: string;
  readonly now: Date;
}

export interface CommitVacationRoundResult {
  readonly vacationPeriodId: string;
  readonly targetVersionId: string;
  readonly committedSelectionIds: readonly string[];
  readonly assignmentSnapshotIds: readonly string[];
  /** True when FAD-59's key had already been recorded: nothing was written. */
  readonly replayed: boolean;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Commit
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * **COMMIT-VACATION-ROUND (SPEC-08 §5.6, doc 09 §2.3), under FAD-59.**
 *
 * Returns a result, or throws `VacationCommitRolledBack`.
 */
export async function commitVacationRound(
  uow: Uow,
  command: CommitVacationRoundCommand,
): Promise<CommitVacationRoundResult> {
  /* ── 0. R-12's replay, before any effect ────────────────────────────────── */
  const recorded = await vacationStore.findCommitCommand(uow, command.idempotencyKey);
  if (recorded !== null) return replayedOutcome(uow, recorded);

  /* ── 1. Re-validation inside the transaction (I-19) ─────────────────────── */
  const period = await vacationStore.loadPeriod(uow, command.vacationPeriodId);
  if (period === null) throw new VacationCommitRolledBack('COMMIT_PERIOD_NOT_FOUND');

  const version = await loadTargetVersion(uow, command.targetVersionId);
  /* §5.6 + I-18 (non-bypass rule 5), refused BY NAME and before anything is
   * attempted. `addManualAssignment`'s own `assertEditable` refuses the same
   * thing again from inside, with a different message — two independent
   * controls, which is what makes "a published version is never committed into"
   * a property rather than a promise this function makes. */
  if (version === null || !versionAcceptsCommit(version.state)) {
    throw new VacationCommitRolledBack('COMMIT_TARGET_NOT_DRAFT');
  }

  const selections = await vacationStore.listSelectionsByStatus(
    uow,
    command.vacationPeriodId,
    'approved',
  );
  if (selections.length === 0) throw new VacationCommitRolledBack('COMMIT_NOTHING_TO_COMMIT');

  /* The round's weeks must fall inside the schedule version's own period; see
   * `COMMIT_PERIOD_VERSION_MISMATCH` in the domain's failure vocabulary. */
  if (!(await versionCoversPeriod(uow, version.period_id, period.startDate, period.endDate))) {
    throw new VacationCommitRolledBack('COMMIT_PERIOD_VERSION_MISMATCH');
  }

  const offShiftType = await loadOffShiftType(uow);
  if (offShiftType === null) throw new VacationCommitRolledBack('COMMIT_NO_OFF_SHIFT_TYPE');

  const renderZone = await resolveRenderTimezone(uow, command.targetVersionId);

  /* ── 2–4. Per selection: snapshots, the selection, the derived root ─────── */
  const committedSelectionIds: string[] = [];
  const assignmentSnapshotIds: string[] = [];

  for (const selection of selections) {
    assertDeadlineDoesNotGateCommit(selection);

    for (const date of vacationWeekDates(selection.weekStart)) {
      /* One OFF snapshot per working day, through the SHIPPED assignment writer.
       * Not a second spelling of it: `addManualAssignment` carries
       * `assertEditable` (the I-18 control), D-1a's overlap exclusion, D-14's
       * one-snapshot-per-identity-per-version rule, and the assignment audit
       * event, and a commit that inserted rows directly would be a writer none
       * of those four apply to. */
      const interval = resolveShiftInterval(
        renderZone.zone,
        date,
        offShiftType.start_time.slice(0, 5),
        offShiftType.end_time.slice(0, 5),
      );
      const added = await addManualAssignment(
        uow,
        { principalUserId: command.principalUserId },
        {
          versionId: command.targetVersionId,
          membershipId: selection.membershipId,
          shiftTypeId: offShiftType.id,
          date,
          startsAt: interval.startsAt,
          endsAt: interval.endsAt,
          locationId: null,
          /* Migration 0027 §5's fifth value. A committed vacation day is placed
           * by neither a person nor a solver nor a clone nor a picklist, and a
           * snapshot in a version that later publishes is immutable (I-18) — so
           * the label has to be true the first time or it is never true. */
          origin: 'vacation_commit',
        },
      );
      assignmentSnapshotIds.push(added.snapshotId);
    }

    const selectionVersion = await vacationStore.commitSelection(uow, {
      selectionId: selection.id,
      committedToVersionId: command.targetVersionId,
      commitIdempotencyKey: command.idempotencyKey,
    });
    if (selectionVersion === null) {
      /* The per-selection half of D-23: `status = 'approved'` in the UPDATE's
       * WHERE, so a selection somebody else committed between the list and here
       * matches zero rows and the whole round rolls back. */
      throw new VacationCommitRolledBack('COMMIT_SELECTION_NOT_APPROVED');
    }

    const requestId = selection.requestId;
    if (requestId === null) {
      /* Unreachable: `vacation_selections_request_present_unless_available`
       * makes `available` the only status with no root, and `available` has no
       * commit edge. Written rather than cast away — a cast is what turns "the
       * constraint was dropped" into an undiagnosable field error. */
      throw new VacationCommitRolledBack('COMMIT_SELECTION_NOT_APPROVED');
    }

    /* §5.3, same transaction. The path is DERIVED from the selection edge rather
     * than written as a literal, so a matrix that ever changed would change this
     * answer instead of leaving it stale — `selectionEdgeRootPath('approved',
     * 'committed')` is §2's `approved → reflected_in_version`. */
    const path = selectionEdgeRootPath('approved', 'committed');
    if (path === null || path.length === 0) {
      throw new Error('VACATION_COMMIT_PATH_MISSING: §5.3 carries no root path for the commit edge');
    }
    const rootVersion = await vacationStore.writeDerivedRootStatus(uow, {
      requestId,
      path,
      decidedBy: command.actingMembershipId,
      decidedAt: command.now,
    });
    if (rootVersion === null) throw new VacationCommitRolledBack('COMMIT_SELECTION_NOT_APPROVED');

    committedSelectionIds.push(selection.id);
  }

  /* ── 5. FAD-59's ledger row, complete, and the race's convergence ───────── */
  const commandId = await vacationStore.recordCommitCommand(uow, {
    vacationPeriodId: command.vacationPeriodId,
    targetVersionId: command.targetVersionId,
    actingMembershipId: command.actingMembershipId,
    idempotencyKey: command.idempotencyKey,
    receivedAt: command.now,
  });
  if (commandId === null) {
    /* A genuine race: another transaction recorded this key while this one was
     * working. Everything this transaction did rolls back with the throw, so
     * exactly one commit exists.
     *
     * **`COMMIT_RACE_LOST` never reaches a caller.** It is an INTERNAL signal to
     * the route, which re-enters this function in a fresh unit of work; step 0
     * then finds the winner's ledger row and returns the recorded outcome. So a
     * concurrent duplicate and a sequential replay answer a caller identically,
     * which is what R-12's "one commit" means from outside — and no `23505`
     * surfaces anywhere. */
    throw new VacationCommitRolledBack('COMMIT_RACE_LOST');
  }

  const audit = await recordAuditEvent(uow, {
    eventName: 'requests.vacation_round.committed',
    subjectType: 'request',
    subjectId: command.vacationPeriodId,
    /* Ids and counts. No week, no date, no reason — the rows carry those, and a
     * payload that repeated them would be a second copy in the one place I-07
     * forbids free text (non-bypass rule 9). */
    payload: {
      periodId: command.vacationPeriodId,
      versionId: command.targetVersionId,
      selections: committedSelectionIds.length,
      assignments: assignmentSnapshotIds.length,
    },
  });
  await publishOutboxEvent(uow, audit, {
    kind: 'requests.vacation_round.committed',
    idempotencyKey: `vacation-committed:${command.vacationPeriodId}:${command.idempotencyKey}`,
    payload: {
      periodId: command.vacationPeriodId,
      versionId: command.targetVersionId,
      selections: committedSelectionIds.length,
    },
  });

  return {
    vacationPeriodId: command.vacationPeriodId,
    targetVersionId: command.targetVersionId,
    committedSelectionIds,
    assignmentSnapshotIds,
    replayed: false,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Reversal
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ReverseVacationCommitCommand {
  readonly selectionId: string;
  /** §5.6's MANDATORY reason. Bounded administrative text; never in a payload. */
  readonly reason: string;
  readonly actingMembershipId: string;
  readonly now: Date;
  /** For the override capability's second evaluation. The route's verified tuple. */
  readonly actor: EvaluationContext;
}

export interface ReverseVacationCommitResult {
  readonly selectionId: string;
  readonly requestId: string;
  readonly selectionVersion: number;
  readonly unitReleased: boolean;
  readonly revisionRequested: true;
}

/**
 * **REVERSE-VACATION-COMMIT (SPEC-08 §5.6).** `committed → reversed`.
 *
 * §5.6's sentence has four clauses and each is a step below: the override
 * capability, the mandatory reason, the quota decrement (R-08's floor, R-20's
 * both-counters rule), and the revision request that is raised **instead of**
 * editing a published version (I-18, non-bypass rule 5).
 *
 * **Nothing here touches the schedule.** The OFF assignment snapshots the commit
 * created stay exactly where they are — and that is true whether the target
 * version is still a DRAFT or has since been published. One behaviour on every
 * path, because §5.6's sentence does not distinguish the two and a branch would
 * make "a reversal never edits a version" a rule with an exception; a draft's
 * snapshots are removed through the ordinary manual surface, by a person, with
 * its own audit row. What this produces is a `ScheduleRevisionRequested` event
 * and a scheduler's decision.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## The revision request is the EVENT, and `requests.revision_requested` is
 *    NOT written — a conflict found by test, and the narrower reading taken
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * §5.6 says a reversal *"raises a revision request against the schedule"* and
 * names no column. §4's withdrawal row is the sentence that names one — *"The
 * request moves to `withdrawn` with `revision_requested = true`"* — and
 * migration 0023's `app_guard_request_revision_requested` implements exactly
 * that and nothing wider: it RAISES `REQUEST_REVISION_NOT_APPLICABLE` on any
 * write that sets the flag whose edge is not `reflected_in_version → withdrawn`.
 * A first implementation of this transaction did set the flag and the guard
 * refused the whole reversal, which is how the conflict was found.
 *
 * The narrower reading is taken: the reversal raises the same
 * `schedule.revision_requested` OUTBOX event and the same
 * `requests.request.revision_requested` AUDIT event M5-001's withdrawal raises —
 * which is what a scheduler acts on — and it does not write §4's withdrawal
 * flag. Nothing is weakened: the guard is untouched, the flag keeps the one
 * meaning §4 gives it, and the revision request exists as a fact in the audit
 * chain and the outbox.
 *
 * **The consequence is owned rather than hidden:** "which requests have an
 * outstanding revision request" is a COLUMN query for the five non-vacation
 * subtypes and an EVENT query for a reversed vacation week. Widening 0023's
 * guard to admit `reflected_in_version → reversed` is the alternative, and it is
 * a change to a shipped enforcement rather than something this transaction may
 * decide for itself — escalated at implementation and recorded here either way.
 */
export async function reverseVacationCommit(
  uow: Uow,
  command: ReverseVacationCommitCommand,
): Promise<ReverseVacationCommitResult> {
  /* §5.6's mandatory reason, before any effect. Bounded by the same rule
   * migration 0022's `vacation_selections_override_reason_len` enforces, so the
   * refusal is a name a caller can act on rather than a `23514` they cannot. */
  if (!reversalReasonIsWellFormed(command.reason)) {
    throw new VacationReversalRolledBack('REVERSAL_REASON_REQUIRED');
  }

  /* §5.6's "requires the override capability", evaluated in THIS transaction
   * against current state (I-19, FAD-12) — not the route's action key, which is
   * the reversal itself. The same second-evaluation shape §5.5's over-quota
   * override uses, through the same `evaluateAction` every path calls. */
  if (!(await actorHoldsOverride(uow, command.actor))) {
    throw new VacationReversalRolledBack('REVERSAL_OVERRIDE_REQUIRED');
  }

  const selection = await vacationStore.loadSelection(uow, command.selectionId);
  if (selection === null || selection.status !== 'committed') {
    throw new VacationReversalRolledBack('REVERSAL_SELECTION_NOT_COMMITTED');
  }
  const requestId = selection.requestId;
  if (requestId === null) {
    throw new VacationReversalRolledBack('REVERSAL_SELECTION_NOT_COMMITTED');
  }

  /* ── The quota release: R-20's both counters, R-08's floor ──────────────── */
  const unitReleased = await releaseCommittedUnit(uow, selection);

  const selectionVersion = await vacationStore.reverseSelection(uow, {
    selectionId: command.selectionId,
    reason: command.reason.trim(),
  });
  if (selectionVersion === null) {
    throw new VacationReversalRolledBack('REVERSAL_SELECTION_NOT_COMMITTED');
  }

  const path = selectionEdgeRootPath('committed', 'reversed');
  if (path === null || path.length === 0) {
    throw new Error('VACATION_REVERSAL_PATH_MISSING: §5.3 carries no root path for the reversal edge');
  }
  const rootVersion = await vacationStore.writeDerivedRootStatus(uow, {
    requestId,
    path,
    decidedBy: command.actingMembershipId,
    decidedAt: command.now,
  });
  if (rootVersion === null) {
    throw new VacationReversalRolledBack('REVERSAL_SELECTION_NOT_COMMITTED');
  }

  const audit = await recordAuditEvent(uow, {
    eventName: 'requests.vacation_selection.reversed',
    subjectType: 'request',
    subjectId: requestId,
    /* `reasonGiven`, never the reason. The M5-002 posture verbatim: the audit
     * chain records THAT a reason was required and supplied, never WHICH. */
    payload: {
      requestId,
      selectionId: command.selectionId,
      unitReleased,
      reasonGiven: true,
    },
  });
  await publishOutboxEvent(uow, audit, {
    kind: 'requests.vacation_selection.reversed',
    idempotencyKey: `vacation-reversed:${command.selectionId}:${String(selectionVersion)}`,
    payload: { requestId, selectionId: command.selectionId, unitReleased },
  });

  /* R-10's second event, with its own name — the same separation M5-001 made for
   * withdrawal-after-reflection: "which published schedules have outstanding
   * revision requests" must be a query, not a payload scan. */
  const revisionAudit = await recordAuditEvent(uow, {
    eventName: 'requests.request.revision_requested',
    subjectType: 'request',
    subjectId: requestId,
    payload: { subtype: 'vacation-selection', requestId },
  });
  await publishOutboxEvent(uow, revisionAudit, {
    kind: 'schedule.revision_requested',
    idempotencyKey: `schedule-revision-requested:${requestId}:${String(rootVersion)}`,
    payload: { requestId, subtype: 'vacation-selection' },
  });

  return {
    selectionId: command.selectionId,
    requestId,
    selectionVersion,
    unitReleased,
    revisionRequested: true,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * The pieces
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * R-12's replayed answer.
 *
 * The ledger row exists, so a previous transaction committed this key. **Nothing
 * is written**: no snapshot, no selection update, no event. The selections the
 * recorded command committed are read back so the caller receives the same
 * shape it would have received the first time.
 */
async function replayedOutcome(
  uow: Uow,
  recorded: { readonly targetVersionId: string; readonly vacationPeriodId: string },
): Promise<CommitVacationRoundResult> {
  const committed = await vacationStore.listSelectionsByStatus(
    uow,
    recorded.vacationPeriodId,
    'committed',
  );
  return {
    vacationPeriodId: recorded.vacationPeriodId,
    targetVersionId: recorded.targetVersionId,
    committedSelectionIds: committed
      .filter((selection) => selection.committedToVersionId === recorded.targetVersionId)
      .map((selection) => selection.id),
    /* A replay creates no snapshot and reports none: the ids belong to the
     * transaction that made them, and inventing a list here would make "what did
     * this call do" unanswerable. */
    assignmentSnapshotIds: [],
    replayed: true,
  };
}

/**
 * **SPEC-08 §3 at the commit, composed rather than restated.**
 *
 * `deadlineBindsInStatus` is M5-001's shipped ruling on §3's *"re-validated at
 * every transition"*, and it answers `false` for `approved` — the status a
 * commit acts from. This function exists so that the composition is a CALL a
 * test can defeat by mutation, rather than a paragraph: change the shipped
 * predicate to bind in `approved` and this throws, which is exactly the
 * behaviour a reader of §3 would expect and exactly the behaviour §2 forbids
 * (`approved → expired` is not an edge, R-23).
 *
 * It is not a gate on the commit. It is the assertion that there is none, made
 * where a future editor would have to look at it.
 */
function assertDeadlineDoesNotGateCommit(selection: VacationSelectionRecord): void {
  if (deadlineBindsInStatus('approved')) {
    throw new Error(
      `VACATION_COMMIT_DEADLINE_RULE_CHANGED: SPEC-08 §3's deadline now binds in 'approved', ` +
        `so selection ${selection.id} cannot be committed without a ruling on what that means`,
    );
  }
}

/** The target version's state and period. `null` when it is not visible here. */
async function loadTargetVersion(
  uow: Uow,
  versionId: string,
): Promise<{ readonly state: string; readonly period_id: string } | null> {
  const row = await uow.query
    .selectFrom('schedule_versions')
    .select(['state', 'period_id'])
    .where('id', '=', versionId)
    .executeTakeFirst();
  return row === undefined ? null : { state: row.state, period_id: row.period_id };
}

/** Whether the schedule period the version belongs to contains the round's weeks. */
async function versionCoversPeriod(
  uow: Uow,
  schedulePeriodId: string,
  roundStart: string,
  roundEnd: string,
): Promise<boolean> {
  const row = await uow.query
    .selectFrom('schedule_periods')
    .select([
      sql<string>`to_char(start_date, 'YYYY-MM-DD')`.as('start_date'),
      sql<string>`to_char(end_date, 'YYYY-MM-DD')`.as('end_date'),
    ])
    .where('id', '=', schedulePeriodId)
    .executeTakeFirst();
  if (row === undefined) return false;
  return row.start_date <= roundStart && row.end_date >= roundEnd;
}

/**
 * The group's OFF shift type — `shift_types.is_leave_of_absence`.
 *
 * That flag is migration 0005's (ADM-07) and it is the vocabulary this product
 * already has for "a day that is not work". A commit does not CREATE one: the
 * catalogue is a scheduler's configuration, and a commit that authored a shift
 * type would be a commit that changed the group's catalogue as a side effect of
 * a vacation round. A group with none gets `COMMIT_NO_OFF_SHIFT_TYPE`.
 *
 * The lowest `report_order` then the id, so a group with several
 * leave-of-absence types commits into the same one every time and a re-run
 * produces the same schedule. `status = 'active'` because a retired shift type
 * is not a thing to newly assign anybody to.
 */
async function loadOffShiftType(uow: Uow): Promise<
  | {
      readonly id: string;
      readonly start_time: string;
      readonly end_time: string;
    }
  | null
> {
  const row = await uow.query
    .selectFrom('shift_types')
    .select(['id', 'start_time', 'end_time'])
    .where('is_leave_of_absence', '=', true)
    .where('status', '=', 'active')
    .orderBy('report_order')
    .orderBy('id')
    .executeTakeFirst();
  return row === undefined
    ? null
    : { id: row.id, start_time: String(row.start_time), end_time: String(row.end_time) };
}

/**
 * **§5.5's reversal arithmetic, on the committed week's grant.**
 *
 * One unit back, and the override it was authorised under with it (R-20) — so
 * the bound returns to its pre-override value and *"an override cannot silently
 * persist as headroom for a later approval"*. `countersAfterReversal` is the
 * arithmetic and the store writes the DELTAS it implies, so the pure function
 * and the statement cannot disagree about the result.
 *
 * **The floor is the database's** (R-08). `CHECK (units_consumed >= 0)` is
 * unconditional and REFUSES the row rather than clamping it, which is §5.5's
 * instruction verbatim: *"a reversal that would go below zero is rejected as a
 * data error"*. A `WHERE units_consumed >= :units` here would turn that data
 * error into a silent no-op.
 *
 * **Open mode is a no-op by the same branch §5.4 uses** (V-30): there is no
 * grant row, `selection.grantId` is null, and nothing is released because
 * nothing was consumed.
 */
async function releaseCommittedUnit(
  uow: Uow,
  selection: VacationSelectionRecord,
): Promise<boolean> {
  if (selection.grantId === null) return false;
  const grants = await vacationStore.listGrants(uow, selection.vacationPeriodId);
  const grant = grants.find((candidate) => candidate.id === selection.grantId);
  if (grant === undefined) return false;

  const after = countersAfterReversal(grant, 1);
  const releasedOverride = grant.overrideUnits - after.overrideUnits;
  const newVersion = await vacationStore.releaseGrantUnits(uow, {
    grantId: grant.id,
    expectedVersion: grant.version,
    units: 1,
    overrideUnits: selection.isOverride ? releasedOverride : 0,
  });
  if (newVersion === null) throw new VacationReversalRolledBack('REVERSAL_GRANT_CONFLICT');
  return true;
}

/**
 * §5.6's override capability, evaluated in THIS transaction (I-19, FAD-12).
 *
 * `vacation.override_quota` — §5.6 says *"the override capability"*, and the
 * definite article points at §5.5's, which is this one. Reversal is exactly what
 * that capability is for: authorising an audited deviation from the quota rules,
 * here in the downward direction.
 *
 * `requiresObjectPolicy: false` for the reason the approval side gives: L5.1
 * asks about a TARGET's owner, and this is a power over a quota rather than over
 * a person's row. The row-level question was answered by the route's own
 * evaluation and by RLS.
 */
async function actorHoldsOverride(uow: Uow, actor: EvaluationContext): Promise<boolean> {
  const { decision } = await evaluateAction(uow.query, {
    context: actor,
    action: {
      key: 'vacation.override_quota',
      moduleKey: 'requests_vacation',
      scope: 'group',
      requiresObjectPolicy: false,
    },
    target: null,
  });
  return decision.allowed;
}
