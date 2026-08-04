/**
 * Typed failures the schedule module raises. The module is service-layer only
 * this packet (no HTTP surface — OPUS-M3-004/005/006 add routes), so these are
 * thrown, and the harness catches them. A future route maps them to responses
 * exactly as the catalogue route maps its `Outcome` union.
 */

import type { Decision } from '@schedulepoint/domain';

/** Authorization denied by the SPEC-06 evaluator (deny-by-default, I-02). */
export class ScheduleDeniedError extends Error {
  readonly decision: Decision;

  constructor(decision: Decision) {
    super(`schedule action denied at ${decision.allowed ? '?' : decision.step} (${decision.allowed ? 'ALLOW' : decision.reason})`);
    this.name = 'ScheduleDeniedError';
    this.decision = decision;
  }
}

/**
 * A precondition of a state transition or of publication did not hold when it
 * was re-checked inside the transaction — e.g. publishing a version whose state
 * is no longer `approved` (the concurrent-publication loser, V-12), or a
 * cross-period double-booking (handled by D-1b at the database, surfaced here
 * for a clearer message). Distinct from a denial: the caller was authorized, the
 * world changed.
 */
export class SchedulePreconditionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SchedulePreconditionError';
    this.code = code;
  }
}

/** An illegal state-machine transition was requested (SPEC-05 §3.1). */
export class ScheduleTransitionError extends SchedulePreconditionError {
  constructor(from: string, to: string) {
    super('ILLEGAL_TRANSITION', `a schedule version cannot move ${from} -> ${to} (SPEC-05 §3.1)`);
    this.name = 'ScheduleTransitionError';
  }
}
