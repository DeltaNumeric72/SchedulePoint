import { CompiledQuery } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TENANT_TABLES } from '../../src/db/schema.js';
import { adminClient } from '../support/admin-client.js';
import { FIXTURE, groupContext } from '../support/fixtures.js';
import {
  createRuntime,
  expectedVisibleUserIds,
  impossibleCensusRows,
  log,
  tenantRowCensus,
  wrongTenantProbe,
  type ProbeResult,
  type Runtime,
} from '../support/harness.js';

/**
 * **Red case: the wrong-tenant probe must be able to fail.**
 *
 * T-15's headline claim is "zero wrong-tenant rows". That claim is worth exactly
 * as much as the probe's ability to report a non-zero number — a probe with a
 * broken predicate, a wrong column, or an empty table reports `wrong = 0`
 * forever and the storm passes for the most boring possible reason.
 *
 * So this file deliberately mis-declares the expectation and asserts that the
 * probe **notices**. It is the mirror image of the storm: same probe, same
 * tables, same fixture, one wrong input.
 *
 * The census gets the same treatment, for the same reason.
 */

let admin: pg.Client;
let runtime: Runtime;

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  runtime = createRuntime('app_runtime', { max: 2 });
});

afterAll(async () => {
  await runtime.destroy();
  await admin.end();
});

describe('the wrong-tenant probe reports a violation when one is expected', () => {
  it('RED: probing Group One\'s rows against Group Two\'s expectation reports wrong > 0', async () => {
    // The unit of work is genuinely Group One's; the probe is handed Group Two's
    // coordinates. Every visible row is now "wrong", and the probe must say so
    // on every table that carries a group.
    const realContext = groupContext(
      FIXTURE.alpha.organizationId,
      FIXTURE.alpha.groupOne.id,
      FIXTURE.alpha.users.scheduler.membershipId,
    );
    const misdeclared = groupContext(
      FIXTURE.alpha.organizationId,
      FIXTURE.alpha.groupTwo.id,
      FIXTURE.alpha.users.scheduler.membershipId,
    );
    const wrongUserExpectation = await expectedVisibleUserIds(admin, misdeclared);

    const reported = new Map<string, number>();
    await runtime.runner.run(realContext, async ({ query }) => {
      for (const table of TENANT_TABLES) {
        const probe = wrongTenantProbe(table, misdeclared, wrongUserExpectation);
        const result = (await query.executeQuery(
          CompiledQuery.raw(probe.text, probe.values),
        )) as unknown as { rows: ProbeResult[] };
        reported.set(table.name, result.rows[0]?.wrong ?? 0);
      }
    });

    log(`probe against a deliberately wrong expectation: ${JSON.stringify([...reported])}`);

    // `groups` and `memberships` carry a group, so every visible row is wrong.
    expect(reported.get('groups'), 'the groups probe did not notice').toBeGreaterThan(0);
    expect(reported.get('memberships'), 'the memberships probe did not notice').toBeGreaterThan(0);
    // `users` is reachable through membership, and Group One's members are not
    // Group Two's, so the expectation set differs and the probe must notice.
    expect(reported.get('users'), 'the users probe did not notice').toBeGreaterThan(0);
    // `organizations` is keyed by the organization, which is the SAME in both
    // contexts — so it correctly reports zero. Asserted explicitly so that a
    // future change making it report non-zero is caught rather than welcomed.
    expect(reported.get('organizations')).toBe(0);
  });

  it('RED: probing Alpha\'s rows against Beta\'s expectation reports wrong > 0 on every table', async () => {
    const realContext = groupContext(
      FIXTURE.alpha.organizationId,
      FIXTURE.alpha.groupOne.id,
      FIXTURE.alpha.users.scheduler.membershipId,
    );
    const otherOrganization = groupContext(
      FIXTURE.beta.organizationId,
      FIXTURE.beta.groupOne.id,
      FIXTURE.beta.users.scheduler.membershipId,
    );
    const wrongUserExpectation = await expectedVisibleUserIds(admin, otherOrganization);

    await runtime.runner.run(realContext, async ({ query }) => {
      for (const table of TENANT_TABLES) {
        const probe = wrongTenantProbe(table, otherOrganization, wrongUserExpectation);
        const result = (await query.executeQuery(
          CompiledQuery.raw(probe.text, probe.values),
        )) as unknown as { rows: ProbeResult[] };
        expect(
          result.rows[0]?.wrong ?? 0,
          `${table.name}: the probe reported 0 wrong rows against another organization's expectation`,
        ).toBeGreaterThan(0);
      }
    });
    log('every tenant table reports wrong > 0 when probed against the other organization');
  });

  it('GREEN: the same probe reports zero against the CORRECT expectation', () => {
    // Both directions, in one file. A probe that always reported a violation
    // would satisfy the red cases above and be equally useless.
    return runtime.runner.run(
      groupContext(
        FIXTURE.alpha.organizationId,
        FIXTURE.alpha.groupOne.id,
        FIXTURE.alpha.users.scheduler.membershipId,
      ),
      async ({ query, context }) => {
        const expected = await expectedVisibleUserIds(admin, context);
        for (const table of TENANT_TABLES) {
          const probe = wrongTenantProbe(table, context, expected);
          const result = (await query.executeQuery(
            CompiledQuery.raw(probe.text, probe.values),
          )) as unknown as { rows: ProbeResult[] };
          expect(result.rows[0]?.wrong ?? 0, `${table.name} reported a false positive`).toBe(0);
          expect(
            result.rows[0]?.visible ?? 0,
            `${table.name} probe was vacuous — no visible rows to be wrong about`,
          ).toBeGreaterThan(0);
        }
      },
    );
  });
});

describe('the ground-truth census reports a violation when one is planted', () => {
  it('RED: a row in a partition that does not exist is flagged', async () => {
    const partitions = await actualPartitionsWithout(FIXTURE.alpha.groupOne.id);
    const census = await tenantRowCensus(admin);
    const impossible = impossibleCensusRows(census, partitions);
    expect(
      impossible.length,
      'the census did not flag memberships whose partition was removed from the expectation',
    ).toBeGreaterThan(0);
    log(`census flagged ${String(impossible.length)} impossible partition(s) when one was withheld`);
  });

  it('GREEN: with the real partitions, the census is clean', async () => {
    const { actualPartitions } = await import('../support/harness.js');
    const partitions = await actualPartitions(admin);
    const census = await tenantRowCensus(admin);
    expect(impossibleCensusRows(census, partitions)).toEqual([]);
  });
});

/** The real partition set, minus one — to prove the census can fail. */
async function actualPartitionsWithout(groupId: string): Promise<ReadonlySet<string>> {
  const result = await admin.query<{ id: string; organization_id: string }>(
    'select id, organization_id from groups where id <> $1',
    [groupId],
  );
  return new Set(result.rows.map((row) => `${row.organization_id}|${row.id}`));
}
