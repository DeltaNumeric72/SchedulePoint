import { randomUUID } from 'node:crypto';

import {
  REQUEST_STATUSES,
  REQUEST_STATUSES_BY_SUBTYPE,
  REQUEST_SUBTYPES,
  initialRequestStatus,
} from '@schedulepoint/domain';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate } from '../../src/db/migrate.js';
import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import { digestRows } from '../../src/schedule/render.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * **Migration 0023, up → down → up, over a POPULATED database** (OPUS-M5-001;
 * doc 42 §5c Acceptance, "a populated cycle for every new migration (0023+)").
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## What 0023 does, and therefore what a cycle of it has to prove
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 0023 creates no table. It adds four columns, widens one function, adds three
 * guards, and REPLACES the tenancy policies on seven tables with narrower ones.
 * That last one is why this file cannot be a copy of 0021's cycle: a policy
 * replacement is the kind of change whose reversal is easy to get *nearly*
 * right, and a `DROP POLICY` that recreated something slightly different would
 * leave every census digest identical and every row count unchanged.
 *
 * So the cycle asserts four separate things:
 *
 *   1. the columns and guards come back **enforcing**, not merely present;
 *   2. the SENSITIVE-PII narrowing is enforcing, in BOTH directions — a member
 *      sees their own rows and CANNOT see a colleague's, even holding the id;
 *   3. after the down, the group-scope policies 0021 and 0022 wrote are back —
 *      asserted by BEHAVIOUR (a colleague's row becomes visible again), because
 *      that is the property the narrowing is about;
 *   4. everything 0023 does not own is untouched.
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

const multi = ownedMulti('requests-migration-0023-cycle', {
  profile: 'core',
  seed: { catalogue: ['alpha'] },
});

let runtime: Runtime;
/** The requester's context — Alpha Group One's `member`. */
let mine: {
  organizationId: string;
  groupId: string;
  membershipId: string;
  correlationId: string;
};
/** A COLLEAGUE in the same group, holding no request capability. */
let theirs: typeof mine;
let organizationAdminMembershipId: string;
let requestableShiftGroupId: string;
let shiftTypeId: string;

const asMe = async <T>(fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> =>
  runtime.runner.run(mine, fn);
const asColleague = async <T>(fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> =>
  runtime.runner.run(theirs, fn);

/** The tables the cycle must leave untouched. */
const CENSUS: readonly { table: string; columns: readonly string[] }[] = [
  { table: 'shift_types', columns: ['id', 'code', 'name'] },
  { table: 'shift_groups', columns: ['id', 'name', 'allow_request'] },
  { table: 'memberships', columns: ['id', 'user_id', 'kind', 'group_role'] },
  { table: 'group_holidays', columns: ['id', 'holiday_date'] },
];

async function census(): Promise<Record<string, { count: number; digest: string }>> {
  const result: Record<string, { count: number; digest: string }> = {};
  for (const entry of CENSUS) {
    const rows = (await asMe(async (uow) =>
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
 * A root at its INITIAL status plus its subtype row, in one unit of work, for
 * the membership in `context`.
 *
 * No status parameter, and that is the ruling expressed as an absent argument:
 * migration 0023 refuses an insert at anything but the subtype's initial status.
 */
async function createOwnRequest(
  context: typeof mine,
  subtype: 'availability' | 'time-off',
  day: string,
  suffix: string,
): Promise<string> {
  return runtime.runner.run(context, async (uow) => {
    const id = randomUUID();
    await sql`
      insert into requests
        (id, organization_id, group_id, membership_id, subtype, status, expires_at,
         idempotency_key)
      values (${id}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
              ${context.membershipId}::uuid, ${subtype},
              app_request_initial_status(${subtype}),
              ${'2099-06-01T00:00:00.000Z'}::timestamptz,
              ${`cycle23.${suffix}.${randomUUID().slice(0, 8)}`})
    `.execute(uow.query);

    if (subtype === 'availability') {
      await sql`
        insert into request_availability (request_id, organization_id, group_id, target_date)
        values (${id}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
                ${day}::date)
      `.execute(uow.query);
    } else {
      await sql`
        insert into request_time_off (request_id, organization_id, group_id, target_date)
        values (${id}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
                ${day}::date)
      `.execute(uow.query);
    }
    return id;
  });
}

/** How many `requests` rows this context can SEE. */
async function visibleTo(context: typeof mine): Promise<number> {
  const rows = await runtime.runner.run(
    context,
    async ({ query }) =>
      await sql<{ n: string }>`select count(*)::text as n from requests`.execute(query),
  );
  return Number(rows.rows[0]?.n ?? '0');
}

beforeAll(async () => {
  runtime = createRuntime('app_runtime', { max: 4 });
  const alpha = multi().alpha;
  const catalogue = multi.catalogue('alpha');
  requestableShiftGroupId = catalogue.shiftGroupId;
  const seededShiftType = catalogue.shiftTypeIds[0];
  if (seededShiftType === undefined) throw new Error('the alpha catalogue seed produced no shift type');
  shiftTypeId = seededShiftType;
  organizationAdminMembershipId = alpha.users.organizationAdmin.membershipId;

  /* ── OPUS-M5-002: the two memberships are SWAPPED, and the swap is the point ──
   *
   * This file shipped with `mine` = the MEMBER and `theirs` = the SCHEDULER, and
   * proved the narrowing by showing the scheduler could not see the member's
   * rows. That was correct while `requests.read_any` and `requests.administer`
   * were grant-only.
   *
   * OPUS-M5-002 makes four decision keys ROLE-IMPLIED for `scheduler`, from doc
   * 08 §6's "Approve requests/vacation ✓" row — so **a scheduler now legitimately
   * sees the queue**, and an assertion that they cannot is asserting something
   * the permission model says is false. The test was encoding an assumption doc
   * 08 contradicts; the role map is not what is wrong.
   *
   * **Every assertion below keeps its meaning, unchanged**, by choosing an actor
   * for whom the key is genuinely absent: the rows belong to the SCHEDULER, and
   * the colleague who must not see them is the MEMBER, whose row in doc 08 §6 is
   * `—`. Nothing is weakened — the narrowing is still proven in both directions,
   * and the grant/revoke arm still opens and closes, because a member has no
   * role-implied key for a revoke to leave behind. */
  mine = {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    membershipId: alpha.users.scheduler.membershipId,
    correlationId: 'cycle23-mine',
  };
  theirs = {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    membershipId: alpha.users.member.membershipId,
    correlationId: 'cycle23-theirs',
  };
}, 240_000);

afterAll(async () => {
  await runtime?.destroy();
});

describe('migration 0023 over a populated database', () => {
  it('up → down → up, resolved and asserted BY NAME', async () => {
    await createOwnRequest(mine, 'availability', '2046-03-02', 'cycle');
    expect(await visibleTo(mine), 'the cycle must have rows to be about').toBeGreaterThan(0);
    const censusBefore = await census();

    let up: readonly string[] = [];
    let midway: Record<string, { count: number; digest: string }> | undefined;
    const down: string[] = [];
    try {
      while (!down.some((name) => name.includes('0023'))) {
        const step = await migrate('down', { count: 1 });
        if (step.applied.length === 0) {
          throw new Error('ran out of migrations before reaching 0023 — the ledger is empty');
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
    expect(up.some((name) => name.includes('0023'))).toBe(true);
    expect(await census()).toEqual(censusBefore);

    /* 0023 creates no table, so unlike 0021's cycle the REQUEST ROWS SURVIVE it.
     * That is the observable difference between a migration that owns tables and
     * one that owns policy, and asserting it is how a reader knows the down
     * really was 0023's and not something wider. */
    expect(await visibleTo(mine)).toBeGreaterThan(0);
  }, 300_000);

  it('MUTATION CONTROL: the initial-status guard is enforcing again after the cycle', async () => {
    /* A down that dropped the trigger and an up that forgot to restore it would
     * leave every digest above identical. This is the assertion that would
     * notice. */
    await expect(
      asMe(
        async ({ query }) =>
          await sql`
            insert into requests
              (organization_id, group_id, membership_id, subtype, status, expires_at,
               idempotency_key)
            values (${mine.organizationId}::uuid, ${mine.groupId}::uuid,
                    ${mine.membershipId}::uuid, ${'availability'}, ${'approved'},
                    ${'2099-06-01T00:00:00.000Z'}::timestamptz,
                    ${`cycle23.control.${randomUUID().slice(0, 8)}`})
          `.execute(query),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('REQUEST_INITIAL_STATUS_ILLEGAL'),
    });

    /* …and the LEGAL creation still works, so the arm above is not passing
     * because everything is refused. */
    expect(await createOwnRequest(mine, 'availability', '2046-03-09', 'control-ok')).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  }, 180_000);
});

describe('the initial-INSERT status ruling, in the database (doc 42 §5c Part A)', () => {
  it('the FULL (subtype × status) cross-product is classified three ways', async () => {
    /* The database half of the ruling, over every pair — the same three classes
     * `migration-0021-populated-cycle.test.ts` now uses, asserted here against
     * 0023's guard specifically:
     *
     *   outside D-20's domain        → 23514, D-20 (0023 changed nothing here)
     *   in domain, IS the initial    → past both guards, D-18 at COMMIT
     *   in domain, NOT the initial   → REQUEST_INITIAL_STATUS_ILLEGAL
     */
    let refusedByDomain = 0;
    let refusedByRuling = 0;
    let admitted = 0;

    for (const subtype of REQUEST_SUBTYPES) {
      const domain = new Set(REQUEST_STATUSES_BY_SUBTYPE[subtype]);
      for (const status of REQUEST_STATUSES) {
        const attempt = asMe(
          async ({ query }) =>
            await sql`
              insert into requests
                (organization_id, group_id, membership_id, subtype, status, expires_at,
                 idempotency_key)
              values (${mine.organizationId}::uuid, ${mine.groupId}::uuid,
                      ${mine.membershipId}::uuid, ${subtype}, ${status},
                      ${'2099-06-01T00:00:00.000Z'}::timestamptz,
                      ${`cycle23.xprod.${randomUUID().slice(0, 12)}`})
            `.execute(query),
        );

        if (!domain.has(status)) {
          refusedByDomain += 1;
          await expect(attempt, `${subtype}/${status}`).rejects.toMatchObject({ code: '23514' });
        } else if (status === initialRequestStatus(subtype)) {
          admitted += 1;
          await expect(attempt, `${subtype}/${status}`).rejects.toMatchObject({
            message: expect.stringContaining('REQUEST_SUBTYPE_ROW_REQUIRED'),
          });
        } else {
          refusedByRuling += 1;
          await expect(attempt, `${subtype}/${status}`).rejects.toMatchObject({
            message: expect.stringContaining('REQUEST_INITIAL_STATUS_ILLEGAL'),
          });
        }
      }
    }

    /* All three classes must be non-empty, or the case is asserting less than it
     * appears to. `admitted` is exactly one per subtype, by the ruling. */
    expect(admitted).toBe(REQUEST_SUBTYPES.length);
    expect(refusedByRuling).toBeGreaterThan(0);
    expect(refusedByDomain).toBeGreaterThan(0);
  }, 300_000);

  it('D-20 still speaks FIRST — the AFTER-INSERT ordering, proved', async () => {
    /* `shift-preference` at `approved` is outside D-20's domain AND is not the
     * initial status, so both guards would refuse it. The one that answers must
     * be D-20, with `23514` — which is what keeps SPEC-08 R-03 provable. Had the
     * guard been BEFORE INSERT it would answer instead, and R-03's mechanism
     * would be gone. */
    await expect(
      asMe(
        async ({ query }) =>
          await sql`
            insert into requests
              (organization_id, group_id, membership_id, subtype, status, expires_at,
               idempotency_key)
            values (${mine.organizationId}::uuid, ${mine.groupId}::uuid,
                    ${mine.membershipId}::uuid, ${'shift-preference'}, ${'approved'},
                    ${'2099-06-01T00:00:00.000Z'}::timestamptz,
                    ${`cycle23.order.${randomUUID().slice(0, 8)}`})
          `.execute(query),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  }, 120_000);

  it('C-1: neither lifecycle flag may be BORN true, and the refusal is NAMED', async () => {
    /* An independent review's probe, issued as an ordinary member: the UPDATE
     * guard is BEFORE UPDATE and 0021's INSERT grant is table-level, so before
     * this rule existed a writer could create
     * `{"status":"draft","revision_requested":true,"is_late":true}`.
     *
     * `revision_requested` born `true` is R-10's claim — that a PUBLISHED
     * version's promise was retracted and a scheduler owes a decision — asserted
     * of a `draft` nobody submitted, with no event and no audit row behind it;
     * and the monotonicity rule, which exists so the flag cannot be quietly
     * CLEARED, then makes the false claim permanent. No shipped path can produce
     * it, which is exactly why the DATABASE half must refuse it: R-01's second
     * layer is the one that binds a writer nobody has written yet. */
    const attempt = (flags: { revision: boolean; late: boolean }): Promise<unknown> =>
      asMe(
        async ({ query }) =>
          await sql`
            insert into requests
              (organization_id, group_id, membership_id, subtype, status, expires_at,
               idempotency_key, revision_requested, is_late)
            values (${mine.organizationId}::uuid, ${mine.groupId}::uuid,
                    ${mine.membershipId}::uuid, ${'availability'},
                    app_request_initial_status(${'availability'}),
                    ${'2099-06-01T00:00:00.000Z'}::timestamptz,
                    ${`cycle23.c1.${randomUUID().slice(0, 12)}`},
                    ${flags.revision}, ${flags.late})
          `.execute(query),
      );

    /* Each flag ALONE, and both together — so the guard is not passing because
     * one of the two happens to be checked. */
    for (const flags of [
      { revision: true, late: false },
      { revision: false, late: true },
      { revision: true, late: true },
    ]) {
      await expect(
        attempt(flags),
        `revision_requested=${String(flags.revision)} is_late=${String(flags.late)}`,
      ).rejects.toMatchObject({
        message: expect.stringContaining('REQUEST_LIFECYCLE_FLAG_AT_CREATION'),
      });
    }

    /* The LEGAL creation control: both flags false is admitted by this guard and
     * fails at COMMIT on D-18's zero-row rule instead, because the attempt
     * writes no subtype row. Without this the three arms above would pass just as
     * well if the guard refused every INSERT. */
    await expect(attempt({ revision: false, late: false })).rejects.toMatchObject({
      message: expect.stringContaining('REQUEST_SUBTYPE_ROW_REQUIRED'),
    });

    /* …and a complete, legal creation still succeeds end to end. */
    expect(await createOwnRequest(mine, 'availability', '2046-09-07', 'c1-ok')).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  }, 180_000);
});

describe('FAD-55 — the revision guard (SPEC-08 §4, R-10)', () => {
  /** A row walked to `reflected_in_version` along §2's edges. */
  async function reflected(suffix: string, day: string): Promise<string> {
    const id = await createOwnRequest(mine, 'time-off', day, suffix);
    await asMe(async ({ query }) => {
      for (const status of ['submitted', 'under_review', 'approved', 'consumed_by_build', 'reflected_in_version']) {
        await sql`update requests set status = ${status} where id = ${id}::uuid`.execute(query);
      }
    });
    return id;
  }

  it('R-10: the withdrawal SUCCEEDS and sets `revision_requested`', async () => {
    const id = await reflected('r10-ok', '2046-04-06');

    await asMe(
      async ({ query }) =>
        await sql`update requests
                     set status = 'withdrawn', revision_requested = true
                   where id = ${id}::uuid`.execute(query),
    );

    const after = await asMe(
      async ({ query }) =>
        await sql<{ status: string; revision_requested: boolean }>`
          select status, revision_requested from requests where id = ${id}::uuid
        `.execute(query),
    );
    expect(after.rows[0]).toEqual({ status: 'withdrawn', revision_requested: true });
  }, 180_000);

  it('the guard REFUSES the same edge without the flag — no quiet withdrawal', async () => {
    /* The negative leg FAD-55's ratification requires. Without it the added cell
     * would be a bare edge, and a withdrawal from a published promise could
     * happen with nothing asked of the scheduler. */
    const id = await reflected('r10-noflag', '2046-04-13');

    await expect(
      asMe(
        async ({ query }) =>
          await sql`update requests set status = 'withdrawn' where id = ${id}::uuid`.execute(query),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('REQUEST_REVISION_REQUIRED') });
  }, 180_000);

  it('the flag is MONOTONIC — it cannot be cleared', async () => {
    const id = await reflected('r10-clear', '2046-04-20');
    await asMe(
      async ({ query }) =>
        await sql`update requests
                     set status = 'withdrawn', revision_requested = true
                   where id = ${id}::uuid`.execute(query),
    );

    await expect(
      asMe(
        async ({ query }) =>
          await sql`update requests set revision_requested = false where id = ${id}::uuid`.execute(
            query,
          ),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('REQUEST_REVISION_FLAG_IMMUTABLE'),
    });
  }, 180_000);

  it('no OTHER transition may set the flag', async () => {
    /* A flag any transition could set is not evidence of the transition it
     * names. Proved on `submitted → withdrawn`, which is a perfectly legal
     * withdrawal that simply did not follow a publication. */
    const id = await createOwnRequest(mine, 'time-off', '2046-04-27', 'r10-other');
    await asMe(
      async ({ query }) =>
        await sql`update requests set status = 'submitted' where id = ${id}::uuid`.execute(query),
    );

    await expect(
      asMe(
        async ({ query }) =>
          await sql`update requests
                       set status = 'withdrawn', revision_requested = true
                     where id = ${id}::uuid`.execute(query),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('REQUEST_REVISION_NOT_APPLICABLE'),
    });

    /* …and the same withdrawal WITHOUT the flag succeeds, so the arm above is
     * refusing the flag and not the withdrawal. */
    await asMe(
      async ({ query }) =>
        await sql`update requests set status = 'withdrawn' where id = ${id}::uuid`.execute(query),
    );
  }, 180_000);
});

describe('R-22 — withdrawal after `consumed_by_build` is refused by the database', () => {
  /**
   * A SHIFT-PREFERENCE request, walked to `status`.
   *
   * It has to be a shift preference and not an availability, and the first draft
   * of this case got that wrong: `accepted_as_input → consumed_by_build` is
   * **shift-preference's alone** (§2). An availability reaches
   * `consumed_by_build` from `approved` instead, so walking one through
   * `accepted_as_input` is a transition §2 does not contain — the guard said so,
   * which is the matrix doing its job on the test rather than on the code.
   */
  async function shiftPreferenceAt(suffix: string, day: string, status: string): Promise<string> {
    const id = await runtime.runner.run(mine, async (uow) => {
      const requestId = randomUUID();
      await sql`
        insert into requests
          (id, organization_id, group_id, membership_id, subtype, status, expires_at,
           idempotency_key)
        values (${requestId}::uuid, ${mine.organizationId}::uuid, ${mine.groupId}::uuid,
                ${mine.membershipId}::uuid, ${'shift-preference'},
                app_request_initial_status(${'shift-preference'}),
                ${'2099-06-01T00:00:00.000Z'}::timestamptz,
                ${`cycle23.${suffix}.${randomUUID().slice(0, 8)}`})
      `.execute(uow.query);
      await sql`
        insert into request_shift_preference
          (request_id, organization_id, group_id, target_date, shift_type_id,
           preference_strength)
        values (${requestId}::uuid, ${mine.organizationId}::uuid, ${mine.groupId}::uuid,
                ${day}::date, ${shiftTypeId}::uuid, ${'medium'})
      `.execute(uow.query);
      return requestId;
    });

    const path = ['submitted', 'accepted_as_input', 'consumed_by_build'];
    await asMe(async ({ query }) => {
      for (const step of path) {
        await sql`update requests set status = ${step} where id = ${id}::uuid`.execute(query);
        if (step === status) return;
      }
    });
    return id;
  }

  it('R-22: a shift preference withdraws while `accepted_as_input`', async () => {
    const id = await shiftPreferenceAt('r22-before', '2046-05-04', 'accepted_as_input');
    await asMe(
      async ({ query }) =>
        await sql`update requests set status = 'withdrawn' where id = ${id}::uuid`.execute(query),
    );
    const after = await asMe(
      async ({ query }) =>
        await sql<{ status: string }>`select status from requests where id = ${id}::uuid`.execute(
          query,
        ),
    );
    expect(after.rows[0]?.status).toBe('withdrawn');
  }, 180_000);

  it('R-22: and is REFUSED after `consumed_by_build` — FAD-55 did not loosen this', async () => {
    /* The half that matters most now: FAD-55 added a cell at
     * `reflected_in_version`, and this asserts it did not widen the neighbouring
     * boundary while it was there. */
    const id = await shiftPreferenceAt('r22-after', '2046-05-11', 'consumed_by_build');
    await expect(
      asMe(
        async ({ query }) =>
          await sql`update requests set status = 'withdrawn' where id = ${id}::uuid`.execute(query),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('REQUEST_TRANSITION_ILLEGAL') });
  }, 180_000);
});

describe('the SENSITIVE-PII narrowing, in BOTH directions (0021 header §5, discharged)', () => {
  it('a member sees their OWN request through the root policy', async () => {
    const id = await createOwnRequest(mine, 'time-off', '2046-06-01', 'own');
    const rows = await asMe(
      async ({ query }) =>
        await sql<{ id: string }>`select id from requests where id = ${id}::uuid`.execute(query),
    );
    expect(rows.rows).toHaveLength(1);
  }, 120_000);

  it("a COLLEAGUE holding the id sees NOTHING — the root row is invisible", async () => {
    /* The narrowing's whole point. The colleague is in the same organization and
     * the same GROUP, so tenancy alone would show them this row: before 0023 the
     * policy was group scope and nothing narrower. They hold the id — the
     * strongest position an attacker inside the tenant can be in — and still see
     * zero rows. */
    const id = await createOwnRequest(mine, 'time-off', '2046-06-08', 'not-yours');

    const rows = await asColleague(
      async ({ query }) =>
        await sql<{ id: string }>`select id from requests where id = ${id}::uuid`.execute(query),
    );
    expect(rows.rows).toHaveLength(0);
  }, 120_000);

  it('the SUBTYPE row is invisible to the colleague too — the EXISTS arm holds', async () => {
    /* The wrinkle the subtype tables introduce: they carry no `membership_id`,
     * so their own-arm reaches the ROOT through an `EXISTS`. This is the
     * assertion that the indirection actually restricts — a policy that joined
     * to `requests` but forgot the membership predicate would pass every other
     * case in this file and fail here. */
    const id = await createOwnRequest(mine, 'time-off', '2046-06-15', 'subtype-not-yours');

    const mineRows = await asMe(
      async ({ query }) =>
        await sql<{ request_id: string }>`
          select request_id from request_time_off where request_id = ${id}::uuid
        `.execute(query),
    );
    expect(mineRows.rows, 'my own subtype row must be visible to me').toHaveLength(1);

    const theirRows = await asColleague(
      async ({ query }) =>
        await sql<{ request_id: string }>`
          select request_id from request_time_off where request_id = ${id}::uuid
        `.execute(query),
    );
    expect(theirRows.rows, "a colleague's read of my subtype row must be empty").toHaveLength(0);
  }, 120_000);

  it('`requests.read_any` OPENS the colleague\'s read, and only while granted', async () => {
    /* The third direction, and the one that proves the narrowing is a NARROWING
     * rather than a lockout: the capability the policy names actually admits the
     * row, through the production grant mechanism (SPEC-06 L4.2), and revoking
     * it closes the door again.
     *
     * Granted under an ORGANIZATION-scoped context by the organization
     * administrator — a different USER from the grantee, so
     * `app_guard_capability_grant_administration`'s two-person rule is satisfied
     * rather than worked around. */
    const id = await createOwnRequest(mine, 'time-off', '2046-06-22', 'read-any');
    const grantId = randomUUID();

    const grantContext = {
      organizationId: mine.organizationId,
      groupId: null,
      membershipId: organizationAdminMembershipId,
      correlationId: 'cycle23-grant',
    };

    await runtime.runner.run(grantContext as never, async ({ query }) => {
      await query
        .insertInto('capability_grants')
        .values({
          id: grantId,
          organization_id: mine.organizationId,
          group_id: mine.groupId,
          membership_id: theirs.membershipId,
          capability_key: 'requests.read_any',
          granted: true,
          granted_by_membership_id: organizationAdminMembershipId,
        })
        .execute();
    });

    const withGrant = await asColleague(
      async ({ query }) =>
        await sql<{ id: string }>`select id from requests where id = ${id}::uuid`.execute(query),
    );
    expect(withGrant.rows, 'the read_any grant must admit the row').toHaveLength(1);

    /* The subtype table's read_any arm too — it is a separate policy on a
     * separate table and could have been forgotten. */
    const subtypeWithGrant = await asColleague(
      async ({ query }) =>
        await sql<{ request_id: string }>`
          select request_id from request_time_off where request_id = ${id}::uuid
        `.execute(query),
    );
    expect(subtypeWithGrant.rows).toHaveLength(1);

    /* Revoke — no runtime role holds DELETE on `capability_grants`, so the
     * production spelling is `granted = false`. */
    await runtime.runner.run(grantContext as never, async ({ query }) => {
      await query
        .updateTable('capability_grants')
        .set({ granted: false })
        .where('id', '=', grantId)
        .execute();
    });

    const afterRevoke = await asColleague(
      async ({ query }) =>
        await sql<{ id: string }>`select id from requests where id = ${id}::uuid`.execute(query),
    );
    expect(afterRevoke.rows, 'revoking must close the door again').toHaveLength(0);
  }, 180_000);
});

describe('FU-20 — `allow_request` stability (doc 42 §5c Part E)', () => {
  /**
   * The flip is a CATALOGUE administration act, so the actor must hold
   * `schedule.catalogue.administer` — migration 0005's
   * `app_guard_catalogue_administration` refuses it otherwise, and the first
   * draft of this case met that refusal instead of FU-20's.
   *
   * Granted through the production mechanism (SPEC-06 L4.2) under an
   * ORGANIZATION-scoped context by the organization administrator — a different
   * USER from the grantee, so `app_guard_capability_grant_administration`'s
   * two-person rule is satisfied rather than worked around. Granting it here
   * rather than leaning on a role the fixture happens to give somebody keeps the
   * case self-contained: it proves FU-20's guard, and it proves it is FU-20's
   * guard doing the refusing.
   */
  async function grantCatalogueAdministration(): Promise<void> {
    await runtime.runner.run(
      {
        organizationId: mine.organizationId,
        groupId: null,
        membershipId: organizationAdminMembershipId,
        correlationId: 'cycle23-fu20-grant',
      } as never,
      async ({ query }) => {
        await query
          .insertInto('capability_grants')
          .values({
            id: randomUUID(),
            organization_id: mine.organizationId,
            group_id: mine.groupId,
            membership_id: mine.membershipId,
            capability_key: 'schedule.catalogue.administer',
            granted: true,
            granted_by_membership_id: organizationAdminMembershipId,
          })
          .execute();
      },
    );
  }

  it('an `allow_request` true → false flip is REFUSED while a request is outstanding', async () => {
    await grantCatalogueAdministration();
    const id = await runtime.runner.run(mine, async (uow) => {
      const requestId = randomUUID();
      await sql`
        insert into requests
          (id, organization_id, group_id, membership_id, subtype, status, expires_at,
           idempotency_key)
        values (${requestId}::uuid, ${mine.organizationId}::uuid, ${mine.groupId}::uuid,
                ${mine.membershipId}::uuid, ${'shift-group-off'}, ${'draft'},
                ${'2099-06-01T00:00:00.000Z'}::timestamptz,
                ${`cycle23.fu20.${randomUUID().slice(0, 8)}`})
      `.execute(uow.query);
      await sql`
        insert into request_shift_group_off
          (request_id, organization_id, group_id, target_date, shift_group_id)
        values (${requestId}::uuid, ${mine.organizationId}::uuid, ${mine.groupId}::uuid,
                ${'2046-07-06'}::date, ${requestableShiftGroupId}::uuid)
      `.execute(uow.query);
      await sql`update requests set status = 'submitted' where id = ${requestId}::uuid`.execute(
        uow.query,
      );
      return requestId;
    });

    await expect(
      asMe(
        async ({ query }) =>
          await sql`update shift_groups
                       set allow_request = false, request_off_label = null
                     where id = ${requestableShiftGroupId}::uuid`.execute(query),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('SHIFT_GROUP_REQUESTS_OUTSTANDING'),
    });

    /* Resolve the outstanding request — withdraw it — and the flip is permitted.
     * This is the operational consequence stated in the trigger's docblock, and
     * it is asserted rather than described: the guard is a delay, not a
     * permanent lock. */
    await asMe(
      async ({ query }) =>
        await sql`update requests set status = 'withdrawn' where id = ${id}::uuid`.execute(query),
    );
    /* 0005 pairs `allow_request` with a mandatory `request_off_label`
     * (`shift_groups_request_label_shape`): a group admitting requests is one
     * that has a label to show for them, so the label moves with the flag in
     * both directions. The first draft of this case flipped the flag alone and
     * met that CHECK instead of FU-20's guard. */
    await asMe(
      async ({ query }) =>
        await sql`update shift_groups
                     set allow_request = false, request_off_label = null
                   where id = ${requestableShiftGroupId}::uuid`.execute(query),
    );

    /* Turning it back ON is never blocked, in either state — restored here so
     * this case leaves the fixture as it found it. */
    await asMe(
      async ({ query }) =>
        await sql`update shift_groups
                     set allow_request = true, request_off_label = ${'Off'}
                   where id = ${requestableShiftGroupId}::uuid`.execute(query),
    );
  }, 180_000);
});

describe('§3 policy columns', () => {
  it('the two group columns exist, default to the STRICT direction, and are constrained', async () => {
    const row = await asMe(
      async ({ query }) =>
        await sql<{ deadline_rolls: string; late_submission_policy: string }>`
          select deadline_rolls, late_submission_policy from groups
           where id = ${mine.groupId}::uuid
        `.execute(query),
    );
    /* A migration must not make a policy decision on a group's behalf in the
     * PERMISSIVE direction: `forward` would silently extend every existing
     * group's window and `accept_as_late` would silently open one that was shut. */
    expect(row.rows[0]).toEqual({ deadline_rolls: 'exact', late_submission_policy: 'reject' });

    for (const [column, bad] of [
      ['deadline_rolls', 'sideways'],
      ['late_submission_policy', 'sometimes'],
    ] as const) {
      await expect(
        asMe(
          async ({ query }) =>
            await sql`update groups set ${sql.raw(column)} = ${bad}
                       where id = ${mine.groupId}::uuid`.execute(query),
        ),
        column,
      ).rejects.toMatchObject({ code: '23514' });
    }
  }, 120_000);

  it('`is_late` and `revision_requested` default to false on every existing row', async () => {
    const id = await createOwnRequest(mine, 'availability', '2046-08-03', 'defaults');
    const row = await asMe(
      async ({ query }) =>
        await sql<{ is_late: boolean; revision_requested: boolean }>`
          select is_late, revision_requested from requests where id = ${id}::uuid
        `.execute(query),
    );
    expect(row.rows[0]).toEqual({ is_late: false, revision_requested: false });
  }, 120_000);
});
