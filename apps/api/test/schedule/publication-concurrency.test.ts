import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { adminClient } from '../support/admin-client.js';
import {
  buildHttpHarness,
  contextHeaders,
  currentCounters,
  type HttpHarness,
} from '../support/http.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * Publication under genuine concurrency (OPUS-M3-005).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## Why sequential tests would not do
 *
 * `publication-http.test.ts` proves the compare-and-set *happens*: a stale token
 * is refused and nothing is written. It proves nothing about whether the check
 * is ATOMIC, and on this codebase that distinction has already been the
 * difference between a control and a decoration twice:
 *
 *  - OPUS-M3-003's review raced two DIFFERENT approved versions into the
 *    publication transaction and both succeeded, one instantly superseding the
 *    other. FAD-22(2) made the compare-and-set required as a result.
 *  - OPUS-M3-004's review raced two cell writes carrying the same revision token
 *    and **both returned 200 in 11 of 12 rounds**, because every unit of work is
 *    READ COMMITTED and an unlocked `SELECT` gives both writers the same
 *    pre-state.
 *
 * So every test here races two REAL requests with `Promise.all`, over the real
 * HTTP surface and the real database, repeated enough times that a probabilistic
 * failure cannot hide.
 *
 * ## Two disciplines that make these tests mean something
 *
 *  1. **Everything is pre-resolved before the race** — headers built, reviews
 *     read, bodies serialized — so `Promise.all` overlaps the two server-side
 *     transactions rather than their own setup.
 *  2. **The assertion is on the DATABASE, not only on the status codes.** "One
 *     200 and one 409" is necessary and not sufficient: a publication that
 *     answered 409 after writing would satisfy it. Each round therefore asserts
 *     exactly one version is current, exactly one publication record exists, and
 *     the loser was not published.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const multi = ownedMulti('schedule-publication-concurrency', {
  profile: 'full',
  seed: { catalogue: ['alpha'], scheduleCredentials: true },
});

let harness: HttpHarness;
let admin: pg.Client;
let schedulerHeaders: Record<string, string>;

beforeAll(async () => {
  harness = await buildHttpHarness();
  admin = adminClient();
  await admin.connect();

  const alpha = multi().alpha;
  schedulerHeaders = {
    ...contextHeaders(
      alpha.users.scheduler.id,
      await currentCounters(admin, {
        organizationId: alpha.organizationId,
        groupId: alpha.groupOne.id,
        userId: alpha.users.scheduler.id,
      }),
    ),
    'content-type': 'application/json',
  };
}, 180_000);

afterAll(async () => {
  await harness.close();
  await admin.end();
});

function schedulePath(): string {
  const alpha = multi().alpha;
  return `/organizations/${alpha.organizationId}/groups/${alpha.groupOne.id}/schedule`;
}

interface Reply {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

function parse(response: { statusCode: number; body: string }): Reply {
  try {
    return { statusCode: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
  } catch {
    return { statusCode: response.statusCode, body: {} };
  }
}

async function send(
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
): Promise<Reply> {
  return parse(
    await harness.app.inject({
      method,
      url,
      headers: schedulerHeaders,
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    }),
  );
}

/** Fire two fully prepared requests at once. Nothing is computed inside. */
async function race(
  first: { url: string; payload: string },
  second: { url: string; payload: string },
): Promise<[Reply, Reply]> {
  const [a, b] = await Promise.all([
    harness.app.inject({ method: 'POST', headers: schedulerHeaders, ...first }),
    harness.app.inject({ method: 'POST', headers: schedulerHeaders, ...second }),
  ]);
  return [parse(a), parse(b)];
}

let windowCounter = 0;
function freshWindow(): { name: string; startDate: string; endDate: string } {
  const index = windowCounter;
  windowCounter += 1;
  const year = 2041 + Math.floor(index / 12);
  const month = String((index % 12) + 1).padStart(2, '0');
  return {
    name: `Concurrency window ${String(index)}`,
    startDate: `${String(year)}-${month}-02`,
    endDate: `${String(year)}-${month}-20`,
  };
}

interface Prepared {
  readonly periodId: string;
  readonly periodName: string;
  readonly versionIds: readonly string[];
}

/**
 * A period with `count` INDEPENDENT approved versions, each holding one
 * assignment for a different membership.
 *
 * Independent versions rather than one version twice, because the interesting
 * race is the one FAD-22(2) exists for: two publications of DIFFERENT versions,
 * where the same-key and same-version mechanisms give no protection at all.
 */
async function prepare(count: number): Promise<Prepared> {
  const window = freshWindow();
  const period = await send('POST', `${schedulePath()}/periods`, {
    name: window.name,
    startDate: window.startDate,
    endDate: window.endDate,
  });
  expect(period.statusCode).toBe(200);
  const periodId = (period.body as { period: { id: string } }).period.id;

  const shiftTypeId = multi().catalogue?.alpha?.shiftTypeIds[0];
  if (shiftTypeId === undefined) throw new Error('the catalogue seed produced no shift type');
  const memberships = [
    multi().alpha.users.member.membershipId,
    multi().alpha.users.scheduler.membershipId,
    multi().alpha.full?.viewer.membershipId,
  ].filter((id): id is string => id !== undefined);

  const versionIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const version = await send('POST', `${schedulePath()}/periods/${periodId}/versions`, {});
    expect(version.statusCode).toBe(200);
    const versionId = (version.body as { version: { id: string } }).version.id;

    const grid = await send('GET', `${schedulePath()}/versions/${versionId}/grid`);
    const added = await send('POST', `${schedulePath()}/versions/${versionId}/assignments`, {
      date: window.startDate,
      shiftTypeId,
      membershipId: memberships[index % memberships.length],
      expectedCellRevision: (grid.body as { emptyCellRevision: string }).emptyCellRevision,
    });
    expect(added.statusCode, JSON.stringify(added.body)).toBe(200);

    for (const to of ['in_review', 'approved'] as const) {
      const moved = await send('POST', `${schedulePath()}/versions/${versionId}/state`, { to });
      expect(moved.statusCode).toBe(200);
    }
    versionIds.push(versionId);
  }

  return { periodId, periodName: window.name, versionIds };
}

async function currentVersions(periodId: string): Promise<string[]> {
  const result = await admin.query<{ id: string }>(
    'select id from schedule_versions where period_id = $1 and is_current',
    [periodId],
  );
  return result.rows.map((row) => row.id);
}

async function publishedCount(periodId: string): Promise<number> {
  const result = await admin.query<{ count: string }>(
    'select count(*)::text as count from publication_records where period_id = $1',
    [periodId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

const ROUNDS = 12;

describe('two publications racing for one period', () => {
  it(`exactly one of two DIFFERENT versions wins, ${String(ROUNDS)} rounds`, async () => {
    const outcomes: string[] = [];

    for (let round = 0; round < ROUNDS; round += 1) {
      const prepared = await prepare(2);
      const [a, b] = prepared.versionIds;
      if (a === undefined || b === undefined) throw new Error('prepare produced too few versions');

      // Both reviews read BEFORE the race, so both racers hold the same belief
      // about what is current — which is exactly the state FAD-22(2) is about.
      const reviewA = (await send('GET', `${schedulePath()}/versions/${a}/publication-review`))
        .body as { reviewDigest: string; expectedPriorCurrentVersionId: string | null };
      const reviewB = (await send('GET', `${schedulePath()}/versions/${b}/publication-review`))
        .body as { reviewDigest: string; expectedPriorCurrentVersionId: string | null };
      expect(reviewA.expectedPriorCurrentVersionId).toBeNull();
      expect(reviewB.expectedPriorCurrentVersionId).toBeNull();

      const bodyFor = (versionId: string, digest: string): string =>
        JSON.stringify({
          idempotencyKey: `race-${String(round)}-${versionId.slice(0, 8)}`,
          expectedPriorCurrentVersionId: null,
          expectedReviewDigest: digest,
          acknowledged: true,
          confirmationPhrase: prepared.periodName,
        });

      const [first, second] = await race(
        { url: `${schedulePath()}/versions/${a}/publication`, payload: bodyFor(a, reviewA.reviewDigest) },
        { url: `${schedulePath()}/versions/${b}/publication`, payload: bodyFor(b, reviewB.reviewDigest) },
      );

      const statuses = [first.statusCode, second.statusCode].sort();
      outcomes.push(statuses.join('/'));

      // ── the database, not the status codes ──────────────────────────────
      expect(await currentVersions(prepared.periodId)).toHaveLength(1);
      expect(await publishedCount(prepared.periodId)).toBe(1);

      const winner = first.statusCode === 200 ? a : b;
      const loser = first.statusCode === 200 ? b : a;
      expect(await currentVersions(prepared.periodId)).toEqual([winner]);
      const loserRow = await admin.query<{ state: string }>(
        'select state from schedule_versions where id = $1',
        [loser],
      );
      expect(loserRow.rows[0]?.state).toBe('approved');
    }

    // Exactly one 200 and one 409 in EVERY round. A round of 200/200 is the
    // OPUS-M3-003 defect; a round of 409/409 would mean nobody could publish.
    expect(outcomes).toEqual(Array.from({ length: ROUNDS }, () => '200/409'));
  }, 180_000);

  it(`the SAME key twice, concurrently, publishes once — ${String(ROUNDS)} rounds`, async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const prepared = await prepare(1);
      const versionId = prepared.versionIds[0];
      if (versionId === undefined) throw new Error('prepare produced no version');

      const review = (await send('GET', `${schedulePath()}/versions/${versionId}/publication-review`))
        .body as { reviewDigest: string };

      // The double-click, at the server: ONE key, two overlapping requests.
      const payload = JSON.stringify({
        idempotencyKey: `double-${String(round)}`,
        expectedPriorCurrentVersionId: null,
        expectedReviewDigest: review.reviewDigest,
        acknowledged: true,
        confirmationPhrase: prepared.periodName,
      });

      const [first, second] = await race(
        { url: `${schedulePath()}/versions/${versionId}/publication`, payload },
        { url: `${schedulePath()}/versions/${versionId}/publication`, payload },
      );

      // Both may legitimately answer 200 — the second one is a REPLAY, which is
      // what D-17 is for. What must never happen is two publications.
      expect([first.statusCode, second.statusCode].every((status) => status === 200 || status === 409)).toBe(
        true,
      );
      expect(await publishedCount(prepared.periodId)).toBe(1);
      expect(await currentVersions(prepared.periodId)).toEqual([versionId]);

      const versionCount = await admin.query<{ count: string }>(
        'select count(*)::text as count from schedule_versions where period_id = $1',
        [prepared.periodId],
      );
      expect(versionCount.rows[0]?.count).toBe('1');
    }
  }, 180_000);
});
