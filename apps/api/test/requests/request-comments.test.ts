import { randomUUID } from 'node:crypto';

import { SYSTEM_ROLE_CAPABILITIES } from '@schedulepoint/domain';
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
 * **SPEC-08 §4's fifth row — COMMENTS: the FAD-58 reader table, every cell
 * proven positively AND negatively over HTTP** (OPUS-M5-00C, doc 42 §5g).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## The obligation, in FAD-58.4's own words
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * > **Visibility is per capability with an explicit table in the packet**,
 * > derived from §4's own text and doc 08 §6 under narrower-never-wider: the
 * > packet writes the reader table (requester sees their own request's comments;
 * > deciders see the queue's) and proves each cell positively AND negatively over
 * > HTTP; any cell §4 does not force is ruled by escalation, not filled by
 * > convenience.
 *
 * §4 itself says only four things — *"Append-only; author recorded;
 * `SENSITIVE-PII`; visible per capability"* — and names no reader. The governing
 * sentence, ratified for this packet and taken from migration 0024's header §3
 * where it was already shipped for a decision reason:
 *
 * > **A comment is visible exactly where the REQUEST it is on is visible, and no
 * > wider.**
 *
 * That reproduces FAD-58.4's two forced cells and is the narrowest reading that
 * does. The four cells §4 does NOT force were escalated and ruled rather than
 * filled: the requester reads the WHOLE thread on their own request (both
 * channels — 0024's `approvals_own` exists precisely so a denial's reason reaches
 * the person it is for); there is no internal-note class; there is no status
 * gate; and the reason CODE never enters an audit payload.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## THE TABLE, and where each cell is proven
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * | Role (doc 08 §6) | Read own thread | Read a colleague's | Attach a code to own | Attach a code to a colleague's | Append a scheduler comment |
 * |---|---|---|---|---|---|
 * | Member | ✓ | — 404 | ✓ | — 404 | — 403 |
 * | Viewer | — 403 | — 403 | — 403 | — 403 | — 403 |
 * | Telecom | — 403 | — 403 | — 403 | — 403 | — 403 |
 * | Scheduler | ✓ (as requester) | ✓ via the DETAIL read | ✓ own only | — 404 | ✓ |
 * | Group Admin | — 403 | — 403 | — 403 | — 403 | — 403 |
 * | Org Admin | — 404* | — 404* | — 404* | — 404* | — 404* |
 *
 * \* The organization administrator's `—` is enforced ONE LAYER EARLIER than the
 * other three, and the asterisk is there because the difference was MEASURED
 * rather than designed: that membership is organization-scoped, so a
 * group-scoped route resolves no acting membership and answers the single `404`
 * every tenant not-found produces, without ever reaching the capability layer.
 * A stronger refusal, and true of every group-scoped route on this surface long
 * before this packet. See `otherRoles`.
 *
 * **Group Admin and Org Admin are `—` because doc 08 §6's two rows say `—` — the
 * document deciding, not this file.** "Submit requests/vacation" is `✓` for
 * Member and Scheduler only; "Approve requests/vacation" is `✓` for Scheduler
 * only.
 *
 * **The two refusal SHAPES are different and both are correct.** A role that
 * lacks the key is refused at the CAPABILITY layer and gets `403` with
 * `NO_CAPABILITY` — the route was never reached. A member who HOLDS the key but
 * names somebody else's request is refused by the operation-layer ownership
 * predicate and gets `404`, byte-identical to a request that does not exist
 * (X-11: "not yours", "another group's" and "no such id" must be one answer).
 * Asserting the two apart is what stops a `403` produced by something else from
 * satisfying a bare status-code check.
 *
 * ## The by-id-write ownership class (M5-003), third member
 *
 * `POST …/:requestId/reason-codes` is an own-scoped WRITE addressing a row BY
 * ID, and the class's whole finding is that neither control anybody would cite
 * closes it: SPEC-06 L5.1 passes BY CONSTRUCTION on a self-scoped surface (the
 * route names the acting membership as its own target), and RLS decides ROWS
 * rather than OPERATIONS. So the predicate lives in `attachReasonCode`, and every
 * `404` below carries the OWNER's success on the same route with the same body
 * shape beside it — FAD-15: a deny test whose subject nobody can act on denies
 * for the wrong reason and passes anyway.
 *
 * ## Synthetic only
 *
 * Every date is far-future and every label is the fixture's own. No
 * organization, site or person name from the research appears here; the
 * scheduler comments are administrative notes about a synthetic roster, and
 * nothing in them is clinical.
 */

const multi = ownedMulti('requests-comments-http', {
  profile: 'full',
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

function basePath(): string {
  const alpha = multi().alpha;
  return `/organizations/${alpha.organizationId}/groups/${alpha.groupOne.id}/requests`;
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

/**
 * The authorization denial the server logged for the last call, if any.
 *
 * The `decision-authority.test.ts` helper, for the reason that file gives: two
 * writers emit `authorization denied` and the LAST one is the flat line, which
 * carries no layer. The structured object is what names the layer that refused,
 * so a refusal can be shown to come from the capability gate rather than from
 * whatever fired first.
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

/** A time-off request submitted through the REAL route by the named user. */
async function submitFor(userId: string, targetDate: string): Promise<{ id: string; version: number }> {
  const reply = await call('POST', basePath(), userId, {
    idempotencyKey: `cmt.${randomUUID().slice(0, 12)}`,
    record: { subtype: 'time-off', targetDate },
  });
  if (reply.statusCode !== 201) throw new Error(`the fixture submission failed: ${reply.raw}`);
  const root = (reply.body as { root: { id: string; version: number } }).root;
  return { id: root.id, version: root.version };
}

async function commentRows(requestId: string): Promise<
  { channel: string; reason_code: string | null; body: string | null; author: string }[]
> {
  const result = await admin.query<{
    channel: string;
    reason_code: string | null;
    body: string | null;
    author: string;
  }>(
    `select channel, reason_code, body, author_membership_id as author
       from request_comments where request_id = $1::uuid order by created_at, id`,
    [requestId],
  );
  return result.rows;
}

async function rootFacts(requestId: string): Promise<{ status: string; version: number }> {
  const result = await admin.query<{ status: string; version: number }>(
    'select status, version from requests where id = $1::uuid',
    [requestId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('the request is missing');
  return row;
}

const asMember = (): string => multi().alpha.users.member.id;
const asScheduler = (): string => multi().alpha.users.scheduler.id;

/**
 * The four roles doc 08 §6 marks `—` in BOTH rows, and the SHAPE each one's
 * refusal takes.
 *
 * **Three of them are refused at the capability layer and one is refused
 * earlier, and the difference is a fact about the fixture rather than about this
 * packet.** `viewer`, `telecom` and `group_admin` hold memberships in Group One,
 * so a group-scoped route reaches SPEC-06 L4 and answers `403` with
 * `NO_CAPABILITY`. The organization administrator's membership is
 * ORGANIZATION-scoped — `test/support/multi.ts` says so in as many words
 * ("ORGANIZATION membership, role `org_admin`") — so there is no membership in
 * this group to act as, tenant-context verification resolves nothing, and the
 * answer is the single `404` every tenant not-found produces.
 *
 * That is a STRONGER refusal, not a weaker one: it discloses neither that the
 * request exists nor which capability was wanted. It is asserted as what it IS
 * rather than forced into the shape the other three take — a test that expected
 * `403` here would be asserting a fixture detail and would fail the moment
 * somebody gave the organization administrator a group membership, which is a
 * legitimate thing to do and is not this table's business.
 *
 * It is also true of every group-scoped route on this surface and predates this
 * packet; the row's `—` is honoured either way, which is what the table claims.
 */
function otherRoles(): { label: string; userId: string; refusal: 403 | 404 }[] {
  const alpha = multi().alpha;
  const full = alpha.full;
  if (full === undefined) throw new Error('the full profile did not provision the extra roles');
  return [
    { label: 'viewer', userId: full.viewer.id, refusal: 403 },
    { label: 'telecom', userId: full.telecom.id, refusal: 403 },
    { label: 'group_admin', userId: full.groupAdmin.id, refusal: 403 },
    { label: 'organization_admin', userId: alpha.users.organizationAdmin.id, refusal: 404 },
  ];
}

/**
 * Assert one `—` cell: the expected refusal, and — where the capability layer is
 * the one that refused — the refusal's IDENTITY.
 *
 * The identity check is what stops a `403` produced by something else from
 * satisfying a bare status-code assertion. On a `404` there is no denial to
 * name, and requiring one would be asserting that the caller got FURTHER than
 * they did.
 */
function expectRefused(
  reply: Reply,
  role: { label: string; refusal: 403 | 404 },
): void {
  expect(reply.statusCode, `${role.label}: ${reply.raw}`).toBe(role.refusal);
  if (role.refusal === 403) {
    expect(lastDenial()?.['reason'], role.label).toBe('NO_CAPABILITY');
  }
}

beforeAll(async () => {
  harness = await buildHttpHarness();
  runtime = createRuntime('app_runtime', { max: 3 });
  admin = adminClient();
  await admin.connect();

  const alpha = multi().alpha;

  /* Without the module entitled every request route denies at SPEC-06 L1.1 and
   * answers the same way for EVERY role — so every refusal below would be about
   * the entitlement rather than about the role, and every success would be
   * impossible. The M5-002 finding (FU-29's class), cured the way that packet
   * cured it. */
  await entitleRequestsModule(runtime.runner, {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    organizationAdminMembershipId: alpha.users.organizationAdmin.membershipId,
  });

  /* §3's window, open on a far-future fixed date, written by the GROUP
   * ADMINISTRATOR — the `member-submit-role-implication.test.ts` setup and the
   * same reason: granting the settings key to the member would make "a member
   * who was granted nothing" a sentence somebody has to qualify. */
  const groupAdmin = alpha.full?.groupAdmin;
  if (groupAdmin === undefined) throw new Error('the full profile did not provision a group admin');
  await runtime.runner.run(
    {
      organizationId: alpha.organizationId,
      groupId: alpha.groupOne.id,
      membershipId: groupAdmin.membershipId,
      correlationId: 'comments-window',
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
}, 300_000);

afterAll(async () => {
  await harness?.close();
  await runtime?.destroy();
  await admin?.end();
});

/* ════════════════════════════════════════════════════════════════════════════
 * Layer 1 — the role→capability constant follows doc 08 §6
 * ════════════════════════════════════════════════════════════════════════════ */

describe('layer 1 — the two new keys land on exactly the roles doc 08 §6 marks ✓', () => {
  it('`requests.own.comment` is role-implied for member and scheduler', () => {
    /* doc 08 §6 "Submit requests/vacation": Member ✓, Scheduler ✓. Attaching a
     * reason code to one's own request is part of ASKING, not part of deciding —
     * the requester's own statement about their own circumstances, on their own
     * row — so it takes that row's population, exactly as FAD-57 gave the three
     * self-scoped keys theirs. */
    for (const role of ['member', 'scheduler']) {
      expect(SYSTEM_ROLE_CAPABILITIES[role] ?? [], role).toContain('requests.own.comment');
    }
  });

  it('`requests.comment_any` is role-implied for scheduler ALONE', () => {
    /* doc 08 §6 "Approve requests/vacation": Scheduler ✓, everybody else —. */
    expect(SYSTEM_ROLE_CAPABILITIES['scheduler'] ?? []).toContain('requests.comment_any');
  });

  it('every OTHER role holds neither — the rows’ `—` cells, which make the ✓ cells mean something', () => {
    for (const [role, held] of Object.entries(SYSTEM_ROLE_CAPABILITIES)) {
      if (role !== 'member' && role !== 'scheduler') {
        expect(held, `${role} is \`—\` in the submit row`).not.toContain('requests.own.comment');
      }
      if (role !== 'scheduler') {
        expect(held, `${role} is \`—\` in the approve row`).not.toContain('requests.comment_any');
      }
    }
  });

  it('a MEMBER did not acquire the decider channel — implication widened nothing', () => {
    /* Role-implication answers "may this person act at all"; it does not answer
     * "on whose rows". A member holding `requests.own.comment` must not thereby
     * hold the key that reaches a colleague's request. */
    const member = SYSTEM_ROLE_CAPABILITIES['member'] ?? [];
    expect(member).not.toContain('requests.comment_any');
    expect(member).not.toContain('requests.read_any');
    expect(member).not.toContain('requests.administer');
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * Layer 2 — the table, cell by cell, over HTTP
 * ════════════════════════════════════════════════════════════════════════════ */

describe('the MEMBER row of the table', () => {
  it('✓ attaches ONE code to their OWN request — 201, stored on the requester channel', async () => {
    const request = await submitFor(asMember(), '2081-03-03');
    const reply = await call(
      'POST',
      `${basePath()}/${request.id}/reason-codes`,
      asMember(),
      { reasonCode: 'childcare' },
    );
    expect(reply.statusCode, reply.raw).toBe(201);

    const wire = (reply.body as { comment: Record<string, unknown> }).comment;
    expect(wire['channel']).toBe('requester');
    expect(wire['reasonCode']).toBe('childcare');
    expect(wire['body'], 'a requester comment has no body, at any layer').toBeNull();
    expect(wire['authorMembershipId']).toBe(multi().alpha.users.member.membershipId);

    const rows = await commentRows(request.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.channel).toBe('requester');
    expect(rows[0]?.reason_code).toBe('childcare');
    expect(rows[0]?.body).toBeNull();
  }, 180_000);

  it('— 404 on a COLLEAGUE’s request, with the owner’s success as the positive control', async () => {
    /* The by-id-write ownership class. The scheduler's request is a colleague's
     * from the member's side, and the member holds `requests.own.comment` by
     * role — so the refusal can only be the operation-layer predicate. */
    const colleague = await submitFor(asScheduler(), '2081-03-10');

    const refused = await call(
      'POST',
      `${basePath()}/${colleague.id}/reason-codes`,
      asMember(),
      { reasonCode: 'travel' },
    );
    expect(refused.statusCode, refused.raw).toBe(404);
    expect(await commentRows(colleague.id), 'nothing may have been written').toEqual([]);

    /* FAD-15's control: the SAME route, the SAME body shape, succeeding for the
     * person FAD-58.1 says may act. Without it the 404 above could be a route
     * nobody can reach. */
    const own = await submitFor(asMember(), '2081-03-11');
    const allowed = await call(
      'POST',
      `${basePath()}/${own.id}/reason-codes`,
      asMember(),
      { reasonCode: 'travel' },
    );
    expect(allowed.statusCode, allowed.raw).toBe(201);
  }, 180_000);

  it('✓ reads their OWN thread — BOTH channels, which is C-1 ruled and proven', async () => {
    /* There is no internal-note class: §4 names ONE comment surface, and 0024's
     * `approvals_own` exists precisely so a decision's reason reaches the person
     * it is for. A requester therefore sees the scheduler's note on their own
     * request as well as their own code. */
    const request = await submitFor(asMember(), '2081-03-17');
    expect(
      (
        await call('POST', `${basePath()}/${request.id}/reason-codes`, asMember(), {
          reasonCode: 'family',
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await call('POST', `${basePath()}/${request.id}/comments`, asScheduler(), {
          body: 'Noted — the rota already has cover that week.',
        })
      ).statusCode,
    ).toBe(201);

    const reply = await call('GET', `${basePath()}/${request.id}/comments`, asMember());
    expect(reply.statusCode, reply.raw).toBe(200);
    const comments = (reply.body as { comments: Record<string, unknown>[] }).comments;
    expect(
      comments.map((comment) => comment['channel']),
      'the requester must see the whole thread, oldest first',
    ).toEqual(['requester', 'scheduler']);
    expect(comments[1]?.['body']).toBe('Noted — the rota already has cover that week.');
  }, 180_000);

  it('— 404 reading a COLLEAGUE’s thread, with their own read as the control', async () => {
    const colleague = await submitFor(asScheduler(), '2081-03-24');
    const refused = await call('GET', `${basePath()}/${colleague.id}/comments`, asMember());
    expect(refused.statusCode, refused.raw).toBe(404);

    const own = await submitFor(asMember(), '2081-03-25');
    const allowed = await call('GET', `${basePath()}/${own.id}/comments`, asMember());
    expect(allowed.statusCode, allowed.raw).toBe(200);
  }, 180_000);

  it('— 403 NO_CAPABILITY appending a SCHEDULER comment — a member has no decider channel', async () => {
    const own = await submitFor(asMember(), '2081-03-31');
    harness.clearLogs();
    const reply = await call('POST', `${basePath()}/${own.id}/comments`, asMember(), {
      body: 'and here is what I actually meant by that',
    });
    expect(reply.statusCode, reply.raw).toBe(403);
    expect(lastDenial()?.['reason']).toBe('NO_CAPABILITY');
    expect(
      await commentRows(own.id),
      'a member must not reach free text by naming the other route',
    ).toEqual([]);
  }, 180_000);

  it('— 403 on the DETAIL read, which is where deciders see comments', async () => {
    /* The member's own thread is `GET …/:requestId/comments`. The detail read is
     * the DECIDER's door and rides `requests.read_any`, which a member is `—` for
     * in doc 08 §6's approve row. */
    const own = await submitFor(asMember(), '2081-04-07');
    harness.clearLogs();
    const reply = await call('GET', `${basePath()}/${own.id}`, asMember());
    expect(reply.statusCode, reply.raw).toBe(403);
    expect(lastDenial()?.['reason']).toBe('NO_CAPABILITY');
  }, 180_000);
});

describe('the SCHEDULER row of the table', () => {
  it('✓ appends a comment to a MEMBER’s request — 201, on the scheduler channel', async () => {
    const request = await submitFor(asMember(), '2081-04-14');
    const reply = await call('POST', `${basePath()}/${request.id}/comments`, asScheduler(), {
      body: 'The department is short-staffed that week.',
    });
    expect(reply.statusCode, reply.raw).toBe(201);

    const wire = (reply.body as { comment: Record<string, unknown> }).comment;
    expect(wire['channel']).toBe('scheduler');
    expect(wire['reasonCode'], 'a scheduler comment carries no code — the other direction').toBeNull();
    expect(wire['authorMembershipId']).toBe(multi().alpha.users.scheduler.membershipId);
  }, 180_000);

  it('— 404 attaching a CODE to a MEMBER’s request, with their own attach as the control', async () => {
    /* **FAD-58.1's precise prevention, at the operation layer.** A decider
     * attaching a code to somebody else's request would be attributing a
     * circumstance to the person whose request it is. The database refuses it
     * too — migration 0026's administration arm admits only `channel =
     * 'scheduler'`, proven in the populated cycle — so this is the same rule at
     * two layers, and either alone is load-bearing. */
    const colleague = await submitFor(asMember(), '2081-04-21');
    const refused = await call(
      'POST',
      `${basePath()}/${colleague.id}/reason-codes`,
      asScheduler(),
      { reasonCode: 'bereavement' },
    );
    expect(refused.statusCode, refused.raw).toBe(404);
    expect(await commentRows(colleague.id)).toEqual([]);

    /* …and a scheduler CAN attach a code to their OWN request: they are also a
     * person with shifts, and doc 08 §6's submit row is `✓` for them. Without
     * this control the 404 above would be indistinguishable from "schedulers
     * cannot use this route at all". */
    const own = await submitFor(asScheduler(), '2081-04-22');
    const allowed = await call(
      'POST',
      `${basePath()}/${own.id}/reason-codes`,
      asScheduler(),
      { reasonCode: 'education' },
    );
    expect(allowed.statusCode, allowed.raw).toBe(201);
    expect((await commentRows(own.id))[0]?.author).toBe(
      multi().alpha.users.scheduler.membershipId,
    );
  }, 180_000);

  it('✓ reads a MEMBER’s thread through the DETAIL read — FAD-58.4’s second forced cell', async () => {
    const request = await submitFor(asMember(), '2081-04-28');
    expect(
      (
        await call('POST', `${basePath()}/${request.id}/reason-codes`, asMember(), {
          reasonCode: 'personal',
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await call('POST', `${basePath()}/${request.id}/comments`, asScheduler(), {
          body: 'Two colleagues already have that Friday off.',
        })
      ).statusCode,
    ).toBe(201);

    const reply = await call('GET', `${basePath()}/${request.id}`, asScheduler());
    expect(reply.statusCode, reply.raw).toBe(200);
    const detail = reply.body as {
      approvals: unknown[];
      comments: Record<string, unknown>[];
    };
    expect(
      detail.comments.map((comment) => comment['channel']),
      'the decider sees the whole thread beside the decision history',
    ).toEqual(['requester', 'scheduler']);
    expect(detail.comments[0]?.['reasonCode']).toBe('personal');
    expect(Array.isArray(detail.approvals), 'the decision history is still there').toBe(true);
  }, 180_000);

  it('✓ reads their OWN thread, and — 404 on a MEMBER’s: the own-thread route stays OWN-scoped', async () => {
    /* ── The `listOwnComments` ownership predicate, defended by test ───────────
     *
     * Added at review (C-2), which proved by mutation that dropping that
     * predicate's ownership half turned NOTHING red: the scheduler holds
     * `requests.own.read` by role (FAD-57), so the route's declaration admits
     * them, and migration 0026's `request_comments_group_read_any` arm admits
     * the ROWS because they also hold `requests.read_any`. With the predicate
     * dropped the colleague probe answers `200`. Nothing else in the suite
     * noticed.
     *
     * This is the one route on the surface where the ratified table's row and
     * column disagree about the same actor: a scheduler MAY see a colleague's
     * comments — through the DETAIL read, which is the decider's door — and MAY
     * NOT see them through the requester's own-thread door. Control B below is
     * what keeps that from being an accident.
     */
    const colleague = await submitFor(asMember(), '2081-08-04');
    expect(
      (
        await call('POST', `${basePath()}/${colleague.id}/reason-codes`, asMember(), {
          reasonCode: 'family',
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await call('POST', `${basePath()}/${colleague.id}/comments`, asScheduler(), {
          body: 'Logged at the rota meeting.',
        })
      ).statusCode,
    ).toBe(201);

    /* THE PROBE. */
    const refused = await call('GET', `${basePath()}/${colleague.id}/comments`, asScheduler());
    expect(refused.statusCode, refused.raw).toBe(404);

    /* CONTROL A — the rows EXIST and this very actor may read them, through the
     * decider's door, in the same fixture state. Without this, the 404 above
     * would be satisfied by an empty thread or by rows nobody can see, and the
     * mutation the review ran (which answered `200 {"comments":[]}`) shows how
     * close those two outcomes look from outside. */
    const detail = await call('GET', `${basePath()}/${colleague.id}`, asScheduler());
    expect(detail.statusCode, detail.raw).toBe(200);
    expect(
      (detail.body as { comments: unknown[] }).comments,
      'the rows must exist and be visible to this actor by the OTHER door',
    ).toHaveLength(2);

    /* CONTROL B — the same actor, the same route, their OWN request: 200 with
     * their own thread. FAD-15: a deny test whose subject nobody can reach denies
     * for the wrong reason and passes anyway. This is also the table's
     * "Scheduler ✓ reads own thread" cell, proven positively. */
    const own = await submitFor(asScheduler(), '2081-08-11');
    expect(
      (
        await call('POST', `${basePath()}/${own.id}/reason-codes`, asScheduler(), {
          reasonCode: 'education',
        })
      ).statusCode,
    ).toBe(201);

    const allowed = await call('GET', `${basePath()}/${own.id}/comments`, asScheduler());
    expect(allowed.statusCode, allowed.raw).toBe(200);
    const mine = (allowed.body as { comments: Record<string, unknown>[] }).comments;
    expect(mine).toHaveLength(1);
    expect(mine[0]?.['reasonCode']).toBe('education');
    expect(mine[0]?.['authorMembershipId']).toBe(multi().alpha.users.scheduler.membershipId);
  }, 180_000);
});

describe('the four `—` ROWS of the table — Viewer, Telecom, Group Admin, Org Admin', () => {
  /* Every one of these roles is `—` in BOTH doc 08 §6 rows, so all three comment
   * routes refuse them. Three are refused at the CAPABILITY layer and the
   * refusal's IDENTITY is checked rather than its status code — a 403 produced
   * by something else would satisfy `toBe(403)` and prove nothing. The fourth,
   * the organization administrator, is refused EARLIER because their membership
   * is organization-scoped; `otherRoles` carries the measurement and the
   * reasoning. */

  it('none of them can attach a reason code — refused, each by its own layer', async () => {
    const request = await submitFor(asMember(), '2081-05-05');
    for (const role of otherRoles()) {
      harness.clearLogs();
      const reply = await call(
        'POST',
        `${basePath()}/${request.id}/reason-codes`,
        role.userId,
        { reasonCode: 'other' },
      );
      expectRefused(reply, role);
    }
    expect(await commentRows(request.id)).toEqual([]);
  }, 180_000);

  it('none of them can append a scheduler comment — refused, each by its own layer', async () => {
    const request = await submitFor(asMember(), '2081-05-12');
    for (const role of otherRoles()) {
      harness.clearLogs();
      const reply = await call('POST', `${basePath()}/${request.id}/comments`, role.userId, {
        body: 'A note from somebody with no key.',
      });
      expectRefused(reply, role);
    }
    expect(await commentRows(request.id)).toEqual([]);
  }, 180_000);

  it('none of them can read a thread — refused on both read doors', async () => {
    const request = await submitFor(asMember(), '2081-05-19');
    for (const role of otherRoles()) {
      harness.clearLogs();
      const own = await call('GET', `${basePath()}/${request.id}/comments`, role.userId);
      expectRefused(own, { label: `${role.label} own-thread`, refusal: role.refusal });

      harness.clearLogs();
      const detail = await call('GET', `${basePath()}/${request.id}`, role.userId);
      expectRefused(detail, { label: `${role.label} detail`, refusal: role.refusal });
    }
  }, 180_000);
});

/* ════════════════════════════════════════════════════════════════════════════
 * FAD-58.1 — the requester channel has NO text field, structurally
 * ════════════════════════════════════════════════════════════════════════════ */

describe('FAD-58.1 — there is no text field on the requester channel, at any layer', () => {
  it('a body carrying `text` beside the code is refused STRUCTURALLY, and nothing is written', async () => {
    /* **The packet's named proof**: "the wire refuses any text field on the
     * requester channel STRUCTURALLY (`.strict()` with no such field), proven by
     * a test that posts one and reads the refusal."
     *
     * `422 VALIDATION_FAILED` with an `unrecognized_keys` problem naming the
     * field — not a 201 whose extra key was silently dropped, which is the outcome
     * that would let a client believe it had said something. */
    const request = await submitFor(asMember(), '2081-05-26');
    const reply = await call('POST', `${basePath()}/${request.id}/reason-codes`, asMember(), {
      reasonCode: 'other',
      text: 'my daughter has an appointment that morning',
    });
    expect(reply.statusCode, reply.raw).toBe(422);
    const error = (reply.body as { error: { code: string; problems: { field: string }[] } }).error;
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(
      JSON.stringify(error.problems),
      'the refusal must name the unrecognized key rather than dropping it',
    ).toContain('text');
    expect(
      await commentRows(request.id),
      'a refused body must leave no row — not even the code half',
    ).toEqual([]);
  }, 180_000);

  it('every plausible name for that field is refused the same way', async () => {
    /* One name proves the schema is strict; several prove there is no field
     * SOMEBODY would find. `otherText` is the one a "helpful" implementer of an
     * "other, specify" box would reach for, and `other` is the TERMINAL code it
     * would hang off. */
    const request = await submitFor(asMember(), '2081-06-02');
    for (const field of ['text', 'note', 'detail', 'comment', 'body', 'otherText', 'reason']) {
      const reply = await call('POST', `${basePath()}/${request.id}/reason-codes`, asMember(), {
        reasonCode: 'other',
        [field]: 'something the requester wanted to say',
      });
      expect(reply.statusCode, `${field}: ${reply.raw}`).toBe(422);
    }
    expect(await commentRows(request.id)).toEqual([]);
  }, 180_000);

  it('a code outside the vocabulary is refused — including `medical`', async () => {
    const request = await submitFor(asMember(), '2081-06-09');
    for (const code of ['medical', 'sick', 'appointment', '', 'PERSONAL']) {
      const reply = await call('POST', `${basePath()}/${request.id}/reason-codes`, asMember(), {
        reasonCode: code,
      });
      expect(reply.statusCode, `${code}: ${reply.raw}`).toBe(422);
    }
    expect(await commentRows(request.id)).toEqual([]);
  }, 180_000);

  it('I-16 — one turn, ONE accepted code: an array is refused', async () => {
    const request = await submitFor(asMember(), '2081-06-16');
    const reply = await call('POST', `${basePath()}/${request.id}/reason-codes`, asMember(), {
      reasonCode: ['childcare', 'travel'],
    });
    expect(reply.statusCode, reply.raw).toBe(422);
    expect(await commentRows(request.id)).toEqual([]);
  }, 180_000);

  it('a scheduler comment of pure whitespace, or over the bound, is refused on the wire', async () => {
    const request = await submitFor(asMember(), '2081-06-23');
    for (const body of ['   ', 'x'.repeat(1001), '']) {
      const reply = await call('POST', `${basePath()}/${request.id}/comments`, asScheduler(), {
        body,
      });
      expect(reply.statusCode, `${String(body.length)}: ${reply.raw}`).toBe(422);
    }
    /* …and the bound itself is INCLUSIVE, so the refusals above are about being
     * over it rather than about the field being unusable. */
    const atBound = await call('POST', `${basePath()}/${request.id}/comments`, asScheduler(), {
      body: 'x'.repeat(1000),
    });
    expect(atBound.statusCode, atBound.raw).toBe(201);
  }, 180_000);
});

/* ════════════════════════════════════════════════════════════════════════════
 * The three properties FAD-58 rules that are NOT about who may act
 * ════════════════════════════════════════════════════════════════════════════ */

describe('append-only, no movement, no status gate', () => {
  it('a comment moves NOTHING — the root is byte-identical across an append', async () => {
    /* The honest discharge of doc 42 §5g's "the R-01 cross-product extends to any
     * new operation in both layers", read as *any new STATUS-MOVING operation*.
     * `comment` is not one: `OperationVerdict`'s allowed arm carries
     * `to: RequestStatus`, so adding it would require inventing a target status
     * for an operation that has none. This is the property that claim reduces to,
     * proven by measurement rather than argued. */
    const request = await submitFor(asMember(), '2081-06-30');
    const before = await rootFacts(request.id);

    expect(
      (
        await call('POST', `${basePath()}/${request.id}/reason-codes`, asMember(), {
          reasonCode: 'personal',
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await call('POST', `${basePath()}/${request.id}/comments`, asScheduler(), {
          body: 'Seen; nothing to change.',
        })
      ).statusCode,
    ).toBe(201);

    expect(await rootFacts(request.id), 'a comment is not a lifecycle operation').toEqual(before);
  }, 180_000);

  it('correction is a NEW comment — the same code twice both stand, oldest first', async () => {
    /* FAD-58.3: "correction is a new comment". There is no edit route and no
     * delete route, because migration 0026 grants no runtime role UPDATE or
     * DELETE — the populated cycle proves the `42501`. What the surface offers
     * instead is another append, and the thread keeps both. */
    const request = await submitFor(asMember(), '2081-07-07');
    for (const code of ['travel', 'family', 'travel'] as const) {
      const reply = await call('POST', `${basePath()}/${request.id}/reason-codes`, asMember(), {
        reasonCode: code,
      });
      expect(reply.statusCode, reply.raw).toBe(201);
    }
    const thread = await call('GET', `${basePath()}/${request.id}/comments`, asMember());
    expect(
      (thread.body as { comments: { reasonCode: string }[] }).comments.map((c) => c.reasonCode),
      'append-only: nothing was replaced, and the order is the conversation’s',
    ).toEqual(['travel', 'family', 'travel']);
  }, 180_000);

  it('NO STATUS GATE — a code attaches to a WITHDRAWN request (C-3, consequence owned)', async () => {
    /* §4's comments row states four properties and a lifecycle predicate is not
     * among them, so this packet does not invent one. The consequence is stated
     * rather than discovered: a requester can annotate a request that is already
     * over. Nothing moves when they do — the assertion two tests above — so the
     * cost of the openness is bounded. */
    const request = await submitFor(asMember(), '2081-07-14');
    const withdrawn = await call('POST', `${basePath()}/${request.id}/withdraw`, asMember(), {
      expectedVersion: request.version,
    });
    expect(withdrawn.statusCode, withdrawn.raw).toBe(200);
    expect((await rootFacts(request.id)).status).toBe('withdrawn');

    const reply = await call('POST', `${basePath()}/${request.id}/reason-codes`, asMember(), {
      reasonCode: 'other',
    });
    expect(reply.statusCode, reply.raw).toBe(201);
    expect((await rootFacts(request.id)).status).toBe('withdrawn');
  }, 180_000);

  it('a request that does not exist and a malformed id both answer 404, not 422', async () => {
    /* Parsing happens AFTER the verdict (the SBX-001 disclosure finding), so a
     * caller who holds nothing cannot learn a route exists by sending a bad body
     * — and an id that names nothing is the same answer as an id that names
     * somebody else's row. */
    const missing = await call(
      'POST',
      `${basePath()}/${randomUUID()}/reason-codes`,
      asMember(),
      { reasonCode: 'other' },
    );
    expect(missing.statusCode, missing.raw).toBe(404);

    const malformed = await call('POST', `${basePath()}/not-a-uuid/reason-codes`, asMember(), {
      reasonCode: 'other',
    });
    expect(malformed.statusCode, malformed.raw).toBe(404);
  }, 180_000);
});
