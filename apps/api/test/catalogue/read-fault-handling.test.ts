import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type * as CatalogueService from '../../src/catalogue/service.js';
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
 * **A fault inside a catalogue read reaches the standard error handler**
 * (OPUS-M2-004, review finding V-02).
 *
 * ## What was wrong
 *
 * `withCatalogueQuery` caught **everything** and answered `404`, with a log line
 * reading "catalogue read refused by the database" — a cause it had never
 * checked. So a `TypeError` in a service, a contract parse failure, or an
 * exhausted pool all became "no such row", and the one log line an operator
 * would find said something untrue about why.
 *
 * The catch is now narrowed to errors carrying a SQLSTATE. Anything else is
 * re-thrown to `setErrorHandler`, which logs the real error with its stack and
 * answers `500` with the fixed generic message (`errors.ts`: for 5xx the body
 * message is a constant, because framework messages quote the offending value).
 *
 * ## Why this file mocks the service module
 *
 * There is no *legitimate* request that makes a catalogue read throw a
 * non-database error — which is the point: the branch is unreachable by
 * construction from outside, so the only honest way to exercise it is to inject
 * the fault. `vi.mock` replaces one service function with one that throws a
 * plain `Error`, and the assertion is on what the SERVER does with it.
 *
 * The mock is file-scoped, and this file tests nothing else, so no other
 * assertion in the suite is evaluated against a mocked service.
 */

vi.mock('../../src/catalogue/service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof CatalogueService>();
  return {
    ...actual,
    listShiftTypeQualifications: () => {
      // Deliberately NOT a postgres error: no `code`, no SQLSTATE. This is the
      // shape of a bug in this process rather than a refusal from the database.
      throw new Error('injected non-database fault');
    },
  };
});

const multi = ownedMulti('catalogue-read-fault-handling', {
  seed: { catalogue: ['alpha'] },
});

let admin: pg.Client;
let harness: HttpHarness;

const alpha = () => multi().alpha;

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  harness = await buildHttpHarness();
}, 180_000);

afterAll(async () => {
  await harness.close();
  await admin.end();
});

async function get(userId: string, path: string): Promise<{ statusCode: number; body: string }> {
  const counters = await currentCounters(admin, {
    organizationId: alpha().organizationId,
    groupId: alpha().groupOne.id,
    userId,
  });
  const response = await harness.app.inject({
    method: 'GET',
    url:
      `/organizations/${alpha().organizationId}/groups/${alpha().groupOne.id}/catalogue${path}`,
    headers: contextHeaders(userId, counters),
  });
  return { statusCode: response.statusCode, body: response.body };
}

describe('a non-database fault in a read is a 500, not a 404', () => {
  it('the authorized read surfaces the injected fault through setErrorHandler', async () => {
    const shiftTypeId = multi.catalogue().shiftTypeIds[0] as string;

    const response = await get(alpha().users.scheduler.id, `/shift-types/${shiftTypeId}/qualifications`);

    expect(
      response.statusCode,
      'a bug in this process was reported as a missing row',
    ).toBe(500);

    // The envelope is the standard one and says nothing about the cause: for 5xx
    // the message is a fixed string, because framework messages quote the value
    // that offended them and a quoted value is how a payload reaches a client
    // (I-17, SPEC-07 §3).
    const body = JSON.parse(response.body) as {
      error: { code: string; message: string; correlationId: string };
    };
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('The request could not be completed.');
    expect(body.error.correlationId.length).toBeGreaterThan(0);
    expect(response.body, 'the injected message reached the wire').not.toContain('injected');

    log('a non-pg throw inside a read → 500 INTERNAL_ERROR, correlation id only');
  });

  it('CONTROL: the DENIAL path still short-circuits before the fault can fire', async () => {
    // The verdict is evaluated first, so an unauthorized caller never reaches
    // the mocked read at all — and therefore never sees a 500 where they should
    // see a denial. Without this arm the test above would also pass if
    // authorization had moved after the read.
    const response = await get(alpha().users.member.id, `/shift-types/${randomShiftType()}/qualifications`);
    expect(response.statusCode).toBe(403);
    log('member → 403, reached without executing the read');
  });
});

/** A well-formed uuid, so the denial arm is not passing on the shape check. */
function randomShiftType(): string {
  return multi.catalogue().shiftTypeIds[0] as string;
}
