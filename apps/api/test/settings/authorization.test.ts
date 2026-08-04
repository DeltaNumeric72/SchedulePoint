import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PICKLIST_ACCESS_MODES, REQUEST_UNTIL_MODES } from '@schedulepoint/contracts';

import { capabilityRouteConfig } from '../../src/http/policy.js';
import { buildServer } from '../../src/http/server.js';
import { SETTINGS_CAPABILITY_KEYS } from '../../src/settings/policies.js';
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
import { labelledLocationBody, locationBody } from '../support/settings.js';

/**
 * **Allow AND deny, for every capability this slice introduces** (packet 32
 * §10c: "Settings mutations capability-gated (allow AND deny), audited,
 * group-scoped (cross-group denial)").
 *
 * ## The three keys, and why a pass on one says nothing about the others
 *
 * | Capability | Held by | NOT held by |
 * |---|---|---|
 * | `group.settings.administer` | `group_admin` | **`scheduler`**, member, viewer |
 * | `group.timezone.administer` | `group_admin` | **`scheduler`**, member, viewer |
 * | `group.location.administer` | `group_admin` | **`scheduler`**, member, viewer |
 *
 * Every deny actor below is `scheduler` — a role that is authorized for the
 * catalogue, for rules and for schedule authoring, and is `—` on doc 08 §6's
 * "Group settings" row. A deny test using `member` would pass while all three
 * keys were silently role-implied for schedulers, which is the mistake the whole
 * arrangement exists to prevent.
 *
 * ## An ALLOW control comes first, every time
 *
 * FAD-15 vacuity discipline: a deny test whose subject does not exist denies for
 * the wrong reason and passes anyway. Every deny is preceded by the same request
 * succeeding for a group administrator against the same route and the same body
 * shape, so a 403 can only mean the capability gate.
 *
 * ## The layer each denial comes from is asserted, not assumed
 *
 * SPEC-06 P-5/P-6: a denial at L0–L2 is a `404` (the module's existence is not
 * disclosed) and a denial at L3–L6 is a `403`. Both arms are exercised.
 */

const multi = ownedMulti('settings-authorization', { profile: 'full' });

let harness: HttpHarness;
let admin: pg.Client;

const alpha = () => multi().alpha;
const groupAdmin = () => {
  const value = multi().alpha.full?.groupAdmin;
  if (value === undefined) throw new Error('the full profile provisions a group admin');
  return value;
};
const gamma = () => {
  const value = multi().gamma;
  if (value === undefined) throw new Error('the full profile provisions Gamma; it is missing');
  return value;
};

const base = (organizationId: string, groupId: string): string =>
  `/organizations/${organizationId}/groups/${groupId}/settings`;

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

async function call(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  userId: string,
  path: string,
  body?: unknown,
  groupId = alpha().groupOne.id,
  organizationId = alpha().organizationId,
): Promise<{ statusCode: number; body: string }> {
  const response = await harness.app.inject({
    method,
    url: `${base(organizationId, groupId)}${path}`,
    headers: {
      ...contextHeaders(userId, await countersFor(userId, groupId, organizationId)),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  return { statusCode: response.statusCode, body: response.body };
}

/** The group's current `group_version`, which every settings write must echo. */
async function currentVersion(userId = groupAdmin().id): Promise<number> {
  const response = await call('GET', userId, '');
  expect(response.statusCode, response.body).toBe(200);
  return (JSON.parse(response.body) as { version: number }).version;
}

let locationSequence = 0;
function uniqueLabel(prefix: string): string {
  locationSequence += 1;
  return `${prefix}-${String(locationSequence)}`;
}

describe('the settings routes are declared, and the gate can see them', () => {
  it('every capability this slice introduces is reachable through a registered route', async () => {
    const { app, routeTable } = await buildServer();
    try {
      const declared = new Set(
        routeTable
          .map((entry) => capabilityRouteConfig(entry.config)?.action.key)
          .filter((key): key is string => key !== undefined),
      );

      for (const key of SETTINGS_CAPABILITY_KEYS) {
        expect(declared.has(key), `${key} is declared by at least one route`).toBe(true);
      }
      log(`      · ${String(SETTINGS_CAPABILITY_KEYS.length)} settings keys, all route-reachable`);
    } finally {
      await app.close();
    }
  });
});

describe('group.settings.administer — allow and deny', () => {
  it('ALLOW: a group administrator reads the settings', async () => {
    /* Asserts the SHAPE, not the values.
     *
     * The first version asserted `{ mode: 'closed' }` and `'disabled'` here —
     * the defaults — and `pnpm fixture-regression` failed it on every fixed
     * seed. Under test-order shuffle the picklist-access write below runs
     * FIRST, so this test was reading whatever a sibling test had left behind.
     * That is exactly the coupling FAD-15's shuffled run exists to find, and it
     * was in this packet's own file.
     *
     * The defaults claim is worth keeping, so it moved to its own test against
     * a group this file never writes to — which is a stronger claim anyway,
     * because it is about the schema's defaults rather than about whatever
     * happened to run last. */
    const response = await call('GET', groupAdmin().id, '');
    expect(response.statusCode, response.body).toBe(200);

    const settings = JSON.parse(response.body) as Record<string, unknown>;
    expect(REQUEST_UNTIL_MODES as readonly string[]).toContain(
      (settings['requestUntil'] as { mode: string }).mode,
    );
    expect(PICKLIST_ACCESS_MODES as readonly string[]).toContain(settings['picklistAccessMode']);
    expect(typeof settings['timezone']).toBe('string');
    expect(typeof settings['version']).toBe('number');
    log('group_admin → GET /settings → 200, every field in its closed vocabulary');
  });

  it('the defaults a group is created with are the SAFE ones', async () => {
    /* Read from Alpha's Group TWO, which no test in this file writes to, and
     * read as ground truth rather than through the API — the claim is about the
     * COLUMN DEFAULTS migration 0010 declares, and it must not depend on any
     * test having run or not run.
     *
     * Why it matters: `disabled` is the default because a setting whose default
     * widened anything would be a capability expansion arriving through a
     * migration (non-bypass rule 11), and `closed` is the default because a
     * request window nobody has configured must not read as one somebody
     * opened. */
    const { rows } = await admin.query<{
      request_until_mode: string;
      request_until_date: string | null;
      request_until_lead_days: number | null;
      picklist_access_mode: string;
      settings_version: number;
    }>(
      `select request_until_mode, request_until_date, request_until_lead_days,
              picklist_access_mode, settings_version
         from groups where id = $1 and organization_id = $2`,
      [alpha().groupTwo.id, alpha().organizationId],
    );

    expect(rows, 'the untouched sibling group exists').toHaveLength(1);
    expect(rows[0]?.request_until_mode).toBe('closed');
    expect(rows[0]?.request_until_date).toBeNull();
    expect(rows[0]?.request_until_lead_days).toBeNull();
    expect(rows[0]?.picklist_access_mode).toBe('disabled');
    expect(rows[0]?.settings_version).toBe(1);
    log('defaults on an untouched group: closed / disabled / version 1');
  });

  it('ALLOW: a group administrator sets a fixed-date request window', async () => {
    const response = await call('PUT', groupAdmin().id, '/request-until', {
      policy: { mode: 'fixed_date', untilDate: '2031-12-18' },
      expectedVersion: await currentVersion(),
    });
    expect(response.statusCode, response.body).toBe(204);

    const read = await call('GET', groupAdmin().id, '');
    expect(JSON.parse(read.body)).toMatchObject({
      requestUntil: { mode: 'fixed_date', untilDate: '2031-12-18' },
    });
    log('group_admin → PUT /request-until → 204, read back as fixed_date');
  });

  it('DENY: a SCHEDULER gets 403 — authorized for the catalogue, not for group settings', async () => {
    // The distinguishing test. `scheduler` holds `schedule.catalogue.administer`,
    // `schedule.period.administer` and `schedule.version.edit`; doc 08 §6 marks
    // it `—` on the "Group settings" row, so it must be refused here or the
    // whole key split is decorative.
    const response = await call('PUT', alpha().users.scheduler.id, '/request-until', {
      policy: { mode: 'closed' },
      expectedVersion: 1,
    });
    expect(response.statusCode, response.body).toBe(403);
    // P-3 and SPEC-01 §2.4: no reason, no layer, no capability on the wire.
    expect(response.body).not.toContain('capability');
    expect(response.body).not.toContain('NO_CAPABILITY');
    log('scheduler → PUT /request-until → 403, no explanation on the wire');
  });

  it('DENY: a scheduler cannot even READ the settings', async () => {
    const response = await call('GET', alpha().users.scheduler.id, '');
    expect(response.statusCode, response.body).toBe(403);
    log('scheduler → GET /settings → 403 (deny-by-default: there is no read key)');
  });

  it('DENY: a member gets 403 on the picklist-access route', async () => {
    const response = await call('PUT', alpha().users.member.id, '/picklist-access', {
      mode: 'members',
      expectedVersion: 1,
    });
    expect(response.statusCode, response.body).toBe(403);
    log('member → PUT /picklist-access → 403');
  });

  it('ALLOW: a group administrator sets the picklist-access mode', async () => {
    const response = await call('PUT', groupAdmin().id, '/picklist-access', {
      mode: 'members_and_proxies',
      expectedVersion: await currentVersion(),
    });
    expect(response.statusCode, response.body).toBe(204);

    const read = await call('GET', groupAdmin().id, '');
    expect(JSON.parse(read.body)).toMatchObject({ picklistAccessMode: 'members_and_proxies' });
    log('group_admin → PUT /picklist-access → 204');
  });

  it('a malformed body from an UNAUTHORIZED actor is a denial, not a 422', async () => {
    /* The disclosure-ordering control, and the reason the body is parsed inside
     * the unit of work AFTER the authorization decision. Parsing first meant an
     * actor holding nothing here could send `{}` and receive a body-shaped
     * refusal describing the fields the route expects, while a genuinely absent
     * route answers `404` (SPEC-01 §2.4, SPEC-06 P-3; found by SBX-001). */
    const denied = await call('PUT', alpha().users.scheduler.id, '/request-until', {});
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.body).not.toContain('VALIDATION_FAILED');
    expect(denied.body).not.toContain('problems');
    expect(denied.body).not.toContain('expectedVersion');

    // The ALLOW control: the SAME empty body from an AUTHORIZED actor DOES get
    // the field-addressed 422 — so the 403 is the authorization gate and not
    // simply "this route never returns 422".
    const authorized = await call('PUT', groupAdmin().id, '/request-until', {});
    expect(authorized.statusCode, authorized.body).toBe(422);
    expect(authorized.body).toContain('VALIDATION_FAILED');
    log('unauthorized + malformed → 403; authorized + malformed → 422 with fields');
  });

  it('DENY at L1: an organization with no core_scheduling entitlement gets 404, not 403', async () => {
    // P-5: "a denial at L0–L2 is reported as 404. Existence of an unentitled
    // module is not disclosed." Gamma is administrable but unentitled, so the
    // SAME shape of request that 403s above 404s here.
    const response = await call(
      'GET',
      gamma().users.scheduler.id,
      '',
      undefined,
      gamma().groupOne.id,
      gamma().organizationId,
    );
    expect(response.statusCode, response.body).toBe(404);
    log('unentitled organization → GET /settings → 404 (L1, not L4)');
  });
});

describe('group.timezone.administer — allow and deny', () => {
  it('ALLOW: a group administrator changes the timezone', async () => {
    const response = await call('PUT', groupAdmin().id, '/timezone', {
      timezone: 'America/Toronto',
      expectedVersion: await currentVersion(),
      acknowledgePublishedImpact: true,
    });
    expect(response.statusCode, response.body).toBe(204);

    const read = await call('GET', groupAdmin().id, '');
    expect(JSON.parse(read.body)).toMatchObject({ timezone: 'America/Toronto' });
    log('group_admin → PUT /timezone → 204');
  });

  it('DENY: a scheduler gets 403 on the timezone route', async () => {
    const response = await call('PUT', alpha().users.scheduler.id, '/timezone', {
      timezone: 'UTC',
      expectedVersion: 1,
    });
    expect(response.statusCode, response.body).toBe(403);
    log('scheduler → PUT /timezone → 403');
  });

  it('refuses a zone the platform does not recognise, with the field named', async () => {
    const response = await call('PUT', groupAdmin().id, '/timezone', {
      timezone: 'Not/A_Real_Zone',
      expectedVersion: await currentVersion(),
    });
    expect(response.statusCode, response.body).toBe(422);
    expect(response.body).toContain('timezone');
    log('group_admin → PUT /timezone with a fabricated zone → 422');
  });
});

describe('group.location.administer — allow and deny', () => {
  it('ALLOW: a group administrator creates a location', async () => {
    const response = await call('POST', groupAdmin().id, '/locations', locationBody(uniqueLabel('A')));
    expect(response.statusCode, response.body).toBe(200);
    const created = JSON.parse(response.body) as { location: { siteLabel: string | null } };
    expect(created.location.siteLabel).toBeNull();
    log('group_admin → POST /locations → 200');
  });

  it('ALLOW: a location may carry the free-form site label (PO-DEC-01 default)', async () => {
    const response = await call(
      'POST',
      groupAdmin().id,
      '/locations',
      labelledLocationBody(uniqueLabel('B'), 'Synthetic campus north'),
    );
    expect(response.statusCode, response.body).toBe(200);
    const created = JSON.parse(response.body) as { location: Record<string, unknown> };
    expect(created.location['siteLabel']).toBe('Synthetic campus north');
    // The label is a STRING and nothing else: no id was minted for it, and the
    // response body contains no site resource of any kind (non-bypass rule 12).
    expect(Object.keys(created.location)).not.toContain('siteId');
    expect(response.body).not.toContain('siteId');
    log('group_admin → POST /locations with a site label → 200, no site resource anywhere');
  });

  it('DENY: a scheduler gets 403 creating a location', async () => {
    const response = await call(
      'POST',
      alpha().users.scheduler.id,
      '/locations',
      locationBody(uniqueLabel('C')),
    );
    expect(response.statusCode, response.body).toBe(403);
    log('scheduler → POST /locations → 403');
  });

  it('DENY: a viewer cannot list locations', async () => {
    const viewer = alpha().full?.viewer;
    if (viewer === undefined) throw new Error('the full profile provisions a viewer');
    const response = await call('GET', viewer.id, '/locations');
    expect(response.statusCode, response.body).toBe(403);
    log('viewer → GET /locations → 403');
  });

  it('RED: a location created in Group One is invisible from Group Two', async () => {
    /* The cross-GROUP denial the packet names as a key proof.
     *
     * The actor is the SAME principal in both groups — `groupAdmin` is a Group
     * One membership, and `alpha.users.scheduler` holds a Group Two membership —
     * so this is not "a different person sees nothing", which any
     * authentication would give. It is the CAR-001 defect class: one principal,
     * two declared contexts, and the row must not follow the principal.
     *
     * The ALLOW control is the create above; the row demonstrably exists.
     */
    const label = uniqueLabel('XGROUP');
    const created = await call('POST', groupAdmin().id, '/locations', locationBody(label));
    expect(created.statusCode, created.body).toBe(200);
    const locationId = (JSON.parse(created.body) as { location: { locationId: string } }).location
      .locationId;

    // Group One sees it — the control that makes the next assertion meaningful.
    const visible = await call('GET', groupAdmin().id, '/locations');
    expect(visible.statusCode, visible.body).toBe(200);
    expect(visible.body).toContain(locationId);

    // Group Two, same organization: a group administrator there would see zero
    // of Group One's rows. There is no group_admin in Group Two in this fixture,
    // so the assertion is made at the DATABASE level under a Group Two context
    // — the layer that must hold regardless of which role asks.
    const { rows } = await admin.query<{ count: string }>(
      `select count(*)::text as count from locations
        where organization_id = $1 and group_id = $2 and id = $3`,
      [alpha().organizationId, alpha().groupTwo.id, locationId],
    );
    expect(rows[0]?.count, 'the row belongs to Group One only').toBe('0');

    // And the PATCH route cannot reach it from Group Two's context either: the
    // row is invisible to the group predicate, so the answer is the same 404 a
    // never-existing id gets (T-05b).
    const fromGroupTwo = await call(
      'PATCH',
      alpha().users.scheduler.id,
      `/locations/${locationId}`,
      { name: 'Moved', expectedVersion: 1 },
      alpha().groupTwo.id,
    );
    // The scheduler is denied before the row is ever looked for, which is the
    // correct order: authorization first, existence never disclosed.
    expect([403, 404]).toContain(fromGroupTwo.statusCode);
    log('cross-group: created in Group One, zero rows and no reach from Group Two');
  });

  it('archiving is a status move, and the row survives it', async () => {
    const created = await call(
      'POST',
      groupAdmin().id,
      '/locations',
      locationBody(uniqueLabel('ARCH')),
    );
    expect(created.statusCode, created.body).toBe(200);
    const location = (JSON.parse(created.body) as { location: { locationId: string; version: number } })
      .location;

    const archived = await call('PATCH', groupAdmin().id, `/locations/${location.locationId}`, {
      status: 'archived',
      expectedVersion: location.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    expect(JSON.parse(archived.body)).toMatchObject({ location: { status: 'archived' } });

    // Archive, never delete: the row is still there, and still readable.
    const listed = await call('GET', groupAdmin().id, '/locations');
    expect(listed.body).toContain(location.locationId);
    log('location archived → status move, row retained');
  });

  it('a stale expectedVersion loses explicitly with a 409', async () => {
    const created = await call(
      'POST',
      groupAdmin().id,
      '/locations',
      locationBody(uniqueLabel('CAS')),
    );
    const location = (JSON.parse(created.body) as { location: { locationId: string; version: number } })
      .location;

    const first = await call('PATCH', groupAdmin().id, `/locations/${location.locationId}`, {
      name: `Renamed ${uniqueLabel('CAS')}`,
      expectedVersion: location.version,
    });
    expect(first.statusCode, first.body).toBe(200);

    // The second writer read the same version the first did. It must lose, and
    // it must lose LOUDLY — a silent no-op is the lost update the counter exists
    // to prevent.
    const second = await call('PATCH', groupAdmin().id, `/locations/${location.locationId}`, {
      name: `Renamed again ${uniqueLabel('CAS')}`,
      expectedVersion: location.version,
    });
    expect(second.statusCode, second.body).toBe(409);
    log('stale version → 409, not a silent overwrite');
  });
});
