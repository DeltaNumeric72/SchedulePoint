import { solverInputSnapshotSchema } from '@schedulepoint/contracts';
import {
  resolveLocalTime,
  type SolverInputSnapshotDocument,
  type UnitOfWork,
} from '@schedulepoint/domain';
import type { Kysely } from 'kysely';

import { lockAuditOrdering } from '../audit/recorder.js';
import type { BuildRunState, Database } from '../db/schema.js';
import { requireScheduleCapability, type ScheduleActor } from '../schedule/actions.js';
import { calendarDate } from '../schedule/render.js';
import { addManualAssignment as addAssignment, createDraftVersion } from '../schedule/service.js';
import { readSnapshot } from '../solver/snapshot-store.js';
import { BuildInputsMovedError, BuildPreconditionError, BuildSourceMovedError } from './errors.js';
import { buildStaleness } from './staleness.js';
import {
  assertExpectedState,
  loadRunForUpdate,
  sourceDigestOf,
  transitionRun,
  type BuildRunRow,
} from './service.js';

/**
 * **Selection: `approved → applied_to_draft_schedule`** (doc 35 §6e Required
 * behaviour 5).
 *
 * ## What this does, and the four things it must never do
 *
 * It creates a **NEW draft version** through the schedule module's own
 * `createDraftVersion` and writes the approved candidate into it. Then it stops.
 *
 *  1. **It never mutates a published version** (I-18, non-bypass rule 5). It
 *     does not touch the source version either — not its rows, not its state.
 *     The new draft is a new proposal; the source stays exactly as the scheduler
 *     left it, which is what makes "compare the build against what I had"
 *     answerable afterwards.
 *  2. **It never publishes.** The draft then flows M3's normal review and
 *     publication path, unchanged. This packet adds no publication surface.
 *  3. **It never runs twice into one version.** D-4d — the partial unique index
 *     on `(applied_to_version_id) WHERE NOT NULL` — is the control, and two
 *     concurrent selections therefore produce one winner and one 23505.
 *  4. **It never silently overwrites an edit.** FAD-26(2)'s second
 *     compare-and-set: the caller states the source draft's material-input
 *     digest as it believed it to be. If the draft moved between the build and
 *     the selection, the answer is `STALE_BUILD_SOURCE` and not a schedule that
 *     quietly discarded somebody's work.
 *
 *     That sentence was **false as worded** until R4-REV-2, and the mirror of
 *     REV-A-003 is why: the compare-and-set was evaluated OUTSIDE the ordering
 *     domain, so an ordinary audited edit of the source draft could be held
 *     behind the audit advisory lock, commit while the selection waited for it,
 *     and be discarded by a selection that had already compared a digest read
 *     one statement earlier. It is now evaluated TWICE — once where it always
 *     was, and once under the locks — and the second evaluation is what makes
 *     the promise true rather than likely. The permanent proof is the
 *     "THE SOURCE WINDOW" arm of `selection-window-ordering.test.ts`.
 *
 * ## ONE assignment write path (FAD-44(1))
 *
 * Every row this function writes goes through `addAssignment` — the schedule
 * module's own writer, the same one the cell editor calls — with
 * `origin: 'solver'`.
 *
 * It did not, at first. `addManualAssignment` wrote `origin: 'manual'` on both
 * the identity and the snapshot with no parameter to say otherwise, so selection
 * had a choice between recording every solver-produced assignment as a manual
 * one — the exact conflation non-bypass rule 7 exists to prevent, and one that
 * would also destroy the distinction report 21 §5 draws between "locked manual
 * assignments" and "locked prior solver assignments" for the NEXT progressive
 * stage — and writing the rows here, which is a second spelling of the write
 * path: the S-01 defect class, applied to writes.
 *
 * FAD-44(1) granted the parameter and ruled the refactor. What this buys, beyond
 * tidiness: the interval guard, `assertAssignableMembership`'s R-B1/R-B2 checks,
 * `assertEditable`'s draft-only refusal, the shift lookup-or-create, and the
 * `schedule.assignment.added` audit event are now reached by the solver path
 * too, because there is only one path to reach. Previously each was either
 * duplicated or silently skipped.
 *
 * ## Credits: a build-produced draft STARTS WITHOUT CREDITS — the ruling, not a gap
 *
 * **doc 35 §6f ruling (1), closing the FAD-44(4) carried question.** M4-003
 * left this open and said so; it is now decided, and the decision is that the
 * absence is CORRECT rather than merely convenient:
 *
 *  * a credit records **human adjudication of burden** (doc 07). It is somebody
 *    deciding that a person carried something. A schedule produced by
 *    optimization has not been adjudicated by anyone yet;
 *  * the solver's fairness terms **read** prior-period credit history from the
 *    snapshot — that is exactly what `fairnessDispersion`'s `priorCredits` are —
 *    and they never write credits. Manufacturing credits from a build would
 *    launder an objective value into a human record, and the next build would
 *    then read its own output back as history;
 *  * mechanically it could not be honest anyway: `cloneCredits` maps credits by
 *    the SOURCE version's snapshot rows, and a build-produced draft's snapshot
 *    set is generated rather than cloned, so a copied credit could point at an
 *    assignment the solver did not reproduce.
 *
 * The scheduler assigns credits on the new draft through the existing M3
 * surfaces, which continue to work on it unchanged. **FAD-32(6) — voided credits
 * are cloned — continues to govern CLONES only**; a build-produced draft is a
 * new version, not a clone, and the two paths stay distinct.
 *
 * Pinned both ways: `e2-quality-and-credits.test.ts` asserts that
 * apply-selection produces ZERO credit rows, and that the M3 credit surface then
 * writes one on the resulting draft.
 */

type Uow = UnitOfWork<Kysely<Database>>;

export interface ApplyCandidateResult {
  readonly run: BuildRunRow;
  readonly draftVersionId: string;
  readonly assignmentsWritten: number;
  /** R-8: how many written rows carried a real pick position through. */
  readonly pickPositionsCarried: number;
}

export async function applyCandidateToNewDraft(
  uow: Uow,
  actor: ScheduleActor,
  buildRunId: string,
  expectedState: BuildRunState,
  expectedSourceDigest: string,
): Promise<ApplyCandidateResult> {
  await requireScheduleCapability(uow, actor, 'versionEdit');

  const run = await loadRunForUpdate(uow, buildRunId);
  if (run === null) {
    throw new BuildPreconditionError(
      'BUILD_RUN_NOT_FOUND',
      `no build run ${buildRunId} is visible in this group`,
    );
  }
  assertExpectedState(run, expectedState);

  /* The CAS comes BEFORE anything is created. A draft created and then abandoned
   * because the source moved would leave an orphan version in the period's list
   * for a scheduler to wonder about.
   *
   * **This evaluation stays exactly here, and R4-REV-2 did not move it.** It is
   * what decides the answer for a source that had ALREADY moved when the
   * selection began, and that answer is `STALE_BUILD_SOURCE` even when an input
   * moved too — the precedence this position has always given. The second
   * evaluation added below is strictly additional: it refuses a case that used
   * to APPLY, and it changes the answer to nothing that previously refused. */
  const currentDigest = await sourceDigestOf(uow, run);
  if (currentDigest !== expectedSourceDigest) throw new BuildSourceMovedError(currentDigest);

  /* ── The ordering domain, entered BEFORE staleness is read ─────────────────
   *
   * What follows is a read-then-write: read staleness, then write a draft. A
   * verdict another transaction can invalidate between the read and the write is
   * not a control, and REV-A-003 demonstrated that deterministically rather than
   * by racing.
   *
   * `createDraftVersion` writes an audit event, and migration 0003's chain
   * trigger takes the per-organization audit advisory lock — so the lock used to
   * be acquired AFTER this read. Any audited transaction holds that lock from its
   * first audit write until it commits, so a concurrent same-organization
   * transaction (a catalogue edit both writes an audit event and moves a build
   * constituent) could hold it across the window, move a constituent, commit
   * while the selection waited, and let the selection write a draft from a world
   * that no longer existed — the same run reading `stale` one statement later,
   * with nothing on any screen saying so. That falsified doc 35 §6g ruling 4,
   * whose word is ABSOLUTE.
   *
   * Acquiring the SAME lock here puts the verdict and the write in one order —
   * the order the audit chain is already in. A same-organization transaction
   * that moves a constituent writes an audit event too, so it either committed
   * before this line, and the verdict below sees it, or it cannot commit until
   * this transaction has, and it is ordered AFTER this draft rather than
   * invisibly inside it.
   *
   * **It works because the unit of work is READ COMMITTED.** `PgUnitOfWorkRunner`
   * issues a plain `BEGIN`, so each statement below takes a NEW snapshot and the
   * staleness read therefore sees what committed while this transaction waited
   * for the lock. Under REPEATABLE READ the same code would read the pre-lock
   * snapshot and this repair would silently do nothing — the isolation level is
   * a premise of the fix, not an incidental property of it.
   *
   * **The period row lock immediately below is part of the fix, not decoration.**
   * Migration 0017 §3 records the rule the whole codebase holds to: a row lock is
   * taken BEFORE the per-organization audit advisory lock, in every shipped
   * writer. Acquiring the audit lock here would invert that for one row —
   * `createDraftVersion`'s `INSERT INTO schedule_versions` takes `FOR KEY SHARE`
   * on this period through the composite FK (migration 0009), while
   * `transitionPeriodStatus` and `publishVersion` take that same period row `FOR
   * UPDATE` and audit afterwards. Selection holding the audit lock and wanting
   * the period row, against a period writer holding the period row and wanting
   * the audit lock, is a cycle, and it was REPRODUCED as `40P01` before this
   * line existed. Taking the period lock first — in the mode the FK will take
   * microseconds later — restores row-then-audit here, so this writer acquires
   * the two locks in the same order as every other one and the acquisition move
   * adds no inverted edge. Re-taking either lock later in the transaction (the
   * FK's KEY SHARE, the trigger's advisory lock) is then a no-op on a lock this
   * transaction already holds.
   *
   * **Placement, and it is deliberate.** After the digest CAS, so that a moved
   * INPUT still refuses as `STALE_BUILD_INPUTS` and not as the source refusal:
   * the two answer different questions and errors.ts says why collapsing them
   * sends half of the schedulers to the wrong place. (The digest CAS keeps the
   * evaluation position it has always had; R4-REV-2 added a SECOND evaluation
   * of it below the staleness verdict rather than moving this one, and the
   * order of the two refusals is argued where the second one is written.)
   *
   * **The premise, stated rather than assumed.** The guarantee is exactly as
   * wide as "a transaction that moves a constituent records that it did, in the
   * same transaction". That is non-bypass rule 6 as a habit, plus ONE partial
   * scan: `test/audit/emission-coverage.test.ts` checks module-granular write
   * coverage under `src/http/routes`, `src/jobs` and `src/profiles` only. A
   * constituent moved from a module outside those three roots — or by a
   * statement the scan's mutation detector does not match — would not be caught
   * by that gate, and this ordering would not see it either.
   *
   * **The cost, measured where it was measured — and the span named.** The
   * audit lock is now held across `buildStaleness`, which re-runs the whole
   * canonical-input assembly, and every audited write of the same organization
   * blocks for that whole span. On the test fixture the SELECTION TRANSACTION
   * measures **49–71 ms** across both variants (R-4 alone 60/49/57 ms; R-4 plus
   * the R4-REV-2 re-read 71/64/66 ms), from the R-4b review's measurement.
   *
   * An earlier note here said ~310–380 ms, and that figure is SUPERSEDED: it was
   * the CONTROL test case's duration — fixture build, read-backs and apply — not
   * the transaction. It is corrected rather than deleted because a control
   * document that quietly swaps a number teaches nobody which span was measured.
   *
   * **The LOCK HOLD is a subset of the transaction and has NOT been isolated as
   * its own measurement.** Everything above the acquisition — the capability
   * check, the run load, the pre-lock digest CAS — is outside the hold, so the
   * hold is shorter than these figures and by an unmeasured amount. The
   * assembly's cost at a realistic tenant size is UNMEASURED, and the hold grows
   * with it. */
  await lockPeriodBeforeAudit(uow, run.period_id);
  await lockAuditOrdering(uow);

  /* ── doc 35 §6g ruling 4, and it is ABSOLUTE ────────────────────────────────
   *
   * The digest above answers "did the SOURCE DRAFT move?". It says nothing about
   * the rules, the catalogue, the profiles, the qualifications, the demand, the
   * timezone, the locations or the participants — every one of which is an input
   * this build was posed against, and every one of which can move between the
   * solve and the click.
   *
   * A candidate applied over moved inputs is a schedule computed from a world
   * that no longer exists, and NOTHING on any screen would say so. The ruling
   * therefore forbids it outright: a build with any changed input revision "can
   * NEVER silently become the current draft".
   *
   * The refusal is typed and carries the changes, because "your inputs moved" is
   * unactionable and "the MinimumRestBetween rule moved from revision 3 to 4" is
   * a thing a scheduler can decide about — the same reason the assembly refusals
   * are itemised rather than counted. The remedy is a NEW build, which is
   * already how SPEC-04 §2 says a re-posed problem is expressed. */
  const staleness = await buildStaleness(uow, run);
  if (staleness.stale) throw new BuildInputsMovedError(staleness);

  /* ── R4-REV-2: the SAME compare-and-set, re-evaluated INSIDE this domain ────
   *
   * The mirror of REV-A-003, and it was demonstrated the same way rather than
   * argued. R-4 brought the STALENESS verdict inside the ordering domain and
   * left the source-digest compare-and-set outside it, so the window simply
   * moved one check to the left: a transaction holding this organization's audit
   * lock performs an ordinary audited edit of the SOURCE DRAFT — the cell
   * editor's own `addManualAssignment` — which moves the material-input digest
   * and moves NO 0016 constituent. The selection reads the digest pre-edit,
   * blocks at the lock, the editor commits, the staleness verdict is honestly
   * `fresh`, and the selection APPLIES over an edit it never saw. That falsified
   * this function's own item 4: "not a schedule that quietly discarded somebody's
   * work".
   *
   * Re-reading it here closes that, and for the same reason the staleness read
   * above is here: a transaction that moves the source draft WRITES AN AUDIT
   * EVENT (every schedule writer does — `schedule.assignment.added` and its
   * siblings), so it holds this lock until it commits. It therefore either
   * committed before the grant, and this READ COMMITTED re-read — a new
   * statement, a new snapshot — sees it; or it cannot commit until this
   * transaction has, and it is ordered AFTER this draft rather than invisibly
   * inside it. The premise is exactly as wide as it is for staleness, and it is
   * stated in the same place: a mover that does not audit is not ordered.
   *
   * **The refusal is the EXISTING one.** `BuildSourceMovedError` /
   * `STALE_BUILD_SOURCE`, carrying the digest as read here. "The draft you were
   * building on has been edited" is the same fact whichever side of the lock
   * grant the edit landed on, and a second refusal kind for the same condition
   * would be a second thing for a client to handle and a second thing to
   * document — the S-01 defect class, applied to refusals.
   *
   * ## Why BELOW the staleness verdict, and it is load-bearing
   *
   * The two refusals are ordered by POSITION, and three cases fix the order
   * between them:
   *
   *  * **the source moved before the selection began** — the pre-lock CAS
   *    answers, `STALE_BUILD_SOURCE`, exactly as it always has, and it answers
   *    first even when an input moved too. That precedence is untouched because
   *    that evaluation was not moved;
   *  * **a constituent moved under the lock** — a catalogue edit bumps
   *    `shift_types.version` (migration 0005's `app_maintain_catalogue_version`),
   *    and that column is BOTH a 0016 constituent and a term of the material-input
   *    digest, so such a mover moves both. The staleness verdict must answer,
   *    because "the PROBLEM changed, re-pose the build" is the actionable half
   *    and `STALE_BUILD_SOURCE` would send that scheduler to look at a draft
   *    nobody edited. Putting this re-read ABOVE the verdict would flip that
   *    case's refusal, which is R-4's accepted behaviour and is pinned by "THE
   *    WINDOW" arm;
   *  * **the source moved under the lock and nothing else did** — the case this
   *    repair exists for. Staleness is genuinely fresh, so it declines, and this
   *    re-read answers.
   *
   * So: no case that refused before refuses differently, and one case that
   * silently applied now refuses. That is the whole behavioural delta.
   *
   * **The cost.** One more full `materialInputDigests` assembly inside the lock
   * hold, reached only when the staleness verdict passed. Measured on the test
   * fixture by the R-4b review as a **mean delta of ≈11.7 ms** on a transaction
   * that runs 49–71 ms — so roughly **10–17%** of the transaction, not a
   * rounding error, though `buildStaleness` still dominates the hold. (An
   * independent probe timed one `materialInputDigest` at 6.1–11.0 ms over six
   * samples, which corroborates it.) See the note on the acquisition above for
   * the span these figures cover and the one they do not. */
  const lockedDigest = await sourceDigestOf(uow, run);
  if (lockedDigest !== expectedSourceDigest) throw new BuildSourceMovedError(lockedDigest);

  if (run.snapshot_id === null) {
    throw new BuildPreconditionError(
      'BUILD_SNAPSHOT_MISSING',
      'an approved build carries a pinned canonical input; this one does not',
    );
  }
  const stored = await readSnapshot(uow, run.snapshot_id);
  if (stored === null) {
    throw new BuildPreconditionError(
      'BUILD_SNAPSHOT_MISSING',
      'the pinned canonical input of this build is not visible',
    );
  }
  const document = solverInputSnapshotSchema.parse(
    stored.payload,
  ) as unknown as SolverInputSnapshotDocument;

  const candidate = await uow.query
    .selectFrom('build_run_candidate_assignments')
    .select([
      'membership_id',
      'date',
      'shift_type_id',
      'location_id',
      'mirrors_assignment_identity_id',
      'mirrors_pinned',
      'pick_position',
      'ordinal',
    ])
    .where('build_run_id', '=', run.id)
    .where('claim_epoch', '=', run.claim_epoch)
    .orderBy('ordinal')
    .execute();

  if (candidate.length === 0) {
    throw new BuildPreconditionError(
      'BUILD_CANDIDATE_EMPTY',
      'this build recorded no candidate assignments at its current claim epoch',
    );
  }

  const draftVersionId = await createDraftVersion(uow, actor, run.period_id);

  const zone = document.timezone.basis;
  const shiftTypes = new Map(document.shiftTypes.map((type) => [type.shiftTypeId, type]));

  let pickPositionsCarried = 0;

  for (const row of candidate) {
    /* `date` is a PostgreSQL `date`, and the driver hands it back as a `Date`
     * rather than as the `YYYY-MM-DD` the column holds. `calendarDate` is the
     * one normalisation in this repository and it is used here for the reason it
     * exists: a second spelling of "render a date column" is how two surfaces
     * end up disagreeing about which day a shift is on. */
    const date = calendarDate(row.date);
    const shiftType = shiftTypes.get(row.shift_type_id);
    if (shiftType === undefined) {
      /* Unreachable through the checker, which refuses an unknown reference —
       * and refused rather than repaired here for that reason: a candidate that
       * got past validation naming a shift type the snapshot does not carry is a
       * defect in the checker, not a row to guess a time for. */
      throw new BuildPreconditionError(
        'BUILD_CANDIDATE_UNKNOWN_SHIFT_TYPE',
        'a candidate assignment names a shift type the pinned input does not carry',
      );
    }

    /* The server owns the instant, and it resolves it under the version's own
     * zone with R-B4/R-B5's stated gap and fold rules — the same
     * `resolveLocalTime` the manual authoring surface uses, so a build-produced
     * assignment and a hand-authored one at the same wall clock are the same
     * instant. A second spelling here is exactly the S-01 defect. */
    const startsAt = resolveLocalTime(zone, date, shiftType.startTime.slice(0, 5), 'earliest')
      .instant;
    const endDate = shiftType.crossesMidnight ? nextDay(date) : date;
    const endsAt = resolveLocalTime(zone, endDate, shiftType.endTime.slice(0, 5), 'latest')
      .instant;

    if (row.pick_position !== null) pickPositionsCarried += 1;

    /* THE one write path (FAD-44(1)). The shift lookup-or-create, the interval
     * guard, R-B1/R-B2's membership checks, the draft-only refusal and the
     * `schedule.assignment.added` audit event all come with it. */
    await addAssignment(uow, actor, {
      versionId: draftVersionId,
      membershipId: row.membership_id,
      shiftTypeId: row.shift_type_id,
      date,
      startsAt,
      endsAt,
      locationId: row.location_id,
      /* R-8: a row mirroring a PINNED fixed input carries the real pick position
       * through; a row the solver chose carries NULL, which RK-RULING-04 rules
       * satisfies `PickPositionRestriction` vacuously. */
      pickPosition: row.pick_position,
      /* The pin is a solver INPUT and it survives selection, so the next
       * progressive stage protects what this one protected without the scheduler
       * re-pinning it (report 21 §5's "explicit unlocking"). */
      isPinned: row.mirrors_pinned,
      /* Identity is PRESERVED for a row that mirrors a fixed input, and minted
       * by the service for a row the solver chose. That is what makes "what did
       * this build change about the assignment I pinned?" a join rather than a
       * heuristic, and it is the same property SPEC-05 §7's clone relies on. */
      ...(row.mirrors_assignment_identity_id === null
        ? {}
        : { assignmentIdentityId: row.mirrors_assignment_identity_id }),
      /* FAD-44(1). A solver-produced assignment is not a manual one, and the
       * database has been able to say so since migration 0009. */
      origin: 'solver',
    });
  }

  const applied = await transitionRun(uow, run, 'applied_to_draft_schedule', {
    appliedToVersionId: draftVersionId,
    reason: 'candidate_selected',
  });

  return {
    run: applied,
    draftVersionId,
    assignmentsWritten: candidate.length,
    pickPositionsCarried,
  };
}

/**
 * Take this period's row lock in the mode the draft insert is about to take it,
 * BEFORE the audit advisory lock — migration 0017 §3's row-then-audit rule.
 *
 * `FOR KEY SHARE` and not `FOR UPDATE`: it is the mode the composite foreign key
 * from `schedule_versions` acquires a few statements later, so this adds no
 * conflict that the insert was not already going to introduce. It still orders
 * this writer against the period writers that take `FOR UPDATE` and audit
 * afterwards (`schedule/publication.ts`), which is the point.
 *
 * No refusal on a missing row: `build_runs.period_id` is a foreign key, so the
 * period exists in this tenant by the time a run is loadable, and inventing a
 * second "period not found" answer here would give the same condition two
 * spellings.
 *
 * It does still CHECK, though — R4-REV-2 note N-2. A `SELECT … FOR KEY SHARE`
 * that matches no row takes no lock and raises nothing, so discarding the result
 * would let a future RLS narrowing, or a period made invisible to this context,
 * silently skip the acquisition and resurrect the lock-order inversion this
 * function exists to prevent. The check is spelled as an internal invariant
 * rather than as a typed refusal for the reason above: nothing a caller does can
 * reach it.
 */
async function lockPeriodBeforeAudit(uow: Uow, periodId: string): Promise<void> {
  const row = await uow.query
    .selectFrom('schedule_periods')
    .select('id')
    .where('id', '=', periodId)
    .forKeyShare()
    .executeTakeFirst();

  if (row === undefined) {
    /* Unreachable through RLS — the run was loaded under this same context and
     * its `period_id` is a foreign key. Kept because "the lock statement matched
     * no row" must never become "the audit lock was taken first after all".  */
    throw new Error(
      'SELECTION_PERIOD_LOCK_MATCHED_NO_ROW: the period row lock that must precede the audit ' +
        `advisory lock matched no row for period ${periodId}. This transaction must not proceed ` +
        'to acquire the audit lock without it.',
    );
  }
}

/** `YYYY-MM-DD` one day after `date`. Pure string arithmetic, no zone. */
function nextDay(date: string): string {
  const ms = Date.parse(`${date}T00:00:00Z`) + 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}
