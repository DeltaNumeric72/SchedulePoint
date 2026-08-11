import {
  containsInstant,
  parseInstant,
  ELIGIBLE_HOLDING_STATUSES,
  type EffectiveDated,
} from '../profiles/in-force.js';

/**
 * **The one eligibility verdict** (OPUS-M4-000A; doc 34 §4-B).
 *
 * Manual scheduling, publication-time validation, and — from M4-001 — solver
 * input assembly and independent output validation all ask the same question:
 * *may this membership work this shift type on this date?* Before this module
 * each surface answered it with its own arithmetic over the same rows, which
 * is the S-01 shape one layer up: two answers written in good faith at their
 * own call sites, waiting to disagree.
 *
 * This is a PURE function over plain data. No clock, no database, no I/O. The
 * instant is a parameter with no default (CAP-058: eligibility is evaluated at
 * the shift date, never at request time), and the deterministic-input ruling
 * (S-03) holds by construction: the caller selects the rows in force at the
 * build instant through the one loader, and the verdict is a function of
 * exactly what it was handed.
 *
 * ## The five distinct non-satisfied outcomes, and the pinned precedence
 *
 * The packet requires DISTINCT functional outcomes for expired / future /
 * revoked / retired / missing. The classification rules, authored here for
 * FAD ratification and test-pinned in
 * `packages/domain/test/eligibility/verdict.test.ts`:
 *
 *   1. **`retired`** — the qualification itself is retired. Evaluated FIRST,
 *      before any holding: retirement is the group withdrawing the credential
 *      definition, and a withdrawn definition confers nothing even where an
 *      in-window holding exists (fail-closed, the FAD-27 direction). Existing
 *      holdings are retained and readable; this outcome is what "their verdict
 *      reflects retirement" means.
 *   2. **`satisfied`** — some holding's half-open window `[from, until)`
 *      contains the instant AND its status confers
 *      (`ELIGIBLE_HOLDING_STATUSES`: `valid`, `expiring`).
 *   3. **`missing`** — the membership has no holding of the qualification at
 *      all. Distinct from every dated outcome: "never credentialed" and
 *      "credential lapsed" are different administrative facts.
 *   4. **`revoked`** — no holding confers and at least one is revoked,
 *      whatever its window. Revocation is the loudest fact about a
 *      credential and takes precedence over every dated classification.
 *   5. **`expired`** — no holding confers, none is revoked, and at least one
 *      holding's window has been reached and passed (or its status says
 *      `expired`). The boundary is half-open: a holding valid **until** the
 *      instant is already OUT at that instant.
 *   6. **`future`** — every classifiable holding lies ahead of the instant
 *      (window not yet begun), or is recorded but not yet in force
 *      administratively (`pending` inside its window). A renewal already
 *      issued is the ordinary shape of this outcome.
 *
 * Aggregate precedence across several non-conferring holdings:
 * `revoked` > `expired` > `future`. A holding whose bounds cannot be parsed
 * is ignored entirely (it can neither confer nor place the instant), which is
 * the fail-closed direction — if every holding is unparsable the outcome is
 * `missing`.
 *
 * ## Absence is not ineligibility (FAD-23)
 *
 * Nothing here decides what a CALLER may see. The three-state display ruling
 * (absent / eligible / ineligible-with-reason) is the consuming surface's:
 * a consumer that cannot read the holdings must report eligibility ABSENT,
 * never feed an empty array into this function and render the resulting
 * `missing` as a verdict about the member. The membership and work-profile
 * dimensions carry an explicit `not-evaluated` arm for the same reason —
 * an input the caller did not supply never manufactures an ineligibility.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Inputs
 * ──────────────────────────────────────────────────────────────────────────── */

/** A credential holding, as the verdict needs it. The loader maps columns onto this. */
export interface VerdictHolding extends EffectiveDated {
  readonly qualificationId: string;
  readonly status: string;
}

export type QualificationLifecycle = 'active' | 'retired';

export interface EligibilityInput {
  /**
   * The ACTIVE requirement edge for the shift type
   * (`shift_type_qualifications.status = 'active'`). Archived requirements are
   * history, not requirements.
   */
  readonly requiredQualificationIds: readonly string[];
  /** Every holding of the membership the caller can see, all statuses, all windows. */
  readonly holdings: readonly VerdictHolding[];
  /**
   * Lifecycle of every qualification named by a requirement. A requirement
   * whose qualification is missing from this map is treated as RETIRED —
   * fail-closed, because an unresolvable requirement must not silently pass.
   */
  readonly qualificationLifecycles: ReadonlyMap<string, QualificationLifecycle>;
  /** The membership's state, or `null` when the caller is not evaluating it. */
  readonly membershipState?: 'invited' | 'active' | 'suspended' | 'ended' | null;
  /** Whether a work profile is in force at the instant, or `null` when not evaluated. */
  readonly workProfileInForce?: boolean | null;
  /** The instant eligibility is evaluated at — the shift date's instant, never "now". */
  readonly at: Date;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Outcomes
 * ──────────────────────────────────────────────────────────────────────────── */

export const QUALIFICATION_OUTCOMES = [
  'satisfied',
  'missing',
  'expired',
  'future',
  'revoked',
  'retired',
] as const;
export type QualificationOutcome = (typeof QUALIFICATION_OUTCOMES)[number];

export interface QualificationVerdict {
  readonly qualificationId: string;
  readonly outcome: QualificationOutcome;
}

export type MembershipVerdict =
  | 'eligible'
  | 'invited'
  | 'suspended'
  | 'ended'
  /** The caller did not supply the membership state. NEVER treated as ineligible. */
  | 'not-evaluated';

export type WorkProfileVerdict = 'in-force' | 'none' | 'not-evaluated';

export interface EligibilityVerdict {
  /**
   * Every requirement's outcome, in the caller's requirement order with
   * duplicates removed — a deterministic function of the input set.
   */
  readonly qualifications: readonly QualificationVerdict[];
  /** `true` iff every requirement is `satisfied`. Vacuously true with no requirements. */
  readonly qualificationsSatisfied: boolean;
  readonly membership: MembershipVerdict;
  /**
   * REPORTED, not blocking: a member without a profile row is still
   * assignable — staffing limits are rule- and solver-side concerns. Carried
   * so solver input (M4-001) and displays receive the fact through the same
   * verdict instead of re-deriving it.
   */
  readonly workProfile: WorkProfileVerdict;
  /**
   * The one boolean the consumers act on: every requirement satisfied AND the
   * membership is not known-ineligible. `not-evaluated` never blocks (FAD-23's
   * absence discipline); `invited`, `suspended` and `ended` do.
   */
  readonly eligible: boolean;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Classification
 * ──────────────────────────────────────────────────────────────────────────── */

/** Statuses that mark a holding revoked, whatever its window. */
const REVOKED_STATUS = 'revoked';
/** A stored status that says the credential lapsed, whatever the window says. */
const EXPIRED_STATUS = 'expired';
/** Recorded but not administratively in force yet. */
const PENDING_STATUS = 'pending';

/**
 * The outcome for ONE required qualification.
 *
 * Exported on its own because the property tests pin each rule directly, and
 * because a consumer that already knows its requirement (the publication
 * checker walking assignments) asks per-qualification.
 */
export function qualificationOutcome(
  qualificationId: string,
  lifecycle: QualificationLifecycle | undefined,
  holdings: readonly VerdictHolding[],
  at: Date,
): QualificationOutcome {
  // Rule 1: a retired — or unresolvable — qualification confers nothing.
  // Fail-closed: `undefined` means the requirement names something the caller
  // could not resolve, and "cannot resolve" must never read as "satisfied".
  if (lifecycle !== 'active') return 'retired';

  const forQualification = holdings.filter((holding) => holding.qualificationId === qualificationId);

  // Rule 2: any in-window holding with a conferring status satisfies.
  if (
    forQualification.some(
      (holding) =>
        containsInstant(holding, at) &&
        (ELIGIBLE_HOLDING_STATUSES as readonly string[]).includes(holding.status),
    )
  ) {
    return 'satisfied';
  }

  // Rule 3: never credentialed at all.
  if (forQualification.length === 0) return 'missing';

  // Rule 4: revocation outranks every dated classification.
  if (forQualification.some((holding) => holding.status === REVOKED_STATUS)) return 'revoked';

  // Rules 5/6: classify each remaining holding by where its window puts the
  // instant, then aggregate `expired` over `future`. Unparsable rows are
  // ignored (they can neither confer nor place the instant).
  let sawExpired = false;
  let sawFuture = false;
  const instant = at.getTime();
  for (const holding of forQualification) {
    if (holding.status === EXPIRED_STATUS) {
      sawExpired = true;
      continue;
    }
    const from = parseInstant(holding.effectiveFrom);
    if (from === null) continue;
    if (from > instant) {
      sawFuture = true;
      continue;
    }
    if (holding.status === PENDING_STATUS && containsInstant(holding, at)) {
      // Recorded, window reached, not yet administratively in force.
      sawFuture = true;
      continue;
    }
    const to = holding.effectiveTo === null ? null : parseInstant(holding.effectiveTo);
    if (to !== null && instant >= to) {
      // The half-open boundary: valid UNTIL the instant is OUT at the instant.
      sawExpired = true;
    }
  }
  if (sawExpired) return 'expired';
  if (sawFuture) return 'future';
  return 'missing';
}

/** The membership dimension. `null`/`undefined` input is `not-evaluated`, never a block. */
function membershipVerdict(state: EligibilityInput['membershipState']): MembershipVerdict {
  if (state === null || state === undefined) return 'not-evaluated';
  if (state === 'active') return 'eligible';
  return state;
}

/**
 * The verdict. Deterministic, order-independent in `holdings`, and dependent
 * only on the input values — asserted directly by the property tests.
 */
export function evaluateEligibility(input: EligibilityInput): EligibilityVerdict {
  const requirementIds = [...new Set(input.requiredQualificationIds)];
  const qualifications = requirementIds.map((qualificationId) => ({
    qualificationId,
    outcome: qualificationOutcome(
      qualificationId,
      input.qualificationLifecycles.get(qualificationId),
      input.holdings,
      input.at,
    ),
  }));

  const qualificationsSatisfied = qualifications.every(
    (verdict) => verdict.outcome === 'satisfied',
  );
  const membership = membershipVerdict(input.membershipState);
  const workProfile: WorkProfileVerdict =
    input.workProfileInForce === null || input.workProfileInForce === undefined
      ? 'not-evaluated'
      : input.workProfileInForce
        ? 'in-force'
        : 'none';

  return {
    qualifications,
    qualificationsSatisfied,
    membership,
    workProfile,
    eligible:
      qualificationsSatisfied && (membership === 'eligible' || membership === 'not-evaluated'),
  };
}
