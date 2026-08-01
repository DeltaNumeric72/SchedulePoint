import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import type { PostgresPool, PostgresPoolClient } from 'kysely';
import { AlertSink } from './alerts.ts';
import type { DB } from './schema.ts';
import { connectionConfig, type RoleName } from './config.ts';

/* ────────────────────────────────────────────────────────────────────────────
 * SPEC-01 §4.2 — the unit of work.
 *
 *   acquire connection from pool
 *   BEGIN
 *   SELECT set_config('app.organization_id', $1, true)      -- transaction LOCAL
 *   SELECT set_config('app.group_id',        $2, true)
 *   SELECT set_config('app.membership_id',   $3, true)
 *   SELECT set_config('app.correlation_id',  $4, true)
 *   verify: read-back == expected
 *     on mismatch: ROLLBACK; POISON and discard the connection; raise
 *                  CONTEXT_READBACK_MISMATCH; emit a page-severity alert
 *   result := fn(tx)
 *   COMMIT
 *
 * The BEGIN/COMMIT are issued by THIS wrapper on a connection THIS wrapper
 * checked out — i.e. a caller-controlled transaction — and the four
 * `set_config(..., true)` calls are issued THROUGH KYSELY inside it. That
 * combination is precisely what TDG-02 requires to be proven.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface TenantContext {
  readonly organizationId: string;
  /** null for an organization-scoped unit of work (SPEC-01 §2.1, V-06). */
  readonly groupId: string | null;
  readonly membershipId: string;
  readonly correlationId: string;
}

export class ContextReadbackMismatchError extends Error {
  readonly code = 'CONTEXT_READBACK_MISMATCH';
  constructor(
    readonly mismatches: ReadonlyArray<{
      setting: string;
      expected: string;
      actual: string | null;
    }>,
  ) {
    super(
      `CONTEXT_READBACK_MISMATCH: ${mismatches
        .map((m) => `${m.setting} expected=${JSON.stringify(m.expected)} actual=${JSON.stringify(m.actual)}`)
        .join('; ')}`,
    );
    this.name = 'ContextReadbackMismatchError';
  }
}

export class NestedTenantChangeError extends Error {
  readonly code = 'NESTED_TENANT_CHANGE';
  constructor(outer: TenantContext, inner: TenantContext) {
    super(
      'NESTED_TENANT_CHANGE: a nested unit of work may not re-tenant. ' +
        `outer=(${outer.organizationId}, ${outer.groupId}) ` +
        `inner=(${inner.organizationId}, ${inner.groupId})`,
    );
    this.name = 'NestedTenantChangeError';
  }
}

/**
 * How the (simulated) connection pooler behaves. TDG-03 evidence.
 *
 *  - 'transaction-affinity': the correct mode. One backend for the whole unit
 *    of work; `SET LOCAL` survives to the COMMIT.
 *  - 'statement-drops-set-local': a faithful simulation of the prohibited
 *    statement-level pooling mode, in which the `set_config` statements are
 *    routed somewhere the subsequent statements do not see. The read-back must
 *    catch this.
 *  - 'statement-drops-group-id': the PARTIAL-loss case. Organization context
 *    survives but `app.group_id` does not. A read-back that only checked
 *    `app.organization_id` — which is all SPEC-01 §4.2's pseudo-code
 *    prescribes — would pass this and then run fail-OPEN at group scope,
 *    which is the CAR-001 defect class below the application layer.
 */
export type PoolerMode =
  | 'transaction-affinity'
  | 'statement-drops-set-local'
  | 'statement-drops-group-id';

export interface DbRuntime {
  readonly role: RoleName;
  readonly pool: pg.Pool;
  readonly alerts: AlertSink;
  poolerMode: PoolerMode;
  /** Backend PIDs the runtime has poisoned and discarded. */
  readonly poisonedPids: number[];
  /** Every statement this runtime has issued, however issued. T-15 evidence. */
  statements: number;
  destroy(): Promise<void>;
}

export function createRuntime(
  role: RoleName,
  options: {
    max?: number;
    connectionTimeoutMillis?: number;
    idleTimeoutMillis?: number;
    /** node-postgres client-side deadline, used by the T-08b probe. */
    queryTimeoutMillis?: number;
  } = {},
): DbRuntime {
  const pool = new pg.Pool({
    ...connectionConfig(role),
    max: options.max ?? 4,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    ...(options.queryTimeoutMillis ? { query_timeout: options.queryTimeoutMillis } : {}),
    allowExitOnIdle: true,
  });
  // A pool client that dies out-of-band (T-10) emits 'error'; without a
  // listener node-postgres turns it into an unhandled exception.
  pool.on('error', () => {});

  const runtime: DbRuntime = {
    role,
    pool,
    alerts: new AlertSink(),
    poolerMode: 'transaction-affinity',
    poisonedPids: [],
    statements: 0,
    async destroy() {
      await pool.end();
    },
  };
  return runtime;
}

/**
 * A Kysely instance bound to ONE already-checked-out client.
 *
 * This is the "no hidden connection checkout" proof required by TDG-02: the
 * fake pool hands Kysely the connection the unit of work already owns and its
 * `release()` is a no-op, so there is no code path by which a query built with
 * this Kysely instance can reach a different backend.
 */
function kyselyBoundTo(client: pg.PoolClient, runtime: DbRuntime): Kysely<DB> {
  let handouts = 0;
  const boundClient: PostgresPoolClient = {
    query: ((text: unknown, params?: unknown) => {
      runtime.statements++;
      return (client.query as (t: unknown, p?: unknown) => unknown)(text, params);
    }) as PostgresPoolClient['query'],
    release: () => {},
  };
  const fakePool: PostgresPool = {
    connect: async () => {
      handouts += 1;
      return boundClient;
    },
    end: async () => {},
  };
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: fakePool }) });
  Object.defineProperty(db, '__handouts', { get: () => handouts });
  return db;
}

export interface UnitOfWork {
  readonly db: Kysely<DB>;
  /** Escape hatch used only by the harness for protocol-level statements. */
  readonly client: pg.PoolClient;
  readonly ctx: TenantContext;
  readonly backendPid: number;
  readonly depth: number;
  readonly runtime: DbRuntime;
}

interface ActiveUow {
  ctx: TenantContext;
  client: pg.PoolClient;
  db: Kysely<DB>;
  backendPid: number;
  depth: number;
  runtime: DbRuntime;
}

const active = new AsyncLocalStorage<ActiveUow>();
let savepointCounter = 0;

/** For assertions: is the current async context inside a unit of work? */
export function currentUnitOfWork(): ActiveUow | undefined {
  return active.getStore();
}

const SETTINGS = [
  'app.organization_id',
  'app.group_id',
  'app.membership_id',
  'app.correlation_id',
] as const;

function settingValues(ctx: TenantContext): Record<(typeof SETTINGS)[number], string> {
  return {
    // `set_config` coerces NULL to the empty string; the RLS predicates use
    // `nullif(..., '')` so both spellings are fail-closed. Passing '' keeps the
    // read-back comparison exact.
    'app.organization_id': ctx.organizationId,
    'app.group_id': ctx.groupId ?? '',
    'app.membership_id': ctx.membershipId,
    'app.correlation_id': ctx.correlationId,
  };
}

export async function withUnitOfWork<T>(
  runtime: DbRuntime,
  ctx: TenantContext,
  fn: (uow: UnitOfWork) => Promise<T>,
): Promise<T> {
  const outer = active.getStore();
  if (outer) return withNestedUnitOfWork(outer, ctx, fn);

  const client = await runtime.pool.connect();
  const backendPid: number = (client as unknown as { processID: number }).processID;
  let poisoned = false;

  try {
    runtime.statements++;
    await client.query('BEGIN');

    const db = kyselyBoundTo(client, runtime);
    const expected = settingValues(ctx);

    // ── set the transaction-local context THROUGH Kysely (TDG-02) ───────────
    for (const name of SETTINGS) {
      // 'statement-drops-set-local': the simulated pooler routed EVERY
      // set_config elsewhere, so nothing lands on this backend.
      // 'statement-drops-group-id': only app.group_id was lost — the partial
      // case, which a single-setting read-back would miss.
      if (runtime.poolerMode === 'statement-drops-set-local') continue;
      if (runtime.poolerMode === 'statement-drops-group-id' && name === 'app.group_id') continue;
      await sql`select set_config(${name}, ${expected[name]}, true)`.execute(db);
    }

    // ── read-back verification (SPEC-01 §4.2) ───────────────────────────────
    const readback = await sql<{
      org: string | null;
      grp: string | null;
      mem: string | null;
      corr: string | null;
    }>`
      select current_setting('app.organization_id', true) as org,
             current_setting('app.group_id',        true) as grp,
             current_setting('app.membership_id',   true) as mem,
             current_setting('app.correlation_id',  true) as corr
    `.execute(db);

    const actual = readback.rows[0];
    const mismatches = [
      { setting: 'app.organization_id', expected: expected['app.organization_id'], actual: actual?.org ?? null },
      { setting: 'app.group_id', expected: expected['app.group_id'], actual: actual?.grp ?? null },
      { setting: 'app.membership_id', expected: expected['app.membership_id'], actual: actual?.mem ?? null },
      { setting: 'app.correlation_id', expected: expected['app.correlation_id'], actual: actual?.corr ?? null },
    ].filter((m) => m.actual !== m.expected);

    if (mismatches.length > 0) {
      // (a) abort the transaction
      try {
        runtime.statements++;
        await client.query('ROLLBACK');
      } catch {
        /* the connection is being discarded either way */
      }
      // (b) poison the connection — released with an error so the pool
      //     DESTROYS it rather than returning it to the idle set
      poisoned = true;
      runtime.poisonedPids.push(backendPid);
      // (c) page
      runtime.alerts.emit({
        severity: 'page',
        code: 'CONTEXT_READBACK_MISMATCH',
        message:
          'Transaction-local tenant context did not read back. The connection ' +
          'pooler is not preserving SET LOCAL (TDG-02 / TDG-03 failure mode).',
        detail: {
          role: runtime.role,
          backendPid,
          poolerMode: runtime.poolerMode,
          correlationId: ctx.correlationId,
          mismatches,
        },
      });
      throw new ContextReadbackMismatchError(mismatches);
    }

    const uow: UnitOfWork = { db, client, ctx, backendPid, depth: 0, runtime };
    const result = await active.run(
      { ctx, client, db, backendPid, depth: 0, runtime },
      () => fn(uow),
    );

    runtime.statements++;
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (!poisoned) {
      try {
        runtime.statements++;
        await client.query('ROLLBACK');
      } catch {
        // ROLLBACK itself failing means the backend is gone (T-10). The pool
        // has already removed the client; releasing with an error is
        // idempotent-safe and keeps the intent explicit.
        poisoned = true;
      }
    }
    throw error;
  } finally {
    try {
      client.release(
        poisoned ? new Error('connection poisoned by the unit of work') : undefined,
      );
    } catch {
      /* already removed from the pool */
    }
  }
}

async function withNestedUnitOfWork<T>(
  outer: ActiveUow,
  ctx: TenantContext,
  fn: (uow: UnitOfWork) => Promise<T>,
): Promise<T> {
  // SPEC-01 §4.2: "No nested transaction may change tenant ... Savepoints are
  // permitted; re-tenanting is not." Thrown BEFORE any statement is issued, so
  // the outer transaction is left untouched and the caller may recover.
  if (
    ctx.organizationId !== outer.ctx.organizationId ||
    (ctx.groupId ?? null) !== (outer.ctx.groupId ?? null)
  ) {
    throw new NestedTenantChangeError(outer.ctx, ctx);
  }

  const depth = outer.depth + 1;
  const name = `sp_${depth}_${++savepointCounter}`;
  outer.runtime.statements++;
  await outer.client.query(`SAVEPOINT ${name}`);

  const uow: UnitOfWork = {
    db: outer.db,
    client: outer.client,
    ctx: outer.ctx,
    backendPid: outer.backendPid,
    depth,
    runtime: outer.runtime,
  };

  try {
    const result = await active.run({ ...outer, depth }, () => fn(uow));
    outer.runtime.statements++;
    await outer.client.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    try {
      outer.runtime.statements++;
      await outer.client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    } catch {
      /* outer transaction already aborted */
    }
    throw error;
  }
}

/**
 * A raw, unwrapped statement — deliberately NOT inside a unit of work.
 * Used by the fail-closed probes (T-13). Nothing else may use it.
 */
export async function outsideUnitOfWork<T = unknown>(
  runtime: DbRuntime,
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T & pg.QueryResultRow>> {
  const client = await runtime.pool.connect();
  try {
    runtime.statements++;
    return (await client.query(text, params)) as pg.QueryResult<T & pg.QueryResultRow>;
  } finally {
    client.release();
  }
}
