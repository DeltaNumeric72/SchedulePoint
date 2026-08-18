/**
 * **The E2 objective: one integer scale, one tier profile, both recorded**
 * (OPUS-M4-004; doc 08 §3.3 and §3.4, SPEC-04 §4).
 *
 * ## §3.4, executed: the scaling factor is decided ONCE
 *
 * > CP-SAT constraints must be expressed over integers; non-integer terms
 * > require scaling. **Decide the scaling factor once, globally, and document
 * > it** — a per-rule ad-hoc choice produces objective terms that are not
 * > comparable, which silently corrupts every trade-off the solver makes.
 *
 * E1 had exactly that defect, and it was invisible: the model computed a rule's
 * contribution as `int(float(weight))`, which **truncates**. A SOFT rule
 * authored at weight `0.5` therefore contributed *nothing at all* — not less,
 * nothing — and the schedule that came back looked exactly like one where the
 * rule had been honoured and simply lost. {@link scaleWeight} is now the only
 * way a weight becomes an integer, and it rounds at a single documented
 * precision.
 *
 * ## Why the constant lives HERE and how the worker cannot drift from it
 *
 * The domain package imports nothing, so this file cannot hash itself and the
 * Python worker cannot import it. The agreement is therefore made *checkable*
 * rather than assumed, by the same device the status vocabulary uses:
 *
 *  1. this module is the one authority — {@link OBJECTIVE_SCALE} and
 *     {@link E2_OBJECTIVE_PROFILE} are declared once;
 *  2. {@link objectiveProfileCanonicalString} renders the profile in a form the
 *     worker's `canonical_dumps` reproduces **byte for byte** (sorted keys, no
 *     whitespace, integers only — there is deliberately no float in the
 *     profile, because `1.0` and `1` do not render alike across the two
 *     runtimes);
 *  3. the platform digests that string, the worker digests its own mirror, and
 *     the worker **echoes its digest on every response**. A mismatch is a
 *     refusal class, not a warning — a result computed under a different
 *     objective is a result for a different question.
 *
 * So "single-sourced" is not a claim about where the number is typed. It is a
 * property a red case can falsify: change the factor in one place and the
 * digests part company at the first solve.
 *
 * ## Tiers are WEIGHTED, and this file does not claim they are lexicographic
 *
 * CP-SAT minimises one expression. The tier weights below order the classes by
 * magnitude; they do **not** guarantee that any amount of a lower tier is
 * outranked by any amount of a higher one, and no surface says they do. A
 * lexicographic objective is a different construction (staged solves with the
 * previous tier frozen), it costs a solve per tier, and promising it here while
 * implementing a weighted sum would be the kind of confident-sounding claim
 * SPEC-04 §5 spends a whole section refusing to make.
 *
 * The ORDER is E1's, preserved deliberately: fairness above target adherence
 * above preference. E2 makes it explicit and records it; it does not re-rank it,
 * because a silent re-ranking would change every schedule the engine has
 * produced so far with nothing in the record to say why.
 */

/**
 * The global integer scaling factor — doc 08 §3.4's "e.g. weights and
 * percentages scaled by 10⁴", adopted as the decision.
 *
 * 10⁴ is four decimal places of a rule weight. It is far more precision than any
 * authored weight needs and small enough that a tier weight of 100, a rule
 * weight of 100, and tens of thousands of terms stay eight orders of magnitude
 * inside int64.
 */
export const OBJECTIVE_SCALE = 10_000;

/**
 * **The one converter.** A rule's authored weight, as the integer the model
 * uses.
 *
 * Throws rather than coercing. A non-finite weight reaching an objective is a
 * defect upstream, and `NaN` silently becoming `0` is the same failure mode as
 * the truncation this replaces — a rule that is present in every listing and
 * absent from the objective.
 */
export function scaleWeight(weight: number): number {
  if (!Number.isFinite(weight)) {
    throw new Error('Cannot scale a non-finite objective weight.');
  }
  return Math.round(weight * OBJECTIVE_SCALE);
}

/** The SOFT-natural kinds an E2 tier may contain. Strings, not the AST union, so
 * this file stays readable beside the worker's mirror of the same table. */
export interface ObjectiveTierSpec {
  /** 1 is the highest-magnitude class. Stable; never renumbered (rule 13). */
  readonly rank: number;
  /** The stable key. The UI's wording table is keyed by it. */
  readonly key: string;
  /** The multiplier applied to every scaled rule weight in this tier. */
  readonly tierWeight: number;
  /** The node kinds whose SOFT authorings land in this tier, sorted. */
  readonly kinds: readonly string[];
}

/**
 * The tier a SOFT rule of an unmapped kind is REPORTED in.
 *
 * It contributes nothing — `tierWeight` is 0 and it holds no terms — and it
 * exists so that "this SOFT rule was not modelled" is a line in the recorded
 * objective rather than an absence. A SOFT rule is not a promise, so omitting
 * one costs quality rather than correctness; omitting it *silently* costs the
 * scheduler the ability to know that.
 */
export const UNMAPPED_SOFT_TIER_KEY = 'unmapped-soft';
export const UNMAPPED_SOFT_TIER_RANK = 99;

/**
 * **The objective profile of record.**
 *
 * `profileId` is a stable identifier and a new one is minted whenever any weight
 * or membership below changes — two results are comparable only under the same
 * profile, and a profile that mutated under a fixed id would make every stored
 * objective value silently incomparable with every other.
 */
export const E2_OBJECTIVE_PROFILE = {
  profileId: 'e2-default-v1',
  scale: OBJECTIVE_SCALE,
  tiers: [
    {
      rank: 1,
      key: 'fairness',
      tierWeight: 100,
      kinds: ['CreditDistribution', 'FairnessBalance'],
    },
    {
      rank: 2,
      key: 'work-percentage',
      tierWeight: 10,
      kinds: ['WorkPercentageTarget'],
    },
    {
      rank: 3,
      key: 'preference',
      tierWeight: 1,
      kinds: ['AvoidDate', 'ShiftPreference'],
    },
  ] as const satisfies readonly ObjectiveTierSpec[],
} as const;

export type ObjectiveProfile = typeof E2_OBJECTIVE_PROFILE;

/** The tier a SOFT node kind belongs to, or `null` when none does. */
export function objectiveTierOf(kind: string): ObjectiveTierSpec | null {
  for (const tier of E2_OBJECTIVE_PROFILE.tiers) {
    /* Widened deliberately: `kinds` is a literal tuple, so `includes` would
     * otherwise only accept one of its own members — which would make this
     * function answerable for kinds it is meant to answer `null` for. */
    if ((tier.kinds as readonly string[]).includes(kind)) return tier;
  }
  return null;
}

/**
 * The profile, rendered exactly as the worker renders its mirror.
 *
 * Key order is `Object.keys(...).sort()` on both sides and every value is an
 * integer or an ASCII string, so `JSON.stringify` and
 * `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=True)` produce
 * the same bytes. The digest over this string is what the two runtimes compare.
 */
export function objectiveProfileCanonicalString(): string {
  /* Hand-rolled rather than routed through `canonicalStringify` so that the
   * shape crossing the language boundary is visible in one place and cannot
   * change as a side effect of a serializer edit. The two are asserted equal by
   * `e2-objective-and-quality.test.ts`. */
  /* Key order is `"key"` before `"kinds"` because that is what BOTH sides'
   * sorts produce — `'e' < 'i'` at the third character — and the digest is over
   * bytes, not over intent. Getting this backwards is the whole class of bug the
   * echoed digest exists to catch, and it was caught here first. */
  const tiers = E2_OBJECTIVE_PROFILE.tiers.map(
    (tier) =>
      `{"key":${JSON.stringify(tier.key)},` +
      `"kinds":[${tier.kinds.map((kind) => JSON.stringify(kind)).join(',')}],` +
      `"rank":${String(tier.rank)},` +
      `"tierWeight":${String(tier.tierWeight)}}`,
  );
  return (
    `{"profileId":${JSON.stringify(E2_OBJECTIVE_PROFILE.profileId)},` +
    `"scale":${String(E2_OBJECTIVE_PROFILE.scale)},` +
    `"tiers":[${tiers.join(',')}]}`
  );
}

/**
 * One recorded objective component: a rule, and the integer weight it actually
 * carried into the model.
 *
 * The SCALED weight rather than the authored one, because the scaled weight is
 * what the objective value is made of. An authored `0.5` that became `5000` and
 * an authored `0.5` that became `0` are the same line in a rule listing and
 * different facts about a result.
 */
export interface ObjectiveComponentRecord {
  readonly ruleKey: string;
  readonly scaledWeight: number;
}

/** One recorded tier of a completed solve — the response's and the row's shape. */
export interface ObjectiveTierRecordShape {
  readonly tier: number;
  readonly name: string;
  readonly weightScale: number;
  readonly scale: number;
  readonly ruleKeys: readonly string[];
  readonly components: readonly ObjectiveComponentRecord[];
  readonly unmappedRuleKeys: readonly string[];
  readonly termCount: number;
}

/**
 * **Comparability, decided in one place** (doc 35 §6f required behaviour 1).
 *
 * > two results are comparable iff same snapshot + same weights, and the
 * > comparison service enforces exactly that.
 *
 * Both halves are necessary and neither is sufficient. Two candidates for the
 * same problem under different weights are answers to different questions; two
 * candidates under the same weights for different problems are answers about
 * different periods. Either way the comparison would put two numbers in one
 * column and invite a scheduler to read the smaller one as better.
 */
export type ComparabilityVerdict =
  | { readonly comparable: true }
  | { readonly comparable: false; readonly reason: 'cross-snapshot' | 'weights-differ' };

export interface ComparableResultFacts {
  /** The canonical input hash the result was produced against. */
  readonly canonicalInputHash: string | null;
  /** The digest of the objective profile the result was produced under. */
  readonly objectiveWeightsDigest: string | null;
}

/**
 * Are these results comparable? `false` names WHICH half failed.
 *
 * A `null` on either side is treated as *not* comparable rather than as a
 * wildcard: an unrecorded hash or an unrecorded profile is exactly the case
 * where nobody can tell, and "cannot tell" must not read as "yes".
 */
export function resultsAreComparable(
  results: readonly ComparableResultFacts[],
): ComparabilityVerdict {
  if (results.length < 2) return { comparable: true };
  const [first, ...rest] = results as [ComparableResultFacts, ...ComparableResultFacts[]];
  for (const other of rest) {
    if (
      first.canonicalInputHash === null ||
      other.canonicalInputHash === null ||
      first.canonicalInputHash !== other.canonicalInputHash
    ) {
      return { comparable: false, reason: 'cross-snapshot' };
    }
  }
  for (const other of rest) {
    if (
      first.objectiveWeightsDigest === null ||
      other.objectiveWeightsDigest === null ||
      first.objectiveWeightsDigest !== other.objectiveWeightsDigest
    ) {
      return { comparable: false, reason: 'weights-differ' };
    }
  }
  return { comparable: true };
}
