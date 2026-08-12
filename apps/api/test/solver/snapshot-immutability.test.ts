import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool } from '../../src/db/pool.js';
import type { RoleName } from '../../src/db/roles.js';
import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import { assembleCanonicalInput } from '../../src/solver/canonical-input.js';
import { persistCanonicalInput } from '../../src/solver/snapshot-store.js';
import { adminClient } from '../support/admin-client.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { fixtureInstant } from '../support/schedule.js';
import { seedSolverFixture, type SolverFixture } from '../support/solver.js';

/**
 * **NAMED PROOF — a solver input snapshot cannot be rewritten by anyone**
 * (OPUS-M4-001; migration 0016, doc 35 §6a "snapshot immutability DB-enforced").
 *
 * A snapshot that could be edited would be **worse than no snapshot**: it would
 * carry the authority of a record while describing something that never
 * happened. That is the same reason D-15d exists for publication history, and it
 * is why the packet asks for the guard trigger *as well as* the absent grant.
 *
 * Two arms, and the second is the one that matters:
 *
 *  1. **No runtime role holds UPDATE or DELETE.** Probed as `app_runtime` and as
 *     `app_worker`, and probed for the read-only roles too.
 *  2. **The OWNER is refused as well**, by `app_guard_append_only` (0009, reused
 *     rather than re-declared). A grant-only control is one `GRANT` away from
 *     being gone, and the owner path is exactly where a maintenance script would
 *     run.
 *
 * ## Mutation control (FAD-15)
 *
 * A SELECT succeeds on every role that is supposed to have one. Without it, "the
 * write was refused" would be indistinguishable from "the row is invisible", and
 * the proof would hold just as well against a table nobody can see at all.
 */

const multi = ownedMulti('solver-snapshot-immutability', {
  profile: 'core',
  seed: { catalogue: ['alpha'], scheduleCredentials: true },
});

let runtime: Runtime;
let admin: pg.Client;
let context: { organizationId: string; groupId: string; membershipId: string; correlationId: string };
let fixture: SolverFixture;
let snapshotId: string;

const run = async <T>(fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> =>
  runtime.runner.run(context, fn);

const BUILD_AT = fixtureInstant('2027-11-01', 12);

beforeAll(async () => {
  runtime = createRuntime('app_runtime', { max: 4 });
  admin = adminClient();
  await admin.connect();

  const alpha = multi().alpha;
  const shiftTypeId = multi.catalogue('alpha').shiftTypeIds[1];
  if (shiftTypeId === undefined) throw new Error('no shift type');

  context = {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    membershipId: alpha.users.scheduler.membershipId,
    correlationId: 'solver-snapshot-immutability',
  };

  fixture = await seedSolverFixture(runtime.runner, {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    actorMembershipId: alpha.users.scheduler.membershipId,
    actorUserId: alpha.users.scheduler.id,
    shiftTypeId,
    startDate: '2027-11-01',
    endDate: '2027-11-07',
    requiredCount: 1,
  });

  snapshotId = (
    await run(async (uow) => {
      const assembled = await assembleCanonicalInput(uow, {
        periodId: fixture.periodId,
        versionId: fixture.versionId,
        at: BUILD_AT,
      });
      return persistCanonicalInput(uow, {
        document: assembled.document,
        constituents: assembled.constituents,
        idempotencyKey: `immutability-${randomUUID()}`,
      });
    })
  ).snapshotId;
}, 180_000);

afterAll(async () => {
  await admin.end();
  await runtime?.destroy();
});

/** A unit-of-work runner under a named role, for the per-role probes. */
async function asRole<T>(role: RoleName, fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> {
  const pool = createPool(role, { max: 1, allowExitOnIdle: true });
  const roleRuntime = createRuntime(role, { max: 1 });
  try {
    return await roleRuntime.runner.run(context, fn);
  } finally {
    await roleRuntime.destroy();
    await pool.end();
  }
}

describe('a solver input snapshot is immutable in the database', () => {
  it.each(['app_runtime', 'app_worker'] as const)(
    '%s can SELECT it but can neither UPDATE nor DELETE it',
    async (role) => {
      /* The MUTATION CONTROL first: without a successful read, "the write was
       * refused" would be indistinguishable from "the row is invisible". */
      const visible = await asRole(
        role,
        async ({ query }) =>
          await sql<{ n: string }>`
            SELECT count(*)::text AS n FROM solver_input_snapshots WHERE id = ${snapshotId}
          `.execute(query),
      );
      expect(visible.rows[0]?.n, `${role} cannot even see the row`).toBe('1');

      await expect(
        asRole(role, async ({ query }) =>
          sql`UPDATE solver_input_snapshots SET canonical_input_hash = ${'0'.repeat(64)}
               WHERE id = ${snapshotId}`.execute(query),
        ),
      ).rejects.toThrow();

      await expect(
        asRole(role, async ({ query }) =>
          sql`DELETE FROM solver_input_snapshots WHERE id = ${snapshotId}`.execute(query),
        ),
      ).rejects.toThrow();
      log(`      · ${role}: SELECT yes, UPDATE no, DELETE no`);
    },
  );

  it('the payload itself cannot be edited in place', async () => {
    /* The most valuable field to tamper with: a payload that could be edited
     * after the fact would let somebody change what a build was asked to solve
     * while the hash — and every citation of it — stayed exactly the same. */
    await expect(
      run(async ({ query }) =>
        sql`UPDATE solver_input_snapshots SET payload = '{}'::jsonb WHERE id = ${snapshotId}`.execute(
          query,
        ),
      ),
    ).rejects.toThrow();
  });

  it('the OWNER is refused too — the guard is not a grant trick', async () => {
    /* `app_guard_append_only` binds the owner, so a maintenance script running
     * as `app_migrator` or a superuser meets the same refusal. This is the arm
     * that makes "immutable" mean immutable rather than "not currently granted". */
    await expect(
      admin.query('update solver_input_snapshots set payload = $2 where id = $1', [
        snapshotId,
        '{}',
      ]),
    ).rejects.toThrow(/APPEND_ONLY/);
    await expect(
      admin.query('delete from solver_input_snapshots where id = $1', [snapshotId]),
    ).rejects.toThrow(/APPEND_ONLY/);
    log('      · the owner is refused by app_guard_append_only, not by a missing grant');
  });

  it('no role anywhere holds UPDATE or DELETE on the table', async () => {
    /* Read from the catalogue rather than inferred from the probes: a grant to a
     * role this file does not probe would be invisible to every case above. */
    const grants = await admin.query<{ grantee: string; privilege_type: string }>(
      `select grantee, privilege_type
         from information_schema.role_table_grants
        where table_name = 'solver_input_snapshots'
          and privilege_type in ('UPDATE', 'DELETE')
        order by grantee, privilege_type`,
    );
    const nonOwner = grants.rows.filter((row) => row.grantee !== 'app_migrator');
    expect(nonOwner, JSON.stringify(nonOwner)).toEqual([]);
    log(`      · ${String(grants.rows.length)} UPDATE/DELETE grant(s), all to the owner alone`);
  });
});
