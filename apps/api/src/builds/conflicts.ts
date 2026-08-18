import type {
  BuildConflict,
  BuildExplanation,
  BuildQualityMetrics,
  BuildRejection,
  BuildViolation,
} from '@schedulepoint/contracts';
import {
  compareConflictClasses,
  conflictClassOfDemandShortfall,
  conflictClassOfRejection,
  conflictClassOfStructuralFinding,
  conflictClassOfViolation,
  conflictClassSpec,
} from '@schedulepoint/domain';

/**
 * **The conflict surface: one classified, severity-ordered list** (OPUS-M4-004;
 * PO-DEC-13's recorded default).
 *
 * ## Why a projection rather than a column
 *
 * Everything here already exists on the result — the checker's violations, its
 * rejections, the worker's T0 findings, the measured demand rate. What did not
 * exist was a single ordering across them, and its absence was the actual
 * problem: a scheduler looking at a refused build read a flat list of hard-rule
 * findings in one panel, a flat list of rejections in another, and a demand
 * ratio in a third, with nothing saying which of the three to read first or
 * which of them could be ignored.
 *
 * PO-DEC-13's four classes are that ordering. This module applies them; it does
 * not invent them, and it adds no fifth class — the domain's taxonomy is closed
 * and an unmapped shape lands in `hard-breach`, the most severe, because a
 * conflict filed where nobody looks is worse than one filed too loudly.
 *
 * ## No schema change, and none needed
 *
 * The classification is a pure function of rows migration 0018 already stores.
 * Persisting a `conflict_class` column would make the taxonomy a fact about when
 * a build ran rather than about what PO-DEC-13 says today, and re-classifying
 * history after a decision change would then require a migration. The projection
 * is derived on read, so a taxonomy change re-classifies every historical build
 * for free — which is the correct behaviour for a *display* rule.
 */

export interface ConflictProjectionInput {
  readonly violations: readonly BuildViolation[];
  readonly rejections: readonly BuildRejection[];
  readonly explanation: BuildExplanation | null;
  readonly quality: BuildQualityMetrics | null;
  /** The fairness extremes, when a dispersion was measurable. Advisory only. */
  readonly fairnessOutliers: readonly {
    readonly membershipId: string;
    readonly normalisedCredit: number;
    readonly position: 'highest' | 'lowest';
  }[];
}

function entry(
  conflictClass: ReturnType<typeof conflictClassOfRejection>,
  source: BuildConflict['source'],
  code: string,
  subject: string | null,
  detail: string,
): BuildConflict {
  const spec = conflictClassSpec(conflictClass);
  return {
    conflictClass,
    severityRank: spec.severityRank,
    blocksApproval: spec.blocksApproval,
    banded: spec.banded,
    source,
    code: code.slice(0, 200),
    subject: subject === null ? null : subject.slice(0, 200),
    detail: detail.slice(0, 2000),
  };
}

/**
 * Classify everything, then sort by severity.
 *
 * The secondary sort is by source, code and subject — stable and content-free,
 * so two identical builds produce identical lists and a diff of two evidence
 * transcripts shows only real differences.
 */
export function conflictsOf(input: ConflictProjectionInput): readonly BuildConflict[] {
  const conflicts: BuildConflict[] = [];

  for (const violation of input.violations) {
    conflicts.push(
      entry(
        conflictClassOfViolation({
          finding: violation.finding,
          nodeKind: violation.nodeKind,
        }),
        'violation',
        violation.finding === 'not-evaluable' ? 'rule_not_evaluable' : 'rule_breached',
        violation.ruleKey,
        violation.explanation,
      ),
    );
  }

  for (const rejection of input.rejections) {
    conflicts.push(
      entry(
        conflictClassOfRejection(rejection.reason),
        'rejection',
        rejection.reason.replace(/-/g, '_'),
        null,
        rejection.detail,
      ),
    );
  }

  for (const finding of input.explanation?.structural ?? []) {
    conflicts.push(
      entry(
        conflictClassOfStructuralFinding(finding.code),
        'structural',
        finding.code,
        finding.date,
        finding.detail,
      ),
    );
  }

  /* The demand shortfall, as a conflict rather than as a ratio. SPEC-04 §7 is
   * explicit that `demand_satisfaction_rate` is "a hard rule; a shortfall is a
   * violation, not a metric" — so a build that filled 34 of 40 slots raises a
   * conflict, and does not merely display 0.85 in a panel of measurements. */
  const shortfall = conflictClassOfDemandShortfall(input.quality?.demandSatisfactionRate ?? null);
  if (shortfall !== null && input.quality !== null) {
    conflicts.push(
      entry(
        shortfall,
        'demand',
        'demand_not_satisfied',
        null,
        `${String(input.quality.filledSlots)} of ${String(input.quality.requiredSlots)} required ` +
          'slots were filled',
      ),
    );
  }

  /* Fairness. **Advisory, and band-less by construction.** No threshold for
   * `fairness_dispersion` exists until the M6 benchmark (SPEC-04 §7), so nothing
   * here says a dispersion is too large — the extremes are named because they
   * are the extremes, and `banded: false` travels with each one so no surface
   * can render it as a failure. */
  for (const outlier of input.fairnessOutliers) {
    conflicts.push(
      entry(
        'fairness-outlier',
        'fairness',
        outlier.position === 'highest' ? 'fairness_load_highest' : 'fairness_load_lowest',
        outlier.membershipId,
        `normalised credit ${outlier.normalisedCredit.toFixed(2)} (${input.quality?.fairnessNormalisation ?? 'unrecorded'}); ` +
          'no band is defined for fairness dispersion, so this is a measurement and not a verdict',
      ),
    );
  }

  conflicts.sort(
    (a, b) =>
      compareConflictClasses(a.conflictClass, b.conflictClass) ||
      a.source.localeCompare(b.source) ||
      a.code.localeCompare(b.code) ||
      (a.subject ?? '').localeCompare(b.subject ?? ''),
  );
  return conflicts;
}
