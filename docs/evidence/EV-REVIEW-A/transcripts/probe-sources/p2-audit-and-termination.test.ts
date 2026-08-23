/**
 * REV-A PROBE 2 — TEMPORARY. Applied, measured, and REMOVED. Not a shipped test.
 *
 * The tightened re-run of probe 1's three inconclusive arms, plus the arm probe 1
 * turned up:
 *
 *   D  audit rows: measured by ROW COUNT and by re-verifying the chain, not by
 *      "the statement returned" (probe 1 conflated a zero-row DELETE under RLS
 *      with a refusal).
 *   G  the audit-chain DETECTOR, with the tamper/restore on Alpha and the
 *      tail-truncation on Beta (deliberately not restored — an ephemeral cluster).
 *   H  the same-state `build_runs` UPDATE probe 1 found ACCEPTED: does rewriting
 *      the termination facts change what the product CLAIMS about the result,
 *      and do `build_runs` and the append-only `build_run_results` then disagree?
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ROLE_NAMES, type RoleName } from '../../src/db/roles.js';
import { runResultReproducibility } from '../../src/builds/service.js';
import { verifyAuditChain } from '../../src/audit/verification.js';
import { adminClient } from '../support/admin-client.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { seedBuildLifecycleForSweep } from '../support/builds.js';

const multi = ownedMulti('rev-a-p2', {
  profile: 'core',
  seed: { catalogue: ['alpha', 'beta'], schedule: true, scheduleCredentials: true },
});

const runtimes = new Map<RoleName, Runtime>();
const log = (...parts: unknown[]): void => {
  // eslint-disable-next-line no-console
  console.log(...parts);
};

function rt(role: RoleName): Runtime {
  const r = runtimes.get(role);
  if (r === undefined) throw new Error(`no runtime for ${role}`);
  return r;
}

beforeAll(async () => {
  for (const role of ROLE_NAMES) runtimes.set(role, createRuntime(role, { max: 3 }));
  const f = multi();
  const cat = f.catalogue?.alpha;
  if (cat === undefined) throw new Error('catalogue seed missing');
  await seedBuildLifecycleForSweep(rt('app_runtime').runner, [
    {
      label: 'reva-p2',
      organizationId: f.alpha.organizationId,
      groupId: f.alpha.groupOne.id,
      membershipId: f.alpha.users.scheduler.membershipId,
      userId: f.alpha.users.scheduler.id,
      shiftTypeId: cat.shiftTypeIds[1] as string,
      startDate: '2029-06-04',
      endDate: '2029-06-17',
    },
  ]);
}, 600_000);

afterAll(async () => {
  for (const r of runtimes.values()) await r.destroy();
});

function orgContext(organizationId: string, correlationId: string): {
  organizationId: string;
  groupId: null;
  membershipId: null;
  correlationId: string;
} {
  return { organizationId, groupId: null, membershipId: null, correlationId };
}

async function chainState(organizationId: string, label: string): Promise<{ entries: number; problems: string[] }> {
  const v = await rt('app_runtime').runner.run(orgContext(organizationId, `rev-a-p2-${label}`), async (uow) =>
    verifyAuditChain(uow),
  );
  log(`[REV-A/chain] ${label}: entries=${String(v.entries)} problems=${String(v.problems.length)} ` +
    `kinds=${JSON.stringify([...new Set(v.problems.map((p) => p.problem))])}`);
  return { entries: v.entries, problems: v.problems.map((p) => p.problem) };
}

/* ── D. Audit rows, measured by ROW COUNT ──────────────────────────────────── */

describe('REV-A/D2b — audit rows: what actually happened, not what returned', () => {
  it('no role deletes an audit row: rowCount 0 everywhere, chain unchanged', async () => {
    const alpha = multi().alpha;
    const before = await chainState(alpha.organizationId, 'before-delete-attempts');
    expect(before.problems).toEqual([]);
    expect(before.entries).toBeGreaterThan(0);

    const outcomes: string[] = [];
    for (const role of ROLE_NAMES) {
      const context = orgContext(alpha.organizationId, `rev-a-p2-del-${role}`);
      let line = `${role}: `;
      try {
        const deleted = await rt(role).runner.run(context, async ({ query }) => {
          const r = await sql`delete from audit_events`.execute(query);
          return r.numAffectedRows ?? 0n;
        });
        line += `DELETE returned, rows affected = ${String(deleted)}`;
      } catch (error) {
        line += `refused (${(error as Error).message.slice(0, 60)})`;
      }
      try {
        const updated = await rt(role).runner.run(context, async ({ query }) => {
          const r = await sql`update audit_events set correlation_id = 'rev-a-p2'`.execute(query);
          return r.numAffectedRows ?? 0n;
        });
        line += ` | UPDATE returned, rows affected = ${String(updated)}`;
      } catch (error) {
        line += ` | UPDATE refused (${(error as Error).message.slice(0, 60)})`;
      }
      outcomes.push(line);
    }
    log('[REV-A/D2b]\n' + outcomes.join('\n'));

    const after = await chainState(alpha.organizationId, 'after-delete-attempts');
    expect(after.entries, 'an audit row was actually removed').toBe(before.entries);
    expect(after.problems, 'the chain was actually damaged').toEqual([]);
    expect(
      outcomes.filter((o) => /rows affected = [1-9]/.test(o)),
      'some role actually wrote or removed audit rows',
    ).toEqual([]);
  }, 240_000);
});

/* ── G. The audit-chain DETECTOR (mutation probe, superuser, triggers off) ─── */

describe('REV-A/G2 — the audit-chain detector is load-bearing', () => {
  it('a tampered payload on a MIDDLE row is DETECTED, and restore puts the chain back', async () => {
    const alpha = multi().alpha;
    const admin = adminClient();
    await admin.connect();
    try {
      const before = await chainState(alpha.organizationId, 'G2-before');
      expect(before.problems).toEqual([]);

      const target = await admin.query<{ id: string; sequence: string; payload: string }>(
        `select id, sequence::text as sequence, payload::text as payload
           from audit_events where organization_id = $1
          order by sequence
         offset (select greatest(1, count(*)/2) from audit_events where organization_id = $1) limit 1`,
        [alpha.organizationId],
      );
      const row = target.rows[0];
      expect(row).toBeTruthy();
      log('[REV-A/G2] tampering with sequence', row?.sequence);

      await admin.query(`alter table audit_events disable trigger all`);
      try {
        await admin.query(
          `update audit_events set payload = jsonb_set(payload, '{revATamper}', '"1"'::jsonb) where id = $1`,
          [row?.id],
        );
        const tampered = await chainState(alpha.organizationId, 'G2-after-tamper');
        expect(tampered.problems).toContain('entry_hash_mismatch');

        await admin.query(`update audit_events set payload = $2::jsonb where id = $1`, [
          row?.id,
          row?.payload,
        ]);
      } finally {
        await admin.query(`alter table audit_events enable trigger all`);
      }
      const restored = await chainState(alpha.organizationId, 'G2-after-restore');
      expect(restored.problems, 'the restore did not put Alpha`s chain back').toEqual([]);
      expect(restored.entries).toBe(before.entries);
    } finally {
      await admin.end();
    }
  }, 240_000);

  it('a TRUNCATED TAIL is detected — the shape walking the surviving rows cannot see (R-01)', async () => {
    /* Deliberately on BETA and deliberately NOT restored: the cluster is created
     * from empty and destroyed at the end of this run, and a byte-exact restore
     * of a hash-covered row through a JS round trip is not reliable (probe 1
     * measured exactly that). Alpha's chain, asserted clean above, is untouched. */
    const beta = multi().beta;
    const admin = adminClient();
    await admin.connect();
    try {
      const before = await chainState(beta.organizationId, 'G2-beta-before');
      expect(before.problems).toEqual([]);
      expect(before.entries).toBeGreaterThan(2);

      await admin.query(`alter table audit_events disable trigger all`);
      try {
        const del = await admin.query(
          `delete from audit_events where id in (
             select id from audit_events where organization_id = $1 order by sequence desc limit 2)`,
          [beta.organizationId],
        );
        log('[REV-A/G2] tail rows deleted from Beta:', del.rowCount);
      } finally {
        await admin.query(`alter table audit_events enable trigger all`);
      }

      const truncated = await chainState(beta.organizationId, 'G2-beta-after-truncation');
      expect(truncated.entries).toBe(before.entries - 2);
      expect(
        truncated.problems,
        'the detector did not see a truncated tail — walking the surviving rows never can',
      ).toContain('head_sequence_ahead_of_chain');
    } finally {
      await admin.end();
    }
  }, 240_000);
});

/* ── H. The same-state UPDATE, and what it does to the honesty verdict ─────── */

describe('REV-A/H — the termination facts are not frozen, and the verdict reads them', () => {
  it('a same-state UPDATE rewrites termination_reason/solver_status, flipping the verdict', async () => {
    const alpha = multi().alpha;
    const context = {
      organizationId: alpha.organizationId,
      groupId: alpha.groupOne.id,
      membershipId: alpha.users.scheduler.membershipId,
      correlationId: 'rev-a-p2-h',
    };

    const shape = await rt('app_runtime').runner.run(context, async ({ query }) => {
      const run = await sql<{
        id: string;
        state: string;
        termination_reason: string | null;
        solver_status: string | null;
        reproducibility_mode: string | null;
        solver_parameters: unknown;
      }>`select id, state, termination_reason, solver_status, reproducibility_mode, solver_parameters
           from build_runs order by created_at desc limit 1`.execute(query);
      const r = run.rows[0];
      const result = await sql<{ solver_status: string; termination_reason: string }>`
        select solver_status, termination_reason from build_run_results where build_run_id = ${r?.id}`.execute(
        query,
      );
      return { run: r, result: result.rows[0] };
    });
    log('[REV-A/H] build_runs        :', JSON.stringify(shape.run));
    log('[REV-A/H] build_run_results :', JSON.stringify(shape.result));

    /* The verdict as the shipped route derives it, under a PINNED parameter set,
     * from the facts as they stand. */
    const pinned = {
      randomSeed: 1,
      numSearchWorkers: 1,
      maxTimeInSeconds: 600,
      maxDeterministicTime: 100,
      interleaveSearch: true,
    };
    const verdictOf = (termination: string | null, status: string | null): string => {
      const v = runResultReproducibility(
        {
          solver_parameters: pinned,
          reproducibility_mode: 'deterministic',
          termination_reason: termination,
          solver_status: status,
        },
        { wallTimeSeconds: 1, deterministicTimeUnits: 90 },
      );
      return `${v?.verdict ?? 'null'} reproducible=${String(v?.reproducible ?? 'null')} promise=${String(/produces the same schedule/.test(v?.detail ?? ''))}`;
    };

    log('[REV-A/H] verdict from the recorded facts        :', verdictOf(shape.run?.termination_reason ?? null, shape.run?.solver_status ?? null));
    log('[REV-A/H] verdict after the rewrite would read   :', verdictOf('completed', 'OPTIMAL'));

    /* Now actually perform the same-state rewrite, as `app_runtime`, through a
     * unit of work — the same access any shipped module inside a UoW holds — and
     * COMMIT it, so the disagreement below is a real database state. */
    let accepted = false;
    try {
      await rt('app_runtime').runner.run(context, async ({ query }) => {
        await sql`update build_runs set termination_reason = 'completed', solver_status = 'OPTIMAL' where id = ${shape.run?.id}`.execute(
          query,
        );
      });
      accepted = true;
    } catch (error) {
      log('[REV-A/H] the same-state rewrite was REFUSED:', (error as Error).message.slice(0, 120));
    }
    log('[REV-A/H] same-state rewrite accepted:', accepted);

    const after = await rt('app_runtime').runner.run(context, async ({ query }) => {
      const run = await sql<{ state: string; termination_reason: string | null; solver_status: string | null }>`
        select state, termination_reason, solver_status from build_runs where id = ${shape.run?.id}`.execute(query);
      const result = await sql<{ solver_status: string; termination_reason: string }>`
        select solver_status, termination_reason from build_run_results where build_run_id = ${shape.run?.id}`.execute(
        query,
      );
      return { run: run.rows[0], result: result.rows[0] };
    });
    log('[REV-A/H] AFTER build_runs        :', JSON.stringify(after.run));
    log('[REV-A/H] AFTER build_run_results :', JSON.stringify(after.result), '  <-- append-only, unchanged');
    log(
      '[REV-A/H] the two records now DISAGREE:',
      String(after.run?.termination_reason !== after.result?.termination_reason ||
        after.run?.solver_status !== after.result?.solver_status),
    );

    /* And can the append-only result row be brought into line? */
    let resultMutable = 'REFUSED';
    try {
      await rt('app_runtime').runner.run(context, async ({ query }) => {
        await sql`update build_run_results set solver_status = 'OPTIMAL' where build_run_id = ${shape.run?.id}`.execute(
          query,
        );
      });
      resultMutable = 'ACCEPTED';
    } catch (error) {
      resultMutable = `refused(${(error as Error).message.slice(0, 60)})`;
    }
    log('[REV-A/H] build_run_results UPDATE :', resultMutable);

    /* REV-A reports; it does not decide. Both outcomes are recorded. */
    expect(typeof accepted).toBe('boolean');
  }, 240_000);
});
