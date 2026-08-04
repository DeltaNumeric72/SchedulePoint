import { AUDIT_EVENT_NAMES, AUDIT_SUBJECT_TYPES } from '@schedulepoint/domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { verifyAuditChain } from '../../src/audit/verification.js';
import { SETTINGS_AUDIT_EVENTS } from '../../src/settings/policies.js';
import { adminClient } from '../support/admin-client.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import {
  buildHttpHarness,
  contextHeaders,
  currentCounters,
  type HttpHarness,
} from '../support/http.js';
import { ownedMulti } from '../support/owned-multi.js';
import { labelledLocationBody, locationBody } from '../support/settings.js';

/**
 * **Every settings mutation lands exactly one audit row, in the same
 * transaction, under a name from the closed vocabulary** (packet 32 §10c:
 * "Settings mutations capability-gated (allow AND deny), **audited**").
 *
 * ## Why this is driven over HTTP rather than scanned
 *
 * The same reason the catalogue's equivalent is: this slice's writes live in
 * `src/settings/service.ts` and its audit emission in
 * `src/http/routes/settings.route.ts`, so a regex over either file alone reports
 * the wrong answer about the pair. Extending the emission scanner's root list
 * would make it fail for a true system, which is the worst kind of gate change.
 *
 * So coverage is asserted empirically, which is stronger: **every one of the six
 * declared event names is DRIVEN through its real route** and the resulting row
 * is read back from `audit_events`. A name nothing emits fails here, and a
 * mutation that emits nothing fails here.
 *
 * ## The payload assertions are the I-07 half
 *
 * A settings payload may carry identifiers, closed tokens and counts, and
 * nothing else — `assertClosedAuditPayload` and the
 * `app_audit_payload_is_closed` CHECK both refuse a string with a space in it.
 * The site label is deliberately NOT in any payload: it is free text a person
 * typed, and `hasSiteLabel` is the fact an audit query actually needs.
 */

const multi = ownedMulti('settings-audit', { profile: 'full' });

let admin: pg.Client;
let harness: HttpHarness;
let runtime: Runtime;

const alpha = () => multi().alpha;
const groupAdmin = () => {
  const value = multi().alpha.full?.groupAdmin;
  if (value === undefined) throw new Error('the full profile provisions a group admin');
  return value;
};
const base = () =>
  `/organizations/${alpha().organizationId}/groups/${alpha().groupOne.id}/settings`;

async function request(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  path: string,
  payload?: unknown,
): Promise<{ statusCode: number; body: string }> {
  const counters = await currentCounters(admin, {
    organizationId: alpha().organizationId,
    groupId: alpha().groupOne.id,
    userId: groupAdmin().id,
  });
  const response = await harness.app.inject({
    method,
    url: `${base()}${path}`,
    headers: {
      ...contextHeaders(groupAdmin().id, counters),
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
  return { statusCode: response.statusCode, body: response.body };
}

async function currentVersion(): Promise<number> {
  const response = await request('GET', '');
  expect(response.statusCode, response.body).toBe(200);
  return (JSON.parse(response.body) as { version: number }).version;
}

interface AuditRow {
  event_name: string;
  subject_type: string;
  subject_id: string;
  payload: Record<string, unknown>;
}

async function eventsSince(sequence: number): Promise<AuditRow[]> {
  const result = await admin.query<AuditRow>(
    `select event_name, subject_type, subject_id::text as subject_id, payload
       from audit_events where organization_id = $1 and sequence > $2 order by sequence`,
    [alpha().organizationId, sequence],
  );
  return result.rows;
}

async function headSequence(): Promise<number> {
  const result = await admin.query<{ head: string | null }>(
    'select max(sequence)::text as head from audit_events where organization_id = $1',
    [alpha().organizationId],
  );
  return Number(result.rows[0]?.head ?? 0);
}

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  harness = await buildHttpHarness();
  runtime = createRuntime('app_runtime', { max: 3 });
}, 180_000);

afterAll(async () => {
  await runtime.destroy();
  await harness.close();
  await admin.end();
});

describe('the settings audit vocabulary', () => {
  it('every declared event name is in the closed vocabulary', () => {
    for (const name of Object.values(SETTINGS_AUDIT_EVENTS)) {
      expect(AUDIT_EVENT_NAMES as readonly string[], `${name} is declared`).toContain(name);
    }
    // Non-vacuous: six names, and the count is asserted so a name silently
    // dropped from the record fails here rather than reducing the loop above to
    // nothing.
    expect(Object.keys(SETTINGS_AUDIT_EVENTS)).toHaveLength(6);
  });

  it('`location` is a declared subject type, and the group settings file under `group`', () => {
    expect(AUDIT_SUBJECT_TYPES as readonly string[]).toContain('location');
    // The three group-settings events use the EXISTING `group` subject, because
    // a request window, a picklist mode and a timezone are properties OF the
    // group — "everything that happened to this group" must return them.
    expect(AUDIT_SUBJECT_TYPES as readonly string[]).toContain('group');
  });
});

describe('every settings mutation emits exactly one audit row', () => {
  it('drives all six routes and reads back one row each, with the right subject', async () => {
    /* Every requested value is chosen RELATIVE to what the group currently
     * holds, and that is a correctness requirement rather than tidiness.
     *
     * A no-op write is now deliberately silent (NB-1), so a fixed request value
     * that happens to equal the stored one produces five rows instead of six.
     * `pnpm fixture-regression` caught exactly that after the NB-1 change — six
     * seeds failed, each missing `settings.picklist_access.changed`, because
     * under test-order shuffle the NB-1 control had already left the mode at
     * `members`. Picking against the current state makes "six mutations produce
     * six rows" true in every order. */
    const before = JSON.parse((await request('GET', '')).body) as {
      requestUntil: { mode: string; leadDays?: number };
      picklistAccessMode: string;
      timezone: string;
    };

    const leadDays =
      before.requestUntil.mode === 'days_before_period_start' &&
      before.requestUntil.leadDays === 14
        ? 13
        : 14;
    const picklistMode = before.picklistAccessMode === 'members' ? 'members_and_proxies' : 'members';
    const zone = before.timezone === 'Europe/Dublin' ? 'Europe/Brussels' : 'Europe/Dublin';

    const marker = await headSequence();

    // 1. request-until
    expect((await request('PUT', '/request-until', {
      policy: { mode: 'days_before_period_start', leadDays },
      expectedVersion: await currentVersion(),
    })).statusCode).toBe(204);

    // 2. picklist access
    expect((await request('PUT', '/picklist-access', {
      mode: picklistMode,
      expectedVersion: await currentVersion(),
    })).statusCode).toBe(204);

    // 3. timezone
    expect((await request('PUT', '/timezone', {
      timezone: zone,
      expectedVersion: await currentVersion(),
      acknowledgePublishedImpact: true,
    })).statusCode).toBe(204);

    // 4. location created
    const created = await request('POST', '/locations', locationBody('audit-a'));
    expect(created.statusCode, created.body).toBe(200);
    const location = (JSON.parse(created.body) as {
      location: { locationId: string; version: number };
    }).location;

    // 5. location updated
    const updated = await request('PATCH', `/locations/${location.locationId}`, {
      siteLabel: 'Synthetic campus east',
      expectedVersion: location.version,
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const updatedVersion = (JSON.parse(updated.body) as { location: { version: number } }).location
      .version;

    // 6. location archived — its OWN name, not a generic update
    const archived = await request('PATCH', `/locations/${location.locationId}`, {
      status: 'archived',
      expectedVersion: updatedVersion,
    });
    expect(archived.statusCode, archived.body).toBe(200);

    const rows = await eventsSince(marker);
    const names = rows.map((row) => row.event_name);

    // Exactly six mutations, exactly six rows: no mutation is silent, and none
    // emits twice.
    expect(rows, `rows: ${names.join(', ')}`).toHaveLength(6);
    expect(names).toEqual([
      SETTINGS_AUDIT_EVENTS.requestUntilChanged,
      SETTINGS_AUDIT_EVENTS.picklistAccessChanged,
      SETTINGS_AUDIT_EVENTS.timezoneChanged,
      SETTINGS_AUDIT_EVENTS.locationCreated,
      SETTINGS_AUDIT_EVENTS.locationUpdated,
      SETTINGS_AUDIT_EVENTS.locationArchived,
    ]);

    // Subjects: the group for the three settings, the location for the three
    // location events.
    expect(rows.slice(0, 3).map((row) => row.subject_type)).toEqual(['group', 'group', 'group']);
    expect(rows.slice(0, 3).every((row) => row.subject_id === alpha().groupOne.id)).toBe(true);
    expect(rows.slice(3).map((row) => row.subject_type)).toEqual([
      'location',
      'location',
      'location',
    ]);
    expect(rows.slice(3).every((row) => row.subject_id === location.locationId)).toBe(true);

    log(`six settings mutations → six audit rows: ${names.join(', ')}`);
  });

  it('a DENIED mutation writes neither the change nor an audit row', async () => {
    /* FAD-12's ordering, from the other side: the evaluation is first so a
     * denial writes neither the change nor a row claiming one. A slice that
     * audited before it evaluated would leave a trail of events for actions that
     * never happened — which reads as authoritative afterwards. */
    const marker = await headSequence();

    const counters = await currentCounters(admin, {
      organizationId: alpha().organizationId,
      groupId: alpha().groupOne.id,
      userId: alpha().users.scheduler.id,
    });
    const response = await harness.app.inject({
      method: 'PUT',
      url: `${base()}/picklist-access`,
      headers: {
        ...contextHeaders(alpha().users.scheduler.id, counters),
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ mode: 'members_and_proxies', expectedVersion: 1 }),
    });
    expect(response.statusCode).toBe(403);

    expect(await eventsSince(marker), 'a denial writes no audit row').toHaveLength(0);
    log('denied mutation → 403, zero audit rows');
  });
});

describe('the payloads carry scalars only (I-07)', () => {
  it('the request-until payload names the mode and its one populated field', async () => {
    const marker = await headSequence();
    expect((await request('PUT', '/request-until', {
      policy: { mode: 'fixed_date', untilDate: '2032-01-15' },
      expectedVersion: await currentVersion(),
    })).statusCode).toBe(204);

    const [row] = await eventsSince(marker);
    expect(row?.payload).toEqual({ mode: 'fixed_date', untilDate: '2032-01-15' });
    log('request-until payload: mode + untilDate, both closed tokens');
  });

  it('the timezone payload records what the change was made OVER', async () => {
    const marker = await headSequence();
    const before = await currentVersion();
    expect((await request('PUT', '/timezone', {
      timezone: 'Australia/Perth',
      expectedVersion: before,
      acknowledgePublishedImpact: true,
    })).statusCode).toBe(204);

    const [row] = await eventsSince(marker);
    const payload = row?.payload ?? {};
    // The warning, recorded. Zone names are printable ASCII with no space, which
    // is exactly what the closed-payload rules admit.
    expect(payload['toTimezone']).toBe('Australia/Perth');
    expect(typeof payload['fromTimezone']).toBe('string');
    expect(typeof payload['publishedVersionCount']).toBe('number');
    expect(typeof payload['publishedImpactAcknowledged']).toBe('boolean');
    log(
      `timezone payload: ${String(payload['fromTimezone'])} → ${String(payload['toTimezone'])}, ` +
        `over ${String(payload['publishedVersionCount'])} published version(s)`,
    );
  });

  it('the site LABEL never reaches the audit payload — only whether one was set', async () => {
    /* The label is free text a person typed. `app_audit_payload_is_closed`
     * admits `[!-~]*` only, so "Synthetic campus east" could not be stored even
     * if this route tried — but relying on the CHECK to catch it would mean a
     * 500 on a legitimate request. The boolean is the fact an audit query needs
     * and it is what the route sends. */
    const marker = await headSequence();
    const created = await request(
      'POST',
      '/locations',
      labelledLocationBody('audit-b', 'Synthetic campus west'),
    );
    expect(created.statusCode, created.body).toBe(200);

    const [row] = await eventsSince(marker);
    expect(row?.payload).toEqual({ hasSiteLabel: true });
    expect(JSON.stringify(row?.payload)).not.toContain('Synthetic');
    log('location payload: hasSiteLabel only — the label itself never lands');
  });
});

describe('a write that changes nothing is not audited as a change (NB-1)', () => {
  /* The independent review's probe, as its own suite.
   *
   * `PUT /timezone` with the zone the group already has produced
   * `settings.timezone.changed` with identical `from` and `to`. The DATABASE
   * was already right — `app_maintain_group_settings_version` uses
   * `IS DISTINCT FROM`, so `settings_version` did not move — which is exactly
   * what made the audit row wrong: it recorded a transition that did not occur.
   *
   * Each probe below re-sends the value the group ALREADY holds, read in the
   * same test, so it is a true no-op whatever order the file runs in. The
   * write must still SUCCEED (the caller asked for a state and that state
   * holds) and must emit NOTHING. */

  it("PROBE: re-sending the group's current timezone succeeds and emits no event", async () => {
    const current = await request('GET', '');
    const settings = JSON.parse(current.body) as { timezone: string; version: number };

    const marker = await headSequence();
    const response = await request('PUT', '/timezone', {
      timezone: settings.timezone,
      expectedVersion: settings.version,
      acknowledgePublishedImpact: true,
    });

    expect(response.statusCode, response.body).toBe(204);
    expect(await eventsSince(marker), 'a no-op timezone write emitted an event').toHaveLength(0);
    log(`no-op timezone (${settings.timezone} → ${settings.timezone}) → 204, zero audit rows`);
  });

  it('PROBE: re-sending the current request-until policy succeeds and emits no event', async () => {
    const current = await request('GET', '');
    const settings = JSON.parse(current.body) as {
      requestUntil: Record<string, unknown>;
      version: number;
    };

    const marker = await headSequence();
    const response = await request('PUT', '/request-until', {
      policy: settings.requestUntil,
      expectedVersion: settings.version,
    });

    expect(response.statusCode, response.body).toBe(204);
    expect(await eventsSince(marker), 'a no-op request-until write emitted an event').toHaveLength(
      0,
    );
    log(`no-op request-until (${JSON.stringify(settings.requestUntil)}) → 204, zero audit rows`);
  });

  it('PROBE: re-sending the current picklist mode succeeds and emits no event', async () => {
    const current = await request('GET', '');
    const settings = JSON.parse(current.body) as {
      picklistAccessMode: string;
      version: number;
    };

    const marker = await headSequence();
    const response = await request('PUT', '/picklist-access', {
      mode: settings.picklistAccessMode,
      expectedVersion: settings.version,
    });

    expect(response.statusCode, response.body).toBe(204);
    expect(await eventsSince(marker), 'a no-op picklist write emitted an event').toHaveLength(0);
    log(`no-op picklist (${settings.picklistAccessMode}) → 204, zero audit rows`);
  });

  it('PROBE: a location PATCH carrying only `expectedVersion` emits no event', async () => {
    const created = await request('POST', '/locations', locationBody('noop'));
    expect(created.statusCode, created.body).toBe(200);
    const location = (JSON.parse(created.body) as {
      location: { locationId: string; version: number };
    }).location;

    const marker = await headSequence();
    const response = await request('PATCH', `/locations/${location.locationId}`, {
      expectedVersion: location.version,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(await eventsSince(marker), 'a no-op location PATCH emitted an event').toHaveLength(0);

    /* And the counter DID move, which is the distinction being drawn.
     * `app_maintain_catalogue_version` bumps unconditionally so a writer who
     * read version N and wrote nothing still loses to one who read N and wrote
     * something (migration 0005). That is a concurrency property; it is not a
     * statement that the location changed, and the audit stream records the
     * second fact rather than the first. */
    const after = (JSON.parse(response.body) as { location: { version: number } }).location;
    expect(after.version, 'the concurrency counter still moved').toBeGreaterThan(location.version);
    log('no-op location PATCH → 200, version bumped, zero audit rows');
  });

  it('CONTROL: the same four routes DO emit when something actually moves', async () => {
    /* Without this, "zero events" above would be satisfied by four routes that
     * had simply stopped auditing. Each control makes the SMALLEST real change
     * and asserts exactly one row with the right name. */
    const settings = () =>
      request('GET', '').then(
        (r) =>
          JSON.parse(r.body) as {
            timezone: string;
            picklistAccessMode: string;
            version: number;
          },
      );

    let marker = await headSequence();
    const before = await settings();
    const flipped = before.timezone === 'Europe/Lisbon' ? 'Europe/Madrid' : 'Europe/Lisbon';
    expect(
      (await request('PUT', '/timezone', {
        timezone: flipped,
        expectedVersion: before.version,
        acknowledgePublishedImpact: true,
      })).statusCode,
    ).toBe(204);
    expect((await eventsSince(marker)).map((row) => row.event_name)).toEqual([
      SETTINGS_AUDIT_EVENTS.timezoneChanged,
    ]);

    marker = await headSequence();
    const nowSettings = await settings();
    const nextMode =
      nowSettings.picklistAccessMode === 'members' ? 'members_and_proxies' : 'members';
    expect(
      (await request('PUT', '/picklist-access', {
        mode: nextMode,
        expectedVersion: nowSettings.version,
      })).statusCode,
    ).toBe(204);
    expect((await eventsSince(marker)).map((row) => row.event_name)).toEqual([
      SETTINGS_AUDIT_EVENTS.picklistAccessChanged,
    ]);

    marker = await headSequence();
    expect(
      (await request('PUT', '/request-until', {
        policy: { mode: 'days_before_period_start', leadDays: 21 },
        expectedVersion: (await settings()).version,
      })).statusCode,
    ).toBe(204);
    expect((await eventsSince(marker)).map((row) => row.event_name)).toEqual([
      SETTINGS_AUDIT_EVENTS.requestUntilChanged,
    ]);

    const created = await request('POST', '/locations', locationBody('noop-control'));
    const location = (JSON.parse(created.body) as {
      location: { locationId: string; version: number };
    }).location;
    marker = await headSequence();
    expect(
      (await request('PATCH', `/locations/${location.locationId}`, {
        address: '9 Fixture Crescent',
        expectedVersion: location.version,
      })).statusCode,
    ).toBe(200);
    expect((await eventsSince(marker)).map((row) => row.event_name)).toEqual([
      SETTINGS_AUDIT_EVENTS.locationUpdated,
    ]);

    log('control: all four routes still emit exactly one row when something moves');
  });
});

describe('the acknowledgement is READ, never derived (NB-2)', () => {
  it('records what the CLIENT sent, on a path where the derived value would differ', async () => {
    /* The discriminating probe. This fixture has NO published versions, so the
     * route does not require the acknowledgement — and the old code computed
     * `publishedImpactAcknowledged` as `publishedVersionCount > 0`, which is
     * `false` here.
     *
     * A caller who sends `true` anyway is asserting a human act, and the audit
     * row has to say what they said. `false` would be the derived answer and it
     * would be wrong about the request. */
    const before = JSON.parse((await request('GET', '')).body) as {
      publishedVersionCount: number;
      timezone: string;
      version: number;
    };
    expect(before.publishedVersionCount, 'this fixture has no published versions').toBe(0);

    const marker = await headSequence();
    const target = before.timezone === 'Asia/Seoul' ? 'Asia/Tokyo' : 'Asia/Seoul';
    expect(
      (await request('PUT', '/timezone', {
        timezone: target,
        expectedVersion: before.version,
        acknowledgePublishedImpact: true,
      })).statusCode,
    ).toBe(204);

    const [row] = await eventsSince(marker);
    expect(row?.event_name).toBe(SETTINGS_AUDIT_EVENTS.timezoneChanged);
    expect(row?.payload['publishedVersionCount']).toBe(0);
    expect(
      row?.payload['publishedImpactAcknowledged'],
      'the payload must carry the CLIENT\'s field, not `count > 0`',
    ).toBe(true);
    log('acknowledgement read from the request: sent true over 0 published versions, recorded true');
  });

  it('records `false` when the client sends `false` — the field tracks the request', async () => {
    const before = JSON.parse((await request('GET', '')).body) as {
      timezone: string;
      version: number;
    };
    const marker = await headSequence();
    const target = before.timezone === 'Africa/Nairobi' ? 'Africa/Lagos' : 'Africa/Nairobi';
    expect(
      (await request('PUT', '/timezone', {
        timezone: target,
        expectedVersion: before.version,
        acknowledgePublishedImpact: false,
      })).statusCode,
    ).toBe(204);

    const [row] = await eventsSince(marker);
    expect(row?.payload['publishedImpactAcknowledged']).toBe(false);
    log('acknowledgement read from the request: sent false, recorded false');
  });
});

describe('the chain still verifies', () => {
  it('verifies clean for this organization after every settings append', async () => {
    // SPEC-11: the per-organization hash chain must verify clean. A new write
    // surface appending through a new module is exactly when a chain breaks.
    const result = await runtime.runner.run(
      {
        organizationId: alpha().organizationId,
        groupId: null,
        membershipId: alpha().users.organizationAdmin.membershipId,
        correlationId: 'settings-audit-chain',
      },
      (uow) => verifyAuditChain(uow),
    );
    expect(result.intact, JSON.stringify(result)).toBe(true);
    // Non-vacuous: an empty chain verifies trivially. This organization has just
    // had ten settings events appended to it.
    expect(result.entries, 'the chain has entries to verify').toBeGreaterThan(0);
    log(`audit chain intact across ${String(result.entries)} event(s)`);
  });
});
