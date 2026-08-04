import { randomUUID } from 'node:crypto';

import type { UnitOfWork } from '@schedulepoint/domain';
import { sql, type Kysely } from 'kysely';

import { recordAuditEvent } from '../audit/recorder.js';
import type { Database } from '../db/schema.js';
import {
  loadWeekdayTargets,
  loadWorkProfiles,
  workProfileWriteContext,
  type WeekdayTargetRow,
  type WorkProfileRow,
} from './in-force-loader.js';

/**
 * Authoring a membership's work profile (CAP-013).
 *
 * ## The one operation, and why there is only one
 *
 * There is no `updateWorkProfile`. Changing a member's arrangement means
 * **authoring a new row**, and if a row is already in force at the instant the
 * change takes effect, that row's open window is closed at exactly that instant.
 * Supersession, not mutation:
 *
 * ```
 *   ├─ 60%  ────────────────)[─ 80% ───────────────────────>
 *                            ↑
 *                  effective_from of the new row
 *                  = effective_to of the old one
 * ```
 *
 * Half-open windows (`[from, to)`) make those two instants the same value with no
 * gap and no overlap, which is why the EXCLUDE constraint uses `'[)'` and why the
 * domain's `containsInstant` does too.
 *
 * Everything else follows from that single shape:
 *
 *  - **history is never rewritten** — a closed row is untouchable, refused by
 *    `app_guard_work_profile_history` for the table owner and by a column-level
 *    grant for the runtime roles;
 *  - **an administrative correction is a new row**, with its own audit entry,
 *    taking effect from now;
 *  - **future-dated changes work with no special case**: the precondition asks
 *    which row is in force *at the future instant*, and closes that one.
 *
 * ## Two instants, one clock
 *
 * When the caller does not name an instant, the row is superseded and opened at
 * the **database's** `now()` — issued as SQL, never round-tripped through a
 * JavaScript `Date`. `now()` is `transaction_timestamp()`, constant for the whole
 * transaction, so the close and the open are byte-identical instants. Reading it
 * into JavaScript first would truncate PostgreSQL's microseconds to milliseconds
 * and could place the close a few hundred microseconds in the past — which
 * `app_guard_work_profile_history` correctly refuses as a retroactive close. The
 * bug would appear roughly once in a thousand requests, which is the worst
 * possible frequency.
 *
 * The JavaScript instant below is used only to ask the loader *which row* is in
 * force; millisecond truncation cannot change that answer.
 */

/**
 * Thrown when a caller names an `effectiveFrom` that has already passed.
 *
 * ## Why this exists, and why it is a SERVICE rule rather than a database one
 *
 * `app_guard_work_profile_history` refuses every UPDATE that would touch elapsed
 * time, so history cannot be *rewritten*. It says nothing about history being
 * **created**: an INSERT dated 2005 into a gap is a perfectly well-formed row that
 * the EXCLUDE constraint is happy with, and it changes what the in-force answer
 * *was* for a period that has already been scheduled against.
 *
 * An independent review found exactly that, against a contract comment which
 * claimed the database refused it. It did not, and it could not — the constraint
 * that would be needed (`effective_from >= now()` on INSERT) is not expressible as
 * a CHECK, because `now()` is not immutable. A BEFORE INSERT trigger could do it;
 * it is a service rule here because the ruling on this finding scoped
 * retroactive-history authoring OUT of this packet entirely, and the layer that
 * refuses it should be the layer that will later be given the capability to allow
 * it.
 *
 * **Retroactive authoring is a legitimate future administrative capability** —
 * "this person actually started at 60% in March" is a real thing an administrator
 * needs to record. It needs its own decision, a richer audit trail than this one,
 * and its own packet. Until then the answer is 422, and
 * `docs/evidence/EV-M2-PROFILES/INDEX.md` §5 carries it forward.
 */
export class RetroactiveEffectiveFromError extends Error {
  readonly code = 'WORK_PROFILE_RETROACTIVE_AUTHORING';

  constructor(requested: string, now: Date) {
    super(
      `WORK_PROFILE_RETROACTIVE_AUTHORING: effectiveFrom ${requested} is before the current ` +
        `instant ${now.toISOString()}; authoring history is not supported. Omit effectiveFrom ` +
        'to mean "now".',
    );
    this.name = 'RetroactiveEffectiveFromError';
  }
}

export interface WeekdayTargetInput {
  readonly day: WeekdayTargetRow['day'];
  readonly fteFraction: number;
  readonly maxAssignments?: number | null | undefined;
}

export interface AuthorWorkProfileInput {
  readonly membershipId: string;
  /** Omitted means "now", decided by the database. See the docblock. */
  readonly effectiveFrom?: string | undefined;
  readonly workPercentage: number;
  readonly maxAssignmentsPerWeek?: number | null | undefined;
  readonly maxAssignmentsPerPeriod?: number | null | undefined;
  readonly maxConsecutiveDays?: number | null | undefined;
  readonly weekdayTargets?: readonly WeekdayTargetInput[] | undefined;
}

export interface AuthoredWorkProfile {
  readonly profile: WorkProfileRow;
  readonly weekdayTargets: readonly WeekdayTargetRow[];
  readonly supersededProfileId: string | null;
}

/**
 * The transaction's own instant, as PostgreSQL sees it, truncated to
 * milliseconds.
 *
 * The truncation is not cosmetic. `now()` has microsecond resolution and a
 * JavaScript `Date` does not, so a bound written with bare `now()` comes back
 * from the API up to 999 µs earlier than it was stored — and the successor's
 * start is written from the predecessor's end, so that difference becomes a
 * sub-millisecond period with no profile in force. Every window bound this schema
 * chooses for itself is truncated the same way, including the column defaults and
 * the retroactive-close guard, so all three agree on what "now" is.
 */
export async function transactionNow(query: Kysely<Database>): Promise<Date> {
  const { rows } = await sql<{ now: Date }>`select date_trunc('milliseconds', now()) as now`.execute(
    query,
  );
  const now = rows[0]?.now;
  if (!(now instanceof Date)) {
    // Unreachable: `now()` cannot return NULL. Kept because silently falling back
    // to the process clock would reintroduce the two-clocks problem this function
    // exists to remove, and it would do it invisibly.
    throw new Error('the database did not return a transaction timestamp');
  }
  return now;
}

/**
 * Author a work profile inside the caller's unit of work.
 *
 * The authorization decision, the supersession, the insert, the weekday targets
 * and the audit rows all share the caller's transaction (FAD-12). A caller that
 * has already been denied never reaches this function.
 */
export async function authorWorkProfile(
  uow: UnitOfWork<Kysely<Database>>,
  input: AuthorWorkProfileInput,
): Promise<AuthoredWorkProfile> {
  const { query } = uow;
  const organizationId = uow.context.organizationId;
  const groupId = uow.context.groupId;
  if (groupId === null) {
    // Unreachable from the route, whose action is group-scoped and whose context
    // middleware refuses a group action without a group. Explicit because
    // `group_id` is NOT NULL and a null here would surface as a constraint error
    // that says nothing about the cause.
    throw new Error('a work profile requires a group-scoped unit of work');
  }

  /* ── the writer's precondition, from ONE load of the history ───────────────
   *
   * The same rows a reader sees, in the same transaction, through the same
   * module. `workProfileWriteContext` throws rather than choosing if two rows are
   * somehow in force at once, and a throw here rolls the whole transaction back —
   * so a supersession against corrupt effective dating writes nothing at all.
   *
   * `nextStart` comes from that same load, which is what lets an immediate change
   * coexist with an already-scheduled future one. Computing it from a second read
   * would be a second view of history, and two views of history is the S-01
   * defect wearing a different hat. */
  //
  // The transaction instant is read on EVERY path, not only when the caller named
  // no instant: it is also what the retroactive-authoring refusal compares
  // against, and comparing against the process clock would make the rule depend on
  // which machine served the request.
  const now = await transactionNow(query);
  const at = input.effectiveFrom === undefined ? now : new Date(input.effectiveFrom);

  /* ── T-01: history is not AUTHORED either ─────────────────────────────────
   *
   * Thrown before any statement that writes, so a refused request leaves neither a
   * row nor an audit entry — and inside the unit of work the throw rolls back
   * whatever else the caller had done. The equal case passes: a caller naming
   * exactly the current instant is asking for "now", which is what omitting the
   * field already means and is the spelling this contract recommends. */
  if (input.effectiveFrom !== undefined && at.getTime() < now.getTime()) {
    throw new RetroactiveEffectiveFromError(input.effectiveFrom, now);
  }

  const { inForce: superseded, nextStart } = await workProfileWriteContext(query, {
    organizationId,
    membershipId: input.membershipId,
    at,
  });

  // The truncated transaction instant when the caller named none; the caller's
  // instant otherwise. ONE expression, used for BOTH the close and the open, so
  // the two windows are exactly adjacent rather than nearly so.
  const effectiveFromExpr =
    input.effectiveFrom === undefined
      ? sql<Date>`date_trunc('milliseconds', now())`
      : new Date(input.effectiveFrom);

  if (superseded !== null) {
    /* ── the close, with the precondition ECHOED into the statement ──────────
     *
     * `id` alone would be enough for correctness today. The extra predicate is
     * the redundancy S-08 was missing — its UPDATE had no window predicate at all
     * and rewrote closed windows alongside the live one — but it is written as an
     * optimistic-concurrency echo rather than as `effective_to IS NULL`, because
     * the row being superseded is legitimately bounded whenever a later change is
     * already scheduled. Matching the value the precondition READ means the
     * statement refuses to act on a row that has moved since, whatever shape it
     * has moved into.
     *
     * A zero-row result is therefore a real failure, not a no-op, and it throws —
     * which rolls the transaction back rather than committing a successor beside
     * a predecessor that was never closed. */
    const closed = await query
      .updateTable('membership_work_profiles')
      .set({ effective_to: effectiveFromExpr, updated_at: sql<Date>`now()` })
      .where('organization_id', '=', organizationId)
      .where('id', '=', superseded.id)
      .where((eb) =>
        superseded.effectiveTo === null
          ? eb('effective_to', 'is', null)
          : eb('effective_to', '=', new Date(superseded.effectiveTo)),
      )
      .returning(['id'])
      .execute();

    if (closed.length !== 1) {
      throw new Error(
        'WORK_PROFILE_PRECONDITION_STALE: the row the precondition selected was no longer in the ' +
          'state it was read in; the transaction is rolled back',
      );
    }
  }

  const id = randomUUID();
  await query
    .insertInto('membership_work_profiles')
    .values({
      id,
      organization_id: organizationId,
      group_id: groupId,
      membership_id: input.membershipId,
      ...(input.effectiveFrom === undefined ? {} : { effective_from: effectiveFromExpr }),
      /* ── the new window's END, and why it is not always NULL ────────────────
       *
       * A change already scheduled for a later instant must still take effect
       * exactly when it was scheduled to. So an immediate change authored while a
       * future one is pending opens `[now, scheduled)` rather than `[now, ∞)`.
       *
       * Without this the insert is refused by the EXCLUDE constraint, and the
       * product's answer to "change this person's FTE today" becomes "not while
       * anything is scheduled" — which is not an answer. The bound comes from the
       * same load as the supersession decision, so the writer cannot bound
       * against one view of history and supersede against another. */
      effective_to: nextStart === null ? null : new Date(nextStart),
      // `numeric` takes a string: handing node-postgres a float64 is how a work
      // percentage acquires a rounding error on its way into a column chosen
      // precisely to avoid one.
      work_percentage: input.workPercentage.toFixed(2),
      max_assignments_per_week: input.maxAssignmentsPerWeek ?? null,
      max_assignments_per_period: input.maxAssignmentsPerPeriod ?? null,
      max_consecutive_days: input.maxConsecutiveDays ?? null,
    })
    .execute();

  /* ── T-02: OMITTED means CARRY FORWARD; `[]` means CLEAR ───────────────────
   *
   * The most common administrative call is "reduce this person to 60%" — a
   * supersession that names a percentage and nothing else. The first version of
   * this service inserted the new profile version with NO weekday targets in that
   * case, so the ordinary FTE change silently destroyed the per-weekday and
   * holiday dimension that CAP-013 exists to hold and that the M4 engine will
   * consume. An independent review found it; nothing failed, because losing data
   * the caller did not mention looks exactly like not being asked for it.
   *
   * The distinction is between "did not say" and "said none", and the contract
   * preserves it deliberately:
   *
   *   `weekdayTargets` omitted    -> the predecessor's targets are copied onto the
   *                                  new version. A change of percentage is not a
   *                                  statement about which days are worked.
   *   `weekdayTargets: []`        -> cleared, on purpose. Saying "none" is a
   *                                  decision and is honoured as one.
   *   `weekdayTargets: [...]`     -> replaced wholesale.
   *
   * Copies, never shared rows: the targets belong to a profile VERSION, so the
   * predecessor keeps its own and remains exactly as readable as it was. */
  const carriedForward = input.weekdayTargets === undefined && superseded !== null;
  const targets: readonly WeekdayTargetInput[] = carriedForward
    ? (
        await loadWeekdayTargets(query, {
          organizationId,
          workProfileIds: [superseded.id],
        })
      ).map((target) => ({
        day: target.day,
        fteFraction: target.fteFraction,
        maxAssignments: target.maxAssignments,
      }))
    : (input.weekdayTargets ?? []);

  if (targets.length > 0) {
    await query
      .insertInto('membership_weekday_fte')
      .values(
        targets.map((target) => ({
          id: randomUUID(),
          organization_id: organizationId,
          group_id: groupId,
          work_profile_id: id,
          day: target.day,
          fte_fraction: target.fteFraction.toFixed(3),
          max_assignments: target.maxAssignments ?? null,
        })),
      )
      .execute();
  }

  // Read back through the ONE loader rather than reconstructing the row from the
  // input. What the caller is told is what the database holds — including the
  // instants the database chose, which the caller never saw. It is read BEFORE the
  // audit rows are written, because the `after` half of the payload has to be what
  // was actually stored rather than what was asked for.
  const all = await loadWorkProfiles(query, { organizationId, membershipId: input.membershipId });
  const written = all.find((row) => row.id === id);
  if (written === undefined) {
    throw new Error('the work profile was not readable after it was written');
  }
  const weekdayTargets = await loadWeekdayTargets(query, {
    organizationId,
    workProfileIds: [id],
  });
  const closedRow = superseded === null ? null : all.find((row) => row.id === superseded.id);

  /* ── audit: two events, because a supersession is two facts ────────────────
   *
   * "A new profile was authored" and "the previous one stopped applying on the
   * 1st" are different questions asked by different people, and one row cannot
   * answer both. The superseded row is its own subject so that "everything that
   * happened to this profile version" is answerable.
   *
   * ## The payloads carry BEFORE and AFTER, and a `mechanism`
   *
   * The packet's audit requirement names five fields: actor, on-behalf-of,
   * before/after, mechanism, correlation id. Four of them come from `uow.context`
   * inside the recorder and from the chain columns; **before/after and mechanism
   * are the two that have to be supplied**, and the first version of this service
   * supplied neither — an event that says only "a profile was authored" cannot
   * answer "what changed", which is the question every audit review actually asks.
   *
   * ## What is deliberately NOT in them (I-07, and the payload is closed)
   *
   * `assertClosedAuditPayload` refuses any string with a space, anything over 64
   * characters, and anything non-scalar. That is not an obstacle to work around —
   * it is the rule, and it is the reason these payloads carry identifiers,
   * enum tokens, ISO instants and numbers and nothing else. No name, no free text,
   * and no display value of any kind appears here or could.
   *
   * `'open'` and `'unset'` are tokens rather than `null` because the payload
   * admits no nulls; they are distinguishable from any instant or number. */
  if (superseded !== null) {
    await recordAuditEvent(uow, {
      eventName: 'staffing.work_profile.superseded',
      subjectType: 'work_profile',
      subjectId: superseded.id,
      payload: {
        mechanism: 'supersede',
        membershipId: input.membershipId,
        beforeEffectiveTo: superseded.effectiveTo ?? 'open',
        afterEffectiveTo: closedRow?.effectiveTo ?? 'open',
        beforeWorkPercentage: superseded.workPercentage,
        supersededByProfileId: id,
      },
    });
  }
  await recordAuditEvent(uow, {
    eventName: 'staffing.work_profile.authored',
    subjectType: 'work_profile',
    subjectId: id,
    payload: {
      mechanism: superseded === null ? 'create' : 'supersede',
      membershipId: input.membershipId,
      beforeProfileId: superseded?.id ?? 'none',
      beforeWorkPercentage: superseded?.workPercentage ?? 'none',
      afterWorkPercentage: written.workPercentage,
      afterEffectiveFrom: written.effectiveFrom,
      afterEffectiveTo: written.effectiveTo ?? 'open',
      afterMaxPerWeek: written.maxAssignmentsPerWeek ?? 'unset',
      afterMaxPerPeriod: written.maxAssignmentsPerPeriod ?? 'unset',
      afterMaxConsecutiveDays: written.maxConsecutiveDays ?? 'unset',
      afterWeekdayTargetCount: weekdayTargets.length,
      // T-02 made visible in the record: whether the targets on this version were
      // stated by the caller or inherited from the version it replaced.
      weekdayTargetsCarriedForward: carriedForward,
    },
  });

  return { profile: written, weekdayTargets, supersededProfileId: superseded?.id ?? null };
}
