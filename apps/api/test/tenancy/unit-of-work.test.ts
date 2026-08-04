import { randomUUID } from 'node:crypto';

import {
  ContextReadbackMismatchError,
  NestedTenantChangeError,
  type TenantContext,
} from '@schedulepoint/domain';
import { CompiledQuery, sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ProcessAlertSink } from '../../src/db/alerts.js';
import { createPool } from '../../src/db/pool.js';
import {
  assertTransactionAffinity,
  PoolerModeAssertionError,
} from '../../src/db/pooler-assertion.js';
import { TENANT_TABLES } from '../../src/db/schema.js';
import { PgUnitOfWorkRunner } from '../../src/db/unit-of-work.js';
import { adminClient } from '../support/admin-client.js';
import { groupContext, organizationContext } from '../support/fixtures.js';
import {
  actualOrganizations,
  actualPartitions,
  assertPoolIsClean,
  createRuntime,
  expectedVisibleUserIds,
  impossibleCensusRows,
  log,
  outsideUnitOfWork,
  tenantRowCensus,
  wrongTenantProbe,
  type ProbeResult,
  type Runtime,
} from '../support/harness.js';
import { withSimulatedPoolerFault } from '../support/pooler-simulator.js';
import { ownedMulti } from '../support/owned-multi.js';
import { seedRulesForSweep } from '../support/rules.js';

/**
 * FAD-15 Layer 2 — this file owns its tenant.
 *
 * It used to write to the shared MULTI baseline, which every other file also read.
 * NR-13 measured what that cost: six order-dependent tests across five files, and
 * eleven of twenty-four files modifying rows the shared seed created. The fixture
 * below has the same shape and fresh identifiers, and RLS — not agreement — is what
 * keeps it out of everybody else's queries.
 */
/* The catalogue and staffing rows this file's probes need.
 *
 * Every table registered in `TENANT_TABLES` must be observed with a VISIBLE
 * row: a probe over a table nobody ever saw a row in reports "0 wrong-tenant
 * rows" for the most boring possible reason, and that vacuous pass is what the
 * non-vacuity checks exist to refuse. So the fixture holds rows in all of them.
 *
 * The seeding used to be two per-file modules called after `ownedMulti` had
 * provisioned, because packet 30 §5 made the MULTI provisioning script
 * read-only while the two M2 packets ran in parallel. The **D-1** ruling moved
 * it back into `provisionMulti`, so a file DECLARES what it needs and the
 * fixture is complete when `beforeAll` returns.
 *
 * The credential is issued to Alpha's `scheduler` membership deliberately:
 * `qualification_holdings` is SENSITIVE-PII with no organization-wide read
 * policy, and that membership is the one these probes act as. A holding
 * belonging to anybody else would be invisible to every probe context and the
 * table would report a vacuous zero. */
const multi = ownedMulti('tenancy-unit-of-work', {
  // `schedule: true` (OPUS-M3-003) so migration 0009's eleven tables carry
  // visible rows: this file's probes fail a REGISTERED table that is never seen
  // with one, because a probe over an empty table reports 0 wrong for the most
  // boring possible reason.
  seed: { staffing: true, catalogue: ['alpha'], schedule: true },
});

/**
 * **SPEC-01 §7.2 — pooled-connection and failure-path isolation (CAR-002),
 * against the PRODUCTION unit of work.**
 *
 * | # | Injected fault | Required outcome |
 * |---|---|---|
 * | T-07  | Exception mid-transaction | Rollback; next checkout sees no setting |
 * | T-08  | Statement cancellation / client timeout | Same |
 * | T-09  | Statement timeout at the server | Same |
 * | T-10  | Connection killed mid-transaction | Same; pool discards the connection |
 * | T-11  | Nested unit of work, same tenant | Permitted (savepoint) |
 * | T-12  | Nested unit of work, **different** tenant | **Throws** |
 * | T-13  | Query issued **outside** any unit of work | Zero rows / write rejected |
 * | T-13b | Group A context, group-scoped table for Group B, same organization | Zero rows / write rejected |
 * | T-14  | Pooler in statement-pooling mode | Abort **and** discard **and** alert |
 * | T-14b | PARTIAL context loss — only `app.group_id` | Same three, and exactly one mismatch |
 * | T-15  | Interleaved two-organization storm | **Zero rows from the wrong tenant** |
 *
 * Every one of these runs against `PgUnitOfWorkRunner`, the module the HTTP
 * surface uses. The spike's equivalents ran against spike code; these do not.
 */

let admin: pg.Client;
let runtime: Runtime;
let worker: Runtime;

const alphaGroupOne = (): TenantContext =>
  groupContext(
    multi().alpha.organizationId,
    multi().alpha.groupOne.id,
    multi().alpha.users.scheduler.membershipId,
    randomUUID(),
  );
const alphaGroupTwo = (): TenantContext =>
  groupContext(
    multi().alpha.organizationId,
    multi().alpha.groupTwo.id,
    multi().alpha.users.groupTwoScheduler.membershipId,
    randomUUID(),
  );
const betaGroupOne = (): TenantContext =>
  groupContext(
    multi().beta.organizationId,
    multi().beta.groupOne.id,
    multi().beta.users.scheduler.membershipId,
    randomUUID(),
  );
const alphaOrganization = (): TenantContext =>
  organizationContext(multi().alpha.organizationId, randomUUID());

/** The write marker: a group row whose name nothing else uses. */
function marker(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

async function countGroupsNamed(name: string): Promise<number> {
  const result = await admin.query<{ n: number }>(
    'select count(*)::int as n from groups where name = $1',
    [name],
  );
  return result.rows[0]?.n ?? 0;
}

async function insertMarkerGroup(
  query: Parameters<Parameters<PgUnitOfWorkRunner['run']>[1]>[0]['query'],
  organizationId: string,
  name: string,
): Promise<void> {
  await query
    .insertInto('groups')
    .values({ id: randomUUID(), organization_id: organizationId, name })
    .execute();
}

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  runtime = createRuntime('app_runtime', { max: 4 });
  worker = createRuntime('app_worker', { max: 2 });

  /* ── OPUS-M3-002: rule rows, so the new tenant tables are not vacuous ──────
   *
   * Migration 0008 registers `rules` and `rule_sets` in `TENANT_TABLES`, and
   * every sweep in this file iterates that registry and refuses a table it never
   * saw a row in — "0 wrong" over an empty table means nothing, which is exactly
   * what these probes exist to catch.
   *
   * Seeded here rather than in `provisionMulti` because `test/support/multi.ts`
   * is prohibited to OPUS-M3-002 (packet 32 §4/§6); `test/support/rules.ts` is
   * this packet's own file and the seed goes through the production write path
   * under a capability-holding context. */
  await seedRulesForSweep(runtime.runner, [
    {
      organizationId: multi().alpha.organizationId,
      groupId: multi().alpha.groupOne.id,
      membershipId: multi().alpha.users.scheduler.membershipId,
      label: 'alpha_one',
    },
    {
      organizationId: multi().alpha.organizationId,
      groupId: multi().alpha.groupTwo.id,
      membershipId: multi().alpha.users.scheduler.groupTwoMembershipId,
      label: 'alpha_two',
    },
    {
      organizationId: multi().beta.organizationId,
      groupId: multi().beta.groupOne.id,
      membershipId: multi().beta.users.scheduler.membershipId,
      label: 'beta_one',
    },
  ]);
}, 180_000);

afterAll(async () => {
  await runtime.destroy();
  await worker.destroy();
  await admin.end();
});

describe('the wrapper establishes and confines context', () => {
  it('X-01 transaction affinity: one backend, one transaction, for the whole unit of work', async () => {
    const probe = sql<{ pid: number; xid: string }>`
      select pg_backend_pid() as pid, pg_current_xact_id()::text as xid`;

    const observed = await runtime.runner.run(alphaGroupOne(), async ({ query, backendPid }) => {
      const first = (await probe.execute(query)).rows[0];
      const second = (await probe.execute(query)).rows[0];
      return { first, second, backendPid };
    });

    expect(observed.first?.pid).toBe(observed.second?.pid);
    expect(observed.first?.pid).toBe(observed.backendPid);
    expect(observed.first?.xid).toBe(observed.second?.xid);
    log(
      `backend ${String(observed.backendPid)}, transaction ${String(observed.first?.xid)}, both statements`,
    );
  });

  it('the startup pooler-mode assertion passes against the real pool', async () => {
    const probe = await assertTransactionAffinity(runtime.pool);
    expect(probe.firstBackendPid).toBe(probe.secondBackendPid);
    expect(probe.settingSurvivedWithinTransaction).toBe(true);
    expect(probe.settingExpiredAfterTransaction).toBe(true);
    log(
      `affinity probe: backend ${String(probe.firstBackendPid)}, setting survived within the transaction and expired after it`,
    );
  });

  it('the startup pooler-mode assertion REFUSES a pool that drops set_config', async () => {
    // The red case for the assertion itself. A control that has only ever been
    // observed passing is not a control.
    const pool = withSimulatedPoolerFault(
      createPool('app_runtime', { max: 2, allowExitOnIdle: true }),
      'drops-all-set-config',
    );
    try {
      await expect(assertTransactionAffinity(pool)).rejects.toBeInstanceOf(
        PoolerModeAssertionError,
      );
      log(
        'assertTransactionAffinity threw POOLER_MODE_UNSUPPORTED on a pooler that drops set_config',
      );
    } finally {
      await pool.end();
    }
  });

  it('X-03 pool reuse across organizations: the same backend serves Alpha then Beta, cleanly', async () => {
    const solo = createRuntime('app_runtime', { max: 1 });
    try {
      const alpha = await solo.runner.run(alphaGroupOne(), async ({ query, backendPid }) => ({
        backendPid,
        organizations: await query.selectFrom('memberships').select(['organization_id']).execute(),
      }));
      const beta = await solo.runner.run(betaGroupOne(), async ({ query, backendPid }) => ({
        backendPid,
        organizations: await query.selectFrom('memberships').select(['organization_id']).execute(),
      }));

      expect(alpha.backendPid).toBe(beta.backendPid);
      expect(
        alpha.organizations.every((row) => row.organization_id === multi().alpha.organizationId),
      ).toBe(true);
      expect(
        beta.organizations.every((row) => row.organization_id === multi().beta.organizationId),
      ).toBe(true);
      log(
        `backend ${String(alpha.backendPid)} served Alpha (${String(alpha.organizations.length)} rows) then Beta (${String(beta.organizations.length)} rows), no bleed`,
      );
    } finally {
      await solo.destroy();
    }
  });
});

describe('SPEC-01 §7.2 — injected faults', () => {
  it('T-07 exception mid-transaction: rollback, and the next checkout sees no setting', async () => {
    const name = marker('t07');
    let backend = 0;

    await expect(
      runtime.runner.run(alphaOrganization(), async ({ query, backendPid }) => {
        backend = backendPid;
        await insertMarkerGroup(query, multi().alpha.organizationId, name);
        throw new Error('deliberate mid-transaction failure');
      }),
    ).rejects.toThrow(/deliberate mid-transaction failure/);

    expect(await countGroupsNamed(name), 'the aborted insert was not rolled back').toBe(0);
    log(`backend ${String(backend)}: insert rolled back, 0 rows named ${name}`);
    await assertPoolIsClean(runtime, 'T-07');
  });

  it('T-08 statement cancellation: 57014, rollback, no lingering setting', async () => {
    const name = marker('t08');
    let cancelIssued: Promise<unknown> = Promise.resolve();

    await expect(
      runtime.runner.run(alphaOrganization(), async ({ query, backendPid }) => {
        await insertMarkerGroup(query, multi().alpha.organizationId, name);
        cancelIssued = new Promise((resolve) => {
          setTimeout(() => resolve(admin.query('select pg_cancel_backend($1)', [backendPid])), 200);
        });
        await sql`select pg_sleep(10)`.execute(query);
      }),
    ).rejects.toMatchObject({ code: '57014' });
    await cancelIssued;

    expect(await countGroupsNamed(name), 'the cancelled transaction was not rolled back').toBe(0);
    log('cancelled: SQLSTATE 57014, transaction rolled back');
    await assertPoolIsClean(runtime, 'T-08');
  });

  it('T-08b a client-side deadline abandons the wait; the rollback still holds', async () => {
    // A different failure shape from T-08: node-postgres, not the server, ends
    // the wait, so there is deliberately no SQLSTATE. Pinning that absence is
    // what distinguishes this case from a server cancellation.
    const rt = createRuntime('app_runtime', { max: 2, queryTimeoutMillis: 400 });
    const name = marker('t08b');
    try {
      await expect(
        rt.runner.run(alphaOrganization(), async ({ query }) => {
          await insertMarkerGroup(query, multi().alpha.organizationId, name);
          await sql`select pg_sleep(10)`.execute(query);
        }),
      ).rejects.toSatisfy((error: unknown) => {
        const err = error as { code?: string; message?: string };
        // A CLIENT-side deadline carries no server SQLSTATE. Pinning that
        // absence is what distinguishes it from T-08 and T-09.
        expect(err.code, 'a client-side timeout must not carry a server SQLSTATE').toBeUndefined();
        expect(err.message ?? '').toMatch(/timeout/i);
        return true;
      });

      expect(await countGroupsNamed(name)).toBe(0);
      log('client-side deadline surfaced with no SQLSTATE; transaction rolled back');
      await assertPoolIsClean(rt, 'T-08b');
    } finally {
      await rt.destroy();
    }
  });

  it('T-09 server statement_timeout: 57014, rollback, and the timeout itself expires', async () => {
    const name = marker('t09');

    await expect(
      runtime.runner.run(alphaOrganization(), async ({ query }) => {
        await insertMarkerGroup(query, multi().alpha.organizationId, name);
        // `set_config(..., true)` rather than `SET LOCAL`, for the same reason
        // the tenant settings use it: the parameterisable form is the only one
        // that never invites interpolation.
        await sql`select set_config('statement_timeout', '150ms', true)`.execute(query);
        await sql`select pg_sleep(5)`.execute(query);
      }),
    ).rejects.toMatchObject({ code: '57014' });

    expect(await countGroupsNamed(name)).toBe(0);
    await assertPoolIsClean(runtime, 'T-09');

    const after = await outsideUnitOfWork<{ v: string }>(
      runtime,
      `select current_setting('statement_timeout') as v`,
    );
    expect(
      after.rows[0]?.v,
      'a transaction-local statement_timeout leaked past the transaction',
    ).toBe('0');
    log('server timeout: 57014, rolled back, statement_timeout back to 0 afterwards');
  });

  it('T-10 connection killed mid-transaction: the pool discards it and never re-issues it', async () => {
    const name = marker('t10');
    let killedPid = 0;
    let killIssued: Promise<unknown> = Promise.resolve();

    await expect(
      runtime.runner.run(alphaOrganization(), async ({ query, backendPid }) => {
        killedPid = backendPid;
        await insertMarkerGroup(query, multi().alpha.organizationId, name);
        killIssued = new Promise((resolve) => {
          setTimeout(
            () =>
              resolve(
                admin.query('select pg_terminate_backend($1)', [backendPid]).catch(() => undefined),
              ),
            200,
          );
        });
        await sql`select pg_sleep(10)`.execute(query);
      }),
    ).rejects.toSatisfy((error: unknown) => {
      const err = error as { code?: string; message?: string };
      // 57P01 is what the server sends before the socket dies. If the FATAL
      // arrives after the socket has already closed, node-postgres surfaces its
      // own connection-terminated error with no SQLSTATE. Both are legitimate
      // symptoms of the same kill, and nothing else is.
      return (
        err.code === '57P01' ||
        /terminating connection due to administrator command/.test(err.message ?? '') ||
        /Connection terminated/.test(err.message ?? '')
      );
    });
    await killIssued;

    expect(await countGroupsNamed(name), 'the killed transaction left a row behind').toBe(0);

    const alive = await admin.query<{ n: number }>(
      'select count(*)::int as n from pg_stat_activity where pid = $1',
      [killedPid],
    );
    expect(alive.rows[0]?.n, 'the terminated backend is still present').toBe(0);

    const max = (runtime.pool as unknown as { options: { max: number } }).options.max;
    const clients = await Promise.all(Array.from({ length: max }, () => runtime.pool.connect()));
    const pids = clients.map((c) => (c as unknown as { processID: number }).processID);
    for (const client of clients) client.release();
    expect(pids, 'the pool handed out a dead connection').not.toContain(killedPid);
    log(`killed backend ${String(killedPid)}; pool now holds ${pids.join(',')}`);

    await assertPoolIsClean(runtime, 'T-10');
  });

  it('T-11 nested unit of work, SAME tenant: permitted, and behaves as a savepoint', async () => {
    const outerName = marker('t11-outer');
    const innerName = marker('t11-inner');

    const pids = await runtime.runner.run(
      alphaOrganization(),
      async ({ query, backendPid, depth }) => {
        expect(depth).toBe(0);
        await insertMarkerGroup(query, multi().alpha.organizationId, outerName);

        let innerPid = 0;
        await expect(
          runtime.runner.run(alphaOrganization(), async (inner) => {
            innerPid = inner.backendPid;
            expect(inner.depth, 'a nested unit of work should report depth 1').toBe(1);
            await insertMarkerGroup(inner.query, multi().alpha.organizationId, innerName);
            throw new Error('inner failure');
          }),
        ).rejects.toThrow(/inner failure/);

        // The outer transaction survives the inner rollback. That is the savepoint.
        const visible = await query
          .selectFrom('groups')
          .select(['name'])
          .where('name', 'in', [outerName, innerName])
          .execute();
        expect(visible.map((row) => row.name)).toEqual([outerName]);

        return { backendPid, innerPid };
      },
    );

    expect(pids.innerPid, 'a nested unit of work must stay on the same backend').toBe(
      pids.backendPid,
    );
    expect(await countGroupsNamed(outerName), 'the outer write should have committed').toBe(1);
    expect(await countGroupsNamed(innerName), 'the inner write should have rolled back').toBe(0);
    log(`same backend ${String(pids.backendPid)}; outer committed, inner rolled back to savepoint`);
  });

  it('T-12 nested unit of work, DIFFERENT tenant: throws, and the outer is untouched', async () => {
    const name = marker('t12');

    await runtime.runner.run(alphaGroupOne(), async ({ query }) => {
      await query
        .updateTable('memberships')
        .set({ last_active_at: new Date() })
        .where('id', '=', multi().alpha.users.scheduler.membershipId)
        .execute();

      // A different ORGANIZATION.
      await expect(
        runtime.runner.run(betaGroupOne(), async () => {
          throw new Error('this callback must never run');
        }),
      ).rejects.toBeInstanceOf(NestedTenantChangeError);

      // A different GROUP in the SAME organization — the CAR-001 defect class.
      await expect(
        runtime.runner.run(alphaGroupTwo(), async () => {
          throw new Error('this callback must never run');
        }),
      ).rejects.toBeInstanceOf(NestedTenantChangeError);

      // The outer transaction is still healthy and still tenanted correctly.
      const rows = await query
        .selectFrom('memberships')
        .select(['organization_id', 'group_id'])
        .execute();
      expect(
        rows.every(
          (row) =>
            row.organization_id === multi().alpha.organizationId &&
            row.group_id === multi().alpha.groupOne.id,
        ),
      ).toBe(true);
      log(
        `cross-organization and cross-group re-tenanting both refused; outer still sees ${String(rows.length)} correctly-tenanted rows`,
      );
    });

    // And a same-tenant nested unit of work still commits afterwards, so the
    // refusal did not poison anything.
    await runtime.runner.run(alphaOrganization(), async ({ query }) => {
      await insertMarkerGroup(query, multi().alpha.organizationId, name);
    });
    expect(await countGroupsNamed(name)).toBe(1);
  });

  it('T-13 outside any unit of work: zero rows, and every write rejected (fail-closed)', async () => {
    for (const rt of [runtime, worker]) {
      for (const table of TENANT_TABLES) {
        const read = await outsideUnitOfWork<{ n: number }>(
          rt,
          `select count(*)::int as n from ${table.name}`,
        );
        expect(read.rows[0]?.n, `${rt.role}: ${table.name} leaked outside the wrapper`).toBe(0);
      }

      // Three write shapes, three different refusals — asserted separately
      // because they fail for different reasons and a single assertion would
      // hide two of them:
      //
      //   INSERT  rejected outright by the RLS `WITH CHECK` (42501).
      //   UPDATE  not rejected: the `USING` clause makes every row invisible, so
      //           the statement legitimately affects nothing at all.
      //   DELETE  rejected by the GRANT (42501) — it is granted to no runtime
      //           role at all (R-05 F/B, doc 09 §4: no hard delete of tenant
      //           data). This is stronger than "affects zero rows".
      await expect(
        outsideUnitOfWork(
          rt,
          `insert into groups (id, organization_id, name) values (gen_random_uuid(), $1, $2)`,
          [multi().alpha.organizationId, marker('outside-write')],
        ),
      ).rejects.toMatchObject({ code: '42501' });

      const updated = await outsideUnitOfWork(rt, `update groups set name = 'hijacked'`);
      expect(updated.rowCount, `${rt.role}: UPDATE affected rows outside the wrapper`).toBe(0);

      await expect(outsideUnitOfWork(rt, 'delete from memberships')).rejects.toMatchObject({
        code: '42501',
      });

      log(
        `${rt.role}: 0 rows readable on all ${String(TENANT_TABLES.length)} tenant tables, INSERT 42501, UPDATE affected 0 rows, DELETE 42501 (no grant)`,
      );
    }
  });

  it('T-13b Group One context cannot see or write Group Two, in the SAME organization', async () => {
    const targetId = multi().alpha.users.groupTwoScheduler.membershipId;

    await runtime.runner.run(alphaGroupOne(), async ({ query }) => {
      const seen = await query.selectFrom('memberships').select(['group_id']).execute();
      expect(seen.length).toBeGreaterThan(0);
      expect(
        seen.every((row) => row.group_id === multi().alpha.groupOne.id),
        'a Group Two membership was visible under a Group One context',
      ).toBe(true);

      const byId = await query
        .selectFrom('memberships')
        .selectAll()
        .where('id', '=', targetId)
        .execute();
      expect(byId, 'a Group Two row was addressable by id under a Group One context').toHaveLength(
        0,
      );

      const updated = await query
        .updateTable('memberships')
        .set({ group_role: 'group_admin' })
        .where('id', '=', targetId)
        .executeTakeFirst();
      expect(Number(updated.numUpdatedRows)).toBe(0);

      // An INSERT that declares Group Two fails the WITH CHECK.
      await expect(
        query
          .insertInto('memberships')
          .values({
            id: randomUUID(),
            organization_id: multi().alpha.organizationId,
            group_id: multi().alpha.groupTwo.id,
            user_id: multi().alpha.users.member.id,
            kind: 'group',
            group_role: 'member',
            organization_role: null,
          })
          .execute(),
      ).rejects.toMatchObject({ code: '42501' });
    });

    // DELETE gets its OWN unit of work, deliberately: it is refused by GRANT
    // rather than by RLS, and a privilege error aborts the transaction it is
    // issued in. Sharing a transaction with the assertions above would make
    // every statement after it fail with 25P02 instead of the code under test —
    // the assertions would still "pass", for entirely the wrong reason.
    await expect(
      runtime.runner.run(alphaGroupOne(), async ({ query }) =>
        query.deleteFrom('memberships').where('id', '=', targetId).execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    const untouched = await admin.query<{ group_role: string }>(
      'select group_role from memberships where id = $1',
      [targetId],
    );
    expect(untouched.rows[0]?.group_role).toBe('scheduler');
    log(
      'Group Two rows invisible, unaddressable and unwritable under a Group One context; DELETE refused 42501 by grant; target unmodified',
    );
  });
});

describe('SPEC-01 §7.2 T-14 — the prohibited pooling mode is detected', () => {
  it('T-14 total context loss: transaction aborted, connection discarded, page alert emitted', async () => {
    const alerts = new ProcessAlertSink({ write: () => {} });
    const pool = withSimulatedPoolerFault(
      createPool('app_runtime', { max: 3, allowExitOnIdle: true }),
      'drops-all-set-config',
    );
    const runner = new PgUnitOfWorkRunner({ role: 'app_runtime', pool, alerts });
    const name = marker('t14');
    let bodyRan = false;

    try {
      await expect(
        runner.run(alphaOrganization(), async ({ query }) => {
          bodyRan = true;
          await insertMarkerGroup(query, multi().alpha.organizationId, name);
        }),
      ).rejects.toBeInstanceOf(ContextReadbackMismatchError);

      /* (a) the transaction aborted and the BODY NEVER RAN */
      expect(bodyRan, 'the unit-of-work body ran despite a read-back mismatch').toBe(false);
      expect(await countGroupsNamed(name), 'a row was written under a mismatched context').toBe(0);

      /* (b) the connection was discarded and is never handed out again */
      expect(runner.stats.poisonedBackendPids).toHaveLength(1);
      const poisoned = runner.stats.poisonedBackendPids[0];
      const seen = new Set<number>();
      for (let round = 0; round < 4; round += 1) {
        const clients = await Promise.all([pool.connect(), pool.connect(), pool.connect()]);
        for (const client of clients)
          seen.add((client as unknown as { processID: number }).processID);
        for (const client of clients) client.release();
      }
      expect([...seen], 'the poisoned connection was handed back out').not.toContain(poisoned);
      const alive = await admin.query<{ n: number }>(
        'select count(*)::int as n from pg_stat_activity where pid = $1',
        [poisoned],
      );
      expect(alive.rows[0]?.n, 'the poisoned backend was not actually closed').toBe(0);

      /* (c) an operational alert at PAGE severity */
      const pages = alerts.byCode('CONTEXT_READBACK_MISMATCH');
      expect(pages).toHaveLength(1);
      expect(pages[0]?.severity).toBe('page');
      expect(pages[0]?.detail['backendPid']).toBe(poisoned);

      log(
        `(a) aborted, body never ran · (b) backend ${String(poisoned)} destroyed, 12 later checkouts used ${[...seen].join(',')} · (c) severity=page`,
      );
    } finally {
      await pool.end();
    }

    /* control: with the pooler behaving, the identical unit of work succeeds */
    const controlName = marker('t14-control');
    await runtime.runner.run(alphaOrganization(), async ({ query }) => {
      await insertMarkerGroup(query, multi().alpha.organizationId, controlName);
    });
    expect(await countGroupsNamed(controlName)).toBe(1);
    log('control: the identical unit of work succeeds once the pooler preserves set_config');
  });

  it('T-14b PARTIAL loss — only app.group_id — which a single-setting read-back would miss', async () => {
    // SPEC-01 §4.2's original pseudo-code verified `app.organization_id` alone.
    // This is the case that makes that insufficient: organization context
    // survives, group context does not, and the unit of work would then run
    // fail-OPEN across every group in the right organization — the CAR-001
    // defect class, below the application layer where no amount of
    // application-level context validation can see it.
    const alerts = new ProcessAlertSink({ write: () => {} });
    const pool = withSimulatedPoolerFault(
      createPool('app_runtime', { max: 3, allowExitOnIdle: true }),
      'drops-group-id',
    );
    const runner = new PgUnitOfWorkRunner({ role: 'app_runtime', pool, alerts });
    let bodyRan = false;

    try {
      const context = alphaGroupOne();
      await expect(
        runner.run(context, async () => {
          bodyRan = true;
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(ContextReadbackMismatchError);
        const mismatches = (error as ContextReadbackMismatchError).mismatches;
        // Exactly ONE setting mismatched, and it is the one a naive read-back
        // would never have looked at.
        expect(
          mismatches,
          `expected exactly one mismatch, got ${String(mismatches.length)}`,
        ).toHaveLength(1);
        expect(mismatches[0]?.setting).toBe('app.group_id');
        expect(mismatches[0]?.expected).toBe(multi().alpha.groupOne.id);
        // On a pristine backend the never-set GUC reads back as NULL; on a
        // reused one it reads back as ''. Both mean "the setting did not land",
        // and which one appears depends on whether this checkout has carried
        // context before (X-09).
        expect([null, '']).toContain(mismatches[0]?.actual);
        return true;
      });

      expect(bodyRan, 'the body ran despite a partial context loss').toBe(false);
      expect(runner.stats.poisonedBackendPids).toHaveLength(1);
      const pages = alerts.byCode('CONTEXT_READBACK_MISMATCH');
      expect(pages).toHaveLength(1);
      expect(pages[0]?.severity).toBe('page');
      expect(pages[0]?.detail['mismatchedSettings']).toEqual(['app.group_id']);

      log(
        `only app.group_id lost; exactly one mismatch reported; backend ${String(runner.stats.poisonedBackendPids[0])} poisoned and paged`,
      );
    } finally {
      await pool.end();
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * T-15 — the two-organization storm
 * ──────────────────────────────────────────────────────────────────────────── */

interface StormStats {
  iterations: number;
  unitsOfWork: number;
  committed: number;
  injectedFaults: number;
  probeTableReads: number;
  probePasses: number;
  outsideProbeReads: number;
  wrongTenantRows: number;
  tenantTableStatements: number;
}

describe('SPEC-01 §7.2 T-15 — two-organization concurrency storm', () => {
  it('runs both roles against every tenant table under injected faults with zero wrong-tenant rows', async () => {
    // SPEC-01 T-15 says **10 000 interleaved operations**. The spike's packet
    // relaxed that to ">=50 iterations"; this one does not, and it does not need
    // to — at four contexts per iteration and three tenant-table statements per
    // unit of work, 900 iterations clears the stated bar with room to spare and
    // still runs in about a second. Protocol overhead (BEGIN, 4x set_config, the
    // read-back, COMMIT/ROLLBACK) is counted separately so it cannot inflate the
    // figure.
    const iterations = Number.parseInt(process.env['SP_STORM_ITERATIONS'] ?? '900', 10);

    const stormRuntime = createRuntime('app_runtime', { max: 3 });
    const stormWorker = createRuntime('app_worker', { max: 2 });
    // The probe runs on its OWN pool, so it proves cross-connection isolation;
    // the in-unit-of-work self-check inside each storm worker covers the
    // workload's own connections.
    const probeRuntime = createRuntime('app_runtime', { max: 2 });

    const stats: StormStats = {
      iterations,
      unitsOfWork: 0,
      committed: 0,
      injectedFaults: 0,
      probeTableReads: 0,
      probePasses: 0,
      outsideProbeReads: 0,
      wrongTenantRows: 0,
      tenantTableStatements: 0,
    };
    const failures: string[] = [];
    /** Tables the probe actually observed with at least one visible row. */
    const nonVacuous = new Set<string>();

    const contexts: readonly (() => TenantContext)[] = [
      alphaGroupOne,
      alphaGroupTwo,
      betaGroupOne,
      () =>
        groupContext(
          multi().beta.organizationId,
          multi().beta.groupTwo.id,
          'bc000002-2222-4222-8222-000000000002',
          randomUUID(),
        ),
    ];

    /**
     * Organization-scoped probe contexts, one per organization.
     *
     * The acting membership is each organization's administrator — an
     * organization-scoped context needs an organization membership, and using a
     * group membership's id here would be refused at the context read-back
     * rather than probing anything.
     */
    const organizationProbeContexts: readonly (() => TenantContext)[] = [
      () => ({
        organizationId: multi().alpha.organizationId,
        groupId: null,
        membershipId: multi().alpha.users.organizationAdmin.membershipId,
        correlationId: randomUUID(),
      }),
      () => ({
        organizationId: multi().beta.organizationId,
        groupId: null,
        membershipId: multi().beta.users.organizationAdmin.membershipId,
        correlationId: randomUUID(),
      }),
    ];

    /** Precomputed ground truth for the `users` probe, one set per context. */
    const expectedUsers = new Map<string, string[]>();
    for (const make of [...contexts, ...organizationProbeContexts]) {
      const context = make();
      expectedUsers.set(
        `${context.organizationId}|${String(context.groupId)}`,
        await expectedVisibleUserIds(admin, context),
      );
    }

    async function probeInside(rt: Runtime, context: TenantContext): Promise<void> {
      const expected =
        expectedUsers.get(`${context.organizationId}|${String(context.groupId)}`) ?? [];
      await rt.runner.run(context, async ({ query }) => {
        for (const table of TENANT_TABLES) {
          const probe = wrongTenantProbe(table, context, expected);
          const result = (await query.executeQuery(
            CompiledQuery.raw(probe.text, probe.values),
          )) as unknown as { rows: ProbeResult[] };
          const row = result.rows[0];
          stats.probeTableReads += 1;
          if ((row?.visible ?? 0) > 0) nonVacuous.add(table.name);
          if ((row?.wrong ?? 0) > 0) {
            stats.wrongTenantRows += row?.wrong ?? 0;
            failures.push(
              `${table.name}: ${String(row?.wrong)} wrong-tenant row(s) visible under (${context.organizationId}, ${String(context.groupId)})`,
            );
          }
        }
        stats.probePasses += 1;
      });
    }

    async function probeOutside(rt: Runtime): Promise<void> {
      for (const table of TENANT_TABLES) {
        const result = await outsideUnitOfWork<{ n: number }>(
          rt,
          `select count(*)::int as n from ${table.name}`,
        );
        stats.outsideProbeReads += 1;
        if ((result.rows[0]?.n ?? 0) > 0) {
          stats.wrongTenantRows += result.rows[0]?.n ?? 0;
          failures.push(`${table.name}: visible OUTSIDE any unit of work`);
        }
      }
    }

    try {
      for (let iteration = 0; iteration < iterations; iteration += 1) {
        const batch: Promise<unknown>[] = [];

        for (const [index, make] of contexts.entries()) {
          const context = make();
          const rt = (iteration + index) % 3 === 0 ? stormWorker : stormRuntime;
          stats.unitsOfWork += 1;

          // Deterministic fault schedule, on a fixed modulus rather than a
          // seeded RNG: reproducible, and it explores one interleaving pattern
          // rather than sampling many. Recorded as a limitation, not hidden.
          const injectFault = (iteration + index) % 7 === 0;

          batch.push(
            rt.runner
              .run(context, async ({ query }) => {
                // A real tenant-table write, then a read-back of the tenant
                // coordinates the transaction can see.
                await query
                  .updateTable('memberships')
                  .set({ last_active_at: new Date() })
                  .where('group_id', '=', context.groupId)
                  .execute();

                const visible = await query
                  .selectFrom('memberships')
                  .select(['organization_id', 'group_id'])
                  .execute();
                const wrong = visible.filter(
                  (row) =>
                    row.organization_id !== context.organizationId ||
                    row.group_id !== context.groupId,
                );
                if (wrong.length > 0) {
                  stats.wrongTenantRows += wrong.length;
                  failures.push(
                    `in-workload self-check saw ${String(wrong.length)} wrong-tenant membership row(s)`,
                  );
                }

                if (injectFault) {
                  stats.injectedFaults += 1;
                  throw new Error('injected storm fault');
                }
                stats.committed += 1;
              })
              .catch((error: unknown) => {
                if (!(error instanceof Error) || error.message !== 'injected storm fault')
                  throw error;
              }),
          );
        }

        // The probe runs concurrently with the batch, on its own pool, both
        // inside a unit of work and outside every unit of work.
        batch.push(probeInside(probeRuntime, contexts[iteration % contexts.length]!()));
        // …and under an ORGANIZATION-scoped context as well (OPUS-M1-004).
        //
        // The storm's workload is deliberately group-scoped — it writes
        // `memberships where group_id = context.groupId`, which has no meaning
        // without a group — so the organization contexts are added as PROBE
        // contexts rather than as workload contexts. Without them
        // `audit_checkpoints` is never observed with a visible row: its policy
        // is organization-context-only by design (0003, R-06), so a
        // group-scoped probe over it reports the vacuous zero this storm's own
        // non-vacuity assertion exists to catch.
        batch.push(
          probeInside(
            probeRuntime,
            organizationProbeContexts[iteration % organizationProbeContexts.length]!(),
          ),
        );
        batch.push(probeOutside(probeRuntime));

        await Promise.all(batch);
      }

      stats.tenantTableStatements =
        stormRuntime.runner.stats.tenantTableStatements +
        stormWorker.runner.stats.tenantTableStatements +
        probeRuntime.runner.stats.tenantTableStatements;

      /* ── the assertions ─────────────────────────────────────────────────── */

      expect(failures, failures.slice(0, 10).join('\n')).toEqual([]);
      expect(stats.wrongTenantRows, 'a wrong-tenant row was observed').toBe(0);

      // A probe that saw nothing reports "0 wrong" for the boring reason. Every
      // tenant table must have been observed with at least one visible row.
      expect([...nonVacuous].sort(), 'the probe was vacuous on at least one tenant table').toEqual(
        TENANT_TABLES.map((t) => t.name).sort(),
      );

      const partitions = await actualPartitions(admin);
      const organizations = await actualOrganizations(admin);
      const census = await tenantRowCensus(admin);
      const impossible = impossibleCensusRows(census, partitions, organizations);
      expect(impossible, JSON.stringify(impossible)).toEqual([]);

      log(
        `${String(stats.iterations)} iterations · ${String(stats.unitsOfWork)} units of work · ` +
          `${String(stats.committed)} committed · ${String(stats.injectedFaults)} injected faults`,
      );
      log(
        `${String(stats.probePasses)} probe passes × ${String(TENANT_TABLES.length)} tables = ` +
          `${String(stats.probeTableReads)} in-wrapper reads, ${String(stats.outsideProbeReads)} outside-wrapper reads`,
      );
      // SPEC-01 T-15's stated scale, asserted rather than reported. A storm that
      // quietly shrank would still print "0 wrong-tenant rows" and mean much less.
      expect(
        stats.tenantTableStatements,
        "the storm did not reach SPEC-01 T-15's 10 000 interleaved operations",
      ).toBeGreaterThanOrEqual(10_000);
      log(
        `${String(stats.tenantTableStatements)} tenant-table statements (protocol overhead counted separately)`,
      );
      log(
        `census: ${String(census.length)} partitions, ${String(impossible.length)} impossible · ` +
          `WRONG-TENANT ROWS: ${String(stats.wrongTenantRows)}`,
      );
    } finally {
      await stormRuntime.destroy();
      await stormWorker.destroy();
      await probeRuntime.destroy();
    }
  });
});

describe('R-15 — a nested unit of work may not change the acting membership', () => {
  it('re-tenanting the ACTOR throws before any statement, and the outer commits', async () => {
    // The tenant tuple is unchanged; only `app.membership_id` differs. That
    // setting is what the audit chain will attribute every row in the
    // transaction to, and a savepoint cannot carry its own — so a nested call
    // that believed it had switched actors would silently write under the outer
    // one's name. Refused, before any statement is issued.
    const name = marker('r15');
    const outer = alphaGroupOne();

    await runtime.runner.run(outer, async ({ query }) => {
      await query
        .updateTable('memberships')
        .set({ last_active_at: new Date() })
        .where('id', '=', multi().alpha.users.scheduler.membershipId)
        .execute();

      await expect(
        runtime.runner.run(
          { ...outer, membershipId: multi().alpha.users.member.membershipId },
          async () => {
            throw new Error('this callback must never run');
          },
        ),
      ).rejects.toBeInstanceOf(NestedTenantChangeError);

      // A nested call declaring NO actor of its own is fine: it inherits the
      // outer attribution, which is what the resolution and system-actor paths
      // rely on.
      const inherited = await runtime.runner.run(
        { ...outer, membershipId: null },
        async (inner) => inner.context.membershipId,
      );
      expect(inherited, 'the nested call did not inherit the outer actor').toBe(outer.membershipId);
    });

    // The outer transaction was untouched by the refusal and still commits.
    await runtime.runner.run(alphaOrganization(), async ({ query }) => {
      await insertMarkerGroup(query, multi().alpha.organizationId, name);
    });
    expect(await countGroupsNamed(name)).toBe(1);
    log('nested actor change refused before any statement; outer transaction unaffected');
  });
});
