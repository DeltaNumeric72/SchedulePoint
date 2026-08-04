import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TENANT_TABLES } from '../../src/db/schema.js';
import { createRuntime, log, outsideUnitOfWork, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { grantStaffingCapabilities } from '../support/staffing.js';

/**
 * Tenant isolation for the four tables this packet adds — reads and writes,
 * across the organization boundary AND the group boundary.
 *
 * The SBX-004 sweep covers these tables generically once they are registered in
 * `TENANT_TABLES` (they are, in the same change as the migration). This file is
 * the packet-local, table-specific version: it plants rows on BOTH sides of each
 * boundary and then probes from each side, so a "zero cross-tenant rows" result
 * cannot come from there being no rows to leak.
 *
 * ## The non-vacuity floor, made explicit
 *
 * Every probe below is preceded by a positive control — the same read from the
 * tenant that OWNS the row, which must return it. A file that only ever asserts
 * "I saw nothing" passes just as well when the fixture is empty, when the query
 * is wrong, and when the table does not exist.
 */

const multi = ownedMulti('profiles-isolation');

let alphaRuntime: Runtime;

const PROFILE_TABLES = [
  'membership_work_profiles',
  'membership_weekday_fte',
  'qualifications',
  'qualification_holdings',
] as const;

interface PlantedRows {
  readonly workProfileId: string;
  readonly weekdayId: string;
  readonly qualificationId: string;
  readonly holdingId: string;
}

/** Plants one row in each of the four tables, in the given organization/group. */
async function plant(
  runtime: Runtime,
  where: {
    organizationId: string;
    groupId: string;
    actorMembershipId: string;
    subjectMembershipId: string;
  },
): Promise<PlantedRows> {
  const ids = {
    workProfileId: randomUUID(),
    weekdayId: randomUUID(),
    qualificationId: randomUUID(),
    holdingId: randomUUID(),
  };

  await runtime.runner.run(
    {
      organizationId: where.organizationId,
      groupId: where.groupId,
      membershipId: where.actorMembershipId,
      correlationId: 'isolation-plant',
    },
    async ({ query }) => {
      await query
        .insertInto('membership_work_profiles')
        .values({
          id: ids.workProfileId,
          organization_id: where.organizationId,
          group_id: where.groupId,
          membership_id: where.subjectMembershipId,
          work_percentage: '90.00',
        })
        .execute();
      await query
        .insertInto('membership_weekday_fte')
        .values({
          id: ids.weekdayId,
          organization_id: where.organizationId,
          group_id: where.groupId,
          work_profile_id: ids.workProfileId,
          day: 'mon',
          fte_fraction: '0.900',
        })
        .execute();
      await query
        .insertInto('qualifications')
        .values({
          id: ids.qualificationId,
          organization_id: where.organizationId,
          group_id: where.groupId,
          key: 'isolation-probe',
          name: 'Isolation Probe',
        })
        .execute();
      await query
        .insertInto('qualification_holdings')
        .values({
          id: ids.holdingId,
          organization_id: where.organizationId,
          group_id: where.groupId,
          membership_id: where.subjectMembershipId,
          qualification_id: ids.qualificationId,
          status: 'valid',
        })
        .execute();
    },
  );

  return ids;
}

/** Alpha group one. */
let alphaOne: PlantedRows;
/** Alpha group TWO — the group boundary. */
let alphaTwo: PlantedRows;
/** Beta group one — the organization boundary. */
let beta: PlantedRows;

beforeAll(async () => {
  alphaRuntime = createRuntime('app_runtime', { max: 6 });
  const fixture = multi();

  /* Alpha group one: the actor is `groupOnly` (its principal holds no other
   * membership, satisfying the grant guard's two-person rule). */
  await grantStaffingCapabilities(alphaRuntime.runner, fixture, {
    organizationId: fixture.alpha.organizationId,
    groupId: fixture.alpha.groupOne.id,
    membershipId: fixture.alpha.users.groupOnly.membershipId,
    capabilities: [
      'staffing.work_profile.administer',
      'staffing.qualification.administer',
      'staffing.qualification_holding.administer',
      'staffing.qualification_holding.read_any',
    ],
  });
  alphaOne = await plant(alphaRuntime, {
    organizationId: fixture.alpha.organizationId,
    groupId: fixture.alpha.groupOne.id,
    actorMembershipId: fixture.alpha.users.groupOnly.membershipId,
    subjectMembershipId: fixture.alpha.users.scheduler.membershipId,
  });

  /* Alpha group TWO. */
  await grantStaffingCapabilities(alphaRuntime.runner, fixture, {
    organizationId: fixture.alpha.organizationId,
    groupId: fixture.alpha.groupTwo.id,
    membershipId: fixture.alpha.users.groupTwoScheduler.membershipId,
    capabilities: [
      'staffing.work_profile.administer',
      'staffing.qualification.administer',
      'staffing.qualification_holding.administer',
      'staffing.qualification_holding.read_any',
    ],
  });
  alphaTwo = await plant(alphaRuntime, {
    organizationId: fixture.alpha.organizationId,
    groupId: fixture.alpha.groupTwo.id,
    actorMembershipId: fixture.alpha.users.groupTwoScheduler.membershipId,
    subjectMembershipId: fixture.alpha.users.scheduler.groupTwoMembershipId,
  });

  /* BETA — the other organization. */
  await grantStaffingCapabilities(alphaRuntime.runner, fixture, {
    organizationId: fixture.beta.organizationId,
    groupId: fixture.beta.groupOne.id,
    membershipId: fixture.beta.users.scheduler.membershipId,
    capabilities: [
      'staffing.work_profile.administer',
      'staffing.qualification.administer',
      'staffing.qualification_holding.administer',
      'staffing.qualification_holding.read_any',
    ],
  });
  beta = await plant(alphaRuntime, {
    organizationId: fixture.beta.organizationId,
    groupId: fixture.beta.groupOne.id,
    actorMembershipId: fixture.beta.users.scheduler.membershipId,
    subjectMembershipId: fixture.beta.users.scheduler.membershipId,
  });
}, 120_000);

afterAll(async () => {
  await alphaRuntime.destroy();
});

/** Counts rows in each of the four tables under one declared context. */
async function countUnder(
  context: { organizationId: string; groupId: string | null; membershipId: string | null },
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of PROFILE_TABLES) {
    // One transaction per table: a genuine refusal on one must not abort the
    // sweep and turn every later table into a false zero (the M2-001 R-04
    // cascade).
    counts[table] = await alphaRuntime.runner.run(
      { ...context, correlationId: `isolation-count-${table}` },
      async ({ query }) => {
        const { rows } = await sql<{ n: number }>`
          select count(*)::int as n from ${sql.raw(table)}
        `.execute(query);
        return Number(rows[0]?.n ?? 0);
      },
    );
  }
  return counts;
}

describe('the four tables are registered as tenant tables', () => {
  it('every one appears in TENANT_TABLES with an organization-and-group scope', () => {
    // Registration is what puts them into every generic probe — the pool
    // cleanliness check, the wrong-tenant probe, the privilege matrix, and
    // SBX-004's non-vacuity assertion. Migration 0003's four tables were left out
    // of this registry and stayed unprobed until OPUS-M1-004 noticed.
    for (const table of PROFILE_TABLES) {
      const entry = TENANT_TABLES.find((candidate) => candidate.name === table);
      expect(entry, `${table} is not registered in TENANT_TABLES`).toBeDefined();
      expect(entry?.scope).toBe('organization-and-group');
    }
  });
});

describe('the ORGANIZATION boundary', () => {
  it('positive control — Beta\'s own context sees Beta\'s rows', async () => {
    const counts = await countUnder({
      organizationId: multi().beta.organizationId,
      groupId: multi().beta.groupOne.id,
      membershipId: multi().beta.users.scheduler.membershipId,
    });
    for (const table of PROFILE_TABLES) {
      expect(counts[table], `${table}: Beta cannot see its own rows`).toBeGreaterThan(0);
    }
    log(`Beta sees its own rows in all four tables: ${JSON.stringify(counts)}`);
  });

  it('an ALPHA context sees ZERO of Beta\'s rows, by row id', async () => {
    // By id rather than by count: a count comparison can be satisfied by
    // coincidence when both tenants happen to hold the same number of rows.
    for (const [table, id] of [
      ['membership_work_profiles', beta.workProfileId],
      ['membership_weekday_fte', beta.weekdayId],
      ['qualifications', beta.qualificationId],
      ['qualification_holdings', beta.holdingId],
    ] as const) {
      const seen = await alphaRuntime.runner.run(
        {
          organizationId: multi().alpha.organizationId,
          groupId: multi().alpha.groupOne.id,
          membershipId: multi().alpha.users.groupOnly.membershipId,
          correlationId: 'cross-org-read',
        },
        async ({ query }) => {
          const { rows } = await sql<{ n: number }>`
            select count(*)::int as n from ${sql.raw(table)} where id = ${id}::uuid
          `.execute(query);
          return Number(rows[0]?.n ?? 0);
        },
      );
      expect(seen, `${table}: an Alpha context read a Beta row`).toBe(0);
    }
    log('cross-organization read: 0 rows in all four tables, probed by row id');
  });

  it('an ALPHA context cannot WRITE a row carrying Beta\'s organization', async () => {
    let refused = false;
    try {
      await alphaRuntime.runner.run(
        {
          organizationId: multi().alpha.organizationId,
          groupId: multi().alpha.groupOne.id,
          membershipId: multi().alpha.users.groupOnly.membershipId,
          correlationId: 'cross-org-write',
        },
        async ({ query }) => {
          await query
            .insertInto('qualifications')
            .values({
              id: randomUUID(),
              organization_id: multi().beta.organizationId,
              group_id: multi().beta.groupOne.id,
              key: 'cross-tenant-attempt',
              name: 'Cross Tenant Attempt',
            })
            .execute();
        },
      );
    } catch {
      refused = true;
    }
    expect(refused, 'an Alpha context wrote a row into Beta').toBe(true);
  });
});

describe('the GROUP boundary', () => {
  it('positive control — group one\'s context sees group one\'s rows', async () => {
    const counts = await countUnder({
      organizationId: multi().alpha.organizationId,
      groupId: multi().alpha.groupOne.id,
      membershipId: multi().alpha.users.groupOnly.membershipId,
    });
    for (const table of PROFILE_TABLES) {
      expect(counts[table], `${table}: group one cannot see its own rows`).toBeGreaterThan(0);
    }
  });

  it('a GROUP ONE context sees zero of group TWO\'s rows', async () => {
    for (const [table, id] of [
      ['membership_work_profiles', alphaTwo.workProfileId],
      ['membership_weekday_fte', alphaTwo.weekdayId],
      ['qualifications', alphaTwo.qualificationId],
      ['qualification_holdings', alphaTwo.holdingId],
    ] as const) {
      const seen = await alphaRuntime.runner.run(
        {
          organizationId: multi().alpha.organizationId,
          groupId: multi().alpha.groupOne.id,
          membershipId: multi().alpha.users.groupOnly.membershipId,
          correlationId: 'cross-group-read',
        },
        async ({ query }) => {
          const { rows } = await sql<{ n: number }>`
            select count(*)::int as n from ${sql.raw(table)} where id = ${id}::uuid
          `.execute(query);
          return Number(rows[0]?.n ?? 0);
        },
      );
      expect(seen, `${table}: a group-one context read a group-two row`).toBe(0);
    }
    log('cross-group read within one organization: 0 rows in all four tables');
  });

  it('a GROUP TWO context sees zero of group ONE\'s rows — the boundary is two-sided', async () => {
    // A one-sided sweep proves half a boundary. This is the other half.
    for (const [table, id] of [
      ['membership_work_profiles', alphaOne.workProfileId],
      ['qualifications', alphaOne.qualificationId],
      ['qualification_holdings', alphaOne.holdingId],
    ] as const) {
      const seen = await alphaRuntime.runner.run(
        {
          organizationId: multi().alpha.organizationId,
          groupId: multi().alpha.groupTwo.id,
          membershipId: multi().alpha.users.groupTwoScheduler.membershipId,
          correlationId: 'cross-group-read-reverse',
        },
        async ({ query }) => {
          const { rows } = await sql<{ n: number }>`
            select count(*)::int as n from ${sql.raw(table)} where id = ${id}::uuid
          `.execute(query);
          return Number(rows[0]?.n ?? 0);
        },
      );
      expect(seen, `${table}: a group-two context read a group-one row`).toBe(0);
    }
  });
});

describe('no statement reaches these tables outside a unit of work (I-15)', () => {
  it('a read with NO transaction-local context returns zero rows from every table', async () => {
    // The T-13 fail-closed probe, applied to this packet's tables. `current_setting`
    // with the missing-ok flag returns NULL, `nullif(...)::uuid` is NULL, and every
    // policy predicate is therefore false — so the answer is zero rows rather than
    // an error, which is the fail-CLOSED direction.
    for (const table of PROFILE_TABLES) {
      const result = await outsideUnitOfWork<{ n: string }>(
        alphaRuntime,
        `select count(*)::text as n from ${table}`,
      );
      expect(Number(result.rows[0]?.n), `${table} was readable with no tenant context`).toBe(0);
    }
    log('with no tenant context all four tables return zero rows — fail closed, not fail open');
  });
});
