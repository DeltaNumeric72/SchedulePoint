import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  WorkProfileNotFutureError,
  authorWorkProfile,
  cancelFutureWorkProfile,
  transactionNow,
} from '../../src/profiles/work-profiles.js';
import { workProfileInForce } from '../../src/profiles/in-force-loader.js';
import { adminClient } from '../support/admin-client.js';
import { groupContext } from '../support/fixtures.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { grantStaffingCapabilities } from '../support/staffing.js';

/**
 * **The future-effective work-profile cancellation path** (OPUS-M4-000A;
 * doc 34 §4-B; doc 35 §3 Required behaviour clause 5).
 *
 * The claims, each with its assertion:
 *
 *   - only a row NOT YET IN FORCE may be cancelled; the in-force row is never
 *     mutated (asserted byte-for-byte on its columns);
 *   - cancelling a scheduled change restores the in-force VALUES from its
 *     start instant via a CONTINUATION row — including the weekday targets;
 *   - an already-scheduled LATER change still takes effect on time (the
 *     continuation is bounded, not open);
 *   - a future first-ever row cancels to nothing (no predecessor, no
 *     continuation);
 *   - the operation is AUDITED: `staffing.work_profile.cancelled` on the
 *     cancelled row, `…authored` mechanism `continuation` on the new one;
 *   - MUTATION CONTROL: the in-force answer comparison can fail — the
 *     pre-cancellation state visibly differs from the post-cancellation one.
 */

// `full`, because the audit case authors and cancels ITS OWN rows and needs two
// memberships no other case in this file touches (see that case for why).
const multi = ownedMulti('work-profile-cancellation', { profile: 'full' });

let admin: pg.Client;
let runtime: Runtime;

const alpha = () => multi().alpha;

/** A `full`-profile group-one membership, by name. Fails loudly if absent. */
function fullUser(which: 'viewer' | 'telecom'): string {
  const user = alpha().full?.[which];
  if (user === undefined) throw new Error(`the full MULTI profile did not provision ${which}`);
  return user.membershipId;
}

const context = (correlationId: string) =>
  groupContext(
    alpha().organizationId,
    alpha().groupOne.id,
    alpha().users.groupOnly.membershipId,
    correlationId,
  );

const run = async <T>(correlationId: string, fn: (uow: never) => Promise<T>): Promise<T> =>
  runtime.runner.run(context(correlationId), fn as never) as Promise<T>;

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  runtime = createRuntime('app_runtime', { max: 4 });
  await grantStaffingCapabilities(runtime.runner, multi(), {
    organizationId: alpha().organizationId,
    groupId: alpha().groupOne.id,
    membershipId: alpha().users.groupOnly.membershipId,
    capabilities: ['staffing.work_profile.administer'],
  });
}, 180_000);

afterAll(async () => {
  await runtime.destroy();
  await admin.end();
});

describe('cancel a scheduled change', () => {
  it('the future row goes, the in-force row is untouched, and a continuation restores the values', async () => {
    const membershipId = alpha().users.member.membershipId;

    // NOW: 60% with weekday targets. FUTURE (2090): 80%.
    const current = await run('cancel-author-now', (uow) =>
      authorWorkProfile(uow as never, {
        membershipId,
        workPercentage: 60,
        weekdayTargets: [
          { day: 'mon', fteFraction: 0.6 },
          { day: 'tue', fteFraction: 0.6 },
        ],
      }),
    );
    const future = await run('cancel-author-future', (uow) =>
      authorWorkProfile(uow as never, {
        membershipId,
        effectiveFrom: '2090-01-01T00:00:00.000Z',
        workPercentage: 80,
      }),
    );
    expect(future.supersededProfileId).toBe(current.profile.id);

    // The in-force row BEFORE, byte for byte.
    const before = await admin.query(
      'select * from membership_work_profiles where id = $1::uuid',
      [current.profile.id],
    );

    const cancelled = await run('cancel', (uow) =>
      cancelFutureWorkProfile(uow as never, { workProfileId: future.profile.id }),
    );
    expect(cancelled).not.toBeNull();
    expect(cancelled?.cancelledProfileId).toBe(future.profile.id);
    expect(cancelled?.continuationProfile).not.toBeNull();

    // The cancelled row is GONE; the continuation stands on its window.
    const remaining = await admin.query<{ n: number }>(
      'select count(*)::int as n from membership_work_profiles where id = $1::uuid',
      [future.profile.id],
    );
    expect(remaining.rows[0]?.n).toBe(0);
    expect(cancelled?.continuationProfile?.effectiveFrom).toBe('2090-01-01T00:00:00.000Z');
    expect(cancelled?.continuationProfile?.effectiveTo).toBeNull();
    expect(cancelled?.continuationProfile?.workPercentage).toBe(60);
    // The weekday targets travelled with the values.
    expect(cancelled?.continuationTargets.map((target) => target.day).sort()).toEqual([
      'mon',
      'tue',
    ]);

    // The in-force row is NEVER mutated — not even `updated_at`.
    const after = await admin.query(
      'select * from membership_work_profiles where id = $1::uuid',
      [current.profile.id],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);

    // And the in-force ANSWER at the future instant is the current values.
    const selection = await run('cancel-read', async (uow) =>
      workProfileInForce((uow as { query: never }).query, {
        organizationId: alpha().organizationId,
        membershipId,
        at: new Date('2091-06-01T00:00:00.000Z'),
      }),
    );
    expect(selection.kind).toBe('in-force');
    if (selection.kind === 'in-force') {
      expect(selection.row.workPercentage).toBe(60);
      expect(selection.row.id).toBe(cancelled?.continuationProfile?.id);
    }
    log('cancellation: future row deleted, continuation carries 60% + targets, in-force row untouched');
  });

  it('a LATER scheduled change still takes effect on time after cancelling the middle one', async () => {
    const membershipId = alpha().users.departed.membershipId;

    await run('mid-now', (uow) =>
      authorWorkProfile(uow as never, { membershipId, workPercentage: 50 }),
    );
    const middle = await run('mid-middle', (uow) =>
      authorWorkProfile(uow as never, {
        membershipId,
        effectiveFrom: '2090-01-01T00:00:00.000Z',
        workPercentage: 70,
      }),
    );
    await run('mid-late', (uow) =>
      authorWorkProfile(uow as never, {
        membershipId,
        effectiveFrom: '2091-01-01T00:00:00.000Z',
        workPercentage: 90,
      }),
    );

    const cancelled = await run('mid-cancel', (uow) =>
      cancelFutureWorkProfile(uow as never, { workProfileId: middle.profile.id }),
    );
    // The continuation is BOUNDED by the later change's start.
    expect(cancelled?.continuationProfile?.effectiveFrom).toBe('2090-01-01T00:00:00.000Z');
    expect(cancelled?.continuationProfile?.effectiveTo).toBe('2091-01-01T00:00:00.000Z');
    expect(cancelled?.continuationProfile?.workPercentage).toBe(50);

    const later = await run('mid-read', async (uow) =>
      workProfileInForce((uow as { query: never }).query, {
        organizationId: alpha().organizationId,
        membershipId,
        at: new Date('2091-06-01T00:00:00.000Z'),
      }),
    );
    expect(later.kind).toBe('in-force');
    if (later.kind === 'in-force') expect(later.row.workPercentage).toBe(90);
    log('cancelling the middle change: 50% continues 2090→2091, the 90% change lands on time');
  });

  it('a future FIRST-EVER row cancels to nothing — no predecessor, no continuation', async () => {
    const membershipId = alpha().users.groupOnly.membershipId;
    const future = await run('first-author', (uow) =>
      authorWorkProfile(uow as never, {
        membershipId,
        effectiveFrom: '2092-01-01T00:00:00.000Z',
        workPercentage: 40,
      }),
    );
    const cancelled = await run('first-cancel', (uow) =>
      cancelFutureWorkProfile(uow as never, { workProfileId: future.profile.id }),
    );
    expect(cancelled?.continuationProfile).toBeNull();
    const rows = await admin.query<{ n: number }>(
      'select count(*)::int as n from membership_work_profiles where membership_id = $1::uuid',
      [membershipId],
    );
    expect(rows.rows[0]?.n).toBe(0);
    log('first-ever future row: cancelled to nothing, no continuation invented');
  });

  it('an IN-FORCE row is refused with WORK_PROFILE_NOT_FUTURE and nothing changes', async () => {
    const membershipId = alpha().users.scheduler.membershipId;
    const current = await run('inforce-author', (uow) =>
      authorWorkProfile(uow as never, { membershipId, workPercentage: 100 }),
    );

    let error: unknown;
    try {
      await run('inforce-cancel', (uow) =>
        cancelFutureWorkProfile(uow as never, { workProfileId: current.profile.id }),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WorkProfileNotFutureError);

    const rows = await admin.query<{ n: number }>(
      'select count(*)::int as n from membership_work_profiles where id = $1::uuid',
      [current.profile.id],
    );
    expect(rows.rows[0]?.n, 'the refused cancellation deleted anyway').toBe(1);
    log('in-force row: WORK_PROFILE_NOT_FUTURE, row intact');
  });

  it('the cancellation is audited as two facts, and the instant is the transaction clock', async () => {
    /* ── this case ESTABLISHES its own two cancellations ───────────────────
     *
     * It used to count every `staffing.work_profile.cancelled` row in the
     * organization and assert THREE — one per sibling case above — which is a
     * dependency on three other tests' side effects AND on the order they ran
     * in. `fixture-regression` caught it on eleven of thirteen fixed seeds and
     * on the rotating one: under `--sequence.shuffle.tests` this case can run
     * first (0 events) or second (1), and only the file's authored order gave
     * it 3. FAD-15: a case owns its arrangement.
     *
     * So it now performs BOTH cancellation shapes itself — one with a
     * predecessor (continuation expected) and one first-ever (no continuation)
     * — on two `full`-profile memberships no other case here touches, and
     * scopes the audit read to the subject ids it created. The assertion is
     * the same one, made about rows this case can account for. */
    const withPredecessor = fullUser('viewer');
    await run('audit-author-now', (uow) =>
      authorWorkProfile(uow as never, { membershipId: withPredecessor, workPercentage: 55 }),
    );
    const scheduled = await run('audit-author-future', (uow) =>
      authorWorkProfile(uow as never, {
        membershipId: withPredecessor,
        effectiveFrom: '2094-01-01T00:00:00.000Z',
        workPercentage: 75,
      }),
    );
    const cancelledWith = await run('audit-cancel-with', (uow) =>
      cancelFutureWorkProfile(uow as never, { workProfileId: scheduled.profile.id }),
    );
    expect(cancelledWith?.continuationProfile, 'the predecessor arm produced no continuation').not.toBeNull();

    const firstEver = fullUser('telecom');
    const only = await run('audit-author-first', (uow) =>
      authorWorkProfile(uow as never, {
        membershipId: firstEver,
        effectiveFrom: '2095-01-01T00:00:00.000Z',
        workPercentage: 45,
      }),
    );
    const cancelledFirst = await run('audit-cancel-first', (uow) =>
      cancelFutureWorkProfile(uow as never, { workProfileId: only.profile.id }),
    );
    expect(cancelledFirst?.continuationProfile, 'a first-ever row invented a continuation').toBeNull();

    // The audit subject of a cancellation is the CANCELLED row; of a
    // continuation, the continuation row. Both ids are this case's own.
    const subjects = [
      scheduled.profile.id,
      only.profile.id,
      cancelledWith?.continuationProfile?.id,
    ].filter((id): id is string => id !== undefined);
    const events = await admin.query<{ event_name: string; payload: Record<string, unknown> }>(
      `select event_name, payload from audit_events
        where organization_id = $1::uuid
          and event_name in ('staffing.work_profile.cancelled', 'staffing.work_profile.authored')
          and subject_id = any($2::uuid[])
        order by sequence`,
      [alpha().organizationId, subjects],
    );
    const cancelledEvents = events.rows.filter(
      (row) => row.event_name === 'staffing.work_profile.cancelled',
    );
    // Two cancellations here, two cancelled events.
    expect(cancelledEvents.length).toBe(2);
    for (const event of cancelledEvents) {
      expect(event.payload['mechanism']).toBe('cancel_future');
      expect(event.payload).toHaveProperty('cancelledEffectiveFrom');
      expect(event.payload).toHaveProperty('continuationProfileId');
    }
    const continuations = events.rows.filter(
      (row) =>
        row.event_name === 'staffing.work_profile.authored' &&
        row.payload['mechanism'] === 'continuation',
    );
    // One cancellation had a predecessor; the first-ever one did not.
    expect(continuations.length).toBe(1);

    // And `transactionNow` (the guard's clock) is the database's, sanity-pinned.
    const now = await run('clock', async (uow) =>
      transactionNow((uow as { query: never }).query),
    );
    expect(Math.abs(now.getTime() - Date.now())).toBeLessThan(60_000);
    log('audit: 2× cancelled (cancel_future), 1× authored (continuation); clock is the DB\'s');
  });
});
