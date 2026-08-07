import { SYSTEM_ROLE_CAPABILITIES, capabilityDefinition } from '@schedulepoint/domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminClient } from '../support/admin-client.js';
import {
  buildHttpHarness,
  contextHeaders,
  currentCounters,
  type DeclaredCounters,
  type HttpHarness,
} from '../support/http.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * The holiday-calendar read/write key split (OPUS-M3-008; FAD-25 / D-10).
 *
 * ## What the split is for, in one line
 *
 * FAD-25's standing rule: **write never implies read, read never implies write.**
 * One key gating both is what produced D-10 — a scheduler authoring per-shift-type
 * `holiday` demand who could not see which dates that demand applied to.
 *
 * ## The claim this file proves, and the way it could fail
 *
 * A holder of the scheduler ROLE and nothing else READS the calendar and CANNOT
 * WRITE it. Both halves are asserted against the same actor on the same base
 * path in the same fixture, so "can read" cannot be an artefact of a permissive
 * fixture and "cannot write" cannot be an artefact of a broken route: a holder
 * of the administer key writes successfully in the same test, which is the
 * control.
 */

const multi = ownedMulti('holiday-key-split', {
  profile: 'core',
  seed: { catalogue: ['alpha'] },
});

let harness: HttpHarness;
let admin: pg.Client;

beforeAll(async () => {
  harness = await buildHttpHarness();
  admin = adminClient();
  await admin.connect();
}, 180_000);

afterAll(async () => {
  await harness.close();
  await admin.end();
});

function holidaysPath(): string {
  const alpha = multi().alpha;
  return `/organizations/${alpha.organizationId}/groups/${alpha.groupOne.id}/catalogue/holidays`;
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
  userId: string,
  body?: unknown,
): Promise<{ statusCode: number; body: unknown }> {
  const response = await harness.app.inject({
    method,
    url: holidaysPath(),
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
  return { statusCode: response.statusCode, body: parsed };
}

describe('the two keys are declared, distinct, and neither implies the other', () => {
  it('both exist, both are group-scoped, and they are different keys', () => {
    const read = capabilityDefinition('group.holiday_calendar.read');
    const write = capabilityDefinition('group.holiday_calendar.administer');
    expect(read?.scope).toBe('group');
    expect(write?.scope).toBe('group');
    expect(read?.key).not.toBe(write?.key);
  });

  it('scheduler holds READ and NOT write; group_admin holds both', () => {
    const scheduler = SYSTEM_ROLE_CAPABILITIES['scheduler'] ?? [];
    const groupAdmin = SYSTEM_ROLE_CAPABILITIES['group_admin'] ?? [];

    expect(scheduler).toContain('group.holiday_calendar.read');
    expect(scheduler).not.toContain('group.holiday_calendar.administer');
    expect(groupAdmin).toContain('group.holiday_calendar.read');
    expect(groupAdmin).toContain('group.holiday_calendar.administer');
  });

  it('no role that lacks the read key gets it by holding the write key', () => {
    // The failure mode the standing rule names: an implication smuggled in by a
    // role that holds only one of the pair.
    for (const [role, keys] of Object.entries(SYSTEM_ROLE_CAPABILITIES)) {
      if (keys.includes('group.holiday_calendar.administer')) {
        expect(
          keys.includes('group.holiday_calendar.read'),
          `${role} writes the calendar without reading it`,
        ).toBe(true);
      }
    }
  });
});

describe('over the real routes: the scheduler ROLE reads and cannot write', () => {
  /**
   * The actor is `groupOnly`, and the choice is the whole test.
   *
   * `groupOnly` holds the `scheduler` ROLE in Group One and **no grants at all**
   * — the catalogue fixture explicitly grants `group.holiday_calendar.administer`
   * to `users.scheduler`, so using that actor would prove nothing about the key
   * split and everything about the fixture. With `groupOnly`, a successful read
   * can only be the role-implied `group.holiday_calendar.read`, and a refused
   * write can only be the absent administer key.
   */
  it('a scheduler with NO grants READS the calendar — the point of the split', async () => {
    const groupOnly = multi().alpha.users.groupOnly;
    const response = await call('GET', groupOnly.id);
    expect(response.statusCode).toBe(200);
    // Non-vacuity: the fixture seeded a holiday, so a 200 with rows means the
    // read really reached the table rather than returning an empty list.
    expect(JSON.stringify(response.body)).toContain('2027-01-01');
  });

  it('the same actor CANNOT write it — and a holder of the administer key can', async () => {
    const alpha = multi().alpha;

    const refused = await call('POST', alpha.users.groupOnly.id, {
      holidayDate: '2029-04-04',
      name: 'Synthetic scheduler-authored holiday',
      observed: true,
    });
    expect(refused.statusCode).toBe(403);

    // Nothing was written. A 403 that wrote would look identical from the code.
    const after = await admin.query<{ n: string }>(
      `select count(*)::text as n from group_holidays
        where group_id = $1 and holiday_date = '2029-04-04'`,
      [alpha.groupOne.id],
    );
    expect(after.rows[0]?.n).toBe('0');

    /* The CONTROL: the same request from a holder of the administer key
     * succeeds, so the refusal above is the key and not the route, the body, or
     * the date. `users.scheduler` holds it by the fixture's explicit grant. */
    const allowed = await call('POST', alpha.users.scheduler.id, {
      holidayDate: '2029-04-04',
      name: 'Synthetic administrator-authored holiday',
      observed: true,
    });
    expect(allowed.statusCode).toBe(200);
  });
});
