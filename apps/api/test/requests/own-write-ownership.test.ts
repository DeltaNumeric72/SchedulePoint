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
 * **§4's "requester-initiated only", on every route that writes a row BY ID
 * from an own-scoped surface** (OPUS-M5-003, found while proving doc 42 §5f's
 * vacation withdrawal).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## The class, and why neither control anybody would name closes it
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * SPEC-08 §4: *"**Withdraw** — **Requester-initiated only.** An administrator
 * 'withdrawing' for someone is a **denial with a reason**, recorded as such."*
 *
 * Two controls are usually cited for that rule, and BOTH are individually
 * correct while their COMPOSITION leaves it undefended:
 *
 *  1. **`ownershipRequired: true` with no override.** SPEC-06 L5.1 compares a
 *     TARGET's owner to the acting membership — and every route on a self-scoped
 *     surface names the ACTING MEMBERSHIP as its own target, because there is no
 *     subject in its path. `requests.route.ts` says so in as many words and calls
 *     it "what makes the declaration have consequences". So on these routes L5.1
 *     passes BY CONSTRUCTION and cannot be the control that decides whose row
 *     this is. (The one route where it genuinely decides is
 *     `context-probe/targets/:targetMembershipId`, which names a real subject.)
 *  2. **Migration 0023's `_own` policy.** It is not the only arm.
 *     `requests_group_administration` and
 *     `vacation_selections_group_administration` are `FOR ALL` behind
 *     `requests.administer` — and 0023 is explicit that this is the design:
 *     *"RLS decides which ROWS, never which OPERATIONS."*
 *
 * **So the operation-layer ownership predicate is the only place §4's rule can
 * live**, and on the two routes in this class it was absent. This file is the
 * class's control: for each one, a COLLEAGUE's row answers `404` and the OWNER's
 * still works.
 *
 * ## The FAD-57 interaction, stated in both directions
 *
 * The defect PREDATES FAD-57: any membership holding an explicit
 * `requests.administer` grant reached these routes identically, and such grants
 * existed from M5-001. FAD-57 (M5-H) made `requests.administer` role-implied for
 * `scheduler`, which WIDENED the exposed population from "whoever was granted it"
 * to "every scheduler". Both are true and neither is the other's excuse.
 *
 * ## The SWEEP — the class closes by enumeration, not by the instances found
 *
 * Every route declaring `ownershipRequired: true`, and what it does:
 *
 * | Route | Method | Names a subject? | In class |
 * |---|---|---|---|
 * | `POST …/requests` | write | no id — the row is created | no |
 * | `POST …/requests/:requestId/withdraw` | write | by id | **YES** |
 * | `GET …/requests/mine` · `GET …/requests/deadline` | read | — | no |
 * | `GET …/published-schedule/members/:membershipId` | read | — | no |
 * | `GET …/vacation/rounds` · `GET …/vacation/rounds/:periodId` | read | — | no |
 * | `POST …/vacation/selections/:selectionId/withdraw` | write | by id | **YES** |
 * | `POST …/context-probe/targets/:targetMembershipId` | write | **a real subject** | no — L5.1 genuinely decides it |
 *
 * Reads are deliberately out: a member's read is row-scoped by RLS, and a
 * scheduler reading a colleague's row rides `requests.read_any`, which is a
 * granted power rather than an accident.
 *
 * ## Synthetic only
 *
 * Every date is far-future and every label is the fixture's own. No
 * organization, site or person name from the research appears here.
 */

const multi = ownedMulti('requests-own-write-ownership', { profile: 'full' });

let harness: HttpHarness;
let runtime: Runtime;
let admin: pg.Client;
let periodId: string;

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

/** A time-off request the MEMBER owns, submitted through the real route. */
async function memberTimeOff(targetDate: string): Promise<{ id: string; version: number }> {
  const reply = await call('POST', `${scope()}/requests`, multi().alpha.users.member.id, {
    idempotencyKey: `own.${randomUUID().slice(0, 12)}`,
    record: { subtype: 'time-off', targetDate },
  });
  if (reply.statusCode !== 201) throw new Error(`the fixture submission failed: ${reply.raw}`);
  const root = (reply.body as { root: { id: string; version: number } }).root;
  return { id: root.id, version: root.version };
}

/** A vacation week the MEMBER owns, submitted through the real route. */
async function memberVacationWeek(
  weekStart: string,
): Promise<{ selectionId: string; version: number }> {
  const reply = await call('POST', `${scope()}/requests`, multi().alpha.users.member.id, {
    idempotencyKey: `ownvac.${randomUUID().slice(0, 12)}`,
    record: { subtype: 'vacation-selection', vacationPeriodId: periodId, weekStart },
  });
  if (reply.statusCode !== 201) throw new Error(`the fixture selection failed: ${reply.raw}`);
  const requestId = (reply.body as { root: { id: string } }).root.id;
  const found = await admin.query<{ id: string; version: number }>(
    'select id, version from vacation_selections where request_id = $1::uuid',
    [requestId],
  );
  const row = found.rows[0];
  if (row === undefined) throw new Error('the fixture selection is missing');
  return { selectionId: row.id, version: row.version };
}

async function requestStatus(requestId: string): Promise<string> {
  const result = await admin.query<{ status: string }>(
    'select status from requests where id = $1::uuid',
    [requestId],
  );
  return result.rows[0]?.status ?? 'missing';
}

async function selectionStatus(selectionId: string): Promise<string> {
  const result = await admin.query<{ status: string }>(
    'select status from vacation_selections where id = $1::uuid',
    [selectionId],
  );
  return result.rows[0]?.status ?? 'missing';
}

const PERIOD_START = '2081-06-02';

beforeAll(async () => {
  harness = await buildHttpHarness();
  runtime = createRuntime('app_runtime', { max: 3 });
  admin = adminClient();
  await admin.connect();

  const alpha = multi().alpha;
  await entitleRequestsModule(runtime.runner, {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    organizationAdminMembershipId: alpha.users.organizationAdmin.membershipId,
  });

  /* §3's window, open, written by the GROUP ADMINISTRATOR — the same setup and
   * the same reason `member-submit-role-implication.test.ts` records: granting
   * the settings key to the member would make "a grantless member" a sentence
   * somebody has to qualify. */
  const groupAdmin = alpha.full?.groupAdmin;
  if (groupAdmin === undefined) throw new Error('the full profile did not provision a group admin');
  await runtime.runner.run(
    {
      organizationId: alpha.organizationId,
      groupId: alpha.groupOne.id,
      membershipId: groupAdmin.membershipId,
      correlationId: 'own-write-window',
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

  periodId = await runtime.runner.run(
    {
      organizationId: alpha.organizationId,
      groupId: alpha.groupOne.id,
      membershipId: alpha.users.scheduler.membershipId,
      correlationId: 'own-write-period',
    },
    async ({ query }) => {
      const inserted = await sql<{ id: string }>`
        insert into vacation_periods
          (organization_id, group_id, start_date, end_date, mode, state)
        values (${alpha.organizationId}::uuid, ${alpha.groupOne.id}::uuid,
                ${PERIOD_START}::date, (${PERIOD_START}::date + 25::integer)::date,
                ${'open'}, ${'open'})
        returning id
      `.execute(query);
      const id = inserted.rows[0]?.id;
      if (id === undefined) throw new Error('the fixture period was not inserted');
      return id;
    },
  );
}, 300_000);

afterAll(async () => {
  await harness?.close();
  await runtime?.destroy();
  await admin?.end();
});

describe('§4 — a SCHEDULER cannot withdraw a colleague’s request', () => {
  it('the OWNER’s withdrawal still works — the control that makes the refusal mean something', async () => {
    /* FAD-15: a deny test whose subject cannot be withdrawn by anybody denies for
     * the wrong reason and passes anyway. This is the same route, the same body
     * shape and the same row class, succeeding for the person §4 says may act. */
    const request = await memberTimeOff('2081-09-01');
    const reply = await call(
      'POST',
      `${scope()}/requests/${request.id}/withdraw`,
      multi().alpha.users.member.id,
      { expectedVersion: request.version },
    );
    expect(reply.statusCode, reply.raw).toBe(200);
    expect(await requestStatus(request.id)).toBe('withdrawn');
  }, 180_000);

  it('a scheduler withdrawing a MEMBER’s time-off request is refused, and nothing moves', async () => {
    /* The neighbour of the vacation case, verified by MEASUREMENT rather than by
     * reading the code: before the cure this call answered 200 and moved the row
     * to `withdrawn`. §4 says an administrator ending somebody's request is a
     * DENIAL with a reason — `POST …/:requestId/deny`, under `requests.deny`,
     * which M5-002 ships and which this refusal leaves as the only door. */
    const request = await memberTimeOff('2081-09-08');

    const reply = await call(
      'POST',
      `${scope()}/requests/${request.id}/withdraw`,
      multi().alpha.users.scheduler.id,
      { expectedVersion: request.version },
    );
    expect(reply.statusCode, reply.raw).toBe(404);
    expect(await requestStatus(request.id), 'the row must not have moved').toBe('submitted');
  }, 180_000);

  it('a scheduler withdrawing a MEMBER’s vacation week is refused, and nothing moves', async () => {
    const selection = await memberVacationWeek(PERIOD_START);

    const reply = await call(
      'POST',
      `${scope()}/vacation/selections/${selection.selectionId}/withdraw`,
      multi().alpha.users.scheduler.id,
      { expectedSelectionVersion: selection.version },
    );
    expect(reply.statusCode, reply.raw).toBe(404);
    expect(await selectionStatus(selection.selectionId), 'the row must not have moved').toBe(
      'pending',
    );
  }, 180_000);

  it('the OWNER’s vacation withdrawal still works', async () => {
    const selection = await memberVacationWeek(
      new Date(Date.parse(`${PERIOD_START}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10),
    );
    const reply = await call(
      'POST',
      `${scope()}/vacation/selections/${selection.selectionId}/withdraw`,
      multi().alpha.users.member.id,
      { expectedSelectionVersion: selection.version },
    );
    expect(reply.statusCode, reply.raw).toBe(200);
    expect(await selectionStatus(selection.selectionId)).toBe('withdrawn');
  }, 180_000);

  it('the scheduler’s legitimate door is still open — a DENIAL with a reason (§4)', async () => {
    /* The refusals above must not have removed the power §4 DOES give an
     * administrator. If they had, the cure would be a narrowing rather than a
     * conformance fix, and this is the assertion that tells the two apart. */
    const request = await memberTimeOff('2081-09-15');
    const reply = await call(
      'POST',
      `${scope()}/requests/${request.id}/deny`,
      multi().alpha.users.scheduler.id,
      { expectedVersion: request.version, reason: 'The department is short-staffed that week.' },
    );
    expect(reply.statusCode, reply.raw).toBe(200);
    expect(await requestStatus(request.id)).toBe('denied');
  }, 180_000);
});
