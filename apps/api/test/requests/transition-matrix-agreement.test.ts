import {
  INITIAL_REQUEST_STATUS_BY_SUBTYPE,
  REQUEST_STATUSES,
  REQUEST_SUBTYPES,
  initialRequestStatus,
  transitionIsLegal,
} from '@schedulepoint/domain';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * **R-01's double enforcement, made CHECKABLE** — the domain matrix and the
 * database's copy, compared cell by cell over the whole cross-product
 * (OPUS-M5-001, doc 42 §5c Part A).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## Why this file exists at all
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * SPEC-08 R-01 requires illegal combinations to be "rejected by both domain and
 * database". Two layers is the requirement — but two layers that DISAGREE are
 * worse than one, because both look authoritative and the caller meets whichever
 * one happens to be in front. A service that refuses what the database would
 * allow is merely restrictive; a service that ALLOWS what the database refuses
 * turns every such call into a 500 at commit time.
 *
 * So the agreement is asserted rather than assumed, over every
 * (subtype × from × to) triple — 6 × 13 × 13 = 1 014 cells — by calling
 * `app_request_transition_is_legal` directly and comparing it to
 * `transitionIsLegal`.
 *
 * ## This is NOT the same test as the domain's own
 *
 * `packages/domain/test/requests/transitions.test.ts` holds the domain matrix to
 * SPEC-08 §2 read as a DOCUMENT, from an independently transcribed table. This
 * file holds the two IMPLEMENTATIONS to each other. Both are needed: the first
 * alone would not notice the database drifting, and this one alone would go
 * green if both layers drifted from §2 together — which is exactly what happens
 * when somebody "fixes" one layer by copying the other.
 *
 * **This is the test that keeps FAD-55 from decaying into a one-layer edit.**
 * The `reflected_in_version → withdrawn` cell exists in both copies or this
 * fails.
 *
 * ## Why the SQL function is called directly rather than exercised through rows
 *
 * The function is `IMMUTABLE`, takes three `text` arguments and reads no table,
 * so calling it 1 014 times is one round trip per batch and no writes at all.
 * Driving 1 014 real transitions through rows would need a legal path to every
 * source status for every subtype, most of which do not exist — and the cells
 * that matter most are precisely the ones no path reaches.
 */

const multi = ownedMulti('requests-transition-agreement', { profile: 'core' });

let runtime: Runtime;
let context: {
  organizationId: string;
  groupId: string;
  membershipId: string;
  correlationId: string;
};

const run = async <T>(fn: (uow: PgUnitOfWork) => Promise<T>): Promise<T> =>
  runtime.runner.run(context, fn);

beforeAll(async () => {
  runtime = createRuntime('app_runtime', { max: 2 });
  const alpha = multi().alpha;
  context = {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    membershipId: alpha.users.scheduler.membershipId,
    correlationId: 'requests-transition-agreement',
  };
}, 240_000);

afterAll(async () => {
  await runtime?.destroy();
});

/** Every cell the database permits, as `subtype|from|to`. */
async function databaseEdges(): Promise<ReadonlySet<string>> {
  const rows = await run(
    async ({ query }) =>
      await sql<{ subtype: string; from_status: string; to_status: string; legal: boolean }>`
        select s.subtype, f.status as from_status, t.status as to_status,
               app_request_transition_is_legal(s.subtype, f.status, t.status) as legal
          from unnest(${sql.val(REQUEST_SUBTYPES as readonly string[])}::text[]) as s(subtype)
         cross join unnest(${sql.val(REQUEST_STATUSES as readonly string[])}::text[]) as f(status)
         cross join unnest(${sql.val(REQUEST_STATUSES as readonly string[])}::text[]) as t(status)
      `.execute(query),
  );

  expect(
    rows.rows.length,
    'the cross-product query must return every cell',
  ).toBe(REQUEST_SUBTYPES.length * REQUEST_STATUSES.length * REQUEST_STATUSES.length);

  return new Set(
    rows.rows
      .filter((row) => row.legal)
      .map((row) => `${row.subtype}|${row.from_status}|${row.to_status}`),
  );
}

describe('R-01 — the domain matrix and the database agree, cell by cell', () => {
  it('every (subtype × from × to) triple gets the SAME verdict from both layers', async () => {
    const dbEdges = await databaseEdges();

    const disagreements: string[] = [];
    let permitted = 0;
    let forbidden = 0;

    for (const subtype of REQUEST_SUBTYPES) {
      for (const from of REQUEST_STATUSES) {
        for (const to of REQUEST_STATUSES) {
          const inDatabase = dbEdges.has(`${subtype}|${from}|${to}`);
          const inDomain = transitionIsLegal(subtype, from, to);
          if (inDatabase) permitted += 1;
          else forbidden += 1;
          if (inDatabase !== inDomain) {
            disagreements.push(
              `${subtype}: ${from} → ${to} — database ${String(inDatabase)}, domain ${String(inDomain)}`,
            );
          }
        }
      }
    }

    expect(disagreements).toEqual([]);
    /* Non-vacuity in both directions. A comparison in which one side permitted
     * nothing would agree with a domain that permitted nothing, and would report
     * zero disagreements while proving nothing at all. */
    expect(permitted, 'the database must permit SOME cells').toBeGreaterThan(0);
    expect(forbidden, 'the database must forbid SOME cells').toBeGreaterThan(0);
  }, 180_000);

  it('FAD-55 — the added cell is present in BOTH layers, for the five subtypes', async () => {
    /* Named separately from the loop above so the cell FAD-55 added is visible
     * in the test report as its own line. A one-layer edit — the failure mode
     * FAD-55's ratification specifically guards against — fails here first and
     * with an unambiguous message. */
    const dbEdges = await databaseEdges();

    for (const subtype of REQUEST_SUBTYPES) {
      const expected = subtype !== 'vacation-selection';
      const cell = `${subtype}|reflected_in_version|withdrawn`;
      expect(dbEdges.has(cell), `database: ${cell}`).toBe(expected);
      expect(
        transitionIsLegal(subtype, 'reflected_in_version', 'withdrawn'),
        `domain: ${cell}`,
      ).toBe(expected);
    }

    /* And vacation still has its own undo, in both layers — the exclusion is a
     * choice of spelling, not the removal of the capability. */
    expect(dbEdges.has('vacation-selection|reflected_in_version|reversed')).toBe(true);
    expect(transitionIsLegal('vacation-selection', 'reflected_in_version', 'reversed')).toBe(true);
  }, 180_000);

  it('V-31 — `expired` has the same three sources in both layers (R-23)', async () => {
    const dbEdges = await databaseEdges();

    for (const subtype of REQUEST_SUBTYPES) {
      const dbSources = REQUEST_STATUSES.filter((from) =>
        dbEdges.has(`${subtype}|${from}|expired`),
      );
      const domainSources = REQUEST_STATUSES.filter((from) =>
        transitionIsLegal(subtype, from, 'expired'),
      );
      expect(dbSources, `${subtype}`).toEqual(domainSources);
      expect([...dbSources].sort(), `${subtype}`).toEqual([
        'accepted_as_input',
        'submitted',
        'under_review',
      ]);
    }
  }, 180_000);
});

describe('the initial-INSERT ruling agrees in both layers', () => {
  it('`app_request_initial_status` returns what the domain constant says', async () => {
    const rows = await run(
      async ({ query }) =>
        await sql<{ subtype: string; initial: string }>`
          select s.subtype, app_request_initial_status(s.subtype) as initial
            from unnest(${sql.val(REQUEST_SUBTYPES as readonly string[])}::text[]) as s(subtype)
        `.execute(query),
    );

    expect(rows.rows).toHaveLength(REQUEST_SUBTYPES.length);
    for (const row of rows.rows) {
      expect(row.initial, `${row.subtype}`).toBe(
        initialRequestStatus(row.subtype as (typeof REQUEST_SUBTYPES)[number]),
      );
    }

    /* And the two values are the ones doc 42 §5c ruled, stated literally so a
     * change to BOTH copies still has to change this line. */
    expect(INITIAL_REQUEST_STATUS_BY_SUBTYPE).toEqual({
      availability: 'draft',
      'time-off': 'draft',
      'no-call': 'draft',
      'shift-preference': 'draft',
      'shift-group-off': 'draft',
      'vacation-selection': 'submitted',
    });
  }, 180_000);
});
