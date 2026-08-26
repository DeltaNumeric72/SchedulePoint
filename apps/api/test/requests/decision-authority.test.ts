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
 * **The §5c binding note, proven at the layer that decides operations**
 * (OPUS-M5-002, doc 42 §5d Part A).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## The claim, and exactly what discharges it
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Doc 42 §5d carries M5-001's review note as binding:
 *
 * > `requests_own` is FOR ALL with `status` in the column grant, so at the SQL
 * > layer a member's own row can walk every §2 edge: **`approved` must be
 * > reachable solely through the `requests.administer` path** when M5-002 adds
 * > the routes (RLS decides rows, never operations; PO-DEC-02's layers decide
 * > operations).
 *
 * The note names its own mechanism, and this packet takes it: **no database
 * trigger gates a status transition on a capability.** Migration 0024's header
 * §4 records why in full — the short version is that such a trigger would
 * retroactively fail four shipped proof suites which walk to `approved` under a
 * member context deliberately, and curing that would mean editing prior packets'
 * proofs to accommodate a new guard.
 *
 * So the property is discharged HERE, in two halves:
 *
 *  1. **Structural** — `test/requests/route-policy.test.ts`, "EVERY route that
 *     can write `approved` declares a DECISION key". Asserted over the registered
 *     route table, so a seventh route with a read key and a decision body fails.
 *  2. **Behavioural — this file.** Every write route this packet adds is driven
 *     by a MEMBER holding only CAP-021's own-keys, and each one is refused. And
 *     the refusal's IDENTITY is checked: the captured log line must show the
 *     denial came from SPEC-06's capability layer, not from a neighbouring
 *     constraint that happened to fire first. A `403` produced by a foreign-key
 *     violation would satisfy a status-code assertion and prove nothing.
 *
 * ## The residue, owned rather than discovered
 *
 * Under layers-only, an operator at a psql prompt running under a member's own
 * tenant context CAN move that member's own request along §2's edges, including
 * into `approved`. That is the division recorded since migration 0023 — *RLS
 * decides which ROWS, never which OPERATIONS* — verified at the M5-001 review and
 * unchanged by this packet. It is stated in 0024's header, and it is stated here
 * so a reader of the proof knows what the proof does not cover.
 *
 * ## FAD-15 vacuity discipline — an ALLOW control before every DENY
 *
 * A deny test whose subject does not exist denies for the wrong reason and passes
 * anyway. Every refusal below is preceded by the SAME request succeeding for the
 * scheduler against the SAME route with the SAME body shape, so a 403 can only
 * mean the capability gate.
 *
 * ## Synthetic only
 *
 * Every date is far-future and every label is the fixture's own. No
 * organization, site or person name from the research appears here.
 */

const multi = ownedMulti('requests-decision-authority', {
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

function basePath(): string {
  const alpha = multi().alpha;
  return `/organizations/${alpha.organizationId}/groups/${alpha.groupOne.id}/requests`;
}

function vacationPath(): string {
  const alpha = multi().alpha;
  return `/organizations/${alpha.organizationId}/groups/${alpha.groupOne.id}/vacation/selections`;
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
 * A `submitted` request owned by the MEMBER, written under the member's own
 * tenant context.
 *
 * Deliberately not through the submission ROUTE: this file is about the decision
 * routes, and routing the setup through a second surface would make a setup
 * failure look like an authorization result. The row is created at its initial
 * status and walked one edge, which is what `requests_own` (FOR ALL) permits and
 * what migration 0023's initial-status guard requires.
 */
async function memberRequestAt(status: 'submitted' | 'approved'): Promise<string> {
  const alpha = multi().alpha;
  const context = {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    membershipId: alpha.users.member.membershipId,
    correlationId: `decision-authority-setup-${randomUUID().slice(0, 8)}`,
  };
  return runtime.runner.run(context, async ({ query }) => {
    const id = randomUUID();
    await sql`
      insert into requests
        (id, organization_id, group_id, membership_id, subtype, status, expires_at,
         idempotency_key)
      values (${id}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
              ${context.membershipId}::uuid, ${'time-off'},
              app_request_initial_status(${'time-off'}),
              ${'2099-06-01T00:00:00.000Z'}::timestamptz,
              ${`authority.${randomUUID().slice(0, 12)}`})
    `.execute(query);
    await sql`
      insert into request_time_off (request_id, organization_id, group_id, target_date)
      values (${id}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
              ${'2047-05-03'}::date)
    `.execute(query);
    await sql`update requests set status = 'submitted' where id = ${id}::uuid`.execute(query);
    if (status === 'approved') {
      /* The two-step, because §2 has no `submitted → approved` cell. This setup
       * walking it under a MEMBER context is precisely the residue the header
       * names — and it is why the route-layer proof below is the control that
       * matters. */
      await sql`update requests set status = 'under_review' where id = ${id}::uuid`.execute(query);
      await sql`
        update requests set status = 'approved', decided_at = now(),
                            decided_by = ${context.membershipId}::uuid
         where id = ${id}::uuid
      `.execute(query);
    }
    return id;
  });
}

/** The row's current status and version, read with the superuser. */
async function rowState(requestId: string): Promise<{ status: string; version: number }> {
  const result = await admin.query<{ status: string; version: number }>(
    'select status, version from requests where id = $1::uuid',
    [requestId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('the setup request is missing');
  return row;
}

/**
 * The authorization denial the server logged for the last call, if any.
 *
 * **This is the assertion that makes the refusals mean something.** A 403 can be
 * produced by many things; `respondToDenial` is the only path that writes this
 * line, and its `reason` names the SPEC-06 layer that refused. Checking it is how
 * "refused by the capability gate" is distinguished from "refused by whatever
 * fired first".
 */
function lastDenial(): { step?: unknown; reason?: unknown } | undefined {
  /* TWO writers emit `authorization denied`, and taking the last one is wrong.
   * `sendForbidden` (`http/context/responses.ts`) logs a FLAT `{ correlationId,
   * reason }` after `respondToDenial` has already logged the structured
   * `{ authorization: { step, reason, … } }` — so a naive "last line with this
   * message" finds the flat one, whose `authorization` key is absent, and reports
   * `undefined` for a denial that was recorded perfectly well. The structured
   * object is what names the LAYER, so it is what this looks for. */
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

beforeAll(async () => {
  harness = await buildHttpHarness();
  runtime = createRuntime('app_runtime', { max: 3 });
  admin = adminClient();
  await admin.connect();

  /* **Without this every assertion below would be vacuous, and the ALLOW controls
   * are what said so.** `requests_vacation` is entitled in no fixture
   * organization, so the request surface denies at SPEC-06 L1.1 NOT_ENTITLED and
   * answers 404 — for a scheduler exactly as for a member. A file that asserted
   * only the DENY cases would have passed against a surface nobody could reach.
   * See `test/support/requests.ts` for the finding and why it is cured here
   * rather than in the shared fixture. */
  const alpha = multi().alpha;
  await entitleRequestsModule(runtime.runner, {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    organizationAdminMembershipId: alpha.users.organizationAdmin.membershipId,
  });
}, 240_000);

afterAll(async () => {
  await harness?.close();
  await runtime?.destroy();
  await admin?.end();
});

describe('ALLOW controls — the scheduler CAN reach every decision route', () => {
  it('approve: a scheduler moves a member request `submitted` → `approved`', async () => {
    const requestId = await memberRequestAt('submitted');
    const before = await rowState(requestId);

    const reply = await call(
      'POST',
      `${basePath()}/${requestId}/approve`,
      multi().alpha.users.scheduler.id,
      { expectedVersion: before.version },
    );
    expect(reply.statusCode, reply.raw).toBe(200);
    expect((reply.body as { status: string }).status).toBe('approved');

    /* The two-step happened INSIDE one transaction: the row is at `approved` and
     * its version rose by TWO, one per edge — which is the observable trace of
     * `submitted → under_review → approved` and would be one if a single-statement
     * spelling had somehow been accepted. */
    const after = await rowState(requestId);
    expect(after.status).toBe('approved');
    expect(after.version).toBe(before.version + 2);
  });

  it('deny: a scheduler denies with a reason, and the row reaches `denied`', async () => {
    const requestId = await memberRequestAt('submitted');
    const before = await rowState(requestId);

    const reply = await call(
      'POST',
      `${basePath()}/${requestId}/deny`,
      multi().alpha.users.scheduler.id,
      { expectedVersion: before.version, reason: 'The department is short-staffed that week.' },
    );
    expect(reply.statusCode, reply.raw).toBe(200);
    expect((await rowState(requestId)).status).toBe('denied');
  });

  it('queue: a scheduler reads the pending-review queue', async () => {
    await memberRequestAt('submitted');
    const reply = await call('GET', `${basePath()}/queue`, multi().alpha.users.scheduler.id);
    expect(reply.statusCode, reply.raw).toBe(200);
    expect((reply.body as { requests: unknown[] }).requests.length).toBeGreaterThan(0);
  });
});

describe('the §5c binding note — a MEMBER cannot reach `approved` through ANY route here', () => {
  /**
   * The member holds `member`'s role capabilities and nothing else. Doc 08 §6's
   * "Approve requests/vacation" row is `—` for Member, so the four decision keys
   * are not theirs — which is the fact every refusal below rests on.
   */
  const asMember = (): string => multi().alpha.users.member.id;

  it('approve: refused, and the refusal comes from the CAPABILITY layer', async () => {
    const requestId = await memberRequestAt('submitted');
    const before = await rowState(requestId);

    harness.clearLogs();
    const reply = await call('POST', `${basePath()}/${requestId}/approve`, asMember(), {
      expectedVersion: before.version,
    });

    /* L4.2 — the actor holds an active membership in this group, so the tenant's
     * existence is already known to them and the disclosure class is 403. */
    expect(reply.statusCode, reply.raw).toBe(403);
    /* SPEC-06 P-3: the reason never reaches the body. */
    expect(reply.raw).not.toMatch(/capability|requests\.approve|CAP-0/i);

    /* THE IDENTITY CHECK. Without it a 403 from any other cause would pass. */
    const denial = lastDenial();
    expect(denial, 'no authorization denial was logged — something else refused').toBeDefined();
    expect(denial?.['reason']).toBe('NO_CAPABILITY');
    expect(denial?.['step']).toBe('L4.2');

    /* And nothing moved. A refusal that had already written would be worse than
     * one that answered 200. */
    const after = await rowState(requestId);
    expect(after.status).toBe('submitted');
    expect(after.version).toBe(before.version);
  });

  it('deny: refused, from the capability layer, with the row untouched', async () => {
    const requestId = await memberRequestAt('submitted');
    const before = await rowState(requestId);

    harness.clearLogs();
    const reply = await call('POST', `${basePath()}/${requestId}/deny`, asMember(), {
      expectedVersion: before.version,
      reason: 'A member should not be able to write this at all.',
    });
    expect(reply.statusCode, reply.raw).toBe(403);
    expect(lastDenial()?.['reason']).toBe('NO_CAPABILITY');
    expect((await rowState(requestId)).status).toBe('submitted');
  });

  it('reverse: refused, from the capability layer', async () => {
    const requestId = await memberRequestAt('approved');
    const before = await rowState(requestId);

    harness.clearLogs();
    const reply = await call('POST', `${basePath()}/${requestId}/reverse`, asMember(), {
      expectedVersion: before.version,
      reason: 'A member should not be able to reverse a decision.',
    });
    expect(reply.statusCode, reply.raw).toBe(403);
    expect(lastDenial()?.['reason']).toBe('NO_CAPABILITY');
    expect((await rowState(requestId)).status).toBe('approved');
  });

  it('batch: refused, from the capability layer, before any item is considered', async () => {
    const requestId = await memberRequestAt('submitted');
    const before = await rowState(requestId);

    harness.clearLogs();
    const reply = await call('POST', `${basePath()}/decisions`, asMember(), {
      decision: 'approved',
      items: [{ requestId, expectedVersion: before.version }],
    });
    expect(reply.statusCode, reply.raw).toBe(403);
    expect(lastDenial()?.['reason']).toBe('NO_CAPABILITY');
    /* Per-item outcomes are for items a caller was ALLOWED to attempt. An
     * unauthorized batch produces no outcomes at all, and reporting per-item
     * failures here would leak which ids exist. */
    expect(reply.raw).not.toMatch(/outcomes/);
    expect((await rowState(requestId)).status).toBe('submitted');
  });

  it('the queue and the detail read are refused too — read_any is not a member key', async () => {
    const requestId = await memberRequestAt('submitted');

    harness.clearLogs();
    const queue = await call('GET', `${basePath()}/queue`, asMember());
    expect(queue.statusCode, queue.raw).toBe(403);
    expect(lastDenial()?.['reason']).toBe('NO_CAPABILITY');

    harness.clearLogs();
    const detail = await call('GET', `${basePath()}/${requestId}`, asMember());
    expect(detail.statusCode, detail.raw).toBe(403);
    expect(lastDenial()?.['reason']).toBe('NO_CAPABILITY');
  });

  it('the vacation decision routes are refused for the same actor', async () => {
    /* The selection id is a fresh uuid that names nothing, and that is
     * deliberate: authorization is evaluated BEFORE the body and before any
     * lookup, so a refusal here cannot be "no such selection" wearing a 403.
     * The identity check proves which layer answered. */
    const selectionId = randomUUID();

    harness.clearLogs();
    const approve = await call('POST', `${vacationPath()}/${selectionId}/approve`, asMember(), {
      approvalIdempotencyKey: `authority-${randomUUID().slice(0, 8)}`,
      expectedSelectionVersion: 1,
    });
    expect(approve.statusCode, approve.raw).toBe(403);
    expect(lastDenial()?.['reason']).toBe('NO_CAPABILITY');

    harness.clearLogs();
    const deny = await call('POST', `${vacationPath()}/${selectionId}/deny`, asMember(), {
      approvalIdempotencyKey: `authority-${randomUUID().slice(0, 8)}`,
      expectedSelectionVersion: 1,
      reason: 'A member should not be able to deny a vacation selection.',
    });
    expect(deny.statusCode, deny.raw).toBe(403);
    expect(lastDenial()?.['reason']).toBe('NO_CAPABILITY');
  });

  it('and the member CAN still do everything their own keys permit — not a blanket denial', async () => {
    /* The other half of FAD-15's discipline, in the other direction: if the member
     * were refused EVERYTHING, the refusals above would prove only that the actor
     * is inert. Their own request is visible to them through `requests_own`, so a
     * read of their own list succeeds where the queue does not.
     *
     * `requests.own.read` is not in any role's set either (doc 08 §6 marks that
     * cell `✓`, and M5-001 left the key grant-only — recorded as a finding for the
     * hygiene batch, not fixed here), so this is asserted at the DATA layer rather
     * than through the route: the member's own row is visible under
     * `requests_own`, which is what makes the 403s above about the OPERATION
     * rather than about the rows. */
    const requestId = await memberRequestAt('submitted');
    const alpha = multi().alpha;
    const visible = await runtime.runner.run(
      {
        organizationId: alpha.organizationId,
        groupId: alpha.groupOne.id,
        membershipId: alpha.users.member.membershipId,
        correlationId: 'decision-authority-own-read',
      },
      async ({ query }) =>
        await sql<{ status: string }>`
          select status from requests where id = ${requestId}::uuid
        `.execute(query),
    );
    expect(visible.rows[0]?.status, 'the member cannot see their own request').toBe('submitted');
  });
});
