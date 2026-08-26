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
 * **FU-28: doc 08 §6's `✓` for Member "Submit requests/vacation" means
 * ROLE-IMPLICATION** (OPUS-M5-H, ruled under the 2026-08-01 mandate).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## The disagreement this closes
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `docs/fable/08-roles-and-permissions.md` §6 states its own legend — "✓ =
 * allowed by role · G = requires named grant · — = denied" — and marks "Submit
 * requests/vacation" `✓` for Member and `✓` for Scheduler. Until this packet
 * `requests.own.submit` / `.own.withdraw` / `.own.read` appeared in **no role's**
 * `SYSTEM_ROLE_CAPABILITIES` entry, so a member could reach their own request
 * surface only through an explicit grant written into a fixture. The document
 * said role-implied; the system said grantable; the two had disagreed since
 * M5-001, which recorded it and deliberately did not act (narrower-never-wider),
 * and M5-002 re-recorded it in `cross-product.ts`'s own comment.
 *
 * The legend was verified against the document BEFORE the constant was edited —
 * the ruling's own precondition — and it supports the reading: this row carries
 * `✓`, not `G`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## Both layers, and why each is here
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  1. **The constant.** `SYSTEM_ROLE_CAPABILITIES` is the seed written into
 *     `role_capabilities` for a new organization AND the map the SPEC-06
 *     cross-product battery reasons about, so the two cannot diverge. Asserted
 *     positively for `member` and `scheduler` and NEGATIVELY for every other
 *     role — the negative half is the row's `—` cells, and without it this file
 *     would pass just as happily if the keys had been given to everybody.
 *  2. **The real routes, over HTTP.** The constant could be right and the
 *     resolution path still not consult it. So a MEMBER with the role and **no
 *     grants at all** drives every one of CAP-021's three own-keys end to end,
 *     and a VIEWER — `—` in the same row — is refused at the capability layer on
 *     the same route with the same shape. This is the `holiday-key-split.test.ts`
 *     pattern (an actor chosen so a success can only be the role-implied key),
 *     and it doubles as FU-29's rule for this route family: at least one
 *     HTTP-driven success shape and at least one HTTP-driven refusal.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## The non-vacuity control, stated rather than assumed
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every success below would be equally green if some fixture had quietly granted
 * these keys to this membership — and that is precisely the shape of the defect
 * this packet is repairing, so it is asserted rather than believed: the test
 * reads `capability_grants` for the acting membership and requires that NO grant
 * of any of the three keys exists. If one is ever added, this file fails and says
 * so, instead of proving the fixture.
 *
 * ## Synthetic only
 *
 * Every date is far-future (2047) and every label is the fixture's own. No
 * organization, site or person name from the research appears here.
 */

const multi = ownedMulti('requests-member-role-implication', {
  profile: 'full',
  seed: { catalogue: ['alpha'] },
});

const OWN_KEYS = ['requests.own.submit', 'requests.own.withdraw', 'requests.own.read'] as const;

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
 * Copied from `decision-authority.test.ts` for the reason that file gives: two
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

beforeAll(async () => {
  harness = await buildHttpHarness();
  runtime = createRuntime('app_runtime', { max: 3 });
  admin = adminClient();
  await admin.connect();

  const alpha = multi().alpha;

  /* Without the module entitled, every request route denies at SPEC-06 L1.1 and
   * answers 404 for EVERY role — so the refusal below would be about the
   * entitlement rather than about the role, and the successes would be
   * impossible. The M5-002 finding, cured the way that packet cured it. */
  await entitleRequestsModule(runtime.runner, {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    organizationAdminMembershipId: alpha.users.organizationAdmin.membershipId,
  });

  /* §3's window, open on a far-future fixed date, so a submission is refused by
   * nothing except authorization. A `closed` window (the fixture default) would
   * refuse the member for a POLICY reason and this file would be asserting the
   * deadline machinery instead of the role.
   *
   * **Written by the GROUP ADMINISTRATOR, and that choice is load-bearing.**
   * Migration 0010 gates the group's request-until columns on
   * `group.settings.administer`, which the `group_admin` role implies and the
   * member does not hold in any form. `lifecycle-service.test.ts` solves the same
   * problem by GRANTING that key to the member; here that would be exactly wrong,
   * because this file's whole claim is about an actor who was granted nothing —
   * a grant of any key to this membership makes "no grants at all" a sentence
   * somebody has to qualify. The setup uses a different person instead, which is
   * also what would happen in the product: schedulers do not open their own
   * request windows. */
  const groupAdmin = alpha.full?.groupAdmin;
  if (groupAdmin === undefined) throw new Error('the full profile did not provision a group admin');
  await runtime.runner.run(
    {
      organizationId: alpha.organizationId,
      groupId: alpha.groupOne.id,
      membershipId: groupAdmin.membershipId,
      correlationId: 'member-role-implication-window',
    },
    async ({ query }) =>
      await sql`
        update groups
           set request_until_mode = ${'fixed_date'},
               request_until_date = ${'2047-12-31'}::date,
               request_until_lead_days = ${null},
               deadline_rolls = ${'exact'},
               late_submission_policy = ${'reject'}
         where id = ${alpha.groupOne.id}::uuid
      `.execute(query),
  );
}, 240_000);

afterAll(async () => {
  await harness?.close();
  await runtime?.destroy();
  await admin?.end();
});

describe('layer 1 — the role→capability constant follows doc 08 §6', () => {
  it('member and scheduler hold all three self-scoped keys', () => {
    for (const role of ['member', 'scheduler']) {
      const held = SYSTEM_ROLE_CAPABILITIES[role] ?? [];
      for (const key of OWN_KEYS) {
        expect(held, `${role} must hold ${key} by role (doc 08 §6 marks that cell ✓)`).toContain(
          key,
        );
      }
    }
  });

  it('every OTHER role holds none of them — the row\'s `—` cells', () => {
    /* The half that makes the half above mean something. `viewer`, `telecom`,
     * `group_admin` and both organization roles are `—` in doc 08 §6's "Submit
     * requests/vacation" row, and a change that handed these keys to everybody
     * would satisfy the positive assertion alone. */
    for (const [role, held] of Object.entries(SYSTEM_ROLE_CAPABILITIES)) {
      if (role === 'member' || role === 'scheduler') continue;
      for (const key of OWN_KEYS) {
        expect(held, `${role} is \`—\` in doc 08 §6's submit row and must not hold ${key}`).not.toContain(
          key,
        );
      }
    }
  });

  it('the three keys are still SELF-scoped — implication widened nothing', () => {
    /* Role-implication answers "may this person act at all"; it does not answer
     * "on whose rows". Reaching a COLLEAGUE's request is `requests.read_any` /
     * `requests.administer`, which are doc 08 §6's "Approve requests/vacation"
     * row (Member `—`) and migration 0023's SENSITIVE-PII narrowing. A member
     * must not have acquired either by this change. */
    const member = SYSTEM_ROLE_CAPABILITIES['member'] ?? [];
    expect(member).not.toContain('requests.read_any');
    expect(member).not.toContain('requests.administer');
    expect(member).not.toContain('requests.approve');
    expect(member).not.toContain('requests.deny');
  });
});

describe('layer 2 — the real routes, driven over HTTP by a role-only member', () => {
  const asMember = (): string => multi().alpha.users.member.id;

  it('the acting membership holds NO grant of any own-key — the control for everything below', async () => {
    const alpha = multi().alpha;
    const grants = await admin.query<{ capability_key: string; granted: boolean }>(
      `select capability_key, granted from capability_grants
        where membership_id = $1::uuid and capability_key = any($2::text[])`,
      [alpha.users.member.membershipId, [...OWN_KEYS]],
    );
    expect(
      grants.rows,
      'a fixture grant of these keys would make every success below prove the fixture, not the role',
    ).toEqual([]);
  });

  it('GET …/requests/mine — 200 for a member who was granted nothing', async () => {
    const reply = await call('GET', `${basePath()}/mine`, asMember());
    expect(reply.statusCode, reply.raw).toBe(200);
    expect(Array.isArray((reply.body as { requests?: unknown }).requests)).toBe(true);
  });

  it('GET …/requests/deadline — 200 on the same key', async () => {
    const reply = await call('GET', `${basePath()}/deadline`, asMember());
    expect(reply.statusCode, reply.raw).toBe(200);
  });

  it('POST …/requests — a member submits their OWN time-off request, 201', async () => {
    const reply = await call('POST', basePath(), asMember(), {
      idempotencyKey: `role-implication.${randomUUID().slice(0, 12)}`,
      record: { subtype: 'time-off', targetDate: '2047-05-03' },
    });
    expect(reply.statusCode, reply.raw).toBe(201);
    /* The wire shape is `{ root, record }` (`requestSchema`), and reading the
     * ROOT rather than the envelope is deliberate: a 201 whose body did not carry
     * a `submitted` root would be a success shape that proved nothing. */
    expect((reply.body as { root: { status: string } }).root.status).toBe('submitted');
  });

  it('POST …/requests/:id/withdraw — the requester takes their own request back', async () => {
    const submitted = await call('POST', basePath(), asMember(), {
      idempotencyKey: `role-implication.${randomUUID().slice(0, 12)}`,
      record: { subtype: 'time-off', targetDate: '2047-05-04' },
    });
    expect(submitted.statusCode, submitted.raw).toBe(201);
    const created = (submitted.body as { root: { id: string; version: number } }).root;

    const reply = await call('POST', `${basePath()}/${created.id}/withdraw`, asMember(), {
      expectedVersion: created.version,
    });
    expect(reply.statusCode, reply.raw).toBe(200);

    const row = await admin.query<{ status: string }>(
      'select status from requests where id = $1::uuid',
      [created.id],
    );
    expect(row.rows[0]?.status).toBe('withdrawn');
  });

  it('a VIEWER is refused on the same route, at the CAPABILITY layer', async () => {
    /* The deny control, with the ROLE as the only variable: same organization,
     * same group, same route, same entitlement — a different `✓`/`—` cell. And
     * the refusal's identity is checked rather than its status code, because a
     * 403 produced by something else would satisfy `toBe(403)` and prove
     * nothing. */
    const full = multi().alpha.full;
    if (full === undefined) throw new Error('the full profile did not provision a viewer');

    harness.clearLogs();
    const reply = await call('GET', `${basePath()}/mine`, full.viewer.id);
    expect(reply.statusCode, reply.raw).toBe(403);
    expect(lastDenial()?.['reason']).toBe('NO_CAPABILITY');
  });
});
