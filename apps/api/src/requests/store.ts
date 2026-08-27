import type {
  Approval,
  NewApproval,
  NewRequest,
  Request,
  RequestAggregate,
  RequestStatus,
  RequestStore,
  RequestSubtype,
  NewRequestSubtypeRecord,
  RequestSubtypeRecord,
  UnitOfWork,
} from '@schedulepoint/domain';
import { sql, type Kysely } from 'kysely';

import type { Database } from '../db/schema.js';

/**
 * `RequestStore` over PostgreSQL — the port `packages/domain/src/requests/port.ts`
 * declares, implemented (OPUS-M5-001, doc 42 §5c Part A).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## Every method takes the unit of work, and none of them opens one
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * I-15 made visible at the type level, exactly as the port says: there is no way
 * to reach this store outside a unit of work, so no way to reach these tables
 * outside transaction-local tenant context, where RLS returns zero rows. The
 * runner owns the transaction boundary, so no caller here can end one early.
 *
 * ## The conditional UPDATE is the concurrency control, and a zero-row result is
 *    an ANSWER
 *
 * Every transition verb below is `UPDATE … WHERE id = ? AND version = ? AND
 * status = ?` and returns the new version or `null`. `null` means the update
 * matched nothing, and the three ways that happens — a stale `expectedVersion`,
 * a row that has already moved, and a row this tenant context cannot see — are
 * deliberately ONE answer. Telling them apart across a tenancy boundary is the
 * existence oracle X-11 exists to close, and it is the same reason
 * `schedule-views.route.ts` makes "not mine", "another group's" and "no such id"
 * byte-identical.
 *
 * **The `status` predicate is not redundant beside the version.** A version
 * check alone would admit a transition from whatever status the row happens to
 * be in, and the caller has already decided which EDGE it is walking — naming
 * the source status is how the statement asserts that its decision is still
 * true. The database's trigger would refuse an illegal edge anyway; this makes a
 * legal-but-different edge a conflict rather than a surprise.
 *
 * ## Nothing here consults the matrix
 *
 * The domain does that, before calling (`packages/domain/src/requests/lifecycle.ts`),
 * and the database does it again in `app_guard_request_transition`. A third copy
 * in the store would be the one that drifts, because it is the one no test
 * compares to anything.
 */

type Uow = UnitOfWork<Kysely<Database>>;

/** The root's columns, as the aggregate reads them. */
interface RootRow {
  readonly id: string;
  readonly organization_id: string;
  readonly group_id: string;
  readonly membership_id: string;
  readonly subtype: RequestAggregate['subtype'];
  readonly status: RequestAggregate['status'];
  readonly submitted_at: Date | null;
  readonly decided_at: Date | null;
  readonly decided_by: string | null;
  readonly withdrawn_at: Date | null;
  readonly expires_at: Date;
  readonly idempotency_key: string;
  readonly version: number;
  readonly is_late: boolean;
  readonly revision_requested: boolean;
}

function toAggregate(row: RootRow): RequestAggregate {
  return {
    id: row.id,
    organizationId: row.organization_id,
    groupId: row.group_id,
    membershipId: row.membership_id,
    subtype: row.subtype,
    status: row.status,
    submittedAt: row.submitted_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    withdrawnAt: row.withdrawn_at,
    expiresAt: row.expires_at,
    idempotencyKey: row.idempotency_key,
    version: row.version,
    isLate: row.is_late,
    revisionRequested: row.revision_requested,
  };
}

const ROOT_COLUMNS = sql`id, organization_id, group_id, membership_id, subtype, status,
                         submitted_at, decided_at, decided_by, withdrawn_at, expires_at,
                         idempotency_key, version, is_late, revision_requested`;

/**
 * The subtype record for a root, from the one table its discriminator names.
 *
 * A switch rather than a six-way UNION, and the reason is D-18: a request has
 * exactly one subtype row and the root already says which table it is in. A
 * UNION would read six tables to find one row and would return a shape the type
 * system could not narrow, which is how a `shift-preference` ends up being
 * handled as an `availability` somewhere downstream.
 *
 * ## The TYPED builder, not SQL templates — NR-16
 *
 * These five reads were first written as multi-line `sql` templates, and the
 * I-15 architecture scan refused all five: a line beginning `from
 * request_availability` is a BARE SQL LINE naming a tenant table, which the
 * NR-16 detector flags wherever it appears. The detector is lexical rather than
 * dataflow — it cannot tell a `uow.query` template from a `client.query` one —
 * which is why `BARE_LINE_BASELINE` pins the modules that legitimately hold such
 * SQL.
 *
 * **This file is deliberately NOT added to that baseline**, for the reason
 * `requests/deadlines.ts` is not: the baseline is for hits that PREDATE the
 * detector, pinned so that "a NEW bare-line query anywhere fails", and filing
 * new debt under a pre-existing-debt list would turn a red gate green by
 * relabelling. The builder removes the SQL rather than reformatting around the
 * detector, so the control is satisfied by having nothing to detect.
 *
 * The `::text` casts survive as `sql` fragments inside the builder: `date`
 * columns come back from node-postgres as JavaScript `Date` objects, and every
 * one of these is a calendar date the domain types declare as a `YYYY-MM-DD`
 * string. Casting in the database is what makes those declarations true at
 * runtime.
 */
async function loadRecord(uow: Uow, root: RootRow): Promise<RequestSubtypeRecord | null> {
  /** A `date` column, cast in the database so the declared `string` type holds. */
  const dateText = <T extends string>(column: T) => sql<string>`${sql.ref(column)}::text`.as(column);
  const dateTextNullable = <T extends string>(column: T) =>
    sql<string | null>`${sql.ref(column)}::text`.as(column);

  switch (root.subtype) {
    case 'availability': {
      const row = await uow.query
        .selectFrom('request_availability')
        .select(['request_id', dateText('target_date')])
        .where('request_id', '=', root.id)
        .executeTakeFirst();
      return row === undefined
        ? null
        : { subtype: 'availability', requestId: row.request_id, targetDate: row.target_date };
    }
    case 'time-off': {
      const row = await uow.query
        .selectFrom('request_time_off')
        .select([
          'request_id',
          dateTextNullable('target_date'),
          dateTextNullable('range_start'),
          dateTextNullable('range_end'),
        ])
        .where('request_id', '=', root.id)
        .executeTakeFirst();
      if (row === undefined) return null;
      /* D-19's exactly-one-of, read back as the discriminated pair the domain
       * type declares. The database has already refused every other shape, so
       * the `null` branch below is unreachable in practice — and it is written
       * rather than cast away, because a cast is what turns "the constraint was
       * dropped" into an undiagnosable field error. */
      return row.target_date !== null
        ? { subtype: 'time-off', requestId: row.request_id, targetDate: row.target_date }
        : row.range_start !== null && row.range_end !== null
          ? {
              subtype: 'time-off',
              requestId: row.request_id,
              rangeStart: row.range_start,
              rangeEnd: row.range_end,
            }
          : null;
    }
    case 'no-call': {
      const row = await uow.query
        .selectFrom('request_no_call')
        .select(['request_id', dateText('target_date')])
        .where('request_id', '=', root.id)
        .executeTakeFirst();
      return row === undefined
        ? null
        : { subtype: 'no-call', requestId: row.request_id, targetDate: row.target_date };
    }
    case 'shift-preference': {
      const row = await uow.query
        .selectFrom('request_shift_preference')
        .select(['request_id', dateText('target_date'), 'shift_type_id', 'preference_strength'])
        .where('request_id', '=', root.id)
        .executeTakeFirst();
      return row === undefined
        ? null
        : {
            subtype: 'shift-preference',
            requestId: row.request_id,
            targetDate: row.target_date,
            shiftTypeId: row.shift_type_id,
            preferenceStrength: row.preference_strength,
          };
    }
    case 'shift-group-off': {
      const row = await uow.query
        .selectFrom('request_shift_group_off')
        .select(['request_id', dateText('target_date'), 'shift_group_id'])
        .where('request_id', '=', root.id)
        .executeTakeFirst();
      return row === undefined
        ? null
        : {
            subtype: 'shift-group-off',
            requestId: row.request_id,
            targetDate: row.target_date,
            shiftGroupId: row.shift_group_id,
          };
    }
    case 'vacation-selection':
      /* Deliberately not implemented here. Doc 42 §5c: "nothing here writes
       * `vacation_selections`", and reading one through the REQUEST store would
       * make this the second reader of a lifecycle §5.3 says has exactly one
       * writer. `VacationStore` is that surface and it is M5-002/003's to
       * implement. A caller that loads a vacation root gets its root and a null
       * record, which is honest about what this store knows. */
      return null;
  }
}

export class PgRequestStore implements RequestStore {
  async load(uow: Uow, requestId: string): Promise<Request | null> {
    const root = await this.loadRootRow(uow, requestId);
    if (root === null) return null;
    const record = await loadRecord(uow, root);
    return record === null ? null : { root: toAggregate(root), record };
  }

  async loadRoot(uow: Uow, requestId: string): Promise<RequestAggregate | null> {
    const root = await this.loadRootRow(uow, requestId);
    return root === null ? null : toAggregate(root);
  }

  private async loadRootRow(uow: Uow, requestId: string): Promise<RootRow | null> {
    const rows = await sql<RootRow>`
      select ${ROOT_COLUMNS} from requests where id = ${requestId}::uuid
    `.execute(uow.query);
    return rows.rows[0] ?? null;
  }

  /**
   * D-7's read side (R-11).
   *
   * The `UNIQUE (membership_id, idempotency_key, organization_id)` index is what
   * makes the answer binding when two callers ask at once — this read is the
   * fast path and the constraint is the correct one. The service relies on
   * exactly that ordering: it reads, and if the read misses it writes and lets
   * the constraint arbitrate.
   */
  async findByIdempotencyKey(
    uow: Uow,
    membershipId: string,
    idempotencyKey: string,
  ): Promise<Request | null> {
    const rows = await sql<RootRow>`
      select ${ROOT_COLUMNS} from requests
       where membership_id = ${membershipId}::uuid
         and idempotency_key = ${idempotencyKey}
    `.execute(uow.query);
    const root = rows.rows[0];
    if (root === undefined) return null;
    const record = await loadRecord(uow, root);
    return record === null ? null : { root: toAggregate(root), record };
  }

  /**
   * **FU-23's split — the ROOT alone, by key** (OPUS-M5-003).
   *
   * `findByIdempotencyKey` above composes two reads and answers `null` if either
   * misses. For a `vacation-selection` the second one misses BY DESIGN —
   * `loadRecord` does not read `vacation_selections`, because §5.3 gives that
   * lifecycle one reader and it is not this store — so the composition says "no
   * request holds this key" about a request that does.
   *
   * That was harmless while no vacation root could exist. This packet creates
   * them, and then the composition sends a member who reuses their own key across
   * subtypes past the replay read and into `UNIQUE (membership_id,
   * idempotency_key, organization_id)`, whose `23505` the route maps to a bare
   * `409` — FU-23's "a 409 posing as a replay".
   *
   * This read stops at the root, which is where D-7's uniqueness lives and the
   * only place it lives. What the caller does with the answer is
   * `submitRequest`'s: the same subtype is a replay, a different subtype is
   * `IDEMPOTENCY_KEY_REUSED`, and neither is a constraint surfacing as an
   * accident.
   */
  async findRootByIdempotencyKey(
    uow: Uow,
    membershipId: string,
    idempotencyKey: string,
  ): Promise<RequestAggregate | null> {
    const rows = await sql<RootRow>`
      select ${ROOT_COLUMNS} from requests
       where membership_id = ${membershipId}::uuid
         and idempotency_key = ${idempotencyKey}
    `.execute(uow.query);
    const root = rows.rows[0];
    return root === undefined ? null : toAggregate(root);
  }

  /**
   * The root and its subtype record, in ONE unit of work.
   *
   * The port's own words for why the two are one argument: D-18's zero-row half
   * is a deferred constraint trigger evaluated at commit, so a store that let a
   * caller insert a root now and a record later would hand out a transaction
   * that aborts at the end for a reason a long way from where it was caused.
   *
   * The root is created at the subtype's INITIAL status and this method does not
   * take one. That is the ruling of doc 42 §5c Part A expressed as an absent
   * parameter: there is no way to ask this store for a request that starts
   * anywhere else, and migration 0023's `requests_guard_initial_status` refuses
   * one written any other way.
   */
  async create(uow: Uow, request: NewRequest): Promise<string> {
    const { organizationId, groupId } = uow.context;
    const inserted = await sql<{ id: string }>`
      insert into requests
        (organization_id, group_id, membership_id, subtype, status, expires_at, idempotency_key)
      values (${organizationId}::uuid, ${groupId}::uuid, ${request.membershipId}::uuid,
              ${request.subtype}, app_request_initial_status(${request.subtype}),
              ${request.expiresAt}::timestamptz, ${request.idempotencyKey})
      returning id
    `.execute(uow.query);

    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('the request insert returned no id');

    await insertRecord(uow, id, request.record);
    return id;
  }

  async listForMembership(uow: Uow, membershipId: string): Promise<readonly Request[]> {
    const roots = await sql<RootRow>`
      select ${ROOT_COLUMNS} from requests
       where membership_id = ${membershipId}::uuid
       order by created_at desc, id
    `.execute(uow.query);

    const out: Request[] = [];
    for (const root of roots.rows) {
      const record = await loadRecord(uow, root);
      if (record !== null) out.push({ root: toAggregate(root), record });
    }
    return out;
  }

  async submit(
    uow: Uow,
    command: {
      readonly requestId: string;
      readonly expectedVersion: number;
      readonly expiresAt: Date;
      readonly isLate: boolean;
      readonly submittedAt: Date;
    },
  ): Promise<number | null> {
    /* The typed builder, for the NR-16 reason `loadRecord` records above: a line
     * beginning `update requests` is a bare SQL line naming a tenant table. The
     * conditional predicate is unchanged — id, version AND source status. */
    const row = await uow.query
      .updateTable('requests')
      .set({
        status: 'submitted',
        submitted_at: command.submittedAt,
        expires_at: command.expiresAt,
        is_late: command.isLate,
        version: sql<number>`version + 1`,
      })
      .where('id', '=', command.requestId)
      .where('version', '=', command.expectedVersion)
      .where('status', '=', 'draft')
      .returning('version')
      .executeTakeFirst();
    return row?.version ?? null;
  }

  /**
   * The withdrawal write.
   *
   * The source status is NOT named in the predicate here, and this is the one
   * place that differs from `submit` — because withdrawal is legal from five
   * different statuses depending on subtype, and naming one would make the
   * store decide which edge the caller meant. The version predicate still makes
   * it conditional, the domain has already checked the edge against the matrix,
   * and `app_guard_request_transition` refuses any edge the matrix does not
   * carry. Three controls, and none of them is this store guessing.
   */
  async withdraw(
    uow: Uow,
    command: {
      readonly requestId: string;
      readonly expectedVersion: number;
      readonly withdrawnAt: Date;
      readonly revisionRequested: boolean;
    },
  ): Promise<number | null> {
    const row = await uow.query
      .updateTable('requests')
      .set({
        status: 'withdrawn',
        withdrawn_at: command.withdrawnAt,
        revision_requested: command.revisionRequested,
        version: sql<number>`version + 1`,
      })
      .where('id', '=', command.requestId)
      .where('version', '=', command.expectedVersion)
      .returning('version')
      .executeTakeFirst();
    return row?.version ?? null;
  }

  /**
   * The sweeper's write.
   *
   * The three source statuses are named explicitly rather than left to the
   * trigger. V-31's whole point is that `expired` has exactly three legal
   * sources and the rule must never be spelled as a wildcard; a sweeper whose
   * own statement said `where status <> 'expired'` would be a second, wrong copy
   * of the rule sitting where nobody compares it to §2.
   */
  async expire(
    uow: Uow,
    command: { readonly requestId: string; readonly expiredAt: Date },
  ): Promise<number | null> {
    const row = await uow.query
      .updateTable('requests')
      .set({
        status: 'expired',
        version: sql<number>`version + 1`,
        updated_at: command.expiredAt,
      })
      .where('id', '=', command.requestId)
      /* The three source statuses, ENUMERATED. V-31's whole point is that
       * `expired` has exactly three legal sources and the rule must never be
       * spelled as a wildcard; `where status <> 'expired'` would be a second,
       * wrong copy of the rule sitting where nobody compares it to §2. */
      .where('status', 'in', ['submitted', 'under_review', 'accepted_as_input'])
      .returning('version')
      .executeTakeFirst();
    return row?.version ?? null;
  }

  /**
   * Undecided rows past their deadline, claimed for update.
   *
   * `FOR UPDATE SKIP LOCKED` for the reason `reapStaleBuilds` gives: two
   * sweepers running at once divide the work instead of colliding, and neither
   * waits on the other — a sweeper that blocks is a sweeper that is not
   * sweeping.
   *
   * The predicate matches `requests_undecided_by_expiry`, the partial index
   * migration 0021 created for exactly this query and no other.
   */
  async claimExpirable(uow: Uow, now: Date, limit: number): Promise<readonly RequestAggregate[]> {
    const rows = await sql<RootRow>`
      select ${ROOT_COLUMNS} from requests
       where status in ('submitted', 'under_review', 'accepted_as_input')
         and expires_at < ${now}::timestamptz
       order by expires_at, id
       limit ${limit}
       for update skip locked
    `.execute(uow.query);
    return rows.rows.map(toAggregate);
  }

  /* ──────────────────────────────────────────────────────────────────────────
   * OPUS-M5-002 — §4's decisions (doc 42 §5d Parts A and C)
   * ────────────────────────────────────────────────────────────────────────── */

  /**
   * **§4's decision, walked one EDGE at a time (M5-000b finding #1).**
   *
   * `path` comes from `decisionStatusPath` in the domain — this store does not
   * compute it, for the reason the header gives about the matrix. Each element
   * is a separate statement because each is a separate edge and
   * `app_guard_request_transition` evaluates one edge at a time; a single
   * statement spelling `submitted → approved` is refused by §2's own matrix,
   * which is the finding this loop exists to honour.
   *
   * The FIRST statement carries `expectedVersion` — §4's "first decision wins,
   * the second gets an explicit conflict". The ones after it carry the version
   * the previous statement returned, which is not a weaker check: nothing can
   * interleave inside this transaction's own row lock, and a mismatch there
   * would mean the row moved under a lock we hold, which is not a thing that
   * happens.
   *
   * `decided_at`/`decided_by` are stamped on the LAST statement only, so the row
   * is never momentarily "decided by somebody, status `under_review`" — a state
   * `requests_decision_coherent` permits and no reader could explain.
   */
  async decide(
    uow: Uow,
    command: {
      readonly requestId: string;
      readonly expectedVersion: number;
      readonly path: readonly RequestStatus[];
      readonly decidedBy: string;
      readonly decidedAt: Date;
    },
  ): Promise<number | null> {
    if (command.path.length === 0) {
      throw new Error('DECISION_PATH_EMPTY: a decision walks at least one edge');
    }

    let version = command.expectedVersion;
    for (const [index, status] of command.path.entries()) {
      const last = index === command.path.length - 1;
      const row = await uow.query
        .updateTable('requests')
        .set({
          status,
          version: sql<number>`version + 1`,
          updated_at: command.decidedAt,
          ...(last ? { decided_at: command.decidedAt, decided_by: command.decidedBy } : {}),
        })
        .where('id', '=', command.requestId)
        .where('version', '=', version)
        .returning('version')
        .executeTakeFirst();
      if (row === undefined) return null;
      version = row.version;
    }
    return version;
  }

  /**
   * **§4's reversal — `approved → superseded_by_revision`.**
   *
   * The source status IS named in the predicate, unlike `withdraw`: a reversal is
   * legal from exactly one status for every subtype it applies to, so naming it
   * costs nothing and makes a legal-but-different edge a conflict rather than a
   * surprise. `decided_at`/`decided_by` are re-stamped, because the reversal is
   * itself a decision and the root's decision columns name the LATEST one; the
   * full history is in `approvals`, which nothing can overwrite.
   */
  async reverseDecision(
    uow: Uow,
    command: {
      readonly requestId: string;
      readonly expectedVersion: number;
      readonly reversedAt: Date;
      readonly reversedBy: string;
    },
  ): Promise<number | null> {
    const row = await uow.query
      .updateTable('requests')
      .set({
        status: 'superseded_by_revision',
        decided_at: command.reversedAt,
        decided_by: command.reversedBy,
        updated_at: command.reversedAt,
        version: sql<number>`version + 1`,
      })
      .where('id', '=', command.requestId)
      .where('version', '=', command.expectedVersion)
      .where('status', '=', 'approved')
      .returning('version')
      .executeTakeFirst();
    return row?.version ?? null;
  }

  /**
   * Append one decision to `approvals`.
   *
   * There is no update counterpart in this class and there cannot be one:
   * migration 0024 grants no runtime role UPDATE or DELETE on the table, so a
   * method that tried would raise `42501` rather than silently succeed. "The
   * prior decision is never overwritten" is a privilege, not a promise.
   */
  async recordApproval(uow: Uow, approval: NewApproval): Promise<string> {
    const { organizationId, groupId } = uow.context;
    const row = await uow.query
      .insertInto('approvals')
      .values({
        organization_id: organizationId,
        group_id: groupId as string,
        request_id: approval.requestId,
        decision: approval.decision,
        decided_by: approval.decidedBy,
        decided_at: approval.decidedAt,
        reason: approval.reason,
        is_override: approval.isOverride,
        vacation_selection_id: approval.vacationSelectionId,
        supersedes_approval_id: approval.supersedesApprovalId,
      })
      .returning('id')
      .executeTakeFirst();

    if (row === undefined) {
      /* Unreachable through RLS — a `WITH CHECK` failure raises rather than
       * returning nothing. Kept for the reason the audit recorder keeps its
       * twin: "the insert silently produced no row" must never become "the
       * decision was recorded". */
      throw new Error('APPROVAL_INSERT_PRODUCED_NO_ROW: the decision insert returned nothing.');
    }
    return row.id;
  }

  /** §4's decision history for one request, newest first. */
  async listApprovals(uow: Uow, requestId: string): Promise<readonly Approval[]> {
    const rows = await uow.query
      .selectFrom('approvals')
      .select([
        'id',
        'request_id',
        'decision',
        'decided_by',
        'decided_at',
        'reason',
        'is_override',
        'vacation_selection_id',
        'supersedes_approval_id',
      ])
      .where('request_id', '=', requestId)
      .orderBy('decided_at', 'desc')
      .orderBy('id')
      .execute();

    return rows.map((row) => ({
      id: row.id,
      requestId: row.request_id,
      decision: row.decision,
      decidedBy: row.decided_by,
      decidedAt: row.decided_at,
      reason: row.reason,
      isOverride: row.is_override,
      vacationSelectionId: row.vacation_selection_id,
      supersedesApprovalId: row.supersedes_approval_id,
    }));
  }

  /**
   * **The pending-review queue** (doc 42 §5d Part C).
   *
   * Oldest first: a queue is worked from the front, and a scheduler who sorts
   * newest-first is a scheduler whose oldest request ages forever. `expires_at`
   * leads the ordering rather than `created_at`, because what makes a request
   * urgent is its DEADLINE — the same ordering `claimExpirable` uses, for the
   * same reason, and it means the queue and the sweeper agree about which
   * request is most at risk of being decided by nobody.
   *
   * **No group predicate and no membership predicate.** The group is the unit of
   * work's own context and migration 0023's policies scope the rows to it; a
   * filter here would be a second, weaker copy of a control that already holds,
   * and it is the copy that would be forgotten on the next reader. Whether this
   * caller may see a colleague's row at all is `requests.read_any`'s question.
   */
  async listPendingReview(
    uow: Uow,
    filter: {
      readonly subtypes?: readonly RequestSubtype[];
      readonly statuses?: readonly RequestStatus[];
      readonly limit: number;
    },
  ): Promise<readonly Request[]> {
    let query = uow.query
      .selectFrom('requests')
      .select([
        'id',
        'organization_id',
        'group_id',
        'membership_id',
        'subtype',
        'status',
        'submitted_at',
        'decided_at',
        'decided_by',
        'withdrawn_at',
        'expires_at',
        'idempotency_key',
        'version',
        'is_late',
        'revision_requested',
      ])
      /* The DEFAULT is the undecided set — §2's three states a decision can act
       * from plus the one a shift preference sits in. A queue that defaulted to
       * every status would open on a list nobody can act on. */
      .where('status', 'in', filter.statuses ?? ['submitted', 'under_review']);

    if (filter.subtypes !== undefined && filter.subtypes.length > 0) {
      query = query.where('subtype', 'in', filter.subtypes);
    }

    const roots = await query
      .orderBy('expires_at')
      .orderBy('id')
      .limit(filter.limit)
      .execute();

    const out: Request[] = [];
    for (const root of roots) {
      const record = await loadRecord(uow, root as RootRow);
      /* A vacation root reads back with a null record here — `loadRecord` does
       * not read `vacation_selections`, because §5.3 gives that lifecycle one
       * reader and it is not the request store. The queue therefore shows the
       * five non-vacation subtypes, which is exactly the set §4's decision verbs
       * act on; the vacation round has its own surface (M5-003). */
      if (record !== null) out.push({ root: toAggregate(root as RootRow), record });
    }
    return out;
  }
}

/** The one subtype row, into the one table the discriminator names. */
async function insertRecord(
  uow: Uow,
  requestId: string,
  record: NewRequestSubtypeRecord,
): Promise<void> {
  const { organizationId, groupId } = uow.context;
  const ids = sql`${requestId}::uuid, ${organizationId}::uuid, ${groupId}::uuid`;

  switch (record.subtype) {
    case 'availability':
      await sql`
        insert into request_availability (request_id, organization_id, group_id, target_date)
        values (${ids}, ${record.targetDate}::date)
      `.execute(uow.query);
      return;
    case 'time-off':
      await ('targetDate' in record
        ? sql`
            insert into request_time_off (request_id, organization_id, group_id, target_date)
            values (${ids}, ${record.targetDate}::date)
          `
        : sql`
            insert into request_time_off
              (request_id, organization_id, group_id, range_start, range_end)
            values (${ids}, ${record.rangeStart}::date, ${record.rangeEnd}::date)
          `
      ).execute(uow.query);
      return;
    case 'no-call':
      await sql`
        insert into request_no_call (request_id, organization_id, group_id, target_date)
        values (${ids}, ${record.targetDate}::date)
      `.execute(uow.query);
      return;
    case 'shift-preference':
      await sql`
        insert into request_shift_preference
          (request_id, organization_id, group_id, target_date, shift_type_id, preference_strength)
        values (${ids}, ${record.targetDate}::date, ${record.shiftTypeId}::uuid,
                ${record.preferenceStrength})
      `.execute(uow.query);
      return;
    case 'shift-group-off':
      await sql`
        insert into request_shift_group_off
          (request_id, organization_id, group_id, target_date, shift_group_id)
        values (${ids}, ${record.targetDate}::date, ${record.shiftGroupId}::uuid)
      `.execute(uow.query);
      return;
  }
  /* ── There is no `vacation-selection` case, and it is not an omission ───────
   *
   * `NewRequestSubtypeRecord` does not CONTAIN one. `VacationSelectionRecord`
   * carries `requestId: string | null` — §5.3's `available` row has no root —
   * so it does not match the `{ requestId: string }` constraint the creation
   * type is built from, and the union excludes it.
   *
   * That falls out of §5.3's own shape, and it is the enforcement doc 42 §5c
   * asks for ("nothing here writes `vacation_selections`") expressed in the type
   * system rather than as a runtime throw somebody has to reach. §5.3 gives that
   * lifecycle ONE writer — the vacation module's, in M5-002/003 — and a second
   * writer here is the thing that would make "the vacation module never writes
   * one without the other" untrue.
   *
   * A runtime guard was written here first and then removed as dead: the switch
   * above is exhaustive over the type, so the branch was unreachable, and an
   * unreachable throw is a claim a reader cannot check. */
}

export const requestStore = new PgRequestStore();
