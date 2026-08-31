import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
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
 * **SPEC-08 §5.6 — commit and reversal, driven over HTTP** (OPUS-M5-004,
 * doc 42 §5h, FAD-59).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## The §7 rows this file owns
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * | Row | What is proven here |
 * |---|---|
 * | **R-12** | a replayed commit key: ONE commit, the recorded outcome returned, and NOTHING written the second time |
 * | **R-08** | a reversal that would take `units_consumed` below zero is REJECTED as a data error, by the unconditional CHECK |
 * | **R-20** | override → reversal decrements BOTH counters, so no silent headroom remains |
 * | **R-10 (composition)** | the reversal RAISES a revision request; the published version is untouched |
 * | §5.6 / I-18 | committing into a PUBLISHED version is refused BY NAME, before anything is written |
 * | I-02 | deny-by-default: `vacation.commit` is grant-only, and a scheduler without it is refused |
 *
 * ## Every state is reached through a REAL route
 *
 * The selection is submitted through M5-001's creation route and approved
 * through M5-002's `APPROVE-VACATION`, so the `approved` row this file commits
 * is one the shipped paths produce. A fixture that wrote the pair directly would
 * be proving the commit against a state nothing makes.
 *
 * ## FAD-15 vacuity discipline
 *
 * Every refusal below is preceded or followed by the SAME shape SUCCEEDING, so a
 * `403` can only mean the capability gate and a `409` can only mean the state.
 *
 * ## Synthetic only
 *
 * Every date is far-future and every label is the fixture's own. No
 * organization, site or person name from the research appears here, and no
 * reason text below is clinical.
 */

const multi = ownedMulti('requests-vacation-commit-http', {
  profile: 'core',
  seed: { catalogue: ['alpha'] },
});

let harness: HttpHarness;
let runtime: Runtime;
let admin: pg.Client;

let quotaPeriodId: string;
let openPeriodId: string;
let schedulePeriodId: string;
let draftVersionId: string;
let publishedVersionId: string;
let offShiftTypeId: string;

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

const key = (label: string): string => `${label}.${randomUUID().slice(0, 12)}`;

/**
 * The Monday on or after `date`.
 *
 * Round starts and week references are BOTH Mondays in this schema
 * (`vacation_periods_starts_monday`, `vacation_selections_week_is_monday`), and
 * a hand-picked far-future date is exactly the kind of thing that is a Tuesday.
 * Computed rather than guessed.
 */
function mondayOnOrAfter(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  const shift = (8 - value.getUTCDay()) % 7;
  value.setUTCDate(value.getUTCDate() + shift);
  return value.toISOString().slice(0, 10);
}

/** The Monday `weeks` weeks after `start`. Always inside a 33-day round for 0..4. */
function weekIn(start: string, weeks: number): string {
  const value = new Date(`${start}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + weeks * 7);
  return value.toISOString().slice(0, 10);
}


const asScheduler = async <T>(fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> => {
  const alpha = multi().alpha;
  return runtime.runner.run(
    {
      organizationId: alpha.organizationId,
      groupId: alpha.groupOne.id,
      membershipId: alpha.users.scheduler.membershipId,
      correlationId: `commit-http-${randomUUID().slice(0, 8)}`,
    },
    fn,
  );
};

/** Grant one capability key to the scheduler, the way production grants it. */
async function grantToScheduler(capabilityKey: string): Promise<string> {
  const alpha = multi().alpha;
  const id = randomUUID();
  await runtime.runner.run(
    {
      organizationId: alpha.organizationId,
      groupId: null,
      membershipId: alpha.users.organizationAdmin.membershipId,
      correlationId: `commit-http-grant-${randomUUID().slice(0, 8)}`,
    },
    async ({ query }) => {
      await query
        .insertInto('capability_grants')
        .values({
          id,
          organization_id: alpha.organizationId,
          group_id: alpha.groupOne.id,
          membership_id: alpha.users.scheduler.membershipId,
          capability_key: capabilityKey,
          granted: true,
          granted_by_membership_id: alpha.users.organizationAdmin.membershipId,
        })
        .execute();
    },
  );
  return id;
}

/** Revoke a grant by id, so a deny-by-default case can be measured honestly. */
async function revokeGrant(grantId: string): Promise<void> {
  await admin.query('delete from capability_grants where id = $1::uuid', [grantId]);
}

/**
 * A vacation round, AND the schedule period and DRAFT version it is committed
 * into.
 *
 * One schedule period per round rather than one for the file, because
 * `schedule_periods_length` (migration 0011) bounds a period at 366 days and
 * `schedule_periods_no_overlap` (0009) forbids two that overlap — so a single
 * period spanning every far-future round this file uses is not a row the schema
 * permits. Each round therefore gets its own, which is also the shape production
 * has: a vacation round is committed into the schedule period that contains it.
 */
async function createPeriod(rawStart: string, mode: 'quota' | 'open'): Promise<string> {
  const alpha = multi().alpha;
  const startDate = mondayOnOrAfter(rawStart);
  return asScheduler(async ({ query }) => {
    const inserted = await sql<{ id: string }>`
      insert into vacation_periods
        (organization_id, group_id, start_date, end_date, mode, state)
      values (${alpha.organizationId}::uuid, ${alpha.groupOne.id}::uuid,
              ${startDate}::date, (${startDate}::date + 32)::date, ${mode}, ${'open'})
      returning id
    `.execute(query);
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('the fixture round was not created');

    const schedulePeriod = randomUUID();
    await sql`
      insert into schedule_periods (id, organization_id, group_id, name, start_date, end_date)
      values (${schedulePeriod}::uuid, ${alpha.organizationId}::uuid, ${alpha.groupOne.id}::uuid,
              ${`commit-http ${startDate}`}, (${startDate}::date - 3)::date,
              (${startDate}::date + 60)::date)
    `.execute(query);

    const draft = randomUUID();
    await sql`
      insert into schedule_versions (id, organization_id, group_id, period_id, state)
      values (${draft}::uuid, ${alpha.organizationId}::uuid, ${alpha.groupOne.id}::uuid,
              ${schedulePeriod}::uuid, ${'draft'})
    `.execute(query);
    DRAFT_BY_ROUND.set(id, draft);
    SCHEDULE_PERIOD_BY_ROUND.set(id, schedulePeriod);
    START_BY_ROUND.set(id, startDate);
    return id;
  });
}

/** The DRAFT version a round commits into. */
const DRAFT_BY_ROUND = new Map<string, string>();
const SCHEDULE_PERIOD_BY_ROUND = new Map<string, string>();
const START_BY_ROUND = new Map<string, string>();

/** The Monday of week `n` (0-based) of a round. Always inside its 33 days. */
function weekOf(roundId: string, n: number): string {
  const start = START_BY_ROUND.get(roundId);
  if (start === undefined) throw new Error('the fixture round has no start date');
  return weekIn(start, n);
}

function draftFor(roundId: string): string {
  const id = DRAFT_BY_ROUND.get(roundId);
  if (id === undefined) throw new Error('the fixture round has no draft version');
  return id;
}

async function createEntitlement(periodId: string, units: number): Promise<string> {
  return asScheduler(async ({ query }) => {
    const inserted = await sql<{ id: string }>`
      insert into vacation_grants
        (organization_id, group_id, vacation_period_id, kind, membership_id, units_total)
      values (${multi().alpha.organizationId}::uuid, ${multi().alpha.groupOne.id}::uuid,
              ${periodId}::uuid, ${'personal-entitlement'},
              ${multi().alpha.users.member.membershipId}::uuid, ${units}::integer)
      returning id
    `.execute(query);
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('the fixture entitlement was not created');
    return id;
  });
}

/** Submit one week as the MEMBER and approve it as the SCHEDULER. Real routes, both. */
async function approvedWeek(
  periodId: string,
  weekStart: string,
  options: { readonly overrideReason?: string } = {},
): Promise<{ selectionId: string; requestId: string }> {
  const submitted = await call('POST', `${scope()}/requests`, multi().alpha.users.member.id, {
    idempotencyKey: key('vc.sub'),
    record: { subtype: 'vacation-selection', vacationPeriodId: periodId, weekStart },
  });
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
      approvalIdempotencyKey: key('vc.appr'),
      expectedSelectionVersion: pending.version,
      ...(options.overrideReason === undefined ? {} : { overrideReason: options.overrideReason }),
    },
  );
  if (approved.statusCode !== 200) {
    throw new Error(`the fixture approval failed: ${approved.raw}`);
  }
  return { selectionId: pending.id, requestId };
}

async function selectionOf(requestId: string): Promise<{
  id: string;
  status: string;
  version: number;
  grant_id: string | null;
  committed_to_version_id: string | null;
  is_override: boolean;
  override_reason: string | null;
}> {
  const result = await admin.query<{
    id: string;
    status: string;
    version: number;
    grant_id: string | null;
    committed_to_version_id: string | null;
    is_override: boolean;
    override_reason: string | null;
  }>(
    `select id, status, version, grant_id, committed_to_version_id, is_override, override_reason
       from vacation_selections where request_id = $1::uuid`,
    [requestId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('the selection is missing');
  return row;
}

async function rootOf(
  requestId: string,
): Promise<{ status: string; version: number; revision_requested: boolean }> {
  const result = await admin.query<{
    status: string;
    version: number;
    revision_requested: boolean;
  }>('select status, version, revision_requested from requests where id = $1::uuid', [requestId]);
  const row = result.rows[0];
  if (row === undefined) throw new Error('the request is missing');
  return row;
}

async function grantCounters(
  grantId: string,
): Promise<{ units_total: number; units_consumed: number; override_units: number }> {
  const result = await admin.query<{
    units_total: number;
    units_consumed: number;
    override_units: number;
  }>(
    'select units_total, units_consumed, override_units from vacation_grants where id = $1::uuid',
    [grantId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('the grant is missing');
  return row;
}

/** OFF assignment snapshots in one version, for one membership. */
async function offSnapshots(versionId: string): Promise<{ n: number; origins: string[] }> {
  const result = await admin.query<{ origin: string }>(
    `select origin from assignment_snapshots
      where version_id = $1::uuid and shift_id in (
        select id from shifts where version_id = $1::uuid and shift_type_id = $2::uuid)`,
    [versionId, offShiftTypeId],
  );
  return { n: result.rows.length, origins: result.rows.map((row) => row.origin) };
}

async function ledgerRows(idempotencyKey: string): Promise<number> {
  const result = await admin.query<{ n: string }>(
    'select count(*)::text as n from vacation_commit_commands where idempotency_key = $1',
    [idempotencyKey],
  );
  return Number(result.rows[0]?.n ?? '0');
}

const QUOTA_START = '2081-06-02';
const OPEN_START = '2082-06-01';
let commitGrantId: string;
let overrideGrantId: string;

beforeAll(async () => {
  harness = await buildHttpHarness();
  runtime = createRuntime('app_runtime', { max: 4 });
  admin = adminClient();
  await admin.connect();

  const alpha = multi().alpha;
  await entitleRequestsModule(runtime.runner, {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    organizationAdminMembershipId: alpha.users.organizationAdmin.membershipId,
  });

  /* §3's window, open on a far-future date, so a submission below is refused by
   * nothing except this file's own subjects.
   *
   * Migration 0010 gates the request-until columns on
   * `group.settings.administer`, which the `scheduler` role does not carry — so
   * the key is GRANTED for the write and revoked immediately after, which is the
   * production mechanism (SPEC-06 L4.2) rather than a fixture that leaves a
   * scheduler holding a settings key for the rest of the file. */
  const settingsGrantId = await grantToScheduler('group.settings.administer');
  await asScheduler(
    async ({ query }) =>
      await sql`
        update groups
           set request_until_mode = ${'fixed_date'},
               request_until_date = ${'2099-12-31'}::date,
               request_until_lead_days = ${null},
               deadline_rolls = ${'exact'},
               late_submission_policy = ${'reject'}
         where id = ${alpha.groupOne.id}::uuid
      `.execute(query),
  );
  await revokeGrant(settingsGrantId);

  commitGrantId = await grantToScheduler('vacation.commit');
  overrideGrantId = await grantToScheduler('vacation.override_quota');

  quotaPeriodId = await createPeriod(QUOTA_START, 'quota');
  openPeriodId = await createPeriod(OPEN_START, 'open');
  await createEntitlement(quotaPeriodId, 4);

  /* The OFF shift type. `is_leave_of_absence` is migration 0005's flag (ADM-07)
   * and it is what a vacation day IS; a group with none gets
   * `COMMIT_NO_OFF_SHIFT_TYPE`, which is proven in its own case below. */
  offShiftTypeId = await asScheduler(async ({ query }) => {
    const inserted = await sql<{ id: string }>`
      insert into shift_types
        (id, organization_id, group_id, code, name, start_time, end_time,
         is_leave_of_absence, include_in_statistics)
      values (${randomUUID()}::uuid, ${alpha.organizationId}::uuid, ${alpha.groupOne.id}::uuid,
              ${'VAC'}, ${'Vacation day'}, ${'00:00:00'}::time, ${'23:59:00'}::time,
              ${true}, ${false})
      returning id
    `.execute(query);
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('the fixture OFF shift type was not created');
    return id;
  });

  /* A PUBLISHED version in the quota round's own schedule period. It is what
   * proves §5.6's draft-only rule BY NAME rather than by whatever constraint
   * fires first — a published version elsewhere would be refused for the period
   * mismatch instead, which is the wrong reason. */
  schedulePeriodId = SCHEDULE_PERIOD_BY_ROUND.get(quotaPeriodId) ?? '';
  draftVersionId = draftFor(quotaPeriodId);
  publishedVersionId = randomUUID();
  await asScheduler(async ({ query }) => {
    await sql`
      insert into schedule_versions
        (id, organization_id, group_id, period_id, state, version_number, published_at, published_by)
      values (${publishedVersionId}::uuid, ${alpha.organizationId}::uuid,
              ${alpha.groupOne.id}::uuid, ${schedulePeriodId}::uuid, ${'published'}, 1,
              now(), ${alpha.users.scheduler.membershipId}::uuid)
    `.execute(query);
  });
}, 300_000);

afterAll(async () => {
  await admin?.end();
  await harness?.close();
  await runtime?.destroy();
});

describe('SPEC-08 §5.6 — the commit', () => {
  it('R-12 — a replayed key commits ONCE and the replay writes nothing', async () => {
    const week = weekOf(quotaPeriodId, 0);
    await approvedWeek(quotaPeriodId, week);

    const idempotencyKey = key('vc.r12');
    const first = await call(
      'POST',
      `${scope()}/vacation/rounds/${quotaPeriodId}/commit`,
      multi().alpha.users.scheduler.id,
      { targetVersionId: draftVersionId, idempotencyKey },
    );
    expect(first.statusCode, first.raw).toBe(200);
    const firstBody = first.body as {
      committedSelectionIds: string[];
      assignmentsCreated: number;
      replayed: boolean;
    };
    expect(firstBody.replayed).toBe(false);
    expect(firstBody.committedSelectionIds).toHaveLength(1);
    /* Five OFF snapshots — Monday to Friday, `vacationWeekDates`'s five, which is
     * the same function §6's projection expands with. */
    expect(firstBody.assignmentsCreated).toBe(5);

    const afterFirst = await offSnapshots(draftVersionId);
    expect(afterFirst.n).toBe(5);
    /* The fifth origin value, on the rows that made it necessary. */
    expect(new Set(afterFirst.origins)).toEqual(new Set(['vacation_commit']));
    expect(await ledgerRows(idempotencyKey)).toBe(1);

    /* THE REPLAY. Same key, same body. R-12: "one commit". */
    const second = await call(
      'POST',
      `${scope()}/vacation/rounds/${quotaPeriodId}/commit`,
      multi().alpha.users.scheduler.id,
      { targetVersionId: draftVersionId, idempotencyKey },
    );
    expect(second.statusCode, second.raw).toBe(200);
    const secondBody = second.body as {
      committedSelectionIds: string[];
      assignmentsCreated: number;
      replayed: boolean;
    };
    expect(secondBody.replayed, 'the second call must be a REPLAY').toBe(true);
    /* Nothing written the second time: no snapshot, no ledger row. The recorded
     * outcome is returned, which is the same selection list. */
    expect(secondBody.assignmentsCreated).toBe(0);
    expect(secondBody.committedSelectionIds).toEqual(firstBody.committedSelectionIds);
    expect(await offSnapshots(draftVersionId)).toEqual(afterFirst);
    expect(await ledgerRows(idempotencyKey), 'exactly ONE ledger row (FAD-59)').toBe(1);
  });

  it('the selection and its root move together — §5.3, one transaction', async () => {
    const week = weekOf(quotaPeriodId, 1);
    const { requestId } = await approvedWeek(quotaPeriodId, week);

    const before = await selectionOf(requestId);
    expect(before.status).toBe('approved');
    expect(before.committed_to_version_id).toBeNull();

    const committed = await call(
      'POST',
      `${scope()}/vacation/rounds/${quotaPeriodId}/commit`,
      multi().alpha.users.scheduler.id,
      { targetVersionId: draftVersionId, idempotencyKey: key('vc.pair') },
    );
    expect(committed.statusCode, committed.raw).toBe(200);

    const after = await selectionOf(requestId);
    expect(after.status).toBe('committed');
    expect(after.committed_to_version_id).toBe(draftVersionId);
    /* §5.3's derived root status, in the SAME transaction. D-27 would have
     * refused the commit at COMMIT time if these two had come apart. */
    expect((await rootOf(requestId)).status).toBe('reflected_in_version');
  });

  it('committing into a PUBLISHED version is refused BY NAME — I-18', async () => {
    await approvedWeek(quotaPeriodId, weekOf(quotaPeriodId, 2));

    const refused = await call(
      'POST',
      `${scope()}/vacation/rounds/${quotaPeriodId}/commit`,
      multi().alpha.users.scheduler.id,
      { targetVersionId: publishedVersionId, idempotencyKey: key('vc.pub') },
    );
    expect(refused.statusCode, refused.raw).toBe(409);
    expect((refused.body as { error: { code: string } }).error.code).toBe(
      'COMMIT_TARGET_NOT_DRAFT',
    );

    /* Nothing was written into the published version — the property I-18 is
     * about, measured rather than assumed. */
    expect((await offSnapshots(publishedVersionId)).n).toBe(0);
  });

  it('a round with no approved selection is refused, not silently successful', async () => {
    const emptyRound = await createPeriod('2083-06-07', 'quota');
    const refused = await call(
      'POST',
      `${scope()}/vacation/rounds/${emptyRound}/commit`,
      multi().alpha.users.scheduler.id,
      { targetVersionId: draftFor(emptyRound), idempotencyKey: key('vc.empty') },
    );
    expect(refused.statusCode, refused.raw).toBe(409);
    expect((refused.body as { error: { code: string } }).error.code).toBe(
      'COMMIT_NOTHING_TO_COMMIT',
    );
  });

  it('I-02 — `vacation.commit` is grant-only; without it the scheduler is refused', async () => {
    /* The deny-by-default case, measured with the grant genuinely removed and
     * then restored — so the 403 cannot be an accident of the fixture and the
     * success afterwards is the FAD-15 positive control. */
    await approvedWeek(quotaPeriodId, weekOf(quotaPeriodId, 3));
    await revokeGrant(commitGrantId);

    const denied = await call(
      'POST',
      `${scope()}/vacation/rounds/${quotaPeriodId}/commit`,
      multi().alpha.users.scheduler.id,
      { targetVersionId: draftVersionId, idempotencyKey: key('vc.deny') },
    );
    expect([403, 404], denied.raw).toContain(denied.statusCode);

    commitGrantId = await grantToScheduler('vacation.commit');
    const allowed = await call(
      'POST',
      `${scope()}/vacation/rounds/${quotaPeriodId}/commit`,
      multi().alpha.users.scheduler.id,
      { targetVersionId: draftVersionId, idempotencyKey: key('vc.allow') },
    );
    expect(allowed.statusCode, allowed.raw).toBe(200);
  });
});

describe('SPEC-08 §5.6 — the reversal', () => {
  it('R-20 + R-10 — an override reversal decrements BOTH counters and raises a revision', async () => {
    /* An entitlement of ZERO, so the approval must take §5.5's audited override
     * path and RAISE the bound. Reversing it must lower the bound back, or "an
     * override cannot silently persist as headroom for a later approval" is
     * false. */
    const overrideRound = await createPeriod('2084-06-05', 'quota');
    const zeroGrant = await createEntitlement(overrideRound, 0);
    const { requestId } = await approvedWeek(overrideRound, weekOf(overrideRound, 0), {
      overrideReason: 'Round agreed at the group meeting.',
    });

    const afterApproval = await grantCounters(zeroGrant);
    expect(afterApproval).toMatchObject({ units_total: 0, units_consumed: 1, override_units: 1 });

    const committed = await call(
      'POST',
      `${scope()}/vacation/rounds/${overrideRound}/commit`,
      multi().alpha.users.scheduler.id,
      { targetVersionId: draftFor(overrideRound), idempotencyKey: key('vc.ovr') },
    );
    expect(committed.statusCode, committed.raw).toBe(200);

    const selection = await selectionOf(requestId);
    expect(selection.status).toBe('committed');

    const reversed = await call(
      'POST',
      `${scope()}/vacation/selections/${selection.id}/reverse`,
      multi().alpha.users.scheduler.id,
      { reason: 'The unit is covered by the other rota this week.' },
    );
    expect(reversed.statusCode, reversed.raw).toBe(200);
    expect(reversed.body).toMatchObject({ unitReleased: true, revisionRequested: true });

    /* R-20: BOTH counters fall, together. */
    expect(await grantCounters(zeroGrant)).toMatchObject({
      units_total: 0,
      units_consumed: 0,
      override_units: 0,
    });

    /* R-10's composition: the root is `reversed` and carries the revision flag,
     * and the version it was committed to is UNTOUCHED — §5.6 raises a revision
     * request rather than editing a published version (I-18). */
    const root = await rootOf(requestId);
    expect(root.status).toBe('reversed');
    /* The revision request is the EVENT, not §4's withdrawal FLAG — migration
     * 0023's `app_guard_request_revision_requested` admits the flag only on
     * `reflected_in_version → withdrawn`, and the narrower reading is taken (see
     * `vacation-commit.ts`'s header). So the column stays false and the two
     * events are what a scheduler acts on. */
    expect(root.revision_requested).toBe(false);
    const revisionAudits = await admin.query<{ n: string }>(
      `select count(*)::text as n from audit_events
        where event_name = 'requests.request.revision_requested'
          and subject_id = $1::uuid`,
      [requestId],
    );
    expect(
      Number(revisionAudits.rows[0]?.n ?? '0'),
      'the reversal must raise a revision request',
    ).toBe(1);
    const revisionOutbox = await admin.query<{ n: string }>(
      `select count(*)::text as n from outbox_events where kind = 'schedule.revision_requested'`,
    );
    expect(Number(revisionOutbox.rows[0]?.n ?? '0')).toBeGreaterThan(0);

    /* FAD-59's CHECK is an equality, so a `reversed` row cannot keep the version
     * id — recorded in 0027's header §5, measured here. */
    const after = await selectionOf(requestId);
    expect(after.status).toBe('reversed');
    expect(after.committed_to_version_id).toBeNull();
    /* The OFF snapshots STAY. Nothing about the schedule is edited by a
     * reversal; the scheduler acts on the revision request. */
    expect((await offSnapshots(draftFor(overrideRound))).n).toBeGreaterThan(0);
  });

  it('R-08 — the floor is the database\'s: a reversal below zero is a data error', async () => {
    /* §5.5 verbatim: "a reversal that would go below zero is rejected as a data
     * error", not clamped. The CHECK is unconditional and refuses the ROW, which
     * is what makes the rule true on paths that never called the service.
     *
     * Driven as a direct UPDATE, because the SERVICE cannot reach this state —
     * it releases exactly one unit for a selection that consumed one. That is
     * R-21's shape applied to the reversal direction, and the refusal is the
     * property R-08 asks for. */
    const floorRound = await createPeriod('2085-06-04', 'quota');
    const floorGrant = await createEntitlement(floorRound, 2);

    await expect(
      asScheduler(
        async ({ query }) =>
          await sql`
            update vacation_grants set units_consumed = units_consumed - 1
             where id = ${floorGrant}::uuid
          `.execute(query),
      ),
      'a reversal below zero must be REJECTED, never clamped',
    ).rejects.toMatchObject({ code: '23514' });

    expect(await grantCounters(floorGrant)).toMatchObject({ units_consumed: 0 });
  });

  it('the reversal REQUIRES the override capability, and refuses without it', async () => {
    const round = await createPeriod('2086-06-03', 'quota');
    await createEntitlement(round, 2);
    const { requestId } = await approvedWeek(round, weekOf(round, 1));
    const committed = await call(
      'POST',
      `${scope()}/vacation/rounds/${round}/commit`,
      multi().alpha.users.scheduler.id,
      { targetVersionId: draftFor(round), idempotencyKey: key('vc.cap') },
    );
    expect(committed.statusCode, committed.raw).toBe(200);
    const selection = await selectionOf(requestId);

    await revokeGrant(overrideGrantId);
    const denied = await call(
      'POST',
      `${scope()}/vacation/selections/${selection.id}/reverse`,
      multi().alpha.users.scheduler.id,
      { reason: 'Cover was found on the other rota.' },
    );
    expect(denied.statusCode, denied.raw).toBe(403);
    expect((denied.body as { error: { code: string } }).error.code).toBe(
      'REVERSAL_OVERRIDE_REQUIRED',
    );
    /* Nothing moved. */
    expect((await selectionOf(requestId)).status).toBe('committed');

    /* FAD-15's positive control: the SAME call with the capability restored
     * succeeds, so the 403 above can only be the capability. */
    overrideGrantId = await grantToScheduler('vacation.override_quota');
    const allowed = await call(
      'POST',
      `${scope()}/vacation/selections/${selection.id}/reverse`,
      multi().alpha.users.scheduler.id,
      { reason: 'Cover was found on the other rota.' },
    );
    expect(allowed.statusCode, allowed.raw).toBe(200);
    expect((await selectionOf(requestId)).status).toBe('reversed');
  });

  it('the mandatory reason is refused at the WIRE — §5.6, three layers, first one', async () => {
    const round = await createPeriod('2087-06-02', 'quota');
    await createEntitlement(round, 2);
    const { requestId } = await approvedWeek(round, weekOf(round, 1));
    await call(
      'POST',
      `${scope()}/vacation/rounds/${round}/commit`,
      multi().alpha.users.scheduler.id,
      { targetVersionId: draftFor(round), idempotencyKey: key('vc.reason') },
    );
    const selection = await selectionOf(requestId);

    for (const body of [{}, { reason: '' }, { reason: '   ' }]) {
      const refused = await call(
        'POST',
        `${scope()}/vacation/selections/${selection.id}/reverse`,
        multi().alpha.users.scheduler.id,
        body,
      );
      expect(refused.statusCode, refused.raw).toBe(422);
    }
    /* Nothing moved through any of the three. */
    expect((await selectionOf(requestId)).status).toBe('committed');
  });

  it('open mode releases NOTHING, by the same branch §5.4 uses (V-30)', async () => {
    /* No grant row exists in open mode, so `unitReleased` is false and no
     * statement touched `vacation_grants` — the branch, proven from the reversal
     * side rather than assumed from the approval side. */
    const { requestId } = await approvedWeek(openPeriodId, weekOf(openPeriodId, 1));
    const committed = await call(
      'POST',
      `${scope()}/vacation/rounds/${openPeriodId}/commit`,
      multi().alpha.users.scheduler.id,
      { targetVersionId: draftFor(openPeriodId), idempotencyKey: key('vc.open') },
    );
    expect(committed.statusCode, committed.raw).toBe(200);
    const selection = await selectionOf(requestId);
    expect(selection.grant_id, 'open mode leaves grant_id null (V-30)').toBeNull();

    const reversed = await call(
      'POST',
      `${scope()}/vacation/selections/${selection.id}/reverse`,
      multi().alpha.users.scheduler.id,
      { reason: 'The round was re-planned after the meeting.' },
    );
    expect(reversed.statusCode, reversed.raw).toBe(200);
    expect(reversed.body).toMatchObject({ unitReleased: false, revisionRequested: true });
  });

  it('a selection that was never committed cannot be reversed', async () => {
    const round = await createPeriod('2088-06-07', 'quota');
    await createEntitlement(round, 2);
    const { requestId } = await approvedWeek(round, weekOf(round, 1));
    const selection = await selectionOf(requestId);

    const refused = await call(
      'POST',
      `${scope()}/vacation/selections/${selection.id}/reverse`,
      multi().alpha.users.scheduler.id,
      { reason: 'Nothing to take back.' },
    );
    expect(refused.statusCode, refused.raw).toBe(409);
    expect((refused.body as { error: { code: string } }).error.code).toBe(
      'REVERSAL_SELECTION_NOT_COMMITTED',
    );
    expect((await selectionOf(requestId)).status).toBe('approved');
  });

  it('the reversal reason reaches NO audit payload and NO outbox row — I-07', async () => {
    const round = await createPeriod('2089-06-05', 'quota');
    await createEntitlement(round, 2);
    const { requestId } = await approvedWeek(round, weekOf(round, 1));
    await call(
      'POST',
      `${scope()}/vacation/rounds/${round}/commit`,
      multi().alpha.users.scheduler.id,
      { targetVersionId: draftFor(round), idempotencyKey: key('vc.i07') },
    );
    const selection = await selectionOf(requestId);

    const distinctive = 'Ward cover was rearranged at the planning meeting.';
    const reversed = await call(
      'POST',
      `${scope()}/vacation/selections/${selection.id}/reverse`,
      multi().alpha.users.scheduler.id,
      { reason: distinctive },
    );
    expect(reversed.statusCode, reversed.raw).toBe(200);

    /* Non-vacuity FIRST: the reason IS on the row it belongs on, so the absences
     * below are absences rather than a reason that was never stored. */
    expect((await selectionOf(requestId)).override_reason).toBe(distinctive);

    const audits = await admin.query<{ n: string }>(
      `select count(*)::text as n from audit_events where payload::text like $1`,
      [`%${distinctive.slice(0, 20)}%`],
    );
    expect(Number(audits.rows[0]?.n ?? '0'), 'no audit payload carries the reason').toBe(0);

    const outbox = await admin.query<{ n: string }>(
      `select count(*)::text as n from outbox_events where payload::text like $1`,
      [`%${distinctive.slice(0, 20)}%`],
    );
    expect(Number(outbox.rows[0]?.n ?? '0'), 'no outbox row carries the reason').toBe(0);

    /* And the audit chain DOES record that a reason was required and supplied —
     * the M5-002 posture: THAT one was given, never WHICH. */
    const flagged = await admin.query<{ n: string }>(
      `select count(*)::text as n from audit_events
        where event_name = 'requests.vacation_selection.reversed'
          and payload->>'reasonGiven' = 'true'`,
    );
    expect(Number(flagged.rows[0]?.n ?? '0')).toBeGreaterThan(0);
  });
});
