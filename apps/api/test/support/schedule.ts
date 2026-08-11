import { randomUUID } from 'node:crypto';

import type { PgUnitOfWorkRunner } from '../../src/db/unit-of-work.js';
import type { ScheduleActor } from '../../src/schedule/actions.js';
import { publishVersion } from '../../src/schedule/publication.js';
import {
  addManualAssignment,
  cloneVersion,
  createDraftVersion,
  createPeriod,
  moveCredit,
  reassignAssignment,
  recordConflict,
  setRequirement,
  transitionVersion,
} from '../../src/schedule/service.js';
import type { MultiFixture } from './multi.js';
import { grantStaffingCapabilities } from './staffing.js';

/**
 * The schedule module's fixture support (OPUS-M3-003).
 *
 * ## Everything is seeded THROUGH the production write path
 *
 * `createPeriod`, `addManualAssignment` and `publishVersion` are the same
 * functions a route will call. A fixture that inserted rows directly would seed
 * states the application cannot produce — and would then "prove" isolation and
 * immutability for rows no code path can create. It also means the seed
 * exercises the SPEC-06 gate, the audit chain and the outbox on every run.
 *
 * ## Why the seed publishes TWICE in Group One
 *
 * `version_supersessions` only has a row once a second publication supersedes a
 * first, and `current_published_assignments` only has rows after a publication
 * at all. Both are registered tenant tables, and SBX-004's sweep fails a table
 * that is never observed with a visible row — a probe over an empty table
 * reports "0 wrong-tenant rows" for the most boring possible reason. So the seed
 * produces a genuine V1 → V2 history rather than a single draft.
 *
 * ## Why the sibling group is seeded too
 *
 * The cross-GROUP arm of the sweep ("Group One sees zero rows from Group Two")
 * is only measurable if Group Two holds rows. Seeding one group would repeat the
 * blocking finding the catalogue seed already had: dropping the `group_id`
 * clause from every policy left the sweep green.
 *
 * ## Dates are far-future and synthetic
 *
 * 2027 dates, so the fixture can never collide with a real-looking window, and
 * no assignment interval overlaps another for the same membership — D-1b's
 * `EXCLUDE` is global per membership across periods, so a careless seed would
 * abort its own second publication.
 */

export interface SeededScheduleGroup {
  readonly groupId: string;
  readonly periodId: string;
  /** The first published version. `superseded` once V2 publishes. */
  readonly firstVersionId: string;
  /** The current published version. */
  readonly currentVersionId: string;
  readonly assignmentIdentityIds: readonly string[];
  readonly requirementId: string;
  readonly creditId: string;
  readonly conflictId: string;
}

export interface SeededSchedule {
  readonly groupOne: SeededScheduleGroup;
  readonly sibling: SeededScheduleGroup;
}

/** The evaluator needs the USER; RLS needs the membership. */
export function scheduleActor(userId: string): ScheduleActor {
  return { principalUserId: userId };
}

/** An instant on a 2027 fixture date, in UTC — never a local-time construction. */
export function fixtureInstant(date: string, hour: number): Date {
  return new Date(`${date}T${String(hour).padStart(2, '0')}:00:00.000Z`);
}

interface SeedGroupInput {
  readonly organizationId: string;
  readonly groupId: string;
  readonly actorMembershipId: string;
  readonly actorUserId: string;
  readonly shiftTypeId: string;
  /** Two distinct memberships in this group to assign. */
  readonly assignees: readonly [string, string];
  /** Distinct per group, so two groups' intervals never collide for one person. */
  readonly startDate: string;
  readonly endDate: string;
}

async function seedOneGroup(
  runtime: PgUnitOfWorkRunner,
  input: SeedGroupInput,
): Promise<SeededScheduleGroup> {
  const actor = scheduleActor(input.actorUserId);
  const context = {
    organizationId: input.organizationId,
    groupId: input.groupId,
    membershipId: input.actorMembershipId,
    correlationId: 'schedule-seed',
  };

  return runtime.run(context, async (uow) => {
    const periodId = await createPeriod(uow, actor, {
      name: `Fixture period ${input.startDate}`,
      startDate: input.startDate,
      endDate: input.endDate,
    });

    const requirementId = await setRequirement(uow, actor, {
      periodId,
      date: input.startDate,
      shiftTypeId: input.shiftTypeId,
      requiredCount: 2,
    });

    /* V1 — two manual assignments, one per assignee, on the same date but at
     * non-overlapping times (D-1a is per membership, so this is only about
     * keeping the fixture readable). */
    const firstVersionId = await createDraftVersion(uow, actor, periodId);
    const first = await addManualAssignment(uow, actor, {
      versionId: firstVersionId,
      membershipId: input.assignees[0],
      shiftTypeId: input.shiftTypeId,
      date: input.startDate,
      startsAt: fixtureInstant(input.startDate, 8),
      endsAt: fixtureInstant(input.startDate, 16),
    });
    const second = await addManualAssignment(uow, actor, {
      versionId: firstVersionId,
      membershipId: input.assignees[1],
      shiftTypeId: input.shiftTypeId,
      date: input.startDate,
      startsAt: fixtureInstant(input.startDate, 16),
      endsAt: fixtureInstant(input.startDate, 22),
    });

    // An `info` conflict, deliberately not `hard-breach`: a hard breach would
    // (correctly) block the publication below.
    const conflictId = await recordConflict(uow, actor, {
      versionId: firstVersionId,
      severity: 'info',
      explanation: 'fixture conflict row',
    });

    await transitionVersion(uow, actor, firstVersionId, 'in_review');
    await transitionVersion(uow, actor, firstVersionId, 'approved');
    await publishVersion(uow, actor, {
      periodId,
      versionId: firstVersionId,
      idempotencyKey: `seed-v1-${input.groupId}`,
      // A first publication: nothing is current yet (FAD-22(2)).
      expectedPriorCurrentVersionId: null,
    });

    /* V2 — clone, amend, publish. This is what puts a row in
     * `version_supersessions` and makes V1 `superseded`. */
    const currentVersionId = await cloneVersion(uow, actor, firstVersionId);
    await reassignAssignment(
      uow,
      actor,
      currentVersionId,
      first.assignmentIdentityId,
      input.assignees[1],
      'fixture reassignment',
    );

    // The credit is authored while V2 is still a DRAFT and is credited to the
    // OTHER membership — the assignee and the credited person differ by design.
    const v2Snapshot = await uow.query
      .selectFrom('assignment_snapshots')
      .select('id')
      .where('version_id', '=', currentVersionId)
      .where('assignment_identity_id', '=', second.assignmentIdentityId)
      .executeTakeFirstOrThrow();
    const creditId = await moveCredit(uow, actor, {
      versionId: currentVersionId,
      assignmentIdentityId: second.assignmentIdentityId,
      snapshotId: v2Snapshot.id,
      creditedMembershipId: input.assignees[0],
      reason: 'fixture credit move',
    });

    await transitionVersion(uow, actor, currentVersionId, 'in_review');
    await transitionVersion(uow, actor, currentVersionId, 'approved');
    await publishVersion(uow, actor, {
      periodId,
      versionId: currentVersionId,
      idempotencyKey: `seed-v2-${input.groupId}`,
      expectedPriorCurrentVersionId: firstVersionId,
    });

    return {
      groupId: input.groupId,
      periodId,
      firstVersionId,
      currentVersionId,
      assignmentIdentityIds: [first.assignmentIdentityId, second.assignmentIdentityId],
      requirementId,
      creditId,
      conflictId,
    };
  });
}

/**
 * Seed a full schedule history into Alpha's Group One and its sibling group.
 *
 * Requires the catalogue seed for Alpha — an assignment hangs on a shift type,
 * and inventing one here would be a second catalogue.
 *
 * **Alpha only, deliberately.** The schedule seed needs two distinct group
 * memberships to assign, and only Alpha's user set has them (`BetaUsers` is a
 * scheduler and an organization administrator). Extending Beta's user set to
 * make a symmetry that nothing needs would change what every existing Beta
 * assertion is asserting about. The cross-ORGANIZATION arm of the sweep does not
 * need Beta to hold schedule rows: it asks whether Alpha's context can see rows
 * it should not, and Alpha's rows are what it must not see from Beta's context.
 * The cross-GROUP arm — the one the catalogue's blocking finding was about — is
 * satisfied by seeding Alpha's sibling group below.
 */
export async function seedSchedule(
  runtime: PgUnitOfWorkRunner,
  fixture: MultiFixture,
): Promise<SeededSchedule> {
  const catalogue = fixture.catalogue?.alpha;
  if (catalogue === undefined) {
    throw new Error(
      "seedSchedule needs seed.catalogue to include 'alpha': an assignment references a " +
        'shift type, and the schedule seed does not mint its own catalogue',
    );
  }

  const organization = fixture.alpha;
  /* Index 1, not 0, since OPUS-M4-000A: the catalogue seeding attaches a
   * qualification REQUIREMENT to `shiftTypeIds[0]`, and publication now
   * enforces requirement satisfaction structurally (the shared verdict) —
   * so a fixture that assigns credential-less members to the constrained
   * type could never publish. The schedule fixture's job is the schedule
   * spine, not the credential path; the structural enforcement has its own
   * dedicated proofs in `test/schedule/qualification-requirement-gate.test.ts`. */
  const shiftTypeId = catalogue.shiftTypeIds[1];
  const siblingShiftTypeId = catalogue.sibling.shiftTypeIds[1];
  if (shiftTypeId === undefined || siblingShiftTypeId === undefined) {
    throw new Error('seedSchedule: the catalogue seed produced no shift type');
  }

  const groupOne = await seedOneGroup(runtime, {
    organizationId: organization.organizationId,
    groupId: organization.groupOne.id,
    actorMembershipId: organization.users.scheduler.membershipId,
    actorUserId: organization.users.scheduler.id,
    shiftTypeId,
    assignees: [
      organization.users.scheduler.membershipId,
      organization.users.member.membershipId,
    ],
    startDate: '2027-03-02',
    endDate: '2027-03-31',
  });

  /* The sibling group.
   *
   * The actor is `groupTwoScheduler`, NOT `scheduler.groupTwoMembershipId`.
   * Both are memberships in Group Two, but only the former is the one the
   * fixture grants `schedule.publish` to — `schedule.publish` is a `G` cell
   * (grant-only, never role-implied), so the group `scheduler` role alone
   * authorizes authoring and NOT publication. Using the ungranted membership
   * denied at L4.2, which is the control working: the seed is not permitted to
   * publish just because it is the fixture.
   *
   * The two assignees are the same membership at ADJACENT, non-overlapping
   * times — `tstzrange` is `[)`, so 08:00–16:00 and 16:00–22:00 do not overlap
   * and D-1a is satisfied without contrivance. */
  const siblingActor = organization.users.groupTwoScheduler;
  const sibling = await seedOneGroup(runtime, {
    organizationId: organization.organizationId,
    groupId: catalogue.sibling.groupId,
    actorMembershipId: siblingActor.membershipId,
    actorUserId: siblingActor.id,
    shiftTypeId: siblingShiftTypeId,
    assignees: [siblingActor.membershipId, siblingActor.membershipId],
    // A DIFFERENT window from Group One's. D-1b's EXCLUDE is global per
    // membership across periods, so overlapping windows would abort the seed's
    // own second publication if a membership were ever shared.
    startDate: '2027-05-04',
    endDate: '2027-05-30',
  });

  return { groupOne, sibling };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Harness helpers — used by the V-01..V-19 proof and by SBX-018
 * ──────────────────────────────────────────────────────────────────────────── */

/** A fresh idempotency key. Publications that must NOT be replays use this. */
export function publicationKey(label: string): string {
  return `${label}-${randomUUID()}`;
}

/**
 * Grant schedule capabilities to a group membership through the production path.
 *
 * Delegates to `grantStaffingCapabilities`, which is only *named* for staffing —
 * it takes an arbitrary capability list and writes `capability_grants` as the
 * organization administrator, satisfying
 * `app_guard_capability_grant_administration`'s two-person rule. Reusing it
 * keeps one grant-writing path rather than adding a second that could drift
 * from the guard's requirements.
 *
 * `schedule.revert` needs this: it is grant-only (doc 08 §4) and no fixture role
 * carries it, so a revert test must be granted it exactly as production would.
 */
export async function grantScheduleCapabilities(
  runtime: PgUnitOfWorkRunner,
  fixture: MultiFixture,
  options: {
    readonly organizationId: string;
    readonly groupId: string;
    readonly membershipId: string;
    readonly capabilities: readonly string[];
    readonly granted?: boolean;
  },
): Promise<{ readonly grantIds: readonly string[] }> {
  return grantStaffingCapabilities(runtime, fixture, options);
}

/* `VERSION_ROW_COLUMNS` lived here and is REMOVED (OPUS-M4-000B, review C-4).
 *
 * It was a hand-maintained list of `schedule_versions`' columns, and its comment
 * claimed it was what made "no column untested" structural for the byte-identity
 * proofs. Nothing imported it — the property is actually provided by V-18, which
 * enumerates the columns from `information_schema` at run time and therefore
 * cannot fall behind a migration. A hand-maintained list claiming a structural
 * guarantee is worse than no list: it reads as a control and silently is not
 * one. (V-18 picked up this packet's two new columns on its own, 13 -> 15.) */
