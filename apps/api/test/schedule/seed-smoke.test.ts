import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * The schedule fixture actually seeds — the cheapest possible proof that the
 * production write path this packet ships runs end to end.
 *
 * It is a smoke test and says so: it asserts that a published history EXISTS in
 * both groups, not that any invariant holds. The invariants are proven by the
 * V-01..V-19 harness and by the immutability suite.
 */

const multi = ownedMulti('schedule-seed-smoke', {
  profile: 'core',
  seed: { catalogue: ['alpha'], schedule: true },
});

let runtime: Runtime;

beforeAll(() => {
  runtime = createRuntime('app_runtime', { max: 3 });
});

afterAll(async () => {
  // Guarded: when `beforeAll` failed (a seeding defect), `runtime` is undefined
  // and an unguarded dispose replaces the real failure with a TypeError.
  await runtime?.destroy();
});

describe('schedule fixture seeding', () => {
  it('publishes a two-version history in Group One and in the sibling group', () => {
    const schedule = multi().schedule;
    expect(schedule, 'seed.schedule was requested').toBeDefined();
    if (schedule === undefined) return;

    for (const group of [schedule.groupOne, schedule.sibling]) {
      expect(group.periodId).toBeTruthy();
      expect(group.firstVersionId).not.toEqual(group.currentVersionId);
      expect(group.assignmentIdentityIds).toHaveLength(2);
    }
  });

  it('leaves exactly one current version per period, with the first superseded', async () => {
    const fixture = multi();
    const schedule = fixture.schedule;
    if (schedule === undefined) throw new Error('no schedule seed');

    await runtime.runner.run(
      {
        organizationId: fixture.alpha.organizationId,
        groupId: fixture.alpha.groupOne.id,
        membershipId: fixture.alpha.users.scheduler.membershipId,
        correlationId: 'seed-smoke',
      },
      async ({ query }) => {
        const versions = await query
          .selectFrom('schedule_versions')
          .select(['id', 'state', 'is_current', 'version_number'])
          .where('period_id', '=', schedule.groupOne.periodId)
          .execute();

        expect(versions).toHaveLength(2);
        expect(versions.filter((v) => v.is_current)).toHaveLength(1);

        const first = versions.find((v) => v.id === schedule.groupOne.firstVersionId);
        const current = versions.find((v) => v.id === schedule.groupOne.currentVersionId);
        expect(first?.state).toBe('superseded');
        expect(first?.version_number).toBe(1);
        expect(current?.state).toBe('published');
        expect(current?.is_current).toBe(true);
        expect(current?.version_number).toBe(2);

        // Reality holds only the CURRENT version's rows.
        const reality = await query
          .selectFrom('current_published_assignments')
          .select(['source_version_id'])
          .where('period_id', '=', schedule.groupOne.periodId)
          .execute();
        expect(reality.length).toBeGreaterThan(0);
        expect(
          reality.every((row) => row.source_version_id === schedule.groupOne.currentVersionId),
          'current_published_assignments carries no stale rows',
        ).toBe(true);
      },
    );
  });
});
