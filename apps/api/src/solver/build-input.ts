import {
  reproducibilityMode,
  type SolverParameters,
  type SnapshotRevisionExpectation,
  type TenantContext,
  type UnitOfWorkRunner,
} from '@schedulepoint/domain';
import type { Kysely } from 'kysely';

import type { Database } from '../db/schema.js';
import { validateCandidate, type CandidateVerdict } from './candidate-validation.js';
import { assembleCanonicalInput } from './canonical-input.js';
import {
  solveOnWorker,
  type SolveOutcomeDetail,
  type SolverDispatchOptions,
} from './solver-client.js';
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
): Promise<SolveOutcomeDetail> {
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
  readonly outcome: SolveOutcomeDetail;
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

/* ────────────────────────────────────────────────────────────────────────────
 * Phase three: the candidate is checked before anybody may believe it
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ValidatedBuild extends BuildInputAndOutcome {
  /**
   * The independent verdict — `null` only when the solve returned **no
   * candidate at all** (INFEASIBLE, TIMEOUT, CANCELLED, FAILED).
   *
   * `null` is not "passed". It is "there was nothing to check", and the two are
   * different states a caller must not be able to confuse: a caller that read
   * `verdict?.usable !== false` as approval would treat a killed solve as a
   * validated schedule. {@link isUsableBuild} is the single predicate.
   */
  readonly verdict: CandidateVerdict | null;
}

/**
 * **The whole pipeline: canonical snapshot → request → worker → response →
 * independent checker.** SPEC-04 §3.3, doc 35 §6d included scope (4).
 *
 * > Every returned solution is re-validated against every `HARD` rule by an
 * > **independent checker** before it can become a schedule version.
 *
 * The re-validation is here, at the seam, rather than in whatever calls this,
 * because a checker a caller can forget to call is a checker that will be
 * forgotten — and the forgetting looks exactly like success. Every path out of
 * this function that carries a candidate has been past the checker.
 *
 * ## What this deliberately does NOT do
 *
 * It does not persist, publish, or record anything. The build lifecycle is
 * M4-003's, and putting a write here would put an effect behind a function
 * whose job is to decide. It also does not open a unit of work around the
 * dispatch — `createBuildInput` commits first and the provider runs after, which
 * is the SPEC-12 U-07 seam `createAndDispatchBuildInput` documents in full.
 *
 * ## The verdict is authoritative over the worker
 *
 * A worker may return `OPTIMAL` and a candidate that breaches a HARD rule. That
 * combination is not a contradiction to resolve in the worker's favour: it is
 * precisely the translation defect the redundancy exists to catch, and the
 * checker wins. {@link isUsableBuild} says so in one place.
 */
export async function createDispatchAndValidateBuild(
  runner: UnitOfWorkRunner<Kysely<Database>>,
  context: TenantContext,
  options: CreateBuildInputOptions & DispatchBuildOptions,
): Promise<ValidatedBuild> {
  const built = await createAndDispatchBuildInput(runner, context, options);
  return { ...built, verdict: validateBuildOutcome(built) };
}

/**
 * Re-validate an outcome that has already been dispatched.
 *
 * Split out and **pure** so a reviewer's probe can substitute a hand-built,
 * deliberately incorrect worker output and prove the refusal, without a worker
 * and without a cluster. That is the packet's "deliberately incorrect worker
 * output rejected" clause, and it is only provable if the decision can be
 * reached with an output no honest worker would produce.
 */
export function validateBuildOutcome(built: BuildInputAndOutcome): CandidateVerdict | null {
  const { outcome, snapshot } = built;
  if (outcome.assignments === null) return null;
  return validateCandidate({
    snapshot: snapshot.document,
    assignments: outcome.assignments,
    /* The hash the PLATFORM computed for what it dispatched — never the one the
     * response echoed. Comparing the echo against itself would make the check
     * agree with any worker. */
    expectedInputHash: snapshot.canonicalInputHash,
    reportedInputHash: outcome.canonicalInputHash,
  });
}

/**
 * **The single usability predicate.** One place decides, so nothing downstream
 * can invent a second, looser reading of the same facts.
 *
 * Three conditions, all required:
 *
 *  1. the solve reached a **solved** status — `OPTIMAL` or `FEASIBLE`. The two
 *     stay distinct (SPEC-04 §2/§7); this asks only whether a candidate exists;
 *  2. a candidate was actually returned and therefore checked;
 *  3. the independent checker found it usable — zero hard violations and no
 *     `not-evaluable` HARD finding (FAD-27: a rule that could not be checked is
 *     not a rule that passed).
 */
export function isUsableBuild(built: ValidatedBuild): boolean {
  if (built.outcome.status !== 'OPTIMAL' && built.outcome.status !== 'FEASIBLE') return false;
  if (built.verdict === null) return false;
  return built.verdict.usable;
}
