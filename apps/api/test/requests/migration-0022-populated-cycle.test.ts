import { randomUUID } from 'node:crypto';

import { VACATION_STATUS_TO_REQUEST_STATUS } from '@schedulepoint/domain';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate } from '../../src/db/migrate.js';
import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import { digestRows } from '../../src/schedule/render.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * **Migration 0022, up → down → up, over a POPULATED database** (OPUS-M5-000b;
 * doc 42 §5b Acceptance, "a populated cycle per new migration").
 *
 * ## BY NAME, never by position — FAD-33(4) / FAD-34(5)
 *
 * As in every cycle file here: the loop's termination condition IS the
 * migration's name, the re-up sits in a `finally`, and the "ran out of
 * migrations" throw sits INSIDE the `try`.
 *
 * 0022 additionally REPLACES a function body 0021 created
 * (`app_guard_request_subtype_row`, widened to count the sixth subtype table),
 * so its down migration restores 0021's body verbatim. That is a thing a cycle
 * can silently get wrong in a way no row census would notice, so it is asserted
 * directly: after the cycle, a `vacation-selection` root with its selection row
 * must still commit — which it could not if the narrower body had survived the
 * re-up.
 *
 * ## What is proven here, against SPEC-08 §7
 *
 *   R-16      one `vacation_selections` row, zero in the other five; D-19
 *             rejects a vacation row missing `vacation_period_id` or
 *             `week_start`, or carrying `shift_type_id`
 *   R-15      the §5.3 mapping after every transition; a deliberately
 *             desynchronised write RAISES (D-27) — from both sides
 *   R-20/R-21 the override raises the bound and a reversal decrements both
 *             counters; a direct `UPDATE` below zero or above the bound is
 *             refused by the unconditional CHECKs, on every path
 *   R-13      a period in `open` mode has no grants, and that is not an error
 *
 * ## The negatives are raw statements, deliberately
 *
 * A negative proved through a service proves the service refused it. These have
 * to be the DATABASE refusing, so they are issued directly, inside a real unit
 * of work under transaction-local tenant context.
 */

const multi = ownedMulti('requests-migration-0022-cycle', {
  profile: 'core',
  seed: { catalogue: ['alpha'] },
});

let runtime: Runtime;
let context: {
  organizationId: string;
  groupId: string;
  membershipId: string;
  correlationId: string;
};
let membershipId: string;
let shiftTypeId: string;

const run = async <T>(fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> =>
  runtime.runner.run(context, fn);

const CENSUS: readonly { table: string; columns: readonly string[] }[] = [
  { table: 'shift_types', columns: ['id', 'code', 'name'] },
  { table: 'memberships', columns: ['id', 'user_id', 'kind', 'group_role'] },
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

/** `YYYY-MM-DD` for `base` plus `days`, without going through a local timezone. */
function plusDays(base: string, days: number): string {
  const at = new Date(`${base}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/**
 * A two-week round: Monday of week one to Friday of week two.
 *
 * Two weeks rather than one because the week-in-period trigger is real — a
 * one-week period refuses a selection in its second week, which is how the first
 * version of the sweep fixture was caught.
 */
async function createPeriod(start: string, mode: 'quota' | 'open'): Promise<string> {
  return run(async ({ query }) => {
    const id = randomUUID();
    await sql`
      insert into vacation_periods
        (id, organization_id, group_id, start_date, end_date, mode, state)
      values (${id}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
              ${start}::date, ${plusDays(start, 11)}::date, ${mode}, ${'open'})
    `.execute(query);
    return id;
  });
}

async function createGrant(periodId: string, unitsTotal: number, consumed = 0): Promise<string> {
  return run(async ({ query }) => {
    const id = randomUUID();
    await sql`
      insert into vacation_grants
        (id, organization_id, group_id, vacation_period_id, kind, membership_id,
         units_total, units_consumed)
      values (${id}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
              ${periodId}::uuid, ${'personal-entitlement'}, ${membershipId}::uuid,
              ${unitsTotal}, ${consumed})
    `.execute(query);
    return id;
  });
}

/** An `available` selection — no request row, by §5.3. */
async function createAvailableSelection(periodId: string, weekStart: string): Promise<string> {
  return run(async ({ query }) => {
    const id = randomUUID();
    await sql`
      insert into vacation_selections
        (id, organization_id, group_id, request_id, membership_id, vacation_period_id,
         week_start, status)
      values (${id}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
              null, ${membershipId}::uuid, ${periodId}::uuid, ${weekStart}::date, ${'available'})
    `.execute(query);
    return id;
  });
}

/**
 * A SUBMITTED vacation request: the root at `submitted` and its selection at
 * `pending`, which is §5.3's mapping holding.
 */
async function createPendingVacation(
  periodId: string,
  weekStart: string,
): Promise<{ requestId: string; selectionId: string }> {
  return run(async ({ query }) => {
    const requestId = randomUUID();
    const selectionId = randomUUID();
    await sql`
      insert into requests
        (id, organization_id, group_id, membership_id, subtype, status, expires_at,
         idempotency_key)
      values (${requestId}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
              ${membershipId}::uuid, ${'vacation-selection'}, ${'submitted'},
              ${'2099-06-01T00:00:00.000Z'}::timestamptz,
              ${`cycle22.${randomUUID().slice(0, 12)}`})
    `.execute(query);
    await sql`
      insert into vacation_selections
        (id, organization_id, group_id, request_id, membership_id, vacation_period_id,
         week_start, status)
      values (${selectionId}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
              ${requestId}::uuid, ${membershipId}::uuid, ${periodId}::uuid,
              ${weekStart}::date, ${'pending'})
    `.execute(query);
    return { requestId, selectionId };
  });
}

async function grantRow(
  grantId: string,
): Promise<{ units_total: number; units_consumed: number; override_units: number } | undefined> {
  const rows = await run(
    async ({ query }) =>
      await sql<{ units_total: number; units_consumed: number; override_units: number }>`
        select units_total, units_consumed, override_units
          from vacation_grants where id = ${grantId}::uuid
      `.execute(query),
  );
  return rows.rows[0];
}

beforeAll(async () => {
  runtime = createRuntime('app_runtime', { max: 4 });
  const alpha = multi().alpha;
  const seededShiftType = multi.catalogue('alpha').shiftTypeIds[0];
  if (seededShiftType === undefined) throw new Error('the alpha catalogue seed produced no shift type');
  shiftTypeId = seededShiftType;
  membershipId = alpha.users.scheduler.membershipId;
  context = {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    membershipId,
    correlationId: 'requests-migration-0022-cycle',
  };
}, 240_000);

afterAll(async () => {
  await runtime?.destroy();
});

describe('migration 0022 over a populated database', () => {
  it('up → down → up, resolved and asserted BY NAME', async () => {
    const periodId = await createPeriod('2047-01-07', 'quota');
    await createGrant(periodId, 3);
    await createPendingVacation(periodId, '2047-01-07');
    const censusBefore = await census();

    const selectionsBefore = await run(
      async ({ query }) =>
        await sql<{ n: string }>`select count(*)::text as n from vacation_selections`.execute(
          query,
        ),
    );
    expect(Number(selectionsBefore.rows[0]?.n)).toBeGreaterThan(0);

    let up: readonly string[] = [];
    let midway: Record<string, { count: number; digest: string }> | undefined;
    const down: string[] = [];
    try {
      while (!down.some((name) => name.includes('0022'))) {
        const step = await migrate('down', { count: 1 });
        if (step.applied.length === 0) {
          throw new Error('ran out of migrations before reaching 0022 — the ledger is empty');
        }
        down.push(...step.applied);
      }
      midway = await census();
    } finally {
      up = (await migrate('up', { count: down.length })).applied;
    }

    expect(midway, 'the census must have been taken before the re-up').toBeDefined();
    expect(midway).toEqual(censusBefore);
    expect(up).toHaveLength(down.length);
    expect(up.some((name) => name.includes('0022'))).toBe(true);
    expect(await census()).toEqual(censusBefore);

    /* The four tables 0022 CREATES do not survive its own `DROP TABLE`. Stated
     * rather than glossed. */
    const selectionsAfter = await run(
      async ({ query }) =>
        await sql<{ n: string }>`select count(*)::text as n from vacation_selections`.execute(
          query,
        ),
    );
    expect(selectionsAfter.rows[0]?.n).toBe('0');

    /* The schema WORKS again — and specifically, the WIDENED subtype-row guard
     * came back. 0022 replaces 0021's `app_guard_request_subtype_row` body with
     * one that counts `vacation_selections`; if the re-up had left the narrower
     * body in place, this write would be refused at commit with
     * `REQUEST_SUBTYPE_ROW_REQUIRED` even though its selection row exists. No row
     * census would notice that, which is why it is asserted here. */
    const rebuiltPeriod = await createPeriod('2047-03-04', 'quota');
    const rebuilt = await createPendingVacation(rebuiltPeriod, '2047-03-04');
    expect(rebuilt.requestId).toMatch(/^[0-9a-f-]{36}$/);
  }, 300_000);

  it('MUTATION CONTROL: D-21 and D-27 are enforcing again after the cycle', async () => {
    /* A down that dropped a CHECK or a trigger and an up that forgot to restore
     * it would leave every digest above identical and the case above green.
     * These two are the only assertions in the file that would notice. */
    const periodId = await createPeriod('2047-05-06', 'quota');
    const grantId = await createGrant(periodId, 1, 1);

    await expect(
      run(
        async ({ query }) =>
          await sql`update vacation_grants set units_consumed = units_consumed + 1
                     where id = ${grantId}::uuid`.execute(query),
      ),
    ).rejects.toMatchObject({ code: '23514' });

    const { requestId } = await createPendingVacation(periodId, '2047-05-06');
    await expect(
      run(
        async ({ query }) =>
          await sql`update requests set status = 'withdrawn'
                     where id = ${requestId}::uuid`.execute(query),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('VACATION_STATUS_MAPPING_VIOLATED'),
    });
  }, 240_000);
});

describe('R-16 — the sixth subtype under D-18 and D-19', () => {
  it('exactly ONE vacation_selections row and ZERO in the other five', async () => {
    const periodId = await createPeriod('2047-07-01', 'quota');
    const { requestId } = await createPendingVacation(periodId, '2047-07-01');

    const counts = await run(
      async ({ query }) =>
        await sql<{ table_name: string; n: string }>`
          select 'vacation_selections' as table_name, count(*)::text as n
            from vacation_selections where request_id = ${requestId}::uuid
          union all select 'request_availability', count(*)::text
            from request_availability where request_id = ${requestId}::uuid
          union all select 'request_time_off', count(*)::text
            from request_time_off where request_id = ${requestId}::uuid
          union all select 'request_no_call', count(*)::text
            from request_no_call where request_id = ${requestId}::uuid
          union all select 'request_shift_preference', count(*)::text
            from request_shift_preference where request_id = ${requestId}::uuid
          union all select 'request_shift_group_off', count(*)::text
            from request_shift_group_off where request_id = ${requestId}::uuid
        `.execute(query),
    );

    expect(Object.fromEntries(counts.rows.map((row) => [row.table_name, row.n]))).toEqual({
      vacation_selections: '1',
      request_availability: '0',
      request_time_off: '0',
      request_no_call: '0',
      request_shift_preference: '0',
      request_shift_group_off: '0',
    });

    /* And a row in one of the other five for this request is refused by the
     * composite FK, because the root's discriminator travels with the reference
     * — which is what makes the zeroes above a guarantee rather than an
     * observation. */
    await expect(
      run(
        async ({ query }) =>
          await sql`
            insert into request_availability (request_id, organization_id, group_id, target_date)
            values (${requestId}::uuid, ${context.organizationId}::uuid,
                    ${context.groupId}::uuid, ${'2047-07-01'}::date)
          `.execute(query),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  }, 180_000);

  it('D-19: a vacation row MISSING vacation_period_id or week_start is REJECTED', async () => {
    const periodId = await createPeriod('2047-09-02', 'quota');

    await expect(
      run(
        async ({ query }) =>
          await sql`
            insert into vacation_selections
              (organization_id, group_id, membership_id, week_start, status)
            values (${context.organizationId}::uuid, ${context.groupId}::uuid,
                    ${membershipId}::uuid, ${'2047-09-02'}::date, ${'available'})
          `.execute(query),
      ),
      'a selection with no period must be refused',
    ).rejects.toMatchObject({ code: '23502' });

    await expect(
      run(
        async ({ query }) =>
          await sql`
            insert into vacation_selections
              (organization_id, group_id, membership_id, vacation_period_id, status)
            values (${context.organizationId}::uuid, ${context.groupId}::uuid,
                    ${membershipId}::uuid, ${periodId}::uuid, ${'available'})
          `.execute(query),
      ),
      'a selection with no week must be refused',
    ).rejects.toMatchObject({ code: '23502' });
  }, 180_000);

  it('D-19: the PROHIBITED fields are ABSENT, enumerated against §1.2', async () => {
    /* §1.2's prohibited list for `vacation-selection`, transcribed. Prohibition
     * is realized as absence (migration 0021 header §2) — strictly stronger than
     * an always-NULL column, and this is what keeps it from being an accident of
     * which columns someone happened to declare. */
    const prohibited = [
      'shift_type_id',
      'shift_group_id',
      'preference_strength',
      'target_date',
      'range_start',
      'range_end',
    ];
    const present = await run(
      async ({ query }) =>
        await sql<{ column_name: string }>`
          select column_name from information_schema.columns
           where table_schema = 'public'
             and table_name = 'vacation_selections'
             and column_name = any(${prohibited}::text[])
        `.execute(query),
    );
    expect(
      present.rows.map((row) => row.column_name),
      'vacation_selections carries a field §1.2 prohibits',
    ).toEqual([]);

    /* R-16's rejection half: the write that CARRIES one is refused, before any
     * row is evaluated. */
    const periodId = await createPeriod('2047-11-04', 'quota');
    await expect(
      run(
        async ({ query }) =>
          await sql`
            insert into vacation_selections
              (organization_id, group_id, membership_id, vacation_period_id, week_start,
               status, shift_type_id)
            values (${context.organizationId}::uuid, ${context.groupId}::uuid,
                    ${membershipId}::uuid, ${periodId}::uuid, ${'2047-11-04'}::date,
                    ${'available'}, ${shiftTypeId}::uuid)
          `.execute(query),
      ),
    ).rejects.toMatchObject({ code: '42703' });
  }, 180_000);

  it('a week OUTSIDE its period is REJECTED', async () => {
    const periodId = await createPeriod('2048-01-06', 'quota');
    await expect(
      run(
        async ({ query }) =>
          await sql`
            insert into vacation_selections
              (organization_id, group_id, membership_id, vacation_period_id, week_start, status)
            values (${context.organizationId}::uuid, ${context.groupId}::uuid,
                    ${membershipId}::uuid, ${periodId}::uuid, ${'2048-03-02'}::date,
                    ${'available'})
          `.execute(query),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('VACATION_WEEK_OUTSIDE_PERIOD'),
    });
  }, 120_000);
});

describe('§5.3 / D-27 — the derived root status', () => {
  it('an `available` selection with a NULL request_id coexists legally', async () => {
    /* The POSITIVE leg of the nullable-`request_id` design. §5.3's first mapping
     * row is "*no request row yet* — a selection becomes a request at
     * submission", so `available` is the one state with no root. A D-27 guard
     * that raised on it, or a `NOT NULL` column, would refuse the one state the
     * specification defines as pre-request — and every negative case in this
     * file would still pass. */
    const periodId = await createPeriod('2048-03-02', 'quota');
    const selectionId = await createAvailableSelection(periodId, '2048-03-02');

    const row = await run(
      async ({ query }) =>
        await sql<{ request_id: string | null; status: string }>`
          select request_id, status from vacation_selections where id = ${selectionId}::uuid
        `.execute(query),
    );
    expect(row.rows[0]).toEqual({ request_id: null, status: 'available' });

    /* …and the CHECK that pins the correspondence works in BOTH directions, so
     * `available` cannot acquire a request and a submitted selection cannot lose
     * one. */
    const { requestId } = await createPendingVacation(periodId, plusDays('2048-03-02', 7));
    await expect(
      run(
        async ({ query }) =>
          await sql`update vacation_selections set request_id = ${requestId}::uuid
                     where id = ${selectionId}::uuid`.execute(query),
      ),
      'an `available` selection may not name a request',
    ).rejects.toMatchObject({ code: '23514' });
  }, 180_000);

  it('R-15: a deliberately DESYNCHRONISED write raises, from BOTH sides', async () => {
    const periodId = await createPeriod('2048-05-04', 'quota');

    /* Side one: move the ROOT and leave the selection. The edge taken is legal
     * under §2's vacation column (`submitted → under_review`), so the transition
     * trigger admits it — and D-27 refuses it at commit, because no
     * `vacation_selections.status` maps to `under_review`. Two layers composing,
     * the stronger one winning. */
    const first = await createPendingVacation(periodId, '2048-05-04');
    await expect(
      run(
        async ({ query }) =>
          await sql`update requests set status = 'under_review'
                     where id = ${first.requestId}::uuid`.execute(query),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('VACATION_STATUS_MAPPING_VIOLATED'),
    });

    /* Side two: move the SELECTION and leave the root. A trigger only on
     * `requests` would not notice this at all — and §5.3's whole complaint is
     * that two rows could disagree about whether a vacation request had been
     * withdrawn. */
    const second = await createPendingVacation(periodId, plusDays('2048-05-04', 7));
    await expect(
      run(
        async ({ query }) =>
          await sql`update vacation_selections set status = 'withdrawn'
                     where id = ${second.selectionId}::uuid`.execute(query),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('VACATION_STATUS_MAPPING_VIOLATED'),
    });
  }, 240_000);

  it('DEFERRED, both legs — the §5.4-shaped writer commits, a one-sided one does not', async () => {
    const periodId = await createPeriod('2048-07-06', 'quota');

    /* LEG ONE — TRANSIENTLY inconsistent, consistent at COMMIT, MUST SUCCEED.
     *
     * This is §5.4's shape: update `vacation_selections`, then update `requests`,
     * in that order, in one transaction. Between the two statements the rows
     * disagree. An IMMEDIATE D-27 would refuse the first statement and therefore
     * refuse every legal approval M5-002 will ever write — while every negative
     * case in this file stayed green. That is the failure this leg exists to
     * catch, and it caught one: the guard's first draft trusted the trigger's
     * `NEW`, which a deferred trigger delivers as of the firing STATEMENT rather
     * than as of commit.
     *
     * ── AND A FINDING FOR M5-002, proven here rather than asserted ──
     *
     * §5.4's pseudocode writes the root in ONE statement:
     * `UPDATE requests SET status = 'approved'`. That statement is REFUSED, and
     * not by D-27: §2's vacation column has no `submitted → approved` edge — the
     * only route to `approved` is via `under_review`. So the legal spelling is
     * the two-step below, INSIDE the one transaction: the intermediate
     * `under_review` never exists at commit, so D-27 (which forbids it, because
     * no selection status maps to it) never sees it. The deferred design is what
     * makes §5.4 implementable at all. */
    const approved = await createPendingVacation(periodId, '2048-07-06');
    await run(async ({ query }) => {
      await sql`update vacation_selections set status = 'approved', version = version + 1
                 where id = ${approved.selectionId}::uuid`.execute(query);
      await sql`update requests set status = 'under_review'
                 where id = ${approved.requestId}::uuid`.execute(query);
      await sql`update requests set status = 'approved'
                 where id = ${approved.requestId}::uuid`.execute(query);
    });

    const settled = await run(
      async ({ query }) =>
        await sql<{ root: string; selection: string }>`
          select r.status as root, v.status as selection
            from requests r join vacation_selections v on v.request_id = r.id
           where r.id = ${approved.requestId}::uuid
        `.execute(query),
    );
    expect(settled.rows[0], 'a transiently-inconsistent transaction must commit').toEqual({
      root: 'approved',
      selection: 'approved',
    });

    /* The single-statement spelling §5.4 prescribes, shown refused — so the
     * finding above is evidence rather than a claim. */
    const direct = await createPendingVacation(periodId, plusDays('2048-07-06', 7));
    await expect(
      run(async ({ query }) => {
        await sql`update vacation_selections set status = 'approved'
                   where id = ${direct.selectionId}::uuid`.execute(query);
        await sql`update requests set status = 'approved'
                   where id = ${direct.requestId}::uuid`.execute(query);
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('REQUEST_TRANSITION_ILLEGAL') });

    /* LEG TWO — still inconsistent AT COMMIT, MUST BE REFUSED. Both legs are
     * asserted because neither alone distinguishes a working deferred guard from
     * a broken one: a guard that secretly fired immediately would pass leg two
     * and fail leg one, and one that never fired would pass leg one and fail
     * leg two. */
    /* A period of its own: D-22 admits one selection per (membership, period,
     * week) and this file's member has already used both of the two weeks the
     * period above contains. */
    const oneSidedPeriod = await createPeriod('2048-08-03', 'quota');
    const oneSided = await createPendingVacation(oneSidedPeriod, '2048-08-03');
    await expect(
      run(async ({ query }) => {
        await sql`update vacation_selections set status = 'approved'
                   where id = ${oneSided.selectionId}::uuid`.execute(query);
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('VACATION_STATUS_MAPPING_VIOLATED'),
    });
  }, 300_000);

  it('DEFERRED on the SELECTION side: the selection moves TWICE in one transaction', async () => {
    /* **The leg that discriminates the SELECTION branch of the guard**, added
     * under review condition C-1.
     *
     * The case above proves the deferred property from the REQUESTS side: it
     * drives the root through two statuses in one transaction, so a guard that
     * trusted the trigger's `NEW` there would compare a stale root status and
     * refuse a legal writer. It does NOT discriminate the other branch — the
     * reviewer mutated `app_guard_vacation_status_mapping`'s
     * `vacation_selections` branch to read `NEW.request_id` / `NEW.status`
     * instead of re-reading the row, and every test in this file still passed.
     * The shipped code was correct; the property was simply unproven on that
     * side, which is exactly the state in which a later refactor reintroduces
     * the defect and nothing objects.
     *
     * So this drives the SELECTION twice in one transaction:
     *
     *     vacation_selections   pending → approved → committed
     *     requests              submitted → under_review → approved
     *                                     → reflected_in_version
     *
     * Every edge is legal. §5.3 maps `approved → approved` and
     * `committed → reflected_in_version`; §2's vacation column carries
     * `submitted → under_review`, `under_review → approved`, and
     * `approved → reflected_in_version` (the vacation-only commit edge, §5.6).
     * The `under_review` step is the intermediate the file's other cases
     * already explain: no selection status maps to it, so it exists only
     * inside the transaction and D-27 never sees it at commit.
     *
     * WHY IT DISCRIMINATES. A deferred trigger queues one event per
     * row-modification. The selection is modified twice, so two events are
     * queued, and the FIRST carries `NEW.status = 'approved'`. Under a
     * `NEW`-trusting branch that event compares its expected root
     * (`approved`) against the root as it stands AT COMMIT
     * (`reflected_in_version`) and raises. Under the current-row read it sees
     * the selection's committed state, expects `reflected_in_version`, and
     * matches. One legal transaction, opposite outcomes — which is what a
     * discriminating test is.
     */
    const periodId = await createPeriod('2049-09-06', 'quota');
    const { requestId, selectionId } = await createPendingVacation(periodId, '2049-09-06');

    await run(async ({ query }) => {
      await sql`update vacation_selections set status = 'approved', version = version + 1
                 where id = ${selectionId}::uuid`.execute(query);
      await sql`update requests set status = 'under_review'
                 where id = ${requestId}::uuid`.execute(query);
      await sql`update requests set status = 'approved'
                 where id = ${requestId}::uuid`.execute(query);

      /* The SECOND selection write. This is the statement the case above never
       * makes, and its queued event is the one a NEW-trusting branch gets
       * wrong. */
      /* OPUS-M5-004: migration 0027's
       * `vacation_selections_committed_version_coherent` makes
       * `(status = 'committed') = (committed_to_version_id IS NOT NULL)` an
       * EQUALITY, so a fixture that moved a selection to `committed` without
       * naming a version is refused by the database. The version below is a real
       * DRAFT one created for this file; nothing about the case is weakened —
       * the statement it is about, and the deferred event it queues, are
       * unchanged. */
      const committedVersionId = await draftVersionForCommit(query);
      await sql`update vacation_selections
                   set status = 'committed',
                       committed_to_version_id = ${committedVersionId}::uuid,
                       version = version + 1
                 where id = ${selectionId}::uuid`.execute(query);
      await sql`update requests set status = 'reflected_in_version'
                 where id = ${requestId}::uuid`.execute(query);
    });

    const settled = await run(
      async ({ query }) =>
        await sql<{ root: string; selection: string; version: number }>`
          select r.status as root, v.status as selection, v.version
            from requests r join vacation_selections v on v.request_id = r.id
           where r.id = ${requestId}::uuid
        `.execute(query),
    );
    expect(
      settled.rows[0],
      'a selection moved twice in one transaction must commit, and the mapping must hold',
    ).toEqual({ root: 'reflected_in_version', selection: 'committed', version: 3 });
  }, 240_000);

  it('the §5.3 mapping constant and the database function agree, row for row', async () => {
    /* A constant and a database rule that drift produce a save which fails for no
     * visible reason. The domain's copy is what a caller consults to know what to
     * write; this asserts it is the same table D-27 enforces against. */
    const rows = await run(
      async ({ query }) =>
        await sql<{ selection_status: string; derived: string | null }>`
          select s as selection_status, app_vacation_derived_request_status(s) as derived
            from unnest(${Object.keys(
              VACATION_STATUS_TO_REQUEST_STATUS,
            )}::text[]) as s
        `.execute(query),
    );

    expect(
      Object.fromEntries(rows.rows.map((row) => [row.selection_status, row.derived])),
    ).toEqual(VACATION_STATUS_TO_REQUEST_STATUS);
  }, 120_000);
});

describe('D-21 — the two unconditional CHECKs, and the audited override', () => {
  it('R-21: a direct UPDATE below zero or above the bound is REJECTED', async () => {
    const periodId = await createPeriod('2048-09-07', 'quota');
    const grantId = await createGrant(periodId, 2, 1);

    await expect(
      run(
        async ({ query }) =>
          await sql`update vacation_grants set units_consumed = -1
                     where id = ${grantId}::uuid`.execute(query),
      ),
      'units_consumed >= 0 is unconditional',
    ).rejects.toMatchObject({ code: '23514' });

    await expect(
      run(
        async ({ query }) =>
          await sql`update vacation_grants set units_consumed = 3
                     where id = ${grantId}::uuid`.execute(query),
      ),
      'units_consumed <= units_total + override_units is unconditional',
    ).rejects.toMatchObject({ code: '23514' });

    /* `override_units` itself cannot go negative either — otherwise the bound
     * could be LOWERED below `units_total`, which is a different way to reach the
     * same corrupt state. */
    await expect(
      run(
        async ({ query }) =>
          await sql`update vacation_grants set override_units = -1
                     where id = ${grantId}::uuid`.execute(query),
      ),
    ).rejects.toMatchObject({ code: '23514' });

    /* …and a legal move still works, so the arms above are not passing because
     * the column is frozen. */
    await run(
      async ({ query }) =>
        await sql`update vacation_grants set units_consumed = 2
                   where id = ${grantId}::uuid`.execute(query),
    );
    expect(await grantRow(grantId)).toMatchObject({ units_consumed: 2, override_units: 0 });
  }, 240_000);

  it('R-20: the override RAISES the bound, and a reversal decrements BOTH', async () => {
    const periodId = await createPeriod('2048-11-02', 'quota');
    const grantId = await createGrant(periodId, 1, 1);

    /* At the bound. A further unit is refused — this is what "advisory, not
     * blocking" was BEFORE V-28, and it is now a real constraint. */
    await expect(
      run(
        async ({ query }) =>
          await sql`update vacation_grants set units_consumed = 2
                     where id = ${grantId}::uuid`.execute(query),
      ),
    ).rejects.toMatchObject({ code: '23514' });

    /* §5.5's override path: raise the bound and consume, in the SAME statement.
     * The constraint is never suspended — a table CHECK cannot be, which is the
     * contradiction V-28 resolved — the BOUND moves, and the relaxation is a
     * visible, audited value on the grant row itself. */
    await run(
      async ({ query }) =>
        await sql`update vacation_grants
                     set override_units = override_units + 1,
                         units_consumed = units_consumed + 1
                   where id = ${grantId}::uuid`.execute(query),
    );
    expect(await grantRow(grantId)).toMatchObject({
      units_total: 1,
      units_consumed: 2,
      override_units: 1,
    });

    /* Reversing an override decrements BOTH, so the bound returns to its
     * pre-override value and an override cannot silently persist as headroom for
     * a later approval. */
    await run(
      async ({ query }) =>
        await sql`update vacation_grants
                     set override_units = override_units - 1,
                         units_consumed = units_consumed - 1
                   where id = ${grantId}::uuid`.execute(query),
    );
    expect(await grantRow(grantId)).toMatchObject({
      units_total: 1,
      units_consumed: 1,
      override_units: 0,
    });

    /* And no headroom remains: the same over-bound write is refused again. If the
     * reversal had decremented only `units_consumed`, this would now succeed —
     * which is precisely the silent headroom R-20 names. */
    await expect(
      run(
        async ({ query }) =>
          await sql`update vacation_grants set units_consumed = 2
                     where id = ${grantId}::uuid`.execute(query),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  }, 240_000);
});

describe('D-22, D-26, and §5.5 mode stability', () => {
  it('D-22: a second selection for the same (membership, period, week) is REJECTED', async () => {
    const periodId = await createPeriod('2049-01-04', 'quota');
    await createAvailableSelection(periodId, '2049-01-04');
    await expect(createAvailableSelection(periodId, '2049-01-04')).rejects.toMatchObject({
      code: '23505',
    });
  }, 120_000);

  it('D-26: the same approval idempotency key twice for one selection is REJECTED', async () => {
    const periodId = await createPeriod('2049-03-01', 'quota');
    const { selectionId } = await createPendingVacation(periodId, '2049-03-01');
    const key = `cycle22.approve.${randomUUID().slice(0, 12)}`;

    const command = async (): Promise<void> =>
      run(async ({ query }) => {
        await sql`
          insert into vacation_approval_commands
            (organization_id, group_id, selection_id, approval_idempotency_key)
          values (${context.organizationId}::uuid, ${context.groupId}::uuid,
                  ${selectionId}::uuid, ${key})
        `.execute(query);
      });

    await command();
    await expect(command()).rejects.toMatchObject({ code: '23505' });
  }, 180_000);

  it('R-13: an `open` period has NO grants, and that is not an error', async () => {
    /* V-30. The superseded design's unconditional grant update made open-mode
     * approval always fail, because there is no grant row to update — so this
     * asserts the two facts that make the mode branch necessary: an open period
     * legitimately has zero grants, and a selection in it is still writable. */
    const periodId = await createPeriod('2049-05-03', 'open');
    const grants = await run(
      async ({ query }) =>
        await sql<{ n: string }>`select count(*)::text as n from vacation_grants
                                  where vacation_period_id = ${periodId}::uuid`.execute(query),
    );
    expect(grants.rows[0]?.n).toBe('0');

    const { selectionId } = await createPendingVacation(periodId, '2049-05-03');
    const row = await run(
      async ({ query }) =>
        await sql<{ grant_id: string | null }>`
          select grant_id from vacation_selections where id = ${selectionId}::uuid
        `.execute(query),
    );
    expect(row.rows[0]?.grant_id, 'open-mode selections leave grant_id null').toBeNull();
  }, 180_000);

  it('§5.5: a period\'s mode does not change under a live selection', async () => {
    const periodId = await createPeriod('2049-07-05', 'quota');
    const { selectionId } = await createPendingVacation(periodId, '2049-07-05');

    await expect(
      run(
        async ({ query }) =>
          await sql`update vacation_periods set mode = 'open' where id = ${periodId}::uuid`.execute(
            query,
          ),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('VACATION_MODE_CHANGE_PROHIBITED'),
    });

    /* …and once nothing is live, the mode moves — so the arm above is not
     * passing because the mode is simply frozen. The selection is withdrawn
     * through both rows at once, which is the only legal way to move it. */
    await run(async ({ query }) => {
      await sql`update vacation_selections set status = 'withdrawn'
                 where id = ${selectionId}::uuid`.execute(query);
      await sql`update requests set status = 'withdrawn'
                 where id = (select request_id from vacation_selections
                              where id = ${selectionId}::uuid)`.execute(query);
    });
    await run(
      async ({ query }) =>
        await sql`update vacation_periods set mode = 'open' where id = ${periodId}::uuid`.execute(
          query,
        ),
    );
    const mode = await run(
      async ({ query }) =>
        await sql<{ mode: string }>`select mode from vacation_periods
                                     where id = ${periodId}::uuid`.execute(query),
    );
    expect(mode.rows[0]?.mode).toBe('open');
  }, 240_000);
});

/**
 * A DRAFT schedule version, for the one fixture statement that needs one.
 *
 * OPUS-M5-004: see the note at its call site. Created inside the caller's own
 * transaction so the fixture stays one unit of work, and named for what it is
 * for rather than for what it is.
 */
async function draftVersionForCommit(query: PgUnitOfWork['query']): Promise<string> {
  const schedulePeriodId = randomUUID();
  await sql`
    insert into schedule_periods (id, organization_id, group_id, name, start_date, end_date)
    values (${schedulePeriodId}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
            ${`c22 commit ${randomUUID().slice(0, 8)}`}, ${'2052-01-05'}::date,
            ${'2052-03-05'}::date)
  `.execute(query);
  const versionId = randomUUID();
  await sql`
    insert into schedule_versions (id, organization_id, group_id, period_id, state)
    values (${versionId}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
            ${schedulePeriodId}::uuid, ${'draft'})
  `.execute(query);
  return versionId;
}
