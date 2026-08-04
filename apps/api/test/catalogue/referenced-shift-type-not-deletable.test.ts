import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TENANT_TABLES } from '../../src/db/schema.js';
import { adminClient } from '../support/admin-client.js';
import { groupContext } from '../support/fixtures.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * **NAMED-CONDITION PROOF 1 — a referenced shift type cannot be hard-deleted, at
 * the database.**
 *
 * Packet 30: "Published-referenced shift type cannot be hard-deleted
 * (database-level)". The requirement is `archive-not-delete for referenced
 * rows`, and it is proven here at the layer where it cannot be bypassed by
 * forgetting to call something.
 *
 * ## Two independent controls, each isolated so a pass names which one worked
 *
 * | Control | Refuses | SQLSTATE |
 * |---|---|---|
 * | **No DELETE grant** for any runtime role, on any tenant table | the application, always | `42501` |
 * | **`NO ACTION` composite child FKs** — PostgreSQL's default, no referential action declared | the table OWNER too | `23503` |
 *
 * The second one matters because the first is only as strong as the grant list:
 * a future migration that granted DELETE "just for cleanup" would silently
 * remove control 1, and control 2 would still refuse. The proof exercises both,
 * separately, and reports which SQLSTATE each produced.
 *
 * **`NO ACTION`, not `RESTRICT`** — this row said RESTRICT and was untrue of the
 * SQL it described. For this purpose the two are equivalent: both raise `23503`
 * on a DELETE whose row is still referenced. They differ only in when the check
 * runs (`NO ACTION` is deferrable and evaluated at end of statement, `RESTRICT`
 * is immediate), and nothing here defers a constraint.
 *
 * ## The ALLOW control comes first
 *
 * FAD-15 vacuity discipline. A deletion that fails proves nothing unless a
 * deletion that should succeed does succeed: without it, a typo in the table
 * name, an empty table, or an already-aborted transaction all produce the same
 * green. So an **unreferenced** shift type is deleted by the owner first, and it
 * must actually go — then the referenced one is attempted and must be refused.
 */

const multi = ownedMulti('catalogue-referenced-not-deletable', {
  seed: { catalogue: ['alpha'] },
});

let admin: pg.Client;
let runtime: Runtime;

const alpha = () => multi().alpha;

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  runtime = createRuntime('app_runtime', { max: 3 });
}, 120_000);

afterAll(async () => {
  await runtime.destroy();
  await admin.end();
});

describe('archive-not-delete, proven at the database', () => {
  it('CONTROL: the owner CAN delete an UNREFERENCED shift type — so the refusals below mean something', async () => {
    // Created through the production path — a superuser INSERT would still fire
    // `shift_types_guard_administration`, which is the control working (a
    // trigger is not RLS and fires for superusers too; the same surprise cost
    // OPUS-M2-001 a debugging session).
    //
    // Deleted as the SUPERUSER, which is a strictly stronger deleter than any
    // runtime role: if even it were blocked here, the refusals below would be
    // telling us nothing about foreign keys.
    const { createShiftType } = await import('../../src/catalogue/service.js');
    const id = await runtime.runner.run(
      groupContext(
        alpha().organizationId,
        alpha().groupOne.id,
        alpha().users.scheduler.membershipId,
        'archive-control',
      ),
      async (uow) => {
        const created = await createShiftType(uow, {
          code: 'TMPCTL',
          name: 'Temporary control',
          description: null,
          displayPaletteKey: 'neutral',
          displayTextStyle: 'regular',
          startTime: '07:00',
          endTime: '19:00',
          isOnCall: false,
          attractsStipend: false,
          isManualOnly: false,
          isDailyPick: false,
          includeInStatistics: true,
          isLeaveOfAbsence: false,
          allowOnRequest: false,
          allowOffRequest: false,
          reportOrder: 0,
          creditWeight: 1,
        });
        if (created.kind !== 'ok') throw new Error(`control setup reported ${created.kind}`);
        return created.value.shiftTypeId;
      },
    );

    const deleted = await admin.query('delete from shift_types where id = $1', [id]);
    expect(deleted.rowCount, 'the control deletion did not remove a row').toBe(1);

    const survivors = await admin.query<{ n: number }>(
      'select count(*)::int as n from shift_types where id = $1',
      [id],
    );
    expect(survivors.rows[0]?.n).toBe(0);
    log('CONTROL: an unreferenced shift type is deletable by the owner — the probe can delete');
  });

  it('the OWNER cannot delete a shift type referenced by a shift group, valid group or demand row', async () => {
    const referenced = multi.catalogue().shiftTypeIds[0];
    if (referenced === undefined) throw new Error('the fixture seeded no shift types');

    // Every reference is established by the fixture through the production path:
    // a demand row, a shift-group membership and a valid-group membership.
    const references = await admin.query<{ table_name: string; n: number }>(
      `select 'shift_type_weekday_demand' as table_name,
              count(*)::int as n from shift_type_weekday_demand where shift_type_id = $1
       union all
       select 'shift_group_members', count(*)::int from shift_group_members where shift_type_id = $1
       union all
       select 'valid_group_shift_types', count(*)::int from valid_group_shift_types where shift_type_id = $1`,
      [referenced],
    );
    for (const row of references.rows) {
      expect(row.n, `${row.table_name} references nothing — the proof would be vacuous`).toBeGreaterThan(0);
    }

    await expect(
      admin.query('delete from shift_types where id = $1', [referenced]),
    ).rejects.toMatchObject({ code: '23503' });

    const survivor = await admin.query<{ n: number }>(
      'select count(*)::int as n from shift_types where id = $1',
      [referenced],
    );
    expect(survivor.rows[0]?.n, 'the referenced shift type was deleted').toBe(1);
    log(
      `OWNER delete of a referenced shift type → 23503 (foreign_key_violation); references: ${references.rows
        .map((row) => `${row.table_name}=${String(row.n)}`)
        .join(', ')}`,
    );
  });

  it('no runtime role holds DELETE on ANY of the nine catalogue tables', async () => {
    const catalogueTables = TENANT_TABLES.filter((table) =>
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
    expect(catalogueTables, 'the catalogue tables are not registered').toHaveLength(9);

    let pairs = 0;
    for (const role of ['app_runtime', 'app_worker', 'app_readonly_support', 'app_breakglass']) {
      for (const table of catalogueTables) {
        const result = await admin.query<{ allowed: boolean }>(
          'select has_table_privilege($1, $2, $3) as allowed',
          [role, table.name, 'DELETE'],
        );
        expect(
          result.rows[0]?.allowed,
          `${role} holds DELETE on ${table.name} — doc 06 §1 permits no hard delete of tenant data`,
        ).toBe(false);
        pairs += 1;
      }
    }
    log(`${String(pairs)} (role, catalogue table) pairs checked; DELETE granted nowhere`);
  });

  it('an attempted DELETE under app_runtime is refused 42501 INSIDE the unit of work', async () => {
    // Stronger than "affects zero rows": the statement is refused outright, so a
    // retirement path that tried to hard-delete would fail loudly in development
    // rather than quietly doing nothing.
    const referenced = multi.catalogue().shiftTypeIds[0];
    if (referenced === undefined) throw new Error('the fixture seeded no shift types');

    await expect(
      runtime.runner.run(
        groupContext(
          alpha().organizationId,
          alpha().groupOne.id,
          alpha().users.scheduler.membershipId,
        ),
        ({ query }) => query.deleteFrom('shift_types').where('id', '=', referenced).execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    log('app_runtime DELETE on shift_types → 42501, inside the wrapper');
  });

  it('RETIREMENT is the path that works, and it keeps every reference resolvable', async () => {
    const referenced = multi.catalogue().shiftTypeIds[1];
    if (referenced === undefined) throw new Error('the fixture seeded fewer than two shift types');

    await runtime.runner.run(
      groupContext(
        alpha().organizationId,
        alpha().groupOne.id,
        alpha().users.scheduler.membershipId,
      ),
      async (uow) => {
        const { updateShiftType } = await import('../../src/catalogue/service.js');
        const outcome = await updateShiftType(uow, referenced, { status: 'retired' });
        expect(outcome.kind).toBe('ok');
      },
    );

    const row = await admin.query<{ status: string; effective_to: Date | null }>(
      'select status, effective_to from shift_types where id = $1',
      [referenced],
    );
    expect(row.rows[0]?.status).toBe('retired');
    expect(row.rows[0]?.effective_to, 'retirement did not close the in-force window').not.toBeNull();

    // The references survive, which is the whole point: a published schedule
    // that cites this type still resolves it.
    const members = await admin.query<{ n: number }>(
      'select count(*)::int as n from shift_group_members where shift_type_id = $1',
      [referenced],
    );
    expect(members.rows[0]?.n).toBeGreaterThan(0);
    log('retirement: status → retired, effective_to closed, every reference still resolvable');
  });
});
