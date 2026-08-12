import { describe, expect, it } from 'vitest';

import {
  ProviderBoundaryNotInstalledError,
  ProviderInsideUnitOfWorkError,
  assertProviderOutsideUnitOfWork,
  providerBoundaryVerdict,
  type ActiveUnitOfWorkMark,
  type ProviderBoundaryProbe,
} from '../../src/ports/provider-boundary.js';

/**
 * The SPEC-12 U-07 decision, proven without a database (doc 34 §4-H).
 *
 * The decision is a total function over a probe result, which is what lets it be
 * exhausted here — three inputs, three outcomes, no I/O. The *observation* half
 * (the `AsyncLocalStorage` that knows whether a transaction is open) is
 * infrastructure and is proven against a real transaction in
 * `apps/api/test/providers/boundary.test.ts`.
 */

function probeReturning(mark: ActiveUnitOfWorkMark | undefined): ProviderBoundaryProbe {
  return { activeUnitOfWork: () => mark };
}

describe('the provider boundary decision', () => {
  it('permits a call when no unit of work is open', () => {
    expect(providerBoundaryVerdict(probeReturning(undefined))).toEqual({ outcome: 'permitted' });
    expect(() => {
      assertProviderOutsideUnitOfWork('solver', probeReturning(undefined));
    }).not.toThrow();
  });

  it('refuses a call inside a unit of work, naming the depth', () => {
    const mark: ActiveUnitOfWorkMark = { depth: 0, correlationId: 'corr-1' };
    expect(providerBoundaryVerdict(probeReturning(mark))).toEqual({
      outcome: 'refused',
      reason: 'inside-unit-of-work',
      active: mark,
    });

    let thrown: unknown;
    try {
      assertProviderOutsideUnitOfWork('solver', probeReturning(mark));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProviderInsideUnitOfWorkError);
    const error = thrown as ProviderInsideUnitOfWorkError;
    expect(error.code).toBe('PROVIDER_INSIDE_UNIT_OF_WORK');
    expect(error.providerName).toBe('solver');
    expect(error.message).toContain('depth 0');
  });

  it('refuses inside a SAVEPOINT too, and reports the savepoint depth', () => {
    const mark: ActiveUnitOfWorkMark = { depth: 2, correlationId: 'corr-2' };
    let thrown: unknown;
    try {
      assertProviderOutsideUnitOfWork('solver', probeReturning(mark));
    } catch (error) {
      thrown = error;
    }
    expect((thrown as ProviderInsideUnitOfWorkError).message).toContain('depth 2');
  });

  it('FAILS CLOSED when no boundary is installed', () => {
    /* The distinction this asserts is the whole design: "I could not tell
     * whether a transaction was open" is not "no transaction was open". A
     * process that forgets to install the boundary must be unable to call a
     * provider at all — loudly, at the first call. */
    expect(providerBoundaryVerdict(undefined)).toEqual({
      outcome: 'refused',
      reason: 'boundary-not-installed',
    });
    expect(() => {
      assertProviderOutsideUnitOfWork('solver', undefined);
    }).toThrow(ProviderBoundaryNotInstalledError);
  });

  it('never puts anything but the provider name and the depth into the message', () => {
    /* I-07 / I-17 / non-bypass rule 9: the refusal is an operational event, and
     * an operational event that carried a payload would be a payload in a log. */
    const error = new ProviderInsideUnitOfWorkError('solver', {
      depth: 1,
      correlationId: 'corr-secret-looking-but-still-only-a-correlation-id',
    });
    expect(error.message).toContain('solver');
    expect(error.message).toContain('depth 1');
    expect(error.message).not.toContain('corr-secret-looking');
  });
});
