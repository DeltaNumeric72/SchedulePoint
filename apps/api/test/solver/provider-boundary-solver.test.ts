import { randomUUID } from 'node:crypto';

import { ProviderInsideUnitOfWorkError } from '@schedulepoint/domain';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { PgUnitOfWork } from '../../src/db/unit-of-work.js';
import { createAndDispatchBuildInput, dispatchBuild } from '../../src/solver/build-input.js';
import { solveOnWorker } from '../../src/solver/solver-client.js';
import { createRuntime, log, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { fixtureInstant } from '../support/schedule.js';
import {
  DETERMINISTIC_PARAMETERS,
  applySolverEnv,
  seedSolverFixture,
  type SolverFixture,
} from '../support/solver.js';
import { syntheticProblem } from './synthetic-problem.js';

/**
 * **NAMED PROOF — the provider boundary, extended to the REAL solver port**
 * (OPUS-M4-001; SPEC-12 U-07, doc 35 §6a binding constraint 1).
 *
 * OPUS-M4-000C built this boundary *before* any provider existed, and the
 * ordering was the point: the solver is written against a boundary that already
 * refuses. Until now the gate's population was a probe. This file is the arm
 * that proves the rule holds for the thing it was built for.
 *
 * | # | Property | What breaks silently without it |
 * |---|---|---|
 * | 1 | a solve inside an open transaction is REFUSED at runtime | a 90-second solve holds a period-wide lock, and pool exhaustion presents as a database fault |
 * | 2 | the refusal happens BEFORE a subprocess exists | the external effect happens and then gets complained about |
 * | 3 | a solve **scheduled inside** a transaction and running **after** it is still refused | the mark propagates past commit, and this is the case the packet names explicitly |
 * | 4 | the two-phase orchestration is permitted | the boundary would be correct and the pipeline unusable |
 *
 * Property 4 is the mutation control: without it, every case here would pass
 * against a guard that refused every solve everywhere.
 *
 * The static half is a red case (`scripts/red-cases/run.mjs`,
 * `provider-boundary-solver-in-transaction`), because a build-time gate cannot
 * be proven by a test that compiles.
 */

const multi = ownedMulti('solver-provider-boundary', {
  profile: 'core',
  seed: { catalogue: ['alpha'], scheduleCredentials: true },
});

let runtime: Runtime;
let context: {
  organizationId: string;
  groupId: string;
  membershipId: string;
  correlationId: string;
};
let fixture: SolverFixture;
let restoreEnv: () => void;

const BUILD_AT = fixtureInstant('2027-12-06', 12);

beforeAll(async () => {
  runtime = createRuntime('app_runtime', { max: 4 });
  const alpha = multi().alpha;
  const shiftTypeId = multi.catalogue('alpha').shiftTypeIds[1];
  if (shiftTypeId === undefined) throw new Error('no shift type');

  context = {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    membershipId: alpha.users.scheduler.membershipId,
    correlationId: 'solver-provider-boundary',
  };

  fixture = await seedSolverFixture(runtime.runner, {
    organizationId: alpha.organizationId,
    groupId: alpha.groupOne.id,
    actorMembershipId: alpha.users.scheduler.membershipId,
    actorUserId: alpha.users.scheduler.id,
    shiftTypeId,
    startDate: '2027-12-06',
    endDate: '2027-12-12',
    requiredCount: 1,
  });
}, 180_000);

beforeEach(() => {
  restoreEnv = applySolverEnv();
});

afterEach(() => {
  restoreEnv();
});

afterAll(async () => {
  await runtime?.destroy();
});

function spec() {
  const payload = syntheticProblem();
  return {
    protocolVersion: 1,
    organizationId: context.organizationId,
    groupId: context.groupId,
    buildRunId: randomUUID(),
    correlationId: 'boundary-probe',
    snapshotId: randomUUID(),
    canonicalInputHash: 'a'.repeat(64),
    snapshotPayload: payload,
    parameters: DETERMINISTIC_PARAMETERS,
  };
}

describe('the solver port is refused inside a unit of work', () => {
  it('REFUSES a solve issued from inside an open transaction', async () => {
    let thrown: unknown;
    let elapsed = 0;
    await runtime.runner.run(context, async (uow: PgUnitOfWork) => {
      // A real statement first, so the transaction is genuinely open and holding
      // a connection when the provider is reached.
      await uow.query.selectFrom('groups').select('id').executeTakeFirst();
      const started = Date.now();
      try {
        await solveOnWorker(spec());
      } catch (error) {
        thrown = error;
      }
      elapsed = Date.now() - started;
    });

    expect(thrown).toBeInstanceOf(ProviderInsideUnitOfWorkError);
    expect((thrown as ProviderInsideUnitOfWorkError).providerName).toBe('solver');

    /* The refusal happened BEFORE a subprocess existed. A Python interpreter
     * start alone is tens of milliseconds; a guard that ran anywhere but the
     * first statement would have spawned one and then complained. */
    expect(elapsed, 'the refusal must precede the effect, not follow it').toBeLessThan(50);
    log(`      · refused in ${String(elapsed)}ms — before any subprocess could start`);
  });

  it('REFUSES a solve inside a SAVEPOINT', async () => {
    let thrown: unknown;
    await runtime.runner.run(context, async (outer: PgUnitOfWork) => {
      await outer.query.selectFrom('groups').select('id').executeTakeFirst();
      await runtime.runner.run(context, async (inner: PgUnitOfWork) => {
        expect(inner.depth).toBeGreaterThan(0);
        try {
          await solveOnWorker(spec());
        } catch (error) {
          thrown = error;
        }
      });
    });
    expect(thrown).toBeInstanceOf(ProviderInsideUnitOfWorkError);
    expect((thrown as ProviderInsideUnitOfWorkError).active.depth).toBeGreaterThan(0);
  });

  it('REFUSES a solve SCHEDULED inside a transaction that runs after it commits', async () => {
    /* Doc 35 §6a binding constraint 1, named explicitly: *"never from work
     * scheduled inside a transaction — the AsyncLocalStorage mark propagates
     * past commit and will refuse"*.
     *
     * This is the shape no source scan can follow, and it is not exotic: it is
     * what `void doTheThing()` or a `.then()` hanging off the transaction
     * callback produces. The transaction has committed by the time the solve
     * runs, and the async context it inherited says otherwise — so the guard
     * refuses, correctly. The remedy is to await the run and dispatch from the
     * caller's context, which is exactly what `build-input.ts` does. */
    let deferred: Promise<unknown> | undefined;
    await runtime.runner.run(context, async (uow: PgUnitOfWork) => {
      await uow.query.selectFrom('groups').select('id').executeTakeFirst();
      deferred = Promise.resolve().then(() => solveOnWorker(spec()));
      deferred.catch(() => {
        /* handled below; attached here so the rejection is never unhandled */
      });
    });

    await expect(deferred).rejects.toBeInstanceOf(ProviderInsideUnitOfWorkError);
    log('      · the mark propagates past commit; deferred work is still refused');
  });
});

describe('the two-phase orchestration is permitted, and is the remedy', () => {
  it('MUTATION CONTROL: assemble inside the transaction, dispatch after it', async () => {
    /* Without this, every case above would pass against a guard that refused
     * every solve everywhere and a pipeline that could never run. */
    const result = await createAndDispatchBuildInput(runtime.runner, context, {
      periodId: fixture.periodId,
      versionId: fixture.versionId,
      at: BUILD_AT,
      idempotencyKey: `two-phase-${randomUUID()}`,
      buildRunId: randomUUID(),
      parameters: DETERMINISTIC_PARAMETERS,
    });

    expect(result.snapshot.replayed).toBe(false);
    expect(result.outcome.status).toBe('FEASIBLE');
    expect(result.outcome.canonicalInputHash).toBe(result.snapshot.canonicalInputHash);
    expect(result.reproducibility).toBe('deterministic');
    log(
      `      · MUTATION CONTROL: snapshot ${result.snapshot.snapshotId.slice(0, 8)} → ` +
        `${result.outcome.status} with ${String((result.outcome.assignments ?? []).length)} assignments`,
    );
  });

  it('dispatching a persisted snapshot takes a VALUE, never a transaction', async () => {
    /* The signature cannot express the mistake: `dispatchBuild` accepts a
     * `PersistedSnapshot`, which is a plain value from a transaction that has
     * already committed. The runtime guard would refuse anyway; making the type
     * unable to carry a unit of work is cheaper than catching it. */
    const snapshot = await createAndDispatchBuildInput(runtime.runner, context, {
      periodId: fixture.periodId,
      versionId: fixture.versionId,
      at: BUILD_AT,
      idempotencyKey: `dispatch-value-${randomUUID()}`,
      buildRunId: randomUUID(),
      parameters: DETERMINISTIC_PARAMETERS,
    });

    const again = await dispatchBuild(context, snapshot.snapshot, {
      buildRunId: randomUUID(),
      parameters: DETERMINISTIC_PARAMETERS,
    });
    expect(again.canonicalInputHash).toBe(snapshot.snapshot.canonicalInputHash);
    /* Re-runnable from the same pinned snapshot and the same recorded
     * parameters (SPEC-04 §2), and the candidate is the same one. */
    expect(JSON.stringify(again.assignments)).toBe(JSON.stringify(snapshot.outcome.assignments));
  });
});
