/**
 * SPEC-08 §5.6 — COMMIT and REVERSAL, the pure half (OPUS-M5-004, doc 42 §5h).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## §5.6, both sentences
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * > **Commit** targets a **draft** version (SPEC-05), creating OFF assignment
 * > snapshots, marking selections `committed` with `committed_to_version_id`, in
 * > one transaction, idempotent by D-23.
 *
 * > **Reversal** (`committed → reversed`) requires the override capability and a
 * > reason; it decrements `units_consumed`, marks the selection `reversed`, and
 * > **raises a revision request against the schedule rather than editing a
 * > published version.**
 *
 * The transaction is `apps/api/src/requests/vacation-commit.ts`, for the reason
 * everything in this directory is split that way: `packages/domain` imports
 * NOTHING, so it holds the rules a reviewer can check against the specification
 * and none of the machinery that would need a clock or a connection to run.
 *
 * ## Why the failure vocabularies are closed sets and live here
 *
 * The same reason `VACATION_APPROVAL_FAILURES` is one: a refusal a caller cannot
 * branch on becomes a 500 at the route, and a wire vocabulary assembled from
 * whatever strings a service happened to throw is a vocabulary that grows
 * without meaning. Both sets below are exhaustive over the refusals §5.6 and
 * SPEC-05 can produce, and the route maps each to one status.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * 1. Commit
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Every way a commit is refused.
 *
 *  - **`COMMIT_TARGET_NOT_DRAFT`** — §5.6's "targets a **draft** version", and
 *    I-18 (non-bypass rule 5) from the other side: a published version is
 *    immutable in the database, so committing INTO one is not a thing that can
 *    be allowed for any reason, and the refusal names the reason rather than
 *    surfacing whatever constraint fired first. SPEC-05 §6.1's remedy applies —
 *    amend a published version by cloning it and publishing forward.
 *  - **`COMMIT_PERIOD_NOT_FOUND`** — no such vacation period under this context.
 *    Not-found and not-visible are deliberately the same answer (RLS makes
 *    another group's period invisible), which is the house rule every by-id read
 *    in this codebase follows.
 *  - **`COMMIT_PERIOD_VERSION_MISMATCH`** — the target version does not belong
 *    to the same schedule period the vacation period covers. Committing a
 *    round's weeks into a version of a different period would produce OFF days
 *    on dates the version does not contain, or silently drop them.
 *  - **`COMMIT_NO_OFF_SHIFT_TYPE`** — the group defines no leave-of-absence
 *    shift type, so there is nothing for an OFF assignment to BE. A refusal
 *    rather than an invented catalogue row: `shift_types.is_leave_of_absence` is
 *    a scheduler's configuration decision (migration 0005, ADM-07), and a
 *    commit that created one would be a commit that authored the catalogue.
 *  - **`COMMIT_SELECTION_NOT_APPROVED`** — a named selection is not `approved`.
 *    §5.3's `approved → committed` is the only edge into `committed`, and the
 *    whole transaction rolls back rather than committing the rest, so a partial
 *    commit is not a state this system has.
 *  - **`COMMIT_NOTHING_TO_COMMIT`** — no approved selection in the round. A
 *    refusal rather than a successful no-op, and deliberately: a scheduler who
 *    pressed commit believes there is something to commit, and a silent success
 *    that wrote nothing would leave them believing it happened.
 *  - **`COMMIT_RACE_LOST`** — the INTERNAL one, and the only member of this set
 *    that never reaches a caller. Two commands carrying one key both passed the
 *    replay read and both did the work; the loser's ledger INSERT found the
 *    winner's row, and its whole transaction rolls back. The route then re-enters
 *    the commit in a FRESH unit of work, where step 0 finds the winner's row and
 *    returns the recorded outcome — so a concurrent duplicate and a sequential
 *    replay answer a caller identically (R-12's "one commit", from outside) and
 *    no `23505` surfaces anywhere. Surfacing a conflict instead would tell a
 *    caller to retry a command that has already succeeded.
 */
export const VACATION_COMMIT_FAILURES = [
  'COMMIT_TARGET_NOT_DRAFT',
  'COMMIT_PERIOD_NOT_FOUND',
  'COMMIT_PERIOD_VERSION_MISMATCH',
  'COMMIT_NO_OFF_SHIFT_TYPE',
  'COMMIT_SELECTION_NOT_APPROVED',
  'COMMIT_NOTHING_TO_COMMIT',
  'COMMIT_RACE_LOST',
] as const;

export type VacationCommitFailure = (typeof VACATION_COMMIT_FAILURES)[number];

/**
 * The schedule-version states a vacation commit may target — **`draft`, and
 * only `draft`.**
 *
 * §5.6 says so and I-18 is why it is not negotiable: *"A published schedule
 * version is immutable in the database"*, and `superseded` is a version that WAS
 * published. `in_review`, `approved` and `publishing` are excluded too, and that
 * is the narrower reading rather than an oversight — SPEC-05 §3.2's editability
 * is `draft` alone (migration 0009's `EDITABLE_STATES` in
 * `apps/api/src/schedule/service.ts` is the shipped copy of the same fact), and
 * a commit is an edit.
 *
 * Spelled as a set of the states that ARE admitted rather than the states that
 * are not, so a state added to `schedule_versions_state_domain` in a later
 * migration is refused by default rather than admitted by omission.
 */
export const COMMITTABLE_VERSION_STATES: readonly string[] = ['draft'];

/**
 * Whether a version in `state` may be committed into.
 *
 * The domain half of a double enforcement. The other half is
 * `assertEditable` inside `addManualAssignment`, which every OFF snapshot goes
 * through and which no future caller can walk past — so a commit that somehow
 * reached a published version would still be refused, by a second control, with
 * a different message. This one exists so the refusal can NAME the reason before
 * anything is attempted, which is what §5.6's "targets a draft version" needs a
 * caller to be told.
 */
export function versionAcceptsCommit(state: string): boolean {
  return COMMITTABLE_VERSION_STATES.includes(state);
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. Reversal
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Every way a reversal is refused.
 *
 *  - **`REVERSAL_SELECTION_NOT_COMMITTED`** — §5.3 has one edge into `reversed`
 *    and it starts at `committed`. A selection that was never committed has
 *    nothing to reverse, and a committed one that was already reversed is not
 *    committed any more.
 *  - **`REVERSAL_OVERRIDE_REQUIRED`** — §5.6: reversal *"requires the override
 *    capability"*. The definite article points at §5.5's, which is
 *    `vacation.override_quota` — the capability this system already has for
 *    "authorise a deviation from the quota rules, audited". Reversal is exactly
 *    that: it hands a consumed unit back and lowers a bound somebody raised.
 *  - **`REVERSAL_REASON_REQUIRED`** — §5.6: *"and a reason"*. Mandatory, bounded,
 *    scheduler-authored administrative text of the `override_reason` class, and
 *    it never enters an audit payload, an outbox row, or a log (I-07, non-bypass
 *    rule 9).
 *  - **`REVERSAL_GRANT_CONFLICT`** — the grant moved under the reversal (another
 *    approval or reversal in flight). The whole transaction rolls back, so a
 *    reversal never commits without its release and a member's allowance is
 *    never left spent.
 *
 * **What is NOT in this list: R-08's negative balance.** §5.5 is explicit that a
 * reversal which would take `units_consumed` below zero is *"rejected as a data
 * error"* — the unconditional `CHECK (units_consumed >= 0)` refuses the row and
 * the service raises rather than returning a failure. A refusal a caller could
 * catch and retry would be one they could not act on: the number was already
 * wrong before they pressed anything.
 */
export const VACATION_REVERSAL_FAILURES = [
  'REVERSAL_SELECTION_NOT_COMMITTED',
  'REVERSAL_OVERRIDE_REQUIRED',
  'REVERSAL_REASON_REQUIRED',
  'REVERSAL_GRANT_CONFLICT',
] as const;

export type VacationReversalFailure = (typeof VACATION_REVERSAL_FAILURES)[number];

/**
 * §5.6's mandatory reason, as a predicate.
 *
 * Trimmed and non-empty, bounded at the administrative-text class's 1000
 * characters — the bound migration 0022's
 * `vacation_selections_override_reason_len` already enforces, restated here so
 * the refusal can be `REVERSAL_REASON_REQUIRED` rather than a `23514` a caller
 * cannot read. Whitespace is not a reason.
 */
export const REVERSAL_REASON_MAX_LENGTH = 1000;

export function reversalReasonIsWellFormed(reason: string): boolean {
  const trimmed = reason.trim();
  return trimmed.length >= 1 && trimmed.length <= REVERSAL_REASON_MAX_LENGTH;
}
