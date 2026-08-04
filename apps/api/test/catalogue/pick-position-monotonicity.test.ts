import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setPickPositionCount } from '../../src/catalogue/service.js';
import { adminClient } from '../support/admin-client.js';
import { groupContext } from '../support/fixtures.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';

/**
 * **NAMED-CONDITION PROOF 2 — pick-position monotonicity under CONCURRENT
 * increase attempts.**
 *
 * Packet 30: "pick-position monotonicity under concurrent increase attempts".
 *
 * ## What is actually being proven, stated precisely
 *
 * The rule (research 05 §ADM-07, OBSERVED) is that the count may only rise. The
 * *interesting* failure is not a single decrease — a CHECK could not express it,
 * but a trigger comparing `OLD` to `NEW` obviously can. The interesting failure
 * is a **lost update under concurrency**: two administrators each read the count
 * as 4, one sets 9 and the other sets 6, and if the second write lands after the
 * first, the count has effectively gone 9 → 6. Every individual statement was an
 * "increase" against what its author read, and the stored value still went down.
 *
 * The trigger compares `NEW` against `OLD` **as the row exists when the
 * statement executes**, and PostgreSQL takes a row lock for the duration of an
 * `UPDATE`, so the second transaction blocks until the first commits and then
 * re-evaluates against the committed value. That is what makes the lost update
 * impossible rather than unlikely, and it is what this file measures.
 *
 * ## Why the two transactions are started from separate runners
 *
 * `PgUnitOfWorkRunner` detects nesting through `AsyncLocalStorage`: a `run`
 * called from inside another `run` becomes a **savepoint on the same
 * connection**, never a second transaction. That is the correct default for
 * isolation and a trap for a test trying to make two units of work contend
 * (SPIKE-REPORT §6.6). Two runners with their own pools, started outside each
 * other's async context, are two genuine backends.
 *
 * ## The ALLOW control
 *
 * A plain increase succeeds first. Without it, a trigger that refused *every*
 * update would satisfy every assertion below.
 *
 * ## Every test reads the count before it acts, and none assumes a value
 *
 * FAD-15: each test owns its subject. `pick_position_count` is MONOTONIC, so it
 * cannot be reset between tests and an absolute expectation ("the count is 5")
 * is an assertion about which test ran first. The shuffled-order run in
 * `corepack pnpm fixture-regression` found exactly that — four tests here were
 * order-dependent — so each one now reads the current value and asserts a
 * RELATIVE outcome, which is the property the rule is actually about.
 */

const multi = ownedMulti('catalogue-pick-position-monotonicity', { profile: 'full' });

let admin: pg.Client;
let runtimeA: Runtime;
let runtimeB: Runtime;

const alpha = () => multi().alpha;

/** The group administrator holds `group.pick_positions.administer` by role. */
function adminContext(correlationId: string) {
  const groupAdmin = alpha().full?.groupAdmin;
  if (groupAdmin === undefined) throw new Error('the full profile provisions a group admin');
  return groupContext(
    alpha().organizationId,
    alpha().groupOne.id,
    groupAdmin.membershipId,
    correlationId,
  );
}

async function storedCount(): Promise<number> {
  const result = await admin.query<{ pick_position_count: number }>(
    'select pick_position_count from groups where id = $1',
    [alpha().groupOne.id],
  );
  return result.rows[0]?.pick_position_count ?? -1;
}

beforeAll(async () => {
  admin = adminClient();
  await admin.connect();
  runtimeA = createRuntime('app_runtime', { max: 2 });
  runtimeB = createRuntime('app_runtime', { max: 2 });
}, 120_000);

afterAll(async () => {
  await runtimeA.destroy();
  await runtimeB.destroy();
  await admin.end();
});

describe('pick_position_count is monotonic', () => {
  it('CONTROL: an increase succeeds and is stored', async () => {
    const before = await storedCount();
    const target = before + 3;
    const outcome = await runtimeA.runner.run(adminContext('monotonic-control'), (uow) =>
      setPickPositionCount(uow, target),
    );
    expect(outcome.kind).toBe('ok');
    expect(await storedCount()).toBe(target);
    log(`CONTROL: ${String(before)} → ${String(target)} accepted and stored`);
  });

  it('a DECREASE is rejected by the database, not only by the service', async () => {
    // Establishes its own precondition rather than inheriting one: the count has
    // to be above zero before "lower it" means anything.
    await runtimeA.runner.run(adminContext('monotonic-decrease-setup'), async (uow) => {
      const outcome = await setPickPositionCount(uow, (await storedCount()) + 2);
      if (outcome.kind !== 'ok') throw new Error(`setup reported ${outcome.kind}`);
    });
    const before = await storedCount();

    // The service refuses first so the form can say why; the database refuses
    // whatever the service thinks. Bypassing the service is the point — this
    // asserts the control that survives a bug in the layer above it.
    await expect(
      runtimeA.runner.run(adminContext('monotonic-decrease'), ({ query }) =>
        query
          .updateTable('groups')
          .set({ pick_position_count: before - 1, updated_at: new Date() })
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '23001' /* restrict_violation, raised by the trigger */ });

    expect(await storedCount(), 'the decrease landed').toBe(before);
    log(
      `direct UPDATE lowering the count ${String(before)} → ${String(before - 1)} → ` +
        `restrict_violation; stored value unchanged at ${String(before)}`,
    );
  });

  it('CONCURRENT increases: the later, LOWER write is refused — the count never goes down', async () => {
    // Both transactions read 5. A sets 9. B sets 6 — an "increase" against what
    // B read, and a decrease against what is committed by the time B's statement
    // runs. The row lock serialises them; B must be refused.
    const before = await storedCount();
    const high = before + 9;
    const low = before + 5;

    let releaseA: () => void = () => {};
    const aHasWritten = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let releaseB: () => void = () => {};
    const bMayProceed = new Promise<void>((resolve) => {
      releaseB = resolve;
    });

    const a = runtimeA.runner.run(adminContext('monotonic-concurrent-a'), async (uow) => {
      const outcome = await setPickPositionCount(uow, high);
      // A has written but NOT committed: the row lock is held from here until
      // the unit of work commits, which is what B is about to contend with.
      releaseA();
      await bMayProceed;
      return outcome;
    });

    await aHasWritten;

    const b = (async () => {
      // Started outside A's async context: a `run` nested inside A's would be a
      // savepoint on A's own connection and would never contend.
      const attempt = runtimeB.runner.run(adminContext('monotonic-concurrent-b'), (uow) =>
        setPickPositionCount(uow, low),
      );
      // Give B's statement time to reach the lock before A commits, so the
      // contention is real rather than accidental ordering.
      setTimeout(releaseB, 150);
      return attempt;
    })();

    const aResult = await a;
    expect(aResult.kind).toBe('ok');

    // B either read the old value before A committed and is then refused by the
    // trigger when it re-evaluates against A's, or it read A's and the SERVICE
    // refused it. Both
    // are correct outcomes and both are the same guarantee; the assertion is on
    // the guarantee, not on which layer happened to win the race.
    const bOutcome = await b.then(
      (value) => ({ refusedBy: 'service' as const, value }),
      (error: unknown) => ({ refusedBy: 'database' as const, error }),
    );

    if (bOutcome.refusedBy === 'service') {
      expect(
        bOutcome.value.kind,
        `the lower concurrent write was ACCEPTED — the count went ${String(high)} → ${String(low)}`,
      ).toBe('invalid');
    } else {
      expect(bOutcome.error).toMatchObject({ code: '23001' });
    }

    const after = await storedCount();
    expect(after, 'the stored count fell below a value that had been committed').toBe(high);
    log(
      `concurrent ${String(high)} and ${String(low)} from two backends: ${String(high)} ` +
        `committed, ${String(low)} refused by the ${bOutcome.refusedBy}; stored value ${String(after)}`,
    );
  });

  it('a valid combination cannot name a position above the ceiling', async () => {
    // The other half of FAD-16's rule: "`valid_groups.allowed_pick_positions`
    // members must be <= it". Enforced by trigger, because a CHECK cannot read
    // `groups`.
    const { createValidGroup } = await import('../../src/catalogue/service.js');
    const { createShiftType } = await import('../../src/catalogue/service.js');

    const scheduler = groupContext(
      alpha().organizationId,
      alpha().groupOne.id,
      alpha().users.scheduler.membershipId,
      'monotonic-ceiling',
    );

    // Read the ceiling rather than assume it: the count is monotonic and every
    // other test in this file raises it, so its value depends on the order.
    await runtimeA.runner.run(adminContext('monotonic-ceiling-setup'), async (uow) => {
      const outcome = await setPickPositionCount(uow, (await storedCount()) + 1);
      if (outcome.kind !== 'ok') throw new Error(`setup reported ${outcome.kind}`);
    });
    const ceiling = await storedCount();

    const shiftTypeId = await runtimeA.runner.run(scheduler, async (uow) => {
      const created = await createShiftType(uow, {
        code: `CEIL${String(ceiling)}`,
        name: 'Ceiling probe',
        description: null,
        displayPaletteKey: 'neutral',
        displayTextStyle: 'regular',
        startTime: '08:00',
        endTime: '16:00',
        isOnCall: false,
        attractsStipend: false,
        isManualOnly: false,
        isDailyPick: false,
        includeInStatistics: true,
        isLeaveOfAbsence: false,
        allowOnRequest: false,
        allowOffRequest: false,
        reportOrder: 0,
        creditWeight: 1,
      });
      if (created.kind !== 'ok') throw new Error(`shift type setup reported ${created.kind}`);
      return created.value.shiftTypeId;
    });

    // ALLOW control: a position within the ceiling is accepted.
    const within = await runtimeA.runner.run(scheduler, (uow) =>
      createValidGroup(uow, {
        name: `Within the ceiling ${String(ceiling)}`,
        shiftTypeIds: [shiftTypeId],
        allowedPickPositions: [1, ceiling],
      }),
    );
    expect(within.kind, JSON.stringify(within)).toBe('ok');

    const above = await runtimeA.runner.run(scheduler, (uow) =>
      createValidGroup(uow, {
        name: `Above the ceiling ${String(ceiling)}`,
        shiftTypeIds: [shiftTypeId],
        allowedPickPositions: [1, ceiling + 1],
      }),
    );
    expect(above.kind).toBe('invalid');
    log(
      `valid combination: position ${String(ceiling)} accepted at ceiling ${String(ceiling)}; ` +
        `position ${String(ceiling + 1)} refused`,
    );
  });
});
