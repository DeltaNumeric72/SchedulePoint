import type { BuildRunState } from '../db/schema.js';
import type { StalenessVerdict } from './constituent-diff.js';

/**
 * The build lifecycle's typed refusals (OPUS-M4-003).
 *
 * Each one exists because a route has to answer a different question with a
 * different status code, and because "the database raised `restrict_violation`"
 * is not an answer a scheduler can act on. **The database remains the control**
 * in every case — these are raised by the service *before* the statement that
 * would have been refused anyway, so removing one weakens the message and
 * nothing else. `lifecycle.test.ts` proves that by driving each refusal with the
 * service check removed and showing the database still refuses.
 */

export class BuildPreconditionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BuildPreconditionError';
    this.code = code;
  }
}

/** An illegal edge of the sixteen-state machine. */
export class BuildTransitionError extends BuildPreconditionError {
  readonly from: BuildRunState;
  readonly to: BuildRunState;

  constructor(from: BuildRunState, to: BuildRunState) {
    super(
      'BUILD_TRANSITION_ILLEGAL',
      `a build run does not move from ${from} to ${to}`,
    );
    this.name = 'BuildTransitionError';
    this.from = from;
    this.to = to;
  }
}

/**
 * The caller's `expectedState` did not match. Answers "did this move while you
 * were looking at it?", which the illegal-transition refusal cannot — a stale
 * tab and a genuine bug produce different words.
 */
export class BuildStateMovedError extends BuildPreconditionError {
  readonly currentState: BuildRunState;

  constructor(currentState: BuildRunState) {
    super('BUILD_STATE_MOVED', 'this build has moved since it was read');
    this.name = 'BuildStateMovedError';
    this.currentState = currentState;
  }
}

/**
 * A result presented at an epoch that is no longer the run's.
 *
 * The worker was reaped, restarted, or superseded between claiming and
 * answering. Its answer is to a question that has been re-asked, and it is
 * REFUSED — and recorded, so that the refusal is a visible fact rather than an
 * absence (doc 35 §6e Required behaviour 3).
 */
export class BuildResultFencedError extends BuildPreconditionError {
  readonly presentedEpoch: number;
  readonly currentEpoch: number;

  constructor(presentedEpoch: number, currentEpoch: number) {
    super(
      'BUILD_RESULT_FENCED',
      'a result from a superseded claim cannot be written for this build run',
    );
    this.name = 'BuildResultFencedError';
    this.presentedEpoch = presentedEpoch;
    this.currentEpoch = currentEpoch;
  }
}

/** FAD-26(2)'s second compare-and-set: the source draft moved since the build. */
export class BuildSourceMovedError extends BuildPreconditionError {
  readonly currentSourceDigest: string;

  constructor(currentSourceDigest: string) {
    super(
      'STALE_BUILD_SOURCE',
      'the draft this build was posed against has changed since the build ran',
    );
    this.name = 'BuildSourceMovedError';
    this.currentSourceDigest = currentSourceDigest;
  }
}

/** The D-17 conflict: the key has been seen, for a DIFFERENT request. */
export class BuildIdempotencyConflictError extends BuildPreconditionError {
  readonly idempotencyKey: string;

  constructor(idempotencyKey: string) {
    super(
      'BUILD_IDEMPOTENCY_CONFLICT',
      'this idempotency key was already used for a different build request',
    );
    this.name = 'BuildIdempotencyConflictError';
    this.idempotencyKey = idempotencyKey;
  }
}

/** SPEC-04 §2's bound. Exhaustion surfaces with the LAST termination reason. */
export class BuildRetryLimitError extends BuildPreconditionError {
  readonly retryLimit: number;
  readonly lastTerminationReason: string | null;

  constructor(retryLimit: number, lastTerminationReason: string | null) {
    super('BUILD_RETRY_LIMIT_REACHED', 'this build chain has used its retries');
    this.name = 'BuildRetryLimitError';
    this.retryLimit = retryLimit;
    this.lastTerminationReason = lastTerminationReason;
  }
}

/**
 * **doc 35 §6g ruling 4** — an input revision moved after snapshot assembly.
 *
 * Distinct from {@link BuildSourceMovedError}, and the distinction is the whole
 * finding. That one answers "the draft you were building on has been edited";
 * this one answers "the PROBLEM has changed" — a rule revised, a shift type
 * archived, a qualification expired, demand re-set, the group timezone changed.
 * A scheduler told the first will look at the draft; a scheduler told the second
 * has to re-pose the build. Collapsing them into one message would send half of
 * them to the wrong place.
 *
 * It carries the changes rather than a count, because the remedy depends on
 * WHICH input moved. The list is bounded and the true total travels with it.
 */
export class BuildInputsMovedError extends BuildPreconditionError {
  readonly staleness: StalenessVerdict;

  constructor(staleness: StalenessVerdict) {
    super(
      'STALE_BUILD_INPUTS',
      'the inputs this build was posed against have changed since it was assembled; ' +
        'a candidate computed from them cannot become the current draft',
    );
    this.name = 'BuildInputsMovedError';
    this.staleness = staleness;
  }
}
