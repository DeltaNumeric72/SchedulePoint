import { assertOutsideUnitOfWork } from '../../src/db/provider-boundary.js';
import { probeProviderCalls } from './provider-probe-log.js';

/**
 * @provider-port probe
 *
 * A probe provider port implementation.
 *
 * SPEC-12 U-07 (doc 34 §4-H) is implemented before any real provider exists:
 * M4-001's solver RPC is the first one, and the packet's ordering is deliberate
 * — the structural separation is proven first, so the solver is written against
 * a boundary that already refuses.
 *
 * That ordering leaves the static gate with nothing to scan, and a gate that
 * scans nothing passes forever. This module is the population: a **real**
 * provider port implementation, shaped exactly as the solver client will be —
 * it declares the marker, it opens every entry point with the guard, it never
 * imports the unit-of-work runner, and it performs no database work. It is the
 * gate's GREEN arm and the runtime guard's proof subject.
 *
 * When `apps/api/src/providers/solver-client.ts` lands in M4-001 the gate's
 * population stops being only this file; nothing here has to change, and this
 * stays as the boundary's own falsifiable control.
 *
 * **It calls nothing external.** The "external effect" is an entry in
 * `provider-probe-log.ts`, because the property under test is *where* a provider
 * may be called, not what it does, and no test in this repository may reach a
 * real third party (CLAUDE.md §7).
 *
 * The log lives in its own module so that every export HERE is a provider entry
 * point — see that file for why an exemption would be worse than a split.
 */

/**
 * The provider entry point.
 *
 * The guard is the FIRST statement, which is what the static gate checks and
 * what makes the refusal happen before any effect. A guard further down would
 * have already let the caller past it.
 */
export async function probeProviderCall(request: string): Promise<string> {
  assertOutsideUnitOfWork('probe');
  probeProviderCalls.push(request);
  return Promise.resolve(`probe:${request}`);
}

/**
 * A second entry point reached through an INDIRECTION, so the runtime arm has a
 * subject the source scan cannot follow.
 *
 * The static gate sees a call to `indirectProbeProviderCall`; it cannot see that
 * the returned closure is what actually reaches the provider, and it certainly
 * cannot see it if the closure is captured outside a transaction and invoked
 * inside one. That is the falsifiability point the packet's mutation case
 * attacks: disable the runtime guard and this path stops being detected while
 * the static gate still says PASS.
 */
export function indirectProbeProviderCall(): (request: string) => Promise<string> {
  assertOutsideUnitOfWork('probe');
  return async (request: string) => {
    // Deliberately re-asserted at the moment of the CALL, not only at capture:
    // the closure may be created outside a transaction and invoked inside one,
    // which is precisely the shape no source scan can follow.
    assertOutsideUnitOfWork('probe');
    probeProviderCalls.push(request);
    return Promise.resolve(`probe:${request}`);
  };
}
