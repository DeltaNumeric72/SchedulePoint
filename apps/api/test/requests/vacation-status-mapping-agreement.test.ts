import { randomUUID } from 'node:crypto';

import {
  VACATION_ROOT_STATUS_TO_SELECTION_STATUS,
  selectionStatusForRootStatusWire,
} from '@schedulepoint/contracts';
import {
  REQUEST_STATUSES,
  VACATION_SELECTION_STATUSES,
  VACATION_SELECTION_TRANSITIONS,
  VACATION_STATUS_TO_REQUEST_STATUS,
  selectionEdgeRootPath,
  selectionStatusForRootStatus,
  type RequestStatus,
  type VacationSelectionStatus,
} from '@schedulepoint/domain';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * **R-15 — the §5.3 STATUS-MAPPING INVARIANT, proven at every layer that holds a
 * copy of it** (OPUS-M5-003, doc 42 §5f Part A).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## SPEC-08 R-15, and what discharging it requires
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * > **R-15** — Every vacation status transition, checking `requests.status`
 * > against `vacation_selections.status`. The §5.3 mapping holds after every
 * > transition, in the same transaction; a deliberately desynchronised write
 * > **raises (D-27)**.
 *
 * And doc 42 §5f states the DISPLAY half: *"the selection's displayed status is
 * DERIVED from the root's SPEC-08 §2 status by the §5.3 table — never stored
 * separately, never divergent"* — with the agreement proven "in the
 * transition-matrix-agreement style (both layers, mutation-killed)".
 *
 * ## THREE copies of one table, and this is where they are held to each other
 *
 * | Copy | Where | Read by |
 * |---|---|---|
 * | `VACATION_STATUS_TO_REQUEST_STATUS` | `packages/domain` | the writers, to know what to write |
 * | `app_vacation_derived_request_status` | migration 0022 | D-27's triggers, to REFUSE |
 * | `VACATION_ROOT_STATUS_TO_SELECTION_STATUS` | `packages/contracts` | the browser, to DISPLAY |
 *
 * The third exists because `packages/contracts` may import zod and nothing else,
 * so a client cannot reach the domain's copy — the same reason this file's
 * neighbours give for the duplicated status enums, and the same discipline
 * applied: *"Two copies of a closed set are two truths that can drift, so they
 * are not left to agree by inspection."* This file is that assertion.
 *
 * ## Why the live walk is not the same test as the table comparison
 *
 * Comparing three constants proves they SAY the same thing. Walking a real
 * selection through every §5.3 edge proves the WRITERS keep the pair together and
 * that D-27 refuses one that does not — which is what R-15 actually asks. Both
 * are here, and neither is the other's spare copy.
 *
 * ## Synthetic only
 *
 * Every date is far-future and every label is the fixture's own. No
 * organization, site or person name from the research appears here.
 */

const multi = ownedMulti('requests-vacation-mapping', { profile: 'core' });

/** A far-future Monday. The walk's round starts here and runs one week per edge. */
const WALK_PERIOD_START = '2051-06-05';

/** The Monday `weeks` weeks after `start`, as a calendar date. */
function mondayAfter(start: string, weeks: number): string {
  const at = Date.parse(`${start}T00:00:00Z`) + weeks * 7 * 24 * 60 * 60 * 1000;
  return new Date(at).toISOString().slice(0, 10);
}

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
    membershipId: alpha.users.member.membershipId,
    correlationId: 'requests-vacation-mapping',
  };
}, 240_000);

afterAll(async () => {
  await runtime?.destroy();
});

/** The database's copy of §5.3, as a record, read in one round trip. */
async function databaseMapping(): Promise<Record<string, string | null>> {
  const rows = await run(
    async ({ query }) =>
      await sql<{ selection_status: string; derived: string | null }>`
        select s as selection_status, app_vacation_derived_request_status(s) as derived
          from unnest(${sql.val(
            VACATION_SELECTION_STATUSES as readonly string[],
          )}::text[]) as s
      `.execute(query),
  );
  expect(rows.rows.length, 'the query must return every selection status').toBe(
    VACATION_SELECTION_STATUSES.length,
  );
  return Object.fromEntries(rows.rows.map((row) => [row.selection_status, row.derived]));
}

/* ────────────────────────────────────────────────────────────────────────────
 * A period, and a selection that can be walked
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A far-future `open` quota round, Monday to Friday as §5.2's CHECKs require.
 *
 * `weeks` is how many Mondays it must contain: the end date is
 * `start + 7·(weeks−1) + 4`, which is a Friday whenever the start is a Monday.
 * Computed rather than written, so a caller that needs one more week does not
 * have to work out which Friday that is.
 */
async function createPeriod(startDate: string, weeks = 4): Promise<string> {
  const span = 7 * (weeks - 1) + 4;
  return run(async ({ query }) => {
    const inserted = await sql<{ id: string }>`
      insert into vacation_periods
        (organization_id, group_id, start_date, end_date, mode, state)
      values (${context.organizationId}::uuid, ${context.groupId}::uuid,
              ${startDate}::date, (${startDate}::date + ${span}::integer)::date, ${'quota'}, ${'open'})
      returning id
    `.execute(query);
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('the fixture period was not inserted');
    return id;
  });
}

/** An `available` selection — no root row, which is §5.3's own first mapping row. */
async function createSelection(periodId: string, weekStart: string): Promise<string> {
  return run(async ({ query }) => {
    const inserted = await sql<{ id: string }>`
      insert into vacation_selections
        (organization_id, group_id, membership_id, vacation_period_id, week_start, status)
      values (${context.organizationId}::uuid, ${context.groupId}::uuid,
              ${context.membershipId}::uuid, ${periodId}::uuid, ${weekStart}::date,
              ${'available'})
      returning id
    `.execute(query);
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('the fixture selection was not inserted');
    return id;
  });
}

/**
 * A selection AND its root, created and linked in ONE transaction.
 *
 * The pairing is not tidiness: D-18's zero-row guard is a DEFERRED constraint
 * trigger, so a root committed without its subtype row raises
 * `REQUEST_SUBTYPE_ROW_REQUIRED` at that commit. A fixture that inserted the
 * root in its own transaction would fail for a reason that has nothing to do
 * with the mapping — and the production writer does exactly this, in exactly
 * this order (`submitVacationSelection`).
 */
async function submittedSelection(
  periodId: string,
  weekStart: string,
): Promise<{ selectionId: string; requestId: string }> {
  return run(async ({ query }) => {
    const selection = await sql<{ id: string }>`
      insert into vacation_selections
        (organization_id, group_id, membership_id, vacation_period_id, week_start, status)
      values (${context.organizationId}::uuid, ${context.groupId}::uuid,
              ${context.membershipId}::uuid, ${periodId}::uuid, ${weekStart}::date,
              ${'available'})
      returning id
    `.execute(query);
    const selectionId = selection.rows[0]?.id;
    if (selectionId === undefined) throw new Error('the fixture selection was not inserted');

    const requestId = randomUUID();
    await sql`
      insert into requests
        (id, organization_id, group_id, membership_id, subtype, status, expires_at,
         idempotency_key, submitted_at)
      values (${requestId}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
              ${context.membershipId}::uuid, ${'vacation-selection'},
              app_request_initial_status(${'vacation-selection'}),
              ${'2099-06-01T00:00:00.000Z'}::timestamptz,
              ${`map.${randomUUID().slice(0, 12)}`}, now())
    `.execute(query);

    await sql`
      update vacation_selections
         set request_id = ${requestId}::uuid, status = ${'pending'}, version = version + 1
       where id = ${selectionId}::uuid
    `.execute(query);

    return { selectionId, requestId };
  });
}

/** The committed pair, read back after a transaction. */
async function pairOf(selectionId: string): Promise<{ selection: string; root: string | null }> {
  const rows = await run(
    async ({ query }) =>
      await sql<{ selection: string; root: string | null }>`
        select v.status as selection, r.status as root
          from vacation_selections v
          left join requests r on r.id = v.request_id
         where v.id = ${selectionId}::uuid
      `.execute(query),
  );
  const row = rows.rows[0];
  if (row === undefined) throw new Error('the selection is missing');
  return row;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The three tables
 * ──────────────────────────────────────────────────────────────────────────── */

describe('R-15 — the §5.3 table, held to itself across three layers', () => {
  it('the DOMAIN constant and the DATABASE function agree, row for row', async () => {
    const database = await databaseMapping();
    expect(database).toEqual(VACATION_STATUS_TO_REQUEST_STATUS);

    /* Non-vacuity, both directions: a function that returned null for everything
     * would equal a constant that did the same, and a comparison of two empty
     * things is a comparison of nothing. */
    const derived = Object.values(database);
    expect(derived.filter((value) => value !== null).length).toBeGreaterThan(0);
    expect(derived.filter((value) => value === null).length).toBe(1);
  }, 120_000);

  it('the CONTRACTS inverse and the DOMAIN inverse agree over every root status', () => {
    /* Every status in the wire enum, not only the seven §5.3 produces — so a
     * contracts table that gained a row the domain does not have fails here. */
    let mapped = 0;
    for (const root of REQUEST_STATUSES) {
      const fromDomain = selectionStatusForRootStatus(root);
      const fromContracts = selectionStatusForRootStatusWire(root);
      expect(fromContracts, `${root}`).toBe(fromDomain);
      if (fromDomain !== null) mapped += 1;
    }
    expect(mapped, 'the inverse must map SOMETHING').toBe(
      VACATION_SELECTION_STATUSES.length - 1,
    );
    /* And the contracts table has no key the domain's inverse does not produce. */
    for (const [root, selection] of Object.entries(VACATION_ROOT_STATUS_TO_SELECTION_STATUS)) {
      expect(selectionStatusForRootStatus(root as RequestStatus), root).toBe(selection);
    }
  });

  it('the CONTRACTS inverse round-trips through the DATABASE function', async () => {
    /* The strongest form of the three-way agreement: take each root status the
     * client would derive FROM, invert it with the browser's copy, and ask the
     * DATABASE what that selection status derives to. It must be the root status
     * we started from. A drift in any of the three copies breaks this. */
    const database = await databaseMapping();
    for (const root of REQUEST_STATUSES) {
      const selection = selectionStatusForRootStatusWire(root);
      if (selection === null) continue;
      expect(database[selection], `${root} → ${selection} → ?`).toBe(root);
    }
  }, 120_000);
});

/* ────────────────────────────────────────────────────────────────────────────
 * The live walk — R-15's own sentence
 * ──────────────────────────────────────────────────────────────────────────── */

describe('R-15 — the mapping holds after EVERY §5.3 transition', () => {
  it('walks every selection edge and finds the pair mapped at each commit', async () => {
    /* One selection per edge, walked from `available` along the shortest path to
     * the edge's source and then across the edge, with the pair read back after
     * every commit. The root path for each hop is the domain's own
     * `selectionEdgeRootPath`, so a writer that took a different path would be
     * refused by 0021's transition guard rather than silently accepted here. */
    const periodId = await createPeriod(
      WALK_PERIOD_START,
      VACATION_SELECTION_TRANSITIONS.length,
    );
    const seen = new Set<VacationSelectionStatus>();

    /* A DRAFT schedule version for the `approved → committed` hop.
     *
     * Added at OPUS-M5-004: migration 0027's
     * `vacation_selections_committed_version_coherent` makes
     * `(status = 'committed') = (committed_to_version_id IS NOT NULL)` an
     * EQUALITY, so a walk that moved a selection to `committed` without naming a
     * version is refused by the database — which is the constraint working, not
     * an obstacle. Nothing about R-15 is weakened: the walk still visits every
     * §5.3 edge and still reads the pair back after every commit; it now supplies
     * the one column the new CHECK requires, and CLEARS it again on the
     * `committed → reversed` hop for the same reason (§5.6's reversal leaves the
     * status and the column agreeing). */
    const walkVersionId = await run(async ({ query }) => {
      const schedulePeriodId = randomUUID();
      await sql`
        insert into schedule_periods (id, organization_id, group_id, name, start_date, end_date)
        values (${schedulePeriodId}::uuid, ${context.organizationId}::uuid,
                ${context.groupId}::uuid, ${'r15 walk'}, ${WALK_PERIOD_START}::date,
                (${WALK_PERIOD_START}::date + 200)::date)
      `.execute(query);
      const versionId = randomUUID();
      await sql`
        insert into schedule_versions (id, organization_id, group_id, period_id, state)
        values (${versionId}::uuid, ${context.organizationId}::uuid, ${context.groupId}::uuid,
                ${schedulePeriodId}::uuid, ${'draft'})
      `.execute(query);
      return versionId;
    });

    /** Moves a selection one §5.3 edge, both rows, in ONE transaction. */
    const step = async (
      selectionId: string,
      from: VacationSelectionStatus,
      to: VacationSelectionStatus,
      requestId: string,
    ): Promise<void> => {
      const path = selectionEdgeRootPath(from, to);
      if (path === null) throw new Error(`no §2 path for ${from} → ${to}`);
      /* The CHECK is an equality, so the column moves WITH the status: set on the
       * way into `committed`, cleared on the way out. Every other edge leaves it
       * NULL, which is what it already is. */
      const committedVersion = to === 'committed' ? walkVersionId : null;
      await run(async ({ query }) => {
        await sql`
          update vacation_selections
             set status = ${to},
                 committed_to_version_id = ${committedVersion}::uuid,
                 version = version + 1
           where id = ${selectionId}::uuid
        `.execute(query);
        for (const hop of path) {
          await sql`update requests set status = ${hop} where id = ${requestId}::uuid`.execute(
            query,
          );
        }
      });
    };

    for (const [index, edge] of VACATION_SELECTION_TRANSITIONS.entries()) {
      /* D-22 is one selection per (membership, period, week), so each edge needs
       * its OWN week — otherwise the second iteration collides with the first and
       * the failure looks like a mapping violation rather than a fixture reusing
       * a week. Every week is a Monday inside the round by construction. */
      /* `available → pending` is the CREATION edge: the selection is created, the
       * root is inserted and the link is written in ONE transaction, which is what
       * the production writer does and what D-18's deferred guard requires. */
      const { selectionId, requestId } = await submittedSelection(
        periodId,
        mondayAfter(WALK_PERIOD_START, index),
      );
      expect(await pairOf(selectionId)).toEqual({ selection: 'pending', root: 'submitted' });
      seen.add('pending');

      if (edge.from === 'available') {
        /* Already walked, and the assertion above IS this edge's. */
        seen.add('available');
        continue;
      }

      /* Walk to the edge's source, then across it. The only sources beyond
       * `pending` are `approved` and `committed`, each one hop further on. */
      if (edge.from === 'approved' || edge.from === 'committed') {
        await step(selectionId, 'pending', 'approved', requestId);
        expect(await pairOf(selectionId)).toEqual({ selection: 'approved', root: 'approved' });
        seen.add('approved');
      }
      if (edge.from === 'committed') {
        await step(selectionId, 'approved', 'committed', requestId);
        expect(await pairOf(selectionId)).toEqual({
          selection: 'committed',
          root: 'reflected_in_version',
        });
        seen.add('committed');
      }

      await step(selectionId, edge.from, edge.to, requestId);
      const pair = await pairOf(selectionId);
      expect(pair.selection, `${edge.from} → ${edge.to}`).toBe(edge.to);
      expect(pair.root, `${edge.from} → ${edge.to}: the derived root status`).toBe(
        VACATION_STATUS_TO_REQUEST_STATUS[edge.to],
      );
      seen.add(edge.to);

    }

    /* Non-vacuity: the walk must have visited every status §5.3 defines except
     * the ones no edge enters. A walk that stopped after one edge would satisfy
     * every assertion above and prove almost nothing. */
    expect([...seen].sort()).toEqual([...VACATION_SELECTION_STATUSES].sort());
  }, 300_000);
});

/* ────────────────────────────────────────────────────────────────────────────
 * D-27 — the deliberate desynchronisation, from BOTH sides
 * ──────────────────────────────────────────────────────────────────────────── */

describe('R-15 — a deliberately desynchronised write RAISES (D-27)', () => {
  it('moving the SELECTION and leaving the root behind is refused at commit', async () => {
    const periodId = await createPeriod('2052-06-03');
    const { selectionId } = await submittedSelection(periodId, '2052-06-03');

    await expect(
      run(async ({ query }) => {
        /* The selection moves and the root does not. Inside the transaction this
         * is legal — D-27 is DEFERRED, which is what makes §5.4's two-statement
         * writer implementable at all — and at COMMIT it raises. */
        await sql`
          update vacation_selections set status = ${'withdrawn'}, version = version + 1
           where id = ${selectionId}::uuid
        `.execute(query);
      }),
      'a selection moved without its root must not commit',
    ).rejects.toMatchObject({ code: '23001' });

    /* And the pair is untouched: the transaction rolled back rather than
     * committing half of it. */
    expect(await pairOf(selectionId)).toEqual({ selection: 'pending', root: 'submitted' });
  }, 180_000);

  it('moving the ROOT and leaving the selection behind is refused at commit', async () => {
    const periodId = await createPeriod('2053-06-02');
    const { selectionId, requestId } = await submittedSelection(periodId, '2053-06-02');

    await expect(
      run(async ({ query }) => {
        /* The other side of the pair, and it is not the first case restated: a
         * one-sided trigger would catch one of these two and not the other, and
         * §5.3's whole complaint is that two rows could disagree about whether a
         * vacation request had been withdrawn. */
        await sql`update requests set status = ${'withdrawn'}, withdrawn_at = now()
                   where id = ${requestId}::uuid`.execute(query);
      }),
      'a root moved without its selection must not commit',
    ).rejects.toMatchObject({ code: '23001' });

    expect(await pairOf(selectionId)).toEqual({ selection: 'pending', root: 'submitted' });
  }, 180_000);

  it('an `available` selection with no root is NOT a violation — §5.3 says so', async () => {
    /* The guard's own caution, asserted: a trigger that raised on this row would
     * refuse the one state the specification defines as pre-request, and every
     * unsubmitted week in a round would be unrepresentable. */
    const periodId = await createPeriod('2054-06-01');
    const selectionId = await createSelection(periodId, '2054-06-01');
    expect(await pairOf(selectionId)).toEqual({ selection: 'available', root: null });
  }, 120_000);
});
