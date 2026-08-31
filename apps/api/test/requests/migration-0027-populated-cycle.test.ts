import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate } from '../../src/db/migrate.js';
import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import { digestRows } from '../../src/schedule/render.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * **Migration 0027, up → down → up, over a POPULATED database** (OPUS-M5-004;
 * doc 42 §5h, "a populated cycle for every new migration").
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## What 0027 does, and therefore what a cycle of it has to prove
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Four things, and only the first is a plain creation:
 *
 *  1. **FAD-59's ledger** — `vacation_commit_commands`, two policy arms, one
 *     index, `SELECT, INSERT` to `app_runtime` **and nothing else**. "Nothing
 *     else" is stricter than 0022's sibling, which holds a column-level
 *     `GRANT UPDATE (outcome)`; here there is none, which is why the row is
 *     written once at the end of the commit, complete.
 *  2. **FAD-59's per-selection CHECK** on 0022's `vacation_selections` —
 *     `(status = 'committed') = (committed_to_version_id IS NOT NULL)`, an
 *     EQUALITY, so both directions are violations and both are driven below.
 *  3. **`vacation_commit` joining the assignment ORIGIN vocabulary** — the one
 *     thing in this migration that REPLACES rather than adds, so the down side
 *     has something to restore byte-for-byte and this file checks that it did.
 *  4. **The solver-projection READ PLANE** — seven additive SELECT-only arms
 *     gated on a transaction-local purpose token. Four properties are proven:
 *     closed without the token, open with it, CLEARED after it, and mutually
 *     isolated from migration 0012's plane in BOTH directions.
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

const multi = ownedMulti('requests-migration-0027-cycle', {
  profile: 'core',
  seed: { catalogue: ['alpha'] },
});

let runtime: Runtime;
/** A `scheduler`, so `requests.administer` and `requests.read_any` are theirs by role. */
let scheduler: {
  organizationId: string;
  groupId: string;
  membershipId: string;
  correlationId: string;
};
/** A `member`, holding no administrative request key at all. */
let member: typeof scheduler;

let vacationPeriodId: string;
let draftVersionId: string;
let selectionId: string;

const asScheduler = async <T>(fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> =>
  runtime.runner.run(scheduler, fn);
const asMember = async <T>(fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> =>
  runtime.runner.run(member, fn);

/** The tables the cycle must leave untouched. */
const CENSUS: readonly { table: string; columns: readonly string[] }[] = [
  { table: 'requests', columns: ['id', 'subtype', 'status', 'version'] },
  { table: 'vacation_selections', columns: ['id', 'status', 'version'] },
  { table: 'vacation_periods', columns: ['id', 'mode', 'state'] },
  { table: 'schedule_versions', columns: ['id', 'state'] },
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

/** How many ledger rows a context can SEE. */
async function ledgerRowsVisible(): Promise<number> {
  const rows = await asScheduler(
    async ({ query }) =>
      await sql<{
        n: string;
      }>`select count(*)::text as n from vacation_commit_commands`.execute(query),
  );
  return Number(rows.rows[0]?.n ?? '0');
}

/** One well-formed ledger row, written the way the commit writes it. */
async function insertLedgerRow(idempotencyKey: string): Promise<void> {
  await asScheduler(
    async ({ query }) =>
      await sql`
        insert into vacation_commit_commands
          (organization_id, group_id, vacation_period_id, target_version_id,
           acting_membership_id, idempotency_key, outcome)
        values (${scheduler.organizationId}::uuid, ${scheduler.groupId}::uuid,
                ${vacationPeriodId}::uuid, ${draftVersionId}::uuid,
                ${scheduler.membershipId}::uuid, ${idempotencyKey}, ${'committed'})
      `.execute(query),
  );
}

const key = (label: string): string => `${label}.${randomUUID().slice(0, 12)}`;

beforeAll(async () => {
  runtime = createRuntime('app_runtime', { max: 4 });
  const alpha = multi().alpha;
  scheduler = {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    membershipId: alpha.users.scheduler.membershipId,
    correlationId: 'cycle27-scheduler',
  };
  member = {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    membershipId: alpha.users.member.membershipId,
    correlationId: 'cycle27-member',
  };

  /* The round, the schedule period, and a DRAFT version — everything FAD-59's
   * ledger row's four foreign keys need. Written under the scheduler's own
   * tenant context, so a row that exists here is one a real path could produce. */
  await asScheduler(async ({ query }) => {
    const period = await sql<{ id: string }>`
      insert into vacation_periods
        (organization_id, group_id, start_date, end_date, mode, state)
      values (${scheduler.organizationId}::uuid, ${scheduler.groupId}::uuid,
              ${'2071-06-01'}::date, ${'2071-07-03'}::date, ${'quota'}, ${'open'})
      returning id
    `.execute(query);
    vacationPeriodId = period.rows[0]?.id ?? '';

    const schedulePeriodId = randomUUID();
    await sql`
      insert into schedule_periods (id, organization_id, group_id, name, start_date, end_date)
      values (${schedulePeriodId}::uuid, ${scheduler.organizationId}::uuid,
              ${scheduler.groupId}::uuid, ${'cycle27 round'}, ${'2071-06-01'}::date,
              ${'2071-07-31'}::date)
    `.execute(query);

    draftVersionId = randomUUID();
    await sql`
      insert into schedule_versions (id, organization_id, group_id, period_id, state)
      values (${draftVersionId}::uuid, ${scheduler.organizationId}::uuid,
              ${scheduler.groupId}::uuid, ${schedulePeriodId}::uuid, ${'draft'})
    `.execute(query);
  });

  /* An `available` selection: the one status §5.3 gives no root row, so it needs
   * nothing else to exist and it is what the per-selection CHECK is driven on. */
  await asMember(async ({ query }) => {
    const inserted = await sql<{ id: string }>`
      insert into vacation_selections
        (organization_id, group_id, membership_id, vacation_period_id, week_start, status)
      values (${member.organizationId}::uuid, ${member.groupId}::uuid,
              ${member.membershipId}::uuid, ${vacationPeriodId}::uuid,
              ${'2071-06-01'}::date, ${'available'})
      returning id
    `.execute(query);
    selectionId = inserted.rows[0]?.id ?? '';
  });
}, 240_000);

afterAll(async () => {
  await runtime?.destroy();
});

describe('migration 0027 over a populated database', () => {
  it('up → down → up, resolved and asserted BY NAME', async () => {
    await insertLedgerRow(key('cycle27.pop'));
    expect(await ledgerRowsVisible(), 'the cycle must have rows to be about').toBeGreaterThan(0);
    const censusBefore = await census();

    let up: readonly string[] = [];
    let midway: Record<string, { count: number; digest: string }> | undefined;
    const down: string[] = [];
    try {
      while (!down.some((name) => name.includes('0027'))) {
        const step = await migrate('down', { count: 1 });
        if (step.applied.length === 0) {
          throw new Error('ran out of migrations before reaching 0027 — the ledger is empty');
        }
        down.push(...step.applied);
      }
      midway = await census();
    } finally {
      up = (await migrate('up', { count: down.length })).applied;
    }

    /* The census is over tables 0027 does NOT own. Reversing 0027 takes the
     * ledger away, drops one CHECK, restores two others and removes seven policy
     * arms — and touches no ROW anywhere. That is what its additive claim
     * reduces to, at the midpoint as well as at the end. */
    expect(midway, 'the census must have been taken before the re-up').toBeDefined();
    expect(midway).toEqual(censusBefore);

    expect(up).toHaveLength(down.length);
    expect(up.some((name) => name.includes('0027'))).toBe(true);
    expect(await census()).toEqual(censusBefore);

    /* The ledger rows are GONE — 0027 owns the table, so reversing it drops
     * them, and saying so is the point (the 0022/0024/0026 precedent). The
     * period, the version and the selections they were about all survive, which
     * is what "additive" means from the other side. */
    expect(await ledgerRowsVisible()).toBe(0);
  }, 300_000);

  it('the ORIGIN widening is deliberately NOT reversed — and the file says why', async () => {
    /* The one thing 0027's down side does not undo, asserted rather than left in
     * a comment. Narrowing the domain back would either FAIL against any
     * `vacation_commit` snapshot (measured: it did, and it took eighteen test
     * files with it) or succeed only by DELETING assignment snapshots a
     * published version may carry — which I-18 forbids.
     *
     * So after a full cycle the widened domain is still there, and the residue
     * is inert: nothing writes the value in a tree where 0027 is reversed. */
    const rows = await asScheduler(
      async ({ query }) =>
        await sql<{ definition: string }>`
          select pg_get_constraintdef(oid) as definition
            from pg_constraint
           where conname = 'assignment_snapshots_origin_domain'
        `.execute(query),
    );
    expect(rows.rows[0]?.definition, 'the widened domain survives the cycle').toContain(
      'vacation_commit',
    );
  });

  it('the ledger comes back ENFORCING — every constraint refuses', async () => {
    /* The key SHAPE. 0022's spelling character for character, and a space is the
     * cheapest thing that violates it. */
    await expect(
      asScheduler(
        async ({ query }) =>
          await sql`
            insert into vacation_commit_commands
              (organization_id, group_id, vacation_period_id, target_version_id,
               acting_membership_id, idempotency_key, outcome)
            values (${scheduler.organizationId}::uuid, ${scheduler.groupId}::uuid,
                    ${vacationPeriodId}::uuid, ${draftVersionId}::uuid,
                    ${scheduler.membershipId}::uuid, ${'not a key'}, ${'committed'})
          `.execute(query),
      ),
      'a malformed idempotency key must be refused by the CHECK',
    ).rejects.toMatchObject({ code: '23514' });

    /* The OUTCOME domain. One member today (migration 0027 header §2), and the
     * CHECK is what makes that a property rather than a convention. */
    await expect(
      asScheduler(
        async ({ query }) =>
          await sql`
            insert into vacation_commit_commands
              (organization_id, group_id, vacation_period_id, target_version_id,
               acting_membership_id, idempotency_key, outcome)
            values (${scheduler.organizationId}::uuid, ${scheduler.groupId}::uuid,
                    ${vacationPeriodId}::uuid, ${draftVersionId}::uuid,
                    ${scheduler.membershipId}::uuid, ${key('cycle27.out')}, ${'quota_exhausted'})
          `.execute(query),
      ),
      'an outcome outside the domain must be refused',
    ).rejects.toMatchObject({ code: '23514' });

    /* FAD-59's UNIQUE — the ONLY thing that makes commit idempotent, and the
     * race control the commit transaction relies on instead of an early INSERT. */
    const shared = key('cycle27.dup');
    await insertLedgerRow(shared);
    await expect(
      insertLedgerRow(shared),
      'FAD-59\'s (organization_id, idempotency_key) must refuse the duplicate',
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('"append-only" is a PRIVILEGE — UPDATE and DELETE are 42501, not a rule', async () => {
    const unique = key('cycle27.priv');
    await insertLedgerRow(unique);

    /* Driven, not read off `information_schema`. A grant table says what was
     * granted; a `42501` says what a runtime role can actually do — and this is
     * the difference from 0022's sibling, which DOES hold a column-level UPDATE
     * grant on its `outcome`. */
    await expect(
      asScheduler(
        async ({ query }) =>
          await sql`
            update vacation_commit_commands set outcome = ${'committed'}
             where idempotency_key = ${unique}
          `.execute(query),
      ),
      'no runtime role may UPDATE a ledger row — not even its outcome',
    ).rejects.toMatchObject({ code: '42501' });

    await expect(
      asScheduler(
        async ({ query }) =>
          await sql`delete from vacation_commit_commands where idempotency_key = ${unique}`.execute(
            query,
          ),
      ),
      'no runtime role may DELETE a ledger row',
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('the administration arm pins the ACTING membership — an author cannot be forged', async () => {
    /* The `WITH CHECK` half of `vacation_commit_commands_group_administration`,
     * 0026's mechanism one table over. Without it a holder of
     * `requests.administer` could record somebody ELSE as having committed the
     * round — which is the specific thing FAD-59's "acting membership" column
     * exists to state truthfully. */
    await expect(
      asScheduler(
        async ({ query }) =>
          await sql`
            insert into vacation_commit_commands
              (organization_id, group_id, vacation_period_id, target_version_id,
               acting_membership_id, idempotency_key, outcome)
            values (${scheduler.organizationId}::uuid, ${scheduler.groupId}::uuid,
                    ${vacationPeriodId}::uuid, ${draftVersionId}::uuid,
                    ${member.membershipId}::uuid, ${key('cycle27.forge')}, ${'committed'})
          `.execute(query),
      ),
      'a forged acting membership must be refused by the WITH CHECK',
    ).rejects.toMatchObject({ code: '42501' });

    /* FAD-15's positive control: the SAME insert with the scheduler's own
     * membership succeeds, so the refusal above can only be the pinned author. */
    const before = await ledgerRowsVisible();
    await insertLedgerRow(key('cycle27.honest'));
    expect(await ledgerRowsVisible(), 'the honest row must be admitted').toBe(before + 1);
  });

  it('a MEMBER cannot write the ledger at all — there is no own-arm', async () => {
    /* The deliberate asymmetry with `request_comments`: committing a round is
     * not a self-scoped act, so this table has no own-arm and a member's INSERT
     * matches no policy. `approvals`'s shape, one table over. */
    await expect(
      asMember(
        async ({ query }) =>
          await sql`
            insert into vacation_commit_commands
              (organization_id, group_id, vacation_period_id, target_version_id,
               acting_membership_id, idempotency_key, outcome)
            values (${member.organizationId}::uuid, ${member.groupId}::uuid,
                    ${vacationPeriodId}::uuid, ${draftVersionId}::uuid,
                    ${member.membershipId}::uuid, ${key('cycle27.member')}, ${'committed'})
          `.execute(query),
      ),
      'a member holds neither requests.administer nor an own-arm here',
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('FAD-59\'s per-selection CHECK refuses BOTH directions', async () => {
    /* `(status = 'committed') = (committed_to_version_id IS NOT NULL)`, an
     * equality — so a committed selection with no version and an uncommitted one
     * WITH a version are both violations, and a CHECK that only forbade the first
     * would still admit a `reversed` row pointing at a version it is no longer
     * in.
     *
     * Driven as the MEMBER on their own `available` selection, because 0023's
     * own-arm is the only policy a member's write matches. */
    await expect(
      asMember(
        async ({ query }) =>
          await sql`
            update vacation_selections
               set committed_to_version_id = ${draftVersionId}::uuid
             where id = ${selectionId}::uuid
          `.execute(query),
      ),
      'a non-committed selection must not carry a committed version',
    ).rejects.toMatchObject({ code: '23514' });

    /* The other direction is unreachable through an UPDATE of the status alone,
     * because §5.3 has no `available → committed` edge and 0021's trigger refuses
     * it first — stated rather than contrived. What IS reachable and IS driven:
     * clearing the version off a row that claims to be committed. The insert
     * below is the closest legal shape, and it is refused by the CHECK before any
     * transition guard is consulted. */
    await expect(
      asMember(
        async ({ query }) =>
          await sql`
            insert into vacation_selections
              (organization_id, group_id, membership_id, vacation_period_id, week_start,
               status, request_id, committed_to_version_id)
            values (${member.organizationId}::uuid, ${member.groupId}::uuid,
                    ${member.membershipId}::uuid, ${vacationPeriodId}::uuid,
                    ${'2071-06-08'}::date, ${'committed'}, ${null}, ${null})
          `.execute(query),
      ),
      'a committed selection must carry the version it was committed to',
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('the assignment ORIGIN domain admits `vacation_commit` and still refuses an invented one', async () => {
    /* Both directions, per the standing rule for a WIDENED domain: the new value
     * is admitted, and the domain is still a domain. A test that only proved the
     * first would pass against a CHECK somebody had dropped entirely. */
    const identityId = randomUUID();
    const schedulePeriodId = await asScheduler(async ({ query }) => {
      const row = await sql<{ period_id: string }>`
        select period_id from schedule_versions where id = ${draftVersionId}::uuid
      `.execute(query);
      return row.rows[0]?.period_id ?? '';
    });

    await expect(
      asScheduler(
        async ({ query }) =>
          await sql`
            insert into assignment_identities (id, organization_id, group_id, period_id, origin)
            values (${identityId}::uuid, ${scheduler.organizationId}::uuid,
                    ${scheduler.groupId}::uuid, ${schedulePeriodId}::uuid, ${'vacation_commit'})
          `.execute(query),
      ),
      '`vacation_commit` must be admitted by the widened domain',
    ).resolves.not.toThrow();

    await expect(
      asScheduler(
        async ({ query }) =>
          await sql`
            insert into assignment_identities (id, organization_id, group_id, period_id, origin)
            values (${randomUUID()}::uuid, ${scheduler.organizationId}::uuid,
                    ${scheduler.groupId}::uuid, ${schedulePeriodId}::uuid, ${'vacation_reversal'})
          `.execute(query),
      ),
      'an invented sixth origin must still be refused — the domain is still a domain',
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('migration 0027 §6 — the solver-projection read plane', () => {
  /* Four properties, and each is a falsifier rather than a description. A read
   * plane whose confinement is only asserted in a comment is a read plane
   * nothing would notice being left open. */

  /** How many of the GROUP's vacation selections this context can see. */
  async function selectionsVisible(
    fn: (uow: PgUnitOfWork) => Promise<void>,
    context: typeof scheduler,
  ): Promise<number> {
    const rows = await runtime.runner.run(context, async (uow) => {
      await fn(uow);
      return await sql<{ n: string }>`select count(*)::text as n from vacation_selections`.execute(
        uow.query,
      );
    });
    return Number(rows.rows[0]?.n ?? '0');
  }

  const openPlane = async (uow: PgUnitOfWork): Promise<void> => {
    await sql`select set_config('app.solver_projection_read', 'solver_projection', true)`.execute(
      uow.query,
    );
  };
  const noPlane = async (): Promise<void> => {
    /* Deliberately nothing: the control's whole content is that the token is
     * absent. */
  };

  it('is CLOSED without the token, and OPEN with it — the same read, twice', async () => {
    /* The member owns one selection and the scheduler's own membership owns
     * none, so a scheduler reading WITHOUT the plane sees zero and WITH it sees
     * the group's. Both directions, so neither number can be an accident of the
     * fixture: a plane that did nothing would give the same answer twice.
     *
     * The scheduler holds `requests.read_any` by role, so this pair is measured
     * as the MEMBER — a principal for whom only the plane can widen the answer.
     * A member sees their OWN selection either way, and the group's colleague
     * rows only with the token. */
    const otherSelection = await asScheduler(async ({ query }) => {
      const inserted = await sql<{ id: string }>`
        insert into vacation_selections
          (organization_id, group_id, membership_id, vacation_period_id, week_start, status)
        values (${scheduler.organizationId}::uuid, ${scheduler.groupId}::uuid,
                ${scheduler.membershipId}::uuid, ${vacationPeriodId}::uuid,
                ${'2071-06-15'}::date, ${'available'})
        returning id
      `.execute(query);
      return inserted.rows[0]?.id ?? '';
    });
    expect(otherSelection).not.toBe('');

    const closed = await selectionsVisible(noPlane, member);
    const open = await selectionsVisible(openPlane, member);

    expect(closed, 'a member sees only their own selections without the token').toBeGreaterThan(0);
    expect(open, 'the plane must widen the answer, or it is doing nothing').toBeGreaterThan(closed);
  });

  it('is CLEARED after the reads — the `finally` is load-bearing', async () => {
    /* The property that makes "for exactly the span of the projection" true. A
     * plane opened and never cleared would stay open for the rest of the
     * transaction, and every later statement in it would run widened. Measured
     * inside ONE unit of work: open, clear, read. */
    const after = await runtime.runner.run(member, async (uow) => {
      await openPlane(uow);
      await sql`select set_config('app.solver_projection_read', '', true)`.execute(uow.query);
      return await sql<{ n: string }>`select count(*)::text as n from vacation_selections`.execute(
        uow.query,
      );
    });
    const closed = await selectionsVisible(noPlane, member);
    expect(Number(after.rows[0]?.n ?? '0')).toBe(closed);
  });

  it('the two purpose tokens are MUTUALLY isolated — both directions', async () => {
    /* One token, one plane. 0012's `qualification_requirements` must not open
     * this one and `solver_projection` must not open 0012's, or the narrower
     * purpose would carry the wider plane. Both are measured. */
    const wrongTokenHere = await runtime.runner.run(member, async (uow) => {
      await sql`select set_config('app.enforcement_read', 'qualification_requirements', true)`.execute(
        uow.query,
      );
      return await sql<{ n: string }>`select count(*)::text as n from vacation_selections`.execute(
        uow.query,
      );
    });
    const closed = await selectionsVisible(noPlane, member);
    expect(
      Number(wrongTokenHere.rows[0]?.n ?? '0'),
      "0012's token must not open the projection plane",
    ).toBe(closed);

    const holdingsClosed = await runtime.runner.run(
      member,
      async (uow) =>
        await sql<{ n: string }>`select count(*)::text as n from qualification_holdings`.execute(
          uow.query,
        ),
    );
    const holdingsUnderProjectionToken = await runtime.runner.run(member, async (uow) => {
      await openPlane(uow);
      return await sql<{ n: string }>`select count(*)::text as n from qualification_holdings`.execute(
        uow.query,
      );
    });
    expect(
      Number(holdingsUnderProjectionToken.rows[0]?.n ?? '0'),
      "the projection's token must not open 0012's plane",
    ).toBe(Number(holdingsClosed.rows[0]?.n ?? '0'));
  });

  it('every projection arm carries the SAME tenant predicate its siblings do', async () => {
    /* The structural half of the confinement claim: each new arm is ONE MORE
     * OR-arm with the tenant predicate unchanged, not a policy that moved a
     * boundary. Asserted over `pg_policies` rather than by reading the migration,
     * so an arm added later with a loosened predicate fails here.
     *
     * Seven arms, one per table, and each must (a) be `SELECT` only, (b) carry
     * both `app.organization_id` and `app.group_id`, and (c) carry the token. */
    const rows = await asScheduler(
      async ({ query }) =>
        await sql<{ tablename: string; cmd: string; qual: string }>`
          select tablename, cmd, qual
            from pg_policies
           where policyname like '%_solver_projection_read'
           order by tablename
        `.execute(query),
    );

    expect(rows.rows).toHaveLength(7);
    for (const row of rows.rows) {
      expect(row.cmd, `${row.tablename}: the plane is SELECT-only`).toBe('SELECT');
      expect(row.qual, `${row.tablename}: the organization predicate is unchanged`).toContain(
        "current_setting('app.organization_id'::text, true)",
      );
      expect(row.qual, `${row.tablename}: the group predicate is unchanged`).toContain(
        "current_setting('app.group_id'::text, true)",
      );
      expect(row.qual, `${row.tablename}: the arm is gated on the purpose token`).toContain(
        'solver_projection',
      );
    }
  });
});
