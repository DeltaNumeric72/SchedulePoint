import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminClient } from '../support/admin-client.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import {
  buildHttpHarness,
  contextHeaders,
  currentCounters,
  type DeclaredCounters,
  type HttpHarness,
} from '../support/http.js';
import { ownedMulti } from '../support/owned-multi.js';
import { entitleRequestsModule } from '../support/requests.js';

/**
 * **SPEC-08 §5's submission side, driven over HTTP as a GRANTLESS MEMBER**
 * (OPUS-M5-003, doc 42 §5f Parts A and B).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## Why the actor is a member holding no grants at all
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * FAD-57 made `requests.own.submit` / `.own.withdraw` / `.own.read`
 * ROLE-IMPLIED for `member` and `scheduler`, on doc 08 §6's "Submit
 * requests/**vacation**" row. So a member with the role and **no capability
 * grants** is the actor whose success can only be the role-implied key — the
 * `member-submit-role-implication.test.ts` pattern, applied to the half of that
 * row nothing could exercise until this packet: the word "vacation".
 *
 * FU-29's rule for a new route family is at least one HTTP-driven SUCCESS shape
 * and at least one HTTP-driven REFUSAL per family, and all three families here
 * carry both.
 *
 * ## What this file proves that nothing else can
 *
 * | Claim | Why HTTP |
 * |---|---|
 * | the vacation subtype reaches the submission route at all | the `422` refusal it replaces was a ROUTE-level check |
 * | **FU-23's two branches** | the replay and the reuse are decided before the write, and the reuse's 409 has its own code |
 * | **R-16** — one selection row, zero in the other five | D-18 is a DEFERRED trigger; only a committed transaction proves it |
 * | **R-13** — open vs quota from the SUBMISSION side | V-30's branch, proven from the half M5-002 could not reach |
 * | **R-18/R-19** — the guarded withdrawal | the guard is a `WHERE`; a stale version has to be sent to be refused |
 * | deny-by-default on all three new routes | a viewer is `—` on doc 08 §6's row |
 *
 * ## FAD-15 vacuity discipline — an ALLOW control before every DENY
 *
 * A deny test whose subject does not exist denies for the wrong reason and
 * passes anyway. Every refusal below is preceded by the SAME request succeeding
 * for the member against the SAME route with the SAME body shape, so a 403 can
 * only mean the capability gate.
 *
 * ## Synthetic only
 *
 * Every date is far-future and every label is the fixture's own. No
 * organization, site or person name from the research appears here.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## FU-32 — OWN FIXTURE PER CASE, and the order dependence it cures
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * **The rule this file keeps (OPUS-M5-F32, doc 42 §5i; the R-13/T-15 pattern):
 * every `it()` creates every round, grant, request and selection it asserts
 * about, and every assertion is scoped to its OWN subject.** No case reads a
 * row another case wrote; no case asserts over a whole round's selection list
 * it did not fill itself. `beforeAll` carries only IMMUTABLE setup — the module
 * entitlement, the group's request window and the scheduler's grant-only
 * `vacation.override_quota` — never a round, never a quota grant, never a
 * selection.
 *
 * Rounds come from `nextRound…()` below, which hands each case its own
 * far-future 56-day band: the bands are distinct because migration 0022 makes
 * `vacation_periods` `UNIQUE (organization_id, group_id, start_date)`,
 * non-overlapping because a six-week round spans 39 days, and Monday-aligned
 * because `vacation_periods_starts_monday` requires it. Nothing in the file
 * depends on WHICH band a case draws, so the allocation is correct under every
 * permutation the shuffle can produce.
 *
 * ## What was wrong, and the seeds that exposed it
 *
 * Four cases used to read rows that EARLIER cases had written into one shared
 * quota round, and two more mutated that round underneath them:
 *
 *   * R-19's stale-version case read the selection the R-16 case submitted;
 *   * R-18's already-withdrawn case read the one the R-11 replay case
 *     submitted, and withdrew it;
 *   * "a member cannot withdraw a COLLEAGUE's selection" read the one FU-23's
 *     first case submitted;
 *   * the round read asserted `pending`/`submitted` over EVERY selection in the
 *     shared round, which the two withdrawal cases moved to `withdrawn`.
 *
 * Under `--sequence.shuffle.tests` those produced, verbatim: `the setup
 * selection must exist: expected undefined to be defined`, a bare `expected
 * undefined to be defined` at the colleague case, and `expected 'withdrawn' to
 * be 'pending'`.
 *
 * **The seeds of record** (FU-32's own evidence): composed seeded runs at
 * 20260920 (3 failures) and 20260921 (4) at M5-00C, both replicated
 * byte-identically on the unmodified base tree; 20260831 (4), 20260901 (2) and
 * 20260902 (1) at M5-004; and nightly fixture-regression runs 3–7
 * (2026-08-27..31), where ALL 14 seed jobs failed on the single case that read
 * a colleague's selection.
 *
 * **All five of those seeds reproduce their recorded failure COUNT in a
 * twelve-second SINGLE-FILE run at the same seed** (3 / 4 / 4 / 2 / 1
 * respectively, measured at OPUS-M5-F32) — so the mechanism is the within-file
 * order ALONE, the file set never entered it, and a single-file
 * `--sequence.shuffle.tests` run is this class's cheap replay key.
 *
 * **Falsified in both directions at ten seeds** — 1, 42, 20260831, 20260901,
 * 20260902, 20260920, 20260921, 777, 424242, 31337: each RED before this cure
 * (1–4 failures) and 19/19 GREEN after it, in an executed test order that is
 * byte-identical between the two runs of each seed, so what changed is the cure
 * and not the permutation. Canonical order is green on BOTH trees — which is
 * exactly why `pnpm check` never saw this defect and the nightly always did.
 *
 * **Nothing is weakened** (non-bypass rule 10): the same cases, the same
 * refusals by name, the same positive controls, the same counts. The fixtures
 * moved; the assertions did not.
 */

const multi = ownedMulti('requests-vacation-http', { profile: 'full' });

let harness: HttpHarness;
let runtime: Runtime;
let admin: pg.Client;
/** A SECOND superuser client, used only to hold a row lock in the C-1(c) race. */
let locker: pg.Client;

interface Reply {
  readonly statusCode: number;
  readonly body: unknown;
  readonly raw: string;
}

function scope(): string {
  const alpha = multi().alpha;
  return `/organizations/${alpha.organizationId}/groups/${alpha.groupOne.id}`;
}

async function countersFor(userId: string): Promise<DeclaredCounters> {
  const alpha = multi().alpha;
  return currentCounters(admin, {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    userId,
  });
}

async function call(
  method: 'GET' | 'POST',
  url: string,
  userId: string,
  body?: unknown,
): Promise<Reply> {
  const response = await harness.app.inject({
    method,
    url,
    headers: {
      ...contextHeaders(userId, await countersFor(userId)),
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    parsed = undefined;
  }
  return { statusCode: response.statusCode, body: parsed, raw: response.body };
}

/** A far-future round. Monday to Friday, as §5.2's CHECKs require. */
async function createPeriod(
  startDate: string,
  mode: 'quota' | 'open',
  state: 'draft' | 'open',
  weeks = 6,
): Promise<string> {
  const alpha = multi().alpha;
  const span = 7 * (weeks - 1) + 4;
  return runtime.runner.run(
    {
      organizationId: alpha.organizationId,
      groupId: alpha.groupOne.id,
      membershipId: alpha.users.scheduler.membershipId,
      correlationId: `vac-http-period-${randomUUID().slice(0, 8)}`,
    },
    async ({ query }) => {
      const inserted = await sql<{ id: string }>`
        insert into vacation_periods
          (organization_id, group_id, start_date, end_date, mode, state)
        values (${alpha.organizationId}::uuid, ${alpha.groupOne.id}::uuid,
                ${startDate}::date, (${startDate}::date + ${span}::integer)::date,
                ${mode}, ${state})
        returning id
      `.execute(query);
      const id = inserted.rows[0]?.id;
      if (id === undefined) throw new Error('the fixture period was not inserted');
      return id;
    },
  );
}

/** A personal entitlement for the MEMBER in the quota round. */
async function createEntitlement(periodId: string, units: number): Promise<string> {
  const alpha = multi().alpha;
  return runtime.runner.run(
    {
      organizationId: alpha.organizationId,
      groupId: alpha.groupOne.id,
      membershipId: alpha.users.scheduler.membershipId,
      correlationId: `vac-http-grant-${randomUUID().slice(0, 8)}`,
    },
    async ({ query }) => {
      const inserted = await sql<{ id: string }>`
        insert into vacation_grants
          (organization_id, group_id, vacation_period_id, kind, membership_id, units_total)
        values (${alpha.organizationId}::uuid, ${alpha.groupOne.id}::uuid, ${periodId}::uuid,
                ${'personal-entitlement'}, ${alpha.users.member.membershipId}::uuid,
                ${units}::integer)
        returning id
      `.execute(query);
      const id = inserted.rows[0]?.id;
      if (id === undefined) throw new Error('the fixture grant was not inserted');
      return id;
    },
  );
}

/** The Monday `weeks` weeks after `start`. */
function mondayAfter(start: string, weeks: number): string {
  return new Date(Date.parse(`${start}T00:00:00Z`) + weeks * 7 * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** A unique, well-formed idempotency key. */
const key = (label: string): string => `${label}.${randomUUID().slice(0, 12)}`;

/** Submit one vacation week as the MEMBER. */
async function submitWeek(
  periodId: string,
  weekStart: string,
  idempotencyKey: string,
): Promise<Reply> {
  return call('POST', `${scope()}/requests`, multi().alpha.users.member.id, {
    idempotencyKey,
    record: { subtype: 'vacation-selection', vacationPeriodId: periodId, weekStart },
  });
}

/** A grant's three counters and its version, read with the superuser. */
async function grantCounters(grantId: string): Promise<{
  units_total: number;
  units_consumed: number;
  override_units: number;
  version: number;
}> {
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
  if (row === undefined) throw new Error('the grant is missing');
  return row;
}

/**
 * Submit a week as the MEMBER and APPROVE it as the SCHEDULER — the state every
 * release case starts from.
 *
 * Both halves go through the real routes: the submission through this packet's
 * own, the approval through M5-002's `APPROVE-VACATION`. A fixture that wrote the
 * `approved` pair directly would be proving the release against a state no
 * shipped path produces, and the unit it releases would be one nothing consumed.
 */
async function approvedWeek(
  periodId: string,
  weekStart: string,
  options: { readonly overrideReason?: string } = {},
): Promise<{ selectionId: string; requestId: string; version: number }> {
  const submitted = await submitWeek(periodId, weekStart, key('vac.rel'));
  if (submitted.statusCode !== 201) {
    throw new Error(`the fixture submission failed: ${submitted.raw}`);
  }
  const requestId = (submitted.body as { root: { id: string } }).root.id;
  const pending = await selectionOf(requestId);

  const approved = await call(
    'POST',
    `${scope()}/vacation/selections/${pending.id}/approve`,
    multi().alpha.users.scheduler.id,
    {
      approvalIdempotencyKey: key('appr'),
      expectedSelectionVersion: pending.version,
      ...(options.overrideReason === undefined
        ? {}
        : { overrideReason: options.overrideReason }),
    },
  );
  if (approved.statusCode !== 200) {
    throw new Error(`the fixture approval failed: ${approved.raw}`);
  }

  const after = await selectionOf(requestId);
  return { selectionId: after.id, requestId, version: after.version };
}

/** How many subtype rows each of the six tables holds for one request. */
async function subtypeRowCensus(requestId: string): Promise<Record<string, number>> {
  const tables = [
    'request_availability',
    'request_time_off',
    'request_no_call',
    'request_shift_preference',
    'request_shift_group_off',
    'vacation_selections',
  ] as const;
  const census: Record<string, number> = {};
  for (const table of tables) {
    const result = await admin.query<{ n: string }>(
      `select count(*)::text as n from ${table} where request_id = $1::uuid`,
      [requestId],
    );
    census[table] = Number(result.rows[0]?.n ?? '0');
  }
  return census;
}

/** The selection row for one request, read with the superuser. */
async function selectionOf(
  requestId: string,
): Promise<{ id: string; status: string; version: number; grant_id: string | null }> {
  const result = await admin.query<{
    id: string;
    status: string;
    version: number;
    grant_id: string | null;
  }>('select id, status, version, grant_id from vacation_selections where request_id = $1::uuid', [
    requestId,
  ]);
  const row = result.rows[0];
  if (row === undefined) throw new Error('the selection is missing');
  return row;
}

/** One request's root status and version. */
async function rootOf(requestId: string): Promise<{ status: string; version: number }> {
  const result = await admin.query<{ status: string; version: number }>(
    'select status, version from requests where id = $1::uuid',
    [requestId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('the request is missing');
  return row;
}

/**
 * The authorization denial the server logged for the last call, if any.
 *
 * A `403` can be produced by many things; `respondToDenial` is the only path
 * that writes this structured line, and its `reason` names the SPEC-06 layer
 * that refused. Checking it is how "refused by the capability gate" is
 * distinguished from "refused by whatever fired first" — the finding
 * `decision-authority.test.ts` records about the two writers of this message.
 */
function lastDenial(): { step?: unknown; reason?: unknown } | undefined {
  for (let index = harness.logs.length - 1; index >= 0; index -= 1) {
    const line = harness.logs[index];
    if (line?.['msg'] !== 'authorization denied') continue;
    const authorization = line['authorization'];
    if (typeof authorization === 'object' && authorization !== null) {
      return authorization as { step?: unknown; reason?: unknown };
    }
  }
  return undefined;
}

/**
 * ## The per-case round allocator (FU-32)
 *
 * The first far-future Monday, and the stride between one case's round and the
 * next. 56 days is eight weeks: a round created by `createPeriod` spans 39 days
 * (`7 × (weeks − 1) + 4` at the default six), so consecutive bands cannot touch
 * even before the `UNIQUE (organization_id, group_id, start_date)` key rules out
 * two rounds sharing a start.
 *
 * The counter is monotonic, never reset, and read by no assertion — so the
 * SHUFFLE decides which case draws which band and every band is still distinct.
 */
const FIRST_ROUND_MONDAY = '2061-06-06';
const ROUND_STRIDE_DAYS = 56;
let roundsAllocated = 0;

function nextRoundStart(): string {
  const index = roundsAllocated;
  roundsAllocated += 1;
  return new Date(
    Date.parse(`${FIRST_ROUND_MONDAY}T00:00:00Z`) + index * ROUND_STRIDE_DAYS * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
}

interface Round {
  /** The round's own id. */
  readonly periodId: string;
  /** Its first Monday — `mondayAfter(round.start, n)` is its nth week. */
  readonly start: string;
}

interface QuotaRound extends Round {
  /** The MEMBER's personal entitlement in this round, which no other round shares. */
  readonly grantId: string;
}

/** A fresh `open`-state QUOTA round with the member's own entitlement in it. */
async function nextQuotaRound(units = 3): Promise<QuotaRound> {
  const start = nextRoundStart();
  const periodId = await createPeriod(start, 'quota', 'open');
  const grantId = await createEntitlement(periodId, units);
  return { periodId, start, grantId };
}

/** A fresh `open`-state OPEN-mode round — V-30's other branch, and no grants at all. */
async function nextOpenRound(): Promise<Round> {
  const start = nextRoundStart();
  return { periodId: await createPeriod(start, 'open', 'open'), start };
}

/** A fresh round still in `draft`: the round's own window, which is not §3's deadline. */
async function nextDraftRound(): Promise<Round> {
  const start = nextRoundStart();
  return { periodId: await createPeriod(start, 'quota', 'draft'), start };
}

beforeAll(async () => {
  harness = await buildHttpHarness();
  runtime = createRuntime('app_runtime', { max: 3 });
  admin = adminClient();
  await admin.connect();

  /* Without this every assertion below is vacuous: `requests_vacation` is
   * entitled in no fixture organization, so the surface denies at L1.1
   * NOT_ENTITLED and answers 404 for everybody. The M5-002 finding, cured the
   * same way. */
  const alpha = multi().alpha;
  await entitleRequestsModule(runtime.runner, {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    organizationAdminMembershipId: alpha.users.organizationAdmin.membershipId,
  });

  /* §3's window, open on a far-future fixed date, so a submission is refused by
   * nothing except this file's own subjects. A `closed` window — the fixture
   * default, and the strict direction migration 0023 deliberately chose — would
   * refuse every submission below for a POLICY reason and this file would be
   * asserting the deadline machinery instead of the vacation lifecycle.
   *
   * **Written by the GROUP ADMINISTRATOR**, for the reason
   * `member-submit-role-implication.test.ts` records: migration 0010 gates the
   * request-until columns on `group.settings.administer`, and granting that key
   * to the member would make "a grantless member" a sentence somebody has to
   * qualify. Schedulers do not open their own request windows either. */
  const groupAdmin = alpha.full?.groupAdmin;
  if (groupAdmin === undefined) throw new Error('the full profile did not provision a group admin');
  await runtime.runner.run(
    {
      organizationId: alpha.organizationId,
      groupId: alpha.groupOne.id,
      membershipId: groupAdmin.membershipId,
      correlationId: 'vac-http-window',
    },
    async ({ query }) =>
      await sql`
        update groups
           set request_until_mode = ${'fixed_date'},
               request_until_date = ${'2090-12-31'}::date,
               request_until_lead_days = ${null},
               deadline_rolls = ${'exact'},
               late_submission_policy = ${'reject'}
         where id = ${alpha.groupOne.id}::uuid
      `.execute(query),
  );

  /* NO round, NO quota grant and NO selection is created here (FU-32): a round
   * built in `beforeAll` is shared mutable state, and a case that reads or
   * moves another case's row is order-dependent by construction. Each case
   * draws its own from `nextQuotaRound` / `nextOpenRound` / `nextDraftRound`.
   * What remains below is IMMUTABLE for the whole file — no case writes it, so
   * no case can see a different value for it than any other. */

  /* `vacation.override_quota` is GRANT-ONLY (doc 08 §4's enumeration and §6's
   * "Vacation commit / quota override — G"), so the scheduler does not hold it by
   * role. It is granted here the way a real one is — through `capability_grants`,
   * under an ORGANIZATION-scoped context, by a DIFFERENT person, so
   * `app_guard_capability_grant_administration`'s two-person rule is satisfied
   * rather than worked around. Only the override half of C-1 needs it. */
  await runtime.runner.run(
    {
      organizationId: alpha.organizationId,
      groupId: null,
      membershipId: alpha.users.organizationAdmin.membershipId,
      correlationId: 'vac-http-override-grant',
    } as never,
    async ({ query }) => {
      await query
        .insertInto('capability_grants')
        .values({
          id: randomUUID(),
          organization_id: alpha.organizationId,
          group_id: alpha.groupOne.id,
          membership_id: alpha.users.scheduler.membershipId,
          capability_key: 'vacation.override_quota',
          granted: true,
          granted_by_membership_id: alpha.users.organizationAdmin.membershipId,
        })
        .execute();
    },
  );

  locker = adminClient();
  await locker.connect();
}, 300_000);

afterAll(async () => {
  await harness?.close();
  await runtime?.destroy();
  await locker?.end();
  await admin?.end();
});

/* ────────────────────────────────────────────────────────────────────────────
 * The submission route — the 422 refusal retires
 * ──────────────────────────────────────────────────────────────────────────── */

describe('the vacation subtype reaches POST …/requests (the §5f retirement)', () => {
  it('R-16: a member submits a week, and the request carries EXACTLY ONE subtype row', async () => {
    const round = await nextQuotaRound();
    const week = mondayAfter(round.start, 0);
    const reply = await submitWeek(round.periodId, week, key('vac.first'));

    expect(reply.statusCode, reply.raw).toBe(201);
    const body = reply.body as {
      root: { id: string; subtype: string; status: string };
      record: Record<string, unknown>;
    };
    expect(body.root.subtype).toBe('vacation-selection');
    /* Born `submitted` — `app_request_initial_status` says so and there is no
     * `draft` hop for this subtype. */
    expect(body.root.status).toBe('submitted');
    /* The wire record is §1.2's three fields and nothing else. A rest-spread of
     * the domain record would have carried eleven more and `requestSchema.parse`
     * would have answered 500 on this success — the M5-002 defect, arriving by a
     * different route. */
    expect(body.record).toEqual({
      subtype: 'vacation-selection',
      vacationPeriodId: round.periodId,
      weekStart: week,
    });

    /* R-16, in the database: exactly one `vacation_selections` row, zero in the
     * other five. D-18's zero-row guard is DEFERRED, so only a COMMITTED
     * transaction proves it — which is what an HTTP call is. */
    expect(await subtypeRowCensus(body.root.id)).toEqual({
      request_availability: 0,
      request_time_off: 0,
      request_no_call: 0,
      request_shift_preference: 0,
      request_shift_group_off: 0,
      vacation_selections: 1,
    });

    /* And R-15's pair, committed: `pending` beside `submitted`. */
    expect((await selectionOf(body.root.id)).status).toBe('pending');
    expect((await rootOf(body.root.id)).status).toBe('submitted');
  }, 180_000);

  it('R-11: the SAME key replays — one row, and a 200 rather than a 201', async () => {
    const round = await nextQuotaRound();
    const week = mondayAfter(round.start, 1);
    const idempotencyKey = key('vac.replay');

    const first = await submitWeek(round.periodId, week, idempotencyKey);
    expect(first.statusCode, first.raw).toBe(201);
    const requestId = (first.body as { root: { id: string } }).root.id;

    const second = await submitWeek(round.periodId, week, idempotencyKey);
    expect(second.statusCode, second.raw).toBe(200);
    expect((second.body as { root: { id: string } }).root.id).toBe(requestId);

    /* One row, and one selection. A replay that wrote would make "how many times
     * did this person select this week" unanswerable. */
    const count = await admin.query<{ n: string }>(
      'select count(*)::text as n from requests where idempotency_key = $1',
      [idempotencyKey],
    );
    expect(Number(count.rows[0]?.n ?? '0')).toBe(1);
  }, 180_000);

  it('D-22: a SECOND selection of the same week is refused, and says which refusal it is', async () => {
    const round = await nextQuotaRound();
    const week = mondayAfter(round.start, 2);
    expect((await submitWeek(round.periodId, week, key('vac.d22a'))).statusCode).toBe(201);

    const second = await submitWeek(round.periodId, week, key('vac.d22b'));
    expect(second.statusCode, second.raw).toBe(409);
    expect((second.body as { error: { code: string } }).error.code).toBe(
      'VACATION_WEEK_ALREADY_SELECTED',
    );
  }, 180_000);

  it("the round's own window: a `draft` round refuses a selection", async () => {
    const round = await nextDraftRound();
    const reply = await submitWeek(round.periodId, mondayAfter(round.start, 0), key('vac.shut'));
    expect(reply.statusCode, reply.raw).toBe(409);
    expect((reply.body as { error: { code: string } }).error.code).toBe('VACATION_ROUND_NOT_OPEN');
  }, 180_000);
});

/* ────────────────────────────────────────────────────────────────────────────
 * FU-23 — the vacation-null replay seam, both branches
 * ──────────────────────────────────────────────────────────────────────────── */

describe('FU-23 — a key that names a request of ANOTHER subtype', () => {
  /**
   * The register's own scenario, made reachable by this packet.
   *
   * > a member who already holds a vacation request under key K, submitting a
   * > non-vacation request under the same K, gets `null` from the R-11 replay
   * > read, proceeds to the insert, and is refused by
   * > `UNIQUE (membership_id, idempotency_key, organization_id)` — a 409 rather
   * > than a replay.
   *
   * The failure to kill is that bare `409`. What must stand in its place is a
   * NAMED refusal decided before any write, and the discriminator is the CODE:
   * a plain `CONFLICT` is the old behaviour surviving.
   */
  it('vacation first, then a time-off under the same key: IDEMPOTENCY_KEY_REUSED', async () => {
    const round = await nextQuotaRound();
    const shared = key('vac.fu23a');
    const first = await submitWeek(round.periodId, mondayAfter(round.start, 3), shared);
    expect(first.statusCode, first.raw).toBe(201);

    const second = await call('POST', `${scope()}/requests`, multi().alpha.users.member.id, {
      idempotencyKey: shared,
      record: { subtype: 'time-off', targetDate: '2061-08-04' },
    });

    expect(second.statusCode, second.raw).toBe(409);
    const error = (second.body as { error: { code: string; existingSubtype?: string } }).error;
    /* THE assertion. `CONFLICT` here is FU-23's defect surviving. */
    expect(error.code, 'a bare CONFLICT is the 409 posing as a replay').toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
    /* And it names what the key already holds, so the caller knows why. The
     * disclosure is nil: D-7 is scoped to `membership_id`, so the row is the
     * caller's own. */
    expect(error.existingSubtype).toBe('vacation-selection');

    /* Nothing was written: the refusal is decided BEFORE the insert, so the
     * constraint is never reached. */
    const count = await admin.query<{ n: string }>(
      'select count(*)::text as n from requests where idempotency_key = $1',
      [shared],
    );
    expect(Number(count.rows[0]?.n ?? '0')).toBe(1);
  }, 180_000);

  it('time-off first, then a vacation week under the same key: the SAME named refusal', async () => {
    /* The other direction, and it is not the first case restated: the vacation
     * submission path has its own replay read, added by this packet, and a fix
     * applied to only one of the two would pass the case above and fail here. */
    const round = await nextQuotaRound();
    const shared = key('vac.fu23b');
    const first = await call('POST', `${scope()}/requests`, multi().alpha.users.member.id, {
      idempotencyKey: shared,
      record: { subtype: 'time-off', targetDate: '2061-08-11' },
    });
    expect(first.statusCode, first.raw).toBe(201);

    const second = await submitWeek(round.periodId, mondayAfter(round.start, 4), shared);
    expect(second.statusCode, second.raw).toBe(409);
    const error = (second.body as { error: { code: string; existingSubtype?: string } }).error;
    expect(error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(error.existingSubtype).toBe('time-off');
  }, 180_000);
});

/* ────────────────────────────────────────────────────────────────────────────
 * R-13 — open vs quota, from the SUBMISSION side
 * ──────────────────────────────────────────────────────────────────────────── */

describe('R-13 — both modes complete, and quota rules apply only in quota mode', () => {
  it('an OPEN round accepts a selection with NO grant row anywhere (V-30)', async () => {
    const round = await nextOpenRound();
    const week = mondayAfter(round.start, 0);
    const reply = await submitWeek(round.periodId, week, key('vac.open'));
    expect(reply.statusCode, reply.raw).toBe(201);

    const requestId = (reply.body as { root: { id: string } }).root.id;
    expect((await selectionOf(requestId)).status).toBe('pending');
    /* V-30's own fact: open mode has NO grants at all, and the submission did not
     * need one. A path that treated "no grants" as "quota exhausted" would have
     * refused this. */
    expect((await selectionOf(requestId)).grant_id).toBeNull();

    const grants = await admin.query<{ n: string }>(
      'select count(*)::text as n from vacation_grants where vacation_period_id = $1::uuid',
      [round.periodId],
    );
    expect(Number(grants.rows[0]?.n ?? '0')).toBe(0);
  }, 180_000);

  it('the round read carries an EMPTY variance in open mode, and a populated one in quota', async () => {
    /* Both rounds are this case's own: the open one so "no grants" is a fact
     * about a round nothing else touched, and the quota one so `unitsTotal` is
     * the entitlement created three lines below rather than one a neighbouring
     * case might have spent. */
    const openRound = await nextOpenRound();
    const quotaRound = await nextQuotaRound(3);

    const open = await call(
      'GET',
      `${scope()}/vacation/rounds/${openRound.periodId}`,
      multi().alpha.users.member.id,
    );
    expect(open.statusCode, open.raw).toBe(200);
    expect((open.body as { variance: unknown[] }).variance).toEqual([]);
    expect((open.body as { period: { mode: string } }).period.mode).toBe('open');

    const quota = await call(
      'GET',
      `${scope()}/vacation/rounds/${quotaRound.periodId}`,
      multi().alpha.users.member.id,
    );
    expect(quota.statusCode, quota.raw).toBe(200);
    const variance = (quota.body as { variance: { unitsTotal: number; state: string }[] }).variance;
    expect(variance.length, 'the quota round has an entitlement').toBeGreaterThan(0);
    expect(variance[0]?.unitsTotal).toBe(3);
    /* Nothing has been APPROVED, so nothing is consumed: a selection is not a
     * unit. The unit is taken by §5.4's approval, which is M5-002's. */
    expect(variance[0]?.state).toBe('within');
  }, 180_000);
});

/* ────────────────────────────────────────────────────────────────────────────
 * The round read — R-15 on the wire, and the ordering
 * ──────────────────────────────────────────────────────────────────────────── */

describe('the round read', () => {
  it('carries BOTH halves of D-27 s pair, and they agree', async () => {
    /* The round is this case's own and it fills the round itself, which is what
     * makes both assertions below mean what they say (FU-32): every selection
     * the read returns is one this case submitted and left `pending`, so
     * `pending`/`submitted` is a claim about the DERIVATION rather than about
     * which neighbouring case happened to run first — the shared round used to
     * arrive here carrying whatever the withdrawal cases had done to it.
     *
     * Three weeks, submitted 2 → 0 → 1, so the ordering assertion has teeth: a
     * route that returned insertion order would answer 2, 0, 1 and fail. */
    const round = await nextQuotaRound();
    for (const offset of [2, 0, 1]) {
      const submitted = await submitWeek(
        round.periodId,
        mondayAfter(round.start, offset),
        key(`vac.read${offset}`),
      );
      expect(submitted.statusCode, submitted.raw).toBe(201);
    }

    const reply = await call(
      'GET',
      `${scope()}/vacation/rounds/${round.periodId}`,
      multi().alpha.users.member.id,
    );
    expect(reply.statusCode, reply.raw).toBe(200);

    const selections = (
      reply.body as {
        selections: { selection: { status: string; weekStart: string }; rootStatus: string | null }[];
      }
    ).selections;
    expect(selections.length, 'the round must have selections to be about').toBeGreaterThan(0);

    for (const view of selections) {
      /* R-15 on the wire: the selection's status and the root's are both carried,
       * so a client can CHECK the derivation rather than trust it. */
      expect(view.selection.status).toBe('pending');
      expect(view.rootStatus).toBe('submitted');
    }

    /* And the ORDER is the domain's rule — week ascending — not the query's
     * accident. The comparator's own matrix test is in `packages/domain`; this
     * asserts the route actually applies it. */
    const weeks = selections.map((view) => view.selection.weekStart);
    expect([...weeks], 'the round list is ordered by week').toEqual([...weeks].sort());
  }, 180_000);
});

/* ────────────────────────────────────────────────────────────────────────────
 * R-18 / R-19 — the guarded withdrawal, and the release that is not double-run
 * ──────────────────────────────────────────────────────────────────────────── */

describe('R-18 / R-19 — withdrawal is guarded on status AND version', () => {
  it('a member withdraws their own pending week, and both rows move together', async () => {
    const round = await nextQuotaRound();
    const week = mondayAfter(round.start, 5);
    const submitted = await submitWeek(round.periodId, week, key('vac.withdraw'));
    expect(submitted.statusCode, submitted.raw).toBe(201);
    const requestId = (submitted.body as { root: { id: string } }).root.id;
    const selection = await selectionOf(requestId);

    const reply = await call(
      'POST',
      `${scope()}/vacation/selections/${selection.id}/withdraw`,
      multi().alpha.users.member.id,
      { expectedSelectionVersion: selection.version },
    );
    expect(reply.statusCode, reply.raw).toBe(200);
    const body = reply.body as {
      selectionStatus: string;
      rootStatus: string;
      unitReleased: boolean;
    };
    expect(body.selectionStatus).toBe('withdrawn');
    expect(body.rootStatus).toBe('withdrawn');
    /* A `pending` week consumed no unit, so none is returned. The release is the
     * `approved` case and is a different fact. */
    expect(body.unitReleased).toBe(false);

    expect((await selectionOf(requestId)).status).toBe('withdrawn');
    expect((await rootOf(requestId)).status).toBe('withdrawn');
  }, 180_000);

  it('R-19: a STALE version is refused, and nothing moves', async () => {
    const round = await nextQuotaRound();
    const week = mondayAfter(round.start, 0);
    /* THIS case submits the week it is about (FU-32 — it used to read the one
     * the R-16 case submitted, in a round both shared), so the selection is
     * `pending` at some version — and a version five ABOVE is stale whatever
     * that version is. The read below stays a database read rather than the
     * submission's own reply, because what R-19 refuses is a version presented
     * against the ROW's, and the row is the thing that must be looked at. */
    const submitted = await submitWeek(round.periodId, week, key('vac.stale'));
    expect(submitted.statusCode, submitted.raw).toBe(201);
    const found = await admin.query<{ id: string; version: number; status: string }>(
      `select v.id, v.version, v.status from vacation_selections v
        where v.vacation_period_id = $1::uuid and v.week_start = $2::date`,
      [round.periodId, week],
    );
    const row = found.rows[0];
    expect(row, 'the setup selection must exist').toBeDefined();
    if (row === undefined) return;

    const reply = await call(
      'POST',
      `${scope()}/vacation/selections/${row.id}/withdraw`,
      multi().alpha.users.member.id,
      { expectedSelectionVersion: row.version + 5 },
    );
    expect(reply.statusCode, reply.raw).toBe(409);
    expect((reply.body as { error: { code: string } }).error.code).toBe('SELECTION_NOT_PENDING');

    const after = await admin.query<{ status: string; version: number }>(
      'select status, version from vacation_selections where id = $1::uuid',
      [row.id],
    );
    expect(after.rows[0]?.status, 'nothing moved').toBe(row.status);
    expect(after.rows[0]?.version).toBe(row.version);
  }, 180_000);

  it('R-18: withdrawing an ALREADY withdrawn selection is refused', async () => {
    /* Its own round and its own week (FU-32): this case WITHDRAWS the selection
     * it reads, so reading one another case had submitted both depended on that
     * case having run and destroyed the state that case's neighbours assumed. */
    const round = await nextQuotaRound();
    const week = mondayAfter(round.start, 1);
    const submitted = await submitWeek(round.periodId, week, key('vac.twice'));
    expect(submitted.statusCode, submitted.raw).toBe(201);
    const found = await admin.query<{ id: string; version: number }>(
      `select id, version from vacation_selections
        where vacation_period_id = $1::uuid and week_start = $2::date`,
      [round.periodId, week],
    );
    const row = found.rows[0];
    expect(row).toBeDefined();
    if (row === undefined) return;

    const first = await call(
      'POST',
      `${scope()}/vacation/selections/${row.id}/withdraw`,
      multi().alpha.users.member.id,
      { expectedSelectionVersion: row.version },
    );
    expect(first.statusCode, first.raw).toBe(200);

    /* The second attempt presents the version the first produced, so the ONLY
     * predicate that can refuse it is `status = 'pending'`. That is R-18 with the
     * version variable held constant — a guard that checked the version alone
     * would let this through and withdraw an already-withdrawn week twice. */
    const after = await admin.query<{ version: number }>(
      'select version from vacation_selections where id = $1::uuid',
      [row.id],
    );
    const second = await call(
      'POST',
      `${scope()}/vacation/selections/${row.id}/withdraw`,
      multi().alpha.users.member.id,
      { expectedSelectionVersion: after.rows[0]?.version ?? 0 },
    );
    expect(second.statusCode, second.raw).toBe(409);
    expect((second.body as { error: { code: string } }).error.code).toBe('SELECTION_NOT_PENDING');
  }, 180_000);
});

/* ────────────────────────────────────────────────────────────────────────────
 * §5.5's RELEASE — withdrawing an APPROVED week returns the unit (condition C-1)
 *
 * The reviewer's finding, stated so it is not lost: the release shipped
 * UNEXECUTED. `unitReleased: true` was produced by no test in 2 508, because
 * every withdrawal case ran on a `pending` selection and a `pending` week has
 * consumed nothing — so the branch that decrements the grant, the branch that
 * decrements an override with it, and the rollback that pairs the release to the
 * withdrawal were all written and none of them had ever run.
 *
 * Three cases, and they are three because the code has three distinct behaviours:
 * the ordinary decrement, the override's SECOND decrement, and the failure path
 * where the release and the withdrawal must roll back TOGETHER.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('§5.5 — a withdrawal from `approved` RELEASES the quota unit', () => {
  it('(a) `unitReleased` is true and `units_consumed` is restored by EXACTLY one', async () => {
    /* Its own round and its own grant, with the headroom this half needs. */
    const round = await nextQuotaRound(2);
    const before = await grantCounters(round.grantId);
    const approved = await approvedWeek(round.periodId, mondayAfter(round.start, 0));

    /* The approval consumed one — asserted, so the release below is measured
     * against a unit that was really taken rather than against an assumption. */
    const consumed = await grantCounters(round.grantId);
    expect(consumed.units_consumed).toBe(before.units_consumed + 1);
    expect((await selectionOf(approved.requestId)).status).toBe('approved');
    expect((await rootOf(approved.requestId)).status).toBe('approved');

    const reply = await call(
      'POST',
      `${scope()}/vacation/selections/${approved.selectionId}/withdraw`,
      multi().alpha.users.member.id,
      { expectedSelectionVersion: approved.version },
    );
    expect(reply.statusCode, reply.raw).toBe(200);
    const body = reply.body as {
      selectionStatus: string;
      rootStatus: string;
      unitReleased: boolean;
    };
    /* THE assertion the reviewer's finding is about. */
    expect(body.unitReleased, 'an approved withdrawal returns the unit').toBe(true);
    expect(body.selectionStatus).toBe('withdrawn');
    expect(body.rootStatus).toBe('withdrawn');

    /* EXACTLY one, not "at least one": a release that decremented twice would
     * satisfy a `toBeLessThan` and corrupt the ledger. */
    const after = await grantCounters(round.grantId);
    expect(after.units_consumed).toBe(before.units_consumed);
    expect(after.override_units, 'no override was involved').toBe(before.override_units);
    expect((await selectionOf(approved.requestId)).status).toBe('withdrawn');
    expect((await rootOf(approved.requestId)).status).toBe('withdrawn');
  }, 240_000);

  it('(b) an OVERRIDE release decrements `override_units` WITH `units_consumed`', async () => {
    /* §5.5: "Reversing an override — Decrements `units_consumed` AND
     * `override_units` together, so the bound returns to its pre-override value
     * and an override cannot silently persist as headroom for a later approval."
     * The headroom sentence is what this case measures: a release that dropped
     * only `units_consumed` would leave `override_units` at 1 and hand the next
     * approval a free unit nobody authorised. */
    /* Its own round, with an entitlement of ZERO so that every approval in it
     * must take the audited override path and raise the bound. */
    const round = await nextQuotaRound(0);
    const before = await grantCounters(round.grantId);
    expect(before.units_total, 'the entitlement is zero, so any approval overrides').toBe(0);

    const approved = await approvedWeek(round.periodId, mondayAfter(round.start, 0), {
      overrideReason: 'The rota is covered that week by the relief roster.',
    });

    const consumed = await grantCounters(round.grantId);
    expect(consumed.units_consumed).toBe(before.units_consumed + 1);
    expect(consumed.override_units, 'the BOUND rose, the CHECK never moved').toBe(
      before.override_units + 1,
    );
    const selection = await admin.query<{ is_override: boolean }>(
      'select is_override from vacation_selections where id = $1::uuid',
      [approved.selectionId],
    );
    expect(selection.rows[0]?.is_override, 'the selection records the audited override').toBe(true);

    const reply = await call(
      'POST',
      `${scope()}/vacation/selections/${approved.selectionId}/withdraw`,
      multi().alpha.users.member.id,
      { expectedSelectionVersion: approved.version },
    );
    expect(reply.statusCode, reply.raw).toBe(200);
    expect((reply.body as { unitReleased: boolean }).unitReleased).toBe(true);

    const after = await grantCounters(round.grantId);
    expect(after.units_consumed).toBe(before.units_consumed);
    /* BOTH counters, together. This is the assertion `countersAfterReversal`
     * exists for, executed at last through a real writer. */
    expect(after.override_units, 'no override may persist as headroom').toBe(
      before.override_units,
    );
  }, 240_000);

  it('(c) a grant-version CONFLICT rolls the release AND the withdrawal back together', async () => {
    /* §5.4's rule, on the release path: a unit is never released without the
     * withdrawal that released it, and a withdrawal never commits without its
     * release — otherwise a member could give a week back and keep the allowance
     * spent, which is the quota-accounting error V-29 fixed on the other side of
     * the same transaction.
     *
     * ## How the conflict is made DETERMINISTIC rather than raced
     *
     * `releaseGrantUnits` is guarded on the grant version read moments earlier in
     * the SAME transaction, so a stale version is unreachable by writing one — it
     * has to be made stale UNDER the transaction. A second superuser connection
     * takes the grant row's write lock and holds it uncommitted; the withdrawal
     * then reads the still-committed version (MVCC does not block a SELECT) and
     * BLOCKS on its own UPDATE. Committing the lock holder releases it, and under
     * READ COMMITTED the withdrawal re-evaluates its `WHERE` against the newly
     * committed row, finds `version` moved, matches zero rows and rolls back.
     *
     * That is the same mechanism M5-002's R-05 race documents, run in the one
     * direction that is schedulable rather than hoped for. If the interleave ever
     * failed to happen the withdrawal would answer 200 and this case would FAIL
     * loudly rather than pass having proven nothing. */
    const round = await nextQuotaRound(2);
    const approved = await approvedWeek(round.periodId, mondayAfter(round.start, 1));
    const before = await grantCounters(round.grantId);
    expect(before.units_consumed, 'the approval consumed a unit to release').toBeGreaterThan(0);

    await locker.query('BEGIN');
    await locker.query(
      'update vacation_grants set version = version + 1, updated_at = now() where id = $1::uuid',
      [round.grantId],
    );

    /* Not awaited: the withdrawal must be in flight and blocked before the lock
     * holder commits. */
    const inFlight = call(
      'POST',
      `${scope()}/vacation/selections/${approved.selectionId}/withdraw`,
      multi().alpha.users.member.id,
      { expectedSelectionVersion: approved.version },
    );

    /* Wait for the block to be REAL rather than assumed: poll until a backend is
     * waiting on a lock. A fixed sleep would make this case's determinism a
     * property of the machine's speed. */
    let blocked = false;
    for (let attempt = 0; attempt < 100 && !blocked; attempt += 1) {
      const waiting = await admin.query<{ n: string }>(
        `select count(*)::text as n from pg_stat_activity
          where wait_event_type = 'Lock' and state = 'active'`,
      );
      blocked = Number(waiting.rows[0]?.n ?? '0') > 0;
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(blocked, 'the withdrawal must be blocked on the held row lock').toBe(true);

    await locker.query('COMMIT');

    const reply = await inFlight;
    expect(reply.statusCode, reply.raw).toBe(409);
    expect((reply.body as { error: { code: string } }).error.code).toBe('SELECTION_NOT_PENDING');

    /* BOTH halves rolled back, and this is the pair that matters: the selection
     * did NOT move, and no unit was returned. A release that had committed
     * without its withdrawal would show `units_consumed` one lower here while the
     * week was still approved — a member holding an approved week whose allowance
     * had been handed back. */
    const after = await grantCounters(round.grantId);
    expect(after.units_consumed, 'no unit may be released by a rolled-back withdrawal').toBe(
      before.units_consumed,
    );
    expect((await selectionOf(approved.requestId)).status, 'the week is still approved').toBe(
      'approved',
    );
    expect((await rootOf(approved.requestId)).status).toBe('approved');
  }, 240_000);
});

/* ────────────────────────────────────────────────────────────────────────────
 * Deny-by-default — the DENY half of FU-29's rule, per route family
 * ──────────────────────────────────────────────────────────────────────────── */

describe('deny-by-default — a VIEWER reaches none of the three new routes', () => {
  /**
   * The viewer holds `viewer`'s role capabilities and nothing else. Doc 08 §6's
   * "Submit requests/vacation" row is `—` for Viewer, so none of CAP-021's
   * own-keys is theirs by role and none is granted.
   *
   * Each refusal is preceded by the same call succeeding for the MEMBER above,
   * so a 403 here can only be the capability gate — and the captured log line's
   * `step` is checked, because a 403 produced by a neighbouring constraint would
   * satisfy a status-code assertion and prove nothing.
   */
  /** The `viewer` the `full` profile provisions — `—` on doc 08 §6's row. */
  const viewerId = (): string => {
    const full = multi().alpha.full;
    if (full === undefined) throw new Error('the full profile did not provision a viewer');
    return full.viewer.id;
  };

  it('the round LIST is refused at the capability layer', async () => {
    harness.clearLogs();
    const reply = await call('GET', `${scope()}/vacation/rounds`, viewerId());
    expect(reply.statusCode, reply.raw).toBe(403);
    expect(lastDenial()?.['reason']).toBe('NO_CAPABILITY');
  }, 120_000);

  it('the round READ is refused at the capability layer', async () => {
    /* Its own round, so the refusal is about a round that exists whichever
     * cases have run — a 403 on a missing round would be the right status for
     * the wrong reason. */
    const round = await nextQuotaRound();
    harness.clearLogs();
    const reply = await call('GET', `${scope()}/vacation/rounds/${round.periodId}`, viewerId());
    expect(reply.statusCode, reply.raw).toBe(403);
    expect(lastDenial()?.['reason']).toBe('NO_CAPABILITY');
  }, 120_000);

  it('the WITHDRAW route is refused at the capability layer', async () => {
    harness.clearLogs();
    const reply = await call(
      'POST',
      `${scope()}/vacation/selections/${randomUUID()}/withdraw`,
      viewerId(),
      { expectedSelectionVersion: 1 },
    );
    expect(reply.statusCode, reply.raw).toBe(403);
    expect(lastDenial()?.['reason']).toBe('NO_CAPABILITY');
  }, 120_000);

  it('a member cannot withdraw a COLLEAGUE’s selection — it is not visible at all', async () => {
    /* §4's "requester-initiated only" — and this case FOUND that the two controls
     * everybody would name do not deliver it, which is why it is here.
     *
     * The route carries `ownershipRequired: true` with no override, but SPEC-06
     * L5.1 compares a TARGET's owner to the acting membership and every route on
     * this self-scoped surface names the ACTING membership as its own target, so
     * L5.1 passes by construction. And migration 0023's `vacation_selections_own`
     * is not the only arm: `_group_administration` is `FOR ALL` behind
     * `requests.administer`, which FAD-57's sibling row makes role-implied for
     * `scheduler` — so RLS admits the write, exactly as 0023 intends ("RLS decides
     * which ROWS, never which OPERATIONS").
     *
     * Both statements are correct; their COMPOSITION left §4 undefended, and the
     * first run of this case withdrew the member's week successfully (200, the
     * selection `withdrawn`). The service now narrows on the VERIFIED context's
     * own membership — the "queries are self-scoped too" discipline
     * `requests.route.ts` records — and a colleague's selection answers 404,
     * byte-identical to a selection that does not exist (X-11).
     *
     * The scheduler is the right actor for it: FAD-57 gives them
     * `requests.own.withdraw` by role, so they REACH the route and are refused on
     * the row rather than at the door — which is the only shape in which this
     * property can be tested at all. */
    /* The colleague's week is submitted HERE, by the member, in this case's own
     * round (FU-32): it used to be the one FU-23's first case had submitted into
     * a shared round, so under a shuffle that placed this case first the read
     * found nothing and the case failed `expected undefined to be defined` —
     * the single assertion all 14 nightly seed jobs reddened on. */
    const round = await nextQuotaRound();
    const week = mondayAfter(round.start, 3);
    const submitted = await submitWeek(round.periodId, week, key('vac.colleague'));
    expect(submitted.statusCode, submitted.raw).toBe(201);
    const found = await admin.query<{ id: string; version: number }>(
      `select id, version from vacation_selections
        where vacation_period_id = $1::uuid and week_start = $2::date`,
      [round.periodId, week],
    );
    const row = found.rows[0];
    expect(row).toBeDefined();
    if (row === undefined) return;

    const reply = await call(
      'POST',
      `${scope()}/vacation/selections/${row.id}/withdraw`,
      multi().alpha.users.scheduler.id,
      { expectedSelectionVersion: row.version },
    );
    expect(reply.statusCode, reply.raw).toBe(404);

    /* And the member's row is untouched. */
    const after = await admin.query<{ status: string }>(
      'select status from vacation_selections where id = $1::uuid',
      [row.id],
    );
    expect(after.rows[0]?.status).toBe('pending');
  }, 180_000);
});
