import { solverInputSnapshotSchema } from '@schedulepoint/contracts';
import {
  resolveLocalTime,
  type SolverInputSnapshotDocument,
  type UnitOfWork,
} from '@schedulepoint/domain';
import type { Kysely } from 'kysely';

import type { BuildRunState, Database } from '../db/schema.js';
import { requireScheduleCapability, type ScheduleActor } from '../schedule/actions.js';
import { calendarDate } from '../schedule/render.js';
import { addManualAssignment as addAssignment, createDraftVersion } from '../schedule/service.js';
import { readSnapshot } from '../solver/snapshot-store.js';
import { BuildPreconditionError, BuildSourceMovedError } from './errors.js';
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
 * ## Credits are deliberately not carried
 *
 * `cloneCredits` maps credits by the source version's snapshot rows. A
 * build-produced draft's snapshot set is GENERATED, not cloned, so a credit
 * copied across could point at an assignment the solver did not reproduce.
 * Carrying credits into a build-produced draft is stated as an M4-004 question
 * rather than approximated here. A credit that matters is re-expressed on the
 * draft, which is the path SPEC-05 already requires for a post-publication
 * correction.
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
   * for a scheduler to wonder about. */
  const currentDigest = await sourceDigestOf(uow, run);
  if (currentDigest !== expectedSourceDigest) throw new BuildSourceMovedError(currentDigest);

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

/** `YYYY-MM-DD` one day after `date`. Pure string arithmetic, no zone. */
function nextDay(date: string): string {
  const ms = Date.parse(`${date}T00:00:00Z`) + 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}
