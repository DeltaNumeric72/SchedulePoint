import {
  VACATION_APPROVAL_ROOT_PATH,
  VACATION_DENIAL_ROOT_PATH,
  approvalConsumesQuota,
  grantHasHeadroom,
  overrideUnitsNeeded,
  type EvaluationContext,
  type UnitOfWork,
  type VacationApprovalFailure,
  type VacationApprovalOutcome,
  type VacationGrant,
  type VacationSelectionRecord,
} from '@schedulepoint/domain';
import type { Kysely } from 'kysely';

import { evaluateAction } from '../authz/authorize-request.js';
import { recordAuditEvent } from '../audit/recorder.js';
import type { Database } from '../db/schema.js';
import { publishOutboxEvent } from '../outbox/publisher.js';

import { requestStore } from './store.js';
import { vacationStore } from './vacation-store.js';

/**
 * SPEC-08 §5.4 and §5.5 — `APPROVE-VACATION`, the transaction (OPUS-M5-002,
 * doc 42 §5d Part B).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## §5.4's steps, in §5.4's order, and why each guard is where it is
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ```
 *   0. D-26 idempotency — the FIRST effect, before any other
 *   1. mode branch (V-30): quota consumes a unit; open skips the grant entirely
 *   2. the GUARDED selection update (V-29): status='pending' AND version
 *   3. the derived root status (§5.3), as the BINDING TWO-STEP
 *      INSERT approvals; INSERT audit_events; INSERT outbox_events
 *      UPDATE vacation_approval_commands SET outcome
 * ```
 *
 * ## The two-step is not a liberty taken with §5.4
 *
 * §5.4 step 3 prints `UPDATE requests SET status = 'approved'`, and **that
 * spelling is refused by §2's own matrix** — there is no `submitted → approved`
 * cell for `vacation-selection` or for anything else, and migration 0021's
 * `app_guard_request_transition` implements §2 literally. M5-000b proved it by
 * test and doc 42 §5d carries the finding as BINDING: the implementable writer is
 * `submitted → under_review → approved` inside ONE transaction, and the same for
 * a denial.
 *
 * **Deferred D-27 is what makes that legal, and it is load-bearing rather than
 * incidental.** `requests_guard_vacation_status_mapping` is a CONSTRAINT trigger
 * evaluated at COMMIT against CURRENT rows, so the intermediate `under_review` —
 * which §5.3's mapping never produces — is never seen. A non-deferred copy of the
 * same trigger would make §5.4 impossible to implement at all.
 *
 * ## What ROLLS BACK, and the declared decision behind it
 *
 * §5.4 says of step 2's zero rows: "**The whole transaction ROLLS BACK**, so a
 * unit consumed at step 1 is released with it." This implementation extends that
 * to EVERY non-approved outcome, and the extension is a declared decision:
 *
 *   * Step 0's command row is itself an effect. If a failed attempt committed it
 *     with `outcome = 'quota_exhausted'`, then D-26 would return that recorded
 *     outcome forever and **the same key could never be retried** — so a
 *     scheduler who raised the quota and retried would be told the quota was
 *     exhausted, by a ledger row, indefinitely.
 *   * D-26's purpose is that a retry must not consume a SECOND unit. A first
 *     attempt that consumed nothing and a retry that consumes one is that rule
 *     working, not a violation of it.
 *
 * **The consequence, stated rather than left to be found:** three of the five
 * values in `vacation_approval_commands.outcome`'s domain —
 * `quota_exhausted`, `version_conflict`, `selection_not_pending` — are
 * unreachable through this writer, because the transactions that would record
 * them roll back. The column's domain is 0022's and is not narrowed; if a future
 * packet wants failure telemetry it needs a write outside this transaction, which
 * is a design question and not a line to add here.
 *
 * A rollback is spelled by THROWING `VacationApprovalRolledBack`: the unit-of-work
 * runner owns the transaction boundary (I-15, non-bypass rule 1), so a service
 * cannot end one early and must not try. The route catches the typed error and
 * answers from `failure`.
 *
 * ## The override is a SECOND authorization, in the same snapshot
 *
 * `vacation.override_quota` is not the route's action key — the route's action is
 * the approval — so it is evaluated here, through `evaluateAction`, against the
 * same transaction the write happens in (I-19, FAD-12). That is what gives the
 * key an evaluator at all: it existed in the catalogue from M1 with no reader
 * anywhere, so a grant of it was inert.
 *
 * ## I-07
 *
 * §5.5's override reason is stored on `vacation_selections.override_reason` and
 * on the `approvals` row, and **enters no payload**. Every payload below is ids
 * and tokens; the validator would refuse prose regardless.
 */

type Uow = UnitOfWork<Kysely<Database>>;

/**
 * Raised to roll the transaction back after an effect has been written.
 *
 * A thrown error rather than a returned failure, because §5.4's requirement is
 * that the unit consumed at step 1 is RELEASED — and the only thing that releases
 * it is the transaction not committing. Returning a failure would leave the
 * consumed unit and the command row behind.
 */
export class VacationApprovalRolledBack extends Error {
  readonly code = 'VACATION_APPROVAL_ROLLED_BACK';

  constructor(readonly failure: VacationApprovalFailure) {
    super(`VACATION_APPROVAL_ROLLED_BACK: ${failure}`);
  }
}

export interface VacationDecisionCommand {
  readonly selectionId: string;
  /** D-26's key. The same key twice consumes nothing the second time. */
  readonly approvalIdempotencyKey: string;
  /** V-29: the SELECTION's version, not the grant's. That confusion was the defect. */
  readonly expectedSelectionVersion: number;
  /** Quota mode only. Resolved from the period's grants when absent. */
  readonly grantId?: string;
  readonly expectedGrantVersion?: number;
  /** §5.5's mandatory reason, when the approval exceeds the bound. */
  readonly overrideReason?: string;
  readonly decidedBy: string;
  readonly now: Date;
  /** For the override's second evaluation. The route's verified tuple. */
  readonly actor: EvaluationContext;
}

export interface VacationDecisionResult {
  readonly selectionId: string;
  readonly requestId: string;
  readonly outcome: VacationApprovalOutcome;
  readonly selectionVersion: number;
  readonly grantId: string | null;
  readonly isOverride: boolean;
  /** True when D-26 stopped this at step 0: nothing was consumed, nothing emitted. */
  readonly replayed: boolean;
}

/* ────────────────────────────────────────────────────────────────────────────
 * §5.4
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * **`APPROVE-VACATION` (SPEC-08 §5.4), as amended by V-28, V-29 and V-30.**
 *
 * Returns a result, or throws `VacationApprovalRolledBack` — see the header on
 * which outcomes roll back and why.
 */
export async function approveVacationSelection(
  uow: Uow,
  command: VacationDecisionCommand,
): Promise<VacationDecisionResult> {
  /* ── 0. D-26 idempotency, FIRST, before any effect ──────────────────────── */
  const commandId = await vacationStore.recordApprovalCommand(uow, {
    selectionId: command.selectionId,
    approvalIdempotencyKey: command.approvalIdempotencyKey,
  });
  if (commandId === null) {
    /* A REPLAY. §5.4's instruction is exact: return the recorded outcome,
     * consume no unit, emit no event, write no approval row. R-17. */
    return replayOutcome(uow, command);
  }

  const selection = await loadPendingSelection(uow, command.selectionId);
  const period = await vacationStore.loadPeriod(uow, selection.vacationPeriodId);
  if (period === null) throw new VacationApprovalRolledBack('SELECTION_NOT_PENDING');

  /* ── 1. The mode branch (V-30) ──────────────────────────────────────────── */
  let resolvedGrantId: string | null = null;
  let isOverride = false;
  let overrideReason: string | null = null;

  if (approvalConsumesQuota(period.mode)) {
    const grant = await resolveGrant(uow, selection, command);
    resolvedGrantId = grant.id;
    let grantVersion = command.expectedGrantVersion ?? grant.version;

    if (!grantHasHeadroom(grant)) {
      /* ── §5.5's over-quota path ─────────────────────────────────────────
       * R-06: refused WITHOUT the override capability. R-07: with it, and with
       * a mandatory reason, the audited path raises the BOUND in this same
       * transaction — the CHECK is never suspended. */
      if (!(await actorHoldsOverride(uow, command.actor))) {
        throw new VacationApprovalRolledBack('OVERRIDE_REQUIRED');
      }
      const reason = command.overrideReason?.trim() ?? '';
      if (reason.length === 0) {
        throw new VacationApprovalRolledBack('OVERRIDE_REASON_REQUIRED');
      }

      const raised = await vacationStore.raiseOverrideUnits(uow, {
        grantId: grant.id,
        expectedVersion: grantVersion,
        units: overrideUnitsNeeded(grant, 1),
      });
      if (raised === null) throw new VacationApprovalRolledBack('VERSION_CONFLICT');
      grantVersion = raised;
      isOverride = true;
      overrideReason = reason;
    }

    const consumed = await vacationStore.consumeGrantUnit(uow, {
      grantId: grant.id,
      expectedVersion: grantVersion,
    });
    if (consumed === null) {
      /* §5.4: "zero rows => QUOTA_EXHAUSTED or VERSION_CONFLICT."
       *
       * The two are told apart by RE-READING the grant, and exhaustion wins the
       * tie. That ordering is R-05's requirement — "the loser receives
       * `QUOTA_EXHAUSTED`" — and it is also the truthful classification: under
       * READ COMMITTED the loser's UPDATE blocked on the winner's row lock, then
       * re-evaluated its `WHERE` against the winner's committed row, and this
       * re-read sees that same row with no headroom left. A version check that
       * answered `VERSION_CONFLICT` first would tell the loser to retry a thing
       * that cannot succeed. */
      const fresh = await findGrant(uow, selection, grant.id);
      throw new VacationApprovalRolledBack(
        fresh !== null && !grantHasHeadroom(fresh) ? 'QUOTA_EXHAUSTED' : 'VERSION_CONFLICT',
      );
    }
  }
  /* `open` mode: `resolvedGrantId` stays null and no grant statement ran at all
   * (V-30). The approval capability was still required and an approval row is
   * still written — what is absent is the quota, not the decision. */

  /* ── 2. The guarded selection update (V-29) ─────────────────────────────── */
  const selectionVersion = await vacationStore.decideSelection(uow, {
    selectionId: command.selectionId,
    expectedSelectionVersion: command.expectedSelectionVersion,
    status: 'approved',
    grantId: resolvedGrantId,
    isOverride,
    overrideReason,
    approvalIdempotencyKey: command.approvalIdempotencyKey,
  });
  if (selectionVersion === null) {
    /* R-18/R-19. The unit consumed at step 1 is released by the rollback, so no
     * unit is ever consumed without an approval and no approval consumes two. */
    throw new VacationApprovalRolledBack('SELECTION_NOT_PENDING');
  }

  /* ── 3. The derived root status, the BINDING two-step, same transaction ─── */
  const requestId = selection.requestId;
  if (requestId === null) {
    /* Unreachable: a `pending` selection has a root by
     * `vacation_selections_request_present_unless_available`. Written rather than
     * asserted away, because a cast is what turns "the constraint was dropped"
     * into an undiagnosable field error. */
    throw new VacationApprovalRolledBack('SELECTION_NOT_PENDING');
  }
  const rootVersion = await vacationStore.writeDerivedRootStatus(uow, {
    requestId,
    path: VACATION_APPROVAL_ROOT_PATH,
    decidedBy: command.decidedBy,
    decidedAt: command.now,
  });
  if (rootVersion === null) throw new VacationApprovalRolledBack('SELECTION_NOT_PENDING');

  await requestStore.recordApproval(uow, {
    requestId,
    decision: 'approved',
    decidedBy: command.decidedBy,
    decidedAt: command.now,
    reason: overrideReason,
    isOverride,
    vacationSelectionId: command.selectionId,
    supersedesApprovalId: null,
  });

  const audit = await recordAuditEvent(uow, {
    eventName: 'requests.vacation_selection.approved',
    subjectType: 'request',
    subjectId: requestId,
    /* Ids, booleans and tokens. No reason, no date, no week — the row carries
     * those, and a payload that repeated them would be a second copy in the one
     * place I-07 forbids free text (non-bypass rule 9). */
    payload: {
      requestId,
      selectionId: command.selectionId,
      isOverride,
      quotaMode: period.mode,
    },
  });
  await publishOutboxEvent(uow, audit, {
    kind: 'requests.vacation_selection.approved',
    idempotencyKey: `vacation-approved:${command.selectionId}:${command.approvalIdempotencyKey}`,
    payload: { requestId, selectionId: command.selectionId, isOverride },
  });

  await vacationStore.setApprovalCommandOutcome(uow, { commandId, outcome: 'approved' });

  return {
    selectionId: command.selectionId,
    requestId,
    outcome: 'approved',
    selectionVersion,
    grantId: resolvedGrantId,
    isOverride,
    replayed: false,
  };
}

/**
 * **The denial half of §5.4/§5.5.**
 *
 * The same shape with the grant branch removed, because **a denial consumes
 * nothing**: there is no unit to take and no bound to raise. What it shares with
 * the approval is everything that makes the transaction correct — D-26 at step 0,
 * the guarded selection update, and the BINDING two-step on the derived root
 * status, which §2 refuses to spell in one statement for a denial exactly as it
 * does for an approval.
 *
 * §4's mandatory reason applies: a denial states one.
 */
export async function denyVacationSelection(
  uow: Uow,
  command: VacationDecisionCommand & { readonly reason: string },
): Promise<VacationDecisionResult> {
  /* §4's mandatory denial reason, checked before any effect.
   *
   * The failure code is `OVERRIDE_REASON_REQUIRED`, and the reuse is deliberate
   * rather than sloppy: that member means "a reason this specification makes
   * MANDATORY is missing", and a denial's reason and an override's reason are
   * mandatory for the same reason and have the same remedy — supply one. A
   * distinct code would be a new wire-visible value with no distinct remedy
   * behind it, which is a vocabulary that grew without meaning.
   *
   * This guard is unreachable through the route, where `denyVacationSelection`'s
   * body schema already requires a trimmed non-empty reason, and unreachable
   * through the database, where `approvals_reason_mandatory_where_stated` refuses
   * the row. It is written anyway because a service that relied on its callers
   * would be one whose next caller is the one that does not. */
  if (command.reason.trim().length === 0) {
    throw new VacationApprovalRolledBack('OVERRIDE_REASON_REQUIRED');
  }

  const commandId = await vacationStore.recordApprovalCommand(uow, {
    selectionId: command.selectionId,
    approvalIdempotencyKey: command.approvalIdempotencyKey,
  });
  if (commandId === null) return replayOutcome(uow, command);

  const selection = await loadPendingSelection(uow, command.selectionId);

  const selectionVersion = await vacationStore.decideSelection(uow, {
    selectionId: command.selectionId,
    expectedSelectionVersion: command.expectedSelectionVersion,
    status: 'denied',
    grantId: null,
    isOverride: false,
    overrideReason: null,
    approvalIdempotencyKey: command.approvalIdempotencyKey,
  });
  if (selectionVersion === null) {
    throw new VacationApprovalRolledBack('SELECTION_NOT_PENDING');
  }

  const requestId = selection.requestId;
  if (requestId === null) throw new VacationApprovalRolledBack('SELECTION_NOT_PENDING');

  const rootVersion = await vacationStore.writeDerivedRootStatus(uow, {
    requestId,
    path: VACATION_DENIAL_ROOT_PATH,
    decidedBy: command.decidedBy,
    decidedAt: command.now,
  });
  if (rootVersion === null) throw new VacationApprovalRolledBack('SELECTION_NOT_PENDING');

  await requestStore.recordApproval(uow, {
    requestId,
    decision: 'denied',
    decidedBy: command.decidedBy,
    decidedAt: command.now,
    reason: command.reason,
    isOverride: false,
    vacationSelectionId: command.selectionId,
    supersedesApprovalId: null,
  });

  const audit = await recordAuditEvent(uow, {
    eventName: 'requests.request.denied',
    subjectType: 'request',
    subjectId: requestId,
    payload: {
      requestId,
      subtype: 'vacation-selection',
      decision: 'denied',
      fromStatus: 'submitted',
      toStatus: 'denied',
    },
  });
  await publishOutboxEvent(uow, audit, {
    kind: 'requests.request.denied',
    idempotencyKey: `vacation-denied:${command.selectionId}:${command.approvalIdempotencyKey}`,
    payload: { requestId, subtype: 'vacation-selection', decision: 'denied' },
  });

  await vacationStore.setApprovalCommandOutcome(uow, { commandId, outcome: 'denied' });

  return {
    selectionId: command.selectionId,
    requestId,
    outcome: 'denied',
    selectionVersion,
    grantId: null,
    isOverride: false,
    replayed: false,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * The pieces both halves share
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * D-26's replay answer (R-17).
 *
 * The command row exists, so a previous attempt reached step 0 with this key.
 * **Nothing is consumed, nothing is emitted, no approval row is written** — the
 * selection is read back and its recorded state is returned. A replay that
 * emitted an event would make "how many times was this approved" unanswerable,
 * which is the same reason M5-001's replayed submission emits nothing.
 */
async function replayOutcome(
  uow: Uow,
  command: VacationDecisionCommand,
): Promise<VacationDecisionResult> {
  const recorded = await vacationStore.findApprovalCommand(
    uow,
    command.selectionId,
    command.approvalIdempotencyKey,
  );
  const selection = await vacationStore.loadSelection(uow, command.selectionId);
  if (recorded === null || selection === null || selection.requestId === null) {
    /* The ledger row was inserted by a transaction that has not committed, or the
     * selection is invisible here. Neither is an outcome to report as recorded. */
    throw new VacationApprovalRolledBack('SELECTION_NOT_PENDING');
  }
  return {
    selectionId: command.selectionId,
    requestId: selection.requestId,
    outcome: recorded.outcome ?? 'approved',
    selectionVersion: selection.version,
    grantId: selection.grantId,
    isOverride: selection.isOverride,
    replayed: true,
  };
}

/** The selection, or a rollback. `pending` is checked by step 2's guard, not here. */
async function loadPendingSelection(
  uow: Uow,
  selectionId: string,
): Promise<VacationSelectionRecord> {
  const selection = await vacationStore.loadSelection(uow, selectionId);
  if (selection === null) throw new VacationApprovalRolledBack('SELECTION_NOT_PENDING');
  return selection;
}

/**
 * The grant this approval consumes from, in quota mode.
 *
 * A caller may name one (§5.4's signature takes `expected_grant_version?`); when
 * it does not, the personal entitlement for this membership is resolved from the
 * period's grants. A period with grants but none for this member is
 * `QUOTA_EXHAUSTED` rather than an error: the member has no allowance in this
 * round, which is the same fact as having used it all, and telling the two apart
 * across a queue would disclose another member's allowance.
 */
async function resolveGrant(
  uow: Uow,
  selection: VacationSelectionRecord,
  command: VacationDecisionCommand,
): Promise<VacationGrant> {
  const grants = await vacationStore.listGrants(uow, selection.vacationPeriodId);
  const found =
    command.grantId === undefined
      ? grants.find(
          (grant) =>
            grant.kind === 'personal-entitlement' && grant.membershipId === selection.membershipId,
        )
      : grants.find((grant) => grant.id === command.grantId);
  if (found === undefined) throw new VacationApprovalRolledBack('QUOTA_EXHAUSTED');
  return found;
}

/** The same grant, re-read after a failed consume. `null` when it is gone. */
async function findGrant(
  uow: Uow,
  selection: VacationSelectionRecord,
  grantId: string,
): Promise<VacationGrant | null> {
  const grants = await vacationStore.listGrants(uow, selection.vacationPeriodId);
  return grants.find((grant) => grant.id === grantId) ?? null;
}

/**
 * **§5.5's override capability, evaluated in THIS transaction.**
 *
 * Not the route's action key — the route's action is the approval — so it is a
 * second evaluation, from the same snapshot as the write (I-19, FAD-12). One
 * evaluator on every path (SPEC-06 §7): this calls `evaluateAction`, the same
 * function the HTTP wrapper and the job worker call.
 *
 * `requiresObjectPolicy: false`: L5.1 asks about a TARGET's owner, and the
 * override is a power over a quota rather than over a person's row. The row-level
 * question was already answered by the route's own evaluation and by RLS.
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
