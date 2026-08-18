/**
 * **Candidate quality, as SPEC-04 §7 defines it — and no further**
 * (OPUS-M4-004).
 *
 * ## Every band except one is undefined, and this file says so in its types
 *
 * SPEC-04 §7:
 *
 * > **Bands are set from the benchmark corpus, not invented here.** Until the
 * > corpus is run, every band except `hard_violations = 0` is **undefined**, and
 * > saying so is the honest position. **PO-DEC-23 … remains pending.**
 *
 * REPAIR F-15 (delta review). The sentence above is SPEC-04 §7 quoted verbatim, and
 * its last clause is now STALE: **PO-DEC-23 is RESOLVED** per
 * `docs/fable/21-decision-resolution.md` — report 21 §8.3's conservative targets are
 * the published commitments, and the benchmark bands are set at M6 and must be ≤ those
 * targets (NR-8).
 *
 * The correction sits OUTSIDE the blockquote and is attributed to doc 21, because the
 * repair round's first attempt edited the clause *inside* the quotation — which made
 * SPEC-04 §7 appear to say something it does not say. Putting a true statement into
 * another document's mouth is a worse defect than the stale line it replaced, and it is
 * unfalsifiable by anyone who trusts the attribution. SPEC-04 is outside this packet's
 * writable glob, so the spec's own line stays stale until a packet that owns it can fix
 * it; that is recorded rather than worked around.
 *
 * The operative half is unchanged either way: resolved is not banded, and until the M6
 * benchmark runs there is still no band to measure against.
 *
 * So nothing here returns a rating, a colour, a grade, or a pass/fail — except
 * `hardViolations`, which has the one defined threshold and is enforced
 * elsewhere as a rejection rather than reported here as a number with an
 * opinion. Everything else is a **measurement**: a count, a ratio, or a
 * dispersion. A metric that carried an invented band would be worse than no
 * metric, because it would look actionable.
 *
 * ## Fairness: what "normalised credits" means here, exactly
 *
 * §7 defines `fairness_dispersion` as the *coefficient of variation of
 * normalised credits*, and doc 08 §8 lists "fair distribution by FTE". Both
 * halves are computable from what the canonical snapshot already carries, and
 * neither needed a new constituent:
 *
 *  * **credit** — `shift_types.credit_weight` summed over the candidate's
 *    assignments, PLUS the credit the snapshot already carries on its fixed
 *    assignments (`creditedMembershipId` / `creditWeight`). That second term is
 *    the *history*: credits are the human adjudication of burden (doc 07), they
 *    were recorded before this build existed, and a fairness measure that
 *    ignored them would call a schedule fair precisely when it had just finished
 *    loading the same person twice;
 *  * **normalisation** — divide by the membership's FTE share
 *    (`work_percentage / 100`). Someone at 50% carrying half the credits is
 *    carrying the same burden as someone at 100% carrying all of them, and an
 *    un-normalised dispersion would report that equality as unfairness.
 *
 * The choice is RECORDED on every result ({@link FAIRNESS_NORMALISATION}), not
 * merely applied, because a dispersion number whose basis is unstated is a
 * number two people will read as two different facts.
 *
 * **A participant with no in-force work profile is excluded from the
 * dispersion**, and the count of exclusions is reported. Treating an absent FTE
 * as 100% would silently claim a fact about a person the snapshot does not carry
 * one for — the FAD-23 class, applied to arithmetic.
 */

/** The recorded normalisation basis. One value today; the field is not a boolean. */
export const FAIRNESS_NORMALISATION = 'fte-work-percentage';
export type FairnessNormalisationBasis = typeof FAIRNESS_NORMALISATION;

/** One participant, as the fairness measure needs them. Structural, not the snapshot type. */
export interface FairnessParticipantInput {
  readonly membershipId: string;
  /** `0 < x <= 100`, or `null` when no work profile is in force at the build instant. */
  readonly workPercentage: number | null;
}

/** One credit-bearing event: an assignment the candidate made, or one the snapshot carried. */
export interface FairnessCreditInput {
  readonly membershipId: string;
  /** The credit weight. Non-finite and negative values are refused by the caller's parser. */
  readonly credit: number;
}

export interface FairnessLoad {
  readonly membershipId: string;
  /** Credit from the candidate plus credit the snapshot already carried. */
  readonly credit: number;
  /** `credit ÷ (workPercentage ÷ 100)`. */
  readonly normalisedCredit: number;
}

/**
 * The dispersion measurement.
 *
 * `coefficientOfVariation` is `null` — never `0` — whenever it is not defined:
 * fewer than two measurable participants, or a mean of zero. Zero would read as
 * "perfectly fair", which is the opposite of "we could not measure it".
 */
export interface FairnessDispersion {
  readonly normalisation: FairnessNormalisationBasis;
  readonly measuredParticipants: number;
  /** Participants excluded because no in-force work profile carries their FTE. */
  readonly unmeasuredParticipants: number;
  readonly mean: number | null;
  readonly standardDeviation: number | null;
  /** SPEC-04 §7's `fairness_dispersion`. Band-less until the M6 benchmark. */
  readonly coefficientOfVariation: number | null;
  /** Every measured load, sorted by normalised credit descending then id. */
  readonly loads: readonly FairnessLoad[];
}

export interface FairnessDispersionInput {
  readonly participants: readonly FairnessParticipantInput[];
  /** Credit the candidate produced. */
  readonly candidateCredits: readonly FairnessCreditInput[];
  /** Credit the snapshot already carried — the adjudicated history (doc 07). */
  readonly priorCredits: readonly FairnessCreditInput[];
}

/**
 * Population standard deviation, not the sample estimator.
 *
 * The participants ARE the population: this is a statement about the group that
 * was scheduled, not an inference from a sample of a larger one. Using the
 * sample estimator would make a two-person group's dispersion larger by a factor
 * of √2 for a reason that has nothing to do with the schedule.
 */
export function fairnessDispersion(input: FairnessDispersionInput): FairnessDispersion {
  const credit = new Map<string, number>();
  for (const participant of input.participants) credit.set(participant.membershipId, 0);
  for (const entry of [...input.priorCredits, ...input.candidateCredits]) {
    if (!Number.isFinite(entry.credit)) continue;
    const current = credit.get(entry.membershipId);
    /* A credit naming a membership outside the participant set is DROPPED here
     * rather than added under a new key: the assembly refuses such a snapshot
     * (`snapshotRefusals`), so reaching this line means somebody hand-built the
     * input, and inventing a participant to hold their credit would make the
     * dispersion a statement about a person who is not in the group. */
    if (current === undefined) continue;
    credit.set(entry.membershipId, current + entry.credit);
  }

  const loads: FairnessLoad[] = [];
  let unmeasured = 0;
  for (const participant of input.participants) {
    const percentage = participant.workPercentage;
    if (percentage === null || !Number.isFinite(percentage) || percentage <= 0) {
      unmeasured += 1;
      continue;
    }
    const earned = credit.get(participant.membershipId) ?? 0;
    loads.push({
      membershipId: participant.membershipId,
      credit: earned,
      normalisedCredit: earned / (percentage / 100),
    });
  }

  loads.sort(
    (a, b) =>
      b.normalisedCredit - a.normalisedCredit || a.membershipId.localeCompare(b.membershipId),
  );

  if (loads.length < 2) {
    return {
      normalisation: FAIRNESS_NORMALISATION,
      measuredParticipants: loads.length,
      unmeasuredParticipants: unmeasured,
      mean: null,
      standardDeviation: null,
      coefficientOfVariation: null,
      loads,
    };
  }

  const mean = loads.reduce((total, load) => total + load.normalisedCredit, 0) / loads.length;
  const variance =
    loads.reduce((total, load) => total + (load.normalisedCredit - mean) ** 2, 0) / loads.length;
  const standardDeviation = Math.sqrt(variance);

  return {
    normalisation: FAIRNESS_NORMALISATION,
    measuredParticipants: loads.length,
    unmeasuredParticipants: unmeasured,
    mean,
    standardDeviation,
    /* Undefined at a zero mean — nobody carried any credit — and reported as
     * `null` rather than as a division that would produce `Infinity` or `NaN`
     * and then be rendered as a number. */
    coefficientOfVariation: mean === 0 ? null : standardDeviation / mean,
    loads,
  };
}

/**
 * The extremes of a measured dispersion — the two participants a scheduler would
 * look at first.
 *
 * **This is not a threshold.** No band exists until the M6 benchmark and none is
 * invented: the extremes are named because they are the extremes, and the
 * surface that shows them says exactly that. Returns `null` when fewer than two
 * participants were measurable or when every load is identical, because "the
 * highest of a set that is all one value" is not a finding.
 */
export interface FairnessExtremes {
  readonly highest: FairnessLoad;
  readonly lowest: FairnessLoad;
}

export function fairnessExtremes(dispersion: FairnessDispersion): FairnessExtremes | null {
  const loads = dispersion.loads;
  if (loads.length < 2) return null;
  const highest = loads[0];
  const lowest = loads[loads.length - 1];
  if (highest === undefined || lowest === undefined) return null;
  if (highest.normalisedCredit === lowest.normalisedCredit) return null;
  return { highest, lowest };
}
