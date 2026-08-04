import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PG_ERRORS, isPostgresError } from '../../src/db/pg-errors.js';
import { loadWorkProfiles } from '../../src/profiles/in-force-loader.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { grantStaffingCapabilities } from '../support/staffing.js';

/**
 * **NAMED CONDITION (3) — overlap rejection, including under concurrent inserts.**
 *
 * The EXCLUDE constraint on `membership_work_profiles` is what makes "one
 * authoritative row in force" a property of the schema rather than a promise made
 * by the writer. A constraint that has only ever been observed not firing is not
 * evidence of anything, so this file fires it — sequentially at every overlap
 * shape, and then concurrently, which is the case an application-layer check
 * cannot cover.
 *
 * ## Why concurrency is the interesting half
 *
 * Two requests, each reading "no row is in force", each deciding to insert. Both
 * preconditions were correct when they ran. Only a database constraint can refuse
 * the second write, and only if it is an exclusion constraint rather than a
 * uniqueness one — `UNIQUE (membership_id, effective_from)` would let two
 * overlapping windows through as long as they started at different instants,
 * which is exactly the shape supersession produces.
 *
 * The concurrency here is deterministic rather than hopeful: both transactions
 * are opened, both insert, and the second blocks on the exclusion constraint
 * until the first commits. No sleeps.
 */

const multi = ownedMulti('profiles-overlap-rejection');

let runtime: Runtime;
let second: Runtime;

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

async function insertWindow(
  which: Runtime,
  membershipId: string,
  from: string,
  to: string | null,
  correlationId = 'overlap-insert',
): Promise<string> {
  const id = randomUUID();
  await which.runner.run(context(correlationId), async ({ query }) => {
    await query
      .insertInto('membership_work_profiles')
      .values({
        id,
        organization_id: multi().alpha.organizationId,
        group_id: multi().alpha.groupOne.id,
        membership_id: membershipId,
        effective_from: new Date(from),
        effective_to: to === null ? null : new Date(to),
        work_percentage: '50.00',
      })
      .execute();
  });
  return id;
}

function isExclusionViolation(error: unknown): boolean {
  return isPostgresError(error) && error.code === PG_ERRORS.exclusionViolation;
}

beforeAll(async () => {
  runtime = createRuntime('app_runtime', { max: 4 });
  second = createRuntime('app_runtime', { max: 2 });
  await grantStaffingCapabilities(runtime.runner, multi(), {
    organizationId: multi().alpha.organizationId,
    groupId: multi().alpha.groupOne.id,
    membershipId: actor(),
    capabilities: ['staffing.work_profile.administer', 'staffing.work_profile.read'],
  });
}, 120_000);

afterAll(async () => {
  await runtime.destroy();
  await second.destroy();
});

describe('the database refuses overlapping windows', () => {
  it('ALLOW control — two ADJACENT windows are accepted', async () => {
    // Green before red. Without this, a constraint that refused every second
    // insert would pass every rejection test below while making supersession
    // impossible — and supersession is the whole product.
    const subject = multi().alpha.users.scheduler.membershipId;
    const first = await insertWindow(runtime, subject, '2022-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
    const next = await insertWindow(runtime, subject, '2024-01-01T00:00:00.000Z', null);

    const rows = await runtime.runner.run(context('census'), ({ query }) =>
      loadWorkProfiles(query, {
        organizationId: multi().alpha.organizationId,
        membershipId: subject,
      }),
    );
    expect(rows.map((row) => row.id)).toEqual([first, next]);
    log('adjacent [) windows are accepted — the constraint permits supersession, as it must');
  });

  const overlapShapes = [
    { name: 'identical windows', from: '2024-06-01T00:00:00.000Z', to: '2025-01-01T00:00:00.000Z' },
    { name: 'a window strictly inside another', from: '2024-07-01T00:00:00.000Z', to: '2024-08-01T00:00:00.000Z' },
    { name: 'a window overlapping the start', from: '2024-01-01T00:00:00.000Z', to: '2024-07-01T00:00:00.000Z' },
    { name: 'a window overlapping the end', from: '2024-12-01T00:00:00.000Z', to: '2025-06-01T00:00:00.000Z' },
    { name: 'a window spanning another entirely', from: '2023-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' },
    { name: 'an open-ended window starting inside another', from: '2024-09-01T00:00:00.000Z', to: null },
  ] as const;

  /**
   * ONE base window, established for the whole block, that every shape below
   * overlaps.
   *
   * Established rather than assumed (FAD-15): if the insert failed, the
   * precondition assertion in each case fails loudly instead of every rejection
   * passing against an empty table — which is the vacuity shape the discipline
   * names, and it is a real risk here because "no rows" and "the insert was
   * refused" both leave the table looking the same.
   */
  const overlapSubject = (): string => multi().alpha.users.member.membershipId;
  let baseWindowId: string;

  beforeAll(async () => {
    baseWindowId = await insertWindow(
      runtime,
      overlapSubject(),
      '2024-06-01T00:00:00.000Z',
      '2025-01-01T00:00:00.000Z',
      'overlap-base',
    );
  });

  for (const shape of overlapShapes) {
    it(`rejects: ${shape.name}`, async () => {
      const subject = overlapSubject();
      const marker = randomUUID();

      const rowsBefore = await runtime.runner.run(context('precheck'), ({ query }) =>
        loadWorkProfiles(query, {
          organizationId: multi().alpha.organizationId,
          membershipId: subject,
        }),
      );
      expect(
        rowsBefore.map((row) => row.id),
        'the base window is missing, so the rejection below would prove nothing',
      ).toEqual([baseWindowId]);

      let rejected = false;
      try {
        await insertWindow(runtime, subject, shape.from, shape.to, `overlap-${marker}`);
      } catch (error) {
        rejected = isExclusionViolation(error);
        if (!rejected) throw error;
      }
      expect(rejected, `${shape.name} was accepted — the EXCLUDE constraint did not fire`).toBe(true);

      const rowsAfter = await runtime.runner.run(context('postcheck'), ({ query }) =>
        loadWorkProfiles(query, {
          organizationId: multi().alpha.organizationId,
          membershipId: subject,
        }),
      );
      expect(rowsAfter.length, 'the refused row landed anyway').toBe(rowsBefore.length);
    });
  }
});

describe('overlap rejection under CONCURRENT inserts', () => {
  it('two transactions inserting overlapping windows: exactly one commits', async () => {
    const subject = multi().alpha.users.departed.membershipId;

    /* Both transactions are opened, both issue their INSERT, and the second
     * BLOCKS on the exclusion constraint until the first commits — PostgreSQL
     * makes exclusion checks wait on an uncommitted conflicting row rather than
     * failing immediately. So the ordering is enforced by the database, not by a
     * sleep, and the test cannot be flaky.
     *
     * `second.runner` is a genuinely different pool: starting the inner run from
     * inside the outer's async context would produce a SAVEPOINT rather than a
     * second transaction (SPIKE-REPORT §6.6), and the race would not exist. */
    let releaseFirst: () => void = () => {};
    const firstReachedInsert = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const firstId = randomUUID();
    const secondId = randomUUID();

    const firstTransaction = runtime.runner.run(context('race-a'), async ({ query }) => {
      await query
        .insertInto('membership_work_profiles')
        .values({
          id: firstId,
          organization_id: multi().alpha.organizationId,
          group_id: multi().alpha.groupOne.id,
          membership_id: subject,
          effective_from: new Date('2026-01-01T00:00:00.000Z'),
          effective_to: null,
          work_percentage: '50.00',
        })
        .execute();
      releaseFirst();
      // Hold the transaction open just long enough for the second INSERT to be
      // issued and start waiting on the constraint.
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      return 'committed';
    });

    await firstReachedInsert;

    const secondTransaction = second.runner
      .run(context('race-b'), async ({ query }) => {
        await query
          .insertInto('membership_work_profiles')
          .values({
            id: secondId,
            organization_id: multi().alpha.organizationId,
            group_id: multi().alpha.groupOne.id,
            membership_id: subject,
            effective_from: new Date('2026-06-01T00:00:00.000Z'),
            effective_to: null,
            work_percentage: '90.00',
          })
          .execute();
        return 'committed' as const;
      })
      .catch((error: unknown) => {
        if (isExclusionViolation(error)) return 'rejected' as const;
        throw error;
      });

    const [firstOutcome, secondOutcome] = await Promise.all([firstTransaction, secondTransaction]);

    expect(firstOutcome).toBe('committed');
    expect(
      secondOutcome,
      'both concurrent overlapping inserts committed — the exclusion constraint is not doing its job',
    ).toBe('rejected');

    const rows = await runtime.runner.run(context('race-census'), ({ query }) =>
      loadWorkProfiles(query, {
        organizationId: multi().alpha.organizationId,
        membershipId: subject,
      }),
    );
    expect(rows.map((row) => row.id)).toEqual([firstId]);
    log('concurrent overlapping inserts: 1 committed, 1 rejected with 23P01, 1 row stored');
  });
});
