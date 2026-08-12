import { randomUUID } from 'node:crypto';

import { ProviderInsideUnitOfWorkError } from '@schedulepoint/domain';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  activeUnitOfWorkMark,
  assertOutsideUnitOfWork,
  providerBoundaryState,
} from '../../src/db/provider-boundary.js';
import { groupContext } from '../support/fixtures.js';
import { createRuntime, type Runtime } from '../support/harness.js';
import { ownedMulti } from '../support/owned-multi.js';
import { probeProviderCalls, resetProbeProvider } from '../support/provider-probe-log.js';
import { indirectProbeProviderCall, probeProviderCall } from '../support/provider-probe.js';

/**
 * **Named proof — the provider boundary is real at RUNTIME, against a real
 * transaction** (SPEC-12 U-07, doc 34 §4-H).
 *
 * The static gate (`scripts/gates/provider-boundary-check.mjs`) catches the
 * ordinary shape at build time. It cannot catch a closure captured outside a
 * transaction and invoked inside one, a dynamic import, or a provider reached
 * through a lookup table — and every one of those is reachable. This file is the
 * arm that makes the rule true rather than tidy, and it attacks the boundary
 * through exactly the indirections the source scan cannot follow.
 *
 * Everything here runs against a REAL `PgUnitOfWorkRunner` on a real backend,
 * because the property is "an open PostgreSQL transaction refuses the call", and
 * a fake runner would prove only that a fake said no.
 */

const multi = ownedMulti('provider-boundary');

let runtime: Runtime;

beforeAll(() => {
  runtime = createRuntime('app_runtime', { max: 2 });
});

afterEach(() => {
  resetProbeProvider();
});

afterAll(async () => {
  await runtime.destroy();
});

function context(): ReturnType<typeof groupContext> {
  const alpha = multi().alpha;
  return groupContext(
    alpha.organizationId,
    alpha.groupOne.id,
    alpha.users.scheduler.membershipId,
    'provider-boundary',
  );
}

describe('the provider boundary at runtime', () => {
  it('permits a provider call outside every unit of work', async () => {
    expect(activeUnitOfWorkMark()).toBeUndefined();
    expect(providerBoundaryState()).toEqual({ outcome: 'permitted' });

    await expect(probeProviderCall('outside')).resolves.toBe('probe:outside');
    expect(probeProviderCalls).toEqual(['outside']);
  });

  it('REFUSES a provider call inside an open unit of work, and the effect never happens', async () => {
    let thrown: unknown;
    await runtime.runner.run(context(), async (uow) => {
      // A real statement first, so the transaction is genuinely open and holding
      // a connection when the provider is reached.
      await uow.query.selectFrom('groups').select('id').executeTakeFirst();
      try {
        await probeProviderCall('inside');
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBeInstanceOf(ProviderInsideUnitOfWorkError);
    expect((thrown as ProviderInsideUnitOfWorkError).providerName).toBe('probe');
    /* The refusal happens BEFORE the effect. If the guard ran anywhere but the
     * first statement, the call would be logged and then complained about. */
    expect(probeProviderCalls).toEqual([]);
  });

  it('refuses inside a SAVEPOINT, and reports the savepoint depth', async () => {
    let thrown: unknown;
    await runtime.runner.run(context(), async (outer) => {
      await outer.query.selectFrom('groups').select('id').executeTakeFirst();
      await runtime.runner.run(context(), async () => {
        try {
          await probeProviderCall('inside-savepoint');
        } catch (error) {
          thrown = error;
        }
      });
    });
    expect(thrown).toBeInstanceOf(ProviderInsideUnitOfWorkError);
    expect((thrown as ProviderInsideUnitOfWorkError).active.depth).toBe(1);
  });

  it('refuses a closure CAPTURED outside the transaction and INVOKED inside it', async () => {
    /* The indirection the static gate cannot see, and the reason the runtime arm
     * exists. At capture time there is no transaction, so the capture succeeds;
     * the call happens inside one, and that is what must be refused. A guard
     * that only ran at capture would pass this and be worthless. */
    const call = indirectProbeProviderCall();
    expect(providerBoundaryState()).toEqual({ outcome: 'permitted' });

    let thrown: unknown;
    await runtime.runner.run(context(), async () => {
      try {
        await call('captured-outside-invoked-inside');
      } catch (error) {
        thrown = error;
      }
    });
    expect(thrown).toBeInstanceOf(ProviderInsideUnitOfWorkError);
    expect(probeProviderCalls).toEqual([]);
  });

  it('refuses a provider reached through a DYNAMIC IMPORT inside the transaction', async () => {
    let thrown: unknown;
    await runtime.runner.run(context(), async () => {
      const module = await import('../support/provider-probe.js');
      try {
        await module.probeProviderCall('dynamic');
      } catch (error) {
        thrown = error;
      }
    });
    expect(thrown).toBeInstanceOf(ProviderInsideUnitOfWorkError);
    expect(probeProviderCalls).toEqual([]);
  });

  it('refuses a provider reached through a LOOKUP TABLE of functions', async () => {
    const table: Record<string, (request: string) => Promise<string>> = {
      [randomUUID()]: probeProviderCall,
    };
    const key = Object.keys(table)[0] ?? '';
    let thrown: unknown;
    await runtime.runner.run(context(), async () => {
      try {
        await table[key]?.('via-lookup');
      } catch (error) {
        thrown = error;
      }
    });
    expect(thrown).toBeInstanceOf(ProviderInsideUnitOfWorkError);
  });

  it('the mark ends with the transaction — a rollback leaves nothing behind', async () => {
    await expect(
      runtime.runner.run(context(), async () => {
        expect(activeUnitOfWorkMark()).toBeDefined();
        throw new Error('deliberate rollback');
      }),
    ).rejects.toThrow('deliberate rollback');

    expect(activeUnitOfWorkMark()).toBeUndefined();
    await expect(probeProviderCall('after-rollback')).resolves.toBe('probe:after-rollback');
  });

  it('the mark is PROCESS-wide: the worker runner marks the boundary too', async () => {
    /* A solver RPC issued from inside the outbox worker's transaction is exactly
     * as illegal as one issued from inside a request's. `PgUnitOfWorkRunner`'s
     * own nesting storage is instance-scoped on purpose (two runners must not
     * see each other's transactions as nestable); the boundary mark deliberately
     * is not. */
    const worker = createRuntime('app_worker', { max: 1 });
    try {
      let thrown: unknown;
      await worker.runner.run(context(), async () => {
        try {
          await probeProviderCall('inside-worker');
        } catch (error) {
          thrown = error;
        }
      });
      expect(thrown).toBeInstanceOf(ProviderInsideUnitOfWorkError);
    } finally {
      await worker.destroy();
    }
  });

  it('a provider call is permitted immediately AFTER the transaction commits', async () => {
    /* The shape M4-001 will actually use: assemble the canonical input inside
     * the transaction, commit, then call the solver. This asserts the boundary
     * does not make the legitimate sequence awkward. */
    const assembled = await runtime.runner.run(context(), async (uow) => {
      const row = await uow.query.selectFrom('groups').select('id').executeTakeFirst();
      return row?.id ?? 'none';
    });
    await expect(probeProviderCall(assembled)).resolves.toBe(`probe:${assembled}`);
    expect(probeProviderCalls).toEqual([assembled]);
  });

  it('the exported guard is the one the gate names', () => {
    // A rename would leave the gate scanning for a call that no longer exists,
    // and the gate would keep passing.
    expect(typeof assertOutsideUnitOfWork).toBe('function');
    expect(() => {
      assertOutsideUnitOfWork('probe');
    }).not.toThrow();
  });
});
