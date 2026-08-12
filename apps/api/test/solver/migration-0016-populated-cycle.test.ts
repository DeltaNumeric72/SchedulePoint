import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate } from '../../src/db/migrate.js';
import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import { digestRows } from '../../src/schedule/render.js';
import { assembleCanonicalInput } from '../../src/solver/canonical-input.js';
import { persistCanonicalInput } from '../../src/solver/snapshot-store.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { fixtureInstant } from '../support/schedule.js';
import { seedSolverFixture, type SolverFixture } from '../support/solver.js';

/**
 * **Migration 0016, up → down → up, over a POPULATED database** (OPUS-M4-001;
 * doc 35 §6a Acceptance, "migration 0016 cycle clean (by-name assertions)").
 *
 * ## Why the standing cycle is not enough
 *
 * `globalSetup` runs the whole stack up → down → up before every test run, on an
 * EMPTY database. That proves the SQL is executable in both directions; it does
 * not prove that reversing 0016 over real rows leaves the rest of the schema
 * intact, nor that a snapshot's composite foreign keys survive the round trip.
 *
 * ## BY NAME, never by position — the composed-battery lesson
 *
 * Doc 35 §6a binding constraint 5 is explicit: *"the populated-cycle test asserts
 * by NAME never position"*. The 0014 cycle test was authored with `count: 1`
 * because 0014 was then the last migration on disk; when 0015 landed above it,
 * `count: 1` reversed the WRONG migration, the assertion threw before step 3
 * re-applied anything, and **four downstream test files met a schema without
 * 0015**. One positional assumption, four failures a long way from their cause.
 *
 * So this file rolls down ONE MIGRATION AT A TIME until 0016 has come down —
 * the loop's termination condition IS the name, so there is no count to go
 * stale — and the re-up sits in a `finally`, so an assertion failing between the
 * two can never leave the schema short for the rest of the run. That second half
 * is the property that was actually missing: the wrong count was only how it got
 * triggered. `schedule/migration-0014-populated-cycle.test.ts` now uses the same
 * idiom, having been bitten by the positional form twice.
 *
 * ## Mutation control (FAD-15)
 *
 * The final case proves the constraints are ENFORCING again after the cycle —
 * a snapshot with a hash that is not a sha-256 is refused. Without it, a down
 * migration that dropped a constraint and an up migration that forgot to restore
 * it would leave every census digest identical and the file green.
 */

const multi = ownedMulti('solver-migration-0016-cycle', {
  profile: 'core',
  seed: { catalogue: ['alpha'], scheduleCredentials: true },
});

let runtime: Runtime;
let context: { organizationId: string; groupId: string; membershipId: string; correlationId: string };
let fixture: SolverFixture;

const run = async <T>(fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> =>
  runtime.runner.run(context, fn);

/** The tables the cycle must leave untouched, and the columns that must survive. */
const CENSUS: readonly { table: string; columns: readonly string[] }[] = [
  { table: 'schedule_periods', columns: ['id', 'name', 'start_date', 'end_date', 'status'] },
  { table: 'schedule_versions', columns: ['id', 'period_id', 'state', 'timezone_basis'] },
  { table: 'schedule_requirements', columns: ['id', 'period_id', 'date', 'required_count'] },
  { table: 'rules', columns: ['id', 'rule_key', 'version', 'status'] },
];

async function census(): Promise<Record<string, { count: number; digest: string }>> {
  const result: Record<string, { count: number; digest: string }> = {};
  for (const entry of CENSUS) {
    const rows = (await run(async (uow) =>
      uow.query
        .selectFrom(entry.table as never)
        .select(entry.columns as never)
        .execute(),
    )) as unknown as Record<string, unknown>[];
    result[entry.table] = { count: rows.length, digest: digestRows(rows) };
  }
  return result;
}

beforeAll(async () => {
  runtime = createRuntime('app_runtime', { max: 4 });
  const alpha = multi().alpha;
  const shiftTypeId = multi.catalogue('alpha').shiftTypeIds[1];
  if (shiftTypeId === undefined) throw new Error('no shift type');

  context = {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    membershipId: alpha.users.scheduler.membershipId,
    correlationId: 'solver-migration-0016-cycle',
  };

  fixture = await seedSolverFixture(runtime.runner, {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    actorMembershipId: alpha.users.scheduler.membershipId,
    actorUserId: alpha.users.scheduler.id,
    shiftTypeId,
    startDate: '2038-02-01',
    endDate: '2038-02-07',
    requiredCount: 1,
  });
}, 180_000);

afterAll(async () => {
  await runtime?.destroy();
});

async function persistOne(label: string): Promise<{ id: string; hash: string }> {
  const persisted = await run(async (uow) => {
    const assembled = await assembleCanonicalInput(uow, {
      periodId: fixture.periodId,
      versionId: fixture.versionId,
      at: fixtureInstant('2038-02-01', 12),
    });
    return persistCanonicalInput(uow, {
      document: assembled.document,
      constituents: assembled.constituents,
      idempotencyKey: `${label}-${randomUUID()}`,
    });
  });
  return { id: persisted.snapshotId, hash: persisted.canonicalInputHash };
}

describe('migration 0016 over a populated database', () => {
  it('up → down → up, resolved and asserted BY NAME', async () => {
    /* ── 1. Populate, through the production path ───────────────────────────
     * A cycle proven over an empty table proves nothing about a migration whose
     * whole content is one table and its constraints. */
    const before = await persistOne('cycle-before');
    const censusBefore = await census();
    const snapshotsBefore = await run(
      async ({ query }) =>
        await sql<{ n: string }>`SELECT count(*)::text AS n FROM solver_input_snapshots`.execute(
          query,
        ),
    );
    expect(Number(snapshotsBefore.rows[0]?.n)).toBeGreaterThan(0);

    /* ── 2. DOWN to a NAMED TARGET, and back UP unconditionally ──────────────
     *
     * One migration at a time until 0016 has come down, so **the loop's
     * termination condition is the name**. There is no count to go stale and no
     * position to assume: whatever lands above 0016 next is reversed on the way
     * past, and this file stays correct without being edited.
     *
     * The same idiom now governs `schedule/migration-0014-populated-cycle.ts`,
     * and it is there because the positional form failed twice — `count: 1` when
     * 0015 landed, then `count: 2` when THIS packet's 0016 landed, reversing
     * 0016+0015 and never touching 0014. Both times the assertion threw between
     * the down and the up, so the schema stayed short for the rest of the run
     * and the real failure surfaced nine files later as
     * `column "operation_type" does not exist`.
     *
     * Hence the `finally`: the re-up is unconditional, so a failure anywhere in
     * this cycle costs one failing test rather than a run-wide cascade. That is
     * the property that was actually missing — the wrong count was only how it
     * got triggered. */
    let up: readonly string[] = [];
    let midway: Record<string, { count: number; digest: string }> | undefined;
    const down: string[] = [];
    try {

    /* **The loop runs INSIDE the try, and that placement is the whole point.**
     *
     * The first repair moved the down-step from a positional `count` to a named
     * target and put the re-up in a `finally` — but left the loop's own
     * "ran out of migrations" `throw` OUTSIDE that try. So the one failure mode
     * the loop introduces was the one the `finally` did not cover: a target that
     * never comes down aborts with migrations already reversed and never
     * re-applied, which is the exact cluster-poisoning signature the repair
     * claimed to close. The independent review proved it by mutating the target
     * to `/0099/`.
     *
     * Everything between the first `migrate('down')` and the re-up is therefore
     * inside the try, and `down.length` is read in the `finally` — so however
     * far the loop got, exactly that many migrations go back up. */
      while (!down.some((name) => name.includes('0016'))) {
        const step = await migrate('down', { count: 1 });
        if (step.applied.length === 0) {
          throw new Error('ran out of migrations before reaching 0016 — the ledger is empty');
        }
        down.push(...step.applied);
      }
      expect(
        down.some((name) => name.includes('0016')),
        '0016 must be among the reversed migrations',
      ).toBe(true);

      /* The table is gone. Everything else is still here — the moment a cascade
       * or a rewrite would already have destroyed it. */
      midway = await census();
    } finally {
      up = (await migrate('up', { count: down.length })).applied;
    }

    for (const entry of CENSUS) {
      expect(midway?.[entry.table]?.count, `${entry.table} after down`).toBe(
        censusBefore[entry.table]?.count,
      );
      expect(midway?.[entry.table]?.digest, `${entry.table} content after down`).toBe(
        censusBefore[entry.table]?.digest,
      );
    }

    expect(up).toHaveLength(down.length);
    expect(
      up.some((name) => name.includes('0016')),
      '0016 must be among the re-applied migrations',
    ).toBe(true);

    /* ── 4. Everything 0016 did NOT touch is byte-identical ────────────────── */
    const after = await census();
    for (const entry of CENSUS) {
      expect(after[entry.table]?.count, `${entry.table} row count`).toBe(
        censusBefore[entry.table]?.count,
      );
      expect(after[entry.table]?.digest, `${entry.table} content digest`).toBe(
        censusBefore[entry.table]?.digest,
      );
    }

    /* ── 5. The NAMED exception, asserted rather than glossed ───────────────
     * `solver_input_snapshots` is a table 0016 CREATES, and its down migration
     * drops it. A dropped table takes its rows with it. Saying so is the point:
     * a cycle report claiming "all data preserved" while silently emptying a
     * table would be the kind of claim this repository treats as worse than a
     * failure. */
    const survivors = await run(
      async ({ query }) =>
        await sql<{ n: string }>`
          SELECT count(*)::text AS n FROM solver_input_snapshots WHERE id = ${before.id}
        `.execute(query),
    );
    expect(
      survivors.rows[0]?.n,
      'the down migration DROPS this table, so its rows do not survive — stated, not hidden',
    ).toBe('0');
    log('      · snapshots do not survive the drop, and that is what dropping a table means');

    /* ── 6. The constraints are back, and ENFORCING ─────────────────────────
     * The mutation control. A down that dropped a constraint and an up that
     * forgot to restore it would leave every digest above identical. */
    const restored = await persistOne('cycle-after');
    expect(restored.hash).toMatch(/^[0-9a-f]{64}$/);

    await expect(
      run(async ({ query }) =>
        sql`
          INSERT INTO solver_input_snapshots (
            organization_id, group_id, period_id, version_id,
            snapshot_schema_version, compiler_version, rule_schema_version,
            canonical_input_hash, payload, constituents,
            timezone_basis, tzdb_version, start_date, end_date,
            idempotency_key, semantic_request_digest
          ) VALUES (
            ${context.organizationId}, ${context.groupId}, ${fixture.periodId}, ${fixture.versionId},
            1, 1, 1,
            'not-a-sha-256',
            '{}'::jsonb, '[]'::jsonb,
            'UTC', 'unknown', ${fixture.startDate}::date, ${fixture.endDate}::date,
            ${`bad-hash-${randomUUID()}`}, ${'0'.repeat(64)}
          )
        `.execute(query),
      ),
      'the hash shape CHECK must be enforcing again after the cycle',
    ).rejects.toThrow();

    await expect(
      run(async ({ query }) =>
        sql`
          UPDATE solver_input_snapshots SET canonical_input_hash = ${'0'.repeat(64)}
           WHERE id = ${restored.id}
        `.execute(query),
      ),
      'the append-only guard must be attached again after the cycle',
    ).rejects.toThrow();
    log('      · MUTATION CONTROL: hash CHECK and append-only guard both enforcing after the cycle');
  }, 180_000);
});
