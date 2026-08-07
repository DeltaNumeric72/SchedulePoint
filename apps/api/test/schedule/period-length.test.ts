import { MAX_PERIOD_DAYS } from '@schedulepoint/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TenantContext } from '@schedulepoint/domain';
import { createPeriod } from '../../src/schedule/service.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { scheduleActor } from '../support/schedule.js';

/**
 * The 366-day period bound, at the DATABASE (OPUS-M3-008; migration 0011).
 *
 * OPUS-M3-004's review added the bound to the CONTRACT
 * (`MAX_PERIOD_DAYS`) and recorded the database half as a future migration —
 * a bound enforced in one layer is a bound the next writer does not have, and
 * `createPeriod` is a service function any future route or job can call without
 * passing through the zod schema.
 *
 * `schedule_periods_length` is that half. The two numbers are asserted equal
 * here so they cannot drift into disagreeing about what a legal period is.
 */

const multi = ownedMulti('period-length', { profile: 'core' });

let runtime: Runtime;
let context: TenantContext;
let actor: ReturnType<typeof scheduleActor>;

beforeAll(() => {
  runtime = createRuntime('app_runtime', { max: 3 });
  const fixture = multi();
  context = {
    organizationId: fixture.alpha.organizationId,
    groupId: fixture.alpha.groupOne.id,
    membershipId: fixture.alpha.users.scheduler.membershipId,
    correlationId: 'period-length',
  };
  actor = scheduleActor(fixture.alpha.users.scheduler.id);
});

afterAll(async () => {
  await runtime?.destroy();
});

/** `YYYY-MM-DD`, `days` inclusive days after `from`. */
function plusDays(from: string, days: number): string {
  return new Date(Date.parse(`${from}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

describe('schedule_periods_length — the database half of the contract bound', () => {
  it('the contract bound and the database bound are the same number', () => {
    // `end_date - start_date <= 365` is 366 INCLUSIVE days, matching the
    // `'[]'` daterange the overlap exclusion already uses.
    expect(MAX_PERIOD_DAYS).toBe(366);
  });

  it('a period of exactly the maximum is accepted', async () => {
    const start = '2040-01-01';
    const id = await runtime.runner.run(context, async (uow) =>
      createPeriod(uow, actor, {
        name: 'exactly the maximum',
        startDate: start,
        endDate: plusDays(start, MAX_PERIOD_DAYS - 1),
      }),
    );
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('one day longer is REFUSED by the database, not by the caller', async () => {
    const start = '2042-01-01';
    await expect(
      runtime.runner.run(context, async (uow) =>
        createPeriod(uow, actor, {
          name: 'one day too long',
          startDate: start,
          endDate: plusDays(start, MAX_PERIOD_DAYS),
        }),
      ),
    ).rejects.toThrow(/schedule_periods_length/);
  });

  it('a single-day period is legal — the bound is inclusive at both ends', async () => {
    const id = await runtime.runner.run(context, async (uow) =>
      createPeriod(uow, actor, {
        name: 'one day',
        startDate: '2044-03-03',
        endDate: '2044-03-03',
      }),
    );
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
