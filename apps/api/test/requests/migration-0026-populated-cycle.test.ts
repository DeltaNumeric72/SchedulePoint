import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate } from '../../src/db/migrate.js';
import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import { digestRows } from '../../src/schedule/render.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * **Migration 0026, up → down → up, over a POPULATED database** (OPUS-M5-00C;
 * doc 42 §5g Acceptance, "a populated cycle for the new migration").
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## What 0026 does, and therefore what a cycle of it has to prove
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 0026 creates ONE table, `request_comments`, with three RLS arms, one index,
 * and `SELECT, INSERT` to `app_runtime` and nothing else. It is purely
 * additive: it replaces no policy, redefines no function, relaxes no constraint
 * and widens no grant. So there is nothing to restore byte-for-byte — the down
 * drops what the up created and stops — and this file asserts that everything
 * ELSE is untouched by it.
 *
 * Five things, then:
 *
 *   1. the table comes back **ENFORCING** — not merely present. Every CHECK is
 *      driven to its refusal, in both directions where the constraint has two;
 *   2. **FAD-58.1's exactly-one-of rule holds at the DATABASE**: a requester row
 *      carrying prose and a scheduler row carrying a code are both refused, so
 *      "no requester-authored free text exists in this system" is a property of
 *      the schema rather than of the callers;
 *   3. **"append-only" is a PRIVILEGE** — asserted by driving an UPDATE and a
 *      DELETE and getting `42501`, not by reading the grant table;
 *   4. the three RLS arms are enforcing, **including the two `WITH CHECK`
 *      predicates that pin the CHANNEL and the AUTHOR** — the property that
 *      makes a requester-channel row's author necessarily the requester, and
 *      that stops an administrator attaching a code to a colleague's request;
 *   5. everything 0026 does not own is untouched, by census.
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
 * organization, site or person name from the research appears here; the comment
 * bodies are administrative notes about a synthetic roster and nothing in them
 * is clinical.
 */

const multi = ownedMulti('requests-migration-0026-cycle', {
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
/** The REQUESTER — a `member`, holding no administrative request key at all. */
let member: typeof scheduler;

const asScheduler = async <T>(fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> =>
  runtime.runner.run(scheduler, fn);
const asMember = async <T>(fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> =>
  runtime.runner.run(member, fn);

/** The tables the cycle must leave untouched. */
const CENSUS: readonly { table: string; columns: readonly string[] }[] = [
  { table: 'requests', columns: ['id', 'subtype', 'status', 'version'] },
  { table: 'request_time_off', columns: ['request_id'] },
  { table: 'approvals', columns: ['id', 'decision', 'reason'] },
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
 * A `submitted` time-off request owned by the MEMBER.
 *
 * Written through the member's own tenant context — `requests_own` admits the
 * creation — so a row that appears here is one the shipped submission path could
 * have produced. The status walk is one statement per EDGE because 0021's guard
 * evaluates one edge at a time.
 */
async function memberRequest(): Promise<string> {
  return asMember(async ({ query }) => {
    const id = randomUUID();
    await sql`
      insert into requests
        (id, organization_id, group_id, membership_id, subtype, status, expires_at,
         idempotency_key)
      values (${id}::uuid, ${member.organizationId}::uuid, ${member.groupId}::uuid,
              ${member.membershipId}::uuid, ${'time-off'},
              app_request_initial_status(${'time-off'}),
              ${'2099-06-01T00:00:00.000Z'}::timestamptz,
              ${`cycle26.${randomUUID().slice(0, 12)}`})
    `.execute(query);
    await sql`
      insert into request_time_off (request_id, organization_id, group_id, target_date)
      values (${id}::uuid, ${member.organizationId}::uuid, ${member.groupId}::uuid,
              ${'2049-03-08'}::date)
    `.execute(query);
    await sql`update requests set status = 'submitted' where id = ${id}::uuid`.execute(query);
    return id;
  });
}

/** A commented request: the member's own code, and the scheduler's note. */
async function commentedRequest(): Promise<string> {
  const requestId = await memberRequest();

  await asMember(
    async ({ query }) =>
      await sql`
        insert into request_comments
          (organization_id, group_id, request_id, channel, reason_code, body,
           author_membership_id)
        values (${member.organizationId}::uuid, ${member.groupId}::uuid, ${requestId}::uuid,
                ${'requester'}, ${'childcare'}, ${null}, ${member.membershipId}::uuid)
      `.execute(query),
  );

  await asScheduler(
    async ({ query }) =>
      await sql`
        insert into request_comments
          (organization_id, group_id, request_id, channel, reason_code, body,
           author_membership_id)
        values (${scheduler.organizationId}::uuid, ${scheduler.groupId}::uuid,
                ${requestId}::uuid, ${'scheduler'}, ${null},
                ${'Noted — the rota already has cover that week.'},
                ${scheduler.membershipId}::uuid)
      `.execute(query),
  );

  return requestId;
}

/** How many `request_comments` rows a context can SEE. */
async function visibleTo(context: typeof scheduler): Promise<number> {
  const rows = await runtime.runner.run(
    context,
    async ({ query }) =>
      await sql<{ n: string }>`select count(*)::text as n from request_comments`.execute(query),
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
    correlationId: 'cycle26-scheduler',
  };
  member = {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    membershipId: alpha.users.member.membershipId,
    correlationId: 'cycle26-member',
  };
}, 240_000);

afterAll(async () => {
  await runtime?.destroy();
});

describe('migration 0026 over a populated database', () => {
  it('up → down → up, resolved and asserted BY NAME', async () => {
    await commentedRequest();
    expect(await visibleTo(scheduler), 'the cycle must have rows to be about').toBeGreaterThan(0);
    const censusBefore = await census();

    let up: readonly string[] = [];
    let midway: Record<string, { count: number; digest: string }> | undefined;
    const down: string[] = [];
    try {
      while (!down.some((name) => name.includes('0026'))) {
        const step = await migrate('down', { count: 1 });
        if (step.applied.length === 0) {
          throw new Error('ran out of migrations before reaching 0026 — the ledger is empty');
        }
        down.push(...step.applied);
      }
      midway = await census();
    } finally {
      up = (await migrate('up', { count: down.length })).applied;
    }

    /* The census is over tables 0026 does NOT own, so it must be identical at
     * the midpoint as well as at the end — 0026 is additive, so reversing it
     * takes `request_comments` away and touches nothing else. That is what this
     * migration's purely-additive claim reduces to. */
    expect(midway, 'the census must have been taken before the re-up').toBeDefined();
    expect(midway).toEqual(censusBefore);

    expect(up).toHaveLength(down.length);
    expect(up.some((name) => name.includes('0026'))).toBe(true);
    expect(await census()).toEqual(censusBefore);

    /* The comments are GONE — 0026 owns the table, so reversing it drops them,
     * and saying so is the point (the 0020/0022/0024 precedent). The requests
     * they were about survive, which is what "additive" means from the other
     * side. */
    expect(await visibleTo(scheduler)).toBe(0);
  }, 300_000);

  it('the table comes back ENFORCING: every CHECK refuses, in both directions', async () => {
    const requestId = await memberRequest();

    /* ── Two drivers, because the RLS arms decide WHICH constraint is reachable
     *
     * Migration 0026's two write arms pin the CHANNEL: the own-arm admits only
     * `requester` rows on the actor's own request, the administration arm only
     * `scheduler` rows. So a CHECK about the requester channel is only
     * REACHABLE as the requester, and one about the scheduler channel only as
     * the decider — drive them the other way round and the POLICY refuses first
     * (`42501`) and the constraint is never consulted.
     *
     * That is a strengthening rather than an obstacle, and it is recorded here
     * rather than worked around: the same shape M5-001 recorded when the
     * SENSITIVE-PII narrowing moved the X-11 oracle's class from `23503` to
     * `42501` — "the narrowing refuses one layer earlier than the FK". Each
     * constraint below is driven by whichever actor can reach it, so every
     * assertion is about the CONSTRAINT and none is about the arms.
     */
    const asMemberOwnRow = (values: Record<string, unknown>): Promise<unknown> =>
      asMember(
        async ({ query }) =>
          await sql`
            insert into request_comments
              (organization_id, group_id, request_id, channel, reason_code, body,
               author_membership_id)
            values (${member.organizationId}::uuid, ${member.groupId}::uuid,
                    ${requestId}::uuid, ${values['channel']}, ${values['reasonCode'] ?? null},
                    ${values['body'] ?? null}, ${member.membershipId}::uuid)
          `.execute(query),
      );

    const asSchedulerRow = (values: Record<string, unknown>): Promise<unknown> =>
      asScheduler(
        async ({ query }) =>
          await sql`
            insert into request_comments
              (organization_id, group_id, request_id, channel, reason_code, body,
               author_membership_id)
            values (${scheduler.organizationId}::uuid, ${scheduler.groupId}::uuid,
                    ${requestId}::uuid, ${values['channel']}, ${values['reasonCode'] ?? null},
                    ${values['body'] ?? null}, ${scheduler.membershipId}::uuid)
          `.execute(query),
      );

    /* ── FAD-58.1's exactly-one-of rule, BOTH directions ───────────────────────
     *
     * These four are the reason this migration exists in the shape it does. A
     * requester row carrying PROSE is the violation the whole ruling is about:
     * I-07 forbids clinical free text, not merely patient identifiers, and a
     * length bound bounds size rather than kind. It is refused by the SCHEMA, so
     * it is refused on every path including one that never touched the service.
     *
     * The other direction matters just as much and is easier to forget: a
     * SCHEDULER row carrying a CODE would be a decider attributing a
     * circumstance to the person whose request it is. */
    await expect(
      asMemberOwnRow({ channel: 'requester', reasonCode: 'childcare', body: 'and here is why' }),
      'a requester row must not be able to carry prose',
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      asMemberOwnRow({ channel: 'requester' }),
      'a requester row with neither a code nor a body is not a comment',
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      asSchedulerRow({ channel: 'scheduler', reasonCode: 'childcare', body: 'A note.' }),
      'a scheduler row must not be able to carry a reason code',
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      asSchedulerRow({ channel: 'scheduler' }),
    ).rejects.toMatchObject({ code: '23514' });

    /* The vocabulary. A code outside the nine is refused by the CHECK domain —
     * the third copy of the list, held to the domain's and the wire's by
     * `comment-vocabulary-agreement.test.ts`. `medical` specifically, because
     * the ABSENCE of a clinical code is FAD-58.1's design rather than an
     * oversight. */
    await expect(
      asMemberOwnRow({ channel: 'requester', reasonCode: 'medical' }),
    ).rejects.toMatchObject({ code: '23514' });

    /* Whitespace is not a comment, and neither is a novel:
     * `length(btrim(body)) BETWEEN 1 AND 1000`. */
    await expect(asSchedulerRow({ channel: 'scheduler', body: '   ' })).rejects.toMatchObject({
      code: '23514',
    });
    await expect(
      asSchedulerRow({ channel: 'scheduler', body: 'x'.repeat(1001) }),
    ).rejects.toMatchObject({ code: '23514' });
    /* …and the bound is INCLUSIVE, so the refusal above is about being over it. */
    await expect(
      asSchedulerRow({ channel: 'scheduler', body: 'x'.repeat(1000) }),
    ).resolves.toBeDefined();

    /* ── The channel DOMAIN check is a backstop, and the honest report is that
     * no runtime role can reach it.
     *
     * `request_comments_channel_domain` refuses anything outside the two
     * channels — but both write arms pin the channel, so an out-of-domain value
     * is refused by the POLICY one layer earlier and answers `42501`, not
     * `23514`. The constraint still earns its place: it is what holds if a policy
     * arm were ever loosened, and it is what a role with `BYPASSRLS` would meet.
     * Asserted as what it IS rather than as what a reader might expect, with
     * both drivers checked so the claim is about the value and not about the
     * actor. */
    await expect(
      asMemberOwnRow({ channel: 'auditor', reasonCode: 'travel' }),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asSchedulerRow({ channel: 'auditor', body: 'A channel outside the domain.' }),
    ).rejects.toMatchObject({ code: '42501' });

    /* …and BOTH LEGAL shapes still work, so the arms above are not passing
     * because everything is refused (FAD-15). */
    await expect(
      asMemberOwnRow({ channel: 'requester', reasonCode: 'travel' }),
    ).resolves.toBeDefined();
    await expect(
      asSchedulerRow({ channel: 'scheduler', body: 'The rota already has cover that week.' }),
    ).resolves.toBeDefined();
  }, 180_000);

  it('"append-only" is a PRIVILEGE — UPDATE and DELETE raise 42501', async () => {
    /* Driven rather than read off `information_schema`: a grant table says what
     * was granted, and this says what a statement can do. `42501` is
     * `insufficient_privilege`, the same class every other absent grant raises,
     * and it is what makes FAD-58.3's "correction is a new comment" a fact about
     * the database rather than an instruction to callers. */
    const requestId = await commentedRequest();

    await expect(
      asScheduler(
        async ({ query }) =>
          await sql`
            update request_comments set body = 'edited'
             where request_id = ${requestId}::uuid
          `.execute(query),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      asScheduler(
        async ({ query }) =>
          await sql`delete from request_comments where request_id = ${requestId}::uuid`.execute(
            query,
          ),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    /* The rows are exactly as they were. */
    const after = await asScheduler(
      async ({ query }) =>
        await sql<{ channel: string; reason_code: string | null }>`
          select channel, reason_code from request_comments
           where request_id = ${requestId}::uuid
           order by created_at, id
        `.execute(query),
    );
    expect(after.rows.map((row) => row.channel)).toEqual(['requester', 'scheduler']);
    expect(after.rows[0]?.reason_code).toBe('childcare');
  }, 180_000);

  it('the three RLS arms are enforcing, and the own-arm is WRITEABLE where `approvals_own` is not', async () => {
    const requestId = await memberRequest();

    /* The requester writes their own code. `request_comments_own` is `FOR ALL`,
     * which is the deliberate INVERSION of 0024's `approvals_own` (`FOR SELECT`):
     * deciding is not a self-scoped act, and commenting on one's own request is. */
    await expect(
      asMember(
        async ({ query }) =>
          await sql`
            insert into request_comments
              (organization_id, group_id, request_id, channel, reason_code, body,
               author_membership_id)
            values (${member.organizationId}::uuid, ${member.groupId}::uuid, ${requestId}::uuid,
                    ${'requester'}, ${'travel'}, ${null}, ${member.membershipId}::uuid)
          `.execute(query),
      ),
    ).resolves.toBeDefined();

    /* …and reads BOTH channels on their own request. There is no internal-note
     * class: §4 names one comment surface, and 0024's `approvals_own` exists
     * precisely so a decision's reason reaches the person it is for. */
    await asScheduler(
      async ({ query }) =>
        await sql`
          insert into request_comments
            (organization_id, group_id, request_id, channel, reason_code, body,
             author_membership_id)
          values (${scheduler.organizationId}::uuid, ${scheduler.groupId}::uuid,
                  ${requestId}::uuid, ${'scheduler'}, ${null},
                  ${'Seen; the week is already covered.'}, ${scheduler.membershipId}::uuid)
        `.execute(query),
    );
    const seenByOwner = await asMember(
      async ({ query }) =>
        await sql<{ channel: string }>`
          select channel from request_comments where request_id = ${requestId}::uuid
        `.execute(query),
    );
    expect(
      seenByOwner.rows.map((row) => row.channel).sort(),
      'the requester must see BOTH channels on their own request',
    ).toEqual(['requester', 'scheduler']);
  }, 180_000);

  it('the two WITH CHECK predicates pin the CHANNEL and the AUTHOR — a code cannot be forged onto a colleague', async () => {
    /* ── The strongest property this migration has, driven rather than read ────
     *
     * Both write arms require the row's `channel` to match the arm and its
     * `author_membership_id` to BE the acting membership. Two consequences no
     * application code maintains:
     *
     *   * a `requester`-channel row's author is NECESSARILY the requester of the
     *     request it is on — because the only arm admitting that channel is the
     *     own-arm, whose `USING`/`WITH CHECK` require the request to belong to
     *     the actor;
     *   * **an administrator cannot attach a CODE to a colleague's request**,
     *     which would be attributing a circumstance to the person whose request
     *     it is — FAD-58.1's precise prevention.
     *
     * Both refusals are `42501` (the RLS `WITH CHECK`), not `23514`: it is the
     * POLICY refusing, not a constraint, which is what makes this a statement
     * about the arms rather than about the columns. */
    const requestId = await memberRequest();

    /* The scheduler holds `requests.administer` by role and can write this table
     * — proven below — and still cannot write the requester channel. */
    await expect(
      asScheduler(
        async ({ query }) =>
          await sql`
            insert into request_comments
              (organization_id, group_id, request_id, channel, reason_code, body,
               author_membership_id)
            values (${scheduler.organizationId}::uuid, ${scheduler.groupId}::uuid,
                    ${requestId}::uuid, ${'requester'}, ${'bereavement'}, ${null},
                    ${scheduler.membershipId}::uuid)
          `.execute(query),
      ),
      'an administrator must not be able to attribute a reason code to a colleague',
    ).rejects.toMatchObject({ code: '42501' });

    /* Nor can they forge the AUTHOR — writing a requester-channel row that names
     * the MEMBER as its author, which is the same attribution by another route. */
    await expect(
      asScheduler(
        async ({ query }) =>
          await sql`
            insert into request_comments
              (organization_id, group_id, request_id, channel, reason_code, body,
               author_membership_id)
            values (${scheduler.organizationId}::uuid, ${scheduler.groupId}::uuid,
                    ${requestId}::uuid, ${'requester'}, ${'bereavement'}, ${null},
                    ${member.membershipId}::uuid)
          `.execute(query),
      ),
      'the author may not be somebody the author was not',
    ).rejects.toMatchObject({ code: '42501' });

    /* …and the MEMBER cannot write the scheduler channel on their own request,
     * which is the same pin from the other side: the own-arm admits `requester`
     * and nothing else, so a member cannot open a free-text field for themselves
     * by naming the other channel. **This is the assertion that makes
     * "requester-authored free text does not exist in this system" true against
     * a determined caller rather than against a well-behaved one.** */
    await expect(
      asMember(
        async ({ query }) =>
          await sql`
            insert into request_comments
              (organization_id, group_id, request_id, channel, reason_code, body,
               author_membership_id)
            values (${member.organizationId}::uuid, ${member.groupId}::uuid, ${requestId}::uuid,
                    ${'scheduler'}, ${null}, ${'the honest answer, in my own words'},
                    ${member.membershipId}::uuid)
          `.execute(query),
      ),
      'a member must not reach free text by naming the other channel',
    ).rejects.toMatchObject({ code: '42501' });

    /* …and a member cannot forge an author on their OWN channel either. */
    await expect(
      asMember(
        async ({ query }) =>
          await sql`
            insert into request_comments
              (organization_id, group_id, request_id, channel, reason_code, body,
               author_membership_id)
            values (${member.organizationId}::uuid, ${member.groupId}::uuid, ${requestId}::uuid,
                    ${'requester'}, ${'travel'}, ${null}, ${scheduler.membershipId}::uuid)
          `.execute(query),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    /* The POSITIVE control, without which every refusal above could be passing
     * because nobody can write this table at all (FAD-15). The administration
     * arm admits the scheduler's own channel, authored by the scheduler. */
    await expect(
      asScheduler(
        async ({ query }) =>
          await sql`
            insert into request_comments
              (organization_id, group_id, request_id, channel, reason_code, body,
               author_membership_id)
            values (${scheduler.organizationId}::uuid, ${scheduler.groupId}::uuid,
                    ${requestId}::uuid, ${'scheduler'}, ${null},
                    ${'The week is covered; no action needed.'},
                    ${scheduler.membershipId}::uuid)
          `.execute(query),
      ),
    ).resolves.toBeDefined();
  }, 180_000);
});
