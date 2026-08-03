import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import { recordAuditEvent } from '../../src/audit/recorder.js';
import { provisionAuthorization } from '../../src/authz/provisioning.js';
import { ProcessAlertSink } from '../../src/db/alerts.js';
import { bootstrapCluster, rolePasswordsFromEnv } from '../../src/db/bootstrap.js';
import { migrateCycle } from '../../src/db/migrate.js';
import { createPool } from '../../src/db/pool.js';
import { installQueueSchema } from '../../src/db/queue-schema.js';
import { TENANT_TABLES } from '../../src/db/schema.js';
import { PgUnitOfWorkRunner } from '../../src/db/unit-of-work.js';
import { publishOutboxEvent } from '../../src/outbox/publisher.js';
import { startClusterDaemon, stopClusterDaemon } from '../support/cluster-process.js';
import { applyHarnessEnv } from '../support/env.js';
import { groupContext, organizationContext, seedAuditAndOutbox, seedFixture } from '../support/fixtures.js';

/* ────────────────────────────────────────────────────────────────────────────
 * OPUS-M2-001 phase A — PROTOTYPE of the recommended mechanism, at full scale.
 *
 * The recommendation is that a file which mutates state provisions its OWN
 * tenant instead of writing to the shared baseline. Two things must be true for
 * that to be worth proposing, and neither is safe to assume:
 *
 *   P1  the aggregate cost at the real file count is small — measured here by
 *       provisioning one owned tenant per existing api test file (24), on top
 *       of the ordinary shared baseline, in one cluster;
 *   P2  the isolation is real — measured here by asking, from inside each
 *       owned tenant's own unit of work, how many rows of every tenant table it
 *       can see that belong to somebody else. The answer must be 0, on every
 *       table, for every tenant. A projection would not establish this; RLS is
 *       the thing being relied on, so RLS is the thing that gets probed.
 *
 * This prototypes the MECHANISM. It converts no test and modifies no fixture —
 * phase A measures, the refactor waits for ratification.
 * ──────────────────────────────────────────────────────────────────────────── */

const TENANT_COUNT = Number.parseInt(process.env['SP_NR13_TENANTS'] ?? '24', 10);

interface OwnedTenant {
  readonly slug: string;
  readonly organizationId: string;
  readonly groupIds: readonly [string, string];
  readonly adminMembershipId: string;
  readonly schedulerMembershipId: string;
}

/**
 * One owned tenant, shaped like the MULTI fixture's Alpha: an organization, two
 * groups, an organization administrator, a group scheduler, a capability grant,
 * and one audited + published event so no probe over it is vacuous.
 *
 * Synthetic throughout. Every identifier is a fresh UUID; every address is at
 * `example.invalid`, the RFC 2606 reserved TLD, which cannot resolve.
 */
async function provisionOwnedTenant(
  runner: PgUnitOfWorkRunner,
  slug: string,
): Promise<OwnedTenant> {
  const organizationId = randomUUID();
  const groupIds: [string, string] = [randomUUID(), randomUUID()];
  const adminUserId = randomUUID();
  const schedulerUserId = randomUUID();
  const adminMembershipId = randomUUID();
  const schedulerMembershipId = randomUUID();

  // Pass 1 — through the provisioning door, which shuts on the first membership.
  await runner.run(organizationContext(organizationId, `owned-${slug}`), async ({ query }) => {
    await query
      .insertInto('organizations')
      .values({ id: organizationId, name: `Owned Tenant ${slug} (synthetic)` })
      .execute();
    await query
      .insertInto('groups')
      .values(
        groupIds.map((id, position) => ({
          id,
          organization_id: organizationId,
          name: `Owned ${slug} Group ${String(position + 1)}`,
        })),
      )
      .execute();
    await query
      .insertInto('users')
      .values([
        {
          id: adminUserId,
          // `users_login_email_unique` is GLOBAL (login identity), so the slug
          // has to be in the address or two owned tenants collide at 23505.
          login_email: `owned-${slug}-admin@example.invalid`,
          display_name: `Owned ${slug} Administrator (synthetic)`,
        },
        {
          id: schedulerUserId,
          login_email: `owned-${slug}-scheduler@example.invalid`,
          display_name: `Owned ${slug} Scheduler (synthetic)`,
        },
      ])
      .execute();
    await provisionAuthorization(query, { organizationId, groupIds });
    await query
      .insertInto('memberships')
      .values({
        id: adminMembershipId,
        organization_id: organizationId,
        group_id: null,
        user_id: adminUserId,
        kind: 'organization' as const,
        organization_role: 'org_admin',
        group_role: null,
      })
      .execute();
  });

  // Pass 2 — the door is shut; the administrator authorizes the rest.
  await runner.run(
    { ...organizationContext(organizationId, `owned-${slug}`), membershipId: adminMembershipId },
    async ({ query }) => {
      await query
        .insertInto('memberships')
        .values({
          id: schedulerMembershipId,
          organization_id: organizationId,
          group_id: groupIds[0],
          user_id: schedulerUserId,
          kind: 'group' as const,
          group_role: 'scheduler',
          organization_role: null,
          status: 'active' as const,
        })
        .execute();
      await query
        .insertInto('capability_grants')
        .values({
          id: randomUUID(),
          organization_id: organizationId,
          group_id: groupIds[0],
          membership_id: schedulerMembershipId,
          capability_key: 'schedule.publish',
          granted: true,
          granted_by_membership_id: adminMembershipId,
        })
        .execute();
    },
  );

  // One audited + published event, so audit_events and outbox_events are
  // non-vacuous inside this tenant too.
  await runner.run(
    groupContext(organizationId, groupIds[0], schedulerMembershipId, `owned-${slug}-touch`),
    async (uow) => {
      await uow.query
        .updateTable('memberships')
        .set({ last_active_at: new Date() })
        .where('id', '=', schedulerMembershipId)
        .execute();
      const recorded = await recordAuditEvent(uow, {
        eventName: 'membership.activity_touched',
        subjectType: 'membership',
        subjectId: schedulerMembershipId,
      });
      await publishOutboxEvent(uow, recorded, {
        kind: 'membership.activity_touched',
        idempotencyKey: `owned-${slug}:${String(recorded.sequence)}`,
      });
    },
  );

  return { slug, organizationId, groupIds, adminMembershipId, schedulerMembershipId };
}

async function main(): Promise<void> {
  applyHarnessEnv();
  const daemon = await startClusterDaemon();
  const lines: string[] = [];
  let failure: unknown;

  try {
    await bootstrapCluster({ passwords: rolePasswordsFromEnv() });
    await migrateCycle();
    await installQueueSchema();

    const pool = createPool('app_runtime', { max: 4, allowExitOnIdle: true });
    const runner = new PgUnitOfWorkRunner({
      role: 'app_runtime',
      pool,
      alerts: new ProcessAlertSink({ write: () => {} }),
    });
    const workerPool = createPool('app_worker', { max: 2, allowExitOnIdle: true });
    const workerRunner = new PgUnitOfWorkRunner({
      role: 'app_worker',
      pool: workerPool,
      alerts: new ProcessAlertSink({ write: () => {} }),
    });

    try {
      const baselineStart = performance.now();
      await seedFixture(runner);
      await seedAuditAndOutbox(runner, workerRunner);
      const baselineMs = performance.now() - baselineStart;

      /* ── P1: aggregate cost ────────────────────────────────────────────── */
      const perTenant: number[] = [];
      const tenants: OwnedTenant[] = [];
      for (let i = 0; i < TENANT_COUNT; i += 1) {
        const started = performance.now();
        tenants.push(await provisionOwnedTenant(runner, `f${String(i).padStart(2, '0')}`));
        perTenant.push(performance.now() - started);
      }
      const total = perTenant.reduce((a, b) => a + b, 0);
      const sorted = [...perTenant].sort((a, b) => a - b);

      lines.push(
        'P1  AGGREGATE COST — one owned tenant per existing api test file',
        `      shared MULTI baseline (unchanged, seeded once): ${baselineMs.toFixed(1)} ms`,
        `      owned tenants provisioned:                      ${String(TENANT_COUNT)}`,
        `      per tenant:  min ${(sorted[0] ?? 0).toFixed(1)} ms  ` +
          `median ${(sorted[Math.floor(sorted.length / 2)] ?? 0).toFixed(1)} ms  ` +
          `max ${(sorted[sorted.length - 1] ?? 0).toFixed(1)} ms`,
        `      TOTAL added to a run:                           ${total.toFixed(1)} ms`,
        '      Each owned tenant is a full working tenant: 2 groups, an organization',
        '      administrator, a group scheduler, a capability grant, and one audited +',
        '      published event, all through the production paths.',
      );

      /* ── P2: is the isolation real? ────────────────────────────────────── */
      let worstWrong = 0;
      let probes = 0;
      const visibility: string[] = [];
      for (const tenant of tenants) {
        const result = await runner.run(
          organizationContext(tenant.organizationId, `owned-${tenant.slug}-probe`),
          async (uow) => {
            const counts: { table: string; wrong: number; visible: number }[] = [];
            for (const table of TENANT_TABLES) {
              // `users` is GLOBAL by PO-DEC-06 and is reached through a
              // membership rather than through a tenant column, so "wrong" is
              // not a column comparison for it. It is reported separately.
              if (table.scope === 'through-membership') continue;
              // `organizations` is keyed by `id`; every other tenant table
              // carries `organization_id`. This is the same scope switch
              // `wrongTenantProbe` makes in `test/support/harness.ts` — copied
              // rather than imported because that module imports vitest's
              // `expect`, which does not belong in a standalone script.
              const tenantColumn = table.scope === 'organization-identity' ? 'id' : 'organization_id';
              // The table and column names are interpolated because an
              // identifier cannot be a bind parameter. Both come only from
              // `TENANT_TABLES`, the closed hard-coded registry in
              // `src/db/schema.ts`, never from input.
              const rows = await sql<{ wrong: number; visible: number }>`
                select count(*) filter (
                         where ${sql.raw(tenantColumn)} is distinct from ${tenant.organizationId}::uuid
                       )::int as wrong,
                       count(*)::int as visible
                  from ${sql.raw(table.name)}
              `.execute(uow.query);
              const row = rows.rows[0];
              counts.push({
                table: table.name,
                wrong: Number(row?.wrong ?? 0),
                visible: Number(row?.visible ?? 0),
              });
            }
            return counts;
          },
        );
        for (const row of result) {
          probes += 1;
          if (row.wrong > worstWrong) worstWrong = row.wrong;
        }
        if (tenant === tenants[0]) {
          visibility.push(
            ...result.map(
              (row) =>
                `        ${row.table}: ${String(row.visible)} visible, ${String(row.wrong)} wrong`,
            ),
          );
        }
      }

      lines.push(
        '',
        'P2  IS THE ISOLATION REAL? — every owned tenant probes every tenant table',
        `      probes: ${String(probes)} (tenant x table), asked from inside each tenant's own`,
        '      unit of work, with the shared baseline and 23 sibling tenants all present',
        `      WORST wrong-tenant row count across every probe: ${String(worstWrong)}`,
        '      Visibility inside the first owned tenant, to show the probe is not vacuous',
        '      (a probe over an empty table reports 0 wrong for the boring reason):',
        ...visibility,
      );
    } finally {
      await pool.end();
      await workerPool.end();
    }
  } catch (error) {
    failure = error;
  } finally {
    await stopClusterDaemon(daemon);
  }

  process.stdout.write(`\n${lines.join('\n')}\n`);
  if (failure !== undefined) throw failure;
}

await main();
