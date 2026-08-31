/**
 * SPEC-08 §6 — the SOLVER PROJECTION, as a pure rule (OPUS-M5-004, doc 42 §5h).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## §6's opening sentence is the whole design
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * > The solver reads a **projection**, never the raw tables, so a status whose
 * > meaning is subtype-dependent cannot leak into the model.
 *
 * `approved` means one thing for a time-off request and another for a shift
 * preference (which never reaches it at all); `accepted_as_input` exists for two
 * subtypes; `unsatisfied` for one. A model that read `requests.status` would
 * have to know all of that, and a model that knew all of that would be a second
 * copy of §2 in the one place nobody compares against §2.
 *
 * So the projection is four ROW KINDS and a membership rule, and this module is
 * the rule — total, pure, and decidable without a database, so the assembly in
 * `apps/api/src/solver/canonical-input.ts` is composition rather than a second
 * spelling.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## §6's table, and V-31 — the amendment that closed the hole
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * | Projection row | Built from |
 * |---|---|
 * | `HardOff(membership, date)` | `time-off` and `no-call` in `approved`, `consumed_by_build`, **or `reflected_in_version`**; committed vacation |
 * | `HardOn(membership, date)` | `availability` in `approved` **or `reflected_in_version`**, where group policy makes it binding |
 * | `SoftPreference(membership, date, shift_type, strength)` | `shift-preference` in `accepted_as_input` **or `reflected_in_version`** |
 * | `ShiftGroupOff(membership, date, shift_group)` | `shift-group-off` in `approved` **or `reflected_in_version`** |
 *
 * **`reflected_in_version` is in every one of the four rows, and that is V-31.**
 * Before the amendment it appeared in neither the include list nor the exclude
 * list, so on a REBUILD of the same period a time-off request a published
 * version already honoured had *undefined* projection membership — and §6 is the
 * only gate. Excluded, the rebuild could schedule the person on their approved
 * day off with neither the domain nor the database objecting. SPEC-08 R-14 is
 * that scenario, and it is this module's most important row.
 *
 * ## The exclusion list is EXHAUSTIVE, and this module makes that checkable
 *
 * > A request in `draft`, `submitted`, `denied`, `withdrawn`, `expired`,
 * > `unsatisfied`, or `reversed` never enters the projection *(the list is now
 * > exhaustive against §2's status set, so no status is undefined in either
 * > direction)*.
 *
 * Seven named statuses. §2's set has thirteen. Four of the remaining six are the
 * include statuses above; the other two are `under_review` and
 * `superseded_by_revision`, which §6 names in neither list — so this module
 * treats them as NOT projected and says so by name rather than by omission, and
 * {@link PROJECTION_EXCLUDED_STATUSES} is asserted against
 * `REQUEST_STATUSES` so that a status added to §2 without a §6 disposition fails
 * a test rather than quietly defaulting to one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## FAD-60 — the preference strength travels VERBATIM, and the weight table
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `SoftPreference` carries a STRENGTH, and there was a real decision hiding in
 * that word. The rules AST has a four-value SIGNED preference vocabulary
 * (`strong_prefer | prefer | avoid | strong_avoid`,
 * `packages/domain/src/rules/ast.ts`); a request has a three-value UNSIGNED one
 * (`REQUEST_PREFERENCE_STRENGTHS = low | medium | high`). FAD-60 rules that the
 * projection **never routes one through the other**:
 *
 *  - three unsigned values onto a two-value positive arm is LOSSY, and
 *  - the `avoid` arm is UNREACHABLE from a request BY CONSTRUCTION — a request
 *    states a preference FOR its named shift type — so a mapping able to express
 *    it would manufacture a hostile preference nobody stated.
 *
 * So the row below carries `low | medium | high` verbatim, and
 * {@link SOFT_PREFERENCE_WEIGHTS} is the mapping the OBJECTIVE applies. Three
 * properties of that table are NOT latitude and are pinned by test
 * (`packages/domain/test/requests/solver-projection.test.ts`):
 *
 *  1. **total** over the closed set — every strength has a weight;
 *  2. **strictly monotone** — `low < medium < high`;
 *  3. **positive** — every weight `> 0`.
 *
 * The VALUES are declared latitude against doc 08 §3.3's objective-term
 * structure, and they were chosen against that file rather than invented: §3.3's
 * preference row reads *"Preference satisfaction | **Reward** honoured ON /
 * preferred-shift requests"* — a REWARD, which is why positivity is a property
 * of the table rather than a convention — and doc 08 §3.4 fixes one global
 * integer scale for the whole objective, already shipped as `OBJECTIVE_SCALE`
 * (`packages/domain/src/rules/objective.ts`). `1 / 2 / 4` is a plain doubling on
 * the unit `E2_OBJECTIVE_PROFILE`'s `preference` tier already uses as its
 * `tierWeight`: a `medium` outweighs a `low`, a `high` outweighs a `medium`, and
 * a `high` outweighs two `low`s — so the strengths order preferences without one
 * class of preference being able to outrank a whole tier.
 *
 * **What this module does NOT do, stated as a routed obligation rather than a
 * disclaimer:** the CP-SAT objective does not yet build a term from
 * `SoftPreference` at all. The worker's objective is assembled from SOFT RULES
 * (`E2_OBJECTIVE_PROFILE`'s tiers name rules-AST node kinds), and wiring a
 * request-derived preference term into it is a solver-model change plus a change
 * to the worker's mirrored profile — outside doc 42 §5h's "API/store/solver-input
 * only" scope, and no SPEC-08 §7 row requires it. **Routed forward** to the M5
 * exit sweep or a solver packet, with this table as the mapping it will apply.
 * `HardOff` is different and IS consumed: R-14's required outcome is behavioural
 * ("the rebuild cannot schedule the person on their approved day off"), which a
 * row nothing reads cannot produce.
 *
 * ## The design anchor `HardOff` finally implements
 *
 * Doc 08 §3.2's hard-constraint table has a row that had no implementation until
 * this packet: **"Availability (approved absence, vacation) | Candidate
 * unavailability window"**. That is what `HardOff` is, and the worker's
 * consumption of it — dropping the (membership, date) cells from the decision
 * grid — is that row's "candidate unavailability window" in the only place a
 * candidate filter can live.
 *
 * ## `packages/domain` imports NOTHING, and that is load-bearing here
 *
 * No clock, no database handle, no configuration. A projection rule that could
 * read something would be a projection rule whose answer depended on when you
 * asked — and the whole point of a pinned `solver_inputs` snapshot is that the
 * problem posed is the problem recorded.
 */

import {
  REQUEST_STATUSES,
  type RequestPreferenceStrength,
  type RequestStatus,
  type RequestSubtype,
} from './subtypes.js';

/* ────────────────────────────────────────────────────────────────────────────
 * 1. The four row kinds
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * §6's four projection rows, in §6's printed order.
 *
 * Stable, never renumbered (non-bypass rule 13). The order is the order a reader
 * meets them in the specification, and the snapshot document carries one array
 * per kind rather than one array of tagged rows, so a consumer that handles one
 * kind cannot silently receive another.
 */
export const REQUEST_PROJECTION_KINDS = [
  'HardOff',
  'HardOn',
  'SoftPreference',
  'ShiftGroupOff',
] as const;

export type RequestProjectionKind = (typeof REQUEST_PROJECTION_KINDS)[number];

/**
 * **`HardOff(membership, date)`** — the person is unavailable that day.
 *
 * Doc 08 §3.2's "Availability (approved absence, vacation) | Candidate
 * unavailability window". Built from `time-off` and `no-call` requests, and from
 * COMMITTED VACATION — §6's table names all three sources in one cell, and the
 * vacation half is why this packet's commit transaction and this packet's
 * projection are one packet.
 */
export interface HardOffProjectionRow {
  readonly membershipId: string;
  /** `YYYY-MM-DD`. */
  readonly date: string;
}

/**
 * **`HardOn(membership, date)`** — an availability the group's policy makes
 * BINDING.
 *
 * §6's cell carries the qualifier verbatim: *"where group policy makes it
 * binding"*. An availability request that the policy does NOT make binding
 * produces no row at all — it is not a soft version of this row, it is absent —
 * so the policy question is answered by the assembly, which can read the group,
 * and never here.
 */
export interface HardOnProjectionRow {
  readonly membershipId: string;
  readonly date: string;
}

/**
 * **`SoftPreference(membership, date, shift_type, strength)`** — FAD-60's row.
 *
 * `strength` is the request's own `low | medium | high`, VERBATIM. It is not the
 * rules AST's signed vocabulary and it must not be mapped onto it; see the
 * module header.
 */
export interface SoftPreferenceProjectionRow {
  readonly membershipId: string;
  readonly date: string;
  readonly shiftTypeId: string;
  readonly strength: RequestPreferenceStrength;
}

/** **`ShiftGroupOff(membership, date, shift_group)`** — §6's fourth row. */
export interface ShiftGroupOffProjectionRow {
  readonly membershipId: string;
  readonly date: string;
  readonly shiftGroupId: string;
}

/**
 * **The projection**, as the snapshot carries it: one array per kind.
 *
 * Every array is REQUIRED and may be empty, for the reason snapshot v2's
 * vocabularies are required — an optional array would make "this period has no
 * approved absences" and "the assembly forgot to project them" the same
 * document, and those two answers disagree about every date in the period. An
 * empty array says "none"; an absent field would say nothing at all.
 */
export interface RequestProjection {
  readonly hardOff: readonly HardOffProjectionRow[];
  readonly hardOn: readonly HardOnProjectionRow[];
  readonly softPreference: readonly SoftPreferenceProjectionRow[];
  readonly shiftGroupOff: readonly ShiftGroupOffProjectionRow[];
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. §6's membership rule
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * **§6's table, as data** — which (subtype, status) pairs produce which row.
 *
 * Spelled as a record from subtype to the statuses that project, and the row
 * kind they project into, so a reader can lay it beside §6 and check it by eye.
 * `time-off` and `no-call` share a kind and a status list, and the sharing is
 * §6's own — they are one cell of its table.
 *
 * **`vacation-selection` is here on `reflected_in_version` and nothing else.**
 * §6's `HardOff` cell says "committed vacation", and §5.3's mapping makes
 * `committed` the selection status whose derived ROOT status is
 * `reflected_in_version`. So the root-side spelling of "committed vacation" is
 * exactly this pair, and expressing it in root terms is what lets one rule
 * decide the whole projection rather than two rules that have to agree.
 */
export const PROJECTION_RULE: {
  readonly [S in RequestSubtype]: {
    readonly kind: RequestProjectionKind;
    readonly statuses: readonly RequestStatus[];
  };
} = {
  'time-off': {
    kind: 'HardOff',
    statuses: ['approved', 'consumed_by_build', 'reflected_in_version'],
  },
  'no-call': {
    kind: 'HardOff',
    statuses: ['approved', 'consumed_by_build', 'reflected_in_version'],
  },
  /* "committed vacation", in the root vocabulary §5.3's mapping produces. */
  'vacation-selection': { kind: 'HardOff', statuses: ['reflected_in_version'] },
  availability: { kind: 'HardOn', statuses: ['approved', 'reflected_in_version'] },
  'shift-preference': {
    kind: 'SoftPreference',
    statuses: ['accepted_as_input', 'reflected_in_version'],
  },
  'shift-group-off': { kind: 'ShiftGroupOff', statuses: ['approved', 'reflected_in_version'] },
};

/**
 * **§6's exclusion list, made exhaustive against §2's status set.**
 *
 * §6 names seven — `draft`, `submitted`, `denied`, `withdrawn`, `expired`,
 * `unsatisfied`, `reversed` — and claims the list is exhaustive. It is
 * exhaustive of the statuses §6 DECIDED; §2's set has thirteen, and two of them
 * (`under_review`, `superseded_by_revision`) appear in neither of §6's lists.
 *
 * Both are excluded here, by name, and the reasoning is written rather than
 * assumed:
 *
 *  - **`under_review`** is an UNDECIDED state — §2's own reading of it, and the
 *    two-step's intermediate. A request nobody has decided is not an input to a
 *    schedule; §6's include lists start at `approved` for every subtype that has
 *    one, which is the same statement from the other side.
 *  - **`superseded_by_revision`** is a decision that has been reversed (§4's
 *    reversal row, M5-002's `reverse_decision`). A reversed decision is not a
 *    live promise, and projecting one would let a withdrawn approval keep
 *    constraining builds forever.
 *
 * Neither is a new rule: both follow §6's own principle that the projection
 * carries live promises. What is new is that they are STATED, so
 * `projectionDisposition` is total and a thirteenth-plus status added to §2
 * without a §6 disposition fails a test rather than defaulting to one.
 */
export const PROJECTION_EXCLUDED_STATUSES: readonly RequestStatus[] = [
  'draft',
  'submitted',
  'denied',
  'withdrawn',
  'expired',
  'unsatisfied',
  'reversed',
  /* Not in §6's printed list; see the docblock. */
  'under_review',
  'superseded_by_revision',
];

/**
 * **The projection's membership question, as a total function.**
 *
 * Returns the row kind a `(subtype, status)` pair projects into, or `null` when
 * it never enters the projection.
 *
 * Total in both arguments: every subtype has an entry in {@link PROJECTION_RULE}
 * and every status is either in that entry's list or is not projected. The
 * exhaustiveness this file claims is asserted rather than asserted-about —
 * `solver-projection.test.ts` walks the full (subtype × status) cross-product
 * and requires this function and {@link PROJECTION_EXCLUDED_STATUSES} to
 * partition it with no overlap and no gap.
 */
export function projectionDisposition(
  subtype: RequestSubtype,
  status: RequestStatus,
): RequestProjectionKind | null {
  const rule = PROJECTION_RULE[subtype];
  return rule.statuses.includes(status) ? rule.kind : null;
}

/** {@link projectionDisposition}, reduced to its boolean. For the cross-product. */
export function entersProjection(subtype: RequestSubtype, status: RequestStatus): boolean {
  return projectionDisposition(subtype, status) !== null;
}

/**
 * Every status §6 projects, for ANY subtype — the union of
 * {@link PROJECTION_RULE}'s status lists.
 *
 * Derived rather than listed, so it cannot disagree with the rule it summarises.
 * Its complement within `REQUEST_STATUSES` is exactly
 * {@link PROJECTION_EXCLUDED_STATUSES}, which is the partition the test asserts.
 */
export const PROJECTED_STATUSES: readonly RequestStatus[] = REQUEST_STATUSES.filter((status) =>
  Object.values(PROJECTION_RULE).some((rule) => rule.statuses.includes(status)),
);

/* ────────────────────────────────────────────────────────────────────────────
 * 3. FAD-60's weight table
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * **The preference-strength → objective-weight table (FAD-60).**
 *
 * Total over `REQUEST_PREFERENCE_STRENGTHS`, strictly monotone
 * (`low < medium < high`), and positive. Those three are the ruling; the values
 * are declared latitude against doc 08 §3.3's objective-term structure. See the
 * module header for why `1 / 2 / 4`, and for the routed obligation that the
 * CP-SAT term consuming it is a later packet's.
 *
 * Integers, not fractions: doc 08 §3.4 requires one global scale and
 * `scaleWeight` (`packages/domain/src/rules/objective.ts`) is the one converter.
 * A fractional table here would be a second, ad-hoc precision — the exact defect
 * §3.4 names.
 */
export const SOFT_PREFERENCE_WEIGHTS: {
  readonly [S in RequestPreferenceStrength]: number;
} = {
  low: 1,
  medium: 2,
  high: 4,
};

/**
 * The weight a `SoftPreference` row carries into the objective.
 *
 * A function over the closed set rather than a property lookup at each call
 * site, so the table has exactly one reader and a future scaling decision has
 * exactly one place to happen.
 */
export function softPreferenceWeight(strength: RequestPreferenceStrength): number {
  return SOFT_PREFERENCE_WEIGHTS[strength];
}
