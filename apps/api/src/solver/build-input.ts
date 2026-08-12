import {
  reproducibilityMode,
  type SolveOutcome,
  type SolverParameters,
  type SnapshotRevisionExpectation,
  type TenantContext,
  type UnitOfWorkRunner,
} from '@schedulepoint/domain';
import type { Kysely } from 'kysely';

import type { Database } from '../db/schema.js';
import { assembleCanonicalInput } from './canonical-input.js';
import { solveOnWorker, type SolverDispatchOptions } from './solver-client.js';
import { persistCanonicalInput, type PersistedSnapshot } from './snapshot-store.js';

/**
 * **The two phases, and the only place they meet** — SPEC-12 U-07, doc 35 §6a
 * binding constraint 1.
 *
 * ```
 *   phase 1  ── inside one unit of work ──   assemble, refuse, persist   → COMMIT
 *   phase 2  ── after run() has RETURNED ──  dispatch to the worker
 * ```
 *
 * ## Why the seam is here and nowhere else
 *
 * A provider call inside an open transaction holds a pooled connection and a row
 * lock for the duration of somebody else's network. A ninety-second solve
 * becomes a ninety-second period-wide lock, and then a connection-pool
 * exhaustion that presents as a database fault rather than as the call that
 * caused it. Worse for correctness: a provider that succeeds inside a
 * transaction that then rolls back has produced an external effect the database
 * has no record of — the one failure mode a single-commit-point architecture
 * (I-22) exists to prevent.
 *
 * Three things enforce the separation, and only the third is unconditional:
 *
 *  1. **Shape.** `solveOnWorker` is called on a line that is not inside any
 *     `.run(…)` argument list. A reader can see the seam.
 *  2. **The static gate.** `scripts/gates/provider-boundary-check.mjs` fails the
 *     build if a name imported from a `@provider-port` module appears inside a
 *     unit-of-work callback body. It reads THIS file.
 *  3. **The runtime guard.** `assertOutsideUnitOfWork('solver')` is the first
 *     statement of `solveOnWorker`, over an `AsyncLocalStorage` mark that
 *     follows the calling async context. It is the one that catches what a
 *     source scan cannot: a dynamic import, a closure captured outside and
 *     invoked inside, a lookup table — and, the case doc 35 §6a names
 *     explicitly, **work scheduled inside a transaction and running after it,
 *     which is still marked**.
 *
 * ## What crosses the seam
 *
 * A snapshot id, a hash, and a document. Not a connection, not a credential, not
 * a unit of work. `PersistedSnapshot` is a value; by the time phase two runs,
 * the transaction that produced it is closed and the row it describes is
 * committed and immutable (0016). A solve can therefore be retried, compared or
 * reproduced against exactly the problem that was posed — SPEC-04 §2's
 * "Re-runnable: from the same pinned `solver_inputs` snapshot and the same
 * recorded parameters".
 */

export interface CreateBuildInputOptions {
  readonly periodId: string;
  readonly versionId: string;
  /** The build instant — what "in force" means (S-03). No default. */
  readonly at: Date;
  /** Idempotency: one key identifies one request, hash included. */
  readonly idempotencyKey: string;
  readonly expectedRevisions?: SnapshotRevisionExpectation;
}

/**
 * **Phase one alone.** Assemble, refuse, persist — and dispatch nothing.
 *
 * Separated from {@link createAndDispatchBuildInput} because they are genuinely
 * different operations and a caller often wants only this one: an assembly that
 * is refused never reaches a worker, and a scheduler reviewing a build input
 * before spending a solve on it is exactly the flow M4-003 puts a screen in
 * front of.
 */
export async function createBuildInput(
  runner: UnitOfWorkRunner<Kysely<Database>>,
  context: TenantContext,
  options: CreateBuildInputOptions,
): Promise<PersistedSnapshot> {
  return runner.run(context, async (uow) => {
    const assembled = await assembleCanonicalInput(uow, {
      periodId: options.periodId,
      versionId: options.versionId,
      at: options.at,
      /* Spread rather than assigned: under `exactOptionalPropertyTypes` an
       * explicit `undefined` and an absent key are different things, and the
       * difference is load-bearing here — an absent expectation makes no claim,
       * where a present-but-empty one would be an empty claim. */
      ...(options.expectedRevisions === undefined
        ? {}
        : { expectedRevisions: options.expectedRevisions }),
    });
    return persistCanonicalInput(uow, {
      document: assembled.document,
      constituents: assembled.constituents,
      idempotencyKey: options.idempotencyKey,
    });
  });
}

export interface DispatchBuildOptions extends SolverDispatchOptions {
  readonly buildRunId: string;
  readonly parameters: SolverParameters;
}

/**
 * **Phase two alone.** Dispatch an already-persisted snapshot to the worker.
 *
 * Takes a `PersistedSnapshot` — a plain value — rather than a unit of work or a
 * runner, so there is no argument through which a transaction could arrive. The
 * runtime guard would refuse anyway; making the signature unable to express the
 * mistake is cheaper than catching it.
 */
export async function dispatchBuild(
  context: TenantContext,
  snapshot: PersistedSnapshot,
  options: DispatchBuildOptions,
): Promise<SolveOutcome> {
  return solveOnWorker(
    {
      protocolVersion: 1,
      organizationId: context.organizationId,
      groupId: context.groupId ?? '',
      buildRunId: options.buildRunId,
      correlationId: context.correlationId,
      snapshotId: snapshot.snapshotId,
      canonicalInputHash: snapshot.canonicalInputHash,
      snapshotPayload: snapshot.document,
      parameters: options.parameters,
    },
    options,
  );
}

export interface BuildInputAndOutcome {
  readonly snapshot: PersistedSnapshot;
  readonly outcome: SolveOutcome;
  /** Computed from the dispatched parameters, never declared (SPEC-04 §4). */
  readonly reproducibility: 'deterministic' | 'best-effort';
}

/**
 * Both phases, in order, with the commit between them.
 *
 * The `await` on phase one is the commit point. Phase two begins in the caller's
 * async context **after** `run()` has returned, which is what makes the runtime
 * guard permit it — and what makes a future refactor that moves the dispatch
 * inside the callback fail loudly at the first call rather than quietly under
 * load.
 */
export async function createAndDispatchBuildInput(
  runner: UnitOfWorkRunner<Kysely<Database>>,
  context: TenantContext,
  options: CreateBuildInputOptions & DispatchBuildOptions,
): Promise<BuildInputAndOutcome> {
  const snapshot = await createBuildInput(runner, context, options);
  const outcome = await dispatchBuild(context, snapshot, options);
  return { snapshot, outcome, reproducibility: reproducibilityMode(options.parameters) };
}
