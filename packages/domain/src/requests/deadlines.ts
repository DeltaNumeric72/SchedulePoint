/**
 * SPEC-08 §3 — deadlines, the weekend/holiday roll, and late submission
 * (OPUS-M5-001, doc 42 §5c Part B).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## What §3 actually asks for
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * | Rule | Design |
 * |---|---|
 * | Server-side only | `expires_at` computed server-side from the group's `request_until_date` policy at submission. **A client-side deadline is not a deadline** |
 * | Re-validated at every transition | Not only at submission |
 * | Weekend and holiday policy | `deadline_rolls ∈ {forward, backward, exact}` against a group **holiday calendar** (`group_holidays`) |
 * | Late submission | Rejected with the effective deadline stated, **or** accepted into `submitted` with `is_late = true` where group policy permits — configured, never implicit |
 *
 * Everything in this file is the PURE half: given a policy, a calendar and a
 * date, what is the effective deadline and is a submission late. The impure half
 * — reading the group's row, reading `group_holidays`, knowing what time it is —
 * is `apps/api/src/requests/deadlines.ts`, because `packages/domain` imports
 * NOTHING and in particular has no clock. **A deadline calculator with a clock
 * inside it is a deadline calculator you cannot test at a boundary**, and every
 * interesting case here is a boundary.
 *
 * ## Why the roll is a policy and not a default
 *
 * SPEC-08's own words: *"Explicit, because 'the deadline is Friday' is ambiguous
 * when Friday is a holiday."* The ambiguity is real and it is not resolvable by
 * picking a sensible-looking default: rolling FORWARD off a holiday gives people
 * more time, rolling BACKWARD gives them less, and a group that has published
 * "requests close on the 15th" to its staff means one of those two and not the
 * other. `exact` is the third answer — the calendar is irrelevant, the date is
 * the date — and it is a real answer rather than "no policy configured", which
 * is why it is a value rather than a NULL.
 *
 * ## Weekend AND holiday, not holiday alone
 *
 * §3 names the rule "**Weekend and holiday policy**" and then names
 * `group_holidays` as the calendar. Both halves are implemented: a non-working
 * day is a Saturday, a Sunday, or a date in `group_holidays`. Treating only the
 * holiday calendar would leave "the deadline is the 15th" ambiguous every time
 * the 15th is a Sunday — the identical ambiguity, with no configuration
 * available to resolve it, and a group would have to enter every weekend of the
 * year as a holiday to get the behaviour §3's own title promises.
 */

import { addDays, dayOfWeek, type CalendarDate } from '../calendar/calendar-date.js';

/* ────────────────────────────────────────────────────────────────────────────
 * The policy vocabularies
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * §3's `deadline_rolls ∈ {forward, backward, exact}`.
 *
 *  - `forward` — a deadline landing on a non-working day moves to the next
 *    working day. **The staff-generous reading**: nobody loses a day because the
 *    office was shut.
 *  - `backward` — it moves to the previous working day. The scheduler-generous
 *    reading: the window closes before the break rather than after it, so the
 *    build is not waiting on a request that arrives during a holiday.
 *  - `exact` — the date is the date. Not "no policy": a deliberate statement that
 *    the calendar does not move this deadline.
 */
export const DEADLINE_ROLLS = ['forward', 'backward', 'exact'] as const;

export type DeadlineRoll = (typeof DEADLINE_ROLLS)[number];

/**
 * §3's late-submission behaviour — **configured, never implicit**.
 *
 *  - `reject` — a submission after the effective deadline is refused, and the
 *    refusal STATES the effective deadline (§3's own words). A refusal that will
 *    not say what the deadline was is a refusal the requester cannot act on.
 *  - `accept_as_late` — the submission is accepted into `submitted` and the row
 *    carries `is_late = true`, so the scheduler sees which requests arrived after
 *    the window and can weigh them accordingly.
 *
 * There is no third value meaning "whatever seems reasonable". SPEC-08 says
 * "configured, never implicit", and a two-value closed set with no default that
 * silently applies is what that sentence is asking for. The database column
 * carries `reject` as its DEFAULT for existing rows, which is a migration
 * necessity rather than a policy preference — and it is the SAFE direction: a
 * group that has not chosen gets the strict behaviour, not the permissive one.
 */
export const LATE_SUBMISSION_POLICIES = ['reject', 'accept_as_late'] as const;

export type LateSubmissionPolicy = (typeof LATE_SUBMISSION_POLICIES)[number];

/**
 * The group's request-until policy, as migration 0010 spells it — a discriminated
 * triple, not a nullable date.
 *
 * 0010's reasoning, which this file consumes rather than re-litigates: a single
 * nullable date expresses "closed" and "never configured" as the same value, and
 * "a group that has deliberately closed its window and a group nobody has
 * configured must not be the same row, because the first is a decision and the
 * second is a gap."
 */
export type RequestUntilPolicy =
  | { readonly mode: 'closed' }
  | { readonly mode: 'fixed_date'; readonly until: CalendarDate }
  | { readonly mode: 'days_before_period_start'; readonly leadDays: number };

/** The whole of a group's §3 configuration, as the computation needs it. */
export interface GroupDeadlinePolicy {
  readonly requestUntil: RequestUntilPolicy;
  readonly deadlineRolls: DeadlineRoll;
  readonly lateSubmission: LateSubmissionPolicy;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Non-working days and the roll
 * ──────────────────────────────────────────────────────────────────────────── */

const SATURDAY = 6;
const SUNDAY = 0;

/**
 * Whether `date` is a non-working day for a group whose holiday calendar is
 * `holidays`.
 *
 * `holidays` is a set of `YYYY-MM-DD` strings — the group's `group_holidays`
 * rows, which have existed since migration 0005. This packet lands the POLICY
 * that reads them, correcting doc 42 §5b's imprecision about where the table
 * arrives.
 */
export function isNonWorkingDay(date: CalendarDate, holidays: ReadonlySet<CalendarDate>): boolean {
  if (holidays.has(date)) return true;
  const day = dayOfWeek(date);
  return day === SATURDAY || day === SUNDAY;
}

/**
 * **The roll itself.** The effective deadline for a nominal `date` under `roll`,
 * against `holidays`.
 *
 * `exact` returns the date unmoved. `forward` and `backward` step one day at a
 * time until a working day is found.
 *
 * ## The bound, and why it is 366 rather than "until it finds one"
 *
 * A group that entered every day of a year as a holiday would send an unbounded
 * loop looking for a working day that does not exist. 366 steps is more than a
 * full year in either direction, so a deadline that has not resolved by then is
 * not a deadline that a longer search would resolve — it is a misconfigured
 * calendar. The function RETURNS the unrolled date in that case rather than
 * throwing: the caller's next question is "is this submission late", and
 * answering it against the nominal date is both defined and strictly no more
 * permissive than the alternative. `deadlineRollExhausted` reports the condition
 * separately, so a caller that wants to surface a configuration problem can,
 * without this function having to decide that a scheduling deadline is the right
 * place to raise one.
 */
const MAX_ROLL_STEPS = 366;

export function rollDeadline(
  date: CalendarDate,
  roll: DeadlineRoll,
  holidays: ReadonlySet<CalendarDate>,
): CalendarDate {
  if (roll === 'exact') return date;
  const step = roll === 'forward' ? 1 : -1;
  let candidate = date;
  for (let taken = 0; taken < MAX_ROLL_STEPS; taken += 1) {
    if (!isNonWorkingDay(candidate, holidays)) return candidate;
    candidate = addDays(candidate, step);
  }
  return date;
}

/**
 * Whether `rollDeadline` gave up — the calendar has no working day within a year
 * of `date` in the roll's direction.
 *
 * Separate from `rollDeadline` so that the roll stays a total function returning
 * a date, and a caller that wants to raise a configuration alarm still can. Both
 * read the same predicate, so they cannot disagree.
 */
export function deadlineRollExhausted(
  date: CalendarDate,
  roll: DeadlineRoll,
  holidays: ReadonlySet<CalendarDate>,
): boolean {
  if (roll === 'exact') return false;
  const step = roll === 'forward' ? 1 : -1;
  let candidate = date;
  for (let taken = 0; taken < MAX_ROLL_STEPS; taken += 1) {
    if (!isNonWorkingDay(candidate, holidays)) return false;
    candidate = addDays(candidate, step);
  }
  return true;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The effective deadline
 * ──────────────────────────────────────────────────────────────────────────── */

/** What the deadline computation concluded, and why. */
export type EffectiveDeadline =
  /** The window is shut. No submission is accepted, whatever the date. */
  | { readonly kind: 'closed' }
  /**
   * The nominal date the policy names, and the date the roll moved it to.
   *
   * Both are carried because a refusal has to STATE the effective deadline (§3)
   * and an operator debugging a group's configuration needs to see whether the
   * roll moved anything.
   */
  | {
      readonly kind: 'dated';
      readonly nominal: CalendarDate;
      readonly effective: CalendarDate;
      readonly rolled: boolean;
    };

/**
 * §3's `expires_at`, as a calendar date — **the server's computation, from the
 * group's policy**.
 *
 * `periodStart` is the schedule period the request is for, and is `null` when the
 * caller has none in hand. Under `days_before_period_start` a null period start
 * makes the deadline uncomputable, and this returns `closed` for it: a submission
 * window whose closing date cannot be established is not an open one. Failing in
 * the permissive direction here would let a request in against a deadline nobody
 * could name, which is precisely the "a client-side deadline is not a deadline"
 * failure with the client replaced by an absence.
 */
export function effectiveDeadline(
  policy: GroupDeadlinePolicy,
  holidays: ReadonlySet<CalendarDate>,
  periodStart: CalendarDate | null,
): EffectiveDeadline {
  const nominal = nominalDeadline(policy.requestUntil, periodStart);
  if (nominal === null) return { kind: 'closed' };
  const effective = rollDeadline(nominal, policy.deadlineRolls, holidays);
  return { kind: 'dated', nominal, effective, rolled: effective !== nominal };
}

/** The date the request-until policy names, before any roll. `null` when closed. */
function nominalDeadline(
  policy: RequestUntilPolicy,
  periodStart: CalendarDate | null,
): CalendarDate | null {
  switch (policy.mode) {
    case 'closed':
      return null;
    case 'fixed_date':
      return policy.until;
    case 'days_before_period_start':
      return periodStart === null ? null : addDays(periodStart, -policy.leadDays);
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Late submission
 * ──────────────────────────────────────────────────────────────────────────── */

/** What a submission attempt at a given date is, against a deadline. */
export type SubmissionTiming =
  /** On or before the effective deadline. The ordinary case. */
  | { readonly kind: 'on-time'; readonly effective: CalendarDate }
  /** After it, and group policy accepts it. The row carries `is_late = true`. */
  | { readonly kind: 'late-accepted'; readonly effective: CalendarDate }
  /** After it, and group policy rejects it. The refusal states `effective`. */
  | { readonly kind: 'late-rejected'; readonly effective: CalendarDate }
  /** The window is shut, so there is no date on which this would be accepted. */
  | { readonly kind: 'window-closed' };

/**
 * **§3's late-submission rule, decided rather than guessed.**
 *
 * `on` is the calendar date of the submission in the GROUP's zone — resolved by
 * the caller, because a timezone is not something this package has. The deadline
 * is inclusive: a submission ON the effective deadline is on time, which is what
 * "accepted until <date>" means in every place research 02 §4 records staff
 * seeing it.
 */
export function classifySubmission(
  policy: GroupDeadlinePolicy,
  holidays: ReadonlySet<CalendarDate>,
  periodStart: CalendarDate | null,
  on: CalendarDate,
): SubmissionTiming {
  const deadline = effectiveDeadline(policy, holidays, periodStart);
  if (deadline.kind === 'closed') return { kind: 'window-closed' };
  if (on <= deadline.effective) return { kind: 'on-time', effective: deadline.effective };
  return policy.lateSubmission === 'accept_as_late'
    ? { kind: 'late-accepted', effective: deadline.effective }
    : { kind: 'late-rejected', effective: deadline.effective };
}

/**
 * §3's "re-validated at every transition. **Not only at submission**".
 *
 * Whether a request whose recorded `expires_at` has passed may still be moved.
 * The answer is a property of the status it is IN, not of the transition asked
 * for: the three undecided states are the ones a passed deadline acts on, and
 * they are exactly the three the sweeper expires (V-31, R-23). A request already
 * approved, consumed, reflected, denied, withdrawn or reversed is past the point
 * where its submission deadline means anything, and re-validating against it
 * would let a stale date un-decide a decision — which is the specific outcome
 * V-31's enumerated expiry sources exist to prevent.
 */
export function deadlineBindsInStatus(status: string): boolean {
  return status === 'submitted' || status === 'under_review' || status === 'accepted_as_input';
}
