import { AsyncLocalStorage } from 'node:async_hooks';

import {
  ContextReadbackMismatchError,
  NestedTenantChangeError,
  TENANT_SETTING_NAMES,
  isTenantChange,
  readBackMismatches,
  tenantSettingValues,
  type AlertSink,
  type TenantContext,
  type TenantSettingName,
  type UnitOfWork,
  type UnitOfWorkRunner,
} from '@schedulepoint/domain';
import { Kysely, PostgresDialect, sql } from 'kysely';
import type { PostgresPool, PostgresPoolClient } from 'kysely';
import type pg from 'pg';

import type { RoleName } from './roles.js';
import type { Database } from './schema.js';

/* ────────────────────────────────────────────────────────────────────────────
 * SPEC-01 §4.2 — the unit of work. This module is the production implementation
 * of the pattern the SP-A spike proved.
 *
 *   acquire connection from pool
 *   BEGIN
 *   SELECT set_config('app.organization_id', $1, true)      -- transaction LOCAL
 *   SELECT set_config('app.group_id',        $2, true)
 *   SELECT set_config('app.membership_id',   $3, true)
 *   SELECT set_config('app.correlation_id',  $4, true)
 *   verify: read back ALL FOUR settings and compare each to its expected value
 *     on mismatch: ROLLBACK
 *                  mark the connection POISONED and discard it from the pool
 *                  raise CONTEXT_READBACK_MISMATCH to the caller
 *                  emit an operational alert at page severity
 *   result := fn(tx)
 *   COMMIT
 *
 * Three properties are structural rather than conventional, and each is a
 * property a reviewer should check rather than take on trust:
 *
 *  1. **The transaction boundary belongs to this module.** `BEGIN` and `COMMIT`
 *     are issued here, on a connection acquired here. `UnitOfWork` exposes no
 *     `commit()` and no `rollback()`, so a caller cannot end a transaction early
 *     or keep the connection past the callback (I-15).
 *
 *  2. **There is no second connection.** Kysely is handed a fake pool whose
 *     `connect()` returns the one client this unit of work already owns and
 *     whose `release()` is a no-op. There is no code path by which a query built
 *     from `uow.query` reaches a different backend — which is what makes the
 *     transaction-local settings meaningful.
 *
 *  3. **There is no test seam in the hot path.** The spike simulated a
 *     statement-level pooler with a `poolerMode` branch *inside* the wrapper, and
 *     its report disclosed that as a weakness in the evidence — a mock inside the
 *     unit under test. Here the fault is injected at the driver boundary instead
 *     (`apps/api/test/support/pooler-simulator.ts` wraps the `pg.Pool`), which is
 *     exactly where a real pooler sits. This file contains no branch that exists
 *     only for a test.
 *
 * The **only** way to touch a tenant table is `PgUnitOfWorkRunner.run`. This
 * module exports no raw client, no pool accessor and no escape hatch; the
 * fail-closed probes that must run outside a unit of work build their own pool
 * in test support, so production has no bypass to find.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface PgUnitOfWork extends UnitOfWork<Kysely<Database>> {
  /** The backend PID serving this transaction. Diagnostics and T-15 evidence. */
  readonly backendPid: number;
}

interface ActiveUnitOfWork {
  readonly context: TenantContext;
  readonly client: pg.PoolClient;
  readonly db: Kysely<Database>;
  readonly backendPid: number;
  readonly depth: number;
  readonly runnerId: symbol;
}

/** Observable counters. Production telemetry, and the T-15 evidence numbers. */
export interface UnitOfWorkStats {
  /** Every statement issued through this runner, however issued. */
  statements: number;
  /** Statements that actually touch a tenant table, excluding protocol overhead. */
  tenantTableStatements: number;
  unitsOfWork: number;
  commits: number;
  rollbacks: number;
  /** Backends discarded because their context did not read back (T-14 (b)). */
  readonly poisonedBackendPids: number[];
}

/**
 * Statements the wrapper itself issues. They are counted separately so a claim
 * about tenant-table volume cannot be inflated by protocol chatter.
 */
const PROTOCOL_STATEMENT =
  /^\s*(?:begin|commit|rollback|savepoint|release\s+savepoint|rollback\s+to\s+savepoint|select\s+set_config|select\s+current_setting)\b/i;

export interface PgUnitOfWorkRunnerOptions {
  readonly role: RoleName;
  readonly pool: pg.Pool;
  readonly alerts: AlertSink;
}

export class PgUnitOfWorkRunner implements UnitOfWorkRunner<Kysely<Database>> {
  readonly #role: RoleName;
  readonly #pool: pg.Pool;
  readonly #alerts: AlertSink;
  readonly #id = Symbol('unit-of-work-runner');
  readonly #active = new AsyncLocalStorage<ActiveUnitOfWork>();
  #savepointCounter = 0;

  readonly stats: UnitOfWorkStats = {
    statements: 0,
    tenantTableStatements: 0,
    unitsOfWork: 0,
    commits: 0,
    rollbacks: 0,
    poisonedBackendPids: [],
  };

  constructor(options: PgUnitOfWorkRunnerOptions) {
    this.#role = options.role;
    this.#pool = options.pool;
    this.#alerts = options.alerts;
    // A pooled client that dies out-of-band (T-10) emits 'error'; with no
    // listener node-postgres turns that into an unhandled exception and takes
    // the process down for a fault the wrapper already handles correctly.
    this.#pool.on('error', () => {});
  }

  /** Whether the calling async context is already inside a unit of work. */
  current(): { context: TenantContext; depth: number; backendPid: number } | undefined {
    const active = this.#active.getStore();
    if (active === undefined || active.runnerId !== this.#id) return undefined;
    return { context: active.context, depth: active.depth, backendPid: active.backendPid };
  }

  async run<T>(context: TenantContext, fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> {
    const outer = this.#active.getStore();
    if (outer !== undefined && outer.runnerId === this.#id) {
      return this.#runNested(outer, context, fn);
    }
    return this.#runOutermost(context, fn);
  }

  async #runOutermost<T>(
    context: TenantContext,
    fn: (uow: PgUnitOfWork) => Promise<T>,
  ): Promise<T> {
    const client = await this.#pool.connect();
    const backendPid = (client as unknown as { processID: number }).processID;
    let poisoned = false;

    // A checked-out client whose backend dies out of band (T-10 — an operator
    // running `pg_terminate_backend`, a network drop, a server restart) emits
    // `error` on the CLIENT. `pool.on('error')` covers idle clients only, and an
    // unhandled `error` on an EventEmitter is a process-level crash. The
    // in-flight query rejects with the same error and the catch below rolls back
    // and discards the connection, so the failure is already handled correctly —
    // this listener exists so that handling it does not require the process to
    // survive an unhandled exception first.
    const swallowOutOfBandError = (): void => {};
    client.on('error', swallowOutOfBandError);

    this.stats.unitsOfWork += 1;

    try {
      this.stats.statements += 1;
      await client.query('BEGIN');

      const db = this.#kyselyBoundTo(client);
      const expected = tenantSettingValues(context);

      // ── establish the transaction-local context ─────────────────────────────
      //
      // `set_config(name, value, true)` is the ONLY permitted spelling. `SET
      // LOCAL app.x = $1` is a syntax error (42601) through raw pg and through
      // Kysely alike — `SET` is a utility statement and cannot be parameterised
      // (X-10) — so the only way to write it is to interpolate the tenant id into
      // SQL, which puts an injection surface at the most security-critical
      // statement in the system. Lint bans every `SET` form for this reason.
      //
      // These go through Kysely, so the bound client below counts them; there is
      // deliberately no second increment here.
      for (const name of TENANT_SETTING_NAMES) {
        await sql`select set_config(${name}, ${expected[name]}, true)`.execute(db);
      }

      // ── read-back verification of ALL FOUR settings (SPEC-01 §4.2) ──────────
      //
      // All four, not one. T-14b demonstrates why: a pooler that preserves
      // `app.organization_id` and drops only `app.group_id` passes a
      // single-setting read-back and then runs fail-OPEN across every group in
      // the right organization — the CAR-001 defect class, below the application
      // layer where no amount of context validation can see it.
      const readback = await sql<Record<string, string | null>>`
        select current_setting('app.organization_id', true) as "app.organization_id",
               current_setting('app.group_id',        true) as "app.group_id",
               current_setting('app.membership_id',   true) as "app.membership_id",
               current_setting('app.correlation_id',  true) as "app.correlation_id"
      `.execute(db);

      const observed = (readback.rows[0] ?? {}) as Partial<Record<TenantSettingName, string | null>>;
      const mismatches = readBackMismatches(context, observed);

      if (mismatches.length > 0) {
        // (a) abort — the unit-of-work body never runs.
        try {
          this.stats.statements += 1;
          this.stats.rollbacks += 1;
          await client.query('ROLLBACK');
        } catch {
          /* the connection is being discarded either way */
        }
        // (b) poison — released WITH an error so the pool destroys the client
        //     rather than returning it to the idle set for the next borrower.
        poisoned = true;
        this.stats.poisonedBackendPids.push(backendPid);
        // (c) page — SPEC-01 §4.2 (V-10). Logging and continuing is prohibited.
        this.#alerts.emit({
          severity: 'page',
          code: 'CONTEXT_READBACK_MISMATCH',
          message:
            'Transaction-local tenant context did not read back. The connection pooler is ' +
            'not preserving set_config(..., true) (TDG-02 / TDG-03 failure mode).',
          detail: {
            role: this.#role,
            backendPid,
            correlationId: context.correlationId,
            // Setting NAMES and the fact of the mismatch. The organization id is
            // a tenant identifier, which is permitted; nothing a user typed
            // appears here (I-07, I-17).
            mismatchedSettings: mismatches.map((m) => m.setting),
          },
        });
        throw new ContextReadbackMismatchError(mismatches);
      }

      const uow: PgUnitOfWork = { context, query: db, depth: 0, backendPid };
      const active: ActiveUnitOfWork = {
        context,
        client,
        db,
        backendPid,
        depth: 0,
        runnerId: this.#id,
      };

      const result = await this.#active.run(active, () => fn(uow));

      this.stats.statements += 1;
      this.stats.commits += 1;
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (!poisoned) {
        try {
          this.stats.statements += 1;
          this.stats.rollbacks += 1;
          await client.query('ROLLBACK');
        } catch {
          // A failing ROLLBACK means the backend is already gone (T-10). The
          // pool has removed the client; releasing with an error keeps the
          // intent explicit and is safe to repeat.
          poisoned = true;
        }
      }
      throw error;
    } finally {
      client.removeListener('error', swallowOutOfBandError);
      try {
        client.release(
          poisoned ? new Error('connection poisoned by the unit of work') : undefined,
        );
      } catch {
        /* already removed from the pool */
      }
    }
  }

  /**
   * A nested `run` is a **savepoint on the same connection**, never a second
   * transaction and never a second tenant.
   *
   * Worth knowing before you write concurrent code: because nesting is detected
   * through `AsyncLocalStorage`, calling `run` from inside another `run` always
   * produces a savepoint — even when the caller intended a genuinely concurrent
   * transaction. For the isolation invariant that is the correct default; for a
   * test author trying to make two units of work contend, it is a trap
   * (SPIKE-REPORT §6.6). Start the second one outside the first's async context.
   */
  async #runNested<T>(
    outer: ActiveUnitOfWork,
    context: TenantContext,
    fn: (uow: PgUnitOfWork) => Promise<T>,
  ): Promise<T> {
    // SPEC-01 §4.2: "No nested transaction may change tenant. Savepoints are
    // permitted; re-tenanting is not." Thrown BEFORE any statement, so the outer
    // transaction is untouched and the caller can recover.
    if (isTenantChange(outer.context, context)) {
      throw new NestedTenantChangeError(outer.context, context);
    }

    const depth = outer.depth + 1;
    this.#savepointCounter += 1;
    // The identifier is built from two integers this module owns. No caller
    // input reaches it, which is the only reason interpolation is acceptable
    // here at all — a savepoint name cannot be a bind parameter.
    const name = `sp_${String(depth)}_${String(this.#savepointCounter)}`;

    this.stats.statements += 1;
    await outer.client.query(`SAVEPOINT ${name}`);

    const uow: PgUnitOfWork = {
      // The tenant tuple stays the OUTER one. A nested call cannot change the
      // correlation id the audit chain will see either.
      context: outer.context,
      query: outer.db,
      depth,
      backendPid: outer.backendPid,
    };

    try {
      const result = await this.#active.run({ ...outer, depth }, () => fn(uow));
      this.stats.statements += 1;
      await outer.client.query(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      try {
        this.stats.statements += 1;
        await outer.client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      } catch {
        /* the outer transaction has already aborted */
      }
      throw error;
    }
  }

  /**
   * A Kysely instance bound to ONE already-checked-out client.
   *
   * The fake pool is the "no hidden connection checkout" guarantee TDG-02 asks
   * to be proven: `connect()` returns the client this unit of work owns and
   * `release()` does nothing, so Kysely cannot reach a second backend even if a
   * caller asks it to.
   */
  #kyselyBoundTo(client: pg.PoolClient): Kysely<Database> {
    const boundClient: PostgresPoolClient = {
      query: ((text: unknown, params?: unknown) => {
        this.stats.statements += 1;
        const sqlText =
          typeof text === 'string' ? text : ((text as { sql?: string }).sql ?? '');
        if (!PROTOCOL_STATEMENT.test(sqlText)) this.stats.tenantTableStatements += 1;
        return (client.query as (t: unknown, p?: unknown) => unknown)(text, params);
      }) as PostgresPoolClient['query'],
      release: () => {},
    };

    const boundPool: PostgresPool = {
      connect: async () => boundClient,
      end: async () => {},
    };

    return new Kysely<Database>({ dialect: new PostgresDialect({ pool: boundPool }) });
  }
}
