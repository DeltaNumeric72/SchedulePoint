import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminClient } from '../support/admin-client.js';
import { log } from '../support/harness.js';
import {
  buildHttpHarness,
  contextHeaders,
  currentCounters,
  type HttpHarness,
} from '../support/http.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * **NAMED-CONDITION PROOF — a timezone change over PUBLISHED schedules is
 * permitted, warned about, and audited with the count it was made over.**
 *
 * Packet 32 §10c: "timezone administration (audited change; **a change while
 * published schedules exist is permitted with an explicit audited warning** —
 * the display-semantics question is recorded to the exit report)".
 *
 * ## Why "permitted" is the right answer and refusing would be worse
 *
 * A group that discovers its zone is wrong after publishing would otherwise have
 * no way to correct the record, and every schedule would go on being rendered
 * against a zone nobody believes. The control is not a prohibition; it is that
 * the change cannot happen *silently*.
 *
 * ## The three things that make it non-silent, each asserted here
 *
 * | | |
 * |---|---|
 * | the count is **read inside the writing transaction** | the number in the audit row is the number that was true at the instant it committed |
 * | the acknowledgement is **required by the server** | a client that could decide when the warning applies is a client that can decide it never applies |
 * | the count is **surfaced on the READ** | the interface can state the consequence BEFORE the administrator acts, not after |
 *
 * ## What this test does NOT claim
 *
 * It does not claim anything about how an already-published assignment should
 * RENDER after the change. That is the display-semantics question packet 32
 * §10c explicitly tells this task to record rather than resolve, and it is
 * recorded in `docs/evidence/EV-M3-SETTINGS/INDEX.md` for the M3 exit report.
 * What is asserted here is the narrower, checkable fact: **no stored instant
 * moves.** `assignment_snapshots` is `timestamptz` and this change does not
 * touch a single row of it.
 */

const multi = ownedMulti('settings-timezone', {
  profile: 'full',
  // A published schedule history in Alpha Group One — the whole point of this
  // file. Without it, "permitted while published schedules exist" would be a
  // claim about a group that has none.
  seed: { staffing: true, catalogue: ['alpha'], schedule: true },
});

let admin: pg.Client;
let harness: HttpHarness;

const alpha = () => multi().alpha;
const groupAdmin = () => {
  const value = multi().alpha.full?.groupAdmin;
  if (value === undefined) throw new Error('the full profile provisions a group admin');
  return value;
};
const base = () =>
  `/organizations/${alpha().organizationId}/groups/${alpha().groupOne.id}/settings`;

async function request(
  method: 'GET' | 'PUT',
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

async function readSettings(): Promise<{
  timezone: string;
  publishedVersionCount: number;
  version: number;
}> {
  const response = await request('GET', '');
  expect(response.statusCode, response.body).toBe(200);
  return JSON.parse(response.body) as {
    timezone: string;
    publishedVersionCount: number;
    version: number;
  };
}

/** Every snapshot instant in this group, as ground truth outside the API. */
async function snapshotInstants(): Promise<string[]> {
  const { rows } = await admin.query<{ instants: string }>(
    `select (starts_at::text || '|' || ends_at::text) as instants
       from assignment_snapshots
      where organization_id = $1 and group_id = $2
      order by id`,
    [alpha().organizationId, alpha().groupOne.id],
  );
  return rows.map((row) => row.instants);
}

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  harness = await buildHttpHarness();
}, 180_000);

afterAll(async () => {
  await harness.close();
  await admin.end();
});

describe('the settings read states the consequence before the administrator acts', () => {
  it('CONTROL: this group really does have published versions', async () => {
    // Ground truth. Without it, every "over N published versions" assertion
    // below would be a statement about zero, and the whole file would be
    // measuring the easy case.
    const { rows } = await admin.query<{ n: number }>(
      `select count(*)::int as n from schedule_versions
        where organization_id = $1 and group_id = $2 and state in ('published', 'superseded')`,
      [alpha().organizationId, alpha().groupOne.id],
    );
    expect(rows[0]?.n ?? 0, 'the fixture published into this group').toBeGreaterThan(0);
    log(`control: ${String(rows[0]?.n)} published/superseded version(s) in Alpha Group One`);
  });

  it('carries the published-version count on the READ', async () => {
    const settings = await readSettings();
    expect(settings.publishedVersionCount).toBeGreaterThan(0);
    log(`GET /settings reports publishedVersionCount = ${String(settings.publishedVersionCount)}`);
  });
});

describe('a timezone change over published schedules', () => {
  it('is REFUSED without the acknowledgement, and the field is named', async () => {
    const before = await readSettings();
    const response = await request('PUT', '/timezone', {
      timezone: 'America/Toronto',
      expectedVersion: before.version,
      acknowledgePublishedImpact: false,
    });

    expect(response.statusCode, response.body).toBe(422);
    expect(response.body).toContain('acknowledgePublishedImpact');
    // The message says what is at stake rather than "invalid".
    expect(response.body).toContain('published schedules');

    // And nothing moved.
    expect((await readSettings()).timezone).toBe(before.timezone);
    log('unacknowledged change over published schedules → 422, zone unchanged');
  });

  it('is PERMITTED with the acknowledgement, and lands the count in the audit payload', async () => {
    const before = await readSettings();
    const marker = await admin
      .query<{ head: string | null }>(
        'select max(sequence)::text as head from audit_events where organization_id = $1',
        [alpha().organizationId],
      )
      .then((result) => Number(result.rows[0]?.head ?? 0));

    const response = await request('PUT', '/timezone', {
      timezone: 'America/Toronto',
      expectedVersion: before.version,
      acknowledgePublishedImpact: true,
    });
    expect(response.statusCode, response.body).toBe(204);
    expect((await readSettings()).timezone).toBe('America/Toronto');

    const { rows } = await admin.query<{ event_name: string; payload: Record<string, unknown> }>(
      `select event_name, payload from audit_events
        where organization_id = $1 and sequence > $2 order by sequence`,
      [alpha().organizationId, marker],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_name).toBe('settings.timezone.changed');

    const payload = rows[0]?.payload ?? {};
    expect(payload['fromTimezone']).toBe(before.timezone);
    expect(payload['toTimezone']).toBe('America/Toronto');
    // The warning, recorded — and the count is the one that was true INSIDE the
    // writing transaction, not one the client sent.
    expect(payload['publishedVersionCount']).toBe(before.publishedVersionCount);
    expect(payload['publishedImpactAcknowledged']).toBe(true);

    log(
      `acknowledged change → 204, audited ${String(payload['fromTimezone'])} → ` +
        `${String(payload['toTimezone'])} over ${String(payload['publishedVersionCount'])} version(s)`,
    );
  });

  it('moves NO stored instant — published content is untouched (I-18)', async () => {
    /* The narrow, checkable half of the display-semantics question.
     *
     * Changing a group's zone changes how a wall-clock time is INTERPRETED. It
     * must not rewrite anything already stored: `assignment_snapshots` carries
     * `timestamptz`, which is an absolute instant, and a published snapshot is
     * immutable at the database (D-15a). A migration that "helpfully" shifted
     * those instants would be mutating published content, which the triggers
     * would refuse — but the API must not attempt it either.
     *
     * The remaining question — whether a published assignment should DISPLAY at
     * its original wall time or at the new zone's equivalent instant — is a
     * product decision, is not settled here, and is recorded to the exit report. */
    const before = await snapshotInstants();
    expect(before.length, 'the fixture has snapshots to compare').toBeGreaterThan(0);

    const settings = await readSettings();
    const response = await request('PUT', '/timezone', {
      timezone: 'Pacific/Auckland',
      expectedVersion: settings.version,
      acknowledgePublishedImpact: true,
    });
    expect(response.statusCode, response.body).toBe(204);

    expect(await snapshotInstants(), 'not one stored instant moved').toEqual(before);
    log(`${String(before.length)} snapshot instants unchanged across two zone changes`);
  });

  it('a stale version loses with a 409, acknowledgement or not', async () => {
    const settings = await readSettings();

    const first = await request('PUT', '/timezone', {
      timezone: 'Europe/Lisbon',
      expectedVersion: settings.version,
      acknowledgePublishedImpact: true,
    });
    expect(first.statusCode, first.body).toBe(204);

    const second = await request('PUT', '/timezone', {
      timezone: 'Asia/Tokyo',
      expectedVersion: settings.version,
      acknowledgePublishedImpact: true,
    });
    expect(second.statusCode, second.body).toBe(409);
    expect((await readSettings()).timezone).toBe('Europe/Lisbon');
    log('concurrent zone change → the loser gets 409, the winner stands');
  });
});
