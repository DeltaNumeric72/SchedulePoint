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
  VacationSelectionView,
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

  /** §5.1's linkage, from the root. `null` for a request that carries no selection. */
  async findSelectionByRequest(
    uow: Uow,
    requestId: string,
  ): Promise<VacationSelectionRecord | null> {
    const row = await uow.query
      .selectFrom('vacation_selections')
      .select([...SELECTION_COLUMNS, dateText('week_start')])
      .where('request_id', '=', requestId)
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

  /* ──────────────────────────────────────────────────────────────────────────
   * OPUS-M5-003 — §5's SUBMISSION side (doc 42 §5f Part A)
   *
   * The member's half of the same lifecycle, HERE for the reason the five above
   * are here: §5.3's "**One writer.** Only the vacation module updates either
   * status … and the vacation module never writes one without the other."
   * Every root write for a `vacation-selection` row is in this file, and
   * `PgRequestStore` still has no verb that can produce one.
   * ────────────────────────────────────────────────────────────────────────── */

  /**
   * **The vacation ROOT, at the status 0023 names for this subtype.**
   *
   * `app_request_initial_status('vacation-selection')` is `'submitted'`, and
   * `requests_guard_initial_status` refuses anything else — so this insert names
   * the function rather than the literal, exactly as `PgRequestStore.create`
   * does. A literal here would be a second copy of the ruling in the one place
   * nobody compares it to the first.
   *
   * `submitted_at` is stamped in the same statement, because for this subtype
   * the creation IS the submission: there is no `draft` to move out of, so there
   * is no later statement to stamp it in.
   *
   * **No subtype row is inserted.** The `vacation_selections` row already exists
   * in `available`; `linkSelectionToRoot` attaches it in the same transaction and
   * D-18's deferred zero-row guard counts exactly one at commit.
   */
  async createRoot(
    uow: Uow,
    command: {
      readonly membershipId: string;
      readonly expiresAt: Date;
      readonly idempotencyKey: string;
      readonly submittedAt: Date;
    },
  ): Promise<string> {
    const { organizationId, groupId } = uow.context;
    const inserted = await sql<{ id: string }>`
      insert into requests
        (organization_id, group_id, membership_id, subtype, status, expires_at,
         idempotency_key, submitted_at)
      values (${organizationId}::uuid, ${groupId}::uuid, ${command.membershipId}::uuid,
              'vacation-selection', app_request_initial_status('vacation-selection'),
              ${command.expiresAt}::timestamptz, ${command.idempotencyKey},
              ${command.submittedAt}::timestamptz)
      returning id
    `.execute(uow.query);

    const id = inserted.rows[0]?.id;
    if (id === undefined) {
      throw new Error('VACATION_ROOT_INSERT_PRODUCED_NO_ROW: the root insert returned no id.');
    }
    return id;
  }

  /**
   * §3's late marker, as the SECOND statement 0023's creation guard forces.
   *
   * `requests_guard_initial_status` refuses a row born with either lifecycle flag
   * true — "§3's late marker is a fact about a SUBMISSION measured against a
   * server-computed deadline, and a row created with it has been measured against
   * nothing". A vacation root is born `submitted`, so unlike the five there is no
   * submission UPDATE to carry the flag, and this is that statement.
   *
   * Same status, so `app_guard_request_transition`'s early return admits it, and
   * `app_guard_request_revision_requested` is satisfied because
   * `revision_requested` does not move.
   */
  async markRootLate(uow: Uow, requestId: string): Promise<void> {
    await uow.query
      .updateTable('requests')
      .set({ is_late: true, version: sql<number>`version + 1` })
      .where('id', '=', requestId)
      .execute();
  }

  /**
   * **§5.3's `available → pending`, guarded.**
   *
   * The guard is R-18/R-19's shape with `available` in its place: without the
   * status predicate a second delivery of the same submission would link a SECOND
   * root to a selection that already has one, and `UNIQUE (request_id,
   * organization_id)` would then refuse the transaction from a long way from the
   * caller that caused it. Without the version predicate two tabs would both
   * succeed and one member would hold two requests for one week.
   */
  async linkSelectionToRoot(
    uow: Uow,
    command: {
      readonly selectionId: string;
      readonly expectedSelectionVersion: number;
      readonly requestId: string;
    },
  ): Promise<number | null> {
    const row = await uow.query
      .updateTable('vacation_selections')
      .set({
        request_id: command.requestId,
        status: 'pending',
        version: sql<number>`version + 1`,
        updated_at: sql<Date>`now()`,
      })
      .where('id', '=', command.selectionId)
      .where('status', '=', 'available')
      .where('version', '=', command.expectedSelectionVersion)
      .returning('version')
      .executeTakeFirst();
    return row?.version ?? null;
  }

  /**
   * **§5.3's `pending | approved → withdrawn`, guarded (R-18, R-19).**
   *
   * The source status is a PARAMETER rather than an `IN` list, because the two
   * cases differ outside this statement: a withdrawal from `approved` releases
   * the quota unit the approval consumed, and a store verb that inferred which
   * case it was in would be deciding that on its own. The caller has already
   * asked the domain which edge it is walking.
   */
  async withdrawSelection(
    uow: Uow,
    command: {
      readonly selectionId: string;
      readonly expectedSelectionVersion: number;
      readonly expectedStatus: VacationSelectionStatus;
    },
  ): Promise<number | null> {
    const row = await uow.query
      .updateTable('vacation_selections')
      .set({
        status: 'withdrawn',
        version: sql<number>`version + 1`,
        updated_at: sql<Date>`now()`,
      })
      .where('id', '=', command.selectionId)
      .where('status', '=', command.expectedStatus)
      .where('version', '=', command.expectedSelectionVersion)
      .returning('version')
      .executeTakeFirst();
    return row?.version ?? null;
  }

  /**
   * **§5.3's derived root status for a WITHDRAWAL, same transaction.**
   *
   * One statement, because `submitted → withdrawn` and `approved → withdrawn` are
   * both cells §2's vacation column carries directly — the two-step is a property
   * of DECISIONS, which have no `submitted → approved` cell, and a withdrawal is
   * not one.
   *
   * `withdrawn_at` and not `decided_at`: §4 is explicit that an administrator
   * "withdrawing" for somebody is a denial instead, so a withdrawn request that
   * named a decider would record the confusion §4 exists to prevent.
   *
   * `revision_requested` is not written and must not be: R-10's flag belongs to a
   * withdrawal from `reflected_in_version`, which vacation reaches as
   * §5.6's REVERSAL instead (FAD-55 excludes vacation from the withdrawal cell
   * deliberately), and 0023's guard refuses the flag on any other transition.
   */
  async writeRootWithdrawal(
    uow: Uow,
    command: { readonly requestId: string; readonly withdrawnAt: Date },
  ): Promise<number | null> {
    const row = await uow.query
      .updateTable('requests')
      .set({
        status: 'withdrawn',
        withdrawn_at: command.withdrawnAt,
        updated_at: command.withdrawnAt,
        version: sql<number>`version + 1`,
      })
      .where('id', '=', command.requestId)
      .returning('version')
      .executeTakeFirst();
    return row?.version ?? null;
  }

  async listSelectionsForMembership(
    uow: Uow,
    membershipId: string,
  ): Promise<readonly VacationSelectionView[]> {
    return this.selectionViews(uow, { membershipId });
  }

  async listSelectionsInPeriod(
    uow: Uow,
    periodId: string,
  ): Promise<readonly VacationSelectionView[]> {
    return this.selectionViews(uow, { periodId });
  }

  /**
   * The selection rows with the root facts a display needs, in ONE query.
   *
   * A `left join`, not an inner one: §5.3's `available` selection has no root and
   * an inner join would drop exactly the state the round's grid is mostly made
   * of. Every root column therefore comes back nullable, and
   * `vacationStatusPairAgrees` is what the read model uses to check the pair
   * rather than trusting either half.
   *
   * **No `ORDER BY`.** The order a selection list is presented in is
   * `compareSelectionsForDisplay` in the domain, which is a stated rule with a
   * matrix test behind it; an ordering here would be a second copy drifting in
   * the direction a surface reads.
   */
  private async selectionViews(
    uow: Uow,
    filter: { readonly membershipId?: string; readonly periodId?: string },
  ): Promise<readonly VacationSelectionView[]> {
    let query = uow.query
      .selectFrom('vacation_selections as v')
      .leftJoin('requests as r', 'r.id', 'v.request_id')
      .select([
        'v.id as id',
        'v.request_id as request_id',
        'v.membership_id as membership_id',
        'v.vacation_period_id as vacation_period_id',
        sql<string>`v.week_start::text`.as('week_start'),
        'v.status as status',
        'v.version as version',
        'v.grant_id as grant_id',
        'v.is_override as is_override',
        'v.override_reason as override_reason',
        'v.approval_idempotency_key as approval_idempotency_key',
        'v.committed_to_version_id as committed_to_version_id',
        'v.commit_idempotency_key as commit_idempotency_key',
        'r.status as root_status',
        'r.version as root_version',
        'r.submitted_at as submitted_at',
        'r.expires_at as expires_at',
        'r.is_late as is_late',
      ]);

    if (filter.membershipId !== undefined) {
      query = query.where('v.membership_id', '=', filter.membershipId);
    }
    if (filter.periodId !== undefined) {
      query = query.where('v.vacation_period_id', '=', filter.periodId);
    }

    const rows = await query.execute();
    return (rows as unknown as SelectionViewRow[]).map((row) => ({
      selection: toSelection(row),
      rootStatus: row.root_status,
      rootVersion: row.root_version,
      submittedAt: row.submitted_at,
      expiresAt: row.expires_at,
      /* A selection with no root is not late; `is_late` comes back null from the
       * outer join and `false` is the fact rather than a default. */
      isLate: row.is_late ?? false,
    }));
  }

  /** The group's rounds, newest first. RLS scopes them to the caller's group. */
  async listPeriods(uow: Uow): Promise<readonly VacationPeriod[]> {
    const rows = await uow.query
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
      .orderBy('start_date', 'desc')
      .execute();
    return rows.map((row) => toPeriod(row as PeriodRow));
  }

  /* ──────────────────────────────────────────────────────────────────────────
   * OPUS-M5-004 — §5.6's commit and reversal (doc 42 §5h, FAD-59)
   *
   * Here for the reason every other selection writer is: §5.3's "**One writer.**
   * Only the vacation module updates either status, and the vacation module
   * never writes one without the other."
   * ────────────────────────────────────────────────────────────────────────── */

  /**
   * **FAD-59's replay read.** The recorded outcome for a commit key, or `null`.
   *
   * The FAST path of R-12, and the reason it is a SELECT rather than an
   * insert-and-see: migration 0027 grants `SELECT, INSERT` and nothing else, so
   * the ledger row is written once, at the END, complete — there is no
   * in-flight row to conflict with at step 0. The UNIQUE key is what makes the
   * race safe; this read is what makes the ordinary replay cheap and silent.
   */
  async findCommitCommand(
    uow: Uow,
    idempotencyKey: string,
  ): Promise<{
    readonly id: string;
    readonly targetVersionId: string;
    readonly vacationPeriodId: string;
    readonly outcome: 'committed';
  } | null> {
    const row = await uow.query
      .selectFrom('vacation_commit_commands')
      .select(['id', 'target_version_id', 'vacation_period_id', 'outcome'])
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
    return row === undefined
      ? null
      : {
          id: row.id,
          targetVersionId: row.target_version_id,
          vacationPeriodId: row.vacation_period_id,
          outcome: row.outcome,
        };
  }

  /**
   * **FAD-59's ledger row, written once at the end of the commit.**
   *
   * `outcome` is `'committed'` and cannot be anything else: a refused commit
   * rolls the whole transaction back and leaves NO row, so the key stays
   * retryable — the discipline M5-002 recorded for every non-approved
   * `APPROVE-VACATION` outcome, and for the same reason (a recorded failure
   * would make the key permanently unusable). Migration 0027's header §2 carries
   * the argument.
   *
   * `null` when the UNIQUE key already holds a row — the loser of a genuine
   * race. The caller converges to the recorded outcome rather than surfacing a
   * `23505`, so a concurrent duplicate and a sequential replay give a caller the
   * same answer, which is what R-12's "one commit" means from outside.
   */
  async recordCommitCommand(
    uow: Uow,
    command: {
      readonly vacationPeriodId: string;
      readonly targetVersionId: string;
      readonly actingMembershipId: string;
      readonly idempotencyKey: string;
      readonly receivedAt: Date;
    },
  ): Promise<string | null> {
    const { organizationId, groupId } = uow.context;
    const row = await uow.query
      .insertInto('vacation_commit_commands')
      .values({
        organization_id: organizationId,
        group_id: groupId as string,
        vacation_period_id: command.vacationPeriodId,
        target_version_id: command.targetVersionId,
        acting_membership_id: command.actingMembershipId,
        idempotency_key: command.idempotencyKey,
        received_at: command.receivedAt,
        outcome: 'committed',
      })
      .onConflict((oc) => oc.columns(['organization_id', 'idempotency_key']).doNothing())
      .returning('id')
      .executeTakeFirst();
    return row?.id ?? null;
  }

  /**
   * **§5.6's selection half of the commit**, guarded exactly as §5.4's approval
   * update is.
   *
   * `status = 'approved'` in the WHERE is the per-selection half of D-23 that
   * FAD-59 names: a second commit of a committed selection matches zero rows,
   * which is the same refusal the domain matrix gives (`committed → committed`
   * is not an edge) and the same one migration 0027's CHECK would give from the
   * third side. `null` is `COMMIT_SELECTION_NOT_APPROVED` and the caller rolls
   * the whole transaction back — a partial commit is not a state this system
   * has.
   *
   * `commit_idempotency_key` is stamped here so a reader of the selection can
   * find the ledger row without a scan, exactly as `approval_idempotency_key` is
   * for the approval command.
   */
  async commitSelection(
    uow: Uow,
    command: {
      readonly selectionId: string;
      readonly committedToVersionId: string;
      readonly commitIdempotencyKey: string;
    },
  ): Promise<number | null> {
    const row = await uow.query
      .updateTable('vacation_selections')
      .set({
        status: 'committed',
        committed_to_version_id: command.committedToVersionId,
        commit_idempotency_key: command.commitIdempotencyKey,
        version: sql<number>`version + 1`,
        updated_at: sql<Date>`now()`,
      })
      .where('id', '=', command.selectionId)
      .where('status', '=', 'approved')
      .returning('version')
      .executeTakeFirst();
    return row?.version ?? null;
  }

  /**
   * **§5.6's selection half of the REVERSAL.** `committed → reversed`.
   *
   * **`committed_to_version_id` is cleared, and that is migration 0027's CHECK
   * rather than a choice made here:** `(status = 'committed') = (committed_to_version_id
   * IS NOT NULL)` is an equality, so a row leaving `committed` must leave the
   * column behind. The version the week was committed to is not lost — the
   * ledger row, the reversal's audit event and the OFF snapshots all still name
   * it — and **the published version is never touched** (I-18, non-bypass rule
   * 5). 0027's header §5 carries the consequence in full.
   *
   * The reason is stored on the selection, in the column §5.5 already gives to
   * scheduler-authored administrative text, and it goes nowhere else: not into
   * an audit payload, not into an outbox row, not into a log (I-07, non-bypass
   * rule 9).
   *
   * ── `is_override` IS OVERLOADED BY THIS WRITE, and the overload is owned ────
   *
   * **After a reversal, `is_override` reads `true` even for a week that was
   * approved WELL WITHIN its allowance.** That is not a choice made here; it is
   * forced. Migration 0022's `vacation_selections_override_reason_coherent` is
   * `CHECK (is_override = (override_reason IS NOT NULL))` — an equality, in both
   * directions — and §5.6 makes the reversal's reason MANDATORY. Storing the
   * reason therefore REQUIRES setting the flag, and 0022 is not this packet's to
   * edit: migrations are additive here, and the CHECK is a shipped control that
   * a later packet may not quietly relax to make a field read more nicely.
   *
   * So the column now carries TWO facts under one name: *"this week was approved
   * over the allowance"* (§5.5's meaning) and *"a reversal was recorded against
   * this week"* (this writer's). A reader distinguishes them today by the
   * selection's STATUS — `reversed` is the second — and nothing in this
   * repository currently needs more than that.
   *
   * **Separating them is a future RECORDED DECISION, not an invention for a
   * future reader's convenience.** The shapes are obvious (a `reversal_reason`
   * column of its own, or an `is_reversal` flag beside the existing one) and
   * both are additive; neither is taken here, because a consumer that needs the
   * distinction does not exist yet and inventing a column for one would be the
   * mirror of the rule M5-001 recorded for capability keys — a field with no
   * reader is a field that lies about being needed.
   */
  async reverseSelection(
    uow: Uow,
    command: { readonly selectionId: string; readonly reason: string },
  ): Promise<number | null> {
    const row = await uow.query
      .updateTable('vacation_selections')
      .set({
        status: 'reversed',
        committed_to_version_id: null,
        is_override: true,
        override_reason: command.reason,
        version: sql<number>`version + 1`,
        updated_at: sql<Date>`now()`,
      })
      .where('id', '=', command.selectionId)
      .where('status', '=', 'committed')
      .returning('version')
      .executeTakeFirst();
    return row?.version ?? null;
  }

}

/** The joined row `selectionViews` reads. Every root column is nullable — see the outer join. */
interface SelectionViewRow extends SelectionRow {
  readonly root_status: RequestStatus | null;
  readonly root_version: number | null;
  readonly submitted_at: Date | null;
  readonly expires_at: Date | null;
  readonly is_late: boolean | null;
}

export const vacationStore = new PgVacationStore();
