/**
 * OPUS-M0-001 / SP-A — tenant-isolation unit-of-work harness.
 *
 * Test-id mapping (SPEC-01 §7.2 is authoritative):
 *   T-07  exception mid-transaction
 *   T-08  statement cancellation / client timeout
 *   T-09  statement timeout at the server
 *   T-10  connection killed mid-transaction
 *   T-11  nested unit of work, same tenant        (savepoint permitted)
 *   T-12  nested unit of work, different tenant   (throws)
 *   T-13  query issued outside any unit of work   (fail-closed)
 *   T-13b group predicate, same organization      (fail-closed)
 *   T-14  pooler in statement-pooling mode        (abort + discard + alert)
 *   T-15  interleaved two-organization storm      (zero wrong-tenant rows)
 *
 * Everything prefixed A-, B-, X- is additional evidence the packet asks for on
 * top of the SPEC-01 numbering (role matrix, SP-2 constraint expressiveness,
 * transaction affinity, statement-pooling counter-demonstration, worker probe,
 * pool reuse, FOR UPDATE, and a static no-session-SET check).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { sql } from 'kysely';

import { FIXTURE, MIGRATIONS_DIR, SPIKE_ROOT, connectionConfig } from '../src/config.ts';
import { SpikeCluster } from '../src/cluster.ts';
import { migrateCycle } from '../src/migrate.ts';
import {
  TENANT_TABLES,
  groupContext,
  impossibleCensusRows,
  orgContext,
  seed,
  tenantRowCensus,
  wrongTenantProbeSql,
} from '../src/seed.ts';
import {
  ContextReadbackMismatchError,
  NestedTenantChangeError,
  createRuntime,
  currentUnitOfWork,
  outsideUnitOfWork,
  withUnitOfWork,
  type DbRuntime,
  type TenantContext,
} from '../src/unit-of-work.ts';

/* ── shared fixtures ─────────────────────────────────────────────────────── */

const cluster = new SpikeCluster();
let admin: pg.Client;
let runtime: DbRuntime; // app_runtime, pool max 4
let worker: DbRuntime; // app_worker,  pool max 2
let cycleResult: { up1: string[]; down: string[]; up2: string[] };
let serverVersion = '';

const ctxA1 = () => groupContext('A', 1);
const ctxA2 = () => groupContext('A', 2);
const ctxB1 = () => groupContext('B', 1);

before(async () => {
  await cluster.start({ fresh: true });
  await cluster.bootstrapRolesAndDatabase();

  // SP-2 reversibility is proved as part of setup so that no later test can
  // depend on schema state the cycle would have destroyed. B-01 asserts on it.
  cycleResult = await migrateCycle();

  admin = cluster.adminClient();
  await admin.connect();
  serverVersion = (await admin.query('select version() as v')).rows[0].v;

  runtime = createRuntime('app_runtime', { max: 4 });
  worker = createRuntime('app_worker', { max: 2 });

  await seed(runtime);
});

after(async () => {
  await runtime?.destroy();
  await worker?.destroy();
  await admin?.end();
  await cluster.stop();
});

/* ── helpers ─────────────────────────────────────────────────────────────── */

async function expectPgError(fn: () => Promise<unknown>, code: string, what: string) {
  await assert.rejects(
    fn(),
    (e: unknown) => {
      const err = e as { code?: string; message?: string };
      assert.equal(err.code, code, `${what}: expected SQLSTATE ${code}, got ${err.code} (${err.message})`);
      return true;
    },
    what,
  );
}

/**
 * "No context" means one of exactly two values.
 *
 * On a PRISTINE backend a never-set custom GUC reads back as NULL. On a REUSED
 * backend — one that has previously run a unit of work — the placeholder
 * survives the transaction with the EMPTY STRING as its reset value, because
 * `SET LOCAL` reverts a GUC's value, it does not undefine the GUC. Both are
 * "no tenant", and both are fail-closed. See X-09, which pins this down and
 * shows why the RLS predicates must use `nullif(..., '')`.
 */
function assertNoTenantValue(actual: string | null, label: string) {
  assert.ok(
    actual === null || actual === '',
    `${label}: expected no tenant value, found ${JSON.stringify(actual)}`,
  );
}

/**
 * Grab every connection the pool can hold and assert not one of them carries
 * tenant context, and not one of them can see a tenant row. This is the
 * "next checkout sees no setting" clause of T-07..T-10, checked across the
 * whole pool rather than against a single lucky checkout.
 */
async function assertPoolIsClean(rt: DbRuntime, label: string) {
  const max = (rt.pool as unknown as { options: { max: number } }).options.max;
  const clients = await Promise.all(Array.from({ length: max }, () => rt.pool.connect()));
  try {
    for (const c of clients) {
      const s = await c.query(
        `select current_setting('app.organization_id', true) as org,
                current_setting('app.group_id',        true) as grp,
                current_setting('app.membership_id',   true) as mem,
                pg_backend_pid() as pid`,
      );
      const row = s.rows[0];
      assertNoTenantValue(row.org, `${label}: backend ${row.pid} app.organization_id`);
      assertNoTenantValue(row.grp, `${label}: backend ${row.pid} app.group_id`);
      assertNoTenantValue(row.mem, `${label}: backend ${row.pid} app.membership_id`);

      // The consequence that actually matters, asserted directly.
      const t = await c.query('select count(*)::int as n from things');
      assert.equal(t.rows[0].n, 0, `${label}: backend ${row.pid} sees ${t.rows[0].n} rows outside the wrapper`);
    }
  } finally {
    for (const c of clients) c.release();
  }
}

async function countThingsNamed(name: string): Promise<number> {
  const r = await admin.query('select count(*)::int as n from things where name = $1', [name]);
  return r.rows[0].n;
}

function log(...parts: unknown[]) {
  console.log('      ·', ...parts);
}

/* ════════════════════════════════════════════════════════════════════════════
 * Suite A — environment and the SPEC-01 §4.4 role matrix
 * ══════════════════════════════════════════════════════════════════════════ */

test('A-01 environment: real PostgreSQL 17.x, user-space (FAD-7 substitution)', () => {
  log(serverVersion);
  assert.match(serverVersion, /^PostgreSQL 17\./, 'expected a PostgreSQL 17.x server');
});

test('A-02 the five roles exist with the attributes SPEC-01 §4.4 requires', async () => {
  const r = await admin.query<{
    rolname: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
    rolcanlogin: boolean;
  }>(
    `select rolname, rolsuper, rolbypassrls, rolcanlogin
       from pg_roles where rolname like 'app\\_%' order by rolname`,
  );
  const byName = Object.fromEntries(r.rows.map((x) => [x.rolname, x]));
  log(r.rows.map((x) => `${x.rolname}{super:${x.rolsuper},bypassrls:${x.rolbypassrls}}`).join('  '));

  assert.deepEqual(Object.keys(byName).sort(), [
    'app_breakglass',
    'app_migrator',
    'app_readonly_support',
    'app_runtime',
    'app_worker',
  ]);

  for (const name of ['app_migrator', 'app_runtime', 'app_worker', 'app_readonly_support']) {
    assert.equal(byName[name].rolsuper, false, `${name} must not be superuser`);
    assert.equal(byName[name].rolbypassrls, false, `${name} must not hold BYPASSRLS`);
  }
  // Break-glass is the ONE role that may bypass; it is what makes it break-glass.
  assert.equal(byName.app_breakglass.rolbypassrls, true);
  assert.equal(byName.app_breakglass.rolsuper, false);
});

test('A-03 every tenant table has RLS ENABLED and FORCED', async () => {
  const r = await admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; owner: string }>(
    `select c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) as owner
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname <> 'pgmigrations'
      order by c.relname`,
  );
  log(r.rows.map((x) => `${x.relname}(owner=${x.owner},rls=${x.relrowsecurity},force=${x.relforcerowsecurity})`).join(' '));
  assert.equal(r.rows.length, 8, 'expected 8 tenant tables');
  for (const row of r.rows) {
    assert.equal(row.relrowsecurity, true, `${row.relname}: RLS not enabled`);
    assert.equal(row.relforcerowsecurity, true, `${row.relname}: RLS not FORCED`);
    assert.equal(row.owner, 'app_migrator', `${row.relname}: owner must be app_migrator`);
  }
});

test('A-04 FORCE RLS binds the owner too: app_migrator sees zero rows without context', async () => {
  const c = new pg.Client(connectionConfig('app_migrator'));
  await c.connect();
  try {
    const n = (await c.query('select count(*)::int as n from things')).rows[0].n;
    log(`app_migrator (schema owner) sees ${n} rows in things with no context`);
    assert.equal(n, 0, 'FORCE ROW LEVEL SECURITY did not bind the table owner');
  } finally {
    await c.end();
  }
});

test('A-05 no runtime role holds TRUNCATE or REFERENCES on ANY tenant table (not RLS-governed, S-03)', async () => {
  // All eight tenant tables, not a sample: neither privilege is governed by
  // RLS, so the grant is the only control and a gap anywhere is a gap.
  const tableList = TENANT_TABLES.map((t) => `('${t.name}')`).join(',');
  const r = await admin.query<{ role: string; tbl: string; trunc: boolean; refs: boolean }>(
    `select g.role, t.tbl,
            has_table_privilege(g.role, t.tbl, 'TRUNCATE')  as trunc,
            has_table_privilege(g.role, t.tbl, 'REFERENCES') as refs
       from (values ('app_runtime'),('app_worker'),('app_readonly_support'),('app_breakglass')) g(role)
       cross join (values ${tableList}) t(tbl)`,
  );
  const bad = r.rows.filter((x) => x.trunc || x.refs);
  log(`${r.rows.length} (role,table) pairs checked across all ${TENANT_TABLES.length} tenant tables; violations: ${bad.length}`);
  assert.equal(r.rows.length, 4 * TENANT_TABLES.length);
  assert.deepEqual(bad, [], 'a runtime role holds TRUNCATE or REFERENCES');
});

test('A-06 app_runtime cannot disable RLS on a table it does not own', async () => {
  await expectPgError(
    () => outsideUnitOfWork(runtime, 'alter table things disable row level security'),
    '42501',
    'app_runtime must not be able to disable RLS',
  );
});

test('A-07 app_readonly_support: SELECT under context works, every write is denied', async () => {
  const support = createRuntime('app_readonly_support', { max: 2 });
  try {
    const ctx = ctxA1();
    const visible = await withUnitOfWork(support, ctx, async ({ db }) => {
      const r = await db.selectFrom('things').select(['id']).execute();
      return r.length;
    });
    log(`app_readonly_support sees ${visible} things under Org A / Group A1 context`);
    assert.ok(visible > 0, 'support role should read under an explicit tenant context');

    await assert.rejects(
      withUnitOfWork(support, ctx, async ({ db }) => {
        await db
          .insertInto('things')
          .values({ id: randomUUID(), organization_id: ctx.organizationId, group_id: ctx.groupId!, name: 'support-write' })
          .execute();
      }),
      (e: unknown) => (e as { code?: string }).code === '42501',
      'support role must not be able to write',
    );

    // ...and it is still fail-closed outside the wrapper.
    const r = await outsideUnitOfWork(support, 'select count(*)::int as n from things');
    assert.equal((r.rows[0] as { n: number }).n, 0);
  } finally {
    await support.destroy();
  }
});

test('A-08 app_breakglass genuinely differs: BYPASSRLS sees both organizations', async () => {
  const bg = createRuntime('app_breakglass', { max: 1 });
  try {
    const r = await outsideUnitOfWork<{ orgs: number; n: number }>(
      bg,
      'select count(distinct organization_id)::int as orgs, count(*)::int as n from things',
    );
    const { orgs, n } = r.rows[0];
    log(`app_breakglass sees ${n} rows across ${orgs} organizations with NO context`);
    assert.equal(orgs, 2, 'break-glass must see both organizations (that is what makes it break-glass)');
    assert.ok(n > 0);
  } finally {
    await bg.destroy();
  }
});

/* ════════════════════════════════════════════════════════════════════════════
 * Suite B — SP-2 constraint expressiveness (TDG-02)
 * ══════════════════════════════════════════════════════════════════════════ */

test('B-01 migrations run up, down, and up again (plain SQL, node-pg-migrate)', () => {
  log(`up#1  ${JSON.stringify(cycleResult.up1)}`);
  log(`down  ${JSON.stringify(cycleResult.down)}`);
  log(`up#2  ${JSON.stringify(cycleResult.up2)}`);
  assert.deepEqual(cycleResult.up1, ['0001_tenant_schema_and_rls', '0002_constraint_expressiveness']);
  assert.deepEqual(cycleResult.down, ['0002_constraint_expressiveness', '0001_tenant_schema_and_rls']);
  assert.deepEqual(cycleResult.up2, cycleResult.up1);
});

test('B-02 EXCLUSION CONSTRAINT: non-overlapping accepted, overlapping rejected', async () => {
  const ctx = ctxA1();
  const versionId = randomUUID();
  const membership = randomUUID();

  await withUnitOfWork(runtime, ctx, async ({ db }) => {
    await db
      .insertInto('schedule_versions')
      .values({ id: versionId, organization_id: ctx.organizationId, group_id: ctx.groupId!, version: 900, status: 'draft', label: 'excl-demo' })
      .execute();
  });

  // positive: two adjacent, non-overlapping ranges
  await withUnitOfWork(runtime, ctx, async ({ db }) => {
    await db
      .insertInto('assignments')
      .values([
        { id: randomUUID(), organization_id: ctx.organizationId, group_id: ctx.groupId!, membership_id: membership, schedule_version_id: versionId, during: '[2026-01-01 08:00+00,2026-01-01 16:00+00)' },
        { id: randomUUID(), organization_id: ctx.organizationId, group_id: ctx.groupId!, membership_id: membership, schedule_version_id: versionId, during: '[2026-01-01 16:00+00,2026-01-02 00:00+00)' },
      ])
      .execute();
  });
  log('positive: two adjacent shifts for one membership accepted');

  // negative: an overlapping range
  await assert.rejects(
    withUnitOfWork(runtime, ctx, async ({ db }) => {
      await db
        .insertInto('assignments')
        .values({ id: randomUUID(), organization_id: ctx.organizationId, group_id: ctx.groupId!, membership_id: membership, schedule_version_id: versionId, during: '[2026-01-01 12:00+00,2026-01-01 20:00+00)' })
        .execute();
    }),
    (e: unknown) => {
      const err = e as { code?: string; constraint?: string };
      assert.equal(err.code, '23P01', `expected exclusion_violation, got ${err.code}`);
      assert.equal(err.constraint, 'assignments_no_overlap');
      log(`negative: overlapping shift rejected by ${err.constraint} (SQLSTATE ${err.code})`);
      return true;
    },
  );
});

test('B-03 PARTIAL UNIQUE INDEX: many non-accepted rows, exactly one accepted', async () => {
  const ctx = ctxA1();
  const turnId = randomUUID();
  const row = (status: string) => ({
    id: randomUUID(),
    organization_id: ctx.organizationId,
    group_id: ctx.groupId!,
    turn_id: turnId,
    membership_id: randomUUID(),
    status: status as 'offered' | 'declined' | 'accepted' | 'expired',
  });

  await withUnitOfWork(runtime, ctx, async ({ db }) => {
    await db.insertInto('picklist_turns').values([row('offered'), row('declined'), row('expired'), row('offered')]).execute();
    await db.insertInto('picklist_turns').values(row('accepted')).execute();
  });
  log('positive: 4 non-accepted rows + 1 accepted row for one turn accepted');

  await assert.rejects(
    withUnitOfWork(runtime, ctx, async ({ db }) => {
      await db.insertInto('picklist_turns').values(row('accepted')).execute();
    }),
    (e: unknown) => {
      const err = e as { code?: string; constraint?: string };
      assert.equal(err.code, '23505', `expected unique_violation, got ${err.code}`);
      assert.equal(err.constraint, 'picklist_turns_one_accepted');
      log(`negative: a second accepted holder rejected by ${err.constraint} (SQLSTATE ${err.code})`);
      return true;
    },
  );
});

test('B-04 BEFORE UPDATE TRIGGER: draft is mutable, published is immutable', async () => {
  const ctx = ctxA1();
  const draftId = randomUUID();
  const publishedId = randomUUID();

  await withUnitOfWork(runtime, ctx, async ({ db }) => {
    await db
      .insertInto('schedule_versions')
      .values([
        { id: draftId, organization_id: ctx.organizationId, group_id: ctx.groupId!, version: 901, status: 'draft', label: 'trig-draft' },
        { id: publishedId, organization_id: ctx.organizationId, group_id: ctx.groupId!, version: 902, status: 'published', label: 'trig-published' },
      ])
      .execute();
  });

  const updated = await withUnitOfWork(runtime, ctx, async ({ db }) => {
    const r = await db.updateTable('schedule_versions').set({ label: 'trig-draft-edited' }).where('id', '=', draftId).executeTakeFirst();
    return Number(r.numUpdatedRows);
  });
  assert.equal(updated, 1);
  log('positive: a draft schedule version updated');

  await assert.rejects(
    withUnitOfWork(runtime, ctx, async ({ db }) => {
      await db.updateTable('schedule_versions').set({ label: 'nope' }).where('id', '=', publishedId).execute();
    }),
    (e: unknown) => {
      const err = e as { code?: string; message?: string };
      assert.equal(err.code, '23001', `expected restrict_violation, got ${err.code}`);
      assert.match(err.message ?? '', /is published and is immutable/);
      log(`negative: updating a published version rejected (SQLSTATE ${err.code})`);
      return true;
    },
  );

  const stillPublished = await admin.query('select label from schedule_versions where id = $1', [publishedId]);
  assert.equal(stillPublished.rows[0].label, 'trig-published');
});

test('B-05 FOR UPDATE is expressible through Kysely and genuinely locks', async () => {
  const ctx = ctxA1();
  const id = randomUUID();
  await withUnitOfWork(runtime, ctx, async ({ db }) => {
    await db
      .insertInto('schedule_versions')
      .values({ id, organization_id: ctx.organizationId, group_id: ctx.groupId!, version: 903, status: 'draft', label: 'lock-demo' })
      .execute();
  });

  // The contender must be a GENUINELY concurrent unit of work, not a nested
  // one: a nested same-tenant call is a savepoint on the very connection that
  // already holds the lock, so it would trivially succeed. Both units of work
  // are therefore started at the top level and coordinated with barriers.
  let lockAcquired!: () => void;
  let releaseOuter!: () => void;
  const acquired = new Promise<void>((r) => (lockAcquired = r));
  const holdUntil = new Promise<void>((r) => (releaseOuter = r));
  let outerPid = 0;
  let contenderPid = 0;

  const outer = withUnitOfWork(runtime, ctx, async ({ db, backendPid }) => {
    outerPid = backendPid;
    const locked = await db.selectFrom('schedule_versions').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    assert.equal(locked?.id, id);
    lockAcquired();
    await holdUntil;
  });

  await acquired;
  log(`backend ${outerPid} holds FOR UPDATE on the row`);

  const contended = await withUnitOfWork(runtime, ctxA1(), async ({ db, backendPid }) => {
    contenderPid = backendPid;
    await db.selectFrom('schedule_versions').selectAll().where('id', '=', id).forUpdate().noWait().execute();
    return 'acquired-the-lock';
  }).catch((e: unknown) => e);

  releaseOuter();
  await outer;

  assert.notEqual(contenderPid, outerPid, 'the contender must be on a different backend');
  const err = contended as { code?: string };
  log(`concurrent FOR UPDATE NOWAIT on backend ${contenderPid} rejected with SQLSTATE ${err?.code}`);
  assert.equal(err?.code, '55P03', 'expected lock_not_available');
});

/* ════════════════════════════════════════════════════════════════════════════
 * Suite C — SPEC-01 §7.2, T-07..T-15
 * ══════════════════════════════════════════════════════════════════════════ */

test('T-07 exception mid-transaction: rollback, and the next checkout sees no setting', async () => {
  const ctx = ctxA1();
  const marker = `t07-${randomUUID()}`;
  let pid = 0;

  await assert.rejects(
    withUnitOfWork(runtime, ctx, async ({ db, backendPid }) => {
      pid = backendPid;
      await db
        .insertInto('things')
        .values({ id: randomUUID(), organization_id: ctx.organizationId, group_id: ctx.groupId!, name: marker })
        .execute();
      throw new Error('deliberate mid-transaction failure');
    }),
    /deliberate mid-transaction failure/,
  );

  assert.equal(await countThingsNamed(marker), 0, 'the aborted insert was not rolled back');
  log(`backend ${pid}: insert rolled back, 0 rows named ${marker}`);
  await assertPoolIsClean(runtime, 'T-07');
});

test('T-08 statement cancellation: 57014, rollback, no lingering setting', async () => {
  const ctx = ctxA1();
  const marker = `t08-${randomUUID()}`;
  let cancelIssued: Promise<unknown> = Promise.resolve();

  await assert.rejects(
    withUnitOfWork(runtime, ctx, async ({ db, client, backendPid }) => {
      await db
        .insertInto('things')
        .values({ id: randomUUID(), organization_id: ctx.organizationId, group_id: ctx.groupId!, name: marker })
        .execute();
      cancelIssued = new Promise((resolve) => {
        setTimeout(() => resolve(admin.query('select pg_cancel_backend($1)', [backendPid])), 200);
      });
      await client.query('select pg_sleep(10)');
    }),
    (e: unknown) => {
      const err = e as { code?: string; message?: string };
      assert.equal(err.code, '57014', `expected query_canceled, got ${err.code}`);
      assert.match(err.message ?? '', /canceling statement due to user request/);
      log(`cancelled: SQLSTATE ${err.code} — ${err.message}`);
      return true;
    },
  );
  await cancelIssued;

  assert.equal(await countThingsNamed(marker), 0, 'cancelled transaction was not rolled back');
  await assertPoolIsClean(runtime, 'T-08 (cancellation)');
});

test('T-08b client-side timeout: the client abandons, rollback still holds', async () => {
  // A genuinely client-side deadline (node-postgres `query_timeout`), which is
  // a different failure shape from a server cancellation: the driver, not the
  // server, ends the wait.
  const rt = createRuntime('app_runtime', { max: 2, queryTimeoutMillis: 400 });
  const ctx = ctxA1();
  const marker = `t08b-${randomUUID()}`;

  try {
    await assert.rejects(
      withUnitOfWork(rt, ctx, async ({ db, client }) => {
        await db
          .insertInto('things')
          .values({ id: randomUUID(), organization_id: ctx.organizationId, group_id: ctx.groupId!, name: marker })
          .execute();
        await client.query('select pg_sleep(10)');
      }),
      (e: unknown) => {
        const err = e as { code?: string; message?: string };
        // A CLIENT-side deadline: node-postgres gives up waiting. It is not a
        // server cancellation, so there is deliberately no SQLSTATE — pinning
        // that absence is part of distinguishing this from T-08 and T-09.
        assert.match(err.message ?? '', /Query read timeout/, `unexpected client-timeout shape: ${err.message}`);
        assert.equal(err.code, undefined, 'a client-side timeout must not carry a server SQLSTATE');
        log(`client timeout surfaced as: ${err.message} (SQLSTATE ${String(err.code)})`);
        return true;
      },
    );
    assert.equal(await countThingsNamed(marker), 0, 'abandoned transaction was not rolled back');
    await assertPoolIsClean(rt, 'T-08b (client timeout)');
  } finally {
    await rt.destroy();
  }
});

test('T-09 server statement_timeout: 57014, rollback, no lingering setting', async () => {
  const ctx = ctxA1();
  const marker = `t09-${randomUUID()}`;

  await assert.rejects(
    withUnitOfWork(runtime, ctx, async ({ db, client }) => {
      await db
        .insertInto('things')
        .values({ id: randomUUID(), organization_id: ctx.organizationId, group_id: ctx.groupId!, name: marker })
        .execute();
      await client.query(`set local statement_timeout = '150ms'`);
      await client.query('select pg_sleep(5)');
    }),
    (e: unknown) => {
      const err = e as { code?: string; message?: string };
      assert.equal(err.code, '57014', `expected query_canceled, got ${err.code}`);
      assert.match(err.message ?? '', /statement timeout/);
      log(`server timeout: SQLSTATE ${err.code} — ${err.message}`);
      return true;
    },
  );

  assert.equal(await countThingsNamed(marker), 0);
  await assertPoolIsClean(runtime, 'T-09');
  // statement_timeout was itself SET LOCAL, so it expired with the transaction.
  // (`SHOW` cannot be aliased, hence current_setting.)
  const st = await outsideUnitOfWork<{ v: string }>(runtime, `select current_setting('statement_timeout') as v`);
  log(`statement_timeout after the transaction: ${st.rows[0].v}`);
  assert.equal(st.rows[0].v, '0', 'a SET LOCAL statement_timeout leaked past the transaction');
});

test('T-10 connection killed mid-transaction: pool discards it, no lingering setting', async () => {
  const ctx = ctxA1();
  const marker = `t10-${randomUUID()}`;
  let killedPid = 0;
  let killIssued: Promise<unknown> = Promise.resolve();

  await assert.rejects(
    withUnitOfWork(runtime, ctx, async ({ db, client, backendPid }) => {
      killedPid = backendPid;
      await db
        .insertInto('things')
        .values({ id: randomUUID(), organization_id: ctx.organizationId, group_id: ctx.groupId!, name: marker })
        .execute();
      killIssued = new Promise((resolve) => {
        setTimeout(() => resolve(admin.query('select pg_terminate_backend($1)', [backendPid]).catch(() => {})), 200);
      });
      await client.query('select pg_sleep(10)');
    }),
    (e: unknown) => {
      const err = e as { code?: string; message?: string; severity?: string };
      // 57P01 admin_shutdown is what the server sends before the socket dies.
      // If the FATAL arrives after the socket has already closed, node-postgres
      // surfaces its own connection-terminated error with no SQLSTATE — both
      // are legitimate symptoms of the same kill, and nothing else is.
      const terminated =
        err.code === '57P01' ||
        /terminating connection due to administrator command/.test(err.message ?? '') ||
        /Connection terminated unexpectedly/.test(err.message ?? '');
      assert.ok(terminated, `expected a connection-terminated symptom, got code=${err.code} message=${err.message}`);
      log(`killed backend ${killedPid}: SQLSTATE ${String(err.code)} — ${err.message}`);
      return true;
    },
  );
  await killIssued;

  assert.equal(await countThingsNamed(marker), 0, 'the killed transaction left a row behind');

  const stillAlive = await admin.query('select count(*)::int as n from pg_stat_activity where pid = $1', [killedPid]);
  assert.equal(stillAlive.rows[0].n, 0, 'the terminated backend is still present');

  // The pool must never hand that connection to another borrower.
  const max = (runtime.pool as unknown as { options: { max: number } }).options.max;
  const clients = await Promise.all(Array.from({ length: max }, () => runtime.pool.connect()));
  const pids = clients.map((c) => (c as unknown as { processID: number }).processID);
  for (const c of clients) c.release();
  log(`pool now holds backends ${pids.join(',')}; killed backend ${killedPid} is absent: ${!pids.includes(killedPid)}`);
  assert.ok(!pids.includes(killedPid), 'the pool handed out a dead connection');

  await assertPoolIsClean(runtime, 'T-10');
});

test('T-11 nested unit of work, same tenant: permitted, and behaves as a savepoint', async () => {
  const ctx = ctxA1();
  const outerMarker = `t11-outer-${randomUUID()}`;
  const innerMarker = `t11-inner-${randomUUID()}`;

  const pids = await withUnitOfWork(runtime, ctx, async ({ db, backendPid, depth }) => {
    assert.equal(depth, 0);
    await db
      .insertInto('things')
      .values({ id: randomUUID(), organization_id: ctx.organizationId, group_id: ctx.groupId!, name: outerMarker })
      .execute();

    let innerPid = 0;
    // Nested with the SAME tenant tuple: allowed, and rolled back independently.
    await assert.rejects(
      withUnitOfWork(runtime, { ...ctx, correlationId: randomUUID() }, async (inner) => {
        innerPid = inner.backendPid;
        assert.equal(inner.depth, 1, 'nested unit of work should report depth 1');
        await inner.db
          .insertInto('things')
          .values({ id: randomUUID(), organization_id: ctx.organizationId, group_id: ctx.groupId!, name: innerMarker })
          .execute();
        throw new Error('inner failure');
      }),
      /inner failure/,
    );

    // The outer transaction survives the inner rollback — that is the savepoint.
    const visible = await db.selectFrom('things').select(['name']).where('name', 'in', [outerMarker, innerMarker]).execute();
    assert.deepEqual(visible.map((v) => v.name), [outerMarker]);
    return { backendPid, innerPid };
  });

  assert.equal(pids.innerPid, pids.backendPid, 'a nested unit of work must stay on the same backend');
  assert.equal(await countThingsNamed(outerMarker), 1, 'outer write should have committed');
  assert.equal(await countThingsNamed(innerMarker), 0, 'inner write should have rolled back to the savepoint');
  log(`same backend ${pids.backendPid}; outer committed, inner rolled back to savepoint`);
});

test('T-12 nested unit of work, DIFFERENT tenant: throws, outer is untouched', async () => {
  const ctx = ctxA1();
  const marker = `t12-${randomUUID()}`;

  await withUnitOfWork(runtime, ctx, async ({ db }) => {
    await db
      .insertInto('things')
      .values({ id: randomUUID(), organization_id: ctx.organizationId, group_id: ctx.groupId!, name: marker })
      .execute();

    // Different organization
    await assert.rejects(
      withUnitOfWork(runtime, ctxB1(), async () => {
        throw new Error('this callback must never run');
      }),
      (e: unknown) => {
        assert.ok(e instanceof NestedTenantChangeError, `expected NestedTenantChangeError, got ${String(e)}`);
        log(`cross-organization re-tenanting refused: ${(e as Error).message}`);
        return true;
      },
    );

    // Different group within the SAME organization — the CAR-001 defect class.
    await assert.rejects(
      withUnitOfWork(runtime, ctxA2(), async () => {
        throw new Error('this callback must never run');
      }),
      (e: unknown) => {
        assert.ok(e instanceof NestedTenantChangeError);
        log(`same-organization, cross-group re-tenanting refused: ${(e as Error).message}`);
        return true;
      },
    );

    // The outer transaction is still healthy and still tenanted correctly.
    const rows = await db.selectFrom('things').select(['organization_id', 'group_id']).execute();
    assert.ok(rows.every((r) => r.organization_id === ctx.organizationId && r.group_id === ctx.groupId));
  });

  assert.equal(await countThingsNamed(marker), 1, 'the outer transaction should still have committed');
});

test('T-13 outside any unit of work: zero rows and every write rejected (fail-closed)', async () => {
  for (const [label, rt] of [['app_runtime', runtime], ['app_worker', worker]] as const) {
    const r = await outsideUnitOfWork<{ n: number }>(rt, 'select count(*)::int as n from things');
    assert.equal(r.rows[0].n, 0, `${label}: reads leaked outside the wrapper`);

    for (const stmt of [
      `insert into things (id, organization_id, group_id, name) values (gen_random_uuid(), '${FIXTURE.orgA.id}', '${FIXTURE.orgA.groupA1}', 'outside-write')`,
      `update things set name = 'hijacked'`,
      `delete from things`,
    ]) {
      const res = await outsideUnitOfWork(rt, stmt).catch((e: { code?: string }) => e);
      if (stmt.startsWith('insert')) {
        // A WITH CHECK failure is an error (42501 new row violates RLS policy).
        assert.equal((res as { code?: string }).code, '42501', `${label}: insert outside the wrapper was not rejected`);
      } else {
        // USING makes the row invisible, so the write affects nothing at all.
        assert.equal((res as pg.QueryResult).rowCount, 0, `${label}: ${stmt.slice(0, 20)} affected rows outside the wrapper`);
      }
    }
    log(`${label}: 0 rows readable, insert rejected 42501, update/delete affected 0 rows`);
  }

  // And the probe really is outside — no ambient unit of work exists here.
  assert.equal(currentUnitOfWork(), undefined);
});

test('T-13b group predicate: Group A1 context cannot see or write Group A2, same organization', async () => {
  const ctx = ctxA1();
  const a2Things = await admin.query<{ id: string }>('select id from things where group_id = $1 limit 1', [FIXTURE.orgA.groupA2]);
  assert.ok(a2Things.rows.length === 1, 'fixture must contain a Group A2 row');
  const a2Id = a2Things.rows[0].id;

  await withUnitOfWork(runtime, ctx, async ({ db }) => {
    // read
    const seen = await db.selectFrom('things').select(['group_id']).execute();
    assert.ok(seen.length > 0);
    assert.ok(seen.every((r) => r.group_id === ctx.groupId), 'a Group A2 row was visible under Group A1 context');

    const direct = await db.selectFrom('things').selectAll().where('id', '=', a2Id).execute();
    assert.equal(direct.length, 0, 'a Group A2 row was addressable by id under Group A1 context');

    // write: update/delete affect nothing
    const upd = await db.updateTable('things').set({ name: 'cross-group-hijack' }).where('id', '=', a2Id).executeTakeFirst();
    assert.equal(Number(upd.numUpdatedRows), 0);
    const del = await db.deleteFrom('things').where('id', '=', a2Id).executeTakeFirst();
    assert.equal(Number(del.numDeletedRows), 0);

    // write: an insert declaring Group A2 fails WITH CHECK
    await assert.rejects(
      db
        .insertInto('things')
        .values({ id: randomUUID(), organization_id: ctx.organizationId, group_id: FIXTURE.orgA.groupA2, name: 'cross-group-insert' })
        .execute(),
      (e: unknown) => (e as { code?: string }).code === '42501',
    );
  });

  const untouched = await admin.query('select name from things where id = $1', [a2Id]);
  assert.notEqual(untouched.rows[0].name, 'cross-group-hijack');
  log('Group A2 rows invisible, unaddressable, unwritable and unmodified under Group A1 context');
});

test('T-14 statement-pooling mode: transaction aborts, connection discarded, page alert emitted', async () => {
  const faulty = createRuntime('app_runtime', { max: 3 });
  const ctx = ctxA1();
  const marker = `t14-${randomUUID()}`;
  let callbackRan = false;

  try {
    faulty.poolerMode = 'statement-drops-set-local';

    await assert.rejects(
      withUnitOfWork(faulty, ctx, async ({ db }) => {
        callbackRan = true;
        await db
          .insertInto('things')
          .values({ id: randomUUID(), organization_id: ctx.organizationId, group_id: ctx.groupId!, name: marker })
          .execute();
      }),
      (e: unknown) => {
        assert.ok(e instanceof ContextReadbackMismatchError, `expected ContextReadbackMismatchError, got ${String(e)}`);
        assert.equal((e as ContextReadbackMismatchError).code, 'CONTEXT_READBACK_MISMATCH');
        log(`(a) ${(e as Error).message}`);
        return true;
      },
    );

    // (a) transaction aborted, no row written, the callback never even ran
    assert.equal(callbackRan, false, 'the unit of work body ran despite a read-back mismatch');
    assert.equal(await countThingsNamed(marker), 0, 'a row was written under a mismatched context');

    // (b) the connection is discarded and never handed to another borrower
    assert.equal(faulty.poisonedPids.length, 1);
    const poisoned = faulty.poisonedPids[0];
    const seenPids = new Set<number>();
    for (let round = 0; round < 4; round++) {
      const cs = await Promise.all([faulty.pool.connect(), faulty.pool.connect(), faulty.pool.connect()]);
      for (const c of cs) seenPids.add((c as unknown as { processID: number }).processID);
      for (const c of cs) c.release();
    }
    log(`(b) poisoned backend ${poisoned}; 12 subsequent checkouts used ${[...seenPids].join(',')}`);
    assert.ok(!seenPids.has(poisoned), 'the poisoned connection was handed back out');
    const alive = await admin.query('select count(*)::int as n from pg_stat_activity where pid = $1', [poisoned]);
    assert.equal(alive.rows[0].n, 0, 'the poisoned backend was not actually closed');

    // (c) an operational alert at page severity
    const pages = faulty.alerts.byCode('CONTEXT_READBACK_MISMATCH');
    assert.equal(pages.length, 1);
    assert.equal(pages[0].severity, 'page');
    log(`(c) alert: severity=${pages[0].severity} code=${pages[0].code} detail.backendPid=${(pages[0].detail as { backendPid: number }).backendPid}`);

    // control: with the pooler behaving, the same runtime works immediately
    faulty.poolerMode = 'transaction-affinity';
    const okMarker = `t14-ok-${randomUUID()}`;
    await withUnitOfWork(faulty, ctx, async ({ db }) => {
      await db
        .insertInto('things')
        .values({ id: randomUUID(), organization_id: ctx.organizationId, group_id: ctx.groupId!, name: okMarker })
        .execute();
    });
    assert.equal(await countThingsNamed(okMarker), 1);
    log('control: the identical unit of work succeeds once the pooler preserves SET LOCAL');
  } finally {
    await faulty.destroy();
  }
});

test('T-14b PARTIAL context loss: only app.group_id is dropped — a single-setting read-back would miss it', async () => {
  // SPEC-01 §4.2's pseudo-code verifies app.organization_id ALONE. This is the
  // case that makes that insufficient: organization context survives, group
  // context does not, and the unit of work would then run fail-OPEN at group
  // scope inside the right organization — the CAR-001 defect class, below the
  // application layer.
  const faulty = createRuntime('app_runtime', { max: 3 });
  const ctx = ctxA1();
  const marker = `t14b-${randomUUID()}`;
  let callbackRan = false;

  try {
    faulty.poolerMode = 'statement-drops-group-id';

    await assert.rejects(
      withUnitOfWork(faulty, ctx, async ({ db }) => {
        callbackRan = true;
        await db
          .insertInto('things')
          .values({ id: randomUUID(), organization_id: ctx.organizationId, group_id: ctx.groupId!, name: marker })
          .execute();
      }),
      (e: unknown) => {
        assert.ok(e instanceof ContextReadbackMismatchError, `expected ContextReadbackMismatchError, got ${String(e)}`);
        const mm = (e as ContextReadbackMismatchError).mismatches;
        // Exactly one setting mismatched — and it is the one a naive read-back
        // would never have looked at.
        assert.equal(mm.length, 1, `expected exactly one mismatch, got ${mm.length}`);
        assert.equal(mm[0].setting, 'app.group_id');
        assert.equal(mm[0].expected, ctx.groupId);
        log(`only ${mm[0].setting} was lost: expected=${String(mm[0].expected).slice(0, 8)}… actual=${JSON.stringify(mm[0].actual)}`);
        return true;
      },
    );

    assert.equal(callbackRan, false, 'the body ran despite a partial context loss');
    assert.equal(await countThingsNamed(marker), 0);

    // A read-back that only compared app.organization_id would have passed:
    // organization context WAS established on the backend.
    assert.equal(faulty.poisonedPids.length, 1);
    const pages = faulty.alerts.byCode('CONTEXT_READBACK_MISMATCH');
    assert.equal(pages.length, 1);
    assert.equal(pages[0].severity, 'page');
    log(`connection poisoned and paged, exactly as for total loss (backend ${faulty.poisonedPids[0]})`);
  } finally {
    await faulty.destroy();
  }
});

/* ── T-15: two-organization concurrency storm ────────────────────────────── */

interface StormStats {
  iterations: number;
  unitsOfWork: number;
  committed: number;
  injectedFaults: number;
  /** In-wrapper probe reads, counted per TABLE, not per probe pass. */
  probeTableReads: number;
  probePasses: number;
  outsideProbes: number;
  wrongTenantRows: number;
  /** Statements that actually touch a tenant table (excludes BEGIN/COMMIT/
   *  ROLLBACK/set_config/read-back protocol overhead). */
  tenantTableStatements: number;
}

test('T-15 two-organization concurrency storm: zero wrong-tenant rows anywhere', async () => {
  const ITERATIONS = Number(process.env.SPIKE_STORM_ITERATIONS ?? 250);
  const stormRuntime = createRuntime('app_runtime', { max: 3 });
  const stormWorker = createRuntime('app_worker', { max: 2 });
  const probeRuntime = createRuntime('app_runtime', { max: 2 });

  const stats: StormStats = {
    iterations: ITERATIONS,
    unitsOfWork: 0,
    committed: 0,
    injectedFaults: 0,
    probeTableReads: 0,
    probePasses: 0,
    outsideProbes: 0,
    wrongTenantRows: 0,
    tenantTableStatements: 0,
  };
  const failures: string[] = [];
  /** Tables the probe actually observed with at least one visible row. */
  const nonVacuous = new Set<string>();

  const contexts: Array<() => TenantContext> = [
    () => groupContext('A', 1),
    () => groupContext('A', 2),
    () => groupContext('B', 1),
    () => groupContext('B', 2),
  ];

  const xactBefore = await admin.query<{ c: string; r: string }>(
    `select xact_commit::text as c, xact_rollback::text as r from pg_stat_database where datname = current_database()`,
  );

  let stormRunning = true;

  /**
   * Continuous cross-tenant probe, running for the whole storm in parallel.
   *
   * SPEC-01 §7.2 requires the harness to run "against every tenant table", so
   * each pass sweeps all eight — not just `things` — and alternates the tenant
   * it declares so that both organizations and all four groups are exercised.
   */
  const probe = (async () => {
    let pass = 0;
    while (stormRunning) {
      // (i) outside the wrapper, NO tenant table is visible — ever.
      for (const table of TENANT_TABLES) {
        const outside = await outsideUnitOfWork<{ n: number }>(
          probeRuntime,
          `select count(*)::int as n from ${table.name}`,
        );
        stats.outsideProbes++;
        stats.tenantTableStatements++;
        if (outside.rows[0].n !== 0) {
          failures.push(`OUTSIDE-PROBE saw ${outside.rows[0].n} rows in ${table.name} outside any unit of work`);
        }
      }

      // (ii) inside a unit of work, every table shows only this tenant's rows.
      const org = pass % 2 === 0 ? 'A' : 'B';
      const which = (pass % 4 < 2 ? 1 : 2) as 1 | 2;
      const ctx = groupContext(org, which);
      try {
        await withUnitOfWork(probeRuntime, ctx, async ({ client }) => {
          for (const table of TENANT_TABLES) {
            const q = wrongTenantProbeSql(table, ctx);
            const r = await client.query<{ wrong: number; visible: number }>(q.text, q.values);
            stats.probeTableReads++;
            stats.tenantTableStatements++;
            const { wrong, visible } = r.rows[0];
            if (visible > 0) nonVacuous.add(table.name);
            stats.wrongTenantRows += wrong;
            if (wrong !== 0) {
              failures.push(
                `PROBE saw ${wrong} wrong-tenant rows in ${table.name} under ${ctx.organizationId}/${ctx.groupId}`,
              );
            }
          }
        });
        stats.probePasses++;
      } catch (e) {
        // A pool-contention timeout is acceptable; a tenancy error is not.
        if (!/timeout exceeded when trying to connect/.test((e as Error).message)) {
          failures.push(`PROBE errored unexpectedly: ${(e as Error).message}`);
        }
      }
      pass++;
      await new Promise((r) => setImmediate(r));
    }
  })();

  const doWork = async (iteration: number, slot: number) => {
    const rt = slot % 2 === 0 ? stormRuntime : stormWorker; // exercise both roles
    const ctx = contexts[slot]();
    const fault = iteration % 4 === 0 ? iteration % 12 : -1; // ~25% of iterations
    stats.unitsOfWork++;

    try {
      await withUnitOfWork(rt, ctx, async ({ db, client }) => {
        await db
          .insertInto('things')
          .values({
            id: randomUUID(),
            organization_id: ctx.organizationId,
            group_id: ctx.groupId!,
            name: `storm-${iteration}-${slot}`,
          })
          .execute();
        stats.tenantTableStatements++;

        // Every unit of work re-verifies its own tenancy from inside.
        const check = await sql<{ wrong: number; visible: number }>`
          select count(*) filter (
                   where organization_id is distinct from ${ctx.organizationId}::uuid
                      or group_id        is distinct from ${ctx.groupId}::uuid
                 )::int as wrong,
                 count(*)::int as visible
            from things
        `.execute(db);
        stats.tenantTableStatements++;
        stats.wrongTenantRows += check.rows[0].wrong;
        if (check.rows[0].wrong !== 0) {
          failures.push(`WORK saw ${check.rows[0].wrong} wrong-tenant rows under ${ctx.organizationId}/${ctx.groupId}`);
        }
        if (check.rows[0].visible === 0) {
          failures.push(`WORK saw 0 rows under ${ctx.organizationId}/${ctx.groupId} — fail-closed inside the wrapper`);
        }

        if (fault === 0) {
          stats.injectedFaults++;
          throw new Error(`injected application exception @${iteration}/${slot}`);
        }
        if (fault === 4) {
          stats.injectedFaults++;
          await client.query(`set local statement_timeout = '40ms'`);
          await client.query('select pg_sleep(2)');
        }
        if (fault === 8) {
          stats.injectedFaults++;
          // nested savepoint that fails, then the outer work still commits
          await withUnitOfWork(rt, { ...ctx, correlationId: randomUUID() }, async () => {
            throw new Error('injected nested failure');
          }).catch(() => {});
        }
      });
      stats.committed++;
    } catch (e) {
      const msg = (e as Error).message;
      const expected =
        /injected application exception/.test(msg) ||
        /statement timeout/.test(msg) ||
        /timeout exceeded when trying to connect/.test(msg);
      if (!expected) failures.push(`WORK errored unexpectedly: ${msg}`);
    }
  };

  for (let i = 0; i < ITERATIONS; i++) {
    await Promise.all([doWork(i, 0), doWork(i, 1), doWork(i, 2), doWork(i, 3)]);
  }

  stormRunning = false;
  await probe;

  // ── ground truth across ALL eight tenant tables, read out of band ──────
  const census = await tenantRowCensus(admin);
  for (const bad of impossibleCensusRows(census)) {
    failures.push(`CENSUS impossible partition in ${bad.table}: ${bad.organization_id}/${bad.group_id} (${bad.n} rows)`);
  }

  const xactAfter = await admin.query<{ c: string; r: string }>(
    `select xact_commit::text as c, xact_rollback::text as r from pg_stat_database where datname = current_database()`,
  );
  const xacts =
    Number(xactAfter.rows[0].c) - Number(xactBefore.rows[0].c) +
    (Number(xactAfter.rows[0].r) - Number(xactBefore.rows[0].r));
  const allStatements = stormRuntime.statements + stormWorker.statements + probeRuntime.statements;
  const protocolStatements = allStatements - stats.tenantTableStatements;

  const censusByTable = new Map<string, number>();
  for (const row of census) censusByTable.set(row.table, (censusByTable.get(row.table) ?? 0) + row.n);

  log(`iterations=${stats.iterations} unitsOfWork=${stats.unitsOfWork} committed=${stats.committed} injectedFaults=${stats.injectedFaults}`);
  log(`probe: ${stats.probePasses} in-wrapper passes x ${TENANT_TABLES.length} tables = ${stats.probeTableReads} table reads; ${stats.outsideProbes} outside-wrapper table reads`);
  log(`server-side transactions during the storm=${xacts}`);
  log(`statements: ${allStatements} total = ${stats.tenantTableStatements} touching a tenant table + ${protocolStatements} protocol/context (BEGIN, 4x set_config, read-back, COMMIT/ROLLBACK per unit of work)`);
  log(`tables observed non-vacuously by the probe: ${[...nonVacuous].sort().join(', ')}`);
  log(`census rows by table: ${[...censusByTable].map(([t, n]) => `${t}=${n}`).join(' ')}`);
  log(`census partitions: ${census.length} (all legitimate: ${impossibleCensusRows(census).length === 0})`);
  log(`wrong-tenant rows observed anywhere: ${stats.wrongTenantRows}`);

  try {
    assert.equal(failures.length, 0, `storm failures:\n${failures.slice(0, 20).join('\n')}`);
    assert.equal(stats.wrongTenantRows, 0, 'a wrong-tenant row was observed — hard failure');
    assert.ok(stats.unitsOfWork >= 200, 'the storm must run a meaningful number of units of work');
    assert.ok(stats.probeTableReads > 0 && stats.outsideProbes > 0, 'the continuous probe did not run');
    assert.ok(stats.injectedFaults > 0, 'no faults were injected');
    assert.equal(impossibleCensusRows(census).length, 0, 'the census found an impossible partition');

    // The probe must have been NON-VACUOUS on every tenant table: a table with
    // no visible rows reports "0 wrong" for the boring reason.
    assert.equal(
      nonVacuous.size,
      TENANT_TABLES.length,
      `probe was vacuous on: ${TENANT_TABLES.map((t) => t.name).filter((n) => !nonVacuous.has(n)).join(', ')}`,
    );

    // SPEC-01 T-15 asks for 10 000 interleaved operations; the packet relaxes
    // the loop count to >=50 iterations. Both are satisfied — assert the
    // stronger of the two so the claim in SPIKE-REPORT.md is backed by a check.
    // Counted on TENANT-TABLE statements only, so protocol overhead cannot
    // inflate the figure.
    assert.ok(stats.iterations >= 50, 'the packet requires at least 50 iterations');
    assert.ok(
      stats.tenantTableStatements >= 10_000,
      `expected >=10 000 tenant-table operations, issued ${stats.tenantTableStatements}`,
    );
  } finally {
    await stormRuntime.destroy();
    await stormWorker.destroy();
    await probeRuntime.destroy();
  }
});

/* ════════════════════════════════════════════════════════════════════════════
 * Suite X — TDG-02 / TDG-03 evidence the packet adds on top of SPEC-01 §7.2
 * ══════════════════════════════════════════════════════════════════════════ */

test('X-01 TRANSACTION AFFINITY: one backend, one transaction, for the whole unit of work', async () => {
  const ctx = ctxA1();
  const samples = await withUnitOfWork(runtime, ctx, async ({ db, client, backendPid }) => {
    const seen: Array<{ where: string; pid: number; xact: string }> = [];
    for (const label of ['after-context', 'mid-1', 'mid-2', 'mid-3']) {
      const r = await sql<{ pid: number; xact: string }>`select pg_backend_pid() as pid, pg_current_xact_id()::text as xact`.execute(db);
      seen.push({ where: `kysely:${label}`, ...r.rows[0] });
    }
    const raw = await client.query<{ pid: number; xact: string }>('select pg_backend_pid() as pid, pg_current_xact_id()::text as xact');
    seen.push({ where: 'raw-client', ...raw.rows[0] });
    return { backendPid, seen };
  });

  const pids = new Set(samples.seen.map((s) => s.pid));
  const xacts = new Set(samples.seen.map((s) => s.xact));
  log(`unit of work backend=${samples.backendPid}; observed pids=${[...pids].join(',')}; xact ids=${[...xacts].join(',')}`);
  assert.equal(pids.size, 1, 'statements were distributed across more than one backend');
  assert.equal([...pids][0], samples.backendPid);
  assert.equal(xacts.size, 1, 'statements ran in more than one transaction');
});

test('X-02 STATEMENT-POOLING COUNTER-DEMONSTRATION: set_config and the query on different clients', async () => {
  const c1 = await runtime.pool.connect();
  const c2 = await runtime.pool.connect();
  const pid1 = (c1 as unknown as { processID: number }).processID;
  const pid2 = (c2 as unknown as { processID: number }).processID;
  try {
    assert.notEqual(pid1, pid2, 'need two distinct backends to simulate statement distribution');

    await c1.query('BEGIN');
    await c1.query(`select set_config('app.organization_id', $1, true)`, [FIXTURE.orgA.id]);
    await c1.query(`select set_config('app.group_id', $1, true)`, [FIXTURE.orgA.groupA1]);

    // The SAME logical unit of work, if the pooler distributed per statement:
    const onC1 = await c1.query<{ n: string }>('select count(*)::text as n from things');
    const onC2 = await c2.query<{ n: string }>('select count(*)::text as n from things');
    const settingOnC2 = await c2.query<{ v: string | null }>(`select current_setting('app.organization_id', true) as v`);

    log(`backend ${pid1} (holds SET LOCAL) sees ${onC1.rows[0].n} rows`);
    log(`backend ${pid2} (next statement, statement-level pooling) sees ${onC2.rows[0].n} rows, app.organization_id=${settingOnC2.rows[0].v}`);

    assert.ok(Number(onC1.rows[0].n) > 0, 'the connection holding SET LOCAL should see its tenant rows');
    assert.equal(Number(onC2.rows[0].n), 0, 'a statement routed to another backend must see nothing');
    assertNoTenantValue(settingOnC2.rows[0].v, `backend ${pid2} app.organization_id`);

    await c1.query('ROLLBACK');
  } finally {
    c1.release();
    c2.release();
  }
});

test('X-03 pool reuse across organizations: the same backend serves A then B, cleanly', async () => {
  const rt = createRuntime('app_runtime', { max: 1 }); // force reuse of one backend
  try {
    const seen: Array<{ org: string; pid: number; visibleGroups: string[] }> = [];
    for (const [label, ctx] of [
      ['A1', groupContext('A', 1)],
      ['B1', groupContext('B', 1)],
      ['A2', groupContext('A', 2)],
      ['B2', groupContext('B', 2)],
    ] as const) {
      const r = await withUnitOfWork(rt, ctx, async ({ db, backendPid }) => {
        const rows = await db.selectFrom('things').select(['organization_id', 'group_id']).execute();
        assert.ok(rows.length > 0, `${label}: expected rows under context`);
        assert.ok(
          rows.every((x) => x.organization_id === ctx.organizationId && x.group_id === ctx.groupId),
          `${label}: saw a row from another tenant`,
        );
        return { pid: backendPid, groups: [...new Set(rows.map((x) => x.group_id))] };
      });
      seen.push({ org: label, pid: r.pid, visibleGroups: r.groups });
      await assertPoolIsClean(rt, `X-03 after ${label}`);
    }
    const pids = new Set(seen.map((s) => s.pid));
    log(`${seen.length} units of work across 2 organizations on ${pids.size} backend(s): ${seen.map((s) => `${s.org}@${s.pid}`).join(' ')}`);
    assert.equal(pids.size, 1, 'the max=1 pool should have reused a single backend, which is the interesting case');
  } finally {
    await rt.destroy();
  }
});

test('X-04 pool exhaustion times out rather than silently proceeding without context', async () => {
  const rt = createRuntime('app_runtime', { max: 1, connectionTimeoutMillis: 300 });
  try {
    let inner: unknown;
    await withUnitOfWork(rt, ctxA1(), async () => {
      inner = await withUnitOfWork(rt, ctxA1(), async () => 'unreachable-via-new-connection').catch((e) => e);
    });
    // The nested call is same-tenant, so it is a savepoint on the SAME
    // connection and must NOT need a second checkout — proving the wrapper
    // never re-enters the pool while it holds a transaction.
    assert.equal(inner, 'unreachable-via-new-connection');

    // A genuinely concurrent second unit of work, however, must wait and time out.
    const hold = withUnitOfWork(rt, ctxA1(), async () => {
      await new Promise((r) => setTimeout(r, 800));
    });
    await new Promise((r) => setTimeout(r, 100));
    const contended = await withUnitOfWork(rt, ctxB1(), async () => 'got-it').catch((e: Error) => e.message);
    await hold;
    log(`contended checkout on an exhausted max=1 pool: ${String(contended)}`);
    assert.match(String(contended), /timeout exceeded when trying to connect/);
  } finally {
    await rt.destroy();
  }
});

test('X-05 worker role: identical isolation guarantees under app_worker', async () => {
  const ctx = groupContext('B', 1);
  const marker = `x05-${randomUUID()}`;

  await withUnitOfWork(worker, ctx, async ({ db }) => {
    await db
      .insertInto('things')
      .values({ id: randomUUID(), organization_id: ctx.organizationId, group_id: ctx.groupId!, name: marker })
      .execute();
    const rows = await db.selectFrom('things').select(['organization_id', 'group_id']).execute();
    assert.ok(rows.every((r) => r.organization_id === ctx.organizationId && r.group_id === ctx.groupId));
  });
  assert.equal(await countThingsNamed(marker), 1);

  await assertPoolIsClean(worker, 'X-05');

  // A worker must not be able to re-tenant a nested unit of work either.
  await assert.rejects(
    withUnitOfWork(worker, ctx, async () => {
      await withUnitOfWork(worker, ctxA1(), async () => undefined);
    }),
    (e: unknown) => e instanceof NestedTenantChangeError,
  );
  log('app_worker: writes under context, fail-closed outside, refuses to re-tenant');
});

test('X-06 SHARP EDGE — referential integrity is not RLS-governed; composite FK closes it', async () => {
  const ctx = ctxA1();
  const bThing = await admin.query<{ id: string }>('select id from things where organization_id = $1 limit 1', [FIXTURE.orgB.id]);
  const foreignThingId = bThing.rows[0].id;
  const naiveId = randomUUID();

  await withUnitOfWork(runtime, ctx, async ({ db }) => {
    // The row's OWN tenant columns satisfy the policy, and the FK check runs
    // outside RLS, so a cross-tenant reference is accepted.
    await db
      .insertInto('thing_notes_naive')
      .values({ id: naiveId, organization_id: ctx.organizationId, group_id: ctx.groupId!, thing_id: foreignThingId, body: 'points at another tenant' })
      .execute();
  });
  const leaked = await admin.query('select count(*)::int as n from thing_notes_naive where id = $1', [naiveId]);
  assert.equal(leaked.rows[0].n, 1);
  log(`single-column FK accepted a reference to Org B thing ${foreignThingId.slice(0, 8)} from an Org A unit of work`);

  // The composite FK makes the same thing structurally impossible.
  await assert.rejects(
    withUnitOfWork(runtime, ctx, async ({ db }) => {
      await db
        .insertInto('thing_notes_scoped')
        .values({ id: randomUUID(), organization_id: ctx.organizationId, group_id: ctx.groupId!, thing_id: foreignThingId, body: 'should not be possible' })
        .execute();
    }),
    (e: unknown) => {
      const err = e as { code?: string; constraint?: string };
      assert.equal(err.code, '23503', `expected foreign_key_violation, got ${err.code}`);
      log(`composite (id, organization_id, group_id) FK rejected the same reference: ${err.constraint} / ${err.code}`);
      return true;
    },
  );

  // Leave no cross-tenant reference behind. Asserted as the invariant itself —
  // "no note points at a thing in another tenant" — rather than as a row
  // count, because the fixture legitimately contains notes in every group.
  await withUnitOfWork(runtime, ctx, async ({ db }) => {
    await db.deleteFrom('thing_notes_naive').where('id', '=', naiveId).execute();
  });
  const dangling = await admin.query<{ n: number }>(
    `select count(*)::int as n
       from thing_notes_naive n
       join things t on t.id = n.thing_id
      where t.organization_id is distinct from n.organization_id
         or t.group_id        is distinct from n.group_id`,
  );
  assert.equal(dangling.rows[0].n, 0, 'a cross-tenant reference was left behind');
  log(`cleanup: 0 cross-tenant references remain across all ${(await admin.query('select count(*)::int as n from thing_notes_naive')).rows[0].n} naive notes`);
});

test('X-07 SHARP EDGE — empty-string context is fail-closed, not an error', async () => {
  // set_config(name, NULL, true) stores '' rather than NULL, and ''::uuid
  // raises 22P02. The policies use nullif(..., '') so both spellings are false.
  const c = await runtime.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`select set_config('app.organization_id', '', true)`);
    await c.query(`select set_config('app.group_id', '', true)`);
    const r = await c.query<{ n: string }>('select count(*)::text as n from things');
    log(`context set to the empty string: ${r.rows[0].n} rows visible (no 22P02 raised)`);
    assert.equal(Number(r.rows[0].n), 0);
    await c.query('ROLLBACK');
  } finally {
    c.release();
  }

  // An organization-scoped unit of work (group_id null) is fail-closed on
  // group-scoped tables, and open on organization-scoped ones.
  await withUnitOfWork(runtime, orgContext('A'), async ({ db }) => {
    const things = await db.selectFrom('things').select(['id']).execute();
    const groups = await db.selectFrom('groups').select(['id']).execute();
    log(`organization-scoped unit of work: things=${things.length} (must be 0), groups=${groups.length} (EX-2 shaped)`);
    assert.equal(things.length, 0, 'group-scoped table leaked under an organization-scoped context');
    assert.equal(groups.length, 2, 'organization-scoped table should be readable');
  });
});

test('X-08 static check: no session-scoped SET and no non-LOCAL set_config anywhere', async () => {
  const files: string[] = [];
  for (const dir of ['src', 'test', 'migrations']) {
    const base = join(SPIKE_ROOT, dir);
    for (const f of await readdir(base)) {
      if (f.endsWith('.ts') || f.endsWith('.sql')) files.push(join(base, f));
    }
  }
  assert.ok(files.length >= 8, 'expected to scan the whole spike source');

  // Comments describe the prohibition; only executable text may be judged by it.
  const stripComments = (line: string) =>
    line.replace(/\/\/.*$/, '').replace(/--.*$/, '').replace(/\/\*.*?\*\//g, '');

  // ANY `SET`-statement form of a tenant setting: `SET app.x`, `SET SESSION
  // app.x` and — the one that matters most — `SET LOCAL app.x`.
  //
  // `SET LOCAL` is banned alongside the session forms, and NOT because it
  // leaks: it does not. It is banned because `SET` is a utility statement that
  // cannot take a bind parameter (proved by X-10, SQLSTATE 42601), so the only
  // way to write it is to interpolate the tenant id into SQL — an injection
  // surface at the most security-critical statement in the system. The
  // parameterisable function form `set_config(name, value, true)` is the only
  // permitted spelling.
  const tenantSetStatement = /\bset\s+((session|local)\s+)?app\.[a-z_]+/i;
  // set_config(..., false) — the session form of the same thing
  const nonLocalSetConfig = /set_config\s*\([^;]*?,\s*false\s*\)/i;
  // Every set_config CALL in the spike must carry the LOCAL flag. Requires at
  // least one argument so that bare `set_config()` in prose or a test title is
  // not mistaken for a call site.
  const anySetConfig = /set_config\s*\(\s*['"$\w]/i;
  const localSetConfig = /set_config\s*\([^)]*,\s*(true|\$\{[^}]*\}|\$\d+)\s*\)/i;

  // Lines carrying this marker are deliberate lint fixtures — the samples in
  // the self-test below, and X-10's assembled `SET LOCAL`. The scanner reads
  // this very file, so without an opt-out the fixtures would flag themselves.
  const FIXTURE_MARKER = 'LINT-FIXTURE';

  // ── self-test: a lint that cannot fail is not a lint ────────────────────
  //
  // The offending forms are ASSEMBLED rather than written out, because the
  // scanner below reads this very file and would otherwise flag the samples.
  const S = 'SET';
  const mustFlag = [
    `await client.query("${S} app.organization_id = '${FIXTURE.orgA.id}'")`,
    `await client.query("${S} SESSION app.organization_id = '${FIXTURE.orgA.id}'")`,
    `await client.query("${S} LOCAL app.organization_id = '${FIXTURE.orgA.id}'")`,
    `await client.query("${S.toLowerCase()} local app.group_id = '...'")`,
    `await client.query("select set_config('app.group_id', $1, false)", [g]);`, // LINT-FIXTURE
  ];
  const mustNotFlag = [
    `await sql\`select set_config(\${name}, \${value}, true)\`.execute(db);`,
    `await client.query("select set_config('app.organization_id', $1, true)", [id]);`,
    `await client.query("set local statement_timeout = '150ms'");`,
    `const v = await client.query("select current_setting('app.organization_id', true)");`,
  ];
  for (const sample of mustFlag) {
    assert.ok(
      tenantSetStatement.test(stripComments(sample)) || nonLocalSetConfig.test(stripComments(sample)),
      `lint self-test: should have flagged  ${sample}`,
    );
  }
  for (const sample of mustNotFlag) {
    const line = stripComments(sample);
    assert.ok(
      !tenantSetStatement.test(line) && !nonLocalSetConfig.test(line),
      `lint self-test: should NOT have flagged  ${sample}`,
    );
  }
  log(`lint self-test: ${mustFlag.length} forms flagged (SET / SET SESSION / SET LOCAL), ${mustNotFlag.length} set_config and non-tenant forms passed`);

  const offenders: string[] = [];
  const skipped: string[] = [];
  let setConfigSites = 0;
  for (const f of files) {
    const body = await readFile(f, 'utf8');
    for (const [i, raw] of body.split('\n').entries()) {
      if (raw.includes(FIXTURE_MARKER)) {
        // Deliberate sample, see the self-test above. Recorded, not silent.
        skipped.push(`${f.replace(SPIKE_ROOT, '.')}:${i + 1}`);
        continue;
      }
      const line = stripComments(raw);
      const where = `${f.replace(SPIKE_ROOT, '.')}:${i + 1}: ${raw.trim()}`;
      if (tenantSetStatement.test(line) || nonLocalSetConfig.test(line)) offenders.push(where);
      if (anySetConfig.test(line)) {
        setConfigSites++;
        if (!/,\s*true\s*\)/.test(line) && !localSetConfig.test(line)) offenders.push(`NON-LOCAL ${where}`);
      }
    }
  }
  log(`${files.length} files scanned; ${setConfigSites} set_config call sites; violations: ${offenders.length}`);
  log(`lint-fixture lines skipped: ${skipped.length} (${skipped.join(', ') || 'none'})`);
  assert.deepEqual(offenders, [], 'a session-scoped tenant setting exists in the spike');
  assert.ok(setConfigSites > 0, 'the scanner found no set_config at all — it is not actually checking anything');
  // The opt-out must stay confined to this test file's own fixtures; a marker
  // appearing in src/ or migrations/ would be a way to smuggle a violation past.
  for (const s of skipped) {
    assert.match(s, /^\.\/test\//, `a lint-fixture opt-out escaped the test file: ${s}`);
  }
  assert.ok(skipped.length <= 3, `too many lint opt-outs (${skipped.length}) — the lint is being worked around`);

  const migrationFiles = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql'));
  assert.equal(migrationFiles.length, 2);
});

test('X-09 SHARP EDGE — SET LOCAL reverts the VALUE, it does not undefine the GUC', async () => {
  // The single most consequential finding of this spike. SPEC-01 §4.3 states
  // that "outside a unit of work the setting is NULL". That is true only on a
  // connection that has never carried context. On a REUSED pooled connection
  // the placeholder survives with the EMPTY STRING as its reset value, so the
  // literal predicate SPEC-01 §4.3 prescribes raises 22P02 instead of
  // evaluating false.
  const rt = createRuntime('app_runtime', { max: 1 });
  try {
    const pristine = await outsideUnitOfWork<{ v: string | null }>(
      rt,
      `select current_setting('app.organization_id', true) as v`,
    );
    log(`pristine backend: current_setting -> ${JSON.stringify(pristine.rows[0].v)}`);
    assert.equal(pristine.rows[0].v, null);

    await withUnitOfWork(rt, ctxA1(), async ({ db }) => {
      await db.selectFrom('things').select(['id']).limit(1).execute();
    });

    const reused = await outsideUnitOfWork<{ v: string | null }>(
      rt,
      `select current_setting('app.organization_id', true) as v`,
    );
    log(`reused backend after COMMIT:   current_setting -> ${JSON.stringify(reused.rows[0].v)}`);
    assert.equal(reused.rows[0].v, '', 'expected the GUC to survive COMMIT as the empty string');

    // The ROLLBACK leg. A rolled-back transaction is the more common case in
    // production (every failed request), so it is the one worth measuring
    // rather than assuming.
    await withUnitOfWork(rt, ctxA1(), async ({ db }) => {
      await db.selectFrom('things').select(['id']).limit(1).execute();
      throw new Error('deliberate rollback for the X-09 rollback leg');
    }).catch(() => {});

    const afterRollback = await outsideUnitOfWork<{ v: string | null }>(
      rt,
      `select current_setting('app.organization_id', true) as v`,
    );
    log(`reused backend after ROLLBACK: current_setting -> ${JSON.stringify(afterRollback.rows[0].v)}`);
    assert.equal(afterRollback.rows[0].v, '', 'expected the GUC to survive ROLLBACK as the empty string');

    // The naive predicate spelling now ERRORS rather than yielding NULL.
    await expectPgError(
      () => outsideUnitOfWork(rt, `select current_setting('app.organization_id', true)::uuid as v`),
      '22P02',
      'the naive cast must raise invalid_text_representation on a reused connection',
    );
    log('naive  current_setting(...)::uuid          -> 22P02 invalid input syntax for type uuid: ""');

    // The spelling actually used by the migrations is correct in both states.
    const safe = await outsideUnitOfWork<{ v: string | null }>(
      rt,
      `select nullif(current_setting('app.organization_id', true), '')::uuid as v`,
    );
    assert.equal(safe.rows[0].v, null);
    log('safe   nullif(current_setting(...),\'\')::uuid -> NULL (predicate false, zero rows)');

    // And, crucially: no tenant identifier survived the transaction.
    await assertPoolIsClean(rt, 'X-09');
  } finally {
    await rt.destroy();
  }
});

test('X-10 SHARP EDGE — `SET LOCAL` cannot be parameterised; only set_config() can', async () => {
  // The report's §4.1 claim, measured rather than asserted from memory. Both
  // the raw pg client and Kysely's sql tag send the same parameterised
  // statement, and PostgreSQL rejects it: SET is a utility statement.
  //
  // Assembled, not written literally, so the X-08 scanner does not flag it.
  const stmt = `${'SET'} LOCAL app.organization_id = $1`;
  const results: Array<{ via: string; code?: string; message?: string }> = [];

  await withUnitOfWork(runtime, ctxA1(), async ({ client }) => {
    try {
      await client.query(stmt, [FIXTURE.orgA.id]);
      results.push({ via: 'raw pg' });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      results.push({ via: 'raw pg', code: err.code, message: err.message });
    }
  }).catch(() => {});

  await withUnitOfWork(runtime, ctxA1(), async ({ db }) => {
    try {
      await sql`${sql.raw(`${'SET'} LOCAL app.organization_id`)} = ${FIXTURE.orgA.id}`.execute(db);
      results.push({ via: 'kysely sql tag' });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      results.push({ via: 'kysely sql tag', code: err.code, message: err.message });
    }
  }).catch(() => {});

  for (const r of results) log(`${r.via}: SQLSTATE ${r.code} — ${r.message}`);
  assert.equal(results.length, 2);
  for (const r of results) {
    assert.equal(r.code, '42601', `${r.via}: expected syntax_error, got ${r.code}`);
    assert.match(r.message ?? '', /\$1/);
  }

  // The function form, with the identical value, is accepted and parameterised.
  const ok = await withUnitOfWork(runtime, ctxA1(), async ({ db }) => {
    const r = await sql<{ v: string }>`select set_config('app.probe', ${FIXTURE.orgA.id}, true) as v`.execute(db);
    return r.rows[0].v;
  });
  assert.equal(ok, FIXTURE.orgA.id);
  log(`set_config(name, $1, true): accepted, returned ${ok.slice(0, 8)}…`);
});

test('X-11 SHARP EDGE — unique/PK checks bypass RLS and disclose invisible rows (existence oracle)', async () => {
  // A companion to X-06. Referential integrity is not the only unique-index
  // machinery that runs outside RLS: the PRIMARY KEY check does too. Under an
  // Org A unit of work, inserting a row whose id collides with an INVISIBLE
  // Org B row raises 23505 rather than succeeding — which is correct for
  // integrity, but tells the caller that the id exists somewhere they cannot
  // see. That is a cross-tenant existence oracle over a guessable id space.
  const ctx = ctxA1();
  const bRow = await admin.query<{ id: string }>(
    'select id from things where organization_id = $1 limit 1',
    [FIXTURE.orgB.id],
  );
  const invisibleId = bRow.rows[0].id;

  await withUnitOfWork(runtime, ctx, async ({ db }) => {
    // First: confirm the row really is invisible under this context.
    const visible = await db.selectFrom('things').selectAll().where('id', '=', invisibleId).execute();
    assert.equal(visible.length, 0, 'precondition: the Org B row must be invisible here');
  });

  await assert.rejects(
    withUnitOfWork(runtime, ctx, async ({ db }) => {
      await db
        .insertInto('things')
        .values({ id: invisibleId, organization_id: ctx.organizationId, group_id: ctx.groupId!, name: 'existence-oracle-probe' })
        .execute();
    }),
    (e: unknown) => {
      const err = e as { code?: string; constraint?: string };
      assert.equal(err.code, '23505', `expected unique_violation, got ${err.code}`);
      log(`inserting an id that exists only in Org B: SQLSTATE ${err.code} on ${err.constraint} — the row is invisible but provably present`);
      return true;
    },
  );

  // Contrast: a fresh, genuinely unused id inserts cleanly. The difference
  // between the two responses IS the oracle.
  const freshId = randomUUID();
  await withUnitOfWork(runtime, ctx, async ({ db }) => {
    await db
      .insertInto('things')
      .values({ id: freshId, organization_id: ctx.organizationId, group_id: ctx.groupId!, name: 'existence-oracle-control' })
      .execute();
  });
  assert.equal(await countThingsNamed('existence-oracle-control'), 1);
  log('the same insert with an unused id succeeds — response differs by existence alone');

  // The Org B row is untouched.
  const untouched = await admin.query('select organization_id from things where id = $1', [invisibleId]);
  assert.equal(untouched.rows.length, 1);
  assert.equal(untouched.rows[0].organization_id, FIXTURE.orgB.id);

  await withUnitOfWork(runtime, ctx, async ({ db }) => {
    await db.deleteFrom('things').where('id', '=', freshId).execute();
  });
});
