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
 * **The SCHEDULER's vacation-round read, driven over HTTP** (OPUS-M5-005; the
 * one route doc 42 §5j was amended in-round to authorise).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## What this file owns
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * | Claim | How it is proven here, and what breaks it |
 * |---|---|
 * | the route serves the `'period'` scope, not `'own'` | the SCHEDULER reads a round in which they have selected NOTHING and sees the MEMBER's week. A route wired to `'own'` answers zero selections and this case fails on the count |
 * | it carries what §5.4 and §5.6 need to name their subject | every field an approval and a reversal must send is asserted PRESENT and non-null by name — `id`, `version`, `status`, `weekStart`, `membershipId` |
 * | narrower-never-wider (condition iii) | asserted on a selection that genuinely HAS an `override_reason` in the database: the string is in the row and NOT in the body, so the omission is a real one rather than an empty case |
 * | FU-36 is structurally satisfied | `isOverride` and `status` arrive in the SAME object, so no surface can render the flag without its disambiguator |
 * | I-02, deny-by-default (FU-29's second direction) | a MEMBER is refused, and the same member succeeds on their OWN round read in the same test — so the refusal is the capability and not a broken URL |
 * | R-15 stays checkable at the wire | `rootStatus` and the selection's own `status` both arrive, so a consumer can verify the derivation instead of trusting it |
 *
 * ## FAD-15 vacuity discipline
 *
 * Every refusal below sits beside the SAME shape succeeding. The member's `403`
 * is measured in the same case as that member's own successful round read, and
 * the scheduler's success is measured against a round the scheduler has no
 * selection in — so neither result can be an accident of the fixture.
 *
 * ## Why the deny direction uses a MEMBER rather than a revoked grant
 *
 * `requests.read_any` is ROLE-implied for `scheduler` and deliberately absent
 * from `member` (`SYSTEM_ROLE_CAPABILITIES`, and the reasoning recorded at
 * `cross-product.ts` — reading a colleague's request is doc 08 §6's "Approve
 * requests/vacation" row, where Member is `—`). So the honest deny case is the
 * role the document denies, not a grant this file removes: revoking something
 * the member never held would prove nothing.
 *
 * ## Own fixture per case
 *
 * One round per case, for the reason `vacation-commit-http.test.ts` records and
 * FU-32 cured in its neighbour: a round is shared state, `--sequence.shuffle`
 * shuffles cases, and a count assertion over a shared round depends on which ran
 * first. Every case below creates its own round from its own far-future Monday.
 *
 * ## Synthetic only
 *
 * Every date is far-future, every label is this file's own, and the one override
 * reason below is administrative and non-clinical. No organization, site or
 * person name from the research appears here.
 */

const multi = ownedMulti('requests-vacation-round-scheduler-read', {
  profile: 'core',
  seed: { catalogue: ['alpha'] },
});

let harness: HttpHarness;
let runtime: Runtime;
let admin: pg.Client;

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

/** The Monday on or after `date` — both round starts and weeks must be Mondays. */
function mondayOnOrAfter(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  const shift = (8 - value.getUTCDay()) % 7;
  value.setUTCDate(value.getUTCDate() + shift);
  return value.toISOString().slice(0, 10);
}

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
      correlationId: `round-read-${randomUUID().slice(0, 8)}`,
    },
    fn,
  );
};

async function grantToScheduler(capabilityKey: string): Promise<string> {
  const alpha = multi().alpha;
  const id = randomUUID();
  await runtime.runner.run(
    {
      organizationId: alpha.organizationId,
      groupId: null,
      membershipId: alpha.users.organizationAdmin.membershipId,
      correlationId: `round-read-grant-${randomUUID().slice(0, 8)}`,
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

async function revokeGrant(grantId: string): Promise<void> {
  await admin.query('delete from capability_grants where id = $1::uuid', [grantId]);
}

const START_BY_ROUND = new Map<string, string>();

/** A quota round of this case's own, with an entitlement for the MEMBER. */
async function ownQuotaRound(rawStart: string, units = 4): Promise<string> {
  const alpha = multi().alpha;
  const startDate = mondayOnOrAfter(rawStart);
  const roundId = await asScheduler(async ({ query }) => {
    const inserted = await sql<{ id: string }>`
      insert into vacation_periods
        (organization_id, group_id, start_date, end_date, mode, state)
      values (${alpha.organizationId}::uuid, ${alpha.groupOne.id}::uuid,
              ${startDate}::date, (${startDate}::date + 32)::date, ${'quota'}, ${'open'})
      returning id
    `.execute(query);
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('the fixture round was not created');
    return id;
  });
  START_BY_ROUND.set(roundId, startDate);

  await asScheduler(async ({ query }) => {
    await sql`
      insert into vacation_grants
        (organization_id, group_id, vacation_period_id, kind, membership_id, units_total)
      values (${alpha.organizationId}::uuid, ${alpha.groupOne.id}::uuid,
              ${roundId}::uuid, ${'personal-entitlement'},
              ${alpha.users.member.membershipId}::uuid, ${units}::integer)
    `.execute(query);
  });
  return roundId;
}

function weekOf(roundId: string, n: number): string {
  const start = START_BY_ROUND.get(roundId);
  if (start === undefined) throw new Error('the fixture round has no start date');
  return weekIn(start, n);
}

/** Submit one week AS THE MEMBER, through the real route. */
async function memberSelects(
  roundId: string,
  weekStart: string,
): Promise<{ requestId: string; selectionId: string; version: number }> {
  const submitted = await call('POST', `${scope()}/requests`, multi().alpha.users.member.id, {
    idempotencyKey: key('vrs.sub'),
    record: { subtype: 'vacation-selection', vacationPeriodId: roundId, weekStart },
  });
  if (submitted.statusCode !== 201) {
    throw new Error(`the fixture submission failed: ${submitted.raw}`);
  }
  const requestId = (submitted.body as { root: { id: string } }).root.id;
  const row = await selectionOf(requestId);
  return { requestId, selectionId: row.id, version: row.version };
}

async function selectionOf(requestId: string): Promise<{
  id: string;
  status: string;
  version: number;
  is_override: boolean;
  override_reason: string | null;
}> {
  const result = await admin.query<{
    id: string;
    status: string;
    version: number;
    is_override: boolean;
    override_reason: string | null;
  }>(
    `select id, status, version, is_override, override_reason
       from vacation_selections where request_id = $1::uuid`,
    [requestId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('the selection is missing');
  return row;
}

/** The shape the route answers with, as this file reads it back. */
interface RoundBody {
  readonly period: { readonly id: string; readonly mode: string; readonly state: string };
  readonly selections: readonly {
    readonly selection: {
      readonly id: string;
      readonly membershipId: string;
      readonly weekStart: string;
      readonly status: string;
      readonly version: number;
      readonly isOverride: boolean;
      readonly committedToVersionId: string | null;
    };
    readonly rootStatus: string | null;
    readonly rootVersion: number | null;
  }[];
  readonly variance: readonly unknown[];
}

const schedulerUrl = (roundId: string): string =>
  `${scope()}/vacation/rounds/${roundId}/selections`;

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

  /* §3's window, open on a far-future date, so nothing below is refused by the
   * deadline. Granted for the write and revoked immediately after — the
   * production mechanism, not a scheduler left holding a settings key. */
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

  /* Held for the file's lifetime rather than per case: the override approval
   * below needs it, and revoking it between cases would make the shuffle order
   * matter — the dependence FU-32 cured in this file's neighbour. */
  await grantToScheduler('vacation.override_quota');
}, 300_000);

afterAll(async () => {
  await admin?.end();
  await harness?.close();
  await runtime?.destroy();
});

describe("the scheduler's round read — the 'period' scope reaches a route", () => {
  it("serves EVERY member's selection, which is what makes it 'period' and not 'own'", async () => {
    const round = await ownQuotaRound('2110-06-01');
    const week = weekOf(round, 0);
    const selected = await memberSelects(round, week);

    /* The SCHEDULER has selected nothing in this round. A route wired to
     * `scope: 'own'` would therefore answer zero selections, and this assertion
     * is what tells the two wirings apart — it is the file's discriminating
     * case, not a smoke test. */
    const read = await call('GET', schedulerUrl(round), multi().alpha.users.scheduler.id);
    expect(read.statusCode, read.raw).toBe(200);

    const body = read.body as RoundBody;
    expect(body.selections).toHaveLength(1);
    const view = body.selections[0];
    if (view === undefined) throw new Error('unreachable: length was just asserted');

    /* Every field §5.4's approval and §5.6's reversal must be able to NAME.
     * Asserted individually rather than as one object comparison, so a missing
     * field fails on its own name and the reader of a failure knows which
     * affordance just lost its subject. */
    expect(view.selection.id).toBe(selected.selectionId);
    expect(view.selection.version).toBe(selected.version);
    expect(view.selection.status).toBe('pending');
    expect(view.selection.weekStart).toBe(week);
    expect(view.selection.membershipId).toBe(multi().alpha.users.member.membershipId);
    expect(view.selection.committedToVersionId).toBeNull();

    /* FU-36: the flag and the fact that disambiguates it arrive together. */
    expect(view.selection.isOverride).toBe(false);
    expect(typeof view.selection.status).toBe('string');

    /* R-15 stays checkable rather than trusted: both halves of D-27's pair are
     * on the wire, so a consumer can verify the derivation. */
    expect(view.rootStatus).toBe('submitted');
    expect(view.rootVersion).not.toBeNull();

    /* The round's own facts, which the commit surface needs to target a draft. */
    expect(body.period.id).toBe(round);
    expect(body.period.mode).toBe('quota');
    expect(body.period.state).toBe('open');
  });

  it('condition (iii) — the projection carries NO `overrideReason`, proven on a row that HAS one', async () => {
    /* ZERO units, so the approval below genuinely EXCEEDS the entitlement and
     * §5.5 records the reason. Measured, not assumed: with the default four-unit
     * entitlement the first approval is within allowance, `is_override` stays
     * false, and migration 0022's frozen equality
     * `is_override = (override_reason IS NOT NULL)` therefore stores NO reason —
     * so this case's absence assertion would have passed over a null and proven
     * nothing. That is exactly the vacuity it exists to avoid, and it took a red
     * run to find. */
    const round = await ownQuotaRound('2111-06-01', 0);
    const week = weekOf(round, 1);
    const selected = await memberSelects(round, week);

    /* Approved WITH an override reason, so the string genuinely exists in the
     * database. An assertion of absence over a row where the value was null
     * would pass for the wrong reason — that is the vacuity this case avoids. */
    const reason = 'Approved beyond the entitlement to keep the roster covered.';
    const approved = await call(
      'POST',
      `${scope()}/vacation/selections/${selected.selectionId}/approve`,
      multi().alpha.users.scheduler.id,
      {
        approvalIdempotencyKey: key('vrs.appr'),
        expectedSelectionVersion: selected.version,
        overrideReason: reason,
      },
    );
    expect(approved.statusCode, approved.raw).toBe(200);

    const stored = await selectionOf(selected.requestId);
    expect(stored.override_reason, 'the fixture must genuinely hold the reason').toBe(reason);

    const read = await call('GET', schedulerUrl(round), multi().alpha.users.scheduler.id);
    expect(read.statusCode, read.raw).toBe(200);

    /* The whole body, as a string. A key-by-key check could miss the reason
     * appearing somewhere this file did not think to look. */
    expect(read.raw).not.toContain(reason);
    expect(read.raw).not.toContain('overrideReason');
    /* …and the two neighbouring classes FAD-58 keeps behind their own reads. */
    expect(read.raw).not.toContain('reasonCode');
    expect(read.raw).not.toContain('comments');

    /* Non-vacuity: the row IS in the answer, and its `isOverride` is true — so
     * the assertions above are about a projection that reached this selection
     * rather than about a body that omitted it entirely. */
    const body = read.body as RoundBody;
    const view = body.selections.find((row) => row.selection.id === selected.selectionId);
    expect(
      view,
      'the overridden selection must be present for the absence to mean anything',
    ).toBeDefined();
    expect(view?.selection.isOverride).toBe(true);
    expect(view?.selection.status).toBe('approved');
  });

  it('I-02 — a MEMBER is refused, and the same member reads their OWN round in the same breath', async () => {
    const round = await ownQuotaRound('2112-06-01');
    await memberSelects(round, weekOf(round, 2));

    const denied = await call('GET', schedulerUrl(round), multi().alpha.users.member.id);
    expect([403, 404], denied.raw).toContain(denied.statusCode);

    /* The vacuity control, and it is the whole point of putting it here: the
     * SAME member, the SAME round, one path segment shorter, succeeds. So the
     * refusal above is `requests.read_any` and cannot be a mis-registered route,
     * a missing entitlement, or a fixture that never made the round. */
    const own = await call(
      'GET',
      `${scope()}/vacation/rounds/${round}`,
      multi().alpha.users.member.id,
    );
    expect(own.statusCode, own.raw).toBe(200);
    expect((own.body as RoundBody).selections).toHaveLength(1);
  });

  it('a round that does not exist is 404 for a scheduler who may read rounds', async () => {
    /* Not-found rather than a 500 or an empty round, and measured with a caller
     * who IS authorized — so this case cannot pass by being refused. */
    const missing = await call('GET', schedulerUrl(randomUUID()), multi().alpha.users.scheduler.id);
    expect(missing.statusCode, missing.raw).toBe(404);
  });
});

describe('the round read after a commit — §5.6 reversal can name its subject', () => {
  it('a committed week comes back with its version id, which is what a reversal needs', async () => {
    const round = await ownQuotaRound('2113-06-01');
    const week = weekOf(round, 0);
    const selected = await memberSelects(round, week);

    const approved = await call(
      'POST',
      `${scope()}/vacation/selections/${selected.selectionId}/approve`,
      multi().alpha.users.scheduler.id,
      { approvalIdempotencyKey: key('vrs.ca'), expectedSelectionVersion: selected.version },
    );
    expect(approved.statusCode, approved.raw).toBe(200);

    /* Committed by writing the pair the way §5.6's own edge does, because this
     * file does not own the commit route's fixture chain (a schedule period, a
     * draft version and an OFF shift type). What is under test here is the READ,
     * and the read's claim is that a committed selection arrives carrying the
     * version id a reversal must name. */
    const alpha = multi().alpha;
    const versionId = randomUUID();
    await asScheduler(async ({ query }) => {
      const schedulePeriod = randomUUID();
      const start = START_BY_ROUND.get(round);
      await sql`
        insert into schedule_periods (id, organization_id, group_id, name, start_date, end_date)
        values (${schedulePeriod}::uuid, ${alpha.organizationId}::uuid, ${alpha.groupOne.id}::uuid,
                ${`round-read ${start ?? ''}`}, (${start}::date - 3)::date,
                (${start}::date + 60)::date)
      `.execute(query);
      await sql`
        insert into schedule_versions (id, organization_id, group_id, period_id, state)
        values (${versionId}::uuid, ${alpha.organizationId}::uuid, ${alpha.groupOne.id}::uuid,
                ${schedulePeriod}::uuid, ${'draft'})
      `.execute(query);
    });
    /* ONE transaction for BOTH rows, and that is D-27 rather than tidiness:
     * the mapping is enforced by DEFERRED constraint triggers that fire at
     * COMMIT, so two auto-committed statements make the intermediate pair
     * (`committed` beside `approved`) a state the database refuses — measured,
     * as `VACATION_STATUS_MAPPING_VIOLATED`. §5.6's own commit moves the pair
     * together for the same reason; this fixture reproduces that, and could not
     * have been written any other way. */
    await admin.query('begin');
    try {
      await admin.query(
        `update vacation_selections
            set status = 'committed', committed_to_version_id = $1::uuid, version = version + 1
          where id = $2::uuid`,
        [versionId, selected.selectionId],
      );
      await admin.query(
        `update requests set status = 'reflected_in_version', version = version + 1
          where id = $1::uuid`,
        [selected.requestId],
      );
      await admin.query('commit');
    } catch (error) {
      await admin.query('rollback');
      throw error;
    }

    const read = await call('GET', schedulerUrl(round), multi().alpha.users.scheduler.id);
    expect(read.statusCode, read.raw).toBe(200);
    const view = (read.body as RoundBody).selections.find(
      (row) => row.selection.id === selected.selectionId,
    );
    expect(view?.selection.status).toBe('committed');
    expect(view?.selection.committedToVersionId).toBe(versionId);
    /* And the pair still agrees, so the read did not paper over a state D-27
     * refuses — `readVacationRound` asserts this before it answers. */
    expect(view?.rootStatus).toBe('reflected_in_version');
  });
});
