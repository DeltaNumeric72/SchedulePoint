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
 * The compare-and-set under genuine concurrency (OPUS-M3-004, review B-1..B-3).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## Why these tests exist
 *
 * The original compare-and-set tests were SEQUENTIAL: they wrote once, then
 * replayed a stale token. That proves the comparison happens. It proves nothing
 * about whether the comparison is atomic — and it was not.
 *
 * `PgUnitOfWorkRunner` issues a plain `BEGIN`, so every unit of work is READ
 * COMMITTED, and an unlocked `SELECT` under READ COMMITTED gives two concurrent
 * transactions the same pre-state. Both find their token current. Both write.
 * The independent review measured it: two concurrent requirement writes carrying
 * the same `expectedRevision` **both returned 200 in 11 of 12 rounds**.
 *
 * So every test here races two REAL requests with `Promise.all`, over the real
 * HTTP surface and the real database, and repeats it enough times that a
 * probabilistic failure cannot hide.
 *
 * ## Two disciplines that make these tests mean something
 *
 * 1. **Everything is pre-resolved before the race.** Context headers are built,
 *    tokens are read and bodies are serialized BEFORE `Promise.all`, so the two
 *    requests actually overlap instead of being serialized by their own setup.
 * 2. **The assertion is on the DATABASE, not only on the status codes.** "One
 *    200 and one 409" is necessary and not sufficient: a compare-and-set that
 *    answered 409 *after* writing would satisfy it. Each test therefore asserts
 *    the final stored state equals the WINNER's intent exactly, and that the
 *    loser's value is absent.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const multi = ownedMulti('schedule-authoring-concurrency', {
  profile: 'full',
  seed: { catalogue: ['alpha'] },
});

let harness: HttpHarness;
let admin: pg.Client;

beforeAll(async () => {
  // Room for both racers plus the setup connection; the default is 6.
  harness = await buildHttpHarness();
  admin = adminClient();
  await admin.connect();
}, 180_000);

afterAll(async () => {
  await harness.close();
  await admin.end();
});

function schedulePath(): string {
  const alpha = multi().alpha;
  return `/organizations/${alpha.organizationId}/groups/${alpha.groupOne.id}/schedule`;
}

/** Headers for the scheduler, resolved ONCE and reused inside every race. */
let schedulerHeaders: Record<string, string>;

async function resolveHeaders(): Promise<void> {
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
}

interface Reply {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
}

function parse(response: { statusCode: number; body: string }): Reply {
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { statusCode: response.statusCode, body };
}

/**
 * Fire two fully prepared requests at once.
 *
 * Nothing is computed inside — both payloads are already strings — so the only
 * thing `Promise.all` is overlapping is the two server-side transactions.
 */
async function race(
  first: { method: 'POST' | 'PUT'; url: string; payload: string },
  second: { method: 'POST' | 'PUT'; url: string; payload: string },
): Promise<[Reply, Reply]> {
  const [a, b] = await Promise.all([
    harness.app.inject({ ...first, headers: schedulerHeaders }),
    harness.app.inject({ ...second, headers: schedulerHeaders }),
  ]);
  return [parse(a), parse(b)];
}

function outcomes(replies: readonly Reply[]): { won: Reply[]; lost: Reply[] } {
  return {
    won: replies.filter((reply) => reply.statusCode === 200),
    lost: replies.filter((reply) => reply.statusCode !== 200),
  };
}

/* ── fixture builders, all through the real routes ────────────────────────── */

let windowCounter = 0;
function freshWindow(): { name: string; startDate: string; endDate: string } {
  const index = windowCounter;
  windowCounter += 1;
  const year = 2030 + Math.floor(index / 12);
  const month = String((index % 12) + 1).padStart(2, '0');
  return {
    name: `Race window ${String(index)} ${String(year)}-${month}`,
    startDate: `${String(year)}-${month}-02`,
    endDate: `${String(year)}-${month}-20`,
  };
}

interface Draft {
  readonly periodId: string;
  readonly versionId: string;
  readonly date: string;
  /** A second date inside the same period — the disjoint-set race needs one. */
  readonly secondDate: string;
  readonly shiftTypeId: string;
  readonly emptyCellRevision: string;
  /** The requirement AGGREGATE's set version (OPUS-M4-000A). */
  readonly requirementSetVersion: number;
}

async function createDraft(): Promise<Draft> {
  const window = freshWindow();
  const period = parse(
    await harness.app.inject({
      method: 'POST',
      url: `${schedulePath()}/periods`,
      headers: schedulerHeaders,
      payload: JSON.stringify(window),
    }),
  );
  expect(period.statusCode, JSON.stringify(period.body)).toBe(200);
  const periodId = (period.body as { period: { id: string } }).period.id;

  const version = parse(
    await harness.app.inject({
      method: 'POST',
      url: `${schedulePath()}/periods/${periodId}/versions`,
      headers: schedulerHeaders,
      payload: '{}',
    }),
  );
  expect(version.statusCode).toBe(200);
  const versionId = (version.body as { version: { id: string } }).version.id;

  const grid = parse(
    await harness.app.inject({
      method: 'GET',
      url: `${schedulePath()}/versions/${versionId}/grid`,
      headers: schedulerHeaders,
    }),
  );
  expect(grid.statusCode).toBe(200);
  const shiftTypeId = (grid.body as { shiftTypes: { id: string }[] }).shiftTypes[0]?.id ?? '';
  const requirements = parse(
    await harness.app.inject({
      method: 'GET',
      url: `${schedulePath()}/periods/${periodId}/requirements`,
      headers: schedulerHeaders,
    }),
  );

  return {
    periodId,
    versionId,
    date: window.startDate,
    secondDate: window.endDate,
    shiftTypeId,
    emptyCellRevision: (grid.body as { emptyCellRevision: string }).emptyCellRevision,
    requirementSetVersion: (requirements.body as { version: number }).version,
  };
}

async function readCellAssignments(
  draft: Draft,
): Promise<{ membershipId: string; assignmentIdentityId: string }[]> {
  const grid = parse(
    await harness.app.inject({
      method: 'GET',
      url: `${schedulePath()}/versions/${draft.versionId}/grid`,
      headers: schedulerHeaders,
    }),
  );
  const cells = (
    grid.body as {
      cells: {
        date: string;
        shiftTypeId: string;
        assignments: { membershipId: string; assignmentIdentityId: string }[];
      }[];
    }
  ).cells;
  return (
    cells.find((cell) => cell.date === draft.date && cell.shiftTypeId === draft.shiftTypeId)
      ?.assignments ?? []
  );
}

async function storedRequirements(
  draft: Draft,
): Promise<{ date: string; requiredCount: number }[]> {
  const list = parse(
    await harness.app.inject({
      method: 'GET',
      url: `${schedulePath()}/periods/${draft.periodId}/requirements`,
      headers: schedulerHeaders,
    }),
  );
  return (
    list.body as { requirements: { date: string; requiredCount: number }[] }
  ).requirements.map((row) => ({ date: row.date, requiredCount: row.requiredCount }));
}

/** Enough rounds that an 11-in-12 failure rate cannot pass by luck. */
const ROUNDS = 12;

beforeAll(async () => {
  await resolveHeaders();
}, 60_000);

/* ────────────────────────────────────────────────────────────────────────────
 * B-1 — two requirement writes, same expectedRevision
 * ──────────────────────────────────────────────────────────────────────────── */

describe('B-1: concurrent requirement writes carrying the SAME revision', () => {
  /* OPUS-M4-000A: the requirement editor is a WHOLE-SET replacement under the
   * aggregate CAS, so the race is raced on the aggregate — two writers, the
   * SAME loaded `expectedVersion`, DISJOINT presented sets. The forbidden
   * outcome is the UNION (both writers' rows in the database); the required
   * outcome is exactly one winner's set, byte for byte, and an explicit
   * `409 STALE_SET_VERSION` for the loser. Asserted against the DATABASE
   * state, not the status codes, twelve rounds. */
  it(`over ${String(ROUNDS)} rounds, exactly one set wins whole and the union never appears`, async () => {
    const results: string[] = [];

    for (let round = 0; round < ROUNDS; round += 1) {
      const draft = await createDraft();
      const url = `${schedulePath()}/periods/${draft.periodId}/requirements`;
      // Disjoint sets: writer A presents ONLY the start date, writer B ONLY
      // the end date. A merge of any kind produces two rows.
      const body = (date: string, count: number): string =>
        JSON.stringify({
          requirements: [{ date, shiftTypeId: draft.shiftTypeId, requiredCount: count }],
          expectedVersion: draft.requirementSetVersion,
        });

      const replies = await race(
        { method: 'PUT', url, payload: body(draft.date, 2) },
        { method: 'PUT', url, payload: body(draft.secondDate, 7) },
      );
      const { won, lost } = outcomes(replies);
      const stored = await storedRequirements(draft);

      results.push(
        `round ${String(round)}: ${replies.map((r) => String(r.statusCode)).join('/')} stored=${JSON.stringify(stored)}`,
      );

      expect(won, `round ${String(round)}: both writers were accepted`).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(lost[0]?.statusCode).toBe(409);
      expect((lost[0]?.body as { error: { code: string } }).error.code).toBe('STALE_SET_VERSION');
      // The refusal carries the CURRENT version — the refetch hint, present
      // and newer than what the loser presented.
      expect(
        (lost[0]?.body as { error: { currentVersion: number } }).error.currentVersion,
      ).toBeGreaterThan(draft.requirementSetVersion);

      /* The decisive assertion: the DATABASE holds exactly the winner's set.
       * One row, the winner's date, the winner's count — never two rows, which
       * is what a union or any silent merge would produce, and never the
       * loser's row alone. */
      const winnerWasA = won[0] === replies[0];
      expect(stored, `round ${String(round)}: the stored set is not exactly the winner's`).toEqual([
        winnerWasA
          ? { date: draft.date, requiredCount: 2 }
          : { date: draft.secondDate, requiredCount: 7 },
      ]);
    }

    console.log(`B-1 requirement whole-set race:\n  ${results.join('\n  ')}`);
  }, 240_000);
});

/* ────────────────────────────────────────────────────────────────────────────
 * B-2 — two adds into one EMPTY cell
 * ──────────────────────────────────────────────────────────────────────────── */

describe('B-2: concurrent adds into one empty cell', () => {
  it(`over ${String(ROUNDS)} rounds, one lands and the other gets an explicit 409`, async () => {
    const alpha = multi().alpha;
    const results: string[] = [];

    for (let round = 0; round < ROUNDS; round += 1) {
      const draft = await createDraft();
      const url = `${schedulePath()}/versions/${draft.versionId}/assignments`;
      const body = (membershipId: string): string =>
        JSON.stringify({
          date: draft.date,
          shiftTypeId: draft.shiftTypeId,
          membershipId,
          expectedCellRevision: draft.emptyCellRevision,
        });

      const replies = await race(
        { method: 'POST', url, payload: body(alpha.users.scheduler.membershipId) },
        { method: 'POST', url, payload: body(alpha.users.member.membershipId) },
      );
      const { won, lost } = outcomes(replies);
      const assignments = await readCellAssignments(draft);

      results.push(
        `round ${String(round)}: ${replies.map((r) => String(r.statusCode)).join('/')} assignments=${String(assignments.length)}`,
      );

      expect(won, `round ${String(round)}: both adds were accepted`).toHaveLength(1);
      expect(lost).toHaveLength(1);
      // NEVER 404. The loser used to be refused by `shifts_unique_in_version`
      // through the service's select-then-insert and told the cell did not
      // exist; it is now serialized and told its revision moved.
      expect(lost[0]?.statusCode, `round ${String(round)}: the loser was not a 409`).toBe(409);
      expect((lost[0]?.body as { error: { code: string } }).error.code).toBe('STALE_EDIT');
      expect(
        (lost[0]?.body as { error: { currentRevision?: string } }).error.currentRevision,
      ).toMatch(/^[0-9a-f]{64}$/);

      expect(assignments).toHaveLength(1);
      const winner =
        won[0] === replies[0]
          ? alpha.users.scheduler.membershipId
          : alpha.users.member.membershipId;
      expect(assignments[0]?.membershipId).toBe(winner);
    }

    console.log(`B-2 empty-cell add race:\n  ${results.join('\n  ')}`);
  }, 240_000);
});

/* ────────────────────────────────────────────────────────────────────────────
 * B-3 — an add and a remove in one cell, same revision
 * ──────────────────────────────────────────────────────────────────────────── */

describe('B-3: a concurrent add and remove in one cell', () => {
  it(`over ${String(ROUNDS)} rounds, one wins and no merged state is ever produced`, async () => {
    const alpha = multi().alpha;
    const results: string[] = [];

    for (let round = 0; round < ROUNDS; round += 1) {
      const draft = await createDraft();

      // Seed ONE assignment, so there is something to remove.
      const seeded = parse(
        await harness.app.inject({
          method: 'POST',
          url: `${schedulePath()}/versions/${draft.versionId}/assignments`,
          headers: schedulerHeaders,
          payload: JSON.stringify({
            date: draft.date,
            shiftTypeId: draft.shiftTypeId,
            membershipId: alpha.users.member.membershipId,
            expectedCellRevision: draft.emptyCellRevision,
          }),
        }),
      );
      expect(seeded.statusCode, JSON.stringify(seeded.body)).toBe(200);
      const cell = (
        seeded.body as {
          cell: { revision: string; assignments: { assignmentIdentityId: string }[] };
        }
      ).cell;
      const identityId = cell.assignments[0]?.assignmentIdentityId ?? '';

      // BOTH racers hold the same, currently-valid revision.
      const replies = await race(
        {
          method: 'POST',
          url: `${schedulePath()}/versions/${draft.versionId}/assignments`,
          payload: JSON.stringify({
            date: draft.date,
            shiftTypeId: draft.shiftTypeId,
            membershipId: alpha.users.scheduler.membershipId,
            expectedCellRevision: cell.revision,
          }),
        },
        {
          method: 'POST',
          url: `${schedulePath()}/versions/${draft.versionId}/assignments/${identityId}/removal`,
          payload: JSON.stringify({
            reason: 'concurrent removal probe',
            expectedCellRevision: cell.revision,
          }),
        },
      );
      const { won, lost } = outcomes(replies);
      const assignments = await readCellAssignments(draft);

      results.push(
        `round ${String(round)}: ${replies.map((r) => String(r.statusCode)).join('/')} assignments=${String(assignments.length)}`,
      );

      expect(won, `round ${String(round)}: both the add and the remove landed`).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(lost[0]?.statusCode).toBe(409);
      expect((lost[0]?.body as { error: { code: string } }).error.code).toBe('STALE_EDIT');

      // No merged state. Either the add won (two people on the shift) or the
      // remove won (nobody) — never "the add landed AND the original is gone",
      // which is what both-succeeding produced.
      if (won[0] === replies[0]) {
        expect(assignments).toHaveLength(2);
        expect(assignments.map((row) => row.membershipId).sort()).toEqual(
          [alpha.users.member.membershipId, alpha.users.scheduler.membershipId].sort(),
        );
      } else {
        expect(assignments).toHaveLength(0);
      }
    }

    console.log(`B-3 add/remove race:\n  ${results.join('\n  ')}`);
  }, 240_000);
});
