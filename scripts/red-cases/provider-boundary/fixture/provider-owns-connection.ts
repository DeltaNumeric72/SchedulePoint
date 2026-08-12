/**
 * @provider-port redcaseowner
 *
 * RED CASE — provider outside unit of work (SPEC-12 U-07), class 3.
 *
 * A declared provider port implementation that imports the unit-of-work runner.
 *
 * The point is narrower than "it looks wrong". A provider that can OPEN a
 * transaction can put itself inside one — and once it does, class 2 has nothing
 * to see, because the illegal call is no longer at a call site the scan can find
 * in some other module's unit-of-work callback. It has been folded into the
 * provider itself. Class 3 is what keeps classes 1 and 2 meaningful.
 *
 * The guard is present and correctly placed, so this fixture isolates class 3:
 * it must fail on the RUNNER IMPORT alone.
 */
import { assertOutsideUnitOfWork } from '../../db/provider-boundary.js';
import type { PgUnitOfWorkRunner } from '../../db/unit-of-work.js';

export async function redCaseOwningProviderCall(
  runner: PgUnitOfWorkRunner,
  request: string,
): Promise<string> {
  assertOutsideUnitOfWork('redcaseowner');
  void runner;
  return Promise.resolve(`redcaseowner:${request}`);
}
