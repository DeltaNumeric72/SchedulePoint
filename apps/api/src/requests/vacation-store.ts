import type {
  NewVacationSelection,
  RequestStatus,
  UnitOfWork,
  VacationApprovalCommand,
  VacationApprovalOutcome,
  VacationGrant,
  VacationPeriod,
  VacationSelectionRecord,
  VacationSelectionStatus,
  VacationStore,
} from '@schedulepoint/domain';
import { sql, type Kysely } from 'kysely';

import type { Database } from '../db/schema.js';

/**
 * `VacationStore` over PostgreSQL — the port
 * `packages/domain/src/requests/port.ts` declares, implemented (OPUS-M5-002,
 * doc 42 §5d Part B).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## §5.3's ONE WRITER, expressed as a file
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * > **One writer.** Only the vacation module updates either status. No other
 * > module writes `requests.status` for a `vacation-selection` row, and the
 * > vacation module never writes one without the other.
 *
 * Both halves are structural here rather than remembered:
 *
 *  * `PgRequestStore` has no verb that can write the root of a vacation
 *    selection — its `decide` is reachable only from the §4 decision service,
 *    which refuses `vacation-selection` before it is called, and its `create`
 *    union has no vacation member at all.
 *  * `writeDerivedRootStatus` lives HERE, beside `decideSelection`, so the two
 *    writes are one file's responsibility and a reader checking "does every
 *    selection write have a root write in the same transaction" reads one module.
 *
 * D-27 is the enforcement behind both: a deferred constraint trigger on each
 * side, evaluated at COMMIT, raising if `requests.status` is not the §5.3 mapping
 * of `vacation_selections.status`.
 *
 * ## Every method is ONE statement, deliberately
 *
 * §5.4's correctness is entirely in which statement runs and what its `WHERE`
 * says — V-29 was three defects in exactly those clauses and V-30 was a missing
 * branch around one of them. A store that offered one `approveVacation` method
 * would hide the shape those amendments fixed. The transaction that sequences
 * them is `./vacation-approval.ts`.
 *
 * ## The unit of work, and no other handle
 *
 * I-15, as in every other store: no method opens a transaction, the runner owns
 * the boundary, and there is no way to reach these tables outside
 * transaction-local tenant context where RLS returns zero rows.
 */

type Uow = UnitOfWork<Kysely<Database>>;

/* ────────────────────────────────────────────────────────────────────────────
 * Row shapes
 * ──────────────────────────────────────────────────────────────────────────── */

interface PeriodRow {
  readonly id: string;
  readonly organization_id: string;
  readonly group_id: string;
  readonly start_date: string;
  readonly end_date: string;
  readonly mode: 'quota' | 'open';
  readonly state: 'draft' | 'open' | 'closed' | 'archived';
  readonly version: number;
}

interface GrantRow {
  readonly id: string;
  readonly organization_id: string;
  readonly group_id: string;
  readonly vacation_period_id: string;
  readonly kind: 'personal-entitlement' | 'weekly-capacity';
  readonly membership_id: string | null;
  readonly week_start: string | null;
  readonly units_total: number;
  readonly units_consumed: number;
  readonly override_units: number;
  readonly version: number;
}

interface SelectionRow {
  readonly id: string;
  readonly request_id: string | null;
  readonly membership_id: string;
  readonly vacation_period_id: string;
  readonly week_start: string;
  readonly status: VacationSelectionStatus;
  readonly version: number;
  readonly grant_id: string | null;
  readonly is_override: boolean;
  readonly override_reason: string | null;
  readonly approval_idempotency_key: string | null;
  readonly committed_to_version_id: string | null;
  readonly commit_idempotency_key: string | null;
}

interface CommandRow {
  readonly id: string;
  readonly organization_id: string;
  readonly group_id: string;
  readonly selection_id: string;
  readonly approval_idempotency_key: string;
  readonly received_at: Date;
  readonly outcome: VacationApprovalOutcome | null;
}

function toPeriod(row: PeriodRow): VacationPeriod {
  return {
    id: row.id,
    organizationId: row.organization_id,
    groupId: row.group_id,
    startDate: row.start_date,
    endDate: row.end_date,
    mode: row.mode,
    state: row.state,
    version: row.version,
  };
}

/**
 * A grant row as the discriminated union the domain declares.
 *
 * The `kind` branch is not a formality: `vacation_grants_kind_shape` makes the
 * other two column combinations unrepresentable, so a row whose `kind` says
 * `personal-entitlement` necessarily carries a `membership_id`. The `??` fallback
 * exists because the ROW TYPE cannot say so and a cast is what turns "the
 * constraint was dropped" into an undiagnosable field error later.
 */
function toGrant(row: GrantRow): VacationGrant {
  const common = {
    id: row.id,
    organizationId: row.organization_id,
    groupId: row.group_id,
    vacationPeriodId: row.vacation_period_id,
    unitsTotal: row.units_total,
    unitsConsumed: row.units_consumed,
    overrideUnits: row.override_units,
    version: row.version,
  };
  return row.kind === 'personal-entitlement'
    ? { ...common, kind: 'personal-entitlement', membershipId: row.membership_id ?? '' }
    : { ...common, kind: 'weekly-capacity', weekStart: row.week_start ?? '' };
}

function toSelection(row: SelectionRow): VacationSelectionRecord {
  return {
    subtype: 'vacation-selection',
    id: row.id,
    requestId: row.request_id,
    membershipId: row.membership_id,
    vacationPeriodId: row.vacation_period_id,
    weekStart: row.week_start,
    status: row.status,
    version: row.version,
    grantId: row.grant_id,
    isOverride: row.is_override,
    overrideReason: row.override_reason,
    approvalIdempotencyKey: row.approval_idempotency_key,
    committedToVersionId: row.committed_to_version_id,
    commitIdempotencyKey: row.commit_idempotency_key,
  };
}

function toCommand(row: CommandRow): VacationApprovalCommand {
  return {
    id: row.id,
    organizationId: row.organization_id,
    groupId: row.group_id,
    selectionId: row.selection_id,
    approvalIdempotencyKey: row.approval_idempotency_key,
    receivedAt: row.received_at,
    outcome: row.outcome,
  };
}

/**
 * A `date` column, cast in the database so the declared `string` type holds.
 *
 * `date` columns come back from node-postgres as JavaScript `Date` objects, and
 * every one of these is a calendar date the domain types declare as a
 * `YYYY-MM-DD` string. Casting in the database is what makes those declarations
 * true at runtime — `requests/store.ts` records the same reason.
 */
const dateText = <T extends string>(column: T) => sql<string>`${sql.ref(column)}::text`.as(column);
const dateTextNullable = <T extends string>(column: T) =>
  sql<string | null>`${sql.ref(column)}::text`.as(column);

const SELECTION_COLUMNS = [
  'id',
  'request_id',
  'membership_id',
  'vacation_period_id',
  'status',
  'version',
  'grant_id',
  'is_override',
  'override_reason',
  'approval_idempotency_key',
  'committed_to_version_id',
  'commit_idempotency_key',
] as const;

export class PgVacationStore implements VacationStore {
  async loadPeriod(uow: Uow, periodId: string): Promise<VacationPeriod | null> {
    const row = await uow.query
      .selectFrom('vacation_periods')
      .select([
        'id',
        'organization_id',
        'group_id',
        dateText('start_date'),
        dateText('end_date'),
        'mode',
        'state',
        'version',
      ])
      .where('id', '=', periodId)
      .executeTakeFirst();
    return row === undefined ? null : toPeriod(row as PeriodRow);
  }

  /**
   * The grants for a period.
   *
   * **Empty in `open` mode, and that is not an error** — V-30: open mode has no
   * `vacation_grants` rows at all, and the previous design's unconditional grant
   * update is precisely why open-mode approval always failed. A caller that
   * treats "no grants" as "quota exhausted" is reintroducing that defect, which
   * is why `approvalConsumesQuota` branches on the PERIOD's mode rather than on
   * whether this list came back empty.
   */
  async listGrants(uow: Uow, periodId: string): Promise<readonly VacationGrant[]> {
    const rows = await uow.query
      .selectFrom('vacation_grants')
      .select([
        'id',
        'organization_id',
        'group_id',
        'vacation_period_id',
        'kind',
        'membership_id',
        dateTextNullable('week_start'),
        'units_total',
        'units_consumed',
        'override_units',
        'version',
      ])
      .where('vacation_period_id', '=', periodId)
      .orderBy('id')
      .execute();
    return rows.map((row) => toGrant(row as GrantRow));
  }

  async loadSelection(uow: Uow, selectionId: string): Promise<VacationSelectionRecord | null> {
    const row = await uow.query
      .selectFrom('vacation_selections')
      .select([...SELECTION_COLUMNS, dateText('week_start')])
      .where('id', '=', selectionId)
      .executeTakeFirst();
    return row === undefined ? null : toSelection(row as unknown as SelectionRow);
  }

  async findSelection(
    uow: Uow,
    membershipId: string,
    periodId: string,
    weekStart: string,
  ): Promise<VacationSelectionRecord | null> {
    const row = await uow.query
      .selectFrom('vacation_selections')
      .select([...SELECTION_COLUMNS, dateText('week_start')])
      .where('membership_id', '=', membershipId)
      .where('vacation_period_id', '=', periodId)
      .where('week_start', '=', weekStart)
      .executeTakeFirst();
    return row === undefined ? null : toSelection(row as unknown as SelectionRow);
  }

  /** Records a selection in `available` — no request row yet (§5.3). */
  async createSelection(uow: Uow, selection: NewVacationSelection): Promise<string> {
    const { organizationId, groupId } = uow.context;
    const row = await uow.query
      .insertInto('vacation_selections')
      .values({
        organization_id: organizationId,
        group_id: groupId as string,
        request_id: null,
        membership_id: selection.membershipId,
        vacation_period_id: selection.vacationPeriodId,
        week_start: selection.weekStart,
        status: 'available',
      })
      .returning('id')
      .executeTakeFirst();
    if (row === undefined) {
      throw new Error('VACATION_SELECTION_INSERT_PRODUCED_NO_ROW: the insert returned nothing.');
    }
    return row.id;
  }

  async findApprovalCommand(
    uow: Uow,
    selectionId: string,
    approvalIdempotencyKey: string,
  ): Promise<VacationApprovalCommand | null> {
    const row = await uow.query
      .selectFrom('vacation_approval_commands')
      .select([
        'id',
        'organization_id',
        'group_id',
        'selection_id',
        'approval_idempotency_key',
        'received_at',
        'outcome',
      ])
      .where('selection_id', '=', selectionId)
      .where('approval_idempotency_key', '=', approvalIdempotencyKey)
      .executeTakeFirst();
    return row === undefined ? null : toCommand(row as CommandRow);
  }

  async listSelectionsByStatus(
    uow: Uow,
    periodId: string,
    status: VacationSelectionStatus,
  ): Promise<readonly VacationSelectionRecord[]> {
    const rows = await uow.query
      .selectFrom('vacation_selections')
      .select([...SELECTION_COLUMNS, dateText('week_start')])
      .where('vacation_period_id', '=', periodId)
      .where('status', '=', status)
      .orderBy('week_start')
      .orderBy('id')
      .execute();
    return rows.map((row) => toSelection(row as unknown as SelectionRow));
  }

  /* ──────────────────────────────────────────────────────────────────────────
   * §5.4's steps, in the order the specification prints them
   * ────────────────────────────────────────────────────────────────────────── */

  /**
   * **Step 0 — D-26.** `ON CONFLICT … DO NOTHING`, before any effect.
   *
   * `null` is a REPLAY, and §5.4's instruction for it is exact: return the
   * recorded outcome, consume no unit, emit no event, write no approval row. The
   * unique constraint is what makes that binding when two deliveries race — one
   * of them inserts, the other gets `null` and reads what the winner recorded.
   */
  async recordApprovalCommand(
    uow: Uow,
    command: { readonly selectionId: string; readonly approvalIdempotencyKey: string },
  ): Promise<string | null> {
    const { organizationId, groupId } = uow.context;
    const row = await uow.query
      .insertInto('vacation_approval_commands')
      .values({
        organization_id: organizationId,
        group_id: groupId as string,
        selection_id: command.selectionId,
        approval_idempotency_key: command.approvalIdempotencyKey,
        outcome: null,
      })
      .onConflict((conflict) =>
        conflict
          .columns(['selection_id', 'approval_idempotency_key', 'organization_id'])
          .doNothing(),
      )
      .returning('id')
      .executeTakeFirst();
    return row?.id ?? null;
  }

  /**
   * **Step 1 — consume one unit, under D-21's raised bound.**
   *
   * The three-part `WHERE` is §5.4's, character for character. The third clause
   * is the arbiter of R-05's race: two concurrent approvals for the last unit
   * both pass any pre-check a caller made, and exactly one of them passes this
   * predicate — the other's `UPDATE` matches no row and the caller answers
   * `QUOTA_EXHAUSTED`. The unconditional CHECK is what makes the same true of a
   * path that never called this method (R-21, proven at M5-000b; not re-proven
   * here and never weakened).
   */
  async consumeGrantUnit(
    uow: Uow,
    command: { readonly grantId: string; readonly expectedVersion: number },
  ): Promise<number | null> {
    const row = await uow.query
      .updateTable('vacation_grants')
      .set({
        units_consumed: sql<number>`units_consumed + 1`,
        version: sql<number>`version + 1`,
        updated_at: sql<Date>`now()`,
      })
      .where('id', '=', command.grantId)
      .where('version', '=', command.expectedVersion)
      .where(sql<boolean>`units_consumed < units_total + override_units`)
      .returning('version')
      .executeTakeFirst();
    return row?.version ?? null;
  }

  /**
   * **§5.5's audited override — the BOUND rises; the CHECK never moves.**
   *
   * `units` is what `overrideUnitsNeeded` computed: the shortfall and no more, so
   * an override leaves no headroom behind it beyond what it authorised. §5.5's
   * reversal row is the other half — an override "cannot silently persist as
   * headroom for a later approval" — and the two together are R-20.
   */
  async raiseOverrideUnits(
    uow: Uow,
    command: {
      readonly grantId: string;
      readonly expectedVersion: number;
      readonly units: number;
    },
  ): Promise<number | null> {
    const row = await uow.query
      .updateTable('vacation_grants')
      .set({
        override_units: sql<number>`override_units + ${command.units}`,
        version: sql<number>`version + 1`,
        updated_at: sql<Date>`now()`,
      })
      .where('id', '=', command.grantId)
      .where('version', '=', command.expectedVersion)
      .returning('version')
      .executeTakeFirst();
    return row?.version ?? null;
  }

  /**
   * **Step 2 — the guarded selection update (V-29).**
   *
   * `status = 'pending'` and `version = :expectedSelectionVersion`, both. Before
   * V-29 neither was there and the version checked was the GRANT's, so a
   * duplicate approval — a retry, a double click, an at-least-once delivery —
   * consumed a second quota unit inside the transaction whose purpose is correct
   * quota accounting. `null` is `SELECTION_NOT_PENDING` (R-18, R-19) and the
   * caller rolls the whole transaction back, releasing any unit step 1 took.
   */
  async decideSelection(
    uow: Uow,
    command: {
      readonly selectionId: string;
      readonly expectedSelectionVersion: number;
      readonly status: VacationSelectionStatus;
      readonly grantId: string | null;
      readonly isOverride: boolean;
      readonly overrideReason: string | null;
      readonly approvalIdempotencyKey: string;
    },
  ): Promise<number | null> {
    const row = await uow.query
      .updateTable('vacation_selections')
      .set({
        status: command.status,
        grant_id: command.grantId,
        is_override: command.isOverride,
        override_reason: command.overrideReason,
        approval_idempotency_key: command.approvalIdempotencyKey,
        version: sql<number>`version + 1`,
        updated_at: sql<Date>`now()`,
      })
      .where('id', '=', command.selectionId)
      .where('status', '=', 'pending')
      .where('version', '=', command.expectedSelectionVersion)
      .returning('version')
      .executeTakeFirst();
    return row?.version ?? null;
  }

  /**
   * **Step 3 — §5.3's derived root status, TWO statements, one transaction.**
   *
   * §5.4 prints one; §2 carries no `submitted → approved` cell, so the printed
   * spelling raises `restrict_violation` at 0021's transition guard. The
   * implementable writer is the two-step through `under_review`, and deferred
   * D-27 — reading CURRENT rows at COMMIT — never sees the intermediate.
   *
   * The loop is shaped exactly like `PgRequestStore.decide`'s, and the
   * duplication is deliberate rather than a missed abstraction: §5.3 gives this
   * lifecycle ONE writer, and sharing a writer with the request store is what
   * would make that untrue. What the two share is the RULE, and the rule lives in
   * the domain (`VACATION_APPROVAL_ROOT_PATH`, `decisionStatusPath`).
   */
  async writeDerivedRootStatus(
    uow: Uow,
    command: {
      readonly requestId: string;
      readonly path: readonly RequestStatus[];
      readonly decidedBy: string;
      readonly decidedAt: Date;
    },
  ): Promise<number | null> {
    if (command.path.length === 0) {
      throw new Error('VACATION_ROOT_PATH_EMPTY: a vacation decision walks at least one edge');
    }

    let version: number | null = null;
    for (const [index, status] of command.path.entries()) {
      const last = index === command.path.length - 1;
      let update = uow.query
        .updateTable('requests')
        .set({
          status,
          version: sql<number>`version + 1`,
          updated_at: command.decidedAt,
          ...(last ? { decided_at: command.decidedAt, decided_by: command.decidedBy } : {}),
        })
        .where('id', '=', command.requestId);
      /* The first statement has no version to present — the caller's optimistic
       * token is the SELECTION's (V-29), and the root's version is nobody's to
       * hold for a vacation request because §5.3 gives it one writer. Subsequent
       * statements pin the version the previous one returned, which is what makes
       * the pair a walk rather than two independent writes. */
      if (version !== null) update = update.where('version', '=', version);

      const row = await update.returning('version').executeTakeFirst();
      if (row === undefined) return null;
      version = row.version;
    }
    return version;
  }

  /** §5.4's last statement: what the transaction decided, on the ledger row. */
  async setApprovalCommandOutcome(
    uow: Uow,
    command: { readonly commandId: string; readonly outcome: VacationApprovalOutcome },
  ): Promise<void> {
    await uow.query
      .updateTable('vacation_approval_commands')
      .set({ outcome: command.outcome })
      .where('id', '=', command.commandId)
      .execute();
  }

  /**
   * **§5.5's reversal — both counters, and the floor is the database's.**
   *
   * `units_consumed` and `override_units` fall together, so the bound returns to
   * its pre-override value. The floor is not a predicate in this statement:
   * `CHECK (units_consumed >= 0)` is unconditional and refuses the row, which is
   * §5.5's own instruction — "a reversal that would go below zero is **rejected
   * as a data error**", not clamped to zero. A `WHERE units_consumed >= :units`
   * here would turn that data error into a silent no-op, which is the failure
   * mode the CHECK exists to make impossible.
   */
  async releaseGrantUnits(
    uow: Uow,
    command: {
      readonly grantId: string;
      readonly expectedVersion: number;
      readonly units: number;
      readonly overrideUnits: number;
    },
  ): Promise<number | null> {
    const row = await uow.query
      .updateTable('vacation_grants')
      .set({
        units_consumed: sql<number>`units_consumed - ${command.units}`,
        override_units: sql<number>`override_units - ${command.overrideUnits}`,
        version: sql<number>`version + 1`,
        updated_at: sql<Date>`now()`,
      })
      .where('id', '=', command.grantId)
      .where('version', '=', command.expectedVersion)
      .returning('version')
      .executeTakeFirst();
    return row?.version ?? null;
  }
}

export const vacationStore = new PgVacationStore();
