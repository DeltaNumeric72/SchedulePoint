import { randomUUID } from 'node:crypto';

import {
  EXPIRY_SOURCE_STATUSES,
  REQUEST_STATUSES_BY_SUBTYPE,
  REQUEST_SUBTYPES,
  type RequestSubtype,
} from '@schedulepoint/domain';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate } from '../../src/db/migrate.js';
import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import { digestRows } from '../../src/schedule/render.js';
import { adminClient } from '../support/admin-client.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * **Migration 0021, up → down → up, over a POPULATED database** (OPUS-M5-000b;
 * doc 42 §5b Acceptance, "a populated cycle per new migration").
 *
 * ## Why the standing cycle is not enough
 *
 * `globalSetup` runs the whole stack up → down → up before every run, on an
 * EMPTY database. That proves the SQL is executable in both directions. It does
 * not prove that reversing 0021 over real rows leaves the rest of the schema
 * intact, and it proves nothing at all about whether the constraints are still
 * ENFORCING afterwards — which is the failure mode a cycle test is most likely
 * to have, because a dropped trigger leaves every census digest identical.
 *
 * ## BY NAME, never by position — FAD-33(4) / FAD-34(5)
 *
 * The loop's termination condition IS the migration's name, so there is no count
 * to go stale when 0022 lands above it. The re-up sits in a `finally` and the
 * loop's own "ran out of migrations" throw sits INSIDE the `try`, because an
 * abort with migrations already reversed is exactly the cluster poisoning the
 * idiom exists to prevent. The 0014 cycle test was authored positionally, 0015
 * landed above it, and four downstream files met a schema without 0015.
 *
 * ## What the negative cases are for
 *
 * Doc 42 §5b names them: the database must REJECT, proven by test. They are
 * grouped by the constraint they exercise and each one says which SPEC-08 test
 * contract row it is — R-02, R-03, R-04, R-22, R-23 — so a reader can check the
 * coverage against §7 rather than counting `expect`s.
 *
 * ## Writing without a service, and why that is not a shortcut here
 *
 * doc 42 §5b ships no service: the request transactions are M5-001 onward, and
 * the packet exists so that they are written against constraints already proven.
 * So rows are written through the unit of work and the typed query path under
 * real transaction-local tenant context — the production DATA path — and the
 * negatives are issued as raw statements ON PURPOSE, because a negative proved
 * through a service proves the service refused it, not the database.
 */

const multi = ownedMulti('requests-migration-0021-cycle', {
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
let requestableShiftGroupId: string;

const run = async <T>(fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> =>
  runtime.runner.run(context, fn);

/** The tables the cycle must leave untouched, and the columns that must survive. */
const CENSUS: readonly { table: string; columns: readonly string[] }[] = [
  { table: 'shift_types', columns: ['id', 'code', 'name', 'start_time', 'end_time'] },
  { table: 'shift_groups', columns: ['id', 'name', 'allow_request'] },
  { table: 'memberships', columns: ['id', 'user_id', 'kind', 'group_role'] },
  { table: 'group_holidays', columns: ['id', 'holiday_date'] },
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

/** How many rows `requests` holds in this context. */
async function requestCount(): Promise<number> {
  const rows = await run(
    async ({ query }) =>
      await sql<{ n: string }>`select count(*)::text as n from requests`.execute(query),
  );
  return Number(rows.rows[0]?.n ?? '0');
}

/**
 * A root and its one subtype row, in ONE unit of work — which is what D-18's
 * deferred guard requires and, equally, what it permits.
 */
async function createRequest(
  subtype: RequestSubtype,
  status: string,
  suffix: string,
  writeRecord: (uow: PgUnitOfWork, requestId: string) => Promise<void>,
): Promise<string> {
  return run(async (uow) => {
    const id = randomUUID();
    await sql`
      insert into requests
        (id, organization_id, group_id, membership_id, subtype, status, expires_at,
         idempotency_key)
      values (${id}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
              ${membershipId}::uuid, ${subtype}, ${status},
              ${'2099-06-01T00:00:00.000Z'}::timestamptz,
              ${`cycle21.${suffix}.${randomUUID().slice(0, 8)}`})
    `.execute(uow.query);
    await writeRecord(uow, id);
    return id;
  });
}

async function createAvailability(status = 'submitted', day = '2046-01-05'): Promise<string> {
  return createRequest('availability', status, 'availability', async (uow, requestId) => {
    await sql`
      insert into request_availability (request_id, organization_id, group_id, target_date)
      values (${requestId}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
              ${day}::date)
    `.execute(uow.query);
  });
}

beforeAll(async () => {
  runtime = createRuntime('app_runtime', { max: 4 });
  const alpha = multi().alpha;
  const catalogue = multi.catalogue('alpha');
  const seededShiftType = catalogue.shiftTypeIds[0];
  if (seededShiftType === undefined) throw new Error('the alpha catalogue seed produced no shift type');
  shiftTypeId = seededShiftType;
  requestableShiftGroupId = catalogue.shiftGroupId;
  membershipId = alpha.users.scheduler.membershipId;
  context = {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    membershipId,
    correlationId: 'requests-migration-0021-cycle',
  };
}, 240_000);

afterAll(async () => {
  await runtime?.destroy();
});

describe('migration 0021 over a populated database', () => {
  it('up → down → up, resolved and asserted BY NAME', async () => {
    /* ── 1. Populate, through the unit of work under real tenant context ─── */
    await createAvailability();
    expect(await requestCount(), 'the cycle must have rows to be about').toBeGreaterThan(0);
    const censusBefore = await census();

    /* ── 2. DOWN to a NAMED TARGET, and back UP unconditionally ──────────── */
    let up: readonly string[] = [];
    let midway: Record<string, { count: number; digest: string }> | undefined;
    const down: string[] = [];
    try {
      while (!down.some((name) => name.includes('0021'))) {
        const step = await migrate('down', { count: 1 });
        if (step.applied.length === 0) {
          throw new Error('ran out of migrations before reaching 0021 — the ledger is empty');
        }
        down.push(...step.applied);
      }
      /* The six tables are gone. Everything the census names is still here —
       * the moment a cascade or a rewrite would already have destroyed it. */
      midway = await census();
    } finally {
      up = (await migrate('up', { count: down.length })).applied;
    }

    expect(midway, 'the census must have been taken before the re-up').toBeDefined();
    expect(midway).toEqual(censusBefore);

    expect(up).toHaveLength(down.length);
    expect(up.some((name) => name.includes('0021'))).toBe(true);

    /* ── 3. The named exception, stated rather than glossed ───────────────── */
    expect(await census()).toEqual(censusBefore);
    /* Rows in the tables 0021 CREATES do not survive its own `DROP TABLE`, and
     * that is correct rather than a defect: a down migration that preserved them
     * would have to keep the table. Asserted explicitly so a reader does not have
     * to wonder whether it was checked. */
    expect(await requestCount()).toBe(0);

    /* ── 4. The schema WORKS again, not merely exists ─────────────────────── */
    expect(await createAvailability()).toMatch(/^[0-9a-f-]{36}$/);
  }, 300_000);

  it('MUTATION CONTROL: the transition guard is enforcing again after the cycle', async () => {
    /* A down that dropped the trigger and an up that forgot to restore it would
     * leave every digest above identical and the case above green. This is the
     * only assertion in the file that would notice. */
    const requestId = await createAvailability('submitted');

    await expect(
      run(
        async ({ query }) =>
          await sql`update requests set status = 'reflected_in_version'
                     where id = ${requestId}::uuid`.execute(query),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('REQUEST_TRANSITION_ILLEGAL') });

    /* …and a LEGAL edge still works, so the arm above is not passing because
     * everything is refused. */
    await run(
      async ({ query }) =>
        await sql`update requests set status = 'under_review' where id = ${requestId}::uuid`.execute(
          query,
        ),
    );
    const after = await run(
      async ({ query }) =>
        await sql<{ status: string }>`select status from requests where id = ${requestId}::uuid`.execute(
          query,
        ),
    );
    expect(after.rows[0]?.status).toBe('under_review');
  }, 180_000);
});

describe('D-18 — exactly one subtype row per request', () => {
  it('R-04: a SECOND subtype row for the same request is REJECTED', async () => {
    const requestId = await createAvailability();

    /* The same table twice: refused by `UNIQUE (request_id)`, which is the
     * primary key here. */
    await expect(
      run(
        async ({ query }) =>
          await sql`
            insert into request_availability (request_id, organization_id, group_id, target_date)
            values (${requestId}::uuid, ${context.organizationId}::uuid,
                    ${context.groupId}::uuid, ${'2046-01-06'}::date)
          `.execute(query),
      ),
    ).rejects.toMatchObject({ code: '23505' });

    /* A DIFFERENT subtype table: refused by the composite foreign key, because
     * the root carries one `subtype` value and the reference transports it. This
     * is the arm a `UNIQUE (request_id)` per table cannot cover on its own, and
     * without it "two subtype rows" would be reachable by using two tables. */
    await expect(
      run(
        async ({ query }) =>
          await sql`
            insert into request_no_call (request_id, organization_id, group_id, target_date)
            values (${requestId}::uuid, ${context.organizationId}::uuid,
                    ${context.groupId}::uuid, ${'2046-01-06'}::date)
          `.execute(query),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  }, 120_000);

  it('the ZERO-row half: a root with no subtype row is REJECTED at COMMIT', async () => {
    await expect(
      run(
        async ({ query }) =>
          await sql`
            insert into requests
              (organization_id, group_id, membership_id, subtype, status, expires_at,
               idempotency_key)
            values (${context.organizationId}::uuid, ${context.groupId}::uuid,
                    ${membershipId}::uuid, ${'availability'}, ${'draft'},
                    ${'2099-06-01T00:00:00.000Z'}::timestamptz,
                    ${`cycle21.orphan.${randomUUID().slice(0, 8)}`})
          `.execute(query),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('REQUEST_SUBTYPE_ROW_REQUIRED'),
    });
  }, 120_000);

  it('DEFERRED, both legs — the property the guard would fail silently without', async () => {
    /* LEG ONE, the one that matters most and is easiest to lose: a transaction
     * that is TRANSIENTLY inconsistent must COMMIT.
     *
     * The root is inserted first and has no subtype row for the length of one
     * statement. An IMMEDIATE constraint would refuse it — and would therefore
     * refuse every legal writer M5-001 is going to have, while every other
     * assertion in this file stayed green. `createAvailability` is exactly that
     * shape, so its success IS the leg. Asserted explicitly rather than left
     * implicit in the helper, because "it happened to work" and "it is required
     * to work" are different claims. */
    const requestId = await createAvailability();
    const committed = await run(
      async ({ query }) =>
        await sql<{ n: string }>`select count(*)::text as n from requests
                                  where id = ${requestId}::uuid`.execute(query),
    );
    expect(committed.rows[0]?.n, 'a transiently-inconsistent transaction must commit').toBe('1');

    /* LEG TWO: still inconsistent AT COMMIT must be refused — the previous case,
     * which is the other half of the same property. Both are asserted because a
     * deferred trigger that secretly fired immediately would pass leg two and
     * fail leg one, and one that never fired at all would pass leg one and fail
     * leg two. Neither alone distinguishes a working guard from a broken one. */
    await expect(
      run(async ({ query }) => {
        await sql`
          insert into requests
            (organization_id, group_id, membership_id, subtype, status, expires_at,
             idempotency_key)
          values (${context.organizationId}::uuid, ${context.groupId}::uuid,
                  ${membershipId}::uuid, ${'no-call'}, ${'draft'},
                  ${'2099-06-01T00:00:00.000Z'}::timestamptz,
                  ${`cycle21.deferred.${randomUUID().slice(0, 8)}`})
        `.execute(query);
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('REQUEST_SUBTYPE_ROW_REQUIRED'),
    });
  }, 120_000);
});

describe('D-19 — required fields non-null, prohibited fields absent', () => {
  it('R-02: a shift preference with NO shift type is REJECTED — the review\'s named failure', async () => {
    await expect(
      createRequest(
        'shift-preference',
        'accepted_as_input',
        'no-shift-type',
        async (uow, requestId) => {
          await sql`
            insert into request_shift_preference
              (request_id, organization_id, group_id, target_date, preference_strength)
            values (${requestId}::uuid, ${context.organizationId}::uuid,
                    ${context.groupId}::uuid, ${'2046-02-02'}::date, ${'high'})
          `.execute(uow.query);
        },
      ),
    ).rejects.toMatchObject({ code: '23502' });
  }, 120_000);

  it('time-off: BOTH a date and a range is REJECTED, and so is HALF a range', async () => {
    const bothShapes = createRequest('time-off', 'submitted', 'both-shapes', async (uow, id) => {
      await sql`
        insert into request_time_off
          (request_id, organization_id, group_id, target_date, range_start, range_end)
        values (${id}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
                ${'2046-03-02'}::date, ${'2046-03-03'}::date, ${'2046-03-04'}::date)
      `.execute(uow.query);
    });
    await expect(bothShapes).rejects.toMatchObject({ code: '23514' });

    const halfRange = createRequest('time-off', 'submitted', 'half-range', async (uow, id) => {
      await sql`
        insert into request_time_off (request_id, organization_id, group_id, range_start)
        values (${id}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
                ${'2046-03-03'}::date)
      `.execute(uow.query);
    });
    await expect(halfRange).rejects.toMatchObject({ code: '23514' });

    /* NEITHER shape — no date and no range at all — is the third way to violate
     * the same constraint, and it is the one a "check the range if present"
     * spelling would miss. */
    const neitherShape = createRequest('time-off', 'submitted', 'neither', async (uow, id) => {
      await sql`
        insert into request_time_off (request_id, organization_id, group_id)
        values (${id}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid)
      `.execute(uow.query);
    });
    await expect(neitherShape).rejects.toMatchObject({ code: '23514' });
  }, 120_000);

  it('a range that ends before it starts is REJECTED', async () => {
    await expect(
      createRequest('time-off', 'submitted', 'backwards', async (uow, id) => {
        await sql`
          insert into request_time_off
            (request_id, organization_id, group_id, range_start, range_end)
          values (${id}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
                  ${'2046-03-10'}::date, ${'2046-03-04'}::date)
        `.execute(uow.query);
      }),
    ).rejects.toMatchObject({ code: '23514' });
  }, 120_000);

  it('the PROHIBITION half, enumerated against §1.2 rather than sampled', async () => {
    /* D-19's prohibition is realized as column ABSENCE (migration 0021 header
     * §2), which is strictly stronger than an always-NULL column with a CHECK —
     * the row is refused before any row is evaluated, and no `DROP CONSTRAINT`
     * can un-prohibit it.
     *
     * The cost of that choice is that the prohibition could become an accident
     * of which columns someone happened to declare. This case is what stops it
     * being one: SPEC-08 §1.2's prohibited list, transcribed subtype by subtype,
     * asserted against the catalogue. A later ALTER that added one back fails
     * here. */
    const PROHIBITED: readonly { table: string; columns: readonly string[] }[] = [
      { table: 'request_availability', columns: ['shift_group_id'] },
      { table: 'request_time_off', columns: ['shift_type_id', 'shift_group_id'] },
      {
        table: 'request_no_call',
        columns: ['shift_type_id', 'shift_group_id', 'preference_strength'],
      },
      { table: 'request_shift_preference', columns: ['shift_group_id'] },
      { table: 'request_shift_group_off', columns: ['shift_type_id'] },
    ];

    for (const entry of PROHIBITED) {
      const present = await run(
        async ({ query }) =>
          await sql<{ column_name: string }>`
            select column_name from information_schema.columns
             where table_schema = 'public'
               and table_name = ${entry.table}
               and column_name = any(${entry.columns}::text[])
          `.execute(query),
      );
      expect(
        present.rows.map((row) => row.column_name),
        `${entry.table} carries a field §1.2 prohibits for its subtype`,
      ).toEqual([]);
    }

    /* And the rejection itself, so "absent" is shown to REFUSE rather than
     * merely to be missing — SPEC-08 R-16's rejection half, in its
     * non-vacation form. */
    await expect(
      createRequest('no-call', 'submitted', 'prohibited', async (uow, id) => {
        await sql`
          insert into request_no_call
            (request_id, organization_id, group_id, target_date, shift_type_id)
          values (${id}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
                  ${'2046-04-06'}::date, ${shiftTypeId}::uuid)
        `.execute(uow.query);
      }),
    ).rejects.toMatchObject({ code: '42703' });
  }, 180_000);

  it('a shift-group-off request naming a group that does not admit requests is REJECTED', async () => {
    /* §1.2's parenthetical — "whose `allow_request` is true" — which no foreign
     * key can carry. The fixture's own bundle DOES admit requests, so a group
     * that does not has to be made; `shift_groups.allow_request` defaults false
     * and is paired with a mandatory label by 0005, so the fixture's second
     * bundle is created through the same path the first was. */
    const refusedGroupId = await run(async ({ query }) => {
      const id = randomUUID();
      await sql`
        insert into shift_groups
          (id, organization_id, group_id, name, scoring_mode, allow_request)
        values (${id}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
                ${`Cycle bundle ${randomUUID().slice(0, 8)}`}, ${'hard'}, ${false})
      `.execute(query);
      return id;
    });

    await expect(
      createRequest('shift-group-off', 'submitted', 'not-requestable', async (uow, id) => {
        await sql`
          insert into request_shift_group_off
            (request_id, organization_id, group_id, target_date, shift_group_id)
          values (${id}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
                  ${'2046-05-04'}::date, ${refusedGroupId}::uuid)
        `.execute(uow.query);
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('SHIFT_GROUP_REQUESTS_NOT_ALLOWED'),
    });

    /* …and the fixture's requestable bundle still works, so the arm above is not
     * passing because every shift-group-off request is refused. */
    const accepted = await createRequest(
      'shift-group-off',
      'submitted',
      'requestable',
      async (uow, id) => {
        await sql`
          insert into request_shift_group_off
            (request_id, organization_id, group_id, target_date, shift_group_id)
          values (${id}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
                  ${'2046-05-11'}::date, ${requestableShiftGroupId}::uuid)
        `.execute(uow.query);
      },
    );
    expect(accepted).toMatch(/^[0-9a-f-]{36}$/);
  }, 180_000);
});

describe('D-20 — the per-subtype status domain', () => {
  it('R-03: a shift preference INSERTED as `approved` is REJECTED by the domain', async () => {
    /* Not by the transition matrix — an INSERT has no transition to refuse,
     * which is exactly why D-20 and §2 are two constraints rather than one. */
    await expect(
      createRequest('shift-preference', 'approved', 'r03', async (uow, id) => {
        await sql`
          insert into request_shift_preference
            (request_id, organization_id, group_id, target_date, shift_type_id,
             preference_strength)
          values (${id}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
                  ${'2046-06-01'}::date, ${shiftTypeId}::uuid, ${'low'})
        `.execute(uow.query);
      }),
    ).rejects.toMatchObject({ code: '23514' });
  }, 120_000);

  it('`unsatisfied` is shift-preference\'s alone, and `reversed` is vacation\'s alone', async () => {
    await expect(
      createRequest('availability', 'unsatisfied', 'unsatisfied', async (uow, id) => {
        await sql`
          insert into request_availability (request_id, organization_id, group_id, target_date)
          values (${id}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
                  ${'2046-06-08'}::date)
        `.execute(uow.query);
      }),
    ).rejects.toMatchObject({ code: '23514' });

    await expect(
      createRequest('time-off', 'reversed', 'reversed', async (uow, id) => {
        await sql`
          insert into request_time_off (request_id, organization_id, group_id, target_date)
          values (${id}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
                  ${'2046-06-15'}::date)
        `.execute(uow.query);
      }),
    ).rejects.toMatchObject({ code: '23514' });
  }, 120_000);

  it('the DOMAIN constant and the CHECK agree, subtype by subtype and status by status', async () => {
    /* A constant and a CHECK that drift produce a save which fails for no visible
     * reason. So the two are not left to agree by inspection: every
     * (subtype × status) pair the domain constant admits is asserted admitted by
     * the database, and every pair it refuses is asserted refused — which is the
     * discipline the shift-type catalogue already uses against migration 0005.
     *
     * The agreement is established by ATTEMPTING THE WRITE, which is the only
     * way a table CHECK permits. There is deliberately no probe function: D-20 is
     * a CHECK, and adding a callable helper purely so a test could ask it would
     * put a second copy of the rule in the schema — the exact drift this case
     * exists to catch.
     *
     * Every attempt fails. What distinguishes an admitted pair from a refused one
     * is WHICH failure: an admitted status gets past D-20 and is then refused at
     * COMMIT by D-18's zero-row guard, because the attempt writes no subtype row.
     * A refused status never gets that far and comes back 23514. */
    for (const subtype of REQUEST_SUBTYPES) {
      const allowed = new Set(REQUEST_STATUSES_BY_SUBTYPE[subtype]);
      for (const status of new Set(Object.values(REQUEST_STATUSES_BY_SUBTYPE).flat())) {
        const attempt = run(
          async ({ query }) =>
            await sql`
              insert into requests
                (organization_id, group_id, membership_id, subtype, status, expires_at,
                 idempotency_key)
              values (${context.organizationId}::uuid, ${context.groupId}::uuid,
                      ${membershipId}::uuid, ${subtype}, ${status},
                      ${'2099-06-01T00:00:00.000Z'}::timestamptz,
                      ${`cycle21.domain.${randomUUID().slice(0, 12)}`})
            `.execute(query),
        );

        if (allowed.has(status)) {
          /* The status is in the domain, so D-20 admits it — and the write then
           * fails at COMMIT on D-18's zero-row guard instead, because no subtype
           * row was written. That distinction IS the assertion: a different
           * refusal proves D-20 let it past. */
          await expect(
            attempt,
            `${subtype}/${status} must be admitted by D-20`,
          ).rejects.toMatchObject({
            message: expect.stringContaining('REQUEST_SUBTYPE_ROW_REQUIRED'),
          });
        } else {
          await expect(
            attempt,
            `${subtype}/${status} must be refused by D-20`,
          ).rejects.toMatchObject({ code: '23514' });
        }
      }
    }
  }, 300_000);
});

describe('§2 — the transition matrices, and V-31 in particular', () => {
  it('R-23: `reflected_in_version → expired` and `approved → expired` are REJECTED', async () => {
    /* The two named attempts. `expired` accepts only `submitted`,
     * `under_review` and `accepted_as_input` — the undecided states. The
     * superseded spelling was a literal `*`, which as a database rule permits
     * expiring a request a PUBLISHED version already honours. */
    const walk = async (requestId: string, statuses: readonly string[]): Promise<void> => {
      for (const status of statuses) {
        await run(
          async ({ query }) =>
            await sql`update requests set status = ${status} where id = ${requestId}::uuid`.execute(
              query,
            ),
        );
      }
    };

    const reflected = await createAvailability('submitted', '2046-07-06');
    await walk(reflected, [
      'under_review',
      'approved',
      'consumed_by_build',
      'reflected_in_version',
    ]);
    await expect(
      run(
        async ({ query }) =>
          await sql`update requests set status = 'expired' where id = ${reflected}::uuid`.execute(
            query,
          ),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('REQUEST_TRANSITION_ILLEGAL') });

    const approved = await createAvailability('submitted', '2046-07-13');
    await walk(approved, ['under_review', 'approved']);
    await expect(
      run(
        async ({ query }) =>
          await sql`update requests set status = 'expired' where id = ${approved}::uuid`.execute(
            query,
          ),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('REQUEST_TRANSITION_ILLEGAL') });

    /* …and each of the THREE legal sources still reaches `expired`, so the arm
     * above is not passing because `expired` is unreachable. Enumerated from the
     * domain constant, so adding a fourth source there without adding it to the
     * migration fails here. */
    expect([...EXPIRY_SOURCE_STATUSES]).toEqual([
      'submitted',
      'under_review',
      'accepted_as_input',
    ]);

    const fromSubmitted = await createAvailability('submitted', '2046-07-20');
    await walk(fromSubmitted, ['expired']);

    const fromUnderReview = await createAvailability('submitted', '2046-07-27');
    await walk(fromUnderReview, ['under_review', 'expired']);

    const fromAccepted = await createAvailability('submitted', '2046-08-03');
    await walk(fromAccepted, ['accepted_as_input', 'expired']);

    const statuses = await run(
      async ({ query }) =>
        await sql<{ status: string }>`
          select status from requests
           where id = any(${[fromSubmitted, fromUnderReview, fromAccepted]}::uuid[])
        `.execute(query),
    );
    expect(statuses.rows.map((row) => row.status)).toEqual(['expired', 'expired', 'expired']);
  }, 240_000);

  it('R-22: a shift preference withdraws while `accepted_as_input`, and not after consumption', async () => {
    const createPreference = async (day: string): Promise<string> =>
      createRequest('shift-preference', 'submitted', 'r22', async (uow, id) => {
        await sql`
          insert into request_shift_preference
            (request_id, organization_id, group_id, target_date, shift_type_id,
             preference_strength)
          values (${id}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
                  ${day}::date, ${shiftTypeId}::uuid, ${'medium'})
        `.execute(uow.query);
      });

    /* BEFORE consumption: succeeds. V-31 added this edge because without it a
     * shift preference became unwithdrawable the moment it was accepted — and it
     * is accepted immediately, since nobody approves a non-binding preference. */
    const early = await createPreference('2046-09-07');
    await run(
      async ({ query }) =>
        await sql`update requests set status = 'accepted_as_input'
                   where id = ${early}::uuid`.execute(query),
    );
    await run(
      async ({ query }) =>
        await sql`update requests set status = 'withdrawn' where id = ${early}::uuid`.execute(query),
    );

    /* AFTER consumption: refused — and refused BECAUSE the build already used
     * it, which is a different fact from the one above rather than an
     * inconsistency. */
    const late = await createPreference('2046-09-14');
    await run(async ({ query }) => {
      await sql`update requests set status = 'accepted_as_input' where id = ${late}::uuid`.execute(
        query,
      );
    });
    await run(async ({ query }) => {
      await sql`update requests set status = 'consumed_by_build' where id = ${late}::uuid`.execute(
        query,
      );
    });
    await expect(
      run(
        async ({ query }) =>
          await sql`update requests set status = 'withdrawn' where id = ${late}::uuid`.execute(
            query,
          ),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('REQUEST_TRANSITION_ILLEGAL') });
  }, 240_000);

  it('the DISCRIMINATOR is frozen — by TWO independent controls', async () => {
    /* Without this, one UPDATE moves a row out from under its status domain, its
     * subtype table and its transition matrix at once — and every constraint
     * above would then be describing a request that is no longer the one they
     * were checked against.
     *
     * TWO controls, asserted separately, because each alone is defeatable and
     * asserting only the first would leave the second untested forever:
     *
     *   1. the COLUMN-LEVEL grant. `subtype` is absent from the UPDATE grant
     *      (migration 0021 §7), so the application role never reaches the
     *      trigger at all — it is refused with 42501 first;
     *   2. the TRIGGER, which binds the OWNER too. That is the arm that matters,
     *      because a grant is a privilege somebody can widen, and the owner
     *      already has every column privilege there is. */
    const requestId = await createAvailability();

    await expect(
      run(
        async ({ query }) =>
          await sql`update requests set subtype = 'no-call' where id = ${requestId}::uuid`.execute(
            query,
          ),
      ),
      'the application role must not even hold the grant',
    ).rejects.toMatchObject({ code: '42501' });

    /* As the superuser, where the grant is not the thing being tested. Tenant
     * context is declared because `requests` is FORCE RLS and binds the owner:
     * without it the UPDATE would match zero rows and this arm would pass
     * vacuously, which is the failure mode 0003's R-05 records. */
    const admin = adminClient();
    await admin.connect();
    try {
      await admin.query('BEGIN');
      await admin.query(`select set_config('app.organization_id', $1, true)`, [
        context.organizationId,
      ]);
      await admin.query(`select set_config('app.group_id', $1, true)`, [context.groupId]);
      await admin.query(`select set_config('app.membership_id', $1, true)`, [membershipId]);

      /* The control: the row IS visible and IS updatable in this session, so the
       * refusal below is the trigger rather than an empty match. */
      const touch = await admin.query(
        `update requests set updated_at = now() where id = $1 returning id`,
        [requestId],
      );
      expect(touch.rowCount, 'the owner must be able to see and touch the row').toBe(1);

      await expect(
        admin.query(`update requests set subtype = 'no-call' where id = $1`, [requestId]),
      ).rejects.toMatchObject({ message: expect.stringContaining('REQUEST_IDENTITY_FROZEN') });
    } finally {
      await admin.query('ROLLBACK').catch(() => {});
      await admin.end();
    }
  }, 180_000);
});

describe('X-11 — a subtype-table key is not a cross-tenant existence oracle', () => {
  it('an EXISTING foreign request and a NONEXISTENT uuid are INDISTINGUISHABLE', async () => {
    /* The falsifier for migration 0021 header §2a.
     *
     * Unique and primary-key checks bypass row-level security, so before the
     * primary key carried `organization_id` this was reachable: an INSERT into a
     * subtype table naming another tenant's request id collided with the unique
     * index (23505) and came back with a different error than one naming a uuid
     * that names nothing (23503, from the composite FK). The DIFFERENCE was the
     * oracle — it answered "does this request exist, and does it already have a
     * subtype row" for a row the caller can never read.
     *
     * With `(request_id, organization_id)` as the key, the caller's own
     * organization is part of every collision, so the foreign row is not a
     * collision at all and both statements fail the same way: the composite
     * foreign key finds no request with THIS request id in THIS tenant, whether
     * or not one exists in another. Same class, same SQLSTATE, no information.
     *
     * Asserting the two are equal is the assertion. Asserting each is 23503
     * individually would pass just as well if one of them were 23505 tomorrow
     * for a new reason, so the equality is what is checked first. */
    const betaRequestId = await runtime.runner.run(
      {
        organizationId: multi().beta.organizationId,
        groupId: multi().beta.groupOne.id,
        membershipId: multi().beta.users.scheduler.membershipId,
        correlationId: 'requests-migration-0021-cycle-foreign',
      },
      async (uow) => {
        const id = randomUUID();
        await sql`
          insert into requests
            (id, organization_id, group_id, membership_id, subtype, status, expires_at,
             idempotency_key)
          values (${id}::uuid, ${multi().beta.organizationId}::uuid,
                  ${multi().beta.groupOne.id}::uuid,
                  ${multi().beta.users.scheduler.membershipId}::uuid,
                  ${'availability'}, ${'submitted'},
                  ${'2099-06-01T00:00:00.000Z'}::timestamptz,
                  ${`cycle21.foreign.${randomUUID().slice(0, 8)}`})
        `.execute(uow.query);
        await sql`
          insert into request_availability (request_id, organization_id, group_id, target_date)
          values (${id}::uuid, ${multi().beta.organizationId}::uuid,
                  ${multi().beta.groupOne.id}::uuid, ${'2046-11-02'}::date)
        `.execute(uow.query);
        return id;
      },
    );

    /* Alpha cannot see that request — the control that makes the rest of this
     * case about the KEY rather than about visibility. */
    const visible = await run(
      async ({ query }) =>
        await sql<{ n: string }>`select count(*)::text as n from requests
                                  where id = ${betaRequestId}::uuid`.execute(query),
    );
    expect(visible.rows[0]?.n, 'the foreign request must be invisible to this tenant').toBe('0');

    /** The error class Alpha gets for naming `candidate` in its OWN tenant. */
    const attemptWith = async (candidate: string): Promise<{ code: unknown }> => {
      try {
        await run(
          async ({ query }) =>
            await sql`
              insert into request_availability (request_id, organization_id, group_id, target_date)
              values (${candidate}::uuid, ${context.organizationId}::uuid,
                      ${context.groupId}::uuid, ${'2046-11-09'}::date)
            `.execute(query),
        );
      } catch (error) {
        return { code: (error as { code?: unknown }).code };
      }
      throw new Error('the insert was accepted — it names a request this tenant does not own');
    };

    const foreign = await attemptWith(betaRequestId);
    const nowhere = await attemptWith(randomUUID());

    expect(
      foreign.code,
      'the foreign request and the nonexistent uuid must be indistinguishable',
    ).toBe(nowhere.code);
    /* And the class itself, recorded so a future reader knows which one it is:
     * the composite foreign key, not a unique violation. */
    expect(foreign.code).toBe('23503');
  }, 180_000);
});

describe('D-7 — one request per (membership, idempotency key)', () => {
  it('R-11: the same key twice for the same member is REJECTED', async () => {
    const key = `cycle21.d7.${randomUUID().slice(0, 12)}`;
    const write = async (): Promise<void> =>
      run(async (uow) => {
        const id = randomUUID();
        await sql`
          insert into requests
            (id, organization_id, group_id, membership_id, subtype, status, expires_at,
             idempotency_key)
          values (${id}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
                  ${membershipId}::uuid, ${'availability'}, ${'submitted'},
                  ${'2099-06-01T00:00:00.000Z'}::timestamptz, ${key})
        `.execute(uow.query);
        await sql`
          insert into request_availability (request_id, organization_id, group_id, target_date)
          values (${id}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
                  ${'2046-10-05'}::date)
        `.execute(uow.query);
      });

    await write();
    await expect(write()).rejects.toMatchObject({ code: '23505' });
  }, 120_000);
});
