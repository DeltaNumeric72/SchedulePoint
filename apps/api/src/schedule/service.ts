import { randomUUID } from 'node:crypto';

import type { TenantContext, UnitOfWork } from '@schedulepoint/domain';
import type { Kysely } from 'kysely';

import { recordAuditEvent } from '../audit/recorder.js';
import {
  acquireStaffingSet,
  readStaffingSetVersion,
} from '../catalogue/staffing-set-version.js';
import type { Database } from '../db/schema.js';
import { requireScheduleCapability, type ScheduleActor } from './actions.js';
import { SchedulePreconditionError, ScheduleTransitionError } from './errors.js';
import { calendarDate } from './render.js';
import { captureTimezoneBasis, readTimezoneBasis } from './timezone.js';

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

export interface RequirementSetEntry {
  readonly date: string;
  readonly shiftTypeId: string;
  readonly requiredCount: number;
}

export interface RequirementRowView {
  readonly id: string;
  readonly date: string;
  readonly shiftTypeId: string;
  readonly requiredCount: number;
}

export interface RequirementReplacement {
  readonly requirements: readonly RequirementRowView[];
  /** The aggregate version AFTER this save — what the next save presents. */
  readonly version: number;
  /** `false` iff the presented set equalled the stored one (FAD-24: no audit event). */
  readonly changed: boolean;
  readonly addedCount: number;
  readonly updatedCount: number;
  readonly deletedCount: number;
}

export type RequirementReplaceOutcome =
  | { readonly kind: 'ok'; readonly value: RequirementReplacement }
  | { readonly kind: 'stale-set'; readonly currentVersion: number }
  | { readonly kind: 'invalid'; readonly problems: readonly { field: string; message: string }[] };

/** One period's requirement rows, with the aggregate version — the editor's load. */
export async function readRequirementSet(
  uow: Uow,
  periodId: string,
): Promise<{ requirements: readonly RequirementRowView[]; version: number }> {
  const rows = (await uow.query
    .selectFrom('schedule_requirements')
    .select(['id', 'date', 'shift_type_id', 'required_count'])
    .where('period_id', '=', periodId)
    .orderBy('date')
    .orderBy('shift_type_id')
    .execute()) as unknown as {
    id: string;
    date: string | Date;
    shift_type_id: string;
    required_count: number;
  }[];
  return {
    requirements: rows.map((row) => ({
      id: row.id,
      date: calendarDate(row.date),
      shiftTypeId: row.shift_type_id,
      requiredCount: row.required_count,
    })),
    version: await readStaffingSetVersion(uow, 'period_requirements', periodId),
  };
}

/**
 * Replace a period's WHOLE requirement set — the atomic aggregate
 * (OPUS-M4-000A; doc 34 §4-A). The canonical omitted-entry rule, stated in
 * the contract and on the page: **saving produces exactly the presented set;
 * an entry omitted from the request is DELETED.** An explicit zero is a real
 * entry and is STORED — on this surface, unlike the catalogue's weekday grid,
 * absent and zero are different statements (a period-dated zero overrides
 * whatever a weekday default would imply, doc 07 §1's default-vs-instance
 * distinction), so no zero-normalisation happens here.
 *
 * Concurrency: `acquireStaffingSet` (the M3-004 lock-then-read shape, on the
 * aggregate) serializes writers per period and refuses a stale
 * `expectedVersion` with the current version. Two concurrent replacements can
 * never combine into a union — proven by the 12-round DB-asserted race in
 * `apps/api/test/schedule/authoring-concurrency.test.ts` (B-1).
 *
 * The no-op is a byte-level no-op: an identical presented set issues no
 * statement, bumps nothing, and is not audited as a change (FAD-24, with the
 * emission control in the same test file).
 */
export async function replaceRequirements(
  uow: Uow,
  actor: ScheduleActor,
  periodId: string,
  body: { readonly requirements: readonly RequirementSetEntry[]; readonly expectedVersion: number },
): Promise<RequirementReplaceOutcome> {
  await requireScheduleCapability(uow, actor, 'periodAdminister');
  const tenant = tenantOf(uow.context);

  const seen = new Set<string>();
  for (const entry of body.requirements) {
    const key = `${entry.date}|${entry.shiftTypeId}`;
    if (seen.has(key)) {
      return {
        kind: 'invalid',
        problems: [
          {
            field: 'requirements',
            message: `The set names ${entry.date} × ${entry.shiftTypeId} more than once.`,
          },
        ],
      };
    }
    seen.add(key);
  }

  // Serialize FIRST, before any read the diff is computed from (the M3-004
  // lesson: an unlocked CAS read under READ COMMITTED protects nothing).
  const acquisition = await acquireStaffingSet(
    uow,
    'period_requirements',
    periodId,
    body.expectedVersion,
  );
  if (acquisition.kind === 'stale') {
    return { kind: 'stale-set', currentVersion: acquisition.currentVersion };
  }

  const existing = (await uow.query
    .selectFrom('schedule_requirements')
    .select(['id', 'date', 'shift_type_id', 'required_count'])
    .where('period_id', '=', periodId)
    .execute()) as unknown as {
    id: string;
    date: string | Date;
    shift_type_id: string;
    required_count: number;
  }[];
  const existingByKey = new Map(
    existing.map((row) => [`${calendarDate(row.date)}|${row.shift_type_id}`, row]),
  );

  const desired = new Map(
    body.requirements.map((entry) => [`${entry.date}|${entry.shiftTypeId}`, entry]),
  );

  const toInsert = [...desired.values()].filter(
    (entry) => !existingByKey.has(`${entry.date}|${entry.shiftTypeId}`),
  );
  const toUpdate = [...desired.values()]
    .map((entry) => ({ entry, row: existingByKey.get(`${entry.date}|${entry.shiftTypeId}`) }))
    .filter(
      (pair): pair is { entry: RequirementSetEntry; row: (typeof existing)[number] } =>
        pair.row !== undefined && pair.row.required_count !== pair.entry.requiredCount,
    );
  const toDelete = existing.filter(
    (row) => !desired.has(`${calendarDate(row.date)}|${row.shift_type_id}`),
  );

  const changed = toInsert.length > 0 || toUpdate.length > 0 || toDelete.length > 0;

  if (toInsert.length > 0) {
    await uow.query
      .insertInto('schedule_requirements')
      .values(
        toInsert.map((entry) => ({
          id: randomUUID(),
          ...tenant,
          period_id: periodId,
          date: entry.date,
          shift_type_id: entry.shiftTypeId,
          required_count: entry.requiredCount,
        })),
      )
      .execute();
  }

  // By ROW ID: the row this transaction read is the row it acts on.
  for (const { entry, row } of toUpdate) {
    await uow.query
      .updateTable('schedule_requirements')
      .set({ required_count: entry.requiredCount, updated_at: new Date() })
      .where('id', '=', row.id)
      .execute();
  }

  if (toDelete.length > 0) {
    await uow.query
      .deleteFrom('schedule_requirements')
      .where(
        'id',
        'in',
        toDelete.map((row) => row.id),
      )
      .execute();
  }

  const after = await readRequirementSet(uow, periodId);

  if (changed) {
    // ONE event for one user action (I-10's audit shadow): the aggregate save
    // is a single administrative act, and its record carries the counts and
    // the resulting set version. NOT emitted for a no-op (FAD-24).
    await recordAuditEvent(uow, {
      eventName: 'schedule.period.updated',
      subjectType: 'schedule_period',
      subjectId: periodId,
      payload: {
        mechanism: 'requirements_replaced',
        added: toInsert.length,
        updated: toUpdate.length,
        deleted: toDelete.length,
        setVersion: after.version,
      },
    });
  }

  return {
    kind: 'ok',
    value: {
      requirements: after.requirements,
      version: after.version,
      changed,
      addedCount: toInsert.length,
      updatedCount: toUpdate.length,
      deletedCount: toDelete.length,
    },
  };
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

  /* The timezone interpretation this version's instants will be derived under,
   * recorded at the moment the draft comes into existence (OPUS-M4-000B, doc 34
   * §4-F). Recorded HERE rather than at publication because that is when the
   * derivation actually happens: every `starts_at`/`ends_at` written into this
   * version resolves against the group's zone as it is now, and a basis captured
   * later would describe the zone at publication rather than the zone the
   * content was built in. */
  const basis = await captureTimezoneBasis(uow);

  await uow.query
    .insertInto('schedule_versions')
    .values({
      id,
      ...tenant,
      period_id: periodId,
      state: 'draft',
      timezone_basis: basis.zone,
      tzdb_version: basis.tzdb,
    })
    .execute();

  await recordAuditEvent(uow, {
    eventName: 'schedule.version.created',
    subjectType: 'schedule_version',
    subjectId: id,
    payload: { period: periodId, origin: 'new', timezone: basis.zone },
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

  /* The clone INHERITS the source's timezone basis, and does not capture the
   * current one (OPUS-M4-000B; doc 35 §4 as amended, escalation E1).
   *
   * A clone copies `starts_at`/`ends_at` VERBATIM — the instants written below
   * are the source's, derived under the source's zone. Stamping the clone with
   * today's zone would assert that content was built under an interpretation it
   * was not, and the publication staleness check would then PASS on a draft
   * whose instants are an hour out. Inheriting means cloning a version authored
   * before a timezone change produces a draft that is correctly reported STALE,
   * which is what makes the scheduler re-derive instead of publishing an
   * unnoticed shift.
   *
   * `cloneVersion` is jointly edited in M4 (000B: these two columns; 000C:
   * credit preservation). This edit is exactly one read and two `.values()`
   * keys, and the proof in `test/schedule/timezone-basis.test.ts` asserts on
   * the INHERITED COLUMNS rather than on this function's body, so it survives
   * the composition. */
  const sourceBasis = await readTimezoneBasis(uow, sourceVersionId);

  await uow.query
    .insertInto('schedule_versions')
    .values({
      id: newVersionId,
      ...tenant,
      period_id: source.period_id,
      state: 'draft',
      cloned_from_version_id: sourceVersionId,
      timezone_basis: sourceBasis?.zone ?? null,
      tzdb_version: sourceBasis?.tzdb ?? null,
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

  /* ── OPUS-M4-000C: credits are PRESERVED across the clone (doc 34 §4-G) ────
   *
   * Self-contained on purpose: one call, after the snapshots exist and before
   * the audit row, touching nothing above it. `cloneVersion` is a jointly-edited
   * function this milestone and the composition has to be clean.
   *
   * ## Why this was a real gap
   *
   * A revert is a clone-then-publish (SPEC-05 §6.1), and a clone dropped every
   * credit. So reverting to v3 produced a v5 whose ASSIGNMENTS were v3's and
   * whose CREDITS were empty — every credit move a scheduler had made silently
   * undone, on the one operation whose entire purpose is to restore a previous
   * state. The same hole made an ordinary amendment lose credits: clone v2, edit
   * one shift, publish, and everybody's credit for the other shifts is gone.
   *
   * ## Voided credits are cloned too, and that is deliberate
   *
   * A voided credit is a RECORD that a credit was withdrawn. Dropping the voided
   * rows and keeping the rest would make the clone say "nobody was ever credited
   * for this", which is a different claim from "somebody was, and it was
   * withdrawn" — and the difference is exactly what an audit of a credit dispute
   * needs. `status` is carried verbatim.
   */
  await cloneCredits(uow, sourceVersionId, newVersionId);

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

/**
 * Copy every credit from one version to another, re-keyed to the clone
 * (OPUS-M4-000C, doc 34 §4-G).
 *
 * ## The re-keying, and the one subtlety in it
 *
 * V-23 keys a credit on (identity, source version, source snapshot). Identity is
 * PRESERVED by the clone — that is the whole point of the clone — so it carries
 * over unchanged. `source_version_id` becomes the new version. `source_snapshot_id`
 * must become the CLONE's snapshot for that identity, not the source's: a credit
 * pointing at a snapshot in another version would be a cross-version reference
 * that looks correct and resolves to a row the clone does not own.
 *
 * So the new snapshot is looked up by identity within the target version, which
 * is unambiguous: D-14 permits exactly one snapshot per identity per version.
 *
 * `weight`, `reason` and `status` are carried verbatim. `moved_by` is carried
 * too, because the person who moved the credit is a fact about the credit and
 * not about the clone — rewriting it to the cloner would put the wrong name on
 * somebody else's decision.
 *
 * Exported so the proof can call it directly against a crafted credit set
 * (moved and voided credits included) without going through a whole clone.
 */
export async function cloneCredits(
  uow: Uow,
  sourceVersionId: string,
  targetVersionId: string,
): Promise<number> {
  const tenant = tenantOf(uow.context);

  const sourceCredits = await uow.query
    .selectFrom('credits')
    .select([
      'assignment_identity_id',
      'credited_membership_id',
      'weight',
      'reason',
      'moved_by',
      'status',
    ])
    .where('source_version_id', '=', sourceVersionId)
    .execute();
  if (sourceCredits.length === 0) return 0;

  // Identity → the CLONE's snapshot. D-14 makes this a function, not a relation.
  const cloneSnapshots = await uow.query
    .selectFrom('assignment_snapshots')
    .select(['id', 'assignment_identity_id'])
    .where('version_id', '=', targetVersionId)
    .execute();
  const snapshotByIdentity = new Map(
    cloneSnapshots.map((row) => [row.assignment_identity_id, row.id]),
  );

  let cloned = 0;
  for (const credit of sourceCredits) {
    const snapshotId = snapshotByIdentity.get(credit.assignment_identity_id);
    if (snapshotId === undefined) {
      /* The source credit names an identity the clone does not carry — a credit
       * against a CANCELLED snapshot, whose row the clone still copies, or a
       * credit whose snapshot was never cloned. It is skipped rather than
       * pointed at a foreign snapshot: a dangling reference that still looks
       * correct is the failure mode `assignment_identities` exists to prevent.
       */
      continue;
    }
    await uow.query
      .insertInto('credits')
      .values({
        id: randomUUID(),
        ...tenant,
        assignment_identity_id: credit.assignment_identity_id,
        source_version_id: targetVersionId,
        source_snapshot_id: snapshotId,
        credited_membership_id: credit.credited_membership_id,
        weight: credit.weight,
        reason: credit.reason,
        // The person who moved it, not the person who cloned it.
        moved_by: credit.moved_by,
        status: credit.status,
      })
      .execute();
    cloned += 1;
  }
  return cloned;
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
  /**
   * The location this shift happens at, or `null` for an un-located shift
   * (OPUS-M4-000B). `null` is a stated allowed state, not a missing value.
   */
  readonly locationId?: string | null;
  /**
   * **Who placed this assignment** — `'manual'` (a human) or `'solver'` (a build
   * whose candidate was approved and selected). FAD-44(1), OPUS-M4-003.
   *
   * ## Why this parameter exists rather than a second writer
   *
   * Migration 0009 has admitted `origin ∈ {manual, clone, solver, picklist}`
   * since the schedule spine landed, and this function could write only one of
   * them. M4-003's selection therefore had a choice between recording every
   * solver-produced assignment as `'manual'` — the exact conflation non-bypass
   * rule 7 exists to prevent, and one that would also destroy the distinction
   * report 21 §5 draws between "locked manual assignments" and "locked prior
   * solver assignments" for the next progressive stage — or writing the rows
   * itself, which would be a second spelling of the assignment write path.
   *
   * FAD-44(1) ruled: one parameter, one write path. **This function is the only
   * writer of `assignment_snapshots` outside the clone**, and it stays that way.
   *
   * ## The default is `'manual'`, and that is load-bearing
   *
   * Every existing caller omits it and is byte-compatible: the manual authoring
   * routes, the cell editor, the reassignment path. Nothing about the manual
   * path changed, and `authoring-http.test.ts` is unmodified.
   *
   * `'clone'` and `'picklist'` are deliberately NOT in the union. A clone is
   * written by `cloneVersion`'s `INSERT … SELECT`, which preserves the source
   * row's origin verbatim and never comes through here; the picklist is M9. A
   * union that admitted values no caller can legitimately pass would invite one.
   */
  readonly origin?: 'manual' | 'solver';
}

export interface AddedAssignment {
  readonly snapshotId: string;
  readonly assignmentIdentityId: string;
}

/**
 * Find or create the shift row this assignment hangs on, within the version.
 *
 * ## Location (OPUS-M4-000B; doc 34 §4-F)
 *
 * `shifts.location_id` existed from 0009 with no foreign key and no way to set
 * it; migration 0014 adds the group-qualified FK and this parameter is the
 * authoring input that reaches it.
 *
 * **`null` is a real, allowed value and not a missing one.** A single-site group
 * schedules without locations, which is what every existing caller does;
 * `shifts_unique_in_version` already COALESCEs the NULL into a stable key, so
 * "the 08:00 ward round" and "the 08:00 ward round at Site A" are different
 * shifts within one version rather than a collision. The lookup below therefore
 * matches on the location too — a `null` search finds only the un-located shift.
 *
 * A NEW reference to an ARCHIVED location is refused by the database
 * (`SCHEDULE_SHIFT_LOCATION_ARCHIVED`, migration 0014); there is deliberately no
 * pre-check here, because a friendly pre-check would only race the control.
 */
async function ensureShift(
  uow: Uow,
  versionId: string,
  date: string,
  shiftTypeId: string,
  locationId: string | null,
): Promise<string> {
  const tenant = tenantOf(uow.context);
  let lookup = uow.query
    .selectFrom('shifts')
    .select('id')
    .where('version_id', '=', versionId)
    .where('date', '=', date)
    .where('shift_type_id', '=', shiftTypeId);
  lookup =
    locationId === null
      ? lookup.where('location_id', 'is', null)
      : lookup.where('location_id', '=', locationId);
  const existing = await lookup.executeTakeFirst();
  if (existing !== undefined) return existing.id;

  const id = randomUUID();
  await uow.query
    .insertInto('shifts')
    .values({
      id,
      ...tenant,
      version_id: versionId,
      date,
      shift_type_id: shiftTypeId,
      location_id: locationId,
    })
    .execute();
  return id;
}

/**
 * The membership-state rules for a NEW assignment target (doc 34 §4-C).
 *
 * The database enforces these independently (migration 0014's
 * `app_guard_assignment_snapshot_graph`), and that trigger is the control. This
 * is the readable error — the same division 0009's `assertEditable` has with
 * D-15a — plus the one thing the trigger cannot give: a typed failure a route
 * can map to a 422 with a field, rather than a raw `restrict_violation`.
 *
 *   R-B1  only an `active` membership is a NEW assignment target
 *   R-B2  the assignment must fall inside the membership's effective window
 *   R-B3  EXISTING assignments are retained when a membership later changes
 *         state — so this is called on a NEW target and on nothing else
 *
 * **There is no override arm.** FAD-23's override exists because an eligibility
 * absence can be an access-control artefact; membership state is not, and an
 * `ended` membership is not a person with a relationship to this group to be
 * scheduled into. The reasoning is set out in full in migration 0014 §9c.
 */
export async function assertAssignableMembership(
  uow: Uow,
  membershipId: string,
  startsAt: Date,
  endsAt: Date,
): Promise<void> {
  const row = (await uow.query
    .selectFrom('memberships')
    .select(['kind', 'status', 'valid_from', 'valid_to'])
    .where('id', '=', membershipId)
    .executeTakeFirst()) as unknown as
    | { kind: string; status: string; valid_from: Date; valid_to: Date | null }
    | undefined;

  if (row === undefined) {
    // The cross-tenant and cross-group answer are deliberately the same reply:
    // RLS makes another group's membership invisible under this context.
    throw new SchedulePreconditionError(
      'ASSIGNEE_NOT_IN_GROUP',
      'no such member of this group',
    );
  }

  if (row.kind !== 'group') {
    throw new SchedulePreconditionError(
      'ASSIGNEE_NOT_GROUP_MEMBERSHIP',
      'a schedule participant is a group membership; an organization membership cannot be assigned',
    );
  }

  if (row.status !== 'active') {
    throw new SchedulePreconditionError(
      'ASSIGNEE_NOT_ACTIVE',
      `membership ${membershipId} is ${row.status}; only an active membership is a NEW ` +
        'assignment target. Assignments already made are retained',
    );
  }

  if (startsAt.getTime() < row.valid_from.getTime()) {
    throw new SchedulePreconditionError(
      'ASSIGNEE_BEFORE_MEMBERSHIP',
      `the assignment starts before membership ${membershipId} becomes effective`,
    );
  }

  if (row.valid_to !== null && endsAt.getTime() > row.valid_to.getTime()) {
    throw new SchedulePreconditionError(
      'ASSIGNEE_AFTER_MEMBERSHIP',
      `the assignment ends after membership ${membershipId} ends`,
    );
  }
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
  /* FAD-44(1). Defaulted here rather than at each use, so the identity row and
   * the snapshot row cannot disagree about who placed the assignment. */
  const origin = input.origin ?? 'manual';

  /* Ordering, before anything else touches the database (OPUS-M4-000B, review
   * B-1). `assignment_snapshots_interval` (`ends_at > starts_at`) is the
   * control and stays the control — but a caller that reached it got a raw
   * CHECK violation, i.e. a 500 for a condition that is fully describable. The
   * defect that made this reachable was a DST-gap interval resolving backwards
   * (now closed by R-B4a); the guard stays regardless, because "no caller can
   * construct one any more" is a claim about today's callers. */
  if (input.endsAt.getTime() <= input.startsAt.getTime()) {
    throw new SchedulePreconditionError(
      'ASSIGNMENT_INTERVAL_INVALID',
      `an assignment must end after it starts; ${input.startsAt.toISOString()} to ` +
        `${input.endsAt.toISOString()} does not advance`,
    );
  }

  await assertAssignableMembership(uow, input.membershipId, input.startsAt, input.endsAt);

  const shiftId = await ensureShift(
    uow,
    input.versionId,
    input.date,
    input.shiftTypeId,
    input.locationId ?? null,
  );

  let identityId = input.assignmentIdentityId;
  if (identityId === undefined) {
    identityId = randomUUID();
    await uow.query
      .insertInto('assignment_identities')
      /* The identity carries the origin too, and it must: the identity is the
       * thing that spans versions, so "was this assignment ever solver-made?"
       * has to be answerable without reading every snapshot of it. */
      .values({ id: identityId, ...tenant, period_id: version.period_id, origin })
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
      origin,
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
      // FAD-44(1): which mechanism placed it. A closed vocabulary, never text.
      origin,
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

  /* A reassignment names a NEW assignment target, so R-B1/R-B2 apply to it
   * exactly as they do to a first assignment (doc 34 §4-C). Reassigning ONTO an
   * ended or suspended membership is the same act as assigning to one; the
   * identity being preserved does not make the target any more available. */
  const interval = (await uow.query
    .selectFrom('assignment_snapshots')
    .select(['starts_at', 'ends_at'])
    .where('id', '=', current.id)
    .executeTakeFirstOrThrow()) as unknown as { starts_at: Date; ends_at: Date };
  await assertAssignableMembership(uow, toMembershipId, interval.starts_at, interval.ends_at);

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
