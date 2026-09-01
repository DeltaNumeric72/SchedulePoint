import type {
  RequestReasonCodeWire,
  RequestStatusWire,
  RequestSubtypeWire,
} from '@schedulepoint/contracts';

/**
 * The words this product uses on the request surfaces (OPUS-M5-005).
 *
 * Three closed vocabularies, each rendered from the CONTRACT's enum rather than
 * from a list typed out here. That is the property that matters: every map below
 * is `Record<TheEnum, string>`, so adding a member to the contract makes this
 * file a type error rather than a silent gap where a raw wire token reaches a
 * screen. A `?? code` fallback would have hidden exactly that.
 *
 * The wording is the READER's, not the schema's. `submitted` is "Waiting for a
 * decision" because a member reading their own list wants to know whether
 * anybody has looked at it yet; `unsatisfied` is spelled out at length because
 * it is the one status a person will otherwise read as a refusal, and it is not
 * one.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * FAD-58.1's nine reason codes
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * **The nine, and there is no tenth.**
 *
 * `other` is TERMINAL: it means "no further statement", and it is a complete
 * answer. There is no "other, specify" field on this surface, in this file, or
 * anywhere else — that field would be FAD-58's free-text channel under another
 * name, and I-07 is not patient-scoped ("no patient-identifying information **or
 * clinical free text** enters the system"). A length bound bounds SIZE, not KIND.
 *
 * **The absence of a medical or sick code is the design, not a gap.** A
 * requester whose reason is medical selects `personal`, or `other`, and
 * discloses nothing; the scheduler learns that the request has a reason and does
 * not learn a diagnosis. A future packet must not add `medical`, `sick`,
 * `health`, `appointment` or any near-synonym — that needs a recorded decision
 * overturning FAD-58 first.
 *
 * The labels below are the codes said in plain words. They are deliberately NOT
 * invitations to elaborate: none of them ends in a colon, and none asks a
 * question.
 */
export const REASON_CODE_LABELS: Readonly<Record<RequestReasonCodeWire, string>> = {
  personal: 'Personal',
  family: 'Family',
  childcare: 'Childcare',
  bereavement: 'Bereavement',
  travel: 'Travel',
  education: 'Education',
  'religious-observance': 'Religious observance',
  'professional-obligation': 'Professional obligation',
  other: 'Other',
};

/**
 * The nine in the order the picker offers them — the contract's own order.
 *
 * Not alphabetical and not "most common first": the contract's enum order is the
 * one the domain constant and migration 0026's CHECK share, and re-ordering here
 * would make a fourth ordering that agrees with nothing.
 */
export const REASON_CODES: readonly RequestReasonCodeWire[] = [
  'personal',
  'family',
  'childcare',
  'bereavement',
  'travel',
  'education',
  'religious-observance',
  'professional-obligation',
  'other',
];

/* ────────────────────────────────────────────────────────────────────────────
 * The six subtypes
 * ──────────────────────────────────────────────────────────────────────────── */

export const SUBTYPE_LABELS: Readonly<Record<RequestSubtypeWire, string>> = {
  availability: 'Availability',
  'time-off': 'Time off',
  'no-call': 'No call',
  'shift-preference': 'Shift preference',
  'shift-group-off': 'Shift group off',
  'vacation-selection': 'Vacation week',
};

/**
 * The five a member submits on THIS surface.
 *
 * `vacation-selection` is absent, and its absence is a routing fact rather than
 * a narrowing: a vacation week is selected on the vacation round surface, where
 * the allowance, the weeks in the round and the §5.3 status mapping live. The
 * server agrees from the other side — the scheduler's queue skips vacation roots
 * for the same reason. Offering it here would produce a form that could name a
 * period id but could not show what selecting it costs.
 */
export const SUBMITTABLE_SUBTYPES: readonly Exclude<RequestSubtypeWire, 'vacation-selection'>[] = [
  'availability',
  'time-off',
  'no-call',
  'shift-preference',
  'shift-group-off',
];

/** What each subtype MEANS, in the requester's terms. Shown beside the choice. */
export const SUBTYPE_HELP: Readonly<Record<RequestSubtypeWire, string>> = {
  availability: 'A day you are available to be scheduled.',
  'time-off': 'A day, or a range of days, you are asking not to work.',
  'no-call': 'A day you are asking not to be placed on any on-call shift.',
  'shift-preference': 'A shift type you would prefer on a particular day.',
  'shift-group-off': 'A group of shifts you are asking to be left out of on a day.',
  'vacation-selection': 'A vacation week. Selected on the vacation round surface.',
};

/* ────────────────────────────────────────────────────────────────────────────
 * The thirteen statuses
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * **`applied` is absent because it never existed on the wire**, and the three
 * statuses that replaced it are told apart here rather than blurred back
 * together: `consumed_by_build` says a solver run took this as input and says
 * NOTHING about the outcome; `reflected_in_version` says a published version
 * honours it; `unsatisfied` says it was consumed and not honoured — **a normal
 * outcome for a soft preference, and not a denial.** The wording for
 * `unsatisfied` is long on purpose, because the short version reads as a refusal
 * and would make a person contest a decision nobody made.
 */
export const STATUS_LABELS: Readonly<Record<RequestStatusWire, string>> = {
  draft: 'Draft',
  submitted: 'Waiting for a decision',
  under_review: 'Being reviewed',
  accepted_as_input: 'Accepted as input to scheduling',
  approved: 'Approved',
  denied: 'Not approved',
  withdrawn: 'Taken back',
  consumed_by_build: 'Used when the schedule was built',
  reflected_in_version: 'On the published schedule',
  unsatisfied: 'Considered, but the schedule could not fit it',
  reversed: 'Reversed',
  expired: 'Expired — nobody decided in time',
  superseded_by_revision: 'Superseded by a later revision',
};

/**
 * The statuses a scheduler's queue filter offers.
 *
 * The server's own default is `submitted` + `under_review` — "a queue that
 * defaulted to every status would open on a list nobody can act on". These are
 * the states a decision can act FROM, plus the one a shift preference sits in,
 * and the surface offers exactly them rather than the full thirteen.
 */
export const QUEUE_STATUSES: readonly RequestStatusWire[] = [
  'submitted',
  'under_review',
  'accepted_as_input',
];

/** True for a status a requester may still take their request back from. */
export function isWithdrawable(status: RequestStatusWire): boolean {
  /* §2's matrix decides this and the server enforces it; this is the display
   * side, and it is deliberately a SUBSET rather than a restatement — a control
   * that is not offered can still be refused, but a control offered where the
   * server will refuse it is a promise the surface cannot keep. `reflected_in_version`
   * IS withdrawable (FAD-55's edge, which raises a revision request), and it is
   * included precisely because that is the case a member most needs. */
  return (
    status === 'submitted' ||
    status === 'under_review' ||
    status === 'accepted_as_input' ||
    status === 'approved' ||
    status === 'reflected_in_version'
  );
}
