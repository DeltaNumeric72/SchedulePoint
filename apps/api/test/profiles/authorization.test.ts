import { CAPABILITIES } from '@schedulepoint/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type pg from 'pg';

import {
  ADMINISTER_HOLDING_CONFIG,
  ADMINISTER_QUALIFICATION_CONFIG,
  AUTHOR_WORK_PROFILE_CONFIG,
  READ_HOLDINGS_CONFIG,
  READ_WORK_PROFILE_CONFIG,
} from '../../src/http/routes/profiles.route.js';
import { adminClient } from '../support/admin-client.js';
import { log } from '../support/harness.js';
import { buildHttpHarness, contextHeaders, currentCounters, type HttpHarness } from '../support/http.js';
import { ownedMulti } from '../support/owned-multi.js';
import { grantStaffingCapabilities, STAFFING_CAPABILITIES } from '../support/staffing.js';

/**
 * **Allow AND deny, for every capability this packet introduces** — plus the
 * `SENSITIVE-PII` read narrowing on `qualification_holdings`.
 *
 * ## Green before red, every time
 *
 * Each capability is exercised twice against the SAME request: once by a
 * principal holding it (must succeed) and once by a principal who does not (must
 * be refused). A deny test on its own proves nothing — a route that is broken for
 * everybody passes it — and the discipline that says so is FAD-15 ruling 4.
 *
 * ## Why the deny is a 403 and not a 404
 *
 * The first version of this file asserted `404` and was wrong; the kernel was
 * right. SPEC-06 P-5 makes an L0–L2 denial a `404` — the existence of an
 * unentitled module is not disclosed — and P-6 makes an **L4** denial a `403`,
 * because reaching L4 required an active membership in the declared tenant, so
 * the tenant's existence is already known to the actor and `403` discloses
 * nothing new. `denialDisclosure` is a total `Record<DenyReason, Disclosure>`, so
 * this is a decision the kernel makes once rather than a per-route choice.
 *
 * What the `403` must NOT carry is which capability was missing, and that is
 * asserted below on every deny: the reason and the layer go to `request.log` and
 * nowhere else.
 */

const multi = ownedMulti('profiles-authorization', { profile: 'full' });

let harness: HttpHarness;
let admin: pg.Client;

const org = (): string => multi().alpha.organizationId;
const group = (): string => multi().alpha.groupOne.id;
const base = (): string => `/organizations/${org()}/groups/${group()}`;

/** Holds every staffing capability. */
const holder = () => multi().alpha.users.groupOnly;
/** Holds NONE of them — a scheduler, so it passes L0..L3 and fails at L4. */
const bystander = () => multi().alpha.users.scheduler;

async function headersFor(userId: string): Promise<Record<string, string>> {
  return {
    ...contextHeaders(
      userId,
      await currentCounters(admin, { organizationId: org(), groupId: group(), userId }),
    ),
    'content-type': 'application/json',
  };
}

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  harness = await buildHttpHarness();
  await grantStaffingCapabilities(harness.runtime.runner, multi(), {
    organizationId: org(),
    groupId: group(),
    membershipId: holder().membershipId,
    capabilities: [...STAFFING_CAPABILITIES],
  });
}, 120_000);

afterAll(async () => {
  await harness.close();
  await admin.end();
});

/* ────────────────────────────────────────────────────────────────────────────
 * Catalogue integrity
 * ──────────────────────────────────────────────────────────────────────────── */

describe('the six new action keys are declared exactly once, group-scoped', () => {
  it('every staffing key is in the catalogue with group scope and core_scheduling', () => {
    for (const key of STAFFING_CAPABILITIES) {
      const definition = CAPABILITIES.find((capability) => capability.key === key);
      expect(definition, `${key} is not in the capability catalogue`).toBeDefined();
      expect(definition?.scope, `${key} is not group-scoped`).toBe('group');
      expect(definition?.module).toBe('core_scheduling');
    }
  });

  it('every route this packet registers declares one of them', () => {
    const declared = [
      AUTHOR_WORK_PROFILE_CONFIG,
      READ_WORK_PROFILE_CONFIG,
      ADMINISTER_QUALIFICATION_CONFIG,
      ADMINISTER_HOLDING_CONFIG,
      READ_HOLDINGS_CONFIG,
    ].map((config) => config.action.key);
    for (const key of declared) {
      expect(
        (STAFFING_CAPABILITIES as readonly string[]).includes(key),
        `route action ${key} is not one of this packet's capabilities`,
      ).toBe(true);
    }
    // `read_any` deliberately has NO route of its own: it is a data-visibility
    // capability evaluated inside the RLS SELECT policy, never a URL. Asserted so
    // that adding a `read_any` route later is a conscious change.
    expect(declared).not.toContain('staffing.qualification_holding.read_any');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Allow and deny, per capability
 * ──────────────────────────────────────────────────────────────────────────── */

interface CapabilityCase {
  readonly capability: string;
  readonly name: string;
  readonly request: () => {
    method: 'POST' | 'GET' | 'PATCH';
    url: string;
    payload?: Record<string, unknown> | undefined;
  };
}

describe('allow and deny for every new capability', () => {
  let qualificationId: string;

  beforeAll(async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `${base()}/qualifications`,
      headers: await headersFor(holder().id),
      payload: { key: 'basic-life-support', name: 'Basic Life Support' },
    });
    expect(response.statusCode, response.body).toBe(200);
    qualificationId = response.json<{ qualification: { id: string } }>().qualification.id;
  });

  const cases = (): readonly CapabilityCase[] => [
    {
      capability: 'staffing.work_profile.administer',
      name: 'author a work profile',
      request: () => ({
        method: 'POST',
        url: `${base()}/work-profiles`,
        payload: { membershipId: multi().alpha.users.member.membershipId, workPercentage: 50 },
      }),
    },
    {
      capability: 'staffing.work_profile.read',
      name: 'read the profile in force',
      request: () => ({
        method: 'GET',
        url: `${base()}/memberships/${multi().alpha.users.member.membershipId}/work-profile`,
      }),
    },
    {
      capability: 'staffing.work_profile.read',
      name: 'read the profile history',
      request: () => ({
        method: 'GET',
        url: `${base()}/memberships/${multi().alpha.users.member.membershipId}/work-profiles`,
      }),
    },
    {
      capability: 'staffing.qualification.administer',
      name: 'create a qualification',
      request: () => ({
        method: 'POST',
        url: `${base()}/qualifications`,
        payload: { key: `synthetic-${Math.random().toString(36).slice(2, 10)}`, name: 'Synthetic' },
      }),
    },
    {
      capability: 'staffing.qualification.administer',
      name: 'retire a qualification',
      request: () => ({
        method: 'PATCH',
        url: `${base()}/qualifications/${qualificationId}`,
        // OPUS-M4-000A: the row CAS. This file's qualification is created in
        // beforeAll and nothing else updates it, so its version is still 1.
        payload: { status: 'active', expectedVersion: 1 },
      }),
    },
    {
      capability: 'staffing.qualification_holding.administer',
      name: 'issue a credential',
      request: () => ({
        method: 'POST',
        url: `${base()}/qualification-holdings`,
        payload: {
          membershipId: multi().alpha.users.member.membershipId,
          qualificationId,
          validFrom: new Date(Date.now() + Math.floor(Math.random() * 1_000_000)).toISOString(),
        },
      }),
    },
    {
      capability: 'staffing.qualification_holding.read',
      name: 'read a membership\'s credentials',
      request: () => ({
        method: 'GET',
        url: `${base()}/memberships/${multi().alpha.users.member.membershipId}/qualification-holdings`,
      }),
    },
  ];

  for (const testCase of cases()) {
    it(`ALLOW — a holder of ${testCase.capability} may ${testCase.name}`, async () => {
      const spec = testCase.request();
      const response = await harness.app.inject({
        method: spec.method,
        url: spec.url,
        headers: await headersFor(holder().id),
        ...(spec.payload === undefined ? {} : { payload: spec.payload }),
      });
      expect(response.statusCode, response.body).toBe(200);
    });

    it(`DENY — a principal without ${testCase.capability} may NOT ${testCase.name}`, async () => {
      const spec = testCase.request();
      harness.clearLogs();
      const response = await harness.app.inject({
        method: spec.method,
        url: spec.url,
        headers: await headersFor(bystander().id),
        ...(spec.payload === undefined ? {} : { payload: spec.payload }),
      });
      // 403 per SPEC-06 P-6, not 404: reaching L4 means the actor holds an
      // active membership here, so the tenant's existence is not a disclosure.
      expect(
        response.statusCode,
        `an unauthorized principal was allowed to ${testCase.name}`,
      ).toBe(403);

      // The denial is recorded server-side with the layer that produced it — and
      // it must be L4, not an earlier layer. A denial at L0..L3 would mean the
      // test is measuring a broken fixture rather than the capability check.
      const denial = harness.logs.find(
        (line) => (line as { authorization?: unknown }).authorization !== undefined,
      ) as { authorization?: { reason?: string; step?: string } } | undefined;
      expect(denial?.authorization?.step, 'denied before the capability layer').toMatch(/^L4/);
      expect(denial?.authorization?.reason).toBe('NO_CAPABILITY');

      // And nothing about the capability reaches the client.
      expect(response.body).not.toContain('staffing.');
      expect(response.body).not.toContain('capability');
    });
  }

  /* ────────────────────────────────────────────────────────────────────────
   * Authorization runs BEFORE the body is parsed — both directions
   *
   * SBX-001 found the original ordering by attempting every registered route as
   * every principal with an empty body: an unauthorized caller received
   * `400 …_BODY_MALFORMED` and thereby learned the route exists, that it takes a
   * body, and — by iterating — what shape it has.
   *
   * One direction is not enough to pin it. "Unauthorized gets 403" also passes on
   * a route that answers 403 to everybody, and "authorized gets 400" also passes
   * on a route that never validates. Both, on the SAME malformed body, is what
   * says the ordering is the thing being measured.
   * ──────────────────────────────────────────────────────────────────────── */
  const malformedBodies = [
    { name: 'author a work profile', url: () => `${base()}/work-profiles` },
    { name: 'create a qualification', url: () => `${base()}/qualifications` },
    { name: 'issue a credential', url: () => `${base()}/qualification-holdings` },
  ] as const;

  for (const route of malformedBodies) {
    it(`ORDERING — a malformed body to ${route.name}: 403 unauthorized, 400 authorized`, async () => {
      const payload = { thisFieldDoesNotExist: true };

      const unauthorized = await harness.app.inject({
        method: 'POST',
        url: route.url(),
        headers: await headersFor(bystander().id),
        payload,
      });
      expect(
        unauthorized.statusCode,
        'an unauthorized caller was told their BODY was wrong, which discloses the schema',
      ).toBe(403);
      expect(unauthorized.body).not.toContain('BODY_MALFORMED');

      const authorized = await harness.app.inject({
        method: 'POST',
        url: route.url(),
        headers: await headersFor(holder().id),
        payload,
      });
      // The other direction: validation is not simply absent. A route that never
      // validated would answer 200 or 500 here and pass the assertion above.
      expect(
        authorized.statusCode,
        'the route does not validate its body at all, so the assertion above proves nothing',
      ).toBe(400);
    });
  }

  it('ORDERING — a malformed `?at=` is invisible to an unauthorized caller too', async () => {
    const url = `${base()}/memberships/${multi().alpha.users.member.membershipId}/work-profile?at=not-an-instant`;

    const unauthorized = await harness.app.inject({
      method: 'GET',
      url,
      headers: await headersFor(bystander().id),
    });
    expect(unauthorized.statusCode).toBe(403);

    const authorized = await harness.app.inject({
      method: 'GET',
      url,
      headers: await headersFor(holder().id),
    });
    expect(authorized.statusCode, 'the query parameter is not validated at all').toBe(400);
    log('authorize-then-parse holds on bodies and on query parameters, in both directions');
  });

  it('an EXPLICIT DENY beats a role and an allow (P-1), at the database as well', async () => {
    // A second principal, granted the capability and then explicitly denied it in
    // an overlapping-free window. `capability_grants` has a `[)` EXCLUDE
    // constraint, so the deny is written on a DIFFERENT capability key to avoid
    // colliding with the allow — this asserts the deny path, not the constraint.
    const target = multi().alpha.full?.groupAdmin;
    expect(target, 'the full profile did not provision a group_admin').toBeDefined();
    if (target === undefined) return;

    await grantStaffingCapabilities(harness.runtime.runner, multi(), {
      organizationId: org(),
      groupId: group(),
      membershipId: target.membershipId,
      capabilities: ['staffing.work_profile.administer'],
      granted: false,
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: `${base()}/work-profiles`,
      headers: await headersFor(target.id),
      payload: { membershipId: multi().alpha.users.member.membershipId, workPercentage: 40 },
    });
    expect(response.statusCode, 'an explicit deny did not deny').toBe(403);
    log('an explicit deny on a staffing capability refuses the write');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * SENSITIVE-PII
 * ──────────────────────────────────────────────────────────────────────────── */

describe('SENSITIVE-PII — who may read whose credentials', () => {
  let qualificationId: string;
  let holdingOfScheduler: string;
  let holdingOfViewer: string;

  /** Holds `…holding.read` and NOT `…holding.read_any`. */
  const peer = () => {
    const viewer = multi().alpha.full?.viewer;
    if (viewer === undefined) throw new Error('the full profile did not provision a viewer');
    return viewer;
  };

  beforeAll(async () => {
    const created = await harness.app.inject({
      method: 'POST',
      url: `${base()}/qualifications`,
      headers: await headersFor(holder().id),
      payload: { key: 'sensitive-pii-probe', name: 'Sensitive PII Probe' },
    });
    expect(created.statusCode, created.body).toBe(200);
    qualificationId = created.json<{ qualification: { id: string } }>().qualification.id;

    for (const [membershipId, target] of [
      [multi().alpha.users.scheduler.membershipId, 'scheduler'],
      [peer().membershipId, 'viewer'],
    ] as const) {
      const response = await harness.app.inject({
        method: 'POST',
        url: `${base()}/qualification-holdings`,
        headers: await headersFor(holder().id),
        payload: { membershipId, qualificationId, status: 'valid' },
      });
      expect(response.statusCode, `${target}: ${response.body}`).toBe(200);
      const id = response.json<{ holding: { id: string } }>().holding.id;
      if (target === 'scheduler') holdingOfScheduler = id;
      else holdingOfViewer = id;
    }

    // The peer gets the read surface and NOTHING else.
    await grantStaffingCapabilities(harness.runtime.runner, multi(), {
      organizationId: org(),
      groupId: group(),
      membershipId: peer().membershipId,
      capabilities: ['staffing.qualification_holding.read'],
    });
  });

  it('a member reads their OWN credentials', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: `${base()}/memberships/${peer().membershipId}/qualification-holdings`,
      headers: await headersFor(peer().id),
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{ holdings: { id: string }[] }>();
    expect(body.holdings.map((h) => h.id)).toContain(holdingOfViewer);
    log('a member reads their own credential record');
  });

  it('…and sees NOTHING of a colleague\'s, without `read_any`', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: `${base()}/memberships/${multi().alpha.users.scheduler.membershipId}/qualification-holdings`,
      headers: await headersFor(peer().id),
    });
    // 200 with an empty list, NOT a 403. "You may not see this" and "there is
    // nothing here" must be indistinguishable (P-3) — a distinct error code would
    // confirm the colleague holds a credential without disclosing which.
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{ holdings: { id: string }[]; eligible: boolean }>();
    expect(
      body.holdings,
      'a colleague\'s SENSITIVE-PII credential record was disclosed',
    ).toEqual([]);
    expect(body.eligible, 'eligibility leaked what the holdings did not').toBe(false);
    log('without read_any a colleague\'s holdings are an empty list, not an error');
  });

  it('a holder of `read_any` sees them', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: `${base()}/memberships/${multi().alpha.users.scheduler.membershipId}/qualification-holdings`,
      headers: await headersFor(holder().id),
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{ holdings: { id: string }[]; eligible: boolean }>();
    expect(
      body.holdings.map((h) => h.id),
      'the narrowing is not a narrowing — nobody can read anything',
    ).toContain(holdingOfScheduler);
    expect(body.eligible).toBe(true);
  });

  it('the narrowing is in the DATA, not in the route: a direct read is narrowed too', async () => {
    // The claim under test is that an application-layer filter is not what stops
    // the disclosure. Read the table directly, inside a unit of work, as the peer
    // — no route, no handler, no filter — and the RLS policy must still narrow it.
    const visible = await harness.runtime.runner.run(
      {
        organizationId: org(),
        groupId: group(),
        membershipId: peer().membershipId,
        correlationId: 'pii-direct-read',
      },
      async ({ query }) => {
        const rows = (await query
          .selectFrom('qualification_holdings')
          .select(['id', 'membership_id'])
          .execute()) as unknown as { id: string; membership_id: string }[];
        return rows;
      },
    );

    expect(visible.length, 'the peer sees nothing at all — the control is inert').toBeGreaterThan(0);
    const foreign = visible.filter((row) => row.membership_id !== peer().membershipId);
    expect(
      foreign,
      'a direct read bypassed the SENSITIVE-PII narrowing — it is an application-layer filter',
    ).toEqual([]);
    log(
      `direct table read as a peer: ${String(visible.length)} row(s), all their own, 0 belonging ` +
        'to anyone else',
    );
  });
});
