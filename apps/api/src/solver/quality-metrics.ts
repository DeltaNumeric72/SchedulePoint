import {
  FAIRNESS_NORMALISATION,
  demandCoverage,
  fairnessDispersion,
  fairnessExtremes,
  type DemandCoverage,
  type FairnessCreditInput,
  type FairnessDispersion,
  type SolverCandidateAssignment,
  type SolverInputSnapshotDocument,
} from '@schedulepoint/domain';

import { OBJECTIVE_PROFILE_DIGEST } from './objective-record.js';
import type { SolveOutcomeDetail } from './solver-client.js';

/**
 * **SPEC-04 §7's metric set, measured — and every band still undefined**
 * (OPUS-M4-004).
 *
 * ## What changed from E1, and why the shape is what it is
 *
 * E1 recorded five numbers computed inline in `runner.ts`, and one of them —
 * `hardViolations: 0` — was a **literal**, written beside a verdict that already
 * knew the real count. It happened to be right, because an unusable candidate
 * never reached the same code path, but a metric that is a constant is a metric
 * nobody can falsify. The count now comes from the checker's verdict, which is
 * the only thing entitled to state it (SPEC-04 §3.3).
 *
 * The rest of §7's table lands here for the first time:
 *
 * | §7 metric | here | status |
 * |---|---|---|
 * | `demand_satisfaction_rate` | `demandSatisfactionRate` | measured; a shortfall is a **conflict**, per §7 "a hard rule; a shortfall is a violation, not a metric" |
 * | `hard_violations` | `hardViolations` | the ONE defined band: must be 0 |
 * | `soft_penalty_total` | `softPenaltyTotal` | the objective value, meaningful only beside `objectiveWeightsDigest` |
 * | `request_honour_rate` | `requestHonourRate` | **`null`** — requests are M5; a zero would claim every request was refused |
 * | `fairness_dispersion` | `fairnessDispersion` | measured, with `fairnessNormalisation` recorded beside it |
 * | `template_adherence_rate` | `templateAdherenceRate` | **`null`** — `TemplateAdherence` is fail-closed at M4 (FAD-27) |
 * | `solve_wall_clock` | `solveWallClockMs` | measured |
 * | `explanation_latency` | `explanationLatencyMs` | measured, from the worker's own explanation clock |
 *
 * The two `null`s are the point. Returning `0` for a rate whose input does not
 * exist yet would put a number on a screen that reads as "nothing was honoured"
 * — a specific, wrong, actionable claim. `null` reads as "not measured", which
 * is true.
 *
 * ## Nothing here carries a band, a rating, or a colour
 *
 * SPEC-04 §7: every band except `hard_violations = 0` is undefined until the
 * benchmark corpus is run at M6. A threshold invented here
 * would be indistinguishable, three screens later, from one the owner approved.
 */

export interface QualityMetricsInput {
  readonly snapshot: SolverInputSnapshotDocument;
  readonly assignments: readonly SolverCandidateAssignment[];
  readonly outcome: SolveOutcomeDetail;
  /** The INDEPENDENT checker's count. `null` when there was nothing to check. */
  readonly hardViolations: number | null;
}

export interface QualityMetricsRecord {
  readonly demandSatisfactionRate: number | null;
  readonly requiredSlots: number;
  readonly filledSlots: number;
  readonly hardViolations: number;
  readonly softPenaltyTotal: number | null;
  readonly solveWallClockMs: number;
  readonly requestHonourRate: number | null;
  readonly templateAdherenceRate: number | null;
  readonly fairnessDispersion: number | null;
  readonly fairnessNormalisation: string;
  readonly fairnessMeasuredParticipants: number;
  readonly fairnessUnmeasuredParticipants: number;
  readonly explanationLatencyMs: number | null;
  /** The objective this result was produced under. Comparability depends on it. */
  readonly objectiveWeightsDigest: string;
  readonly objectiveScale: number;
  readonly objectiveProfileId: string;
  readonly solverStatistics: Record<string, number | null>;
  /**
   * The measured extremes, PERSISTED rather than recomputed on every read.
   *
   * The dispersion is a fact about the candidate at the moment it was produced.
   * Recomputing it when the detail page loads would mean reading the whole
   * snapshot on every render and — worse — would let a later change to the
   * measurement silently restate history.
   */
  readonly fairnessOutliers: readonly FairnessOutlier[];
}

/**
 * The credit each assignment carries, from the snapshot's shift-type credit
 * weights.
 *
 * `credit_weight` is a `numeric` and arrives as a STRING, which is why it is
 * parsed here rather than read: `Number('')` is `0` and `Number(undefined)` is
 * `NaN`, and both would silently become "this shift carries no burden".
 */
function creditWeightOf(snapshot: SolverInputSnapshotDocument): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  for (const shiftType of snapshot.shiftTypes) {
    const parsed = Number(shiftType.creditWeight);
    map.set(shiftType.shiftTypeId, Number.isFinite(parsed) ? parsed : 0);
  }
  return map;
}

/** Credit the SNAPSHOT already carried — the adjudicated history (doc 07). */
function priorCreditsOf(snapshot: SolverInputSnapshotDocument): readonly FairnessCreditInput[] {
  const out: FairnessCreditInput[] = [];
  for (const fixed of snapshot.fixedAssignments) {
    if (fixed.creditedMembershipId === null || fixed.creditWeight === null) continue;
    const parsed = Number(fixed.creditWeight);
    if (!Number.isFinite(parsed)) continue;
    out.push({ membershipId: fixed.creditedMembershipId, credit: parsed });
  }
  return out;
}

/**
 * Demand coverage for a candidate, over the snapshot's REQUIREMENT cells.
 *
 * The `period-requirement` filter is the whole adapter: `weekday-default` cells
 * describe a shape the period may draw from, not a quantity anybody asked for,
 * and counting them would invent demand the scheduler never stated.
 *
 * Exported because the INDEPENDENT checker reads the same rule — see
 * `candidate-validation.ts`. One statement in TypeScript, and the Python model's
 * hard equality remains a separate statement it may disagree with; that
 * disagreement is what makes the check worth running (F-03).
 */
export function candidateDemandCoverage(
  snapshot: SolverInputSnapshotDocument,
  assignments: readonly SolverCandidateAssignment[],
): DemandCoverage {
  return demandCoverage(
    snapshot.demand
      .filter((cell) => cell.source === 'period-requirement')
      /* `on` carries the DATE for a period requirement (it is a weekday token
       * only for a `weekday-default`, which the filter above has already
       * dropped). Reading a `date` property here would read `undefined`, and
       * `undefined` matches no placement — a metric that scores every candidate
       * 0 is no better than one that scores every candidate 1. */
      .map((cell) => ({
        date: cell.on,
        shiftTypeId: cell.shiftTypeId,
        requiredCount: cell.requiredCount,
      })),
    assignments.map((assignment) => ({
      date: assignment.date,
      shiftTypeId: assignment.shiftTypeId,
    })),
  );
}

/**
 * The fairness measurement for a candidate, or for the empty candidate.
 *
 * Exported so the comparison surface and the conflict taxonomy read the SAME
 * dispersion the result recorded, rather than each computing one — the S-01
 * defect shape, applied to statistics.
 */
export function candidateFairness(
  snapshot: SolverInputSnapshotDocument,
  assignments: readonly SolverCandidateAssignment[],
): FairnessDispersion {
  const credits = creditWeightOf(snapshot);
  const candidateCredits: FairnessCreditInput[] = assignments.map((assignment) => ({
    membershipId: assignment.membershipId,
    credit: credits.get(assignment.shiftTypeId) ?? 0,
  }));
  return fairnessDispersion({
    participants: snapshot.participants.map((participant) => ({
      membershipId: participant.membershipId,
      workPercentage: participant.workProfile?.workPercentage ?? null,
    })),
    candidateCredits,
    priorCredits: priorCreditsOf(snapshot),
  });
}

export function qualityMetrics(input: QualityMetricsInput): QualityMetricsRecord {
  const { snapshot, assignments, outcome } = input;

  const coverage = candidateDemandCoverage(snapshot, assignments);
  const { requiredSlots, filledSlots } = coverage;
  const dispersion = candidateFairness(snapshot, assignments);

  return {
    demandSatisfactionRate: coverage.satisfactionRate,
    requiredSlots,
    filledSlots,
    /* The CHECKER's count, never a literal. `null` — nothing was checked —
     * records as 0 because there were no measured violations, and the
     * `candidateReturned` column beside it is what distinguishes that from a
     * candidate that was checked and found clean. */
    hardViolations: input.hardViolations ?? 0,
    softPenaltyTotal: outcome.objectiveValue,
    solveWallClockMs: outcome.elapsedMs,
    /* M5 owns requests; `TemplateAdherence` is fail-closed at M4 (FAD-27). A
     * rate over an input that does not exist is not a low rate, it is no rate. */
    requestHonourRate: null,
    templateAdherenceRate: null,
    fairnessDispersion: dispersion.coefficientOfVariation,
    fairnessNormalisation: FAIRNESS_NORMALISATION,
    fairnessMeasuredParticipants: dispersion.measuredParticipants,
    fairnessUnmeasuredParticipants: dispersion.unmeasuredParticipants,
    explanationLatencyMs:
      outcome.explanation?.elapsedSeconds === null ||
      outcome.explanation?.elapsedSeconds === undefined
        ? null
        : Math.round(outcome.explanation.elapsedSeconds * 1000),
    /* Recorded from the PLATFORM's constant, not from the worker's echo. The
     * echo was already compared against this value at the boundary and a
     * mismatch was refused there; recording the echo here would store a claim
     * where a fact belongs. */
    objectiveWeightsDigest: OBJECTIVE_PROFILE_DIGEST,
    objectiveScale: outcome.objectiveProfile?.scale ?? 0,
    objectiveProfileId: outcome.objectiveProfile?.profileId ?? '',
    solverStatistics: { ...outcome.statistics },
    fairnessOutliers: fairnessOutliers(dispersion),
  };
}

/**
 * The fairness EXTREMES, as advisory conflicts.
 *
 * Separate from the metric because they are a different kind of statement: the
 * metric is a number, these are rows a scheduler is invited to look at. Neither
 * carries a threshold — no band for
 * `fairness_dispersion` exists until the M6 benchmark — so the surface says exactly
 * that (PO-DEC-13's `fairness-outlier` class, `blocksApproval: false`).
 */
export interface FairnessOutlier {
  readonly membershipId: string;
  readonly normalisedCredit: number;
  readonly position: 'highest' | 'lowest';
}

export function fairnessOutliers(dispersion: FairnessDispersion): readonly FairnessOutlier[] {
  const extremes = fairnessExtremes(dispersion);
  if (extremes === null) return [];
  return [
    {
      membershipId: extremes.highest.membershipId,
      normalisedCredit: extremes.highest.normalisedCredit,
      position: 'highest',
    },
    {
      membershipId: extremes.lowest.membershipId,
      normalisedCredit: extremes.lowest.normalisedCredit,
      position: 'lowest',
    },
  ];
}
