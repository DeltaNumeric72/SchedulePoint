import { sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TENANT_TABLES } from '../../src/db/schema.js';
import { adminClient } from '../support/admin-client.js';
import { groupContext } from '../support/fixtures.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * **The mutation test for the cross-tenant sweep** — S-01's other half.
 *
 * ## Why this file exists
 *
 * An independent review found that `cross-tenant-sweep.test.ts` could not fail.
 * The fixture seeded one group per organization, so the cross-GROUP arm was
 * measuring an empty table, and the reviewer proved it by applying a CAR-001
 * class mutation — **drop the `group_id` clause from every catalogue policy,
 * keep the `organization_id` clause** — and watching all six tests stay green.
 *
 * Seeding a sibling group fixes the sweep. It does not, on its own, prove the
 * sweep is now falsifiable — that is a claim about a mutation nobody has run.
 * So this file runs **the reviewer's exact mutation** and asserts the sweep's
 * own oracle now reports a violation.
 *
 * ## Rolled back, always
 *
 * The mutation runs inside a transaction that is **always** rolled back, on a
 * dedicated `app_migrator` client. The policies are read back from `pg_policies`
 * afterwards, from a fresh connection, and asserted to be intact — a red case
 * that leaves the schema damaged is worse than no red case, and "we rolled back"
 * is a claim worth checking rather than asserting.
 *
 * This is the same shape as OPUS-M2-001's "RED: with FORCE RLS off inside a
 * rolled-back transaction, the sweep sees foreign rows".
 */

const multi = ownedMulti('catalogue-sweep-mutation', { seed: { catalogue: ['alpha'] } });

const CATALOGUE_TABLES = TENANT_TABLES.filter((table) =>
  [
    'shift_types',
    'shift_type_weekday_demand',
    'shift_groups',
    'shift_group_members',
    'staff_groups',
    'staff_group_members',
    'valid_groups',
    'valid_group_shift_types',
    'group_holidays',
  ].includes(table.name),
);

let admin: pg.Client;
let runtime: Runtime;

const alpha = () => multi().alpha;

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  runtime = createRuntime('app_runtime', { max: 3 });
}, 180_000);

afterAll(async () => {
  await runtime.destroy();
  await admin.end();
});

/** The sweep's own oracle: wrong-organization and wrong-group counts per table. */
async function measure(
  query: Parameters<Parameters<Runtime['runner']['run']>[1]>[0]['query'],
  expected: { organizationId: string; groupId: string },
): Promise<{ table: string; visible: number; wrongGroup: number }[]> {
  const readings: { table: string; visible: number; wrongGroup: number }[] = [];
  for (const table of CATALOGUE_TABLES) {
    const { rows } = await sql<{ visible: number; wrong_group: number }>`
      select count(*)::int as visible,
             count(*) filter (
               where group_id is distinct from ${expected.groupId}::uuid
             )::int as wrong_group
        from ${sql.raw(table.name)}
    `.execute(query);
    readings.push({
      table: table.name,
      visible: Number(rows[0]?.visible ?? 0),
      wrongGroup: Number(rows[0]?.wrong_group ?? 0),
    });
  }
  return readings;
}

describe('the cross-group arm of the sweep can be made to fail', () => {
  it('GREEN: unmutated, Alpha Group One sees zero rows from its sibling group', async () => {
    const readings = await runtime.runner.run(
      groupContext(
        alpha().organizationId,
        alpha().groupOne.id,
        alpha().users.scheduler.membershipId,
        'sweep-mutation-green',
      ),
      (uow) =>
        measure(uow.query, {
          organizationId: alpha().organizationId,
          groupId: alpha().groupOne.id,
        }),
    );
    expect(readings.filter((reading) => reading.wrongGroup > 0)).toEqual([]);
    expect(readings.filter((reading) => reading.visible === 0)).toEqual([]);
    log('GREEN: 0 wrong-group on all nine tables, every table non-vacuous');
  });

  it("RED: with the group clause dropped from every policy, the sweep reports wrong-group rows", async () => {
    /* The reviewer's mutation, verbatim in effect: each catalogue policy is
     * replaced by one that checks ONLY the organization. That is the CAR-001
     * defect — the wrong group inside the right organization — and it is the
     * one an organization-only predicate cannot see. */
    const migrator = createRuntime('app_migrator', { max: 1 });
    const client = await migrator.pool.connect();
    const sawWrongGroup = new Map<string, number>();

    try {
      await client.query('BEGIN');
      for (const table of CATALOGUE_TABLES) {
        // Identifiers come from `TENANT_TABLES`, the closed registry, and are
        // interpolated because an identifier cannot be a bind parameter.
        await client.query(`DROP POLICY ${table.name}_group_scope ON ${table.name}`);
        await client.query(
          `CREATE POLICY ${table.name}_group_scope ON ${table.name} FOR ALL
             USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
             WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)`,
        );
      }

      // Measured on the SAME connection, inside the same transaction, under
      // Alpha Group One's declared context.
      await client.query(
        `select set_config('app.organization_id', $1, true),
                set_config('app.group_id', $2, true),
                set_config('app.membership_id', $3, true),
                set_config('app.correlation_id', 'sweep-mutation-red', true)`,
        [alpha().organizationId, alpha().groupOne.id, alpha().users.scheduler.membershipId],
      );

      for (const table of CATALOGUE_TABLES) {
        const result = await client.query<{ wrong_group: number }>(
          `select count(*) filter (where group_id is distinct from $1::uuid)::int as wrong_group
             from ${table.name}`,
          [alpha().groupOne.id],
        );
        sawWrongGroup.set(table.name, result.rows[0]?.wrong_group ?? 0);
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await migrator.destroy();
    }

    // EVERY table must report a violation. One table reporting it would mean the
    // other eight are still unfalsifiable, which is the finding rather than the
    // fix.
    for (const table of CATALOGUE_TABLES) {
      expect(
        sawWrongGroup.get(table.name) ?? 0,
        `${table.name}: the mutated policy exposed no sibling-group rows, so the sweep's ` +
          'cross-group arm is still incapable of failing on this table',
      ).toBeGreaterThan(0);
    }
    log(
      'RED (group clause dropped, organization clause kept): ' +
        CATALOGUE_TABLES.map((t) => `${t.name}=${String(sawWrongGroup.get(t.name) ?? 0)}`).join(' ') +
        ' — the sweep would fail, as it must',
    );
  });

  it('the rollback restored every policy — verified from a FRESH connection', async () => {
    // "We rolled back" is a claim. This is the check.
    const result = await admin.query<{ tablename: string; qual: string | null }>(
      `select tablename, qual from pg_policies where tablename = any($1::text[])`,
      [CATALOGUE_TABLES.map((table) => table.name)],
    );
    expect(result.rows.length).toBe(CATALOGUE_TABLES.length);
    for (const row of result.rows) {
      expect(
        row.qual ?? '',
        `${row.tablename}: the group clause did not come back after the rollback`,
      ).toContain('app.group_id');
    }
    log(`${String(result.rows.length)} catalogue policies intact after the rolled-back mutation`);
  });

  it('the seeded sibling group is what makes all of the above measurable', () => {
    // Named explicitly so the dependency is visible: remove the sibling seeding
    // and the RED case above goes green, which is the original defect.
    expect(multi.catalogue().sibling.shiftTypeIds.length).toBeGreaterThan(0);
    expect(multi.catalogue().sibling.holidaySeeded).toBe(true);
    expect(multi.catalogue().sibling.groupId).not.toBe(alpha().groupOne.id);
  });
});
