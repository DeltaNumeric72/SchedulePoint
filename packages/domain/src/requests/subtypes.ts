/**
 * SPEC-08 §1.1, §1.2, §2 and §5.3 — the closed vocabularies of the request
 * aggregate, expressed once.
 *
 * **This module states DOMAINS, not TRANSITIONS.** D-20 asks "may this subtype's
 * row ever hold this status"; SPEC-08 §2's matrix asks "may it move from this
 * status to that one". They are different claims, only the first is here, and
 * the omission is deliberate: doc 42 §5b gives this packet the schema and the
 * types, and gives M5-001 the §2 matrices' domain half and the double
 * enforcement that goes with it. A half-written matrix living here would be the
 * thing M5-001 finds and trusts.
 *
 * Every constant below has a counterpart CHECK or function in
 * `apps/api/migrations/0021_request_aggregate_and_subtypes.sql` or
 * `apps/api/migrations/0022_vacation_lifecycle_carriers.sql`. The api test suite
 * asserts the two AGREE rather than assuming it — a constant and a CHECK that
 * drift produce a save which fails for no visible reason, which is the lesson
 * the shift-type catalogue records for exactly this pattern.
 */

/**
 * The six subtypes (§1, V-27 / FD-9 — `vacation-selection` is the sixth).
 *
 * `vacation-selection` is a subtype under D-18/D-19/D-20 **and** the carrier of a
 * distinct quota and commitment lifecycle. Both statements are true; §5.3's
 * mapping is what keeps the two consistent.
 */
export const REQUEST_SUBTYPES = [
  'availability',
  'time-off',
  'no-call',
  'shift-preference',
  'shift-group-off',
  'vacation-selection',
] as const;

export type RequestSubtype = (typeof REQUEST_SUBTYPES)[number];

/**
 * Every status any subtype can hold — the UNION, which is not a state machine
 * and is not a per-subtype domain.
 *
 * `applied` is absent, and its absence is the point (§2.1). It meant three
 * different things, and it has been split into the three facts it was
 * concealing: `consumed_by_build` (a solver run took this as input, saying
 * nothing about the outcome), `reflected_in_version` (a PUBLISHED version
 * honours it), and `unsatisfied` (consumed, not honoured — a normal reportable
 * outcome for a soft preference, and **not** a denial).
 */
export const REQUEST_STATUSES = [
  'draft',
  'submitted',
  'under_review',
  'accepted_as_input',
  'approved',
  'denied',
  'withdrawn',
  'consumed_by_build',
  'reflected_in_version',
  'unsatisfied',
  'reversed',
  'expired',
  'superseded_by_revision',
] as const;

export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/**
 * **D-20 — the per-subtype status domain.** Each entry is §2's column for that
 * subtype: every status appearing at either end of a permitted cell in it, and
 * no other.
 *
 * Three of these are worth reading rather than skimming:
 *
 *  - `shift-preference` has **no** `approved`, `denied` or `under_review`.
 *    Nobody approves a non-binding preference, so forcing it through
 *    `under_review → approved` would invent an approval that does not happen.
 *    SPEC-08 R-03 — a shift preference reaching `approved` — is refused by this
 *    domain and not only by the transition matrix, because an INSERT has no
 *    transition to refuse.
 *  - `unsatisfied` is `shift-preference`'s **alone**, for the same reason: no
 *    other subtype has a way to reach it.
 *  - `reversed` is `vacation-selection`'s **alone** (§5.6, V-27). Per-subtype
 *    domains are exactly what make that legal — a status may exist for one
 *    subtype and not for others, which is the whole point of having six domains
 *    rather than one enum.
 */
export const REQUEST_STATUSES_BY_SUBTYPE: {
  readonly [S in RequestSubtype]: readonly RequestStatus[];
} = {
  availability: [
    'draft',
    'submitted',
    'under_review',
    'accepted_as_input',
    'approved',
    'denied',
    'withdrawn',
    'consumed_by_build',
    'reflected_in_version',
    'expired',
    'superseded_by_revision',
  ],
  'time-off': [
    'draft',
    'submitted',
    'under_review',
    'approved',
    'denied',
    'withdrawn',
    'consumed_by_build',
    'reflected_in_version',
    'expired',
    'superseded_by_revision',
  ],
  'no-call': [
    'draft',
    'submitted',
    'under_review',
    'approved',
    'denied',
    'withdrawn',
    'consumed_by_build',
    'reflected_in_version',
    'expired',
    'superseded_by_revision',
  ],
  'shift-preference': [
    'draft',
    'submitted',
    'accepted_as_input',
    'withdrawn',
    'consumed_by_build',
    'reflected_in_version',
    'unsatisfied',
    'expired',
  ],
  'shift-group-off': [
    'draft',
    'submitted',
    'under_review',
    'approved',
    'denied',
    'withdrawn',
    'consumed_by_build',
    'reflected_in_version',
    'expired',
    'superseded_by_revision',
  ],
  'vacation-selection': [
    'draft',
    'submitted',
    'under_review',
    'approved',
    'denied',
    'withdrawn',
    'reflected_in_version',
    'reversed',
    'expired',
    'superseded_by_revision',
  ],
};

/**
 * The three states from which `expired` is reachable, and the only three
 * (V-31). The undecided ones.
 *
 * The superseded spelling was a literal `*`. As a database rule that permits
 * `reflected_in_version → expired` — expiring a request a published version
 * already honours — and `approved → expired`, which silently un-decides a
 * decision. SPEC-08 R-23 is those two attempts.
 *
 * Exported as data rather than folded into a predicate because this packet does
 * not own the transition predicate (see this module's header); the three source
 * states are a fact about §2 that M5-001's matrix must reproduce, and stating
 * them here is what lets a test hold M5-001 to it.
 */
export const EXPIRY_SOURCE_STATUSES = [
  'submitted',
  'under_review',
  'accepted_as_input',
] as const;

export type ExpirySourceStatus = (typeof EXPIRY_SOURCE_STATUSES)[number];

/**
 * `vacation_selections.status` — **the authoritative status** for a vacation
 * request (§5.3, V-27 / FD-9).
 *
 * `requests.status` for such a request is DERIVED from this one. Previously two
 * statuses existed with no stated relationship, so two rows could disagree about
 * whether a vacation request had been withdrawn and nothing would object. This
 * one is authoritative because it is the one the quota and commitment
 * transactions already write.
 */
export const VACATION_SELECTION_STATUSES = [
  'available',
  'pending',
  'approved',
  'committed',
  'denied',
  'withdrawn',
  'expired',
  'reversed',
] as const;

export type VacationSelectionStatus = (typeof VACATION_SELECTION_STATUSES)[number];

/**
 * **§5.3's mapping, and D-27's subject.** `null` for `available`, which is the
 * row reading "*no request row yet* — a selection becomes a request at
 * submission".
 *
 * The database holds the same mapping in
 * `app_vacation_derived_request_status(text)`, and D-27's deferred triggers
 * assert it from both sides of the pair at commit. This copy is not the
 * enforcement; it is what a caller consults to know what to write, and what a
 * test compares the database's copy against.
 */
export const VACATION_STATUS_TO_REQUEST_STATUS: {
  readonly [S in VacationSelectionStatus]: RequestStatus | null;
} = {
  available: null,
  pending: 'submitted',
  approved: 'approved',
  committed: 'reflected_in_version',
  denied: 'denied',
  withdrawn: 'withdrawn',
  expired: 'expired',
  reversed: 'reversed',
};

/**
 * The root status a vacation selection in `status` requires, or `null` when the
 * selection has no request row yet.
 *
 * A function rather than only the record above, because the caller that matters
 * — the one writing both rows in one transaction — is asking a question, and a
 * lookup expression at every call site is a lookup expression somebody will
 * eventually get wrong in one place.
 */
export function derivedRequestStatus(status: VacationSelectionStatus): RequestStatus | null {
  return VACATION_STATUS_TO_REQUEST_STATUS[status];
}

/**
 * D-20, as a predicate. Whether `status` is in `subtype`'s domain at all.
 *
 * **Not** whether a transition into it is legal — see this module's header. A
 * status this returns `true` for may still be unreachable from where a row
 * currently stands, and for `vacation-selection` three of them are unreachable
 * from anywhere: `draft`, `under_review` and `superseded_by_revision` are in
 * §2's vacation column but are produced by no `vacation_selections.status`
 * under §5.3, so D-27 refuses them even though D-20 admits them. That tension is
 * SPEC-08's, is documented in
 * `apps/api/migrations/0022_vacation_lifecycle_carriers.sql` §2, and is not
 * resolved here.
 */
export function statusIsInSubtypeDomain(subtype: RequestSubtype, status: RequestStatus): boolean {
  return REQUEST_STATUSES_BY_SUBTYPE[subtype].includes(status);
}

/**
 * The three-value ordered strength of a shift-preference REQUEST (§1.2, §6).
 *
 * ## Provenance — a declared decision taken at latitude
 *
 * SPEC-08 §1.2 and doc 06 §3.4 both NAME `preference_strength` and NEITHER
 * states its type, so there is no specified spelling to follow. §6's projection
 * row is `SoftPreference(membership, date, shift_type, strength)`, which needs an
 * ORDERED strength and nothing finer. Three ordered values is the smallest thing
 * that carries that distinction, and a closed set cannot acquire a `7` that no
 * objective term knows how to weigh — which an integer column would. The mapping
 * from these values to solver weights is M5-004's and is deliberately absent.
 *
 * ## Why it is NOT `rules`' `PREFERENCE_STRENGTHS`, and why the name says so
 *
 * `./rules/ast.ts` already exports `PREFERENCE_STRENGTHS` as
 * `['strong_prefer', 'prefer', 'avoid', 'strong_avoid']`, and the two are
 * genuinely different vocabularies:
 *
 *  - that one is a SIGNED strength on a typed scheduling-RULE node — a
 *    configured policy term, four values, with a direction;
 *  - this one is an UNSIGNED strength on a PERSON'S stated preference — three
 *    values, ordered, with no direction, because SPEC-08 gives a shift-preference
 *    request no way to express avoidance and inventing one here would import a
 *    dimension the specification does not have.
 *
 * Reusing the rules vocabulary would collapse a policy weight and a person's
 * wish into one type, and would make M5-004's projection mapping look like an
 * identity when it is a real decision. So the name is qualified rather than
 * shared — the collision was a compile error, and the honest fix for a compile
 * error between two different concepts is two names.
 */
export const REQUEST_PREFERENCE_STRENGTHS = ['low', 'medium', 'high'] as const;

export type RequestPreferenceStrength = (typeof REQUEST_PREFERENCE_STRENGTHS)[number];

/** §5.2 — what a vacation grant is a grant OF. */
export const VACATION_GRANT_KINDS = ['personal-entitlement', 'weekly-capacity'] as const;

export type VacationGrantKind = (typeof VACATION_GRANT_KINDS)[number];

/** §5.2 / §5.5 (V-30) — `quota` has grant rows; `open` has none. */
export const VACATION_PERIOD_MODES = ['quota', 'open'] as const;

export type VacationPeriodMode = (typeof VACATION_PERIOD_MODES)[number];

/** The lifecycle state of the round itself, distinct from any selection's. */
export const VACATION_PERIOD_STATES = ['draft', 'open', 'closed', 'archived'] as const;

export type VacationPeriodState = (typeof VACATION_PERIOD_STATES)[number];

/**
 * §5.4's recorded outcomes for an approval command.
 *
 * `quota_exhausted` and `version_conflict` are separate members because they are
 * different facts about a failed approval: one says the allowance is spent, the
 * other says somebody else moved first. `selection_not_pending` is V-29's
 * addition — the guard that stops a duplicate or retried approval consuming a
 * second unit.
 */
export const VACATION_APPROVAL_OUTCOMES = [
  'approved',
  'denied',
  'quota_exhausted',
  'version_conflict',
  'selection_not_pending',
] as const;

export type VacationApprovalOutcome = (typeof VACATION_APPROVAL_OUTCOMES)[number];
