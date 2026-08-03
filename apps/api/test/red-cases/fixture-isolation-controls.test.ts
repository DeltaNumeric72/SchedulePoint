import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { adminClient } from '../support/admin-client.js';
import {
  baselineViolations,
  readBaselineDigest,
  type BaselineDigest,
} from '../support/baseline-guard.js';
import { FIXTURE } from '../support/fixtures.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * FAD-15 Layer 2 — this file owns its tenant, like every other file that writes.
 */
const multi = ownedMulti('red-cases-fixture-isolation-controls');

/* ────────────────────────────────────────────────────────────────────────────
 * RED CASES for the two controls FAD-15 introduced.
 *
 * A control nobody has seen fail is a decoration. `pnpm red-cases` proves each
 * build-failing gate red on its violation; these two controls live inside the
 * test run rather than in a gate script, so their red cases live here — and they
 * are red cases in the same sense: **each one first shows the control passing on
 * clean state, then produces the violation and shows the control catching it.**
 *
 * Neither of them leaves the violation behind. The baseline write is made and
 * then reversed inside this file, and the reversal is verified — because a red
 * case that damages the fixture would make every later file fail for a reason
 * that is not their defect, which is precisely the coupling class FAD-15 exists
 * to remove.
 * ──────────────────────────────────────────────────────────────────────────── */

let admin: pg.Client;
let runtime: Runtime;

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  runtime = createRuntime('app_runtime');
});

afterAll(async () => {
  await runtime.destroy();
  await admin.end();
});

/**
 * The digest, computed exactly as the guard computes it. Duplicated here rather
 * than exported from the guard so this red case exercises the guard's OUTPUT
 * (`baselineViolations`) against independently gathered state, instead of
 * comparing the guard with itself.
 */
async function digestBaselineIndependently(): Promise<BaselineDigest> {
  const organizationIds = FIXTURE.organizationIds;
  const userIds = [
    ...Object.values(FIXTURE.alpha.users).map((user) => user.id),
    ...Object.values(FIXTURE.beta.users).map((user) => user.id),
  ];
  const tables: Record<string, string[]> = {};

  const withOrganization = await admin.query<{ schemaname: string; tablename: string }>(
    `select t.schemaname, t.tablename
       from pg_tables t
       join information_schema.columns c
         on c.table_schema = t.schemaname and c.table_name = t.tablename
        and c.column_name = 'organization_id'
      where t.schemaname not in ('pg_catalog', 'information_schema')
      order by 1, 2`,
  );
  for (const { schemaname, tablename } of withOrganization.rows) {
    const rows = await admin.query<{ h: string }>(
      `select md5(t::text) as h from "${schemaname}"."${tablename}" t
        where organization_id = any($1::uuid[])`,
      [organizationIds],
    );
    tables[`${schemaname}.${tablename}`] = rows.rows.map((row) => row.h).sort();
  }
  const organizations = await admin.query<{ h: string }>(
    'select md5(t::text) as h from organizations t where id = any($1::uuid[])',
    [organizationIds],
  );
  tables['public.organizations'] = organizations.rows.map((row) => row.h).sort();
  const users = await admin.query<{ h: string }>(
    'select md5(t::text) as h from users t where id = any($1::uuid[])',
    [userIds],
  );
  tables['public.users'] = users.rows.map((row) => row.h).sort();
  return { tables };
}

describe('red case — the Layer 1 baseline control catches a write to the shared fixture', () => {
  it('GREEN: with the baseline untouched, the control reports no violation', async () => {
    const reference = readBaselineDigest();
    expect(reference, 'the reference digest is missing — the control is inert').toBeDefined();
    const current = await digestBaselineIndependently();
    expect(baselineViolations(reference as BaselineDigest, current)).toEqual([]);
    log('control is quiet on an untouched baseline');
  });

  it('RED: one row changed in the baseline, and the control names the table', async () => {
    const reference = readBaselineDigest() as BaselineDigest;
    const target = FIXTURE.alpha.groupOne.id;

    const before = await admin.query<{ name: string }>('select name from groups where id = $1', [
      target,
    ]);
    const originalName = before.rows[0]?.name;
    expect(originalName, 'the baseline group is missing — this red case would be vacuous').toBe(
      'Alpha Group One',
    );

    try {
      // Deliberately as the SUPERUSER and out of band. The point is not that an
      // application role could do this — the grants make that its own question —
      // but that IF the baseline changes by ANY route, the control sees it.
      await admin.query('update groups set name = $1 where id = $2', [
        'RED CASE — baseline tampered with (synthetic)',
        target,
      ]);

      const tampered = await digestBaselineIndependently();
      const problems = baselineViolations(reference, tampered);

      expect(problems.length, 'the control did not notice a changed baseline row').toBeGreaterThan(
        0,
      );
      expect(problems.join('\n'), 'the control did not name the table').toContain('public.groups');
      expect(problems.join('\n')).toContain('1 row(s) appeared');
      log(`control caught the tampering: ${problems.join(' | ')}`);
    } finally {
      // Put it back, whatever happened above. A red case that leaves the fixture
      // broken reintroduces the coupling class it is here to police.
      await admin.query('update groups set name = $1 where id = $2', [originalName, target]);
    }

    const restored = await digestBaselineIndependently();
    expect(
      baselineViolations(reference, restored),
      'the red case did not restore the baseline it tampered with',
    ).toEqual([]);
    log('baseline restored; the control is quiet again');
  });
});

describe('red case — a hidden order dependence is caught by the new fixture strategy', () => {
  /**
   * The reference implementation of the coupling class NR-13 measured: a pair of
   * tests where the second reads a row the first created, with nothing declaring
   * that dependency.
   *
   * It cannot be written as two real `it`s — the gate would then be red on every
   * run, which is a broken build rather than a proof. So the pair is executed
   * here in BOTH orders against this file's own tenant, and the assertions are
   * about what each order produces: the coupled pair fails in the reversed order
   * and the state-owning pair passes in both. That is the same demonstration the
   * gate performs across the suite, made local and deterministic.
   */
  const subjectKey = 'red-case-order-dependence';

  async function coupledFirst(): Promise<void> {
    await runtime.runner.run(
      {
        organizationId: multi().alpha.organizationId,
        groupId: multi().alpha.groupOne.id,
        membershipId: multi().alpha.users.scheduler.membershipId,
        correlationId: subjectKey,
      },
      async ({ query }) => {
        await query
          .updateTable('memberships')
          .set({ last_active_at: new Date() })
          .where('id', '=', multi().alpha.users.scheduler.membershipId)
          .execute();
      },
    );
  }

  /** The dependent half: asserts on state `coupledFirst` produced, and says nothing about it. */
  async function coupledSecond(): Promise<void> {
    const { rows } = await admin.query<{ last_active_at: Date | null }>(
      'select last_active_at from memberships where id = $1::uuid',
      [multi().alpha.users.scheduler.membershipId],
    );
    expect(rows[0]?.last_active_at, 'no touch has happened').not.toBeNull();
  }

  it('RED: run second-then-first, the coupled pair FAILS', async () => {
    // The fixture seeds one activity touch per group, so the coupling has to be
    // built on something the seed did NOT establish. Clearing it first is how
    // this red case reaches the state a fresh subject would be in.
    await admin.query('update memberships set last_active_at = null where id = $1::uuid', [
      multi().alpha.users.scheduler.membershipId,
    ]);

    await expect(coupledSecond()).rejects.toThrow();
    log('the coupled pair fails when its unstated precondition has not run');
  });

  it('GREEN: run first-then-second, the same pair passes — so the failure was the ORDER', async () => {
    await admin.query('update memberships set last_active_at = null where id = $1::uuid', [
      multi().alpha.users.scheduler.membershipId,
    ]);

    await coupledFirst();
    await coupledSecond();
    log('the same pair passes in the declared order — the defect is the dependency, not the code');
  });

  it('GREEN: a test that OWNS its state passes in BOTH orders — run both', async () => {
    // R-12(c): this used to run ONE order and claim "either". It now runs both.
    //
    // The state-owning shape is `establish, then assert` as a single unit, so
    // "the other order" means running that unit twice with the state cleared
    // between — which is what order-independence actually means for it.
    const owning = async (): Promise<void> => {
      await admin.query('update memberships set last_active_at = null where id = $1::uuid', [
        multi().alpha.users.scheduler.membershipId,
      ]);
      await coupledFirst();
      await coupledSecond();
    };

    await owning();
    await owning();

    // And the discriminating half: after clearing, the COUPLED shape still fails,
    // so the two shapes are genuinely different rather than both trivially green.
    await admin.query('update memberships set last_active_at = null where id = $1::uuid', [
      multi().alpha.users.scheduler.membershipId,
    ]);
    await expect(coupledSecond()).rejects.toThrow();

    log('the state-owning pair passes run twice from cleared state; the coupled one still fails');
  });
});
