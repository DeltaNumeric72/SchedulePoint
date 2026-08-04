import { CompiledQuery } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TENANT_TABLES } from '../../src/db/schema.js';
import { adminClient } from '../support/admin-client.js';
import { groupContext } from '../support/fixtures.js';
import {
  createRuntime,
  expectedVisibleUserIds,
  actualOrganizations,
  impossibleCensusRows,
  log,
  tenantRowCensus,
  wrongTenantProbe,
  type ProbeResult,
  type Runtime,
} from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { seedRulesForSweep } from '../support/rules.js';
import { seedLocationsForSweep } from '../support/settings.js';

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
const multi = ownedMulti('red-cases-probe-is-not-vacuous', {
  // `schedule: true` (OPUS-M3-003) so migration 0009's eleven tables carry
  // visible rows: this file's probes fail a REGISTERED table that is never seen
  // with one, because a probe over an empty table reports 0 wrong for the most
  // boring possible reason.
  seed: { staffing: true, catalogue: ['alpha'], schedule: true },
});

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
 *
 * ## Two contexts, because one scope class cannot be probed from a group
 *
 * `audit_checkpoints` is `organization-context-only`: a checkpoint covers an
 * organization's whole chain, so its read policy carries `app.group_id IS NULL`
 * and a group-scoped context correctly sees nothing. Probing it from a group
 * context would report `visible = 0` — the vacuous pass this file exists to
 * catch — so tables in that class are probed under an ORGANIZATION-scoped
 * context instead. Every other table is probed exactly as before, and no table
 * goes unprobed.
 */

/** Tables whose RLS predicate requires an organization-scoped context to see anything. */
const ORGANIZATION_CONTEXT_ONLY = TENANT_TABLES.filter(
  (table) => table.scope === 'organization-context-only',
);
const GROUP_PROBABLE = TENANT_TABLES.filter((table) => table.scope !== 'organization-context-only');

let admin: pg.Client;
let runtime: Runtime;

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  runtime = createRuntime('app_runtime', { max: 2 });

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

  /* ── OPUS-M3-007: location rows for the SBX-004 sweep ─────────────────────
   *
   * Migration 0010 registers `locations` in `TENANT_TABLES` — this packet raises
   * the sweep floor — and the sweep's own non-vacuity check fails when a
   * REGISTERED table is never seen with a visible row. "0 wrong" over an empty
   * table means nothing.
   *
   * Seeded HERE rather than in `provisionMulti`: `test/support/multi.ts` is the
   * single fixture owner and packet 32 §10a gives this packet
   * `test/support/settings.ts` alone. This file and that one are both in the
   * allowed globs, so the seeding reaches the same fixture without either packet
   * editing the shared provisioning script — the arrangement OPUS-M3-002 used
   * for `rules`.
   *
   * Into BOTH of Alpha's groups AND into Beta, so the group predicate arm has
   * rows it COULD see if the predicate were broken, not only the
   * cross-organization arm.
   *
   * Each target names an organization administrator as `grantorMembershipId`,
   * because `group.location.administer` is role-implied for `group_admin` alone
   * (doc 08 §6 "Group settings") and these fixtures' group memberships are
   * schedulers. The grant is the product's own layer-4 mechanism; the write
   * still goes through the trigger and RLS. */
  await seedLocationsForSweep(runtime.runner, [
    {
      organizationId: multi().alpha.organizationId,
      groupId: multi().alpha.groupOne.id,
      membershipId: multi().alpha.users.scheduler.membershipId,
      grantorMembershipId: multi().alpha.users.organizationAdmin.membershipId,
      label: 'alpha_one',
    },
    {
      organizationId: multi().alpha.organizationId,
      groupId: multi().alpha.groupTwo.id,
      membershipId: multi().alpha.users.scheduler.groupTwoMembershipId,
      grantorMembershipId: multi().alpha.users.organizationAdmin.membershipId,
      label: 'alpha_two',
    },
    {
      organizationId: multi().beta.organizationId,
      groupId: multi().beta.groupOne.id,
      membershipId: multi().beta.users.scheduler.membershipId,
      grantorMembershipId: multi().beta.users.organizationAdmin.membershipId,
      label: 'beta_one',
    },
  ]);
}, 180_000);

afterAll(async () => {
  await runtime.destroy();
  await admin.end();
});

describe('the wrong-tenant probe reports a violation when one is expected', () => {
  it("RED: probing Group One's rows against Group Two's expectation reports wrong > 0", async () => {
    // The unit of work is genuinely Group One's; the probe is handed Group Two's
    // coordinates. Every visible row is now "wrong", and the probe must say so
    // on every table that carries a group.
    const realContext = groupContext(
      multi().alpha.organizationId,
      multi().alpha.groupOne.id,
      multi().alpha.users.scheduler.membershipId,
    );
    const misdeclared = groupContext(
      multi().alpha.organizationId,
      multi().alpha.groupTwo.id,
      multi().alpha.users.scheduler.membershipId,
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

  it("RED: probing Alpha's rows against Beta's expectation reports wrong > 0 on every table", async () => {
    const realContext = groupContext(
      multi().alpha.organizationId,
      multi().alpha.groupOne.id,
      multi().alpha.users.scheduler.membershipId,
    );
    const otherOrganization = groupContext(
      multi().beta.organizationId,
      multi().beta.groupOne.id,
      multi().beta.users.scheduler.membershipId,
    );
    const wrongUserExpectation = await expectedVisibleUserIds(admin, otherOrganization);

    const probed: string[] = [];
    const assertReportsWrong = async (
      query: Parameters<Parameters<Runtime['runner']['run']>[1]>[0]['query'],
      tables: readonly (typeof TENANT_TABLES)[number][],
    ): Promise<void> => {
      for (const table of tables) {
        const probe = wrongTenantProbe(table, otherOrganization, wrongUserExpectation);
        const result = (await query.executeQuery(
          CompiledQuery.raw(probe.text, probe.values),
        )) as unknown as { rows: ProbeResult[] };
        expect(
          result.rows[0]?.wrong ?? 0,
          `${table.name}: the probe reported 0 wrong rows against another organization's expectation`,
        ).toBeGreaterThan(0);
        probed.push(table.name);
      }
    };

    await runtime.runner.run(realContext, ({ query }) => assertReportsWrong(query, GROUP_PROBABLE));
    await runtime.runner.run(
      multi.administrator(multi().alpha.organizationId, 'probe-red-organization'),
      ({ query }) => assertReportsWrong(query, ORGANIZATION_CONTEXT_ONLY),
    );

    // Every registered table was probed under SOME context. A table silently
    // skipped by the partition above would otherwise be a table this red case
    // never exercises.
    expect([...probed].sort()).toEqual(TENANT_TABLES.map((t) => t.name).sort());
    log('every tenant table reports wrong > 0 when probed against the other organization');
  });

  it('GREEN: the same probe reports zero against the CORRECT expectation', async () => {
    // Both directions, in one file. A probe that always reported a violation
    // would satisfy the red cases above and be equally useless.
    const assertCleanAndNonVacuous = async (
      query: Parameters<Parameters<Runtime['runner']['run']>[1]>[0]['query'],
      context: ReturnType<typeof groupContext>,
      tables: readonly (typeof TENANT_TABLES)[number][],
    ): Promise<void> => {
      const expected = await expectedVisibleUserIds(admin, context);
      for (const table of tables) {
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
    };

    const group = groupContext(
      multi().alpha.organizationId,
      multi().alpha.groupOne.id,
      multi().alpha.users.scheduler.membershipId,
    );
    await runtime.runner.run(group, ({ query, context }) =>
      assertCleanAndNonVacuous(query, context, GROUP_PROBABLE),
    );

    const organization = multi.administrator(
      multi().alpha.organizationId,
      'probe-green-organization',
    );
    await runtime.runner.run(organization, ({ query, context }) =>
      assertCleanAndNonVacuous(query, context, ORGANIZATION_CONTEXT_ONLY),
    );
  });
});

describe('the ground-truth census reports a violation when one is planted', () => {
  it('RED: a row in a partition that does not exist is flagged', async () => {
    const partitions = await actualPartitionsWithout(multi().alpha.groupOne.id);
    const organizations = await actualOrganizations(admin);
    const census = await tenantRowCensus(admin);
    const impossible = impossibleCensusRows(census, partitions, organizations);
    expect(
      impossible.length,
      'the census did not flag memberships whose partition was removed from the expectation',
    ).toBeGreaterThan(0);
    log(
      `census flagged ${String(impossible.length)} impossible partition(s) when one was withheld`,
    );
  });

  it('GREEN: with the real partitions, the census is clean', async () => {
    const { actualPartitions } = await import('../support/harness.js');
    const partitions = await actualPartitions(admin);
    const organizations = await actualOrganizations(admin);
    const census = await tenantRowCensus(admin);
    expect(impossibleCensusRows(census, partitions, organizations)).toEqual([]);
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
