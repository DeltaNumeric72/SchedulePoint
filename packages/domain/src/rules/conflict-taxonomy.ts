/**
 * **PO-DEC-13's conflict taxonomy, implemented exactly** (OPUS-M4-004).
 *
 * The recorded default ([21-decision-resolution](../../../../docs/fable/21-decision-resolution.md),
 * PO-DEC-13) reads:
 *
 * > **Four classes: hard breach / unmet demand / eligibility failure / fairness
 * > outlier** — plus severity ordering and per-class display rules in SPEC-04
 * > terms.
 *
 * Four classes. Not three, not five, and not a fifth "other" bucket — a taxonomy
 * with an escape hatch is a taxonomy nothing ever has to fit. Every conflict the
 * build pipeline can produce is mapped below, by name, and a shape that reaches
 * an unmapped branch is classified `hard-breach`: the most severe class, because
 * the one thing worse than a mis-filed conflict is a conflict that was filed
 * where nobody looks.
 *
 * ## The severity order is the decision's own order
 *
 * `hard-breach` → `unmet-demand` → `eligibility-failure` → `fairness-outlier`,
 * as PO-DEC-13 lists them. The order was not re-derived here: re-deriving a
 * recorded default is how a default quietly becomes a preference.
 *
 * ## The display rules, in SPEC-04 terms
 *
 * | class | SPEC-04 basis | blocks approval |
 * |---|---|---|
 * | `hard-breach` | §3.3 "a violation fails the build"; §7 `hard_violations` **must be 0** | yes |
 * | `unmet-demand` | §7 `demand_satisfaction_rate` is "a **hard rule**; a shortfall is a violation, not a metric" | yes |
 * | `eligibility-failure` | §3.1's eligibility family; the snapshot's frozen verdict | yes |
 * | `fairness-outlier` | §7 `fairness_dispersion` — "**band per dataset class**", and **every band is undefined until the corpus is run** | **no** |
 *
 * The fourth row is the load-bearing one. A fairness outlier is a
 * **measurement without a threshold**: no band exists until the M6 benchmark, so nothing in this
 * system knows what "too dispersed" is, and a class that blocked approval on a
 * number with no band would be enforcing an invented standard. It is reported,
 * ordered last, and explicitly advisory — which is what SPEC-04 §7's "undefined"
 * means when it has to be rendered on a screen.
 */

/** The four classes. Order IS the severity order; index 0 is most severe. */
export const CONFLICT_CLASSES = [
  'hard-breach',
  'unmet-demand',
  'eligibility-failure',
  'fairness-outlier',
] as const;

export type ConflictClass = (typeof CONFLICT_CLASSES)[number];

export interface ConflictClassSpec {
  readonly conflictClass: ConflictClass;
  /** 1 is most severe. Stable; a class is never renumbered (rule 13). */
  readonly severityRank: number;
  /**
   * Whether an open conflict of this class prevents `reviewed → approved`.
   *
   * Mirrors the database's own control: migration 0018's transition guard reads
   * `build_run_violations` on that edge, which is exactly the `hard-breach` and
   * `eligibility-failure` population. This flag is the READABLE half; the guard
   * is the control.
   */
  readonly blocksApproval: boolean;
  /**
   * Whether a threshold exists for this class at all.
   *
   * `false` everywhere a band would be needed and none is defined. A surface
   * that shows a band-less class must say so — SPEC-04 §7's honest position,
   * carried into the type rather than into a comment somebody might not render.
   */
  readonly banded: boolean;
}

export const CONFLICT_TAXONOMY: readonly ConflictClassSpec[] = [
  { conflictClass: 'hard-breach', severityRank: 1, blocksApproval: true, banded: true },
  { conflictClass: 'unmet-demand', severityRank: 2, blocksApproval: true, banded: true },
  { conflictClass: 'eligibility-failure', severityRank: 3, blocksApproval: true, banded: true },
  { conflictClass: 'fairness-outlier', severityRank: 4, blocksApproval: false, banded: false },
];

const BY_CLASS: ReadonlyMap<ConflictClass, ConflictClassSpec> = new Map(
  CONFLICT_TAXONOMY.map((spec) => [spec.conflictClass, spec]),
);

export function conflictClassSpec(conflictClass: ConflictClass): ConflictClassSpec {
  const spec = BY_CLASS.get(conflictClass);
  /* Unreachable while the union and the table agree, and the table is asserted
   * exhaustive by its own test. Thrown rather than defaulted, because a default
   * here would be a fifth class wearing the name of one of the four. */
  if (spec === undefined) throw new Error(`No taxonomy entry for conflict class ${conflictClass}.`);
  return spec;
}

/** Severity order, then the caller's own tiebreak. Never alphabetical by class name. */
export function compareConflictClasses(a: ConflictClass, b: ConflictClass): number {
  return conflictClassSpec(a).severityRank - conflictClassSpec(b).severityRank;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The mappings. Every producer of a conflict in the pipeline has one.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Node kinds whose breach is a statement about COVERAGE, not about a person. */
const COVERAGE_KINDS: ReadonlySet<string> = new Set([
  'RequiredCount',
  'MinCoverage',
  'MaxCoverage',
]);

/** Node kinds whose breach is a statement about WHO may work a shift. */
const ELIGIBILITY_KINDS: ReadonlySet<string> = new Set([
  'RequiresQualification',
  'MemberOfStaffGroup',
  'ValidGroupRestriction',
  'PickPositionRestriction',
]);

/**
 * An independently measured HARD finding → its class.
 *
 * A `not-evaluable` finding is `hard-breach` regardless of kind, per FAD-27:
 * "this HARD rule cannot be checked, so this version cannot be asserted to
 * satisfy it". Filing it under the kind's own class would report an unchecked
 * coverage rule as a coverage shortfall — a specific claim about demand that
 * nobody measured.
 */
export function conflictClassOfViolation(input: {
  readonly finding: 'breach' | 'not-evaluable';
  readonly nodeKind: string;
}): ConflictClass {
  if (input.finding === 'not-evaluable') return 'hard-breach';
  if (COVERAGE_KINDS.has(input.nodeKind)) return 'unmet-demand';
  if (ELIGIBILITY_KINDS.has(input.nodeKind)) return 'eligibility-failure';
  return 'hard-breach';
}

/**
 * An independent-checker rejection → its class.
 *
 * The three integrity rejections (`input-hash-mismatch`, `unknown-reference`,
 * `duplicate-assignment`) and the dropped-pin rejection are `hard-breach`: each
 * one means the candidate is not a well-formed answer to the problem that was
 * posed, which is strictly worse than a schedule that breaks a rule.
 */
export function conflictClassOfRejection(reason: string): ConflictClass {
  if (reason === 'ineligible-assignment') return 'eligibility-failure';
  return 'hard-breach';
}

/**
 * A T0 structural finding → its class.
 *
 * The codes are the worker's own closed set (`cpsat_adapter.structural_findings`).
 * An unrecognised code lands in `hard-breach` rather than being dropped: an
 * unclassifiable finding is still a finding, and losing it would be the silent
 * skip SPEC-04 §3.3 forbids in its own domain.
 */
export function conflictClassOfStructuralFinding(code: string): ConflictClass {
  if (code === 'no_eligible_member') return 'eligibility-failure';
  if (code === 'eligible_capacity_below_demand') return 'unmet-demand';
  if (code === 'day_demand_exceeds_participants') return 'unmet-demand';
  if (code === 'conflicting_fixed_assignments') return 'hard-breach';
  return 'hard-breach';
}

/**
 * A demand shortfall measured on a COMPLETED build → `unmet-demand`.
 *
 * Returns `null` when demand was fully satisfied or when the rate is not
 * measurable (no required slots). `null` rather than a zero-count conflict,
 * because "nothing was asked for" and "everything asked for was delivered" are
 * both non-events and neither is a conflict to render.
 */
export function conflictClassOfDemandShortfall(
  demandSatisfactionRate: number | null,
): ConflictClass | null {
  if (demandSatisfactionRate === null) return null;
  return demandSatisfactionRate < 1 ? 'unmet-demand' : null;
}
