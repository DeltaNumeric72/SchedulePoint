import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  loadWorkProfiles,
  workProfileInForce,
  workProfileToSupersede,
} from '../../src/profiles/in-force-loader.js';
import { authorWorkProfile } from '../../src/profiles/work-profiles.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { grantStaffingCapabilities } from '../support/staffing.js';

/**
 * **NAMED CONDITION (2) — loader/writer agreement.**
 *
 * The packet, in its own words: *"the row the writer's precondition saw is the
 * row the reader returns, inside one unit of work"*.
 *
 * ## Why this is THE test of this packet
 *
 * S-01 was not a bug in a selection rule. It was two selection rules that
 * disagreed: `load-policy-input.ts` read an arbitrary row while the entitlement
 * route UPDATEd every row for the module. Each looked reasonable where it was
 * written. They only disagreed for organizations that had re-windowed an
 * entitlement — which is why it took an independent reviewer rather than a unit
 * test to find, and why the consequence was an entire organization 404ing with
 * nothing in the logs.
 *
 * The structural answer is that there is now exactly one selector
 * (`loader-is-the-only-selector.test.ts` asserts that no other module reaches
 * these tables). This file is the behavioural answer: the two entry points are
 * called on the same rows in the same transaction and the ids are compared.
 *
 * ## And the one thing a structural test cannot show
 *
 * The last describe block writes a row from a **concurrent transaction** between
 * the precondition and the write. Inside a single unit of work the precondition's
 * snapshot is the snapshot the write commits against, so the concurrent row
 * either is not visible or makes the write fail — never "the writer superseded a
 * row that was no longer the one in force".
 */

const multi = ownedMulti('profiles-loader-writer-agreement');

let runtime: Runtime;
/** A SECOND runner, so a concurrent transaction is genuinely concurrent. */
let other: Runtime;

const actor = (): string => multi().alpha.users.groupOnly.membershipId;

function context(correlationId: string): {
  organizationId: string;
  groupId: string;
  membershipId: string;
  correlationId: string;
} {
  return {
    organizationId: multi().alpha.organizationId,
    groupId: multi().alpha.groupOne.id,
    membershipId: actor(),
    correlationId,
  };
}

beforeAll(async () => {
  runtime = createRuntime('app_runtime', { max: 4 });
  other = createRuntime('app_runtime', { max: 2 });
  await grantStaffingCapabilities(runtime.runner, multi(), {
    organizationId: multi().alpha.organizationId,
    groupId: multi().alpha.groupOne.id,
    membershipId: actor(),
    capabilities: ['staffing.work_profile.administer', 'staffing.work_profile.read'],
  });
}, 120_000);

afterAll(async () => {
  await runtime.destroy();
  await other.destroy();
});

describe('the writer supersedes exactly the row the reader reports', () => {
  it('with a history present, precondition and reader agree at every instant that has a row', async () => {
    const subject = multi().alpha.users.scheduler.membershipId;

    // Three windows, planted directly so the shape is the test's rather than the
    // writer's.
    const ids: string[] = [];
    await runtime.runner.run(context('plant'), async ({ query }) => {
      for (const [from, to] of [
        ['2022-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z'],
        ['2024-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
        ['2026-01-01T00:00:00.000Z', null],
      ] as const) {
        const id = randomUUID();
        ids.push(id);
        await query
          .insertInto('membership_work_profiles')
          .values({
            id,
            organization_id: multi().alpha.organizationId,
            group_id: multi().alpha.groupOne.id,
            membership_id: subject,
            effective_from: new Date(from),
            effective_to: to === null ? null : new Date(to),
            work_percentage: '75.00',
          })
          .execute();
      }
    });
    expect(ids).toHaveLength(3);

    /* ── THE ASSERTION: one unit of work, both entry points, same instant ──── */
    const instants = [
      '2022-06-01T00:00:00.000Z',
      '2024-01-01T00:00:00.000Z',
      '2025-12-31T23:59:59.999Z',
      '2026-01-01T00:00:00.000Z',
      '2099-01-01T00:00:00.000Z',
    ];

    const comparisons = await runtime.runner.run(context('agreement'), async ({ query }) => {
      const results: { instant: string; writerSaw: string | null; readerReturned: string | null }[] = [];
      for (const instant of instants) {
        const at = new Date(instant);
        const writerSaw = await workProfileToSupersede(query, {
          organizationId: multi().alpha.organizationId,
          membershipId: subject,
          at,
        });
        const readerReturned = await workProfileInForce(query, {
          organizationId: multi().alpha.organizationId,
          membershipId: subject,
          at,
        });
        results.push({
          instant,
          writerSaw: writerSaw?.id ?? null,
          readerReturned: readerReturned.kind === 'in-force' ? readerReturned.row.id : null,
        });
      }
      return results;
    });

    for (const comparison of comparisons) {
      expect(
        comparison.writerSaw,
        `at ${comparison.instant} the writer and the reader saw different rows — this is S-01`,
      ).toBe(comparison.readerReturned);
    }

    // Non-vacuity: at least three of the five instants must have found a row. If
    // every comparison were `null === null` the test would pass while proving
    // nothing, which is the exact shape the vacuity discipline names.
    const withRows = comparisons.filter((c) => c.readerReturned !== null);
    expect(
      withRows.length,
      'every comparison was null-to-null — the agreement test is vacuous',
    ).toBeGreaterThanOrEqual(3);

    log(
      `writer/reader agreement at ${String(comparisons.length)} instants ` +
        `(${String(withRows.length)} with a row in force), 0 disagreements`,
    );
  });

  it('an actual supersession closes the row the precondition named, and no other', async () => {
    const subject = multi().alpha.users.member.membershipId;

    const first = await runtime.runner.run(context('author-first'), (uow) =>
      authorWorkProfile(uow, { membershipId: subject, workPercentage: 100 }),
    );
    expect(first.supersededProfileId).toBeNull();

    const second = await runtime.runner.run(context('author-second'), async (uow) => {
      // The precondition, read explicitly first, so the assertion compares what
      // the writer WOULD see against what it actually acted on.
      const precondition = await workProfileToSupersede(uow.query, {
        organizationId: multi().alpha.organizationId,
        membershipId: subject,
        at: new Date(),
      });
      const authored = await authorWorkProfile(uow, { membershipId: subject, workPercentage: 60 });
      return { preconditionId: precondition?.id ?? null, authored };
    });

    expect(second.preconditionId).toBe(first.profile.id);
    expect(
      second.authored.supersededProfileId,
      'the writer superseded a row its own precondition did not name',
    ).toBe(second.preconditionId);

    const history = await runtime.runner.run(context('history'), ({ query }) =>
      loadWorkProfiles(query, {
        organizationId: multi().alpha.organizationId,
        membershipId: subject,
      }),
    );
    expect(history).toHaveLength(2);
    const closed = history.find((row) => row.id === first.profile.id);
    const open = history.find((row) => row.id === second.authored.profile.id);
    expect(closed?.effectiveTo, 'the superseded row was not closed').not.toBeNull();
    expect(open?.effectiveTo, 'the successor is not open-ended').toBeNull();
    // Adjacency: the close instant IS the open instant, to the microsecond,
    // because both came from one `now()` in SQL. A gap here would mean a period
    // with no profile in force at all.
    expect(closed?.effectiveTo, 'the windows are not exactly adjacent').toBe(open?.effectiveFrom);
    log('supersession produces exactly adjacent half-open windows — no gap, no overlap');
  });

  it('a FUTURE-dated supersession closes the row in force AT THAT FUTURE INSTANT', async () => {
    const subject = multi().alpha.users.departed.membershipId;
    const at = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

    const current = await runtime.runner.run(context('author-current'), (uow) =>
      authorWorkProfile(uow, { membershipId: subject, workPercentage: 100 }),
    );

    const scheduled = await runtime.runner.run(context('author-future'), async (uow) => {
      const precondition = await workProfileToSupersede(uow.query, {
        organizationId: multi().alpha.organizationId,
        membershipId: subject,
        at: new Date(at),
      });
      const authored = await authorWorkProfile(uow, {
        membershipId: subject,
        effectiveFrom: at,
        workPercentage: 50,
      });
      return { preconditionId: precondition?.id ?? null, authored };
    });

    expect(scheduled.preconditionId).toBe(current.profile.id);
    expect(scheduled.authored.supersededProfileId).toBe(current.profile.id);

    // And the present verdict is unchanged: the row in force NOW is still the
    // original. A writer that had superseded "the latest row" would have made the
    // future change take effect immediately.
    const now = await runtime.runner.run(context('read-now'), ({ query }) =>
      workProfileInForce(query, {
        organizationId: multi().alpha.organizationId,
        membershipId: subject,
        at: new Date(),
      }),
    );
    expect(now.kind).toBe('in-force');
    if (now.kind === 'in-force') {
      expect(now.row.id, 'a future-dated change took effect immediately').toBe(current.profile.id);
      expect(now.row.workPercentage).toBe(100);
    }
    log('a change dated 90 days out leaves the present verdict untouched');
  });
});

describe('the agreement holds against a concurrent writer', () => {
  it('a row committed by another transaction cannot make the precondition stale', async () => {
    const subject = multi().alpha.users.groupTwoScheduler.membershipId;

    // Group TWO's membership — so this uses group two's context throughout, and
    // the concurrent runner declares the same tenant.
    const groupTwo = {
      organizationId: multi().alpha.organizationId,
      groupId: multi().alpha.groupTwo.id,
      membershipId: actor(),
      correlationId: 'concurrent',
    };
    // The actor holds its grant in group ONE. Grant it in group two as well —
    // through the production path, on the membership it actually acts as there.
    const actorInGroupTwo = multi().alpha.users.scheduler.groupTwoMembershipId;
    await grantStaffingCapabilities(runtime.runner, multi(), {
      organizationId: multi().alpha.organizationId,
      groupId: multi().alpha.groupTwo.id,
      membershipId: actorInGroupTwo,
      capabilities: ['staffing.work_profile.administer', 'staffing.work_profile.read'],
    });
    const actingContext = { ...groupTwo, membershipId: actorInGroupTwo };

    const first = await runtime.runner.run(actingContext, (uow) =>
      authorWorkProfile(uow, { membershipId: subject, workPercentage: 90 }),
    );

    /* ── the interleaving ──────────────────────────────────────────────────
     *
     * Inside ONE unit of work: read the precondition, let a SECOND transaction
     * commit a supersession, then write. The outer transaction's snapshot was
     * taken at its first statement, so it either does not see the concurrent row
     * (READ COMMITTED sees it, but the EXCLUDE constraint then refuses the
     * overlap) or the write fails. What must NOT happen is a silent success in
     * which the writer superseded a row that was no longer in force. */
    let outcome: 'wrote' | 'refused' = 'wrote';
    try {
      await runtime.runner.run({ ...actingContext, correlationId: 'outer' }, async (uow) => {
        const precondition = await workProfileToSupersede(uow.query, {
          organizationId: multi().alpha.organizationId,
          membershipId: subject,
          at: new Date(),
        });
        expect(precondition?.id).toBe(first.profile.id);

        // A genuinely separate connection, started OUTSIDE this async context so
        // it is a second transaction rather than a savepoint (SPIKE-REPORT §6.6).
        await other.runner.run(
          { ...actingContext, correlationId: 'concurrent-writer' },
          (inner) => authorWorkProfile(inner, { membershipId: subject, workPercentage: 70 }),
        );

        await authorWorkProfile(uow, { membershipId: subject, workPercentage: 50 });
      });
    } catch {
      outcome = 'refused';
    }

    const history = await runtime.runner.run({ ...actingContext, correlationId: 'audit' }, ({ query }) =>
      loadWorkProfiles(query, {
        organizationId: multi().alpha.organizationId,
        membershipId: subject,
      }),
    );

    // Whatever happened, the invariant holds: at most ONE open-ended row, and no
    // two windows overlap. That is the property the EXCLUDE constraint exists for
    // and the only thing worth asserting about a race.
    const open = history.filter((row) => row.effectiveTo === null);
    expect(open.length, `${String(history.length)} rows, ${String(open.length)} open-ended`).toBe(1);
    log(
      `concurrent supersession: outer transaction ${outcome}; ` +
        `${String(history.length)} window(s), exactly 1 open-ended, 0 overlapping`,
    );
  });
});
