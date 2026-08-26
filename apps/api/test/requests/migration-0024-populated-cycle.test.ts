import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate } from '../../src/db/migrate.js';
import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import { digestRows } from '../../src/schedule/render.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * **Migration 0024, up → down → up, over a POPULATED database** (OPUS-M5-002;
 * doc 42 §5d Acceptance, "a populated cycle per new migration").
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## What 0024 does, and therefore what a cycle of it has to prove
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 0024 creates ONE table, `approvals`, with three RLS arms, two indexes, and
 * `SELECT, INSERT` grants and no others. It is purely additive: it replaces no
 * policy, redefines no function, relaxes no constraint and widens no grant. So
 * unlike 0023's cycle there is nothing to restore byte-for-byte — the down drops
 * what the up created and stops, and this file asserts that everything ELSE is
 * untouched by it.
 *
 * Four things, then:
 *
 *   1. the table comes back **ENFORCING** — not merely present. Every CHECK is
 *      driven to its refusal, in both directions where the constraint has two;
 *   2. the three RLS arms are enforcing, including the one that differs from
 *      0023's shape: **`approvals_own` is `FOR SELECT`**, so a member can read the
 *      decision on their own request and cannot write one;
 *   3. "the prior decision is never overwritten" is a PRIVILEGE — asserted by
 *      driving an UPDATE and a DELETE and getting `42501`, not by reading the
 *      grant table;
 *   4. everything 0024 does not own is untouched, by census.
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
 * organization, site or person name from the research appears here, and the
 * reasons are administrative notes about a synthetic roster.
 */

const multi = ownedMulti('requests-migration-0024-cycle', {
  profile: 'core',
  seed: { catalogue: ['alpha'] },
});

let runtime: Runtime;
/** The DECIDER — a `scheduler`, so `requests.administer` is theirs by role. */
let scheduler: {
  organizationId: string;
  groupId: string;
  membershipId: string;
  correlationId: string;
};
/** The REQUESTER — a `member`, holding no request capability at all. */
let member: typeof scheduler;

const asScheduler = async <T>(fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> =>
  runtime.runner.run(scheduler, fn);
const asMember = async <T>(fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> =>
  runtime.runner.run(member, fn);

/** The tables the cycle must leave untouched. */
const CENSUS: readonly { table: string; columns: readonly string[] }[] = [
  { table: 'requests', columns: ['id', 'subtype', 'status', 'version'] },
  { table: 'request_time_off', columns: ['request_id'] },
  { table: 'vacation_selections', columns: ['id', 'status', 'version'] },
  { table: 'memberships', columns: ['id', 'user_id', 'kind', 'group_role'] },
];

async function census(): Promise<Record<string, { count: number; digest: string }>> {
  const result: Record<string, { count: number; digest: string }> = {};
  for (const entry of CENSUS) {
    const rows = (await asScheduler(async (uow) =>
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
 * A request owned by the MEMBER, decided by the SCHEDULER, with its decision row.
 *
 * Written through the tenant contexts that production uses for each half —
 * `requests_own` admits the member's creation, `approvals_group_administration`
 * admits the scheduler's decision — so a row that appears here is one the shipped
 * paths could have produced.
 */
async function decidedRequest(): Promise<{ requestId: string; approvalId: string }> {
  const requestId = await asMember(async ({ query }) => {
    const id = randomUUID();
    await sql`
      insert into requests
        (id, organization_id, group_id, membership_id, subtype, status, expires_at,
         idempotency_key)
      values (${id}::uuid, ${member.organizationId}::uuid, ${member.groupId}::uuid,
              ${member.membershipId}::uuid, ${'time-off'},
              app_request_initial_status(${'time-off'}),
              ${'2099-06-01T00:00:00.000Z'}::timestamptz,
              ${`cycle24.${randomUUID().slice(0, 12)}`})
    `.execute(query);
    await sql`
      insert into request_time_off (request_id, organization_id, group_id, target_date)
      values (${id}::uuid, ${member.organizationId}::uuid, ${member.groupId}::uuid,
              ${'2048-02-03'}::date)
    `.execute(query);
    /* The two-step, one statement per edge, because §2 has no
     * `submitted → approved` cell. */
    await sql`update requests set status = 'submitted' where id = ${id}::uuid`.execute(query);
    await sql`update requests set status = 'under_review' where id = ${id}::uuid`.execute(query);
    return id;
  });

  const approvalId = await asScheduler(async ({ query }) => {
    await sql`
      update requests
         set status = 'approved', decided_at = now(),
             decided_by = ${scheduler.membershipId}::uuid
       where id = ${requestId}::uuid
    `.execute(query);
    const inserted = await sql<{ id: string }>`
      insert into approvals
        (organization_id, group_id, request_id, decision, decided_by, reason)
      values (${scheduler.organizationId}::uuid, ${scheduler.groupId}::uuid,
              ${requestId}::uuid, ${'approved'}, ${scheduler.membershipId}::uuid, null)
      returning id
    `.execute(query);
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('the fixture approval was not inserted');
    return id;
  });

  return { requestId, approvalId };
}

/** How many `approvals` rows a context can SEE. */
async function visibleTo(context: typeof scheduler): Promise<number> {
  const rows = await runtime.runner.run(
    context,
    async ({ query }) =>
      await sql<{ n: string }>`select count(*)::text as n from approvals`.execute(query),
  );
  return Number(rows.rows[0]?.n ?? '0');
}

beforeAll(async () => {
  runtime = createRuntime('app_runtime', { max: 4 });
  const alpha = multi().alpha;
  scheduler = {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    membershipId: alpha.users.scheduler.membershipId,
    correlationId: 'cycle24-scheduler',
  };
  member = {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    membershipId: alpha.users.member.membershipId,
    correlationId: 'cycle24-member',
  };
}, 240_000);

afterAll(async () => {
  await runtime?.destroy();
});

describe('migration 0024 over a populated database', () => {
  it('up → down → up, resolved and asserted BY NAME', async () => {
    await decidedRequest();
    expect(await visibleTo(scheduler), 'the cycle must have rows to be about').toBeGreaterThan(0);
    const censusBefore = await census();

    let up: readonly string[] = [];
    let midway: Record<string, { count: number; digest: string }> | undefined;
    const down: string[] = [];
    try {
      while (!down.some((name) => name.includes('0024'))) {
        const step = await migrate('down', { count: 1 });
        if (step.applied.length === 0) {
          throw new Error('ran out of migrations before reaching 0024 — the ledger is empty');
        }
        down.push(...step.applied);
      }
      midway = await census();
    } finally {
      up = (await migrate('up', { count: down.length })).applied;
    }

    /* The census is over tables 0024 does NOT own, so it must be identical at the
     * midpoint as well as at the end — 0024 is additive, so reversing it takes
     * `approvals` away and touches nothing else. That is the property this
     * migration's purely-additive claim reduces to. */
    expect(midway, 'the census must have been taken before the re-up').toBeDefined();
    expect(midway).toEqual(censusBefore);

    expect(up).toHaveLength(down.length);
    expect(up.some((name) => name.includes('0024'))).toBe(true);
    expect(await census()).toEqual(censusBefore);

    /* The decision rows are GONE — 0024 owns the table, so reversing it drops
     * them, and saying so is the point (the 0020/0022 precedent). The requests
     * they were about survive, which is what "additive" means from the other
     * side. */
    expect(await visibleTo(scheduler)).toBe(0);
  }, 300_000);

  it('the table comes back ENFORCING: every CHECK refuses, in both directions', async () => {
    const { requestId, approvalId } = await decidedRequest();

    const attempt = (
      values: Record<string, unknown>,
    ): Promise<unknown> =>
      asScheduler(
        async ({ query }) =>
          await sql`
            insert into approvals
              (organization_id, group_id, request_id, decision, decided_by, reason,
               is_override, vacation_selection_id, supersedes_approval_id)
            values (${scheduler.organizationId}::uuid, ${scheduler.groupId}::uuid,
                    ${requestId}::uuid, ${values['decision']}, ${scheduler.membershipId}::uuid,
                    ${values['reason']}, ${values['isOverride'] ?? false},
                    ${values['selectionId'] ?? null}::uuid,
                    ${values['supersedes'] ?? null}::uuid)
          `.execute(query),
      );

    /* The decision domain. */
    await expect(attempt({ decision: 'maybe', reason: 'A decision outside the domain.' }))
      .rejects.toMatchObject({ code: '23514' });

    /* The mandatory-reason rule, BOTH directions — a denial with none, and an
     * approval with one. A CHECK that enforced only the first would let new free
     * text onto a SENSITIVE-PII aggregate that no specification asks for. */
    await expect(attempt({ decision: 'denied', reason: null })).rejects.toMatchObject({
      code: '23514',
    });
    await expect(
      attempt({ decision: 'approved', reason: 'An approval needs no explanation.' }),
    ).rejects.toMatchObject({ code: '23514' });

    /* Whitespace is not a reason: `length(btrim(reason)) BETWEEN 1 AND 1000`. */
    await expect(attempt({ decision: 'denied', reason: '   ' })).rejects.toMatchObject({
      code: '23514',
    });
    await expect(
      attempt({ decision: 'denied', reason: 'x'.repeat(1001) }),
    ).rejects.toMatchObject({ code: '23514' });

    /* An override is a QUOTA act, so it must name a selection. */
    await expect(
      attempt({
        decision: 'approved',
        reason: 'An override with no selection has no referent.',
        isOverride: true,
      }),
    ).rejects.toMatchObject({ code: '23514' });

    /* A reversal names its predecessor, and only a reversal does. */
    await expect(
      attempt({ decision: 'reversed', reason: 'A reversal that names nothing.' }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      attempt({
        decision: 'denied',
        reason: 'A denial that names a predecessor it does not supersede.',
        supersedes: approvalId,
      }),
    ).rejects.toMatchObject({ code: '23514' });

    /* …and the LEGAL shapes still work, so the arms above are not passing because
     * everything is refused. */
    await expect(
      attempt({ decision: 'denied', reason: 'The department is short-staffed that week.' }),
    ).resolves.toBeDefined();
    await expect(
      attempt({
        decision: 'reversed',
        reason: 'Reversed because the cover was found elsewhere.',
        supersedes: approvalId,
      }),
    ).resolves.toBeDefined();
  }, 180_000);

  it('"never overwritten" is a PRIVILEGE — UPDATE and DELETE raise 42501', async () => {
    /* Driven rather than read off `information_schema`: a grant table says what
     * was granted, and this says what a statement can do. `42501` is
     * `insufficient_privilege`, the same class every other absent grant raises. */
    const { approvalId } = await decidedRequest();

    await expect(
      asScheduler(
        async ({ query }) =>
          await sql`
            update approvals set decision = 'denied' where id = ${approvalId}::uuid
          `.execute(query),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      asScheduler(
        async ({ query }) =>
          await sql`delete from approvals where id = ${approvalId}::uuid`.execute(query),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    /* The row is exactly as it was. */
    const after = await asScheduler(
      async ({ query }) =>
        await sql<{ decision: string }>`
          select decision from approvals where id = ${approvalId}::uuid
        `.execute(query),
    );
    expect(after.rows[0]?.decision).toBe('approved');
  }, 180_000);

  it('the three RLS arms are enforcing, and `approvals_own` is READ-ONLY', async () => {
    const { requestId } = await decidedRequest();

    /* The requester READS the decision on their own request — that is how they
     * learn they were approved, and it is what carries a denial's reason to the
     * person it is for. */
    const own = await asMember(
      async ({ query }) =>
        await sql<{ decision: string }>`
          select decision from approvals where request_id = ${requestId}::uuid
        `.execute(query),
    );
    expect(own.rows.length, 'a member must see the decision on their OWN request').toBe(1);

    /* …and cannot WRITE one. `approvals_own` is `FOR SELECT`, which is the one
     * deliberate difference from 0023's `requests_own` (`FOR ALL`): submitting and
     * withdrawing are self-scoped acts, deciding is not. The refusal is the RLS
     * `WITH CHECK` — `42501` — rather than a constraint. */
    await expect(
      asMember(
        async ({ query }) =>
          await sql`
            insert into approvals
              (organization_id, group_id, request_id, decision, decided_by, reason)
            values (${member.organizationId}::uuid, ${member.groupId}::uuid,
                    ${requestId}::uuid, ${'approved'}, ${member.membershipId}::uuid, null)
          `.execute(query),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    /* And the ADMINISTRATION arm admits the same write for a holder of
     * `requests.administer`, so the refusal above is about the KEY and not about
     * the table being unwritable. */
    await expect(
      asScheduler(
        async ({ query }) =>
          await sql`
            insert into approvals
              (organization_id, group_id, request_id, decision, decided_by, reason)
            values (${scheduler.organizationId}::uuid, ${scheduler.groupId}::uuid,
                    ${requestId}::uuid, ${'denied'},
                    ${scheduler.membershipId}::uuid, ${'A second decision, for the arm test.'})
          `.execute(query),
      ),
    ).resolves.toBeDefined();
  }, 180_000);
});
