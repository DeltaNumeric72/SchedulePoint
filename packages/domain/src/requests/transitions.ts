/**
 * SPEC-08 §2 — the per-subtype transition matrices, as DOMAIN logic
 * (OPUS-M5-001, doc 42 §5c Part A).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## Why this file exists when the database already refuses the same edges
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * SPEC-08 §7 R-01 is "every (subtype × status × operation) combination —
 * illegal ones **rejected by both domain and database**". Two layers, and the
 * second one is not a spare copy of the first:
 *
 *   * The DATABASE layer (`app_request_transition_is_legal`, migration 0021 §3)
 *     is the one that cannot be walked past. Every writer meets it, including a
 *     writer nobody has written yet, a migration, and an operator at a psql
 *     prompt.
 *   * The DOMAIN layer is the one that can say WHY before anything is attempted,
 *     and the one a caller can consult to find out what is possible. A service
 *     that discovers a refusal by catching `restrict_violation` cannot tell a
 *     requester "this request has already been consumed by a build" — it can
 *     only tell them something failed.
 *
 * **The two must agree exactly, and agreement is asserted rather than assumed.**
 * `apps/api/test/requests/transition-matrix-agreement.test.ts` walks the FULL
 * cross-product — every subtype, every from-status, every to-status — and
 * requires `transitionIsLegal` here and the SQL function there to return the
 * same boolean for every cell. A matrix that drifts from its own database copy
 * is worse than having only one, because both look authoritative.
 *
 * ## This module states EDGES. `./subtypes.ts` states DOMAINS
 *
 * D-20 asks "may this subtype's row ever hold this status"; §2 asks "may it move
 * from this status to that one". Neither implies the other, and a design with
 * only the first is the one in which `shift-preference` reaches `approved`
 * through a path nobody enumerated. `./subtypes.ts` deliberately shipped the
 * domains alone and said so; this is the other half.
 *
 * ## `packages/domain` imports NOTHING, and that is load-bearing here
 *
 * There is no clock, no database handle and no configuration in this file. A
 * transition matrix that could read something would be a transition matrix whose
 * answer depended on when you asked.
 */

import { REQUEST_SUBTYPES, type RequestStatus, type RequestSubtype } from './subtypes.js';

/* ────────────────────────────────────────────────────────────────────────────
 * The subtype groupings §2's columns actually use
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The five subtypes that go through review — everything except
 * `shift-preference`.
 *
 * A shift preference is **non-binding**: nobody approves or denies it, so it has
 * no `under_review`, no `approved` and no `denied` (§2.1). Forcing it through
 * `under_review → approved` would invent an approval that does not happen, which
 * is the defect `accepted_as_input` exists to avoid.
 */
export const REVIEWED_SUBTYPES = [
  'availability',
  'time-off',
  'no-call',
  'shift-group-off',
  'vacation-selection',
] as const satisfies readonly RequestSubtype[];

/**
 * The two subtypes that carry `accepted_as_input`.
 *
 * `availability` carries it because §2's `submitted → accepted_as_input` cell is
 * ✓ for it; `shift-preference` because it is the only route that subtype has.
 */
export const ACCEPTED_AS_INPUT_SUBTYPES = [
  'availability',
  'shift-preference',
] as const satisfies readonly RequestSubtype[];

/**
 * The five subtypes a solver BUILD consumes — everything except vacation.
 *
 * Vacation reaches a published version by COMMIT (§5.6), not by a build, which
 * is why `approved → reflected_in_version` is vacation's alone and
 * `consumed_by_build` is not in its domain at all.
 */
export const BUILD_CONSUMED_SUBTYPES = [
  'availability',
  'time-off',
  'no-call',
  'shift-preference',
  'shift-group-off',
] as const satisfies readonly RequestSubtype[];

/* ────────────────────────────────────────────────────────────────────────────
 * The matrix
 * ──────────────────────────────────────────────────────────────────────────── */

/** One cell of §2's table: an edge, and the subtypes whose column carries a ✓. */
export interface RequestTransition {
  readonly from: RequestStatus;
  readonly to: RequestStatus;
  readonly subtypes: readonly RequestSubtype[];
}

/**
 * **§2's table, row for row, in its printed order.**
 *
 * Spelled as data rather than as a chain of boolean clauses so that a reader can
 * lay it beside SPEC-08 §2 and check it by eye, and so that the agreement test
 * can enumerate it. The database's copy is a chain of clauses because a SQL
 * `IMMUTABLE` function is the cheapest thing to call from a trigger; that
 * asymmetry is deliberate and is exactly why the two are compared by test rather
 * than trusted to match.
 *
 * Three rows repay reading rather than skimming, because each was got wrong once
 * (V-31):
 *
 *  1. **`accepted_as_input → withdrawn`** exists for `availability` and
 *     `shift-preference`. Without it a shift preference became unwithdrawable the
 *     instant it was accepted — and it is accepted immediately, because nobody
 *     approves a non-binding preference. A preference is retractable until a
 *     build consumes it, and forbidden after that only because the build already
 *     used it.
 *  2. **`→ expired` names its three sources.** The superseded spelling was a
 *     literal `*`, which as a rule permits `reflected_in_version → expired` —
 *     expiring a request a PUBLISHED version already honours — and
 *     `approved → expired`, which silently un-decides a decision. R-23 is those
 *     two attempts.
 *  3. **`approved → reflected_in_version` is vacation's alone**, and
 *     `consumed_by_build → reflected_in_version` is everyone else's. A vacation
 *     week is committed to a version; a request is consumed by a build and then
 *     honoured by the version that build produced. Collapsing them would make
 *     "how did this reach the schedule" unanswerable.
 */
export const REQUEST_TRANSITIONS: readonly RequestTransition[] = [
  { from: 'draft', to: 'submitted', subtypes: REQUEST_SUBTYPES },

  { from: 'submitted', to: 'under_review', subtypes: REVIEWED_SUBTYPES },
  { from: 'submitted', to: 'accepted_as_input', subtypes: ACCEPTED_AS_INPUT_SUBTYPES },

  { from: 'under_review', to: 'approved', subtypes: REVIEWED_SUBTYPES },
  { from: 'under_review', to: 'denied', subtypes: REVIEWED_SUBTYPES },

  { from: 'submitted', to: 'withdrawn', subtypes: REQUEST_SUBTYPES },
  { from: 'under_review', to: 'withdrawn', subtypes: REVIEWED_SUBTYPES },
  { from: 'approved', to: 'withdrawn', subtypes: REVIEWED_SUBTYPES },
  { from: 'accepted_as_input', to: 'withdrawn', subtypes: ACCEPTED_AS_INPUT_SUBTYPES },

  {
    from: 'approved',
    to: 'consumed_by_build',
    subtypes: ['availability', 'time-off', 'no-call', 'shift-group-off'],
  },
  { from: 'accepted_as_input', to: 'consumed_by_build', subtypes: ['shift-preference'] },

  { from: 'consumed_by_build', to: 'reflected_in_version', subtypes: BUILD_CONSUMED_SUBTYPES },
  { from: 'approved', to: 'reflected_in_version', subtypes: ['vacation-selection'] },

  { from: 'consumed_by_build', to: 'unsatisfied', subtypes: ['shift-preference'] },

  { from: 'reflected_in_version', to: 'reversed', subtypes: ['vacation-selection'] },

  /* ──────────────────────────────────────────────────────────────────────────
   * FAD-55 (2026-08-26) — `reflected_in_version → withdrawn`, five subtypes.
   *
   * **This cell is not in SPEC-08 §2's printed table, and it is required by
   * SPEC-08 §4 and R-10.** §4's withdrawal row: "Withdrawal after
   * `reflected_in_version` … The request moves to `withdrawn` with
   * `revision_requested = true`." R-10 tests exactly that. The V-31 amendment
   * swept §2 — it added `accepted_as_input → withdrawn` and rewrote the expiry
   * rows — but never added the row §4's own sentence requires, so the matrix and
   * §4 disagreed and migration 0021, implementing §2 literally, refused the edge
   * R-10 needs.
   *
   * Escalated rather than resolved unilaterally, and RATIFIED as FAD-55 under
   * the delegated authority: resolve ADDITIVELY, in favour of the explicit
   * behavioural requirement. SPEC-08 §2 carries a dated amendment landed by this
   * same packet, so the specification and the enforcement do not disagree after
   * this. **Nothing is narrowed**: V-31's enumerated expiry sources are
   * untouched, no wildcard is reintroduced, and D-20 needs no change at all
   * because `withdrawn` is already in every subtype's status domain.
   *
   * The edge is unusable for a QUIET withdrawal: migration 0023's
   * `app_guard_request_revision_requested` refuses a `reflected_in_version →
   * withdrawn` write that does not set `revision_requested` in the same row
   * write. So the only thing this cell permits is the scenario §4 describes.
   *
   * **Vacation is excluded.** A committed vacation week's undo is §5.6's
   * REVERSAL — `reflected_in_version → reversed`, already in the row above.
   * A second spelling would leave §5.3's mapping unable to say which one a
   * `withdrawn` selection meant.
   * ────────────────────────────────────────────────────────────────────────── */
  {
    from: 'reflected_in_version',
    to: 'withdrawn',
    subtypes: ['availability', 'time-off', 'no-call', 'shift-preference', 'shift-group-off'],
  },

  { from: 'submitted', to: 'expired', subtypes: REQUEST_SUBTYPES },
  { from: 'under_review', to: 'expired', subtypes: REQUEST_SUBTYPES },
  { from: 'accepted_as_input', to: 'expired', subtypes: REQUEST_SUBTYPES },

  { from: 'approved', to: 'superseded_by_revision', subtypes: REVIEWED_SUBTYPES },
];

/**
 * The matrix as a lookup, built once.
 *
 * A `Set` of `"subtype|from|to"` rather than a nested record, because the
 * question this module is asked is always the three-part one and a nested record
 * invites a caller to walk a level of it and reason about the rest themselves.
 */
const EDGES: ReadonlySet<string> = new Set(
  REQUEST_TRANSITIONS.flatMap((edge) =>
    edge.subtypes.map((subtype) => `${subtype}|${edge.from}|${edge.to}`),
  ),
);

/**
 * **§2, as a predicate.** Whether a `subtype` request may move from `from` to
 * `to`.
 *
 * There are no self-edges in §2, so `from === to` is `false` here. That is not
 * the same question the database's trigger answers: `app_guard_request_transition`
 * returns early for a same-status UPDATE, because stamping `decided_at`,
 * recomputing `expires_at` or bumping `version` are all legitimate same-status
 * work and the matrix has nothing to say about them. **The two agree on every
 * cell where `from <> to`, which is every cell §2 has**, and the agreement test
 * compares exactly that region.
 */
export function transitionIsLegal(
  subtype: RequestSubtype,
  from: RequestStatus,
  to: RequestStatus,
): boolean {
  return EDGES.has(`${subtype}|${from}|${to}`);
}

/** Every status a `subtype` request in `from` may legally move to, in §2's order. */
export function legalTransitionsFrom(
  subtype: RequestSubtype,
  from: RequestStatus,
): readonly RequestStatus[] {
  return REQUEST_TRANSITIONS.filter(
    (edge) => edge.from === from && edge.subtypes.includes(subtype),
  ).map((edge) => edge.to);
}

/* ────────────────────────────────────────────────────────────────────────────
 * The initial-INSERT status ruling
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * **The status a request row is CREATED at — the 0021 header §4 open decision,
 * decided by doc 42 §5c Part A.**
 *
 * > a request row is CREATED at `draft` for the five subtypes — submission is a
 * > TRANSITION, never an insert state — and at `submitted` only for
 * > `vacation-selection` (§5.3: a selection becomes a request AT submission).
 *
 * The matrix above bounds UPDATE edges only. Nothing in §2 says where a row may
 * START, and a row that could be INSERTed at any status in its D-20 domain could
 * reach `approved` without ever having been submitted, reviewed or decided —
 * every edge in §2 walked around rather than through. The ruling closes that,
 * and the database enforces it in migration 0023.
 *
 * **Vacation is `submitted` and not `draft`, and the asymmetry is §5.3's, not a
 * convenience.** §5.3's mapping table reads `available` → *no request row yet*,
 * `pending` → `submitted`: a vacation selection lives as a selection with no root
 * until it is submitted, and the root's first instant is the submission. There is
 * no state of the world in which a vacation root exists at `draft`, so admitting
 * one would be admitting a row §5.3 cannot explain — and D-27 would refuse it at
 * commit anyway, from the other side, with a message about a mapping rather than
 * about a creation.
 *
 * **A consequence, stated rather than left to be discovered:** §2's
 * `draft → submitted` cell is ✓ for `vacation-selection`, and under this ruling
 * that edge is unreachable, because no vacation row is ever at `draft`. This is
 * the third of the three SPEC-08 findings already on record from M5-000b — §2's
 * vacation column admits `draft`, `under_review` and `superseded_by_revision`
 * which §5.3 never produces; the effective set is the intersection. Nothing new
 * is created here and nothing is narrowed: both layers stay implemented
 * literally, and the SPEC-08 clarification remains a candidate for the M5 exit
 * sweep.
 */
export const INITIAL_REQUEST_STATUS_BY_SUBTYPE: {
  readonly [S in RequestSubtype]: RequestStatus;
} = {
  availability: 'draft',
  'time-off': 'draft',
  'no-call': 'draft',
  'shift-preference': 'draft',
  'shift-group-off': 'draft',
  'vacation-selection': 'submitted',
};

/** The status a new `subtype` request row is created at. */
export function initialRequestStatus(subtype: RequestSubtype): RequestStatus {
  return INITIAL_REQUEST_STATUS_BY_SUBTYPE[subtype];
}

/**
 * Whether `status` is the status a `subtype` row may be created at.
 *
 * The domain half of the double enforcement for the ruling above; migration
 * 0023's `app_guard_request_initial_status` is the other half, and
 * `apps/api/test/requests/migration-0023-populated-cycle.test.ts` proves the two
 * agree over the whole (subtype × status) cross-product.
 */
export function isLegalInitialStatus(subtype: RequestSubtype, status: RequestStatus): boolean {
  return INITIAL_REQUEST_STATUS_BY_SUBTYPE[subtype] === status;
}
