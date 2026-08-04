import { randomUUID } from 'node:crypto';

import type { TenantContext, UnitOfWork } from '@schedulepoint/domain';
import type { Kysely } from 'kysely';

import { recordAuditEvent } from '../audit/recorder.js';
import type { Database } from '../db/schema.js';
import { requireScheduleCapability, type ScheduleActor } from './actions.js';
import { SchedulePreconditionError, ScheduleTransitionError } from './errors.js';

/**
 * The schedule module's domain services (SPEC-05).
 *
 * ## Manual content only — and manual is not the production mechanism
 *
 * Everything here is the MANUAL path: a human creating a period, assigning a
 * person to a shift, overriding with a reason, pinning a fixed assignment. Doc
 * 07 §1 is explicit that a manual override is "a human edit, audited, with a
 * reason where it breaches a soft rule" and is **NOT** "the production
 * scheduling mechanism" (I-05, non-bypass rule 7). The automated engine is M4;
 * nothing here anticipates, approximates or substitutes for it. `is_pinned` and
 * `origin` exist precisely so the M4 solver can later consume manual content as
 * FIXED INPUT rather than as a schedule in its own right.
 *
 * ## Every function takes a unit of work and none opens one
 *
 * I-15 and non-bypass rule 1. The transaction boundary belongs to
 * `PgUnitOfWorkRunner`; a service that could start its own would be a second
 * place to get FAD-12's evaluate → deny → mutate → audit ordering wrong.
 *
 * ## Nothing reads a tenant identifier from its arguments
 *
 * `organization_id` and `group_id` always come from `uow.context`.
 *
 * ## Draft-only, enforced twice
 *
 * Every mutation below refuses a non-draft version in application code, and the
 * database refuses it independently: D-15a's triggers raise on any UPDATE or
 * DELETE of a child row whose version is published or superseded. The check here
 * produces a good error message; the check in the database is the control
 * (I-18). **There is no code path in this module that mutates a published row**,
 * and if one were added the database would refuse it.
 */

type Uow = UnitOfWork<Kysely<Database>>;

function tenantOf(context: TenantContext): { organization_id: string; group_id: string } {
  const { organizationId, groupId } = context;
  if (groupId === null) {
    throw new Error(
      'SCHEDULE_REQUIRES_GROUP_CONTEXT: a schedule statement was reached under an ' +
        'organization-scoped unit of work',
    );
  }
  return { organization_id: organizationId, group_id: groupId };
}

/** The states in which a version's content may be edited at all (doc 07 §3.1). */
const EDITABLE_STATES = new Set(['draft']);

/** SPEC-05 §3.1's legal lifecycle moves, excluding the publication transaction's. */
const LEGAL_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  draft: ['in_review', 'cancelled'],
  in_review: ['draft', 'approved', 'cancelled'],
  approved: ['draft', 'cancelled'],
  // publishing -> published/approved belongs to the publication transaction and
  // to the reconciler; it is deliberately not reachable from this surface.
  publishing: [],
  published: [],
  superseded: [],
  cancelled: [],
};

export interface VersionRow {
  readonly id: string;
  readonly period_id: string;
  readonly version_number: number | null;
  readonly state: string;
  readonly lock_state: string;
  readonly is_current: boolean;
}

async function loadVersion(uow: Uow, versionId: string): Promise<VersionRow> {
  const row = await uow.query
    .selectFrom('schedule_versions')
    .select(['id', 'period_id', 'version_number', 'state', 'lock_state', 'is_current'])
    .where('id', '=', versionId)
    .executeTakeFirst();
  if (row === undefined) {
    // Also the cross-tenant answer: RLS makes another group's version invisible,
    // so "not found" and "not yours" are deliberately the same reply.
    throw new SchedulePreconditionError('VERSION_NOT_FOUND', 'no such schedule version');
  }
  return row as VersionRow;
}

/** Refuse any content edit that is not against an unlocked draft. */
function assertEditable(version: VersionRow): void {
  if (!EDITABLE_STATES.has(version.state)) {
    throw new SchedulePreconditionError(
      'VERSION_NOT_EDITABLE',
      `version ${version.id} is ${version.state}; only a draft is edited — amend a published ` +
        'version by cloning it and publishing forward (SPEC-05 §6.1)',
    );
  }
  if (version.lock_state === 'locked') {
    throw new SchedulePreconditionError(
      'VERSION_LOCKED',
      `version ${version.id} is locked for editing (SPEC-05 §3.2)`,
    );
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Periods and requirements
 * ──────────────────────────────────────────────────────────────────────────── */

export interface CreatePeriodInput {
  readonly name: string;
  /** `YYYY-MM-DD`. */
  readonly startDate: string;
  readonly endDate: string;
}

export async function createPeriod(
  uow: Uow,
  actor: ScheduleActor,
  input: CreatePeriodInput,
): Promise<string> {
  await requireScheduleCapability(uow, actor, 'periodAdminister');
  const tenant = tenantOf(uow.context);
  const id = randomUUID();

  // The no-overlap exclusion (D-2) is the control; a friendly pre-check would
  // only race it, so the database's refusal is the answer.
  await uow.query
    .insertInto('schedule_periods')
    .values({
      id,
      ...tenant,
      name: input.name,
      start_date: input.startDate,
      end_date: input.endDate,
    })
    .execute();

  await recordAuditEvent(uow, {
    eventName: 'schedule.period.created',
    subjectType: 'schedule_period',
    subjectId: id,
  });
  return id;
}

export interface SetRequirementInput {
  readonly periodId: string;
  readonly date: string;
  readonly shiftTypeId: string;
  readonly requiredCount: number;
}

/**
 * Author one period-scoped demand row.
 *
 * These are **period instances**. The catalogue's per-weekday demand defaults
 * (FAD-16, `shift_type_weekday_demand`) stay in M2 and are a different concept:
 * a default for a weekday versus a requirement for a date.
 */
export async function setRequirement(
  uow: Uow,
  actor: ScheduleActor,
  input: SetRequirementInput,
): Promise<string> {
  await requireScheduleCapability(uow, actor, 'periodAdminister');
  const tenant = tenantOf(uow.context);
  const id = randomUUID();

  const inserted = await uow.query
    .insertInto('schedule_requirements')
    .values({
      id,
      ...tenant,
      period_id: input.periodId,
      date: input.date,
      shift_type_id: input.shiftTypeId,
      required_count: input.requiredCount,
    })
    .onConflict((oc) =>
      oc
        .columns(['organization_id', 'group_id', 'period_id', 'date', 'shift_type_id'])
        .doUpdateSet({ required_count: input.requiredCount, updated_at: new Date() }),
    )
    .returning('id')
    .executeTakeFirstOrThrow();

  await recordAuditEvent(uow, {
    eventName: 'schedule.period.updated',
    subjectType: 'schedule_period',
    subjectId: input.periodId,
    payload: { requirement: inserted.id, required: input.requiredCount },
  });
  return inserted.id;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Versions
 * ──────────────────────────────────────────────────────────────────────────── */

export async function createDraftVersion(
  uow: Uow,
  actor: ScheduleActor,
  periodId: string,
): Promise<string> {
  await requireScheduleCapability(uow, actor, 'versionEdit');
  const tenant = tenantOf(uow.context);
  const id = randomUUID();

  await uow.query
    .insertInto('schedule_versions')
    .values({ id, ...tenant, period_id: periodId, state: 'draft' })
    .execute();

  await recordAuditEvent(uow, {
    eventName: 'schedule.version.created',
    subjectType: 'schedule_version',
    subjectId: id,
    payload: { period: periodId, origin: 'new' },
  });
  return id;
}

/**
 * Clone a version into a new draft — SPEC-05 §7, the operation the old D-1 made
 * impossible.
 *
 * **No row in the source version is read for update, modified, or marked
 * superseded.** The clone succeeds because D-1a is scoped by `version_id`:
 * V1 and V2 hold identical assignment sets without colliding.
 *
 * **Identity is preserved across the clone.** That is what makes "what changed
 * between V2 and V3?" a join on `assignment_identity_id` rather than a heuristic
 * diff, and it is why `assignment_identities` is a table of its own.
 */
export async function cloneVersion(
  uow: Uow,
  actor: ScheduleActor,
  sourceVersionId: string,
): Promise<string> {
  await requireScheduleCapability(uow, actor, 'versionEdit');
  const tenant = tenantOf(uow.context);
  const source = await loadVersion(uow, sourceVersionId);
  const newVersionId = randomUUID();

  await uow.query
    .insertInto('schedule_versions')
    .values({
      id: newVersionId,
      ...tenant,
      period_id: source.period_id,
      state: 'draft',
      cloned_from_version_id: sourceVersionId,
    })
    .execute();

  // Shifts first: snapshots reference them, and the clone needs its own rows so
  // that editing the clone's shift cannot reach the source's (D-15a would refuse
  // it anyway once the source is published — this keeps the drafts independent).
  const sourceShifts = await uow.query
    .selectFrom('shifts')
    .select(['id', 'date', 'shift_type_id', 'location_id', 'required_count'])
    .where('version_id', '=', sourceVersionId)
    .execute();

  const shiftIdBySource = new Map<string, string>();
  for (const shift of sourceShifts) {
    const cloneId = randomUUID();
    shiftIdBySource.set(shift.id, cloneId);
    await uow.query
      .insertInto('shifts')
      .values({
        id: cloneId,
        ...tenant,
        version_id: newVersionId,
        date: shift.date,
        shift_type_id: shift.shift_type_id,
        location_id: shift.location_id,
        required_count: shift.required_count,
      })
      .execute();
  }

  const sourceSnapshots = await uow.query
    .selectFrom('assignment_snapshots')
    .select([
      'id',
      'assignment_identity_id',
      'membership_id',
      'shift_id',
      'date',
      'starts_at',
      'ends_at',
      'pick_position',
      'is_pinned',
      'status',
      'override_reason',
    ])
    .where('version_id', '=', sourceVersionId)
    .execute();

  for (const snapshot of sourceSnapshots) {
    const clonedShiftId = shiftIdBySource.get(snapshot.shift_id);
    if (clonedShiftId === undefined) {
      throw new Error('SCHEDULE_CLONE_SHIFT_MISSING: a snapshot referenced an uncloned shift');
    }
    await uow.query
      .insertInto('assignment_snapshots')
      .values({
        id: randomUUID(),
        ...tenant,
        // PRESERVED — this is the point of the clone.
        assignment_identity_id: snapshot.assignment_identity_id,
        version_id: newVersionId,
        membership_id: snapshot.membership_id,
        shift_id: clonedShiftId,
        date: snapshot.date,
        starts_at: snapshot.starts_at,
        ends_at: snapshot.ends_at,
        origin: 'clone',
        pick_position: snapshot.pick_position,
        is_pinned: snapshot.is_pinned,
        status: snapshot.status,
        supersedes_snapshot_id: snapshot.id,
        override_reason: snapshot.override_reason,
      })
      .execute();
  }

  await recordAuditEvent(uow, {
    eventName: 'schedule.version.created',
    subjectType: 'schedule_version',
    subjectId: newVersionId,
    payload: {
      period: source.period_id,
      origin: 'clone',
      clonedFrom: sourceVersionId,
      snapshots: sourceSnapshots.length,
    },
  });
  return newVersionId;
}

export async function transitionVersion(
  uow: Uow,
  actor: ScheduleActor,
  versionId: string,
  to: 'in_review' | 'approved' | 'draft' | 'cancelled',
): Promise<void> {
  await requireScheduleCapability(uow, actor, 'versionEdit');
  const version = await loadVersion(uow, versionId);
  if (!(LEGAL_TRANSITIONS[version.state] ?? []).includes(to)) {
    throw new ScheduleTransitionError(version.state, to);
  }

  // Approval is blocked while a hard-breach conflict is open (doc 06 §3.3). The
  // publication transaction re-checks it at commit, because the world can change
  // between approval and publication (doc 07 §2.1).
  if (to === 'approved') await assertNoOpenHardBreach(uow, versionId);

  await uow.query
    .updateTable('schedule_versions')
    .set({ state: to, updated_at: new Date() })
    .where('id', '=', versionId)
    .execute();

  await recordAuditEvent(uow, {
    eventName: 'schedule.version.state_changed',
    subjectType: 'schedule_version',
    subjectId: versionId,
    payload: { from: version.state, to },
  });
}

export async function assertNoOpenHardBreach(uow: Uow, versionId: string): Promise<void> {
  const open = await uow.query
    .selectFrom('schedule_conflicts')
    .select('id')
    .where('version_id', '=', versionId)
    .where('severity', '=', 'hard-breach')
    .where('state', '=', 'open')
    .executeTakeFirst();
  if (open !== undefined) {
    throw new SchedulePreconditionError(
      'OPEN_HARD_BREACH',
      `version ${versionId} has an open hard-breach conflict; sign-off and publication are blocked`,
    );
  }
}

/** Administrator lock/unlock of a DRAFT's editability (SPEC-05 §3.2). */
export async function setLockState(
  uow: Uow,
  actor: ScheduleActor,
  versionId: string,
  lockState: 'locked' | 'unlocked',
): Promise<void> {
  await requireScheduleCapability(uow, actor, 'versionEdit');
  const version = await loadVersion(uow, versionId);
  if (version.state === 'published' || version.state === 'superseded') {
    // The CHECK constraint says the same thing; this is the readable error.
    throw new SchedulePreconditionError(
      'LOCK_MEANINGLESS_WHEN_FROZEN',
      'a published or superseded version is immutable regardless; lock_state does not apply',
    );
  }
  await uow.query
    .updateTable('schedule_versions')
    .set({ lock_state: lockState, updated_at: new Date() })
    .where('id', '=', versionId)
    .execute();
  await recordAuditEvent(uow, {
    eventName: 'schedule.version.state_changed',
    subjectType: 'schedule_version',
    subjectId: versionId,
    payload: { lockFrom: version.lock_state, lockTo: lockState },
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Manual assignment (draft only)
 * ──────────────────────────────────────────────────────────────────────────── */

export interface AddAssignmentInput {
  readonly versionId: string;
  readonly membershipId: string;
  readonly shiftTypeId: string;
  /** `YYYY-MM-DD` — the shift's calendar date in the group's timezone. */
  readonly date: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly pickPosition?: number | null;
  readonly isPinned?: boolean;
  /**
   * Required when this assignment is a manual OVERRIDE. Non-clinical
   * administrative text; it never enters an audit payload (I-07).
   */
  readonly overrideReason?: string | null;
  /** Reuse an existing identity (a reassignment keeps the identity). */
  readonly assignmentIdentityId?: string;
}

export interface AddedAssignment {
  readonly snapshotId: string;
  readonly assignmentIdentityId: string;
}

/** Find or create the shift row this assignment hangs on, within the version. */
async function ensureShift(
  uow: Uow,
  versionId: string,
  date: string,
  shiftTypeId: string,
): Promise<string> {
  const tenant = tenantOf(uow.context);
  const existing = await uow.query
    .selectFrom('shifts')
    .select('id')
    .where('version_id', '=', versionId)
    .where('date', '=', date)
    .where('shift_type_id', '=', shiftTypeId)
    .where('location_id', 'is', null)
    .executeTakeFirst();
  if (existing !== undefined) return existing.id;

  const id = randomUUID();
  await uow.query
    .insertInto('shifts')
    .values({ id, ...tenant, version_id: versionId, date, shift_type_id: shiftTypeId })
    .execute();
  return id;
}

export async function addManualAssignment(
  uow: Uow,
  actor: ScheduleActor,
  input: AddAssignmentInput,
): Promise<AddedAssignment> {
  await requireScheduleCapability(uow, actor, 'versionEdit');
  const tenant = tenantOf(uow.context);
  const version = await loadVersion(uow, input.versionId);
  assertEditable(version);

  const shiftId = await ensureShift(uow, input.versionId, input.date, input.shiftTypeId);

  let identityId = input.assignmentIdentityId;
  if (identityId === undefined) {
    identityId = randomUUID();
    await uow.query
      .insertInto('assignment_identities')
      .values({ id: identityId, ...tenant, period_id: version.period_id, origin: 'manual' })
      .execute();
  }

  const snapshotId = randomUUID();
  // D-1a refuses an overlap for this membership WITHIN this version, including
  // across midnight; D-14 refuses a second snapshot for this identity in this
  // version. Both are the database's, and both are load-bearing here.
  await uow.query
    .insertInto('assignment_snapshots')
    .values({
      id: snapshotId,
      ...tenant,
      assignment_identity_id: identityId,
      version_id: input.versionId,
      membership_id: input.membershipId,
      shift_id: shiftId,
      date: input.date,
      starts_at: input.startsAt,
      ends_at: input.endsAt,
      origin: 'manual',
      pick_position: input.pickPosition ?? null,
      is_pinned: input.isPinned ?? false,
      status: 'active',
      override_reason: input.overrideReason ?? null,
    })
    .execute();

  await recordAuditEvent(uow, {
    eventName: 'schedule.assignment.added',
    subjectType: 'assignment_identity',
    subjectId: identityId,
    payload: {
      version: input.versionId,
      snapshot: snapshotId,
      membership: input.membershipId,
      pinned: input.isPinned ?? false,
      // The reason TEXT is deliberately not here — only whether one was given.
      overridden: input.overrideReason != null,
    },
  });

  if (input.overrideReason != null) {
    await recordAuditEvent(uow, {
      eventName: 'schedule.assignment.overridden',
      subjectType: 'assignment_identity',
      subjectId: identityId,
      payload: { version: input.versionId, snapshot: snapshotId, reasonGiven: true },
    });
  }

  return { snapshotId, assignmentIdentityId: identityId };
}

/**
 * Remove a manual assignment from a DRAFT.
 *
 * The snapshot is CANCELLED, not deleted: the version's content is the history
 * of what this draft held, and a delete would make "was this person ever on
 * this draft?" unanswerable. `status='cancelled'` also drops the row out of
 * D-1a's partial exclusion, which is what frees the interval.
 */
export async function removeAssignment(
  uow: Uow,
  actor: ScheduleActor,
  versionId: string,
  assignmentIdentityId: string,
  reason: string,
): Promise<void> {
  await requireScheduleCapability(uow, actor, 'versionEdit');
  const version = await loadVersion(uow, versionId);
  assertEditable(version);

  const updated = await uow.query
    .updateTable('assignment_snapshots')
    .set({ status: 'cancelled', override_reason: reason, updated_at: new Date() })
    .where('version_id', '=', versionId)
    .where('assignment_identity_id', '=', assignmentIdentityId)
    .where('status', '=', 'active')
    .returning('id')
    .executeTakeFirst();
  if (updated === undefined) {
    throw new SchedulePreconditionError(
      'ASSIGNMENT_NOT_FOUND',
      'no active snapshot for that identity in that version',
    );
  }

  await recordAuditEvent(uow, {
    eventName: 'schedule.assignment.removed',
    subjectType: 'assignment_identity',
    subjectId: assignmentIdentityId,
    payload: { version: versionId, snapshot: updated.id, reasonGiven: true },
  });
}

/**
 * Reassign to a different membership, PRESERVING the identity.
 *
 * The identity is what "that assignment" means to a human (SPEC-05 §1), and a
 * reassignment is a change to it — not a new assignment. Preserving it is what
 * lets the affected-staff diff say "this assignment moved from A to B" rather
 * than "one assignment vanished and an unrelated one appeared".
 */
export async function reassignAssignment(
  uow: Uow,
  actor: ScheduleActor,
  versionId: string,
  assignmentIdentityId: string,
  toMembershipId: string,
  reason: string,
): Promise<void> {
  await requireScheduleCapability(uow, actor, 'versionEdit');
  const version = await loadVersion(uow, versionId);
  assertEditable(version);

  const current = await uow.query
    .selectFrom('assignment_snapshots')
    .select(['id', 'membership_id'])
    .where('version_id', '=', versionId)
    .where('assignment_identity_id', '=', assignmentIdentityId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (current === undefined) {
    throw new SchedulePreconditionError(
      'ASSIGNMENT_NOT_FOUND',
      'no active snapshot for that identity in that version',
    );
  }

  await uow.query
    .updateTable('assignment_snapshots')
    .set({ membership_id: toMembershipId, override_reason: reason, updated_at: new Date() })
    .where('id', '=', current.id)
    .execute();

  await recordAuditEvent(uow, {
    eventName: 'schedule.assignment.reassigned',
    subjectType: 'assignment_identity',
    subjectId: assignmentIdentityId,
    payload: {
      version: versionId,
      snapshot: current.id,
      fromMembership: current.membership_id,
      toMembership: toMembershipId,
      reasonGiven: true,
    },
  });
}

/** Set or clear the fixed-assignment pin — a SOLVER INPUT, not an editing control. */
export async function setPin(
  uow: Uow,
  actor: ScheduleActor,
  versionId: string,
  assignmentIdentityId: string,
  isPinned: boolean,
): Promise<void> {
  await requireScheduleCapability(uow, actor, 'versionEdit');
  const version = await loadVersion(uow, versionId);
  assertEditable(version);

  const updated = await uow.query
    .updateTable('assignment_snapshots')
    .set({ is_pinned: isPinned, updated_at: new Date() })
    .where('version_id', '=', versionId)
    .where('assignment_identity_id', '=', assignmentIdentityId)
    .returning('id')
    .executeTakeFirst();
  if (updated === undefined) {
    throw new SchedulePreconditionError('ASSIGNMENT_NOT_FOUND', 'no snapshot for that identity');
  }

  await recordAuditEvent(uow, {
    eventName: 'schedule.assignment.pinned',
    subjectType: 'assignment_identity',
    subjectId: assignmentIdentityId,
    payload: { version: versionId, snapshot: updated.id, pinned: isPinned },
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Credits — the tenth concept, deliberately separate from the assignment
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Credit a membership for an assignment. **The credited membership may differ
 * from the assignee, by design** (doc 07: "Who *works* a shift and who is
 * *scored* for it can legitimately differ").
 *
 * V-23 keying: identity + source_version + source_snapshot. Moving a credit
 * NEVER touches the snapshot — that is the whole point of the separation, and
 * the independent-review probe for it is "does a credit edit reach the
 * snapshot?" The answer is no: this function writes only `credits`.
 */
export async function moveCredit(
  uow: Uow,
  actor: ScheduleActor,
  input: {
    readonly versionId: string;
    readonly assignmentIdentityId: string;
    readonly snapshotId: string;
    readonly creditedMembershipId: string;
    readonly weight?: number;
    readonly reason?: string | null;
  },
): Promise<string> {
  await requireScheduleCapability(uow, actor, 'versionEdit');
  // FAD-22(1). A credit against a PUBLISHED version was accepted and then
  // permanently frozen by D-15a — an uncorrectable credit written against
  // immutable history. A post-publication credit correction is expressed on a
  // DRAFT of the next version, never against the published one. The trigger now
  // refuses this independently; this is the readable error.
  const creditVersion = await loadVersion(uow, input.versionId);
  assertEditable(creditVersion);

  const tenant = tenantOf(uow.context);
  const id = randomUUID();

  const row = await uow.query
    .insertInto('credits')
    .values({
      id,
      ...tenant,
      assignment_identity_id: input.assignmentIdentityId,
      source_version_id: input.versionId,
      source_snapshot_id: input.snapshotId,
      credited_membership_id: input.creditedMembershipId,
      weight: String(input.weight ?? 1),
      reason: input.reason ?? null,
      moved_by: uow.context.membershipId,
      status: 'active',
    })
    .onConflict((oc) =>
      oc
        .columns(['organization_id', 'group_id', 'assignment_identity_id', 'source_version_id'])
        .doUpdateSet({
          credited_membership_id: input.creditedMembershipId,
          status: 'reassigned',
          moved_by: uow.context.membershipId,
          updated_at: new Date(),
        }),
    )
    .returning('id')
    .executeTakeFirstOrThrow();

  await recordAuditEvent(uow, {
    eventName: 'schedule.credit.moved',
    subjectType: 'credit',
    subjectId: row.id,
    payload: {
      version: input.versionId,
      identity: input.assignmentIdentityId,
      credited: input.creditedMembershipId,
    },
  });
  return row.id;
}

export async function voidCredit(uow: Uow, actor: ScheduleActor, creditId: string): Promise<void> {
  await requireScheduleCapability(uow, actor, 'versionEdit');

  // The credit's parent version is `source_version_id` (V-23 keying), so the
  // draft-only boundary is checked by resolving the credit first (FAD-22(1)).
  const credit = await uow.query
    .selectFrom('credits')
    .select(['id', 'source_version_id'])
    .where('id', '=', creditId)
    .executeTakeFirst();
  if (credit === undefined) {
    throw new SchedulePreconditionError('CREDIT_NOT_FOUND', 'no such credit');
  }
  assertEditable(await loadVersion(uow, credit.source_version_id));

  const updated = await uow.query
    .updateTable('credits')
    .set({ status: 'voided', updated_at: new Date() })
    .where('id', '=', creditId)
    .returning('id')
    .executeTakeFirst();
  if (updated === undefined) {
    throw new SchedulePreconditionError('CREDIT_NOT_FOUND', 'no such credit');
  }
  await recordAuditEvent(uow, {
    eventName: 'schedule.credit.voided',
    subjectType: 'credit',
    subjectId: creditId,
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Conflicts (the publication prerequisite)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Record a validation conflict against a DRAFT version.
 *
 * ## Three defects the independent review found here, all closed
 *
 * As first written this function took no actor, evaluated no capability, wrote
 * no audit event, and accepted a published `version_id`. That last one is the
 * worst of the four: a conflict recorded against a published version is
 * immediately frozen by D-15a, so it can never be accepted or resolved — an
 * `open` `hard-breach` written there is permanent, and it blocks nothing
 * (publication already happened) while being impossible to clear.
 *
 * The missing capability check and audit event were unconditional defects
 * regardless of version state — non-bypass rules 4 and 6 — and are the reason
 * this is the only mutator in the module that used to be callable by anyone who
 * could reach a unit of work.
 */
export async function recordConflict(
  uow: Uow,
  actor: ScheduleActor,
  input: {
    readonly versionId: string;
    readonly severity: 'hard-breach' | 'soft' | 'info';
    readonly explanation?: string;
  },
): Promise<string> {
  await requireScheduleCapability(uow, actor, 'versionEdit');
  const version = await loadVersion(uow, input.versionId);
  assertEditable(version);

  const tenant = tenantOf(uow.context);
  const id = randomUUID();
  await uow.query
    .insertInto('schedule_conflicts')
    .values({
      id,
      ...tenant,
      version_id: input.versionId,
      severity: input.severity,
      explanation: input.explanation ?? null,
      state: 'open',
    })
    .execute();

  await recordAuditEvent(uow, {
    eventName: 'schedule.conflict.recorded',
    subjectType: 'schedule_version',
    subjectId: input.versionId,
    // The severity and the conflict id, never the explanation TEXT.
    payload: { conflict: id, severity: input.severity },
  });
  return id;
}
