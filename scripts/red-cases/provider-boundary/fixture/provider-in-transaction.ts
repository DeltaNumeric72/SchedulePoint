import type { TenantContext } from '@schedulepoint/domain';

import type { PgUnitOfWorkRunner } from '../../db/unit-of-work.js';
import { probeProviderCall } from '../../../test/support/provider-probe.js';

/**
 * RED CASE — provider outside unit of work (SPEC-12 U-07), class 2.
 *
 * The ordinary defect, written the ordinary way: a provider called from inside a
 * unit-of-work callback, so an external round trip happens while a pooled
 * connection and every lock the transaction holds are pinned for its duration —
 * and, worse, so a provider that succeeds can be followed by a rollback that
 * leaves the database with no record of the effect (I-22).
 *
 * The gate must fail on it. The runtime guard would also throw here; the point
 * of the static arm is that this shape never reaches runtime in the first place.
 */
export async function redCaseProviderInsideTransaction(
  runner: PgUnitOfWorkRunner,
  context: TenantContext,
): Promise<string> {
  return runner.run(context, async () => {
    return probeProviderCall('inside-the-transaction');
  });
}
