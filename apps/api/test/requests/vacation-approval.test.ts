import { randomUUID } from 'node:crypto';

import {
  countersAfterReversal,
  grantHasHeadroom,
  overrideUnitsNeeded,
  type EvaluationContext,
} from '@schedulepoint/domain';
import { sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import {
  VacationApprovalRolledBack,
  approveVacationSelection,
  denyVacationSelection,
} from '../../src/requests/vacation-approval.js';
import { vacationStore } from '../../src/requests/vacation-store.js';
import { adminClient } from '../support/admin-client.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { entitleRequestsModule } from '../support/requests.js';

/**
 * **SPEC-08 §5.4 and §5.5 — `APPROVE-VACATION`, over the real database**
 * (OPUS-M5-002, doc 42 §5d Part B).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## The SPEC-08 §7 rows this file discharges
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * | # | What |
 * |---|---|
 * | R-05 | Two approvals RACING the last quota unit — exactly one succeeds; the loser gets `QUOTA_EXHAUSTED` |
 * | R-06 | Over-quota approval WITHOUT the override capability — denied |
 * | R-07 | Over-quota WITH capability and reason — approved, audited, `is_override` set |
 * | R-08 | A reversal that would go negative — rejected |
 * | R-13 | Open vs quota mode; open-mode approval succeeds with NO grant row and `grant_id` null |
 * | R-17 | Duplicate with the same key — the recorded outcome, exactly ONE unit consumed |
 * | R-18 | A selection already decided, fresh key — `SELECTION_NOT_PENDING`, no unit consumed |
 * | R-19 | A stale `expected_selection_version` — `SELECTION_NOT_PENDING`, nothing written |
 * | R-20 | Override then reversal — both counters fall, no silent headroom remains |
 *
 * **R-21 is NOT re-proven here.** M5-000b proved the unconditional CHECKs against
 * a direct `UPDATE` and that proof carries; doc 42 §5d says do not re-prove it and
 * never weaken it, and nothing in this packet touches those constraints.
 *
 * ## R-05 is proven with two GENUINELY CONCURRENT transactions
 *
 * Not a sequential simulation. Two units of work are opened, both wait on one
 * gate, and the gate is released so that both attempt the grant `UPDATE` while the
 * other's transaction is open. Under READ COMMITTED the loser blocks on the
 * winner's row lock, then re-evaluates its own `WHERE` against the winner's
 * committed row — which is the mechanism §5.4's predicate relies on, and the thing
 * a sequential test would never exercise.
 *
 * **The D-21 CHECK is the arbiter**, and the loser's classification is
 * deliberate: `QUOTA_EXHAUSTED` rather than `VERSION_CONFLICT`, because §5.4's
 * note requires it AND because it is the truthful answer — telling the loser their
 * version was stale would tell them to retry something that cannot succeed.
 *
 * ## Synthetic only
 *
 * Every date is far-future; every label and reason is the fixture's own.
 */

const multi = ownedMulti('requests-vacation-approval', {
  profile: 'core',
  seed: { catalogue: ['alpha'] },
});

let runtime: Runtime;
let admin: pg.Client;
let organizationId: string;
let groupId: string;
/** The requester whose selections are decided. */
let memberMembershipId: string;
/** The decider. Holds the four decision keys by role (doc 08 §6). */
let schedulerMembershipId: string;
let schedulerUserId: string;
let organizationAdminMembershipId: string;
/** A second decider who additionally holds `vacation.override_quota` (R-07). */
let overriderMembershipId: string;
let overriderUserId: string;

interface Ctx {
  organizationId: string;
  groupId: string;
  membershipId: string;
  correlationId: string;
}

const schedulerCtx = (): Ctx => ({
  organizationId,
  groupId,
  membershipId: schedulerMembershipId,
  correlationId: `vac-approval-${randomUUID().slice(0, 8)}`,
});

const overriderCtx = (): Ctx => ({
  organizationId,
  groupId,
  membershipId: overriderMembershipId,
  correlationId: `vac-override-${randomUUID().slice(0, 8)}`,
});

const actorFor = (membershipId: string, userId: string): EvaluationContext => ({
  principalUserId: userId,
  expectedOrganizationId: organizationId,
  expectedGroupId: groupId,
  membershipId,
});

const asScheduler = async <T>(fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> =>
  runtime.runner.run(schedulerCtx(), fn);

/* ────────────────────────────────────────────────────────────────────────────
 * Fixture
 * ──────────────────────────────────────────────────────────────────────────── */

interface Round {
  readonly periodId: string;
  readonly grantId: string | null;
  readonly weeks: readonly string[];
}

/** `YYYY-MM-DD` for `base` plus `days`, without a local timezone in the way. */
function plusDays(base: string, days: number): string {
  const at = new Date(`${base}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/**
 * A two-week vacation period, optionally with a personal-entitlement grant.
 *
 * Two weeks because the week-in-period trigger refuses a `weekStart` outside the
 * period, and a one-week round leaves nowhere for a second selection to go —
 * which `test/support/requests.ts` records having discovered the hard way.
 *
 * `unitsTotal` is a parameter because the interesting cases are exactly the small
 * numbers: **1** is the last unit R-05 races for, and **0** is the bound R-06 and
 * R-07 push past.
 */
async function makeRound(
  start: string,
  mode: 'quota' | 'open',
  unitsTotal: number | null,
): Promise<Round> {
  return asScheduler(async ({ query }) => {
    const periodId = randomUUID();
    await sql`
      insert into vacation_periods
        (id, organization_id, group_id, start_date, end_date, mode, state)
      values (${periodId}::uuid, ${organizationId}::uuid, ${groupId}::uuid,
              ${start}::date, ${plusDays(start, 11)}::date, ${mode}, ${'open'})
    `.execute(query);

    let grantId: string | null = null;
    if (unitsTotal !== null) {
      grantId = randomUUID();
      await sql`
        insert into vacation_grants
          (id, organization_id, group_id, vacation_period_id, kind, membership_id, units_total,
           units_consumed)
        values (${grantId}::uuid, ${organizationId}::uuid, ${groupId}::uuid, ${periodId}::uuid,
                ${'personal-entitlement'}, ${memberMembershipId}::uuid, ${unitsTotal}, ${0})
      `.execute(query);
    }
    return { periodId, grantId, weeks: [start, plusDays(start, 7)] };
  });
}

/**
 * A `pending` selection with its root, in ONE transaction.
 *
 * Both halves together because D-27 is a DEFERRED constraint trigger on both
 * sides: the root's `submitted` and the selection's `pending` must agree at
 * COMMIT, and writing them in two transactions would abort the second one for a
 * reason a long way from where it was caused.
 *
 * The root is created at `submitted` — §5.3's mapping reads `available` → *no
 * request row yet*, `pending` → `submitted`, so a vacation root's first instant
 * IS the submission and migration 0023's initial-status guard refuses any other.
 */
async function makePendingSelection(round: Round, weekIndex: number): Promise<string> {
  const week = round.weeks[weekIndex];
  if (week === undefined) throw new Error('the round has no such week');
  return asScheduler(async ({ query }) => {
    const requestId = randomUUID();
    await sql`
      insert into requests
        (id, organization_id, group_id, membership_id, subtype, status, expires_at,
         idempotency_key)
      values (${requestId}::uuid, ${organizationId}::uuid, ${groupId}::uuid,
              ${memberMembershipId}::uuid, ${'vacation-selection'},
              app_request_initial_status(${'vacation-selection'}),
              ${'2099-06-01T00:00:00.000Z'}::timestamptz,
              ${`vac.${randomUUID().slice(0, 12)}`})
    `.execute(query);

    const selectionId = randomUUID();
    await sql`
      insert into vacation_selections
        (id, organization_id, group_id, request_id, membership_id, vacation_period_id,
         week_start, status)
      values (${selectionId}::uuid, ${organizationId}::uuid, ${groupId}::uuid,
              ${requestId}::uuid, ${memberMembershipId}::uuid, ${round.periodId}::uuid,
              ${week}::date, ${'pending'})
    `.execute(query);
    return selectionId;
  });
}

async function grantCounters(
  grantId: string,
): Promise<{ unitsTotal: number; unitsConsumed: number; overrideUnits: number; version: number }> {
  const result = await admin.query<{
    units_total: number;
    units_consumed: number;
    override_units: number;
    version: number;
  }>(
    'select units_total, units_consumed, override_units, version from vacation_grants where id = $1::uuid',
    [grantId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('the fixture grant is missing');
  return {
    unitsTotal: row.units_total,
    unitsConsumed: row.units_consumed,
    overrideUnits: row.override_units,
    version: row.version,
  };
}

async function selectionState(
  selectionId: string,
): Promise<{
  status: string;
  version: number;
  grant_id: string | null;
  is_override: boolean;
  override_reason: string | null;
  request_id: string | null;
}> {
  const result = await admin.query<{
    status: string;
    version: number;
    grant_id: string | null;
    is_override: boolean;
    override_reason: string | null;
    request_id: string | null;
  }>(
    `select status, version, grant_id, is_override, override_reason, request_id
       from vacation_selections where id = $1::uuid`,
    [selectionId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('the fixture selection is missing');
  return row;
}

async function rootStatus(requestId: string): Promise<{ status: string; version: number }> {
  const result = await admin.query<{ status: string; version: number }>(
    'select status, version from requests where id = $1::uuid',
    [requestId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('the root is missing');
  return row;
}

/** A promise plus its resolver — the gate the two racing transactions wait on. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = () => {
      resolve();
    };
  });
  return { promise, open };
}

beforeAll(async () => {
  runtime = createRuntime('app_runtime', { max: 6 });
  admin = adminClient();
  await admin.connect();

  const alpha = multi().alpha;
  organizationId = alpha.organizationId;
  groupId = alpha.groupOne.id;
  memberMembershipId = alpha.users.member.membershipId;
  schedulerMembershipId = alpha.users.scheduler.membershipId;
  schedulerUserId = alpha.users.scheduler.id;
  organizationAdminMembershipId = alpha.users.organizationAdmin.membershipId;
  /* The OVERRIDER is a SECOND scheduler membership in Group One (`groupOnly`,
   * whose group role is `scheduler`). Two memberships rather than one granted
   * mid-file, so R-06's refusal and R-07's success are independent of ordering
   * under a shuffled seed — a single membership granted the key partway through
   * would make one of the two cases depend on which ran first.
   *
   * It already holds the four DECISION keys by role, from doc 08 §6's "Approve
   * requests/vacation ✓" for `scheduler`. What it does not hold — and what the
   * plain scheduler above must NOT hold, or R-06 would be vacuous — is
   * `vacation.override_quota`, which is GRANT-ONLY (doc 08 §4's enumeration, and
   * §6's "Vacation commit / quota override — G" row).
   *
   * So exactly one key is granted, the way a real one is: through
   * `capability_grants`, under an ORGANIZATION-scoped context, by a DIFFERENT
   * user, so `app_guard_capability_grant_administration`'s two-person rule is
   * satisfied rather than worked around. */
  overriderMembershipId = alpha.users.groupOnly.membershipId;
  overriderUserId = alpha.users.groupOnly.id;

  /* The override's second evaluation runs the FULL SPEC-06 truth table, so L1.1
   * and L2.1 apply to it exactly as they apply to a route. `requests_vacation` is
   * entitled in no fixture organization, and without this R-07 would refuse a
   * caller who genuinely holds `vacation.override_quota` — with R-06's own code,
   * which would have made R-06 look proven while proving nothing. See
   * `test/support/requests.ts` for the finding. */
  await entitleRequestsModule(runtime.runner, {
    organizationId,
    groupId,
    organizationAdminMembershipId,
  });

  await runtime.runner.run(
    {
      organizationId,
      groupId: null,
      membershipId: organizationAdminMembershipId,
      correlationId: 'vac-approval-grant',
    } as never,
    async ({ query }) => {
      await query
        .insertInto('capability_grants')
        .values({
          id: randomUUID(),
          organization_id: organizationId,
          group_id: groupId,
          membership_id: overriderMembershipId,
          capability_key: 'vacation.override_quota',
          granted: true,
          granted_by_membership_id: organizationAdminMembershipId,
        })
        .execute();
    },
  );
}, 240_000);

afterAll(async () => {
  await runtime?.destroy();
  await admin?.end();
});

/* ────────────────────────────────────────────────────────────────────────────
 * The happy path, and the two-step
 * ──────────────────────────────────────────────────────────────────────────── */

describe('§5.4 — the approval transaction, and the BINDING two-step', () => {
  it('a quota-mode approval consumes exactly one unit and walks the root TWO edges', async () => {
    const round = await makeRound('2048-03-02', 'quota', 3);
    const selectionId = await makePendingSelection(round, 0);
    const before = await grantCounters(round.grantId ?? '');
    const rootBefore = await rootStatus((await selectionState(selectionId)).request_id ?? '');

    const result = await asScheduler((uow) =>
      approveVacationSelection(uow, {
        selectionId,
        approvalIdempotencyKey: `approve-${randomUUID().slice(0, 8)}`,
        expectedSelectionVersion: 1,
        decidedBy: schedulerMembershipId,
        now: new Date(),
        actor: actorFor(schedulerMembershipId, schedulerUserId),
      }),
    );

    expect(result.outcome).toBe('approved');
    expect(result.replayed).toBe(false);
    expect(result.grantId).toBe(round.grantId);
    expect(result.isOverride).toBe(false);

    const after = await grantCounters(round.grantId ?? '');
    expect(after.unitsConsumed, 'exactly one unit').toBe(before.unitsConsumed + 1);
    expect(after.overrideUnits, 'an ordinary approval raises no bound').toBe(before.overrideUnits);

    const selection = await selectionState(selectionId);
    expect(selection.status).toBe('approved');
    expect(selection.grant_id).toBe(round.grantId);

    /* §5.3's derived root status, and the trace of the two-step: the root's
     * version rose by TWO. §5.4 prints one statement; §2 has no
     * `submitted → approved` cell, so the printed spelling is refused by 0021's
     * guard and the implementable writer is `submitted → under_review → approved`
     * — invisible to deferred D-27, which reads current rows at COMMIT. */
    const rootAfter = await rootStatus(selection.request_id ?? '');
    expect(rootAfter.status).toBe('approved');
    expect(rootAfter.version, 'the two-step must leave a version that rose by two').toBe(
      rootBefore.version + 2,
    );
  });

  it('R-13 / V-30: an OPEN-mode approval succeeds with NO grant row and `grant_id` null', async () => {
    /* The defect V-30 fixed: the grant update ran unconditionally, so in open mode
     * — where no `vacation_grants` rows exist at all — it affected zero rows,
     * which §5.4 defined as `QUOTA_EXHAUSTED`. Open-mode approval therefore always
     * failed and R-13 could not pass. */
    const round = await makeRound('2048-05-04', 'open', null);
    const selectionId = await makePendingSelection(round, 0);

    const result = await asScheduler((uow) =>
      approveVacationSelection(uow, {
        selectionId,
        approvalIdempotencyKey: `open-${randomUUID().slice(0, 8)}`,
        expectedSelectionVersion: 1,
        decidedBy: schedulerMembershipId,
        now: new Date(),
        actor: actorFor(schedulerMembershipId, schedulerUserId),
      }),
    );

    expect(result.outcome).toBe('approved');
    expect(result.grantId, 'open mode leaves grant_id null — a recorded fact, not a gap').toBeNull();

    const selection = await selectionState(selectionId);
    expect(selection.status).toBe('approved');
    expect(selection.grant_id).toBeNull();

    /* No grant rows exist for the period at all, which is what makes this the
     * open-mode branch rather than a quota round that happened to have room. */
    const grants = await admin.query<{ n: string }>(
      'select count(*)::text as n from vacation_grants where vacation_period_id = $1::uuid',
      [round.periodId],
    );
    expect(grants.rows[0]?.n).toBe('0');
  });

  it('a DENIAL consumes nothing, and walks the same two edges', async () => {
    const round = await makeRound('2048-06-01', 'quota', 2);
    const selectionId = await makePendingSelection(round, 0);
    const before = await grantCounters(round.grantId ?? '');

    const result = await asScheduler((uow) =>
      denyVacationSelection(uow, {
        selectionId,
        approvalIdempotencyKey: `deny-${randomUUID().slice(0, 8)}`,
        expectedSelectionVersion: 1,
        reason: 'Two colleagues already have that week.',
        decidedBy: schedulerMembershipId,
        now: new Date(),
        actor: actorFor(schedulerMembershipId, schedulerUserId),
      }),
    );
    expect(result.outcome).toBe('denied');

    expect((await grantCounters(round.grantId ?? '')).unitsConsumed).toBe(before.unitsConsumed);
    const selection = await selectionState(selectionId);
    expect(selection.status).toBe('denied');
    expect((await rootStatus(selection.request_id ?? '')).status).toBe('denied');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * D-26 — idempotency
 * ──────────────────────────────────────────────────────────────────────────── */

describe('D-26 — approval is idempotent (R-17), and a failure stays retryable', () => {
  it('R-17: the same key twice returns the recorded outcome and consumes ONE unit', async () => {
    const round = await makeRound('2048-07-06', 'quota', 3);
    const selectionId = await makePendingSelection(round, 0);
    const key = `replay-${randomUUID().slice(0, 8)}`;
    const before = await grantCounters(round.grantId ?? '');

    const first = await asScheduler((uow) =>
      approveVacationSelection(uow, {
        selectionId,
        approvalIdempotencyKey: key,
        expectedSelectionVersion: 1,
        decidedBy: schedulerMembershipId,
        now: new Date(),
        actor: actorFor(schedulerMembershipId, schedulerUserId),
      }),
    );
    expect(first.replayed).toBe(false);

    const second = await asScheduler((uow) =>
      approveVacationSelection(uow, {
        selectionId,
        approvalIdempotencyKey: key,
        /* A FRESH version would be needed for a real second approval; the replay
         * never reaches step 2, so the value here is deliberately the stale one —
         * if the guard were skipped this would be the second consumption. */
        expectedSelectionVersion: 1,
        decidedBy: schedulerMembershipId,
        now: new Date(),
        actor: actorFor(schedulerMembershipId, schedulerUserId),
      }),
    );
    expect(second.replayed, 'the second call must be a REPLAY').toBe(true);
    expect(second.outcome).toBe('approved');

    /* Exactly one unit, one approval row, one event — §7's R-17 in three
     * assertions. */
    expect((await grantCounters(round.grantId ?? '')).unitsConsumed).toBe(before.unitsConsumed + 1);
    const approvals = await admin.query<{ n: string }>(
      'select count(*)::text as n from approvals where vacation_selection_id = $1::uuid',
      [selectionId],
    );
    expect(approvals.rows[0]?.n).toBe('1');
    const events = await admin.query<{ n: string }>(
      `select count(*)::text as n from audit_events
        where event_name = 'requests.vacation_selection.approved'
          and payload ->> 'selectionId' = $1`,
      [selectionId],
    );
    expect(events.rows[0]?.n).toBe('1');
  });

  it('a CONCURRENT duplicate: the second blocks, then replays what the first committed', async () => {
    /* The other half of D-26, and the one a sequential replay never exercises: two
     * deliveries of the same command in flight at once. The second's `INSERT …
     * ON CONFLICT DO NOTHING` blocks on the first's uncommitted unique key until
     * the first resolves, then sees the conflict and replays.
     *
     * This is the case that proves the rollback extension (migration 0024's header
     * / `vacation-approval.ts`'s header — every non-approved outcome rolls back)
     * did not open a double-consume window: whichever way the first goes, exactly
     * one unit is consumed in total. */
    const round = await makeRound('2048-08-03', 'quota', 3);
    const selectionId = await makePendingSelection(round, 0);
    const key = `concurrent-${randomUUID().slice(0, 8)}`;
    const before = await grantCounters(round.grantId ?? '');

    const start = gate();
    const attempt = (): Promise<unknown> =>
      runtime.runner.run(schedulerCtx(), async (uow) => {
        await start.promise;
        return approveVacationSelection(uow, {
          selectionId,
          approvalIdempotencyKey: key,
          expectedSelectionVersion: 1,
          decidedBy: schedulerMembershipId,
          now: new Date(),
          actor: actorFor(schedulerMembershipId, schedulerUserId),
        });
      });

    const both = Promise.allSettled([attempt(), attempt()]);
    start.open();
    const results = await both;

    const fulfilled = results.filter((one) => one.status === 'fulfilled');
    expect(fulfilled.length, 'both calls must resolve').toBe(2);
    const replays = fulfilled.filter(
      (one) => (one as PromiseFulfilledResult<{ replayed: boolean }>).value.replayed,
    );
    expect(replays.length, 'exactly one of the two must be the REPLAY').toBe(1);

    /* One unit in total, whichever order they resolved in. */
    expect((await grantCounters(round.grantId ?? '')).unitsConsumed).toBe(before.unitsConsumed + 1);
    expect((await selectionState(selectionId)).status).toBe('approved');
  });

  it('a FAILED attempt leaves the key retryable — the rollback extension, proven', async () => {
    /* The direction the concurrent case above cannot show. An attempt that fails
     * rolls back its D-26 command row with everything else, so the SAME key
     * succeeds afterwards once the obstacle is gone.
     *
     * Without the rollback the ledger would answer `quota_exhausted` to that
     * retry forever, and an idempotency guard would have become a
     * denial-of-service on the key. */
    const round = await makeRound('2048-09-07', 'quota', 0);
    const selectionId = await makePendingSelection(round, 0);
    const key = `retryable-${randomUUID().slice(0, 8)}`;

    /* First attempt: no headroom at all and the scheduler holds no override, so
     * R-06's refusal. */
    await expect(
      asScheduler((uow) =>
        approveVacationSelection(uow, {
          selectionId,
          approvalIdempotencyKey: key,
          expectedSelectionVersion: 1,
          decidedBy: schedulerMembershipId,
          now: new Date(),
          actor: actorFor(schedulerMembershipId, schedulerUserId),
        }),
      ),
    ).rejects.toBeInstanceOf(VacationApprovalRolledBack);

    /* The ledger row is GONE — that is the rollback, and it is what makes the
     * retry possible. */
    const ledger = await admin.query<{ n: string }>(
      'select count(*)::text as n from vacation_approval_commands where selection_id = $1::uuid',
      [selectionId],
    );
    expect(ledger.rows[0]?.n, 'a failed attempt must leave no ledger row').toBe('0');

    /* The obstacle is removed the way §5.5 says it is removed — by raising the
     * allowance, not by relaxing anything — and the SAME key now succeeds. */
    await admin.query('update vacation_grants set units_total = 1 where id = $1::uuid', [
      round.grantId,
    ]);
    const retried = await asScheduler((uow) =>
      approveVacationSelection(uow, {
        selectionId,
        approvalIdempotencyKey: key,
        expectedSelectionVersion: 1,
        decidedBy: schedulerMembershipId,
        now: new Date(),
        actor: actorFor(schedulerMembershipId, schedulerUserId),
      }),
    );
    expect(retried.outcome).toBe('approved');
    expect(retried.replayed).toBe(false);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * R-18 / R-19 — the guarded selection update
 * ──────────────────────────────────────────────────────────────────────────── */

describe('V-29 — the guarded selection update (R-18, R-19)', () => {
  it('R-18: a selection already decided is `SELECTION_NOT_PENDING`, with no unit consumed', async () => {
    const round = await makeRound('2048-10-05', 'quota', 3);
    const selectionId = await makePendingSelection(round, 0);

    await asScheduler((uow) =>
      approveVacationSelection(uow, {
        selectionId,
        approvalIdempotencyKey: `first-${randomUUID().slice(0, 8)}`,
        expectedSelectionVersion: 1,
        decidedBy: schedulerMembershipId,
        now: new Date(),
        actor: actorFor(schedulerMembershipId, schedulerUserId),
      }),
    );
    const afterFirst = await grantCounters(round.grantId ?? '');

    /* A FRESH key, so D-26 does not stop it at step 0 — the guard that must stop
     * it is step 2's `status = 'pending'`. */
    const failure = await asScheduler((uow) =>
      approveVacationSelection(uow, {
        selectionId,
        approvalIdempotencyKey: `second-${randomUUID().slice(0, 8)}`,
        expectedSelectionVersion: 2,
        decidedBy: schedulerMembershipId,
        now: new Date(),
        actor: actorFor(schedulerMembershipId, schedulerUserId),
      }),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(VacationApprovalRolledBack);
    expect((failure as VacationApprovalRolledBack).failure).toBe('SELECTION_NOT_PENDING');

    /* **The unit consumed at step 1 was RELEASED by the rollback.** Without it a
     * second approval of an already-approved selection would consume a second
     * unit, which is the exact accounting error V-29 exists to prevent. */
    expect((await grantCounters(round.grantId ?? '')).unitsConsumed).toBe(afterFirst.unitsConsumed);
    expect((await selectionState(selectionId)).status).toBe('approved');
  });

  it('R-19: a stale `expected_selection_version` writes NOTHING', async () => {
    const round = await makeRound('2048-11-02', 'quota', 3);
    const selectionId = await makePendingSelection(round, 0);
    const before = await grantCounters(round.grantId ?? '');

    const failure = await asScheduler((uow) =>
      approveVacationSelection(uow, {
        selectionId,
        approvalIdempotencyKey: `stale-${randomUUID().slice(0, 8)}`,
        /* The selection is at version 1; this caller read an older one. */
        expectedSelectionVersion: 99,
        decidedBy: schedulerMembershipId,
        now: new Date(),
        actor: actorFor(schedulerMembershipId, schedulerUserId),
      }),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(VacationApprovalRolledBack);
    expect((failure as VacationApprovalRolledBack).failure).toBe('SELECTION_NOT_PENDING');

    expect((await grantCounters(round.grantId ?? '')).unitsConsumed).toBe(before.unitsConsumed);
    const selection = await selectionState(selectionId);
    expect(selection.status, 'the selection must not have moved').toBe('pending');
    expect(selection.version).toBe(1);
    const approvals = await admin.query<{ n: string }>(
      'select count(*)::text as n from approvals where vacation_selection_id = $1::uuid',
      [selectionId],
    );
    expect(approvals.rows[0]?.n).toBe('0');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * R-05 — the race
 * ──────────────────────────────────────────────────────────────────────────── */

describe('R-05 — two approvals RACING the last quota unit, genuinely concurrently', () => {
  it('exactly one succeeds; the loser gets QUOTA_EXHAUSTED and consumes nothing', async () => {
    /* ONE unit, TWO pending selections in different weeks of the same round,
     * sharing the same personal-entitlement grant. Both approvals target the last
     * unit, and the D-21 predicate `units_consumed < units_total + override_units`
     * is the arbiter.
     *
     * The gate makes this a REAL race rather than a simulation: both units of work
     * are open before either acts, so the loser's `UPDATE` blocks on the winner's
     * row lock and then re-evaluates its own `WHERE` against the winner's
     * committed row. A sequential test would never take that lock at all. */
    const round = await makeRound('2049-01-04', 'quota', 1);
    const first = await makePendingSelection(round, 0);
    const second = await makePendingSelection(round, 1);
    const before = await grantCounters(round.grantId ?? '');
    expect(before.unitsConsumed, 'the round must start with exactly one unit left').toBe(0);
    expect(before.unitsTotal).toBe(1);

    const start = gate();
    const attempt = (selectionId: string): Promise<unknown> =>
      runtime.runner.run(schedulerCtx(), async (uow) => {
        await start.promise;
        return approveVacationSelection(uow, {
          selectionId,
          approvalIdempotencyKey: `race-${selectionId.slice(0, 8)}`,
          expectedSelectionVersion: 1,
          decidedBy: schedulerMembershipId,
          now: new Date(),
          actor: actorFor(schedulerMembershipId, schedulerUserId),
        });
      });

    const both = Promise.allSettled([attempt(first), attempt(second)]);
    start.open();
    const results = await both;

    const winners = results.filter((one) => one.status === 'fulfilled');
    const losers = results.filter((one) => one.status === 'rejected');
    expect(winners.length, 'EXACTLY ONE approval must succeed').toBe(1);
    expect(losers.length).toBe(1);

    const loser = (losers[0] as PromiseRejectedResult).reason as unknown;
    expect(loser).toBeInstanceOf(VacationApprovalRolledBack);
    /* §5.4's own sentence: "The loser receives `QUOTA_EXHAUSTED`, not a silent
     * overwrite." Not `VERSION_CONFLICT` — that would tell the loser to retry
     * something that cannot succeed. */
    expect((loser as VacationApprovalRolledBack).failure).toBe('QUOTA_EXHAUSTED');

    /* The ledger: one unit consumed, the bound intact, one selection approved and
     * one still pending. */
    const after = await grantCounters(round.grantId ?? '');
    expect(after.unitsConsumed).toBe(1);
    expect(after.overrideUnits, 'a race must not raise a bound').toBe(0);
    expect(grantHasHeadroom(after), 'the grant is now at its bound').toBe(false);

    const statuses = [
      (await selectionState(first)).status,
      (await selectionState(second)).status,
    ].sort();
    expect(statuses).toEqual(['approved', 'pending']);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * §5.5 — over-quota, the audited override, and reversal
 * ──────────────────────────────────────────────────────────────────────────── */

describe('§5.5 — over-quota (R-06, R-07) and reversal (R-08, R-20)', () => {
  it('R-06: over-quota WITHOUT the override capability is refused, and writes nothing', async () => {
    const round = await makeRound('2049-02-01', 'quota', 0);
    const selectionId = await makePendingSelection(round, 0);
    const before = await grantCounters(round.grantId ?? '');

    const failure = await asScheduler((uow) =>
      approveVacationSelection(uow, {
        selectionId,
        approvalIdempotencyKey: `noquota-${randomUUID().slice(0, 8)}`,
        expectedSelectionVersion: 1,
        /* A reason IS supplied, and it authorises nothing. The capability is the
         * control; a body field could never be one. */
        overrideReason: 'The rota would otherwise be unfilled.',
        decidedBy: schedulerMembershipId,
        now: new Date(),
        actor: actorFor(schedulerMembershipId, schedulerUserId),
      }),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(VacationApprovalRolledBack);
    expect((failure as VacationApprovalRolledBack).failure).toBe('OVERRIDE_REQUIRED');

    const after = await grantCounters(round.grantId ?? '');
    expect(after.unitsConsumed).toBe(before.unitsConsumed);
    expect(after.overrideUnits, 'no bound may rise without the capability').toBe(
      before.overrideUnits,
    );
    expect((await selectionState(selectionId)).status).toBe('pending');
  });

  it('R-07: WITH the capability and a reason, the BOUND rises and the CHECK never moves', async () => {
    const round = await makeRound('2049-03-01', 'quota', 0);
    const selectionId = await makePendingSelection(round, 0);
    const before = await grantCounters(round.grantId ?? '');
    expect(overrideUnitsNeeded(before, 1), 'the fixture must genuinely be over quota').toBe(1);

    const reason = 'Approved over quota because the rota would otherwise be unfilled.';
    const result = await runtime.runner.run(overriderCtx(), (uow) =>
      approveVacationSelection(uow, {
        selectionId,
        approvalIdempotencyKey: `override-${randomUUID().slice(0, 8)}`,
        expectedSelectionVersion: 1,
        overrideReason: reason,
        decidedBy: overriderMembershipId,
        now: new Date(),
        actor: actorFor(overriderMembershipId, overriderUserId),
      }),
    );

    expect(result.outcome).toBe('approved');
    expect(result.isOverride, 'R-07 requires `is_override` set').toBe(true);

    const after = await grantCounters(round.grantId ?? '');
    /* **The invariant was never suspended; the BOUND was raised.** V-28's whole
     * resolution in two numbers: `units_consumed` went past `units_total`, and
     * `units_consumed <= units_total + override_units` still holds. */
    expect(after.unitsConsumed).toBe(1);
    expect(after.unitsTotal).toBe(0);
    expect(after.overrideUnits).toBe(1);
    expect(after.unitsConsumed).toBeLessThanOrEqual(after.unitsTotal + after.overrideUnits);

    /* Every relaxation is a visible, audited row ON THE GRANT — and the reason is
     * on the selection and on the decision, never in a payload. */
    const selection = await selectionState(selectionId);
    expect(selection.is_override).toBe(true);
    expect(selection.override_reason).toBe(reason);
    const decision = await admin.query<{ is_override: boolean; reason: string | null }>(
      'select is_override, reason from approvals where vacation_selection_id = $1::uuid',
      [selectionId],
    );
    expect(decision.rows[0]?.is_override).toBe(true);
    expect(decision.rows[0]?.reason).toBe(reason);

    const audits = await admin.query<{ payload: Record<string, unknown> }>(
      `select payload from audit_events
        where event_name = 'requests.vacation_selection.approved'
          and payload ->> 'selectionId' = $1`,
      [selectionId],
    );
    expect(audits.rows.length).toBe(1);
    expect(audits.rows[0]?.payload['isOverride']).toBe(true);
    expect(Object.keys(audits.rows[0]?.payload ?? {})).not.toContain('reason');
  });

  it('an override WITH the capability but NO reason is refused', async () => {
    const round = await makeRound('2049-04-05', 'quota', 0);
    const selectionId = await makePendingSelection(round, 0);

    const failure = await runtime.runner
      .run(overriderCtx(), (uow) =>
        approveVacationSelection(uow, {
          selectionId,
          approvalIdempotencyKey: `noreason-${randomUUID().slice(0, 8)}`,
          expectedSelectionVersion: 1,
          decidedBy: overriderMembershipId,
          now: new Date(),
          actor: actorFor(overriderMembershipId, overriderUserId),
        }),
      )
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(VacationApprovalRolledBack);
    expect((failure as VacationApprovalRolledBack).failure).toBe('OVERRIDE_REASON_REQUIRED');
  });

  it('R-20: reversal decrements BOTH counters, so no silent headroom remains', async () => {
    const round = await makeRound('2049-05-03', 'quota', 0);
    const selectionId = await makePendingSelection(round, 0);

    await runtime.runner.run(overriderCtx(), (uow) =>
      approveVacationSelection(uow, {
        selectionId,
        approvalIdempotencyKey: `r20-${randomUUID().slice(0, 8)}`,
        expectedSelectionVersion: 1,
        overrideReason: 'Approved over quota for the reversal case.',
        decidedBy: overriderMembershipId,
        now: new Date(),
        actor: actorFor(overriderMembershipId, overriderUserId),
      }),
    );
    const overridden = await grantCounters(round.grantId ?? '');
    expect(overridden).toMatchObject({ unitsConsumed: 1, unitsTotal: 0, overrideUnits: 1 });

    /* The domain's arithmetic and the store's statement must agree, and the
     * assertion is that they do — not that either one is separately plausible. */
    const predicted = countersAfterReversal(overridden, 1);
    const version = await runtime.runner.run(overriderCtx(), (uow) =>
      vacationStore.releaseGrantUnits(uow, {
        grantId: round.grantId ?? '',
        expectedVersion: overridden.version,
        units: 1,
        overrideUnits: 1,
      }),
    );
    expect(version).not.toBeNull();

    const after = await grantCounters(round.grantId ?? '');
    expect(after.unitsConsumed).toBe(predicted.unitsConsumed);
    expect(after.overrideUnits).toBe(predicted.overrideUnits);
    /* **No silent headroom.** The bound is back where it started, so the next
     * approval meets `units_total` and not `units_total + 1`. */
    expect(after.unitsTotal + after.overrideUnits).toBe(0);
    expect(grantHasHeadroom(after)).toBe(false);
  });

  it('R-08: a reversal that would go NEGATIVE is rejected as a data error', async () => {
    /* §5.5: "a reversal that would go below zero is rejected as a data error". Not
     * clamped — the unconditional `CHECK (units_consumed >= 0)` refuses the row,
     * and the store deliberately carries no defensive `WHERE units_consumed >=
     * :units` that would turn the refusal into a silent no-op. */
    const round = await makeRound('2049-06-07', 'quota', 2);
    const counters = await grantCounters(round.grantId ?? '');
    expect(counters.unitsConsumed).toBe(0);

    await expect(
      runtime.runner.run(schedulerCtx(), (uow) =>
        vacationStore.releaseGrantUnits(uow, {
          grantId: round.grantId ?? '',
          expectedVersion: counters.version,
          units: 1,
          overrideUnits: 0,
        }),
      ),
    ).rejects.toMatchObject({ code: '23514' });

    /* Rejected, and nothing changed. */
    expect((await grantCounters(round.grantId ?? '')).unitsConsumed).toBe(0);
  });
});
