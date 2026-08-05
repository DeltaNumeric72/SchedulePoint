import type { Candidate, CandidateList } from '@schedulepoint/contracts';

/**
 * The eligibility absent-vs-empty ruling, client half (OPUS-M3-004).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## The question this answers
 *
 * The cell editor asks the server who may be assigned. Three answers are
 * possible and only two of them are the same question:
 *
 * | Server says | Means | This offers |
 * |---|---|---|
 * | `eligibilityKnown: false` | the caller cannot see credentials at all | **every** candidate, marked "eligibility not shown" |
 * | `eligibilityKnown: true`, candidate `eligible: null` | no eligibility row for that member and shift type | that candidate, marked "eligibility not shown" |
 * | `eligibilityKnown: true`, candidate `eligible: false` | genuinely missing a required credential | that candidate, marked ineligible, with the count of what is missing |
 *
 * **ABSENT is never rendered as INELIGIBLE.** `staffing.qualification_holding.read`
 * is grant-only — no role carries it — so a plain scheduler's default experience
 * is the absent arm, and `qualification_holdings`' RLS predicate would otherwise
 * make every colleague look unqualified. Saying "this person is not qualified"
 * when the truth is "you cannot see whether they are" is a false statement about
 * a patient-safety-adjacent fact, produced entirely by an access-control
 * artefact.
 *
 * **EMPTY is not a block either.** When eligibility is known and nobody
 * qualifies, the editor still offers the roster behind an explicit override,
 * because this surface IS the override and recovery mechanism (non-bypass rule
 * 7, I-05) and eligibility here is a report rather than an enforcement point.
 * Enforcement against qualifications belongs to publication-time validation and
 * to the M4 engine, each computing with its own credential.
 *
 * ## Reversing the ruling is one edit
 *
 * This function is the only place the distinction is decided. A ratification
 * that went the other way — "absent must be treated as ineligible" — changes
 * `disposition` here and nothing else; the editor renders whatever it returns.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** What the editor may say about one candidate. Three values, never two. */
export type EligibilityDisposition = 'eligible' | 'ineligible' | 'unknown';

export interface CandidateOffer {
  readonly candidate: Candidate;
  readonly disposition: EligibilityDisposition;
  /** Rendered beside the name. Never colour-alone (SPEC-14). */
  readonly label: string;
  /**
   * Whether choosing this candidate requires the scheduler to record an
   * override reason. Only a KNOWN ineligibility does — an unknown one has
   * nothing to override.
   */
  readonly requiresOverrideReason: boolean;
}

export interface EligibilityOffer {
  readonly offers: readonly CandidateOffer[];
  /**
   * True when the credential-derived answer is unavailable for the whole call.
   * The editor renders a standing notice, in words, not a colour.
   */
  readonly eligibilityAbsent: boolean;
  /** True when eligibility is known and nobody qualifies — a different state. */
  readonly noneEligible: boolean;
  /** The sentence the editor shows above the list. Never "no data". */
  readonly notice: string | null;
}

const ABSENT_NOTICE =
  'Eligibility cannot be shown with your permissions. Check credentials before assigning.';
const NONE_ELIGIBLE_NOTICE =
  'Nobody in this group holds every credential this shift type requires. Assigning anyone here is an override and needs a reason.';

function dispositionOf(candidate: Candidate, eligibilityKnown: boolean): EligibilityDisposition {
  // The whole ruling. `null` is UNKNOWN, and unknown is not "no".
  if (!eligibilityKnown || candidate.eligible === null) return 'unknown';
  return candidate.eligible ? 'eligible' : 'ineligible';
}

function labelOf(disposition: EligibilityDisposition, candidate: Candidate): string {
  if (disposition === 'unknown') return 'Eligibility not shown';
  if (disposition === 'eligible') return 'Eligible';
  const missing = candidate.missingQualificationIds.length;
  return missing === 1 ? 'Missing 1 credential' : `Missing ${String(missing)} credentials`;
}

export function decideEligibilityOffer(list: CandidateList): EligibilityOffer {
  const offers = list.candidates.map((candidate) => {
    const disposition = dispositionOf(candidate, list.eligibilityKnown);
    return {
      candidate,
      disposition,
      label: labelOf(disposition, candidate),
      requiresOverrideReason: disposition === 'ineligible',
    };
  });

  const eligibilityAbsent = !list.eligibilityKnown;
  const noneEligible =
    list.eligibilityKnown &&
    offers.length > 0 &&
    offers.every((offer) => offer.disposition !== 'eligible');

  return {
    offers,
    eligibilityAbsent,
    noneEligible,
    notice: eligibilityAbsent ? ABSENT_NOTICE : noneEligible ? NONE_ELIGIBLE_NOTICE : null,
  };
}
