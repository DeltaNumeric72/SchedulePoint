import type { SolveOutcomeDetail } from '../solver/solver-client.js';
import type {
  BuildRunState,
  BuildSolverStatus,
  BuildTerminationReason,
} from '../db/schema.js';

/**
 * The sixteen states, their legal edges, and the honest mapping from a solve
 * outcome onto one of them (OPUS-M4-003; report 21 §4 governs the set).
 *
 * ## This is the readable half of a control that lives in the database
 *
 * `app_build_run_transition_is_legal` in migration 0018 is the same table,
 * written in SQL. Two spellings of one rule is normally the S-01 defect — here
 * it is deliberate and the duplication is PROVEN rather than trusted:
 * `transition-matrix.test.ts` drives every ordered pair of the sixteen states
 * through **both** layers and asserts they agree, so a divergence is a test
 * failure rather than a surprise in production. The database is the control; the
 * table below is what lets a route return `409 BUILD_STATE_MOVED` instead of a
 * raw `restrict_violation`.
 *
 * ## Two departures from report 21's edge table, both from doc 35 §6e's rulings
 *
 *  1. **`infeasible → draft_configuration` is absent.** SPEC-04 §2: "a retry is
 *     a **new** `build_run` … retries are never in-place". The retry is a new
 *     row carrying `retryOfBuildRunId`.
 *  2. **`queued → cancelled` is present**, where report 21 lists cancellation
 *     from `running` only. Without it, cancelling a build that has not yet been
 *     claimed can only be recorded as `failed` by the reaper — reporting a
 *     deliberate human decision as a system fault, which is the conflation
 *     SPEC-04 §2 and FAD-34 exist to prevent. DISCLOSED as an extension.
 */

export const BUILD_RUN_STATES = [
  'draft_configuration',
  'validating',
  'readiness_check',
  'queued',
  'running',
  'completed',
  'completed_with_unmet_preferences',
  'infeasible',
  'failed',
  'cancelled',
  'reviewed',
  'progressively_extended',
  'approved',
  'applied_to_draft_schedule',
  'superseded',
  'archived',
] as const satisfies readonly BuildRunState[];

/**
 * The states in which a build is IN FLIGHT — being configured, validated,
 * checked, queued, or solved. D-4a's partial unique index covers exactly these,
 * and the set is spelled out in both places rather than negated so that a future
 * state cannot silently join or leave it.
 */
export const IN_FLIGHT_STATES = [
  'draft_configuration',
  'validating',
  'readiness_check',
  'queued',
  'running',
] as const satisfies readonly BuildRunState[];

const IN_FLIGHT: ReadonlySet<string> = new Set(IN_FLIGHT_STATES);

export function isInFlight(state: BuildRunState): boolean {
  return IN_FLIGHT.has(state);
}

/** The "completed family" report 21 means by "any completed state → superseded". */
export const COMPLETED_FAMILY_STATES = [
  'completed',
  'completed_with_unmet_preferences',
  'reviewed',
  'progressively_extended',
  'approved',
  'applied_to_draft_schedule',
] as const satisfies readonly BuildRunState[];

/** Every state in which the build has an answer — report 21's "terminal". */
export const SETTLED_STATES = [
  ...COMPLETED_FAMILY_STATES,
  'infeasible',
  'failed',
  'cancelled',
  'superseded',
] as const satisfies readonly BuildRunState[];

/**
 * The legal edges. Mirrors `app_build_run_transition_is_legal` exactly; the
 * matrix proof asserts the mirror.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<BuildRunState, readonly BuildRunState[]>> = {
  draft_configuration: ['validating'],
  validating: ['draft_configuration', 'readiness_check'],
  readiness_check: ['draft_configuration', 'queued'],
  queued: ['running', 'cancelled'],
  running: [
    'completed',
    'completed_with_unmet_preferences',
    'infeasible',
    'failed',
    'cancelled',
  ],
  completed: ['reviewed', 'superseded', 'archived'],
  completed_with_unmet_preferences: ['reviewed', 'superseded', 'archived'],
  infeasible: ['archived'],
  failed: ['archived'],
  cancelled: ['archived'],
  reviewed: ['progressively_extended', 'approved', 'superseded', 'archived'],
  progressively_extended: ['reviewed', 'superseded', 'archived'],
  approved: ['applied_to_draft_schedule', 'superseded', 'archived'],
  applied_to_draft_schedule: ['superseded', 'archived'],
  superseded: ['archived'],
  archived: [],
};

export function isLegalTransition(from: BuildRunState, to: BuildRunState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/**
 * The states from which a build may be cancelled by a scheduler.
 *
 * `queued` cancels immediately (nothing is running to interrupt). `running`
 * requests cancellation through the shipped file channel and the dispatch
 * reports `CANCELLED` — the state moves when the solve really stops, not when
 * the button is pressed, because a state that moved first would be a claim the
 * system had not yet earned.
 */
export function isCancellable(state: BuildRunState): boolean {
  return state === 'queued' || state === 'running';
}

/* ────────────────────────────────────────────────────────────────────────────
 * Outcome → state
 * ──────────────────────────────────────────────────────────────────────────── */

export interface TerminalOutcome {
  readonly state: BuildRunState;
  readonly terminationReason: BuildTerminationReason;
  readonly solverStatus: BuildSolverStatus;
}

export interface OutcomeClassificationInput {
  readonly outcome: Pick<
    SolveOutcomeDetail,
    'status' | 'terminationReason' | 'assignments' | 'objectiveValue'
  >;
  /** The INDEPENDENT checker's verdict. `null` when there was nothing to check. */
  readonly usable: boolean | null;
}

/**
 * **The single place a solve outcome becomes a lifecycle state.**
 *
 * Four rules, each of which exists because collapsing it would produce a
 * plausible-looking lie:
 *
 *  1. **`INFEASIBLE` is `infeasible`, never `failed`.** A statement about the
 *     problem, not about the system (report 21 §4).
 *  2. **`TIMEOUT` is `failed` with reason `deadline`, never `infeasible`.** A
 *     solve that ran out of time has said nothing about whether a schedule
 *     exists (doc 08 §4.1; SPEC-04 §2 "a timed-out run must not be reported as a
 *     completed one").
 *  3. **`CANCELLED` is `cancelled` with reason `user_cancelled`.** EV-M0-SPC's
 *     H-6 finding, carried the whole way up.
 *  4. **A candidate the independent checker refused is `failed` with reason
 *     `rejected`** — not `completed`, whatever the worker's status said. The
 *     checker wins over the worker (SPEC-04 §3.3), and `rejected` is the FAD-34
 *     word for it.
 *
 * The split between `completed` and `completed_with_unmet_preferences` is
 * measured rather than assumed: a zero (or absent) objective value means no soft
 * penalty was incurred, which is what "all preferences met" means. A positive
 * objective means some were not, whether or not the solve proved optimality —
 * so optimality and completeness stay separate questions, which is exactly what
 * SPEC-04 §7's "no optimality claim for a feasible result" asks for.
 */
export function classifyOutcome(input: OutcomeClassificationInput): TerminalOutcome {
  const { outcome, usable } = input;
  const solverStatus = outcome.status;

  if (solverStatus === 'CANCELLED') {
    return { state: 'cancelled', terminationReason: 'user_cancelled', solverStatus };
  }
  if (solverStatus === 'TIMEOUT') {
    return { state: 'failed', terminationReason: 'deadline', solverStatus };
  }
  if (solverStatus === 'INFEASIBLE') {
    return { state: 'infeasible', terminationReason: 'completed', solverStatus };
  }
  if (solverStatus === 'MODEL_INVALID' || solverStatus === 'FAILED' || solverStatus === 'UNKNOWN') {
    /* The worker's own reason is preserved when it gave one that is not
     * `completed` — `killed` and `crashed` are attributed by the parent and must
     * survive the trip (FAD-34(2)). */
    const reason: BuildTerminationReason =
      outcome.terminationReason === 'completed' ? 'rejected' : outcome.terminationReason;
    return { state: 'failed', terminationReason: reason, solverStatus };
  }

  /* OPTIMAL or FEASIBLE. A candidate exists only if one was returned AND the
   * independent checker admitted it. */
  if (outcome.assignments === null || usable !== true) {
    return { state: 'failed', terminationReason: 'rejected', solverStatus };
  }

  const objective = outcome.objectiveValue;
  const allPreferencesMet = objective === null || objective === 0;
  return {
    state: allPreferencesMet ? 'completed' : 'completed_with_unmet_preferences',
    terminationReason: 'completed',
    solverStatus,
  };
}
