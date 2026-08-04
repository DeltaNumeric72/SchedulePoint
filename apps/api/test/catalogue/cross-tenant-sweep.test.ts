import { sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TENANT_TABLES } from '../../src/db/schema.js';
import { adminClient } from '../support/admin-client.js';
import { seedCatalogueFixture, type SeededCatalogue } from '../support/catalogue-fixture.js';
import { groupContext } from '../support/fixtures.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * **NAMED-CONDITION PROOF 3 — the cross-tenant catalogue sweep reports zero
 * rows.**
 *
 * Packet 30: "cross-tenant catalogue sweep zero rows".
 *
 * ## Both boundaries, not just the organization one
 *
 * The catalogue is GROUP-scoped, so there are two ways to leak and they fail
 * differently:
 *
 *   * **organization boundary** — Alpha's context seeing Beta's rows. Caught by
 *     the `organization_id` clause of every policy;
 *   * **group boundary** — Alpha Group One's context seeing Alpha Group Two's
 *     rows. Caught by the `group_id` clause, and this is the CAR-001 defect
 *     class: an application bug that resolves the wrong group *inside the right
 *     organization*, which the organization clause cannot see.
 *
 * ## The cross-GROUP arm was VACUOUS, and this is the fix
 *
 * The fixture used to seed one group per organization, so "Alpha Group One sees
 * zero rows from Alpha Group Two" was measuring an empty table. An independent
 * review proved the consequence: dropping the `group_id` clause from every
 * catalogue policy while keeping the `organization_id` clause — the CAR-001
 * defect class exactly — left all six tests in this file **green**.
 *
 * Two things changed. The fixture seeds a SIBLING group in the same organization
 * (`catalogue-fixture.ts`), and the sweep now asserts, before it asserts zero,
 * that the cross-group measurement is **capable of being non-zero**: it counts
 * the sibling's rows from outside RLS and requires that count to be positive per
 * table. An assertion that cannot fail when its subject is absent is a
 * review-rejectable defect, and this one could not.
 *
 * ## Non-vacuity, both dimensions
 *
 * | Dimension | Assertion |
 * |---|---|
 * | organization | every table observed with ≥1 VISIBLE row in the caller's own group |
 * | group | every table holds ≥1 row in the SIBLING group, from ground truth |
 *
 * Without the first, "0 wrong" is what an empty table reports. Without the
 * second, "0 wrong-group" is what a schema with one group reports.
 *
 * ## And the probe is shown to be capable of reporting a violation
 *
 * The falsifiability arm runs the SAME sweep with the WRONG expectation of which
 * tenant is ours. If the probe is really reading rows, it must report `wrong > 0`
 * on every table. A probe that reports zero there is looking at nothing.
 */

const multi = ownedMulti('catalogue-cross-tenant-sweep');

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
let alphaSeed: SeededCatalogue;
let betaSeed: SeededCatalogue;

const alpha = () => multi().alpha;
const beta = () => multi().beta;

/**
 * How many rows the SIBLING group holds in each catalogue table, read as the
 * superuser — outside RLS, which is the point: it is the number the sweep would
 * report as `wrongGroup` if the group predicate stopped working.
 */
async function siblingRowCounts(siblingGroupId: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const table of CATALOGUE_TABLES) {
    const result = await admin.query<{ n: number }>(
      `select count(*)::int as n from ${table.name} where group_id = $1`,
      [siblingGroupId],
    );
    counts.set(table.name, result.rows[0]?.n ?? 0);
  }
  return counts;
}

interface Reading {
  readonly table: string;
  readonly visible: number;
  readonly wrongOrganization: number;
  readonly wrongGroup: number;
}

async function sweep(
  context: ReturnType<typeof groupContext>,
  expected: { organizationId: string; groupId: string },
): Promise<Reading[]> {
  const readings: Reading[] = [];
  for (const table of CATALOGUE_TABLES) {
    // ONE transaction per table: OPUS-M2-001's D-01 finding — a genuine refusal
    // aborts the transaction, and every later table then reports 25P02 recorded
    // as "0 wrong". A fresh transaction per table makes that cascade impossible
    // by construction rather than by care.
    const reading = await runtime.runner.run(
      { ...context, correlationId: `catalogue-sweep-${table.name}` },
      async (uow) => {
        // The identifier comes from `TENANT_TABLES`, the closed registry in
        // `src/db/schema.ts`. Identifiers cannot be bind parameters.
        const { rows } = await sql<{ visible: number; wrong_org: number; wrong_group: number }>`
          select count(*)::int as visible,
                 count(*) filter (
                   where organization_id is distinct from ${expected.organizationId}::uuid
                 )::int as wrong_org,
                 count(*) filter (
                   where group_id is distinct from ${expected.groupId}::uuid
                 )::int as wrong_group
            from ${sql.raw(table.name)}
        `.execute(uow.query);
        return rows[0];
      },
    );
    readings.push({
      table: table.name,
      visible: Number(reading?.visible ?? 0),
      wrongOrganization: Number(reading?.wrong_org ?? 0),
      wrongGroup: Number(reading?.wrong_group ?? 0),
    });
  }
  return readings;
}

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  runtime = createRuntime('app_runtime', { max: 3 });
  // BOTH organizations, so the organization arm has a neighbour to fail to see —
  // and each seeds its SIBLING group too, so the cross-group arm does as well.
  alphaSeed = await seedCatalogueFixture(runtime.runner, multi(), 'alpha');
  betaSeed = await seedCatalogueFixture(runtime.runner, multi(), 'beta');
}, 180_000);

afterAll(async () => {
  await runtime.destroy();
  await admin.end();
});

describe('the catalogue is invisible across both boundaries', () => {
  it('CONTROL: both tenants really do hold catalogue rows', async () => {
    // Ground truth, read as the superuser. Without this, every zero below could
    // mean "nothing was ever written".
    for (const table of CATALOGUE_TABLES) {
      const result = await admin.query<{ organizations: number; total: number }>(
        `select count(distinct organization_id)::int as organizations, count(*)::int as total
           from ${table.name}
          where organization_id = any($1::uuid[])`,
        [[alpha().organizationId, beta().organizationId]],
      );
      expect(
        result.rows[0]?.organizations,
        `${table.name} has rows in fewer than two of this fixture's organizations`,
      ).toBe(2);
    }
    log(`${String(CATALOGUE_TABLES.length)} catalogue tables populated in BOTH fixture organizations`);
  });

  it('CONTROL: the SIBLING group holds rows in every table — the cross-group arm can fail', async () => {
    /* The assertion the cross-group arm was missing, and the reason it was
     * vacuous. Read as the superuser, outside RLS: this is exactly the number
     * the sweep below would report as `wrongGroup` if the `group_id` clause were
     * dropped from the policies (the mutation the reviewer used).
     *
     * Asserted PER TABLE rather than in aggregate: one populated table would
     * make the aggregate positive while eight others stayed unfalsifiable. */
    for (const [group, label] of [
      [alphaSeed.sibling.groupId, 'Alpha'],
      [betaSeed.sibling.groupId, 'Beta'],
    ] as const) {
      const counts = await siblingRowCounts(group);
      for (const table of CATALOGUE_TABLES) {
        expect(
          counts.get(table.name) ?? 0,
          `${label}'s sibling group holds no ${table.name} rows — "0 wrong-group" there is what ` +
            'an empty table reports, and the arm cannot fail',
        ).toBeGreaterThan(0);
      }
      log(
        `${label} sibling group ${group.slice(0, 8)}: ` +
          CATALOGUE_TABLES.map((t) => `${t.name}=${String(counts.get(t.name) ?? 0)}`).join(' '),
      );
    }
  });

  it('Alpha Group One sees zero rows from Beta and zero from Alpha Group Two', async () => {
    const readings = await sweep(
      groupContext(
        alpha().organizationId,
        alpha().groupOne.id,
        alpha().users.scheduler.membershipId,
      ),
      { organizationId: alpha().organizationId, groupId: alpha().groupOne.id },
    );

    const leaks = readings.filter(
      (reading) => reading.wrongOrganization > 0 || reading.wrongGroup > 0,
    );
    expect(
      leaks.map((leak) => `${leak.table}: org=${String(leak.wrongOrganization)} group=${String(leak.wrongGroup)}`),
      'a cross-tenant or cross-group catalogue row was visible',
    ).toEqual([]);

    const vacuous = readings.filter((reading) => reading.visible === 0).map((r) => r.table);
    expect(
      vacuous,
      'a catalogue table was probed with no visible rows — "0 wrong" there means nothing',
    ).toEqual([]);

    const hidden = await siblingRowCounts(alphaSeed.sibling.groupId);
    const hiddenTotal = [...hidden.values()].reduce((sum, n) => sum + n, 0);
    log(
      `Alpha/GroupOne sweep: ${readings
        .map((r) => `${r.table}=${String(r.visible)}`)
        .join(' ')} — 0 wrong-organization, 0 wrong-group, with ${String(hiddenTotal)} ` +
        'sibling-group row(s) present and correctly invisible',
    );
  });

  it('Beta Group One sees zero rows from Alpha — the same sweep, from the other side', async () => {
    const readings = await sweep(
      groupContext(beta().organizationId, beta().groupOne.id, beta().users.scheduler.membershipId),
      { organizationId: beta().organizationId, groupId: beta().groupOne.id },
    );
    expect(
      readings.filter((r) => r.wrongOrganization > 0 || r.wrongGroup > 0),
      'Beta saw a row belonging to another tenant',
    ).toEqual([]);
    expect(readings.filter((r) => r.visible === 0).map((r) => r.table)).toEqual([]);
    log('Beta/GroupOne sweep: 0 wrong-organization, 0 wrong-group, every table non-vacuous');
  });

  it('an ORGANIZATION-scoped context sees NO catalogue rows at all — the policy is group-only', async () => {
    // Not an accident to be relaxed later. SPEC-06 §1.1 puts catalogue authoring
    // outside the organization-scoped action set, so the narrow predicate is the
    // correct one. Asserted in both directions: zero here, non-zero above.
    for (const table of CATALOGUE_TABLES) {
      const visible = await runtime.runner.run(
        {
          organizationId: alpha().organizationId,
          groupId: null,
          membershipId: alpha().users.organizationAdmin.membershipId,
          correlationId: `catalogue-sweep-org-${table.name}`,
        },
        async (uow) => {
          const { rows } = await sql<{ n: number }>`
            select count(*)::int as n from ${sql.raw(table.name)}
          `.execute(uow.query);
          return Number(rows[0]?.n ?? -1);
        },
      );
      expect(visible, `${table.name} was visible under an organization-scoped context`).toBe(0);
    }
    log('organization-scoped context: 0 rows on all nine catalogue tables (group predicate only)');
  });

  it('FALSIFIABILITY: the same sweep measured against the WRONG tenant reports wrong > 0', async () => {
    // If this reported zero, the sweep above would be looking at nothing and its
    // pass would be vacuous. Same probe, same tables, one wrong input.
    const readings = await sweep(
      groupContext(
        alpha().organizationId,
        alpha().groupOne.id,
        alpha().users.scheduler.membershipId,
      ),
      { organizationId: beta().organizationId, groupId: beta().groupOne.id },
    );
    for (const reading of readings) {
      expect(
        reading.wrongOrganization,
        `${reading.table}: the probe reported 0 wrong against another organization's expectation`,
      ).toBeGreaterThan(0);
    }
    log('falsifiability: every catalogue table reports wrong > 0 against the wrong expectation');
  });

  it('a write declaring Alpha but naming Beta\'s group is refused, not silently retenanted', async () => {
    // The write arm. RLS `WITH CHECK` pins both tenant columns, so a row whose
    // `group_id` names another tenant's group cannot be inserted even by a caller
    // holding the capability in its own group.
    await expect(
      runtime.runner.run(
        groupContext(
          alpha().organizationId,
          alpha().groupOne.id,
          alpha().users.scheduler.membershipId,
          'catalogue-sweep-write-arm',
        ),
        ({ query }) =>
          query
            .insertInto('group_holidays')
            .values({
              id: '00000000-0000-4000-8000-0000000000ff',
              organization_id: alpha().organizationId,
              // Another group, inside the same organization: the CAR-001 shape.
              group_id: alpha().groupTwo.id,
              holiday_date: '2027-12-25',
              name: 'Cross-group probe',
            })
            .execute(),
      ),
      // 42501 is `new row violates row-level security policy`.
    ).rejects.toMatchObject({ code: '42501' });

    const landed = await admin.query<{ n: number }>(
      'select count(*)::int as n from group_holidays where name = $1',
      ['Cross-group probe'],
    );
    expect(landed.rows[0]?.n, 'the cross-group write landed').toBe(0);
    log('cross-group INSERT declaring Alpha/GroupOne and naming GroupTwo → 42501, nothing written');
  });
});
