/**
 * SPEC-08 §5.4 and §5.5 — `APPROVE-VACATION`, as DOMAIN rules (OPUS-M5-002,
 * doc 42 §5d Part B).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## What is here and what is deliberately not
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The transaction itself is `apps/api/src/requests/vacation-approval.ts`, because
 * it is a sequence of statements and this package has no database handle. What
 * is here is every part of §5.4/§5.5 that is a question about VALUES: the outcome
 * vocabulary, D-21's bound as a predicate, V-30's mode branch, the two-step's
 * status path, and R-08's floor.
 *
 * Splitting it that way is not tidiness. Each predicate below has a DATABASE
 * counterpart that is unconditional — `vacation_grants_units_within_bound` and
 * `vacation_grants_units_not_negative`, migration 0022 — and R-01's discipline is
 * that the two layers must agree and be ASSERTED to agree. A predicate embedded
 * in the transaction is a predicate no test can put beside the CHECK.
 *
 * ## D-21 is never suspended. The BOUND is raised
 *
 * §5.5, after V-28: the previous text said D-21's upper bound was a `CHECK` *and*
 * that it was "relaxed only on the override path", and those cannot both be true
 * — a table CHECK is unconditional and cannot be relaxed per-caller. The
 * resolution raises the bound instead: `units_consumed <= units_total +
 * override_units`, with `override_units` written only by the audited override
 * path. **Every function below reads the raised bound**; none of them has a
 * branch that ignores it, because there is no such branch in the database either.
 *
 * ## `packages/domain` imports NOTHING
 *
 * No clock and no configuration, so `overrideUnitsNeeded` cannot decide *whether*
 * an override is permitted — that is a capability question, evaluated against
 * current state inside the transaction (I-19). It answers only *how much* the
 * bound would have to rise, which is arithmetic.
 */

import type { RequestStatus } from './subtypes.js';

/* ────────────────────────────────────────────────────────────────────────────
 * Outcomes
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Why an `APPROVE-VACATION` did not approve.
 *
 * The first three are §5.4's own words, spelled as the specification spells them
 * so a reader can lay the two side by side:
 *
 *  * **`QUOTA_EXHAUSTED`** — step 1's grant update matched no row because the
 *    raised bound is reached. R-05: "exactly one of two racing approvals
 *    succeeds. **The loser receives `QUOTA_EXHAUSTED`, not a silent overwrite.**"
 *  * **`VERSION_CONFLICT`** — step 1's grant update matched no row because
 *    `expected_grant_version` is stale. The same statement, a different reason,
 *    and they are separated because the remedies differ: a version conflict means
 *    reload and retry, an exhausted quota means there is nothing to retry.
 *  * **`SELECTION_NOT_PENDING`** — step 2's guarded selection update matched no
 *    row: the selection has already been approved, withdrawn or denied (R-18), or
 *    `expected_selection_version` is stale (R-19). **The whole transaction rolls
 *    back**, so a unit consumed at step 1 is released with it.
 *
 * The last two are §5.5's, and are refusals BEFORE any effect:
 *
 *  * **`OVERRIDE_REQUIRED`** — the approval would exceed the bound and the actor
 *    does not hold the override capability (R-06).
 *  * **`OVERRIDE_REASON_REQUIRED`** — the actor holds it but supplied no reason,
 *    which §5.5 makes mandatory.
 */
export const VACATION_APPROVAL_FAILURES = [
  'QUOTA_EXHAUSTED',
  'VERSION_CONFLICT',
  'SELECTION_NOT_PENDING',
  'OVERRIDE_REQUIRED',
  'OVERRIDE_REASON_REQUIRED',
] as const;

export type VacationApprovalFailure = (typeof VACATION_APPROVAL_FAILURES)[number];

/* ────────────────────────────────────────────────────────────────────────────
 * D-21, as predicates over the raised bound
 * ──────────────────────────────────────────────────────────────────────────── */

/** The three counters D-21's two CHECKs read. Nothing else about a grant matters here. */
export interface GrantCounters {
  readonly unitsTotal: number;
  readonly unitsConsumed: number;
  readonly overrideUnits: number;
}

/**
 * **D-21's upper bound**, exactly as `vacation_grants_units_within_bound` spells
 * it: `units_consumed <= units_total + override_units`.
 *
 * Read as "the bound after this row would still hold if one more unit were
 * consumed" by `grantHasHeadroom` below. Exposed separately because a caller
 * showing a variance indicator needs the bound itself, and computing it a second
 * time at the surface is how the surface and the constraint drift.
 */
export function grantBound(counters: GrantCounters): number {
  return counters.unitsTotal + counters.overrideUnits;
}

/**
 * Whether one more unit fits under the current bound — §5.4 step 1's
 * `units_consumed < units_total + override_units` predicate.
 *
 * Strictly less-than, matching the specification character for character: the
 * UPDATE's guard is what makes the race safe, and the CHECK is what makes it
 * true on every path including one that never ran this function.
 */
export function grantHasHeadroom(counters: GrantCounters): boolean {
  return counters.unitsConsumed < grantBound(counters);
}

/**
 * **How far the bound must rise for `units` more units to fit** — §5.5's
 * "increments `vacation_grants.override_units` **by the units being
 * authorised**".
 *
 * Zero when the units already fit, so an override path that is invoked
 * unnecessarily raises nothing. That matters more than it looks: §5.5's last
 * sentence in the reversal row is that "an override cannot silently persist as
 * headroom for a later approval", and raising the bound by a unit that was not
 * needed would be exactly that headroom, created at the moment of the override
 * rather than left behind by it.
 */
export function overrideUnitsNeeded(counters: GrantCounters, units: number): number {
  const shortfall = counters.unitsConsumed + units - grantBound(counters);
  return shortfall > 0 ? shortfall : 0;
}

/**
 * **R-08's floor.** Whether a reversal of `units` may be applied.
 *
 * §5.5: "**Negative balance — Prohibited.** `CHECK (units_consumed >= 0)` is
 * unconditional and applies on every path including override and reversal; a
 * reversal that would go below zero is rejected as a data error."
 *
 * A data error, and therefore not a `VacationApprovalFailure`: the failures above
 * are things a caller can be told and act on, and "this reversal would make the
 * ledger say a negative number of days were taken" is a bug in whatever computed
 * it. The service raises rather than returning it, and the unconditional CHECK
 * refuses it regardless.
 */
export function reversalKeepsFloor(counters: GrantCounters, units: number): boolean {
  return counters.unitsConsumed - units >= 0;
}

/**
 * **§5.5's reversal, both counters.** What `(units_consumed, override_units)`
 * become after reversing `units`.
 *
 * > **Reversing an override** — Decrements `units_consumed` **and**
 * > `override_units` together, so the bound returns to its pre-override value and
 * > an override cannot silently persist as headroom for a later approval.
 *
 * `override_units` falls by at most what is there, because
 * `CHECK (override_units >= 0)` (V-28) is unconditional too — a grant that was
 * never overridden reverses its consumption and leaves a bound of exactly
 * `units_total`, which is where it started.
 *
 * R-20 is this function and its CHECK together: the override raises the bound,
 * the reversal lowers it, and no step of either leaves the bound above where the
 * outstanding overrides put it.
 */
export function countersAfterReversal(counters: GrantCounters, units: number): GrantCounters {
  const releasedOverride = counters.overrideUnits < units ? counters.overrideUnits : units;
  return {
    unitsTotal: counters.unitsTotal,
    unitsConsumed: counters.unitsConsumed - units,
    overrideUnits: counters.overrideUnits - releasedOverride,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * §5.5's variance indicator — OPUS-M5-003, doc 42 §5f Part B
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * What a variance display says about one grant.
 *
 * Three numbers and a verdict, and the numbers are the three
 * [report 12](../../../../schedulepoint-research/reports/12-product-glossary.md)
 * TERM-051 renames: the ENTITLEMENT (`unitsTotal` — the allowance), the BALANCE
 * (`remaining` — what is left of it), and, for a `weekly-capacity` grant, the
 * per-week capacity those same fields carry. The glossary's disposition on that
 * term is explicit that the over-quota indicator is **advisory only** — "it
 * turns red but does not block approval" — and doc 09 §2.1 says the same:
 * *"Over-quota is advisory, not blocking. The variance indicator warns; approval
 * still succeeds."*
 *
 * So `state` is a WARNING vocabulary, never a permission. Nothing consults it to
 * decide anything: §5.5's refusal is `OVERRIDE_REQUIRED`, evaluated against the
 * override capability inside the transaction, and D-21's two unconditional
 * CHECKs are what actually bound the counters.
 */
export interface GrantVariance extends GrantCounters {
  /** D-21's upper bound: `unitsTotal + overrideUnits`. */
  readonly bound: number;
  /** What is left under the bound. Never negative — the CHECK makes it so. */
  readonly remaining: number;
  /**
   * How far consumption has passed the ENTITLEMENT, ignoring any override that
   * authorised it. Zero when the entitlement still covers it.
   *
   * This is the number the indicator turns red on, and it is deliberately
   * measured against `unitsTotal` rather than against `bound`: an approval that
   * raised the bound to fit itself is precisely the event a variance display
   * exists to make visible, and measuring against the raised bound would hide
   * every override behind the headroom it created.
   */
  readonly overEntitlement: number;
  readonly state: 'within' | 'at-entitlement' | 'over-entitlement';
}

/**
 * §5.5's advisory indicator, computed from the three counters and nothing else.
 *
 * `at-entitlement` is its own value rather than folded into `within`, because a
 * surface warns differently about "the last unit is gone" and "there are three
 * left" — and a caller that had to compare two numbers to tell them apart is a
 * caller that will compare them differently somewhere else.
 */
export function grantVariance(counters: GrantCounters): GrantVariance {
  const bound = grantBound(counters);
  const overEntitlement =
    counters.unitsConsumed > counters.unitsTotal ? counters.unitsConsumed - counters.unitsTotal : 0;
  const remaining = bound - counters.unitsConsumed > 0 ? bound - counters.unitsConsumed : 0;
  return {
    ...counters,
    bound,
    remaining,
    overEntitlement,
    state:
      overEntitlement > 0
        ? 'over-entitlement'
        : counters.unitsConsumed === counters.unitsTotal
          ? 'at-entitlement'
          : 'within',
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * V-30's mode branch
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * **Whether this period's approval consumes a grant at all** — §5.4 step 1's
 * branch, added by V-30.
 *
 * `quota` consumes; `open` does not, and skips the grant update ENTIRELY, leaving
 * `grant_id` null. The defect V-30 fixed is worth restating because the shape
 * that caused it is easy to write again: the previous transaction ran the grant
 * update unconditionally, so in open mode — where **no `vacation_grants` rows
 * exist at all** — it affected zero rows, and §5.4 defined zero rows as
 * `QUOTA_EXHAUSTED`. **Open-mode approval therefore always failed**, and R-13
 * could not pass.
 *
 * A caller that treats "no grants" as "quota exhausted" is reintroducing it —
 * which is why `VacationStore.listGrants` says the same thing from the read side.
 *
 * §5.5's mode-stability rule is what makes this branch safe: a mode change is
 * "**Prohibited** while selections exist in `pending` or `approved`", enforced by
 * migration 0022's `vacation_periods_guard_mode_stable`, so the mode cannot flip
 * underneath a live approval.
 */
export function approvalConsumesQuota(mode: 'quota' | 'open'): boolean {
  return mode === 'quota';
}

/* ────────────────────────────────────────────────────────────────────────────
 * The two-step — M5-000b finding #1, BINDING
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * **The root status path a vacation decision walks**, in order, excluding the
 * starting status.
 *
 * §5.4 step 3 prints one statement:
 *
 * ```
 *   UPDATE requests SET status = 'approved' WHERE id = <the selection's request_id>
 * ```
 *
 * **That spelling is refused by §2's own matrix.** There is no
 * `submitted → approved` cell for `vacation-selection` — or for any subtype —
 * and 0021's `app_guard_request_transition` implements §2 literally, so the
 * printed statement raises `restrict_violation`. M5-000b proved it by test and
 * the finding is BINDING on this packet: the implementable writer is the two-step
 * `submitted → under_review → approved` inside ONE transaction, and the same for
 * a denial.
 *
 * **Deferred D-27 is what makes the two-step legal, and it is load-bearing.**
 * `requests_guard_vacation_status_mapping` is a CONSTRAINT trigger evaluated at
 * COMMIT against CURRENT rows, so the intermediate `under_review` — which §5.3's
 * mapping does not produce and which D-27 would refuse if it saw it — is never
 * seen. A non-deferred version of the same trigger would make §5.4 unimplementable
 * altogether.
 *
 * The selection's own status moves `pending → approved` in one step, because
 * §5.3's lifecycle carries that edge directly. Only the DERIVED root status needs
 * two.
 */
export const VACATION_APPROVAL_ROOT_PATH: readonly RequestStatus[] = ['under_review', 'approved'];

/** The same, for a denial. Same reason, same shape, and stated rather than derived. */
export const VACATION_DENIAL_ROOT_PATH: readonly RequestStatus[] = ['under_review', 'denied'];
