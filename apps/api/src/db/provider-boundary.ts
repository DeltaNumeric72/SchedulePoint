import { AsyncLocalStorage } from 'node:async_hooks';

import {
  assertProviderOutsideUnitOfWork,
  providerBoundaryVerdict,
  type ActiveUnitOfWorkMark,
  type ProviderBoundaryProbe,
  type ProviderBoundaryVerdict,
} from '@schedulepoint/domain';

/**
 * The runtime half of the SPEC-12 U-07 provider boundary (doc 34 §4-H).
 *
 * The domain owns the DECISION (`packages/domain/src/ports/provider-boundary.ts`,
 * pure and total over a probe result). This module owns the OBSERVATION: an
 * `AsyncLocalStorage` that `PgUnitOfWorkRunner` enters for the lifetime of every
 * transaction and every savepoint, so "am I inside a unit of work?" is answered
 * for the calling async context rather than for the process.
 *
 * ## Why the storage is module-scoped rather than per-runner
 *
 * `PgUnitOfWorkRunner` already has an instance-scoped `AsyncLocalStorage` for
 * nesting detection, and it is deliberately instance-scoped: two runners (the
 * `app_runtime` one and the `app_worker` one) must not see each other's
 * transactions as nestable, because they hold different connections under
 * different roles.
 *
 * The provider question is the opposite question. A provider call is illegal
 * inside **any** open transaction, whichever runner owns it — a solver RPC
 * issued from inside the outbox worker's transaction is exactly as bad as one
 * issued from inside a request's. So the boundary mark is process-wide and every
 * runner writes to it.
 *
 * ## Why a provider cannot reach the runner instead
 *
 * A provider port implementation is constructed once, at composition time, and
 * is called from wherever the pipeline happens to be. Handing it a runner
 * reference would mean the guard's correctness depended on every call site
 * passing the *right* runner, and passing the wrong one (or none) would silently
 * disable the guard. An ambient mark cannot be passed wrongly.
 *
 * ## Nothing here logs
 *
 * The mark carries a depth and a correlation id. No payload, no SQL, no user
 * text ever enters it (I-07, I-17, non-bypass rule 9).
 */

const ACTIVE_UNIT_OF_WORK = new AsyncLocalStorage<ActiveUnitOfWorkMark>();

/**
 * Run `fn` marked as being inside a unit of work.
 *
 * Called by `PgUnitOfWorkRunner` for the outermost transaction and again for
 * every savepoint. The mark ends with the callback, which is the same lifetime
 * the transaction has — there is no way to leave it set past a commit, because
 * `AsyncLocalStorage.run` restores the previous store when the callback settles.
 */
export function withUnitOfWorkMark<T>(mark: ActiveUnitOfWorkMark, fn: () => Promise<T>): Promise<T> {
  return ACTIVE_UNIT_OF_WORK.run(mark, fn);
}

/** The installed probe. Exported so a test can assert the decision directly. */
export const unitOfWorkBoundaryProbe: ProviderBoundaryProbe = {
  activeUnitOfWork: () => ACTIVE_UNIT_OF_WORK.getStore(),
};

/** The mark for the calling async context, or `undefined` outside every transaction. */
export function activeUnitOfWorkMark(): ActiveUnitOfWorkMark | undefined {
  return unitOfWorkBoundaryProbe.activeUnitOfWork();
}

/** The verdict without throwing — for diagnostics and for the boundary's own tests. */
export function providerBoundaryState(): ProviderBoundaryVerdict {
  return providerBoundaryVerdict(unitOfWorkBoundaryProbe);
}

/**
 * **The guard every provider port entry point calls, as its first statement.**
 *
 * SPEC-12 U-07. Throws `ProviderInsideUnitOfWorkError` when a database
 * transaction is open in the calling async context.
 *
 * The static gate (`scripts/gates/provider-boundary-check.mjs`) requires this
 * exact call at the top of every exported entry point of every module under
 * `apps/api/src/providers/`, so a new provider cannot ship without it; the red
 * case proves the gate fires, and the mutation case proves the RUNTIME arm is
 * what catches the indirections the gate cannot see.
 */
export function assertOutsideUnitOfWork(providerName: string): void {
  assertProviderOutsideUnitOfWork(providerName, unitOfWorkBoundaryProbe);
}
