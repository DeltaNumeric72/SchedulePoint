import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate } from '../../src/db/migrate.js';
import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import { digestRows } from '../../src/schedule/render.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * **Migration 0025, up → down → up, over a POPULATED database** — and the
 * FU-20 period-shrink guard it exists for (OPUS-M5-003, doc 42 §5f).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## What 0025 does, and therefore what a cycle of it has to prove
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 0025 creates ONE function and ONE trigger and nothing else. It creates no
 * table, alters no column, replaces no policy, redefines nothing that already
 * existed and widens no grant — so unlike 0022's cycle there is no verbatim body
 * to restore, and the down is two `DROP`s.
 *
 * Four things, then:
 *
 *   1. the guard comes back **ENFORCING** — not merely present. The refusal is
 *      driven, and so is the PERMITTED shrink, because a guard that refused
 *      everything would satisfy a refusal test and break the product;
 *   2. the NAMED EXCLUSIONS behave as the header's table says: an inert row in a
 *      removed week does NOT block, because nothing can remove it;
 *   3. widening is never refused;
 *   4. everything 0025 does not own is untouched, by census.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## FU-20's measurement, asserted rather than described
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The migration's header §3 records the enumeration that chose the covered set:
 * `vacation_selections` has no `DELETE` grant for any role, `week_start` is not
 * in its column-level `UPDATE` grant, and §2's vacation column carries no
 * outgoing edge from `denied`, `withdrawn`, `expired` or `reversed` — so a row in
 * any of the five excluded statuses cannot be removed, re-pointed or moved on.
 * An unconditional guard would therefore make a period permanently unshrinkable
 * past any week that had ever held a selection.
 *
 * **The first two facts are asserted here**, because they are the reason for the
 * exclusion and a grant added later would silently invalidate it.
 *
 * ## BY NAME, never by position — FAD-33(4) / FAD-34(5)
 *
 * The loop's termination condition IS the migration's name, the re-up sits in a
 * `finally`, and the "ran out of migrations" throw sits INSIDE the `try`. An
 * abort with migrations already reversed is the cluster poisoning that idiom
 * exists to prevent.
 *
 * ## Synthetic only
 *
 * Every date is far-future and every label is the fixture's own. No
 * organization, site or person name from the research appears here.
 */

const multi = ownedMulti('requests-migration-0025-cycle', { profile: 'core' });

let runtime: Runtime;
let context: {
  organizationId: string;
  groupId: string;
  membershipId: string;
  correlationId: string;
};

const run = async <T>(fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> =>
  runtime.runner.run(context, fn);

/** The tables the cycle must leave untouched. 0025 owns no table at all. */
const CENSUS: readonly { table: string; columns: readonly string[] }[] = [
  { table: 'vacation_periods', columns: ['id', 'start_date', 'end_date', 'mode', 'state'] },
  { table: 'vacation_selections', columns: ['id', 'week_start', 'status', 'version'] },
  { table: 'vacation_grants', columns: ['id', 'kind', 'week_start', 'units_total'] },
  { table: 'requests', columns: ['id', 'subtype', 'status', 'version'] },
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

/**
 * A round with `weeks` Mondays in it. `start + 7·(weeks−1) + 4` is a Friday
 * whenever the start is a Monday, which is what §5.2's two CHECKs require.
 */
async function createPeriod(startDate: string, weeks: number): Promise<string> {
  const span = 7 * (weeks - 1) + 4;
  return run(async ({ query }) => {
    const inserted = await sql<{ id: string }>`
      insert into vacation_periods
        (organization_id, group_id, start_date, end_date, mode, state)
      values (${context.organizationId}::uuid, ${context.groupId}::uuid,
              ${startDate}::date, (${startDate}::date + ${span}::integer)::date,
              ${'quota'}, ${'open'})
      returning id
    `.execute(query);
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('the fixture period was not inserted');
    return id;
  });
}

/** The Monday `weeks` weeks after `start`. */
function mondayAfter(start: string, weeks: number): string {
  return new Date(Date.parse(`${start}T00:00:00Z`) + weeks * 7 * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * A selection in `status`, with its root where the status needs one.
 *
 * The selection and the root are created in ONE transaction — D-18's zero-row
 * guard is deferred and counts at commit, so a root committed alone raises.
 * Every status but `available` is then reached by walking §5.3's edges with the
 * root following the §5.3 mapping, because D-27 refuses any other pairing.
 */
async function createSelection(
  periodId: string,
  weekStart: string,
  status: 'available' | 'pending' | 'approved' | 'committed' | 'withdrawn' | 'denied',
): Promise<string> {
  return run(async ({ query }) => {
    const inserted = await sql<{ id: string }>`
      insert into vacation_selections
        (organization_id, group_id, membership_id, vacation_period_id, week_start, status)
      values (${context.organizationId}::uuid, ${context.groupId}::uuid,
              ${context.membershipId}::uuid, ${periodId}::uuid, ${weekStart}::date,
              ${'available'})
      returning id
    `.execute(query);
    const selectionId = inserted.rows[0]?.id;
    if (selectionId === undefined) throw new Error('the fixture selection was not inserted');
    if (status === 'available') return selectionId;

    const requestId = randomUUID();
    await sql`
      insert into requests
        (id, organization_id, group_id, membership_id, subtype, status, expires_at,
         idempotency_key, submitted_at)
      values (${requestId}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
              ${context.membershipId}::uuid, ${'vacation-selection'},
              app_request_initial_status(${'vacation-selection'}),
              ${'2099-06-01T00:00:00.000Z'}::timestamptz,
              ${`c25.${randomUUID().slice(0, 12)}`}, now())
    `.execute(query);
    await sql`
      update vacation_selections
         set request_id = ${requestId}::uuid, status = ${'pending'}, version = version + 1
       where id = ${selectionId}::uuid
    `.execute(query);
    if (status === 'pending') return selectionId;

    /* The remaining statuses, each walked with its §5.3 root path. `approved` and
     * `denied` take the BINDING two-step because §2 has no `submitted → approved`
     * or `submitted → denied` cell (M5-000b finding #1). */
    const walk = async (
      selectionStatus: string,
      rootPath: readonly string[],
    ): Promise<void> => {
      await sql`
        update vacation_selections set status = ${selectionStatus}, version = version + 1
         where id = ${selectionId}::uuid
      `.execute(query);
      for (const hop of rootPath) {
        await sql`update requests set status = ${hop} where id = ${requestId}::uuid`.execute(query);
      }
    };

    if (status === 'withdrawn') {
      await walk('withdrawn', ['withdrawn']);
      return selectionId;
    }
    if (status === 'denied') {
      await walk('denied', ['under_review', 'denied']);
      return selectionId;
    }
    await walk('approved', ['under_review', 'approved']);
    if (status === 'committed') await walk('committed', ['reflected_in_version']);
    return selectionId;
  });
}

/** A weekly-capacity grant for one week. `unitsTotal` 0 is the INERT case. */
async function createCapacity(
  periodId: string,
  weekStart: string,
  unitsTotal: number,
): Promise<string> {
  return run(async ({ query }) => {
    const inserted = await sql<{ id: string }>`
      insert into vacation_grants
        (organization_id, group_id, vacation_period_id, kind, week_start, units_total)
      values (${context.organizationId}::uuid, ${context.groupId}::uuid, ${periodId}::uuid,
              ${'weekly-capacity'}, ${weekStart}::date, ${unitsTotal}::integer)
      returning id
    `.execute(query);
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('the fixture grant was not inserted');
    return id;
  });
}

/** Attempts to move a period's bounds. Resolves on success, rejects on refusal. */
async function moveBounds(periodId: string, startDate: string, weeks: number): Promise<void> {
  const span = 7 * (weeks - 1) + 4;
  await run(async ({ query }) => {
    await sql`
      update vacation_periods
         set start_date = ${startDate}::date,
             end_date = (${startDate}::date + ${span}::integer)::date,
             version = version + 1
       where id = ${periodId}::uuid
    `.execute(query);
  });
}

const A = '2071-06-01';
const B = '2072-06-06';
const C = '2073-06-05';
const D = '2074-06-04';
const E = '2075-06-03';

beforeAll(async () => {
  runtime = createRuntime('app_runtime', { max: 2 });
  const alpha = multi().alpha;
  context = {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    membershipId: alpha.users.member.membershipId,
    correlationId: 'requests-migration-0025-cycle',
  };
}, 240_000);

afterAll(async () => {
  await runtime?.destroy();
});

describe('FU-20 — the period-shrink guard, ENFORCING', () => {
  it('REFUSES a shrink that would strand a live selection, and names what it found', async () => {
    const periodId = await createPeriod(A, 4);
    /* Week 3 is a live claim: `pending` is one of the three statuses that still
     * claim the week, and it is the one an administrator CAN remediate today. */
    await createSelection(periodId, mondayAfter(A, 3), 'pending');

    await expect(
      moveBounds(periodId, A, 2),
      'a shrink past a pending selection must be refused',
    ).rejects.toThrow(/VACATION_PERIOD_BOUNDS_STRAND_ROWS/);

    /* And the refusal names the count and the bounds, so a surface can say what
     * to do about it — the courtesy 0023's own guard extends. */
    await expect(moveBounds(periodId, A, 2)).rejects.toThrow(/1 live selection\(s\)/);
  }, 240_000);

  it('REFUSES for `approved` and for `committed` too — everything that still claims', async () => {
    for (const [index, status] of (['approved', 'committed'] as const).entries()) {
      const start = index === 0 ? B : C;
      const periodId = await createPeriod(start, 4);
      await createSelection(periodId, mondayAfter(start, 3), status);
      await expect(
        moveBounds(periodId, start, 2),
        `a shrink past a ${status} selection must be refused`,
      ).rejects.toThrow(/VACATION_PERIOD_BOUNDS_STRAND_ROWS/);
    }
  }, 240_000);

  it('PERMITS a shrink when only EXCLUDED rows sit in the removed weeks', async () => {
    /* The other half, and the half a refusal-only test would miss entirely. The
     * five excluded statuses are inert AND irremediable — no DELETE grant, an
     * immutable `week_start`, and no outgoing §2 edge — so counting them would
     * make this period permanently unshrinkable against rows nobody can remove.
     * That is the deadlock the named exclusion exists to avoid. */
    const periodId = await createPeriod(D, 4);
    await createSelection(periodId, mondayAfter(D, 3), 'withdrawn');
    await createSelection(periodId, mondayAfter(D, 2), 'denied');
    await createSelection(periodId, mondayAfter(D, 1), 'available');

    await moveBounds(periodId, D, 1);

    const after = await run(
      async ({ query }) =>
        await sql<{ start_date: string; end_date: string }>`
          select start_date::text, end_date::text from vacation_periods
           where id = ${periodId}::uuid
        `.execute(query),
    );
    expect(after.rows[0]?.start_date).toBe(D);
    /* One week: Monday to the Friday four days later. */
    expect(after.rows[0]?.end_date).toBe(mondayAfter(D, 0).slice(0, 8) + String(Number(D.slice(8)) + 4).padStart(2, '0'));
  }, 240_000);

  it('never refuses a WIDENING — it strands nothing', async () => {
    const periodId = await createPeriod(E, 2);
    await createSelection(periodId, mondayAfter(E, 1), 'pending');
    /* The same live claim that would refuse a shrink. Widening keeps it inside
     * the round, so a guard that refused this would be blocking the remedy
     * rather than the harm. */
    await moveBounds(periodId, E, 5);
  }, 240_000);

  it('a weekly-capacity grant that ALLOCATES blocks; a zeroed one does not', async () => {
    const start = '2076-06-01';
    const periodId = await createPeriod(start, 4);
    const grantId = await createCapacity(periodId, mondayAfter(start, 3), 2);

    await expect(
      moveBounds(periodId, start, 2),
      'an allocated weekly capacity outside the new bounds must refuse',
    ).rejects.toThrow(/VACATION_PERIOD_BOUNDS_STRAND_ROWS/);

    /* The measured remediation: `units_total` IS in 0022's column-level UPDATE
     * grant, so zeroing the capacity is something an administrator can actually
     * do — which is why grants are covered CONDITIONALLY and no deadlock is
     * introduced. */
    await run(async ({ query }) => {
      await sql`update vacation_grants set units_total = 0, version = version + 1
                 where id = ${grantId}::uuid`.execute(query);
    });
    await moveBounds(periodId, start, 2);
  }, 240_000);

  it('a period whose bounds do NOT move is not this guard’s business', async () => {
    /* The early return. A round changing its `state` under a live selection must
     * still be able to — the only thing this trigger constrains is the bounds. */
    const start = '2077-06-07';
    const periodId = await createPeriod(start, 4);
    await createSelection(periodId, mondayAfter(start, 3), 'pending');
    await run(async ({ query }) => {
      await sql`update vacation_periods set state = ${'closed'}, version = version + 1
                 where id = ${periodId}::uuid`.execute(query);
    });
  }, 240_000);
});

describe('FU-20 — the facts the exclusion RESTS on', () => {
  it('no runtime role holds DELETE on `vacation_selections` or `vacation_grants`', async () => {
    /* The measurement, asserted. A `DELETE` grant added later would give the five
     * excluded statuses a remediation path and the exclusion could be revisited —
     * but silently adding one and leaving the exclusion in place is the drift this
     * assertion exists to catch. */
    const rows = await run(
      async ({ query }) =>
        await sql<{ grantee: string; table_name: string }>`
          select grantee, table_name
            from information_schema.role_table_grants
           where table_name in ('vacation_selections', 'vacation_grants')
             and privilege_type = 'DELETE'
             and grantee in ('app_runtime', 'app_worker', 'app_readonly_support', 'app_breakglass')
        `.execute(query),
    );
    expect(rows.rows).toEqual([]);
  }, 120_000);

  it('`week_start` is not in the UPDATE grant — a selection cannot be re-pointed', async () => {
    const rows = await run(
      async ({ query }) =>
        await sql<{ column_name: string }>`
          select column_name
            from information_schema.column_privileges
           where table_name = 'vacation_selections'
             and privilege_type = 'UPDATE'
             and grantee = 'app_runtime'
             and column_name = 'week_start'
        `.execute(query),
    );
    expect(rows.rows, 'a selection whose week could move would need no guard').toEqual([]);
  }, 120_000);
});

describe('migration 0025 over a populated database', () => {
  it('up → down → up, resolved and asserted BY NAME', async () => {
    const periodId = await createPeriod('2078-06-06', 4);
    await createSelection(periodId, mondayAfter('2078-06-06', 3), 'pending');
    const censusBefore = await census();
    expect(censusBefore['vacation_selections']?.count).toBeGreaterThan(0);

    let up: readonly string[] = [];
    let midway: Record<string, { count: number; digest: string }> | undefined;
    const down: string[] = [];
    try {
      while (!down.some((name) => name.includes('0025'))) {
        const step = await migrate('down', { count: 1 });
        if (step.applied.length === 0) {
          throw new Error('ran out of migrations before reaching 0025 — the ledger is empty');
        }
        down.push(...step.applied);
      }
      midway = await census();
    } finally {
      up = (await migrate('up', { count: down.length })).applied;
    }

    /* 0025 owns no table, so the census is identical at the midpoint as well as
     * at the end. That is what "purely additive" reduces to for a migration whose
     * whole content is one function and one trigger. */
    expect(midway, 'the census must have been taken before the re-up').toBeDefined();
    expect(midway).toEqual(censusBefore);

    expect(up).toHaveLength(down.length);
    expect(up.some((name) => name.includes('0025'))).toBe(true);
    expect(await census()).toEqual(censusBefore);
  }, 300_000);

  it('the guard comes back ENFORCING after the round trip, not merely present', async () => {
    /* A trigger that existed but did nothing would satisfy a catalogue query and
     * fail the product. The refusal is DRIVEN again, on a fresh period, after the
     * cycle above has run. */
    const start = '2079-06-05';
    const periodId = await createPeriod(start, 4);
    await createSelection(periodId, mondayAfter(start, 3), 'pending');

    await expect(moveBounds(periodId, start, 2)).rejects.toThrow(
      /VACATION_PERIOD_BOUNDS_STRAND_ROWS/,
    );

    /* And the permitted direction still works, so the re-upped guard is the same
     * guard rather than a stricter one. */
    await moveBounds(periodId, start, 6);
  }, 240_000);
});
