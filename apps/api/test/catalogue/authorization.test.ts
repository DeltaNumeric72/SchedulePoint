import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CATALOGUE_CAPABILITY_KEYS } from '../../src/catalogue/policies.js';
import { capabilityRouteConfig } from '../../src/http/policy.js';
import { buildServer } from '../../src/http/server.js';
import { adminClient } from '../support/admin-client.js';
import { log } from '../support/harness.js';
import {
  buildHttpHarness,
  contextHeaders,
  currentCounters,
  type DeclaredCounters,
  type HttpHarness,
} from '../support/http.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * **Allow AND deny, for every capability this slice introduces** (packet 30:
 * "deny paths tested for **every** new capability").
 *
 * ## The three keys, and why a pass on one says nothing about the others
 *
 * | Capability | Held by | Not held by |
 * |---|---|---|
 * | `schedule.catalogue.administer` | `scheduler`, `group_admin` | `member`, `viewer`, `telecom` |
 * | `group.holiday_calendar.administer` | `group_admin` | **`scheduler`** |
 * | `group.pick_positions.administer` | `group_admin` | **`scheduler`** |
 *
 * The second and third rows are the interesting ones: their deny actor is a role
 * that IS authorized for the rest of the catalogue. A single "an unauthorized
 * role gets 403" test with `member` would pass for all three while the
 * group-settings keys were silently role-implied for schedulers, which is
 * exactly the mistake the three-key split exists to prevent.
 *
 * ## An ALLOW control comes first, every time
 *
 * FAD-15 vacuity discipline: a deny test whose subject does not exist denies for
 * the wrong reason and passes anyway. Every deny below is preceded by the same
 * request succeeding for an authorized actor against the same route and the same
 * body shape, so a 403 can only mean the capability gate.
 *
 * ## The layer each denial comes from is asserted, not assumed
 *
 * SPEC-06 P-5/P-6: a denial at L0–L2 is a `404` (the module's existence is not
 * disclosed) and a denial at L3–L6 is a `403` where the actor already knows the
 * tenant exists. Both arms are exercised — a role that lacks the capability gets
 * `403`, and an organization with no `core_scheduling` entitlement gets `404` on
 * the same route.
 */

const multi = ownedMulti('catalogue-authorization', { profile: 'full' });

let harness: HttpHarness;
let admin: pg.Client;

const alpha = () => multi().alpha;
const gamma = () => {
  const value = multi().gamma;
  if (value === undefined) throw new Error('the full profile provisions Gamma; it is missing');
  return value;
};

const base = (organizationId: string, groupId: string): string =>
  `/organizations/${organizationId}/groups/${groupId}/catalogue`;

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  harness = await buildHttpHarness();
}, 120_000);

afterAll(async () => {
  await harness.close();
  await admin.end();
});

function countersFor(
  userId: string,
  groupId: string,
  organizationId = alpha().organizationId,
): Promise<DeclaredCounters> {
  return currentCounters(admin, { organizationId, groupId, userId });
}

async function post(
  userId: string,
  path: string,
  body: unknown,
  groupId = alpha().groupOne.id,
  organizationId = alpha().organizationId,
): Promise<{ statusCode: number; body: string }> {
  const response = await harness.app.inject({
    method: 'POST',
    url: `${base(organizationId, groupId)}${path}`,
    headers: {
      ...contextHeaders(userId, await countersFor(userId, groupId, organizationId)),
      'content-type': 'application/json',
    },
    payload: JSON.stringify(body),
  });
  return { statusCode: response.statusCode, body: response.body };
}

async function put(
  userId: string,
  path: string,
  body: unknown,
  groupId = alpha().groupOne.id,
): Promise<{ statusCode: number; body: string }> {
  const response = await harness.app.inject({
    method: 'PUT',
    url: `${base(alpha().organizationId, groupId)}${path}`,
    headers: {
      ...contextHeaders(userId, await countersFor(userId, groupId)),
      'content-type': 'application/json',
    },
    payload: JSON.stringify(body),
  });
  return { statusCode: response.statusCode, body: response.body };
}

async function get(
  userId: string,
  path: string,
  groupId = alpha().groupOne.id,
): Promise<{ statusCode: number; body: string }> {
  const response = await harness.app.inject({
    method: 'GET',
    url: `${base(alpha().organizationId, groupId)}${path}`,
    headers: contextHeaders(userId, await countersFor(userId, groupId)),
  });
  return { statusCode: response.statusCode, body: response.body };
}

let sequence = 0;
function uniqueCode(prefix: string): string {
  sequence += 1;
  return `${prefix}${String(sequence)}`;
}

const shiftTypeBody = (code: string) => ({
  code,
  name: `Shift ${code}`,
  startTime: '07:00',
  endTime: '19:00',
});

describe('schedule.catalogue.administer — allow and deny', () => {
  it('ALLOW: a scheduler creates a shift type', async () => {
    const response = await post(
      alpha().users.scheduler.id,
      '/shift-types',
      shiftTypeBody(uniqueCode('ALW')),
    );
    expect(response.statusCode, response.body).toBe(200);
    log('scheduler → POST /shift-types → 200');
  });

  it('DENY: a member — an active membership with a role that holds nothing — gets 403', async () => {
    const response = await post(
      alpha().users.member.id,
      '/shift-types',
      shiftTypeBody(uniqueCode('DNY')),
    );
    expect(response.statusCode, response.body).toBe(403);
    // P-3 and SPEC-01 §2.4: the body carries no reason, no layer, no capability.
    expect(response.body).not.toContain('capability');
    expect(response.body).not.toContain('NO_CAPABILITY');
    log('member → POST /shift-types → 403, no explanation on the wire');
  });

  it('DENY: a viewer gets 403 on the READ route too — reads are gated by the same key', async () => {
    const viewer = multi().alpha.full?.viewer;
    if (viewer === undefined) throw new Error('the full profile provisions a viewer');
    const response = await get(viewer.id, '/shift-types');
    expect(response.statusCode, response.body).toBe(403);
    log('viewer → GET /shift-types → 403 (deny-by-default: there is no read capability yet)');
  });

  it('a malformed body from an UNAUTHORIZED actor is a denial, not a 422', async () => {
    /* The disclosure-ordering control, and the reason the body is parsed inside
     * the unit of work AFTER the authorization decision.
     *
     * Parsing first meant an actor holding nothing in this group could send
     * `{}` and receive a body-shaped refusal describing the fields the route
     * expects, while a genuinely absent route answers `404`. SPEC-01 §2.4 and
     * SPEC-06 P-3 require those two to be indistinguishable to that actor.
     *
     * Found by SBX-001's role × route matrix, which sends `{}` to every
     * registered route as every principal — and it is the precondition that
     * makes SBX-001's `422` class acceptable rather than a leak. */
    const denied = await post(alpha().users.member.id, '/shift-types', {});
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.body).not.toContain('VALIDATION_FAILED');
    // No field names, and no `problems` array: the denial body is the fixed
    // envelope and nothing else. (`"code"` DOES appear — it is the envelope's
    // own error-code key, not the shift type's `code` field.)
    expect(denied.body).not.toContain('problems');
    expect(denied.body).not.toContain('startTime');

    // The ALLOW control: the SAME empty body from an AUTHORIZED actor DOES get
    // the field-addressed 422 — so the 403 above is the authorization gate and
    // not simply "this server never returns 422".
    const authorized = await post(alpha().users.scheduler.id, '/shift-types', {});
    expect(authorized.statusCode, authorized.body).toBe(422);
    expect(authorized.body).toContain('VALIDATION_FAILED');
    log('unauthorized + malformed body → 403; authorized + malformed body → 422 with fields');
  });

  it('DENY at L1: an organization with no core_scheduling entitlement gets 404, not 403', async () => {
    // P-5: "a denial at L0–L2 is reported as 404. Existence of an unentitled
    // module is not disclosed." Gamma is administrable but not entitled to
    // core_scheduling, so the SAME request that 403s for a member 404s here —
    // and the difference is the whole point of evaluating entitlement first.
    const response = await post(
      gamma().users.scheduler.id,
      '/shift-types',
      shiftTypeBody(uniqueCode('ENT')),
      gamma().groupOne.id,
      gamma().organizationId,
    );
    expect(response.statusCode, response.body).toBe(404);
    log('unentitled organization → POST /shift-types → 404 (L1, not L4)');
  });
});

describe('group.holiday_calendar.administer — allow and deny', () => {
  it('ALLOW: a group administrator adds a holiday', async () => {
    const groupAdmin = alpha().full?.groupAdmin;
    if (groupAdmin === undefined) throw new Error('the full profile provisions a group admin');
    // A date this file alone uses, so a shuffled or repeated run cannot collide
    // with another test's holiday on the tenant-qualified unique key.
    const response = await post(groupAdmin.id, '/holidays', {
      holidayDate: '2031-03-01',
      name: 'Synthetic holiday A',
    });
    expect(response.statusCode, response.body).toBe(200);
    log('group_admin → POST /holidays → 200');
  });

  it('DENY: a SCHEDULER gets 403 — authorized for the catalogue, not for group settings', async () => {
    // The distinguishing test. `scheduler` holds `schedule.catalogue.administer`
    // and has just been shown creating a shift type; it must still be refused
    // here, or the three-key split is decorative.
    const response = await post(alpha().users.scheduler.id, '/holidays', {
      holidayDate: '2031-03-02',
      name: 'Synthetic holiday B',
    });
    expect(response.statusCode, response.body).toBe(403);
    log('scheduler → POST /holidays → 403 (holds the catalogue key, not the calendar key)');
  });
});

describe('group.pick_positions.administer — allow and deny', () => {
  it('ALLOW: a group administrator raises the pick-position count', async () => {
    const groupAdmin = alpha().full?.groupAdmin;
    if (groupAdmin === undefined) throw new Error('the full profile provisions a group admin');
    const current = await admin.query<{ pick_position_count: number }>(
      'select pick_position_count from groups where id = $1',
      [alpha().groupOne.id],
    );
    const target = (current.rows[0]?.pick_position_count ?? 0) + 6;

    const response = await put(groupAdmin.id, '/pick-positions', { pickPositionCount: target });
    expect(response.statusCode, response.body).toBe(200);
    expect(JSON.parse(response.body).pickPositionCount).toBe(target);
    log(`group_admin → PUT /pick-positions → 200, count ${String(target)}`);
  });

  it('DENY: a scheduler gets 403', async () => {
    // Read BEFORE, assert unchanged AFTER. The count is monotonic and other
    // tests raise it, so an absolute expectation would be an assertion about
    // which test ran first — the order dependence `pnpm fixture-regression`
    // found on the first shuffled run.
    const storedCount = async (): Promise<number | undefined> => {
      const result = await admin.query<{ pick_position_count: number }>(
        'select pick_position_count from groups where id = $1',
        [alpha().groupOne.id],
      );
      return result.rows[0]?.pick_position_count;
    };
    const before = await storedCount();

    const response = await put(alpha().users.scheduler.id, '/pick-positions', {
      pickPositionCount: (before ?? 0) + 3,
    });
    expect(response.statusCode, response.body).toBe(403);

    // And nothing moved. A 403 that still wrote would be the worst outcome of
    // the three, and it is the one a status-code-only assertion cannot see.
    expect(await storedCount()).toBe(before);
    log('scheduler → PUT /pick-positions → 403, and the stored count is unchanged');
  });
});

describe('every capability this slice introduces is reachable and gated', () => {
  it('each key appears on at least one REGISTERED route', async () => {
    // Read from the server's own route table rather than from the config
    // objects: a config that no route uses would satisfy a check over the
    // configs and gate nothing at all.
    const { app, routeTable } = await buildServer();
    try {
      const declared = new Set(
        routeTable
          .map((entry) => capabilityRouteConfig(entry.config)?.action.key)
          .filter((key): key is string => key !== undefined),
      );
      for (const key of CATALOGUE_CAPABILITY_KEYS) {
        expect(declared, `${key} is declared by no registered route`).toContain(key);
      }
      log(`${String(CATALOGUE_CAPABILITY_KEYS.length)} catalogue capabilities, each on a live route`);
    } finally {
      await app.close();
    }
  });
});
