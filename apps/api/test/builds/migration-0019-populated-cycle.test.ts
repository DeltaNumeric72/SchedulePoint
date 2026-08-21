import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runningBuildCount } from '../../src/builds/capacity.js';
import { migrate } from '../../src/db/migrate.js';
import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import { seedBuildFixture, type BuildFixture } from '../support/builds.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * **Migration 0019, up → down → up, over a POPULATED database** (OPUS-M4-005;
 * doc 35 §6g Acceptance, "migration cycle 0001–0018(19)").
 *
 * ## What is different about this one
 *
 * 0019 creates **no table**. It creates one policy and one `SECURITY DEFINER`
 * function, so there is no row census to take and no `DROP TABLE` whose
 * destruction has to be excused. The cycle assertion is therefore about the
 * things that CAN silently fail to come back:
 *
 *  * the function exists and is `SECURITY DEFINER` again;
 *  * `EXECUTE` is granted to `app_runtime` and `app_worker` and to **nobody
 *    else** — a re-up that restored the function while `REVOKE ALL … FROM
 *    PUBLIC` was lost would leave every role able to call it, and the count it
 *    returns would look identical;
 *  * the policy exists again, `FOR SELECT`, `TO app_migrator` only;
 *  * and the guard still REFUSES a foreign organization id. That is the arm that
 *    matters, because 0003's R-05 lesson is that a definer function reading a
 *    foreign tenant returns **0** rather than an error — a confident statement
 *    that nothing is running, which would silently disable the cap.
 *
 * ## BY NAME, never by position — FAD-33(4)
 *
 * The loop's termination condition is the migration's NAME, so there is no count
 * to go stale when 0020 lands above it. The re-up sits in a `finally` and the
 * loop's own "ran out of migrations" throw sits INSIDE the `try`, because an
 * abort with migrations already reversed is exactly the cluster poisoning the
 * idiom exists to prevent.
 */

const multi = ownedMulti('builds-migration-0019-cycle', {
  profile: 'core',
  seed: { catalogue: ['alpha'], scheduleCredentials: true },
});

let runtime: Runtime;
let fixture: BuildFixture;

const run = async <T>(fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> =>
  runtime.runner.run(fixture.context, fn);

interface FunctionShape {
  readonly security_definer: boolean;
  readonly grantees: string;
}

/** The function's security posture and its exact grantee set, as the catalogue holds them. */
async function functionShape(): Promise<FunctionShape | null> {
  return run(async ({ query }) => {
    const rows = await sql<FunctionShape>`
      SELECT p.prosecdef AS security_definer,
             coalesce(
               (SELECT string_agg(DISTINCT a.grantee::regrole::text, ',' ORDER BY a.grantee::regrole::text)
                  FROM aclexplode(p.proacl) a
                 WHERE a.privilege_type = 'EXECUTE'),
               '(none)') AS grantees
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'app_build_running_count'
    `.execute(query);
    return rows.rows[0] ?? null;
  });
}

/** The capacity policy's command and role list, as `pg_policies` holds them. */
async function policyShape(): Promise<{ cmd: string; roles: string } | null> {
  return run(async ({ query }) => {
    const rows = await sql<{ cmd: string; roles: string }>`
      SELECT cmd, roles::text AS roles
        FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename = 'build_runs'
         AND policyname = 'build_runs_organization_capacity_read'
    `.execute(query);
    return rows.rows[0] ?? null;
  });
}

beforeAll(async () => {
  runtime = createRuntime('app_runtime');
  const alpha = multi().alpha;
  const catalogue = multi.catalogue('alpha');
  const shiftTypeId = catalogue.shiftTypeIds[1];
  if (shiftTypeId === undefined) throw new Error('the alpha catalogue seed produced no shift type');

  fixture = await seedBuildFixture(runtime.runner, {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    membershipId: alpha.users.scheduler.membershipId,
    userId: alpha.users.scheduler.id,
    shiftTypeId,
    label: 'cycle-0019',
    startDate: '2046-03-05',
    endDate: '2046-03-11',
  });
}, 240_000);

afterAll(async () => {
  await runtime?.destroy();
});

describe('migration 0019 over a populated database', () => {
  it('up → down → up, resolved and asserted BY NAME', async () => {
    const before = await functionShape();
    const policyBefore = await policyShape();
    expect(before, 'the function must exist before the cycle — else this is vacuous').not.toBeNull();
    expect(policyBefore, 'the policy must exist before the cycle').not.toBeNull();
    expect(before?.security_definer).toBe(true);
    expect(before?.grantees, 'the grantee set before the cycle').toBe(
      'app_migrator,app_runtime,app_worker',
    );

    /* The counter answers before the cycle, so "it answers after" means
     * something. Zero is the honest answer here: the fixture has no running
     * build, and the point is that the CALL succeeds. */
    expect(await run(async (uow) => runningBuildCount(uow))).toBe(0);

    let up: readonly string[] = [];
    let midwayFunction: FunctionShape | null = null;
    let midwayPolicy: { cmd: string; roles: string } | null = null;
    const down: string[] = [];
    try {
      while (!down.some((name) => name.includes('0019'))) {
        const step = await migrate('down', { count: 1 });
        if (step.applied.length === 0) {
          throw new Error('ran out of migrations before reaching 0019 — the ledger is empty');
        }
        down.push(...step.applied);
      }
      midwayFunction = await functionShape();
      midwayPolicy = await policyShape();
    } finally {
      up = (await migrate('up', { count: down.length })).applied;
    }

    /* The down migration really removed both. A `DROP … IF EXISTS` that named
     * the wrong signature would leave them in place and every assertion after
     * the re-up would pass without the cycle having tested anything. */
    expect(midwayFunction, 'the down migration left the function behind').toBeNull();
    expect(midwayPolicy, 'the down migration left the policy behind').toBeNull();

    expect(up).toHaveLength(down.length);
    expect(up.some((name) => name.includes('0019'))).toBe(true);

    const after = await functionShape();
    expect(after?.security_definer, 'the function came back without SECURITY DEFINER').toBe(true);
    /* The grantee set, EXACTLY, and the owner is in it on purpose.
     *
     * `REVOKE ALL … FROM PUBLIC` is the half a re-up can silently lose: the
     * function would work, the counter would be right, and every role in the
     * system could call it — which is invisible to any test that only checks
     * that `app_runtime` can call it.
     *
     * PostgreSQL writes the OWNER's own grant into the ACL as soon as the
     * default `PUBLIC` entry is revoked, so `app_migrator` appearing here is the
     * revoke having happened rather than a widening. What must never appear is a
     * fourth name, or `PUBLIC` (rendered by `regrole` as `-`). */
    expect(after?.grantees).toBe('app_migrator,app_runtime,app_worker');
    expect(after?.grantees).not.toContain('-');

    const policyAfter = await policyShape();
    expect(policyAfter?.cmd, 'the capacity policy is no longer SELECT-only').toBe('SELECT');
    expect(policyAfter?.roles, 'the capacity policy widened beyond app_migrator').toBe(
      '{app_migrator}',
    );
  }, 240_000);

  it('MUTATION CONTROL: the context guard still REFUSES a foreign organization', async () => {
    /* The arm that would notice a re-up which restored the function body without
     * its guard. 0003's R-05: with the policy alone a foreign id matches no row
     * and the count comes back **0** — not an error, a confident statement that
     * the tenant has nothing running. Every assertion above would still pass. */
    const foreign = multi().beta.organizationId;
    await expect(
      run(async ({ query }) =>
        sql`SELECT app_build_running_count(${foreign}::uuid) AS n`.execute(query),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('BUILD_CAPACITY_CONTEXT_MISMATCH'),
    });

    /* …and the caller's OWN organization still answers, so the arm above is not
     * passing because the function refuses everything. */
    expect(await run(async (uow) => runningBuildCount(uow))).toBe(0);
  }, 120_000);
});
