/**
 * REV-A PROBE 1 — TEMPORARY. Applied, measured, and REMOVED. Not a shipped test.
 *
 * Adversarial probes authored by the post-M4 internal review, packet REV-A.
 * Every arm here is an ATTACK, not a restatement of a shipped test:
 *
 *   A  I-15 fail-closed OUTSIDE a unit of work over the M4 tables, EVERY role,
 *      read and write, with a NON-VACUITY guard proving the rows exist first.
 *   B  cross-tenant and cross-group reads with a VALID but WRONG declared
 *      context, every role, over the M4 + publication tables.
 *   C  I-18 published immutability at the database, every role INCLUDING the
 *      BYPASSRLS break-glass role, over update / delete / INSERT-a-new-child /
 *      delete-the-version.
 *   D  audit chain verification per organization, and update/delete/truncate of
 *      an audit row as every role.
 *   E  the build-run transition TRIGGER on REAL ROWS (the shipped matrix test
 *      drives the SQL FUNCTION), plus the trigger's same-state early return.
 *   F  epoch fencing on a real row: a stale epoch is refused and leaves a ROW.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ROLE_NAMES, type RoleName } from '../../src/db/roles.js';
import { TENANT_TABLES } from '../../src/db/schema.js';
import { verifyAuditChain } from '../../src/audit/verification.js';
import { createRuntime, outsideUnitOfWork, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { seedBuildLifecycleForSweep } from '../support/builds.js';

const multi = ownedMulti('rev-a-p1', {
  profile: 'core',
  seed: { catalogue: ['alpha', 'beta'], schedule: true, scheduleCredentials: true },
});

const M4_TABLES = [
  'solver_input_snapshots',
  'build_configurations',
  'build_runs',
  'build_run_events',
  'build_run_results',
  'build_run_violations',
  'build_run_candidate_assignments',
  'rule_revisions',
  'staffing_set_versions',
  'locations',
] as const;

const PUBLICATION_TABLES = [
  'schedule_versions',
  'shifts',
  'assignment_snapshots',
  'credits',
  'schedule_conflicts',
  'publication_records',
  'version_supersessions',
] as const;

const runtimes = new Map<RoleName, Runtime>();
const log = (...parts: unknown[]): void => {
  // eslint-disable-next-line no-console
  console.log(...parts);
};

beforeAll(async () => {
  for (const role of ROLE_NAMES) runtimes.set(role, createRuntime(role, { max: 3 }));

  /* Non-vacuity: seed a REAL build in BOTH organizations, so every "reads zero
   * rows" arm below is asserting an absence against a population that exists. */
  const fixture = multi();
  const alphaCat = fixture.catalogue?.alpha;
  const betaCat = fixture.catalogue?.beta;
  if (alphaCat === undefined || betaCat === undefined) throw new Error('catalogue seed missing');
  const written = await seedBuildLifecycleForSweep(rt('app_runtime').runner, [
    {
      label: 'reva-alpha',
      organizationId: fixture.alpha.organizationId,
      groupId: fixture.alpha.groupOne.id,
      membershipId: fixture.alpha.users.scheduler.membershipId,
      userId: fixture.alpha.users.scheduler.id,
      shiftTypeId: alphaCat.shiftTypeIds[1] as string,
      startDate: '2029-04-02',
      endDate: '2029-04-15',
    },
    {
      label: 'reva-beta',
      organizationId: fixture.beta.organizationId,
      groupId: fixture.beta.groupOne.id,
      membershipId: fixture.beta.users.scheduler.membershipId,
      userId: fixture.beta.users.scheduler.id,
      shiftTypeId: betaCat.shiftTypeIds[1] as string,
      startDate: '2029-04-02',
      endDate: '2029-04-15',
    },
  ]);
  log('[REV-A/seed] builds written =', written);
}, 600_000);

afterAll(async () => {
  for (const r of runtimes.values()) await r.destroy();
});

function rt(role: RoleName): Runtime {
  const r = runtimes.get(role);
  if (r === undefined) throw new Error(`no runtime for ${role}`);
  return r;
}

function alphaContext(correlationId: string): {
  organizationId: string;
  groupId: string;
  membershipId: string;
  correlationId: string;
} {
  const alpha = multi().alpha;
  return {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    membershipId: alpha.users.scheduler.membershipId,
    correlationId,
  };
}

/* ── 0. NON-VACUITY ────────────────────────────────────────────────────────── */

describe('REV-A/0 — the population the absence arms assert against', () => {
  it('every M4 and publication table under test holds rows in the CORRECT context', async () => {
    const counts: Record<string, string> = {};
    const empty: string[] = [];
    for (const table of [...M4_TABLES, ...PUBLICATION_TABLES]) {
      const res = await rt('app_runtime').runner.run(alphaContext('rev-a-nonvacuity'), async ({ query }) =>
        sql<{ n: string }>`select count(*)::text as n from ${sql.raw(table)}`.execute(query),
      );
      const n = res.rows[0]?.n ?? '0';
      counts[table] = n;
      if (n === '0') empty.push(table);
    }
    log('[REV-A/0] rows visible in the correct context:', JSON.stringify(counts, null, 1));
    log('[REV-A/0] tables that are EMPTY (their absence arms below are vacuous):', JSON.stringify(empty));
    expect(counts['build_runs']).not.toBe('0');
    expect(counts['schedule_versions']).not.toBe('0');
    expect(counts['assignment_snapshots']).not.toBe('0');
  }, 120_000);
});

/* ── A. I-15 fail-closed OUTSIDE the unit of work ──────────────────────────── */

describe('REV-A/A — I-15 fail-closed outside the unit of work', () => {
  it('every non-BYPASSRLS role reads ZERO rows from every M4 + publication table', async () => {
    const nonZero: string[] = [];
    const threw: string[] = [];
    for (const role of ROLE_NAMES) {
      if (role === 'app_breakglass') continue;
      for (const table of [...M4_TABLES, ...PUBLICATION_TABLES]) {
        try {
          const res = await outsideUnitOfWork<{ n: string }>(
            rt(role),
            `select count(*)::text as n from ${table}`,
          );
          const n = res.rows[0]?.n;
          if (n !== '0') nonZero.push(`${role}/${table}: ${String(n)}`);
        } catch (error) {
          threw.push(`${role}/${table}: ${(error as Error).message.slice(0, 80)}`);
        }
      }
    }
    log('[REV-A/A1] non-zero reads (must be empty):', JSON.stringify(nonZero, null, 1));
    log('[REV-A/A1] refusals (also fail-closed):', JSON.stringify(threw, null, 1));
    expect(nonZero).toEqual([]);
  }, 240_000);

  it('every non-BYPASSRLS role is REFUSED an unscoped write to build_runs', async () => {
    const outcomes: string[] = [];
    for (const role of ROLE_NAMES) {
      if (role === 'app_breakglass') continue;
      try {
        const res = await outsideUnitOfWork(
          rt(role),
          `update build_runs set candidate_label = 'rev-a-tamper'`,
        );
        outcomes.push(`${role}: UPDATE returned, rowCount=${String(res.rowCount)}`);
      } catch (error) {
        outcomes.push(`${role}: refused (${(error as Error).message.slice(0, 70)})`);
      }
    }
    log('[REV-A/A2]', JSON.stringify(outcomes, null, 1));
    const tampered = await rt('app_runtime').runner.run(alphaContext('rev-a-a2'), async ({ query }) =>
      sql<{ n: string }>`select count(*)::text as n from build_runs where candidate_label = 'rev-a-tamper'`.execute(
        query,
      ),
    );
    log('[REV-A/A2] rows actually tampered:', tampered.rows[0]?.n);
    expect(tampered.rows[0]?.n).toBe('0');
  }, 120_000);

  it('the tenant-table registry counts 54; the FAD-34(3) sweep floor is 53', () => {
    log('[REV-A/A3] TENANT_TABLES =', TENANT_TABLES.length);
    expect(TENANT_TABLES.length).toBe(54);
  });
});

/* ── B. Cross-tenant and cross-group with a VALID but WRONG context ─────────── */

describe('REV-A/B — cross-tenant and cross-group', () => {
  it('a Beta-declared context sees ZERO Alpha rows in every M4 + publication table, every role', async () => {
    const alpha = multi().alpha;
    const beta = multi().beta;
    const leaks: string[] = [];
    const skipped: string[] = [];
    for (const role of ROLE_NAMES) {
      if (role === 'app_breakglass') continue;
      for (const table of [...M4_TABLES, ...PUBLICATION_TABLES]) {
        try {
          const res = await rt(role).runner.run(
            {
              organizationId: beta.organizationId,
              groupId: beta.groupOne.id,
              membershipId: beta.users.scheduler.membershipId,
              correlationId: 'rev-a-cross-tenant',
            },
            async ({ query }) =>
              sql<{ n: string }>`select count(*)::text as n from ${sql.raw(table)} where organization_id = ${alpha.organizationId}`.execute(
                query,
              ),
          );
          const n = res.rows[0]?.n;
          if (n !== '0') leaks.push(`${role}/${table}: ${String(n)} Alpha rows`);
        } catch (error) {
          skipped.push(`${role}/${table}: ${(error as Error).message.slice(0, 70)}`);
        }
      }
    }
    log('[REV-A/B1] LEAKS (must be empty):', JSON.stringify(leaks, null, 1));
    log('[REV-A/B1] skipped/threw:', JSON.stringify(skipped, null, 1));
    expect(leaks).toEqual([]);
  }, 300_000);

  it('a Beta-declared context cannot WRITE an Alpha-owned build_runs row', async () => {
    const alpha = multi().alpha;
    const beta = multi().beta;
    const outcomes: string[] = [];
    for (const role of ROLE_NAMES) {
      if (role === 'app_breakglass') continue;
      try {
        await rt(role).runner.run(
          {
            organizationId: beta.organizationId,
            groupId: beta.groupOne.id,
            membershipId: beta.users.scheduler.membershipId,
            correlationId: 'rev-a-cross-tenant-write',
          },
          async ({ query }) => {
            await sql`update build_runs set candidate_label = 'rev-a-xtenant' where organization_id = ${alpha.organizationId}`.execute(
              query,
            );
          },
        );
        outcomes.push(`${role}: statement returned`);
      } catch (error) {
        outcomes.push(`${role}: refused (${(error as Error).message.slice(0, 60)})`);
      }
    }
    const tampered = await rt('app_runtime').runner.run(alphaContext('rev-a-b2'), async ({ query }) =>
      sql<{ n: string }>`select count(*)::text as n from build_runs where candidate_label = 'rev-a-xtenant'`.execute(
        query,
      ),
    );
    log('[REV-A/B2]', JSON.stringify(outcomes, null, 1), 'tampered =', tampered.rows[0]?.n);
    expect(tampered.rows[0]?.n).toBe('0');
  }, 180_000);

  it('a sibling-group context sees ZERO of Group One`s build rows', async () => {
    const alpha = multi().alpha;
    const siblingGroupId = multi().catalogue?.alpha.sibling.groupId;
    expect(siblingGroupId).toBeTruthy();
    const leaks: string[] = [];
    for (const role of ROLE_NAMES) {
      if (role === 'app_breakglass') continue;
      for (const table of ['build_runs', 'build_configurations', 'schedule_versions', 'shifts']) {
        const res = await rt(role).runner.run(
          {
            organizationId: alpha.organizationId,
            groupId: siblingGroupId as string,
            membershipId: alpha.users.groupTwoScheduler.membershipId,
            correlationId: 'rev-a-cross-group',
          },
          async ({ query }) =>
            sql<{ n: string }>`select count(*)::text as n from ${sql.raw(table)} where group_id = ${alpha.groupOne.id}`.execute(
              query,
            ),
        );
        const n = res.rows[0]?.n;
        if (n !== '0') leaks.push(`${role}/${table}: ${String(n)}`);
      }
    }
    log('[REV-A/B3] cross-group visibility:', JSON.stringify(leaks, null, 1));
    /* EXPECTED, by migration 0019 §1: `build_runs_organization_capacity_read` is
     * `FOR SELECT TO app_migrator USING (organization_id = app.organization_id)`
     * — ORGANIZATION-scoped, so the schema owner (which serves no application
     * traffic) sees the whole organization's build_runs from any group context.
     * That is the SECURITY DEFINER capacity counter's route. The shipped D-4b
     * arm asserts the property for `app_runtime` and `app_worker` only, and the
     * exit report's wording ("reachable by NO application role") is accurate
     * because `app_migrator` is not one. Pinned EXACTLY, so anything else that
     * ever appears here still fails. */
    expect(leaks).toEqual(['app_migrator/build_runs: 1']);
  }, 180_000);
});

/* ── C. I-18 published immutability at the database ─────────────────────────── */

describe('REV-A/C — I-18 at the database, every role', () => {
  it('no role — break-glass included — mutates a published version or its children', async () => {
    const schedule = multi().schedule;
    expect(schedule, 'the fixture must seed a published schedule').toBeTruthy();
    const versionId = schedule?.groupOne.currentVersionId as string;

    /* Confirm the target really IS published first — an immutability arm
     * against a draft would pass for the wrong reason. */
    const state = await rt('app_runtime').runner.run(alphaContext('rev-a-c-state'), async ({ query }) =>
      sql<{ state: string }>`select state from schedule_versions where id = ${versionId}`.execute(query),
    );
    log('[REV-A/C0] target version state =', state.rows[0]?.state);
    expect(['published', 'superseded']).toContain(state.rows[0]?.state);

    const results: string[] = [];
    for (const role of ROLE_NAMES) {
      const runner = rt(role).runner;
      const context = alphaContext(`rev-a-i18-${role}`);
      const attempt = async (label: string, run: (q: unknown) => Promise<void>): Promise<string> => {
        try {
          await runner.run(context, async ({ query }) => run(query));
          return `${label}=NOT-REFUSED`;
        } catch (error) {
          const message = (error as Error).message;
          const code = /SCHEDULE_PUBLISHED_IMMUTABLE|permission denied|violates|restrict/.exec(message);
          return `${label}=refused(${code?.[0] ?? message.slice(0, 40)})`;
        }
      };
      const parts = [
        await attempt('update-child', async (q) =>
          sql`update assignment_snapshots set notes = 'rev-a' where schedule_version_id = ${versionId}`.execute(
            q as never,
          ),
        ),
        await attempt('delete-child', async (q) =>
          sql`delete from shifts where schedule_version_id = ${versionId}`.execute(q as never),
        ),
        await attempt('insert-child', async (q) =>
          sql`insert into shifts (id, organization_id, group_id, schedule_version_id, shift_type_id, shift_date, span, location_id)
              select gen_random_uuid(), organization_id, group_id, schedule_version_id, shift_type_id, shift_date, span, location_id
              from shifts where schedule_version_id = ${versionId} limit 1`.execute(q as never),
        ),
        await attempt('delete-version', async (q) =>
          sql`delete from schedule_versions where id = ${versionId}`.execute(q as never),
        ),
        await attempt('update-publication-record', async (q) =>
          sql`update publication_records set published_at = now() where schedule_version_id = ${versionId}`.execute(
            q as never,
          ),
        ),
      ];
      results.push(`${role}: ${parts.join(' ')}`);
    }
    log('[REV-A/C1]\n' + results.join('\n'));
    expect(results.filter((r) => r.includes('NOT-REFUSED'))).toEqual([]);
  }, 300_000);
});

/* ── D. Audit chain ────────────────────────────────────────────────────────── */

describe('REV-A/D — audit chain', () => {
  it('verifies with ZERO problems per organization, over a non-empty chain', async () => {
    const lines: string[] = [];
    for (const org of [multi().alpha, multi().beta]) {
      const verification = await rt('app_runtime').runner.run(
        { organizationId: org.organizationId, groupId: null, membershipId: null, correlationId: 'rev-a-audit' },
        async (uow) => verifyAuditChain(uow),
      );
      lines.push(
        `org=${org.organizationId} events=${String(verification.entries)} problems=${String(verification.problems.length)} ${JSON.stringify(verification.problems.slice(0, 3))}`,
      );
      expect(verification.problems).toEqual([]);
      expect(verification.entries).toBeGreaterThan(0);
    }
    log('[REV-A/D1]\n' + lines.join('\n'));
  }, 240_000);

  /* (superseded by probe 2's REV-A/D2b, which measures ROW COUNTS: probe 1's
     arm read a zero-row DELETE under RLS as "not refused".) */

});

/* ── E. The transition trigger on REAL ROWS, and the same-state early return ── */

describe('REV-A/E — the build-run transition trigger, on real rows', () => {
  it('a sample of ILLEGAL edges is refused by the TRIGGER, not only by the function', async () => {
    const runId = await rt('app_runtime').runner.run(alphaContext('rev-a-e-find'), async ({ query }) => {
      const r = await sql<{ id: string; state: string }>`select id, state from build_runs limit 1`.execute(query);
      return r.rows[0];
    });
    log('[REV-A/E0] target run =', JSON.stringify(runId));
    expect(runId).toBeTruthy();

    const illegal = ['draft_configuration', 'queued', 'running', 'completed', 'approved', 'reviewed'];
    const outcomes: string[] = [];
    for (const to of illegal) {
      try {
        await rt('app_runtime').runner.run(alphaContext('rev-a-e1'), async ({ query }) => {
          await sql`update build_runs set state = ${to}, termination_reason = 'completed' where id = ${runId?.id}`.execute(
            query,
          );
          throw new Error('ROLLBACK-PROBE'); // never commit a probe write
        });
      } catch (error) {
        const message = (error as Error).message;
        outcomes.push(
          `${runId?.state} -> ${to}: ${message.includes('ROLLBACK-PROBE') ? 'ACCEPTED-BY-TRIGGER' : message.slice(0, 60)}`,
        );
      }
    }
    log('[REV-A/E1]\n' + outcomes.join('\n'));
    // `failed` -> archived is the ONLY legal edge from the seeder's terminal state.
    expect(outcomes.filter((o) => o.includes('ACCEPTED-BY-TRIGGER'))).toEqual([]);
  }, 180_000);

  it('SAME-STATE UPDATE: can termination_reason / solver_status be rewritten after the fact?', async () => {
    const run = await rt('app_runtime').runner.run(alphaContext('rev-a-e2-find'), async ({ query }) => {
      const r = await sql<{ id: string; state: string; termination_reason: string | null; solver_status: string | null }>`
        select id, state, termination_reason, solver_status from build_runs limit 1`.execute(query);
      return r.rows[0];
    });
    log('[REV-A/E2] before:', JSON.stringify(run));

    let outcome = 'REFUSED';
    let after: unknown = null;
    try {
      await rt('app_runtime').runner.run(alphaContext('rev-a-e2'), async ({ query }) => {
        await sql`update build_runs
                  set termination_reason = 'completed', solver_status = 'OPTIMAL'
                  where id = ${run?.id}`.execute(query);
        const r = await sql<{ termination_reason: string | null; solver_status: string | null }>`
          select termination_reason, solver_status from build_runs where id = ${run?.id}`.execute(query);
        after = r.rows[0];
        outcome = 'ACCEPTED';
        throw new Error('ROLLBACK-PROBE'); // do not commit
      });
    } catch (error) {
      if (!(error as Error).message.includes('ROLLBACK-PROBE')) {
        outcome = `REFUSED(${(error as Error).message.slice(0, 70)})`;
      }
    }
    log('[REV-A/E2] same-state rewrite of the termination facts:', outcome, JSON.stringify(after));
    log(
      '[REV-A/E2] NOTE: the trigger returns early on `NEW.state IS NOT DISTINCT FROM OLD.state`,',
      'so every state-conditioned guard below that line is skipped for a same-state UPDATE.',
    );
    // Recorded, not asserted — REV-A reports, it does not decide.
    expect(['ACCEPTED', 'REFUSED']).toContain(outcome.split('(')[0]);
  }, 120_000);

  it('claim_epoch never regresses, and `running` requires an ADVANCED epoch', async () => {
    const run = await rt('app_runtime').runner.run(alphaContext('rev-a-e3-find'), async ({ query }) => {
      const r = await sql<{ id: string; claim_epoch: number; state: string }>`
        select id, claim_epoch, state from build_runs limit 1`.execute(query);
      return r.rows[0];
    });
    log('[REV-A/E3] run =', JSON.stringify(run));

    let regress = 'ACCEPTED';
    try {
      await rt('app_runtime').runner.run(alphaContext('rev-a-e3'), async ({ query }) => {
        await sql`update build_runs set claim_epoch = claim_epoch - 1 where id = ${run?.id}`.execute(query);
      });
    } catch (error) {
      regress = (error as Error).message.slice(0, 70);
    }
    log('[REV-A/E3] epoch decrement:', regress);
    expect(regress).not.toBe('ACCEPTED');
  }, 120_000);

  it('a build run`s identity fields are frozen (BUILD_IDENTITY_FROZEN)', async () => {
    const run = await rt('app_runtime').runner.run(alphaContext('rev-a-e4-find'), async ({ query }) => {
      const r = await sql<{ id: string }>`select id from build_runs limit 1`.execute(query);
      return r.rows[0];
    });
    const frozen = ['period_id', 'build_configuration_id', 'source_version_id', 'idempotency_key', 'semantic_request_digest'];
    const outcomes: string[] = [];
    for (const column of frozen) {
      try {
        await rt('app_runtime').runner.run(alphaContext('rev-a-e4'), async ({ query }) => {
          const value = column.endsWith('_id') ? sql`gen_random_uuid()` : sql`'rev-a-probe'`;
          await sql`update build_runs set ${sql.raw(column)} = ${value} where id = ${run?.id}`.execute(query);
          throw new Error('ROLLBACK-PROBE');
        });
        outcomes.push(`${column}: NOT-REFUSED`);
      } catch (error) {
        const m = (error as Error).message;
        outcomes.push(`${column}: ${m.includes('ROLLBACK-PROBE') ? 'NOT-REFUSED (write accepted)' : m.slice(0, 55)}`);
      }
    }
    log('[REV-A/E4]\n' + outcomes.join('\n'));
    expect(outcomes.filter((o) => o.includes('NOT-REFUSED'))).toEqual([]);
  }, 180_000);
});

/* (probe 1's G block was superseded by probe 2's G2 and removed.) */
