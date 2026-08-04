/**
 * **The one implementation of "which row is in force at instant T".**
 *
 * ## Why this module exists, in one paragraph
 *
 * `docs/evidence/EV-M1-AUTHZ` finding S-01: `entitlements` is effective-dated, the
 * loader read it with no window predicate and no total order, and whichever row
 * PostgreSQL happened to return last won. The consequence, reproduced end to end
 * by an independent reviewer, was that **one legitimate administrative write made
 * every action in a module 404 organization-wide** — no exception raised, nothing
 * in the logs, and nothing pointing at the entitlement table. The write path had
 * the mirror defect: it UPDATEd every row for the module, rewriting windows that
 * had closed months earlier.
 *
 * `membership_work_profiles` is the same shape with more rows and a longer life.
 * So the selection rule is written **once**, here, in the domain, with no
 * database and no I/O — and every reader and **every writer's precondition check**
 * calls it. A second selection rule somewhere else is the defect; a shared one
 * cannot disagree with itself.
 *
 * ## The rules, in full
 *
 *  1. **Windows are half-open, `[from, to)`.** Identical to the `tstzrange(...,
 *     '[)')` in the EXCLUDE constraint and to what SPEC-06's evaluator already
 *     uses at every layer, so an instant is in exactly one window and end-dating a
 *     row by starting its replacement at the same instant produces no gap and no
 *     overlap. An instant exactly equal to `from` is IN; an instant exactly equal
 *     to `to` is OUT.
 *  2. **`null` is the only spelling of an open end.** `'infinity'` is rejected by
 *     a CHECK constraint in the migration (S-22) and by `parseInstant` here, and
 *     an *unparsable* upper bound is **not** treated as open-ended — that would
 *     make a corrupt row confer unlimited validity.
 *  3. **There is no tie-break.** If two rows are in force at the same instant the
 *     EXCLUDE constraint has been dropped or bypassed, and picking one of them is
 *     how S-01 stayed invisible for a milestone. `selectInForce` returns
 *     `ambiguous` and `requireInForce` throws. `LIMIT 1` does not appear anywhere
 *     in this codebase's profile paths, with or without an `ORDER BY`.
 *  4. **"No row in force" is not one outcome.** A gap between two closed windows,
 *     an instant before the first row starts, an instant after the last row ends,
 *     and no rows at all are four different facts about the data, and collapsing
 *     them is what makes an effective-dating bug unreadable from a log line. Each
 *     is reported by name.
 *
 * ## What lives here and what does not
 *
 * Pure functions over plain data: no `Date` arithmetic beyond `Date.parse`, no
 * clock, no database handle. The SQL that fetches candidate rows is
 * `apps/api/src/profiles/in-force-loader.ts`, which is the only module allowed to
 * issue it — a structural test asserts that no other module selects from the
 * effective-dated tables (`apps/api/test/profiles/loader-is-the-only-selector.test.ts`).
 */

/* ────────────────────────────────────────────────────────────────────────────
 * The shape every effective-dated row has
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The minimum an effective-dated row must expose to be selectable.
 *
 * Deliberately structural rather than a base class: `qualification_holdings`
 * spells its columns `valid_from` / `valid_until` and `membership_work_profiles`
 * spells them `effective_from` / `effective_to`, and both map onto this at the
 * loader boundary. One window predicate, two tables, no second implementation.
 */
export interface EffectiveDated {
  /** Stable row identity. Present so an outcome can name the row it chose. */
  readonly id: string;
  /** ISO-8601 instant, inclusive. */
  readonly effectiveFrom: string;
  /** ISO-8601 instant, EXCLUSIVE. `null` means open-ended. */
  readonly effectiveTo: string | null;
}

/** Why no row was in force. Four distinct facts, never collapsed into one. */
export type NoRowReason =
  /** The candidate set was empty. */
  | 'no-rows'
  /** `at` precedes the earliest row's start. */
  | 'before-first'
  /** `at` is at or after the last window's end, and no window is open. */
  | 'after-last'
  /** `at` falls between two closed windows. */
  | 'gap';

export type InForceSelection<T extends EffectiveDated> =
  | { readonly kind: 'in-force'; readonly row: T }
  | {
      readonly kind: 'none';
      readonly reason: NoRowReason;
      /**
       * The row the caller most likely means, for a diagnostic — the most
       * recently ended one, or the earliest future one when nothing has started.
       * `null` when there are no rows at all.
       *
       * **It is never returned as if it were in force.** The distinction is the
       * one S-01 lost: the entitlement loader had to fall back to a nearby row so
       * SPEC-06 L1.3 could report `ENTITLEMENT_EXPIRED` rather than
       * `NOT_ENTITLED`, and a caller that treats a fallback as a verdict
       * reintroduces the defect. Here the fallback is on a differently-named
       * field of a differently-shaped outcome, so it cannot be read by accident.
       */
      readonly nearest: T | null;
    }
  | {
      /**
       * More than one row is in force. The EXCLUDE constraint makes this
       * unreachable through the database; it is reported rather than resolved
       * because a silent choice here is exactly the S-01 defect.
       */
      readonly kind: 'ambiguous';
      readonly rows: readonly T[];
    };

/* ────────────────────────────────────────────────────────────────────────────
 * Instants
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Milliseconds since the epoch, or `null` when the value is not a usable instant.
 *
 * `Date.parse` accepts a lot; what matters is that everything it cannot turn into
 * a finite number becomes `null`, and every caller treats `null` as "this bound
 * cannot be trusted" rather than as a default in either direction.
 *
 * The literal strings `infinity` / `-infinity` are called out because
 * `timestamptz` accepts them and node-postgres hands them back as the JavaScript
 * numbers `Infinity` / `-Infinity`. They are refused at the CHECK level in the
 * migration; this is what survives a row written before that constraint existed,
 * and the same belt-and-braces `load-policy-input.ts` carries for the same reason.
 */
export function parseInstant(value: string): number | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'infinity' || normalized === '-infinity' || normalized === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Is `at` inside this row's half-open window?
 *
 * **The single window predicate.** Every reader, every writer precondition, the
 * profile selector and the holdings filter all reach the boundary rules through
 * this one function, so "in force" means the same thing in all of them by
 * construction rather than by four authors agreeing.
 *
 * A row whose `effectiveFrom` will not parse is never in force: an unusable lower
 * bound cannot be shown to have been reached. A row whose `effectiveTo` will not
 * parse is never in force either — treating it as open-ended would let a corrupt
 * upper bound confer permanent validity, which is the fail-open direction.
 */
export function containsInstant(row: EffectiveDated, at: Date): boolean {
  const instant = at.getTime();
  if (!Number.isFinite(instant)) return false;

  const from = parseInstant(row.effectiveFrom);
  if (from === null || instant < from) return false;

  if (row.effectiveTo === null) return true;
  const to = parseInstant(row.effectiveTo);
  if (to === null) return false;
  return instant < to;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Single-row selection — `membership_work_profiles`
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The row in force at `at`, or a named reason there is none.
 *
 * Order-independent: the answer depends only on the SET of rows and the instant,
 * never on the order the database returned them. That is asserted directly
 * (`packages/domain/test/profiles/in-force.test.ts`, "order independence"), because
 * "we always ORDER BY" is a property of today's query and this must be a property
 * of the rule.
 */
export function selectInForce<T extends EffectiveDated>(
  rows: readonly T[],
  at: Date,
): InForceSelection<T> {
  if (rows.length === 0) return { kind: 'none', reason: 'no-rows', nearest: null };

  const inForce = rows.filter((row) => containsInstant(row, at));
  if (inForce.length === 1) {
    // Non-null by the length check; written this way so the array index is not
    // an assertion the type system has to be told to trust.
    const [only] = inForce;
    if (only !== undefined) return { kind: 'in-force', row: only };
  }
  if (inForce.length > 1) return { kind: 'ambiguous', rows: inForce };

  return { kind: 'none', reason: noRowReason(rows, at), nearest: nearestRow(rows, at) };
}

/**
 * Which of the four "no row" facts this is.
 *
 * Rows whose lower bound will not parse are excluded from the reasoning entirely:
 * they cannot place `at` before, after or between anything.
 */
function noRowReason(rows: readonly EffectiveDated[], at: Date): NoRowReason {
  const instant = at.getTime();
  const usable = rows
    .map((row) => ({ from: parseInstant(row.effectiveFrom), to: row.effectiveTo === null ? null : parseInstant(row.effectiveTo) }))
    .filter((row): row is { from: number; to: number | null } => row.from !== null);

  if (usable.length === 0) return 'no-rows';

  const earliestStart = Math.min(...usable.map((row) => row.from));
  if (instant < earliestStart) return 'before-first';

  // An open-ended row exists and `at` is not in it, so `at` precedes its start —
  // already handled above unless another row starts earlier, which makes this a gap.
  const started = usable.filter((row) => row.from <= instant);
  const anyOpenAfter = usable.some((row) => row.to === null && row.from > instant);
  if (anyOpenAfter) return 'gap';

  const latestEnd = Math.max(...started.map((row) => (row.to === null ? Number.POSITIVE_INFINITY : row.to)));
  const anyStartsLater = usable.some((row) => row.from > instant);
  if (instant >= latestEnd && anyStartsLater) return 'gap';
  return 'after-last';
}

/** The most recently ended row, or the earliest future one when nothing has started. */
function nearestRow<T extends EffectiveDated>(rows: readonly T[], at: Date): T | null {
  const instant = at.getTime();
  const withFrom = rows
    .map((row) => ({ row, from: parseInstant(row.effectiveFrom) }))
    .filter((entry): entry is { row: T; from: number } => entry.from !== null);
  if (withFrom.length === 0) return null;

  const started = withFrom.filter((entry) => entry.from <= instant);
  if (started.length > 0) {
    return started.reduce((best, entry) => (entry.from > best.from ? entry : best)).row;
  }
  return withFrom.reduce((best, entry) => (entry.from < best.from ? entry : best)).row;
}

/**
 * The start instant of the earliest window that begins **strictly after** `from`,
 * or `null` when none does.
 *
 * ## Why a writer cannot do without this
 *
 * Authoring a change today while a change is already scheduled for the 1st of
 * next month is an ordinary thing to want. Without this rule the new row is
 * opened `[today, ∞)`, the scheduled row is `[1st, ∞)`, and the EXCLUDE
 * constraint refuses the insert — so the product's answer to "change this
 * person's FTE now" becomes "not while anything is scheduled", which is not an
 * answer.
 *
 * With it, the new row is `[today, 1st)` and the scheduled change still takes
 * effect exactly when it was scheduled to. The bound is computed from the same
 * loaded rows as the supersession decision, by the same module, so a writer
 * cannot bound a window against one view of history and supersede against
 * another.
 *
 * Rows with an unparsable lower bound are ignored: an instant that cannot be read
 * cannot be a boundary.
 */
export function nextWindowStart(rows: readonly EffectiveDated[], from: Date): string | null {
  const after = from.getTime();
  if (!Number.isFinite(after)) return null;

  let earliest: { instant: number; iso: string } | null = null;
  for (const row of rows) {
    const start = parseInstant(row.effectiveFrom);
    if (start === null || start <= after) continue;
    if (earliest === null || start < earliest.instant) {
      earliest = { instant: start, iso: row.effectiveFrom };
    }
  }
  return earliest?.iso ?? null;
}

/** Thrown when two rows are in force at once — the EXCLUDE constraint is gone. */
export class AmbiguousInForceError extends Error {
  readonly rowIds: readonly string[];

  constructor(rowIds: readonly string[], at: Date) {
    super(
      `AMBIGUOUS_IN_FORCE: ${String(rowIds.length)} rows are in force at ${at.toISOString()} ` +
        `(${rowIds.join(', ')}). The non-overlap constraint has been dropped or bypassed; ` +
        'refusing to choose one.',
    );
    this.name = 'AmbiguousInForceError';
    this.rowIds = rowIds;
  }
}

/**
 * The row in force, or `null` — throwing rather than choosing when the data is
 * ambiguous.
 *
 * **This is what writers' precondition checks call, and readers call it too.**
 * That is the whole point: the row a writer decided to supersede and the row a
 * reader reports are produced by the same call on the same rows in the same
 * transaction, so they cannot be different rows.
 *
 * It throws on `ambiguous` deliberately. Inside a unit of work, throwing rolls the
 * transaction back — so a supersession attempted against corrupt effective-dating
 * writes nothing at all, which is the only safe outcome. Returning would let the
 * caller "handle" it and commit.
 */
export function requireInForce<T extends EffectiveDated>(rows: readonly T[], at: Date): T | null {
  const selection = selectInForce(rows, at);
  if (selection.kind === 'ambiguous') {
    throw new AmbiguousInForceError(
      selection.rows.map((row) => row.id),
      at,
    );
  }
  return selection.kind === 'in-force' ? selection.row : null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Multi-row selection — `qualification_holdings`
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Every row whose window contains `at`.
 *
 * Holdings are deliberately **not** single-valued: a renewal is routinely issued
 * before the previous certificate expires, so two valid holdings of one
 * qualification overlapping is correct data rather than a constraint failure. The
 * question a holding answers is "is this member credentialed at T", which is an
 * existence question — so the arity differs from `selectInForce` while the window
 * rule, `containsInstant`, is literally the same function.
 *
 * Order-preserving: the caller's order is the result's order, and no row is
 * dropped for being a duplicate of another.
 */
export function filterInForce<T extends EffectiveDated>(rows: readonly T[], at: Date): readonly T[] {
  return rows.filter((row) => containsInstant(row, at));
}

/** Holding statuses that confer eligibility. `revoked`, `expired` and `pending` do not. */
export const ELIGIBLE_HOLDING_STATUSES = ['valid', 'expiring'] as const;
export type EligibleHoldingStatus = (typeof ELIGIBLE_HOLDING_STATUSES)[number];

export interface HoldingLike extends EffectiveDated {
  readonly status: string;
}

/**
 * Is this membership credentialed for the qualification at `at`?
 *
 * Two conditions, and both are load-bearing: the window must contain the instant
 * **and** the status must be one that confers eligibility. A revoked credential
 * keeps its window exactly as issued — revocation moves `status` and nothing else,
 * so rewriting what the credential said is never necessary — which means the
 * status check is what actually stops a revoked holding conferring eligibility.
 *
 * CAP-058's open question is recorded rather than resolved here: eligibility "must
 * be evaluated at the shift date, not at request time". `at` is therefore a
 * parameter with no default. Nothing in this module reads a clock.
 */
export function isEligibleAt(holdings: readonly HoldingLike[], at: Date): boolean {
  return filterInForce(holdings, at).some((holding) =>
    (ELIGIBLE_HOLDING_STATUSES as readonly string[]).includes(holding.status),
  );
}
