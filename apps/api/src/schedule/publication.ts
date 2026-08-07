import { randomUUID } from 'node:crypto';

import type { UnitOfWork } from '@schedulepoint/domain';
import { PUBLICATION_IDEMPOTENCY_KEY_PATTERN } from '@schedulepoint/contracts';
import { sql, type Kysely } from 'kysely';

import { recordAuditEvent } from '../audit/recorder.js';
import type { RecordedAuditEvent } from '@schedulepoint/domain';
import type { Database } from '../db/schema.js';
import { publishOutboxEvent } from '../outbox/publisher.js';
import { requireScheduleCapability, type ScheduleActor } from './actions.js';
import { differenceByIdentity, type DiffSnapshot, type VersionDifference } from './diff.js';
import { SchedulePreconditionError } from './errors.js';
import { assertHardRulesRevalidated } from './hard-rule-revalidation.js';
import { assertNoOpenHardBreach } from './service.js';

/**
 * The publication transaction — SPEC-05 §6.
 *
 * ## One transaction, one commit point
 *
 * Doc 07 §3: "Publication is one database transaction. This is a deliberate
 * architectural choice and the strongest argument for the modular monolith: in a
 * service-oriented design this would be a saga with compensating actions, and
 * the failure modes would be materially worse." SPEC-12's I-22 says the same:
 * one owning module, one commit point, other modules reached through their
 * ports (audit, outbox), effects outside the transaction only after commit.
 *
 * This function therefore takes the caller's unit of work and never opens one.
 * Everything below happens inside it, and the caller's commit is the publication.
 *
 * ## Failure means nothing happened
 *
 * There is no partial publication. Because the whole sequence is one
 * transaction, a process killed at any point leaves the database exactly as it
 * was — a stronger guarantee than the SPEC's "a `publishing` row observed after
 * failover is resolved by the reconciler", and the reconciler
 * (`reconcileStalePublishing`) still exists for a durable `publishing` row
 * however it arose. V-16 proves both halves.
 *
 * ## Notification failure never rolls back a publication (I-11)
 *
 * What is written inside the transaction is an *intent* — an `outbox_events`
 * row. Delivery happens after commit, in the worker, and a delivery failure
 * retries against a publication that has already happened. The converse is also
 * true and is the other half of the boundary: if the outbox WRITE fails, the
 * transaction has not committed, so the publication rolls back atomically and no
 * one is told about a schedule that does not exist. Both halves are proven.
 */

type Uow = UnitOfWork<Kysely<Database>>;

export interface PublishInput {
  readonly periodId: string;
  readonly versionId: string;
  /** D-17. A retried publication publishes once. */
  readonly idempotencyKey: string;
  /** SPEC-05 §6 step 03. The publication asserts the state it was told to expect. */
  readonly expectedVersionState?: string;
  /**
   * The version the caller believed was current when it decided to publish.
   *
   * **REQUIRED** (FAD-22(2)), and nullable: `null` means "I believe nothing is
   * current yet", a first publication.
   *
   * It was optional, and the independent review showed why that could not
   * stand: §6's same-key and same-version mechanisms only catch same-version
   * races, so two concurrent publications of DIFFERENT approved versions both
   * succeeded, one instantly superseding the other. V-12's "the loser fails
   * explicitly" cannot hold when the compare-and-set can simply be omitted, and
   * an omitted CAS is indistinguishable from a caller that never thought about
   * concurrency at all.
   *
   * This is doc 07 §3.1's rule applied to publication: "A stale edit is
   * rejected, never merged blindly."
   */
  readonly expectedPriorCurrentVersionId: string | null;
}

export interface PublishResult {
  /** `true` when the idempotency key had already published: nothing was emitted. */
  readonly replay: boolean;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly priorCurrentVersionId: string | null;
  readonly difference: VersionDifference;
  /** `null` on a replay — exactly one outbox event exists, from the first run. */
  readonly outboxEventId: string | null;
}

/**
 * The outbox write, injectable **solely** so the I-11 boundary can be proven
 * from both sides.
 *
 * A fault-injected pre-commit failure is not otherwise reachable from a test,
 * and an unprovable invariant is the thing this repository treats as a defect.
 * The default is the real publisher; no production caller passes anything. This
 * widens no permission and skips no check — it substitutes one function that
 * writes a row for one that throws.
 */
export interface PublicationDependencies {
  readonly publishOutbox?: typeof publishOutboxEvent;
}

interface VersionRow {
  readonly id: string;
  readonly period_id: string;
  readonly state: string;
  readonly version_number: number | null;
}

/**
 * What the publication record remembers, so a replay can answer from the record
 * rather than from a guess (FAD-22(3)).
 *
 * The affected-membership LIST is stored here even though the outbox payload
 * cannot carry it (`assertClosedAuditPayload` admits scalars only). That is the
 * right split: the outbox row is a delivery intent and stays scalar, while the
 * publication record is the durable account of what happened and is read only
 * by the publication path itself.
 */
interface PrerequisitesSnapshot {
  readonly expectedVersionState?: string;
  readonly versionNumber?: number;
  readonly priorCurrentVersionId?: string | null;
  readonly affectedMembershipIds?: readonly string[];
  readonly affectedCount?: number;
}

/** Rows the difference and `current_published_assignments` are computed from. */
async function activeSnapshotsOf(uow: Uow, versionId: string): Promise<DiffSnapshot[]> {
  const rows = await uow.query
    .selectFrom('assignment_snapshots')
    .select(['assignment_identity_id', 'membership_id', 'starts_at', 'ends_at', 'status'])
    .where('version_id', '=', versionId)
    .execute();
  return rows.map((row) => ({
    assignmentIdentityId: row.assignment_identity_id,
    membershipId: row.membership_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
  }));
}

export async function publishVersion(
  uow: Uow,
  actor: ScheduleActor,
  input: PublishInput,
  deps: PublicationDependencies = {},
): Promise<PublishResult> {
  const publishOutbox = deps.publishOutbox ?? publishOutboxEvent;
  const expectedState = input.expectedVersionState ?? 'approved';
  const { organizationId, groupId } = uow.context;
  if (groupId === null) {
    throw new Error('SCHEDULE_REQUIRES_GROUP_CONTEXT: publication needs a group-scoped context');
  }

  /* 00 — the key's SHAPE, before anything else happens (FAD-22(3)).
   *
   *      Checked first so a malformed key is a caller error answered before the
   *      capability read, the lock and the writes — never a raw 23514 from the
   *      middle of the transaction, which is a 500-shaped failure for what is a
   *      422-shaped mistake. The CHECK on `publication_records` still holds the
   *      property for any caller that never came through here. */
  if (!PUBLICATION_IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)) {
    throw new SchedulePreconditionError(
      'IDEMPOTENCY_KEY_INVALID',
      'a publication idempotency key is 1–64 characters of letters, digits, underscore, ' +
        'dot or hyphen',
    );
  }

  // Evaluated INSIDE the publishing transaction, so a grant revoked while the
  // publication is in flight denies it (I-19). Publishing is its own capability,
  // distinct from editing (doc 08 §4, grant-only).
  await requireScheduleCapability(uow, actor, 'publish');

  /* 02 — the single-writer point for this period. Two concurrent publications
   *      both arrive here; the second waits, and then either replays (step 01,
   *      below) or fails at step 03 because the first moved the version out of
   *      `approved` (V-12). Publications for DIFFERENT periods take different
   *      locks and do not contend (V-15b).
   *
   *      The lock is taken BEFORE the idempotency read, which is a deliberate
   *      reordering of §6's step 01/02 (N-4). With the read first, two
   *      concurrent publications sharing a key but naming DIFFERENT versions
   *      both saw "no record", both proceeded, and the loser died on a raw 23505
   *      from the step-15 insert — a unique-violation leak instead of a decision.
   *      Under the lock the read is authoritative, so the second attempt sees the
   *      committed record and takes the replay path deterministically. */
  const period = await uow.query
    .selectFrom('schedule_periods')
    .select('id')
    .where('id', '=', input.periodId)
    .forUpdate()
    .executeTakeFirst();
  if (period === undefined) {
    throw new SchedulePreconditionError('PERIOD_NOT_FOUND', 'no such schedule period');
  }

  /* 01 — idempotency (D-17). A replay returns the RECORDED result and emits
   *      nothing: no second outbox event, no second audit row, no supersession.
   *
   *      The recorded outcome is read back out of `prerequisites_snapshot`
   *      rather than fabricated (FAD-22(3)). The first version of this returned
   *      `priorCurrentVersionId: null` and an empty difference to EVERY replay,
   *      which is a lie a caller cannot detect: a retry after a dropped
   *      connection would have been told nobody was affected. */
  const existing = await sql<{
    version_id: string;
    outcome: string;
    prerequisites_snapshot: PrerequisitesSnapshot;
  }>`SELECT version_id, outcome, prerequisites_snapshot
       FROM publication_records
      WHERE period_id = ${input.periodId}
        AND publication_idempotency_key = ${input.idempotencyKey}`.execute(uow.query);
  const replayed = existing.rows[0];
  if (replayed !== undefined) {
    /* A reused key naming a DIFFERENT version is a caller defect, not a replay.
     * Silently returning the first version's result would tell the caller its
     * publication succeeded when a different one did. */
    if (replayed.version_id !== input.versionId) {
      throw new SchedulePreconditionError(
        'IDEMPOTENCY_KEY_REUSED_FOR_DIFFERENT_VERSION',
        `idempotency key already published version ${replayed.version_id} in this period; ` +
          `it cannot be reused for version ${input.versionId}`,
      );
    }
    const snapshot = replayed.prerequisites_snapshot ?? {};
    return {
      replay: true,
      versionId: replayed.version_id,
      versionNumber: snapshot.versionNumber ?? 0,
      priorCurrentVersionId: snapshot.priorCurrentVersionId ?? null,
      difference: {
        changes: [],
        affectedMembershipIds: snapshot.affectedMembershipIds ?? [],
      },
      outboxEventId: null,
    };
  }

  /* 03 — the version is in the state the caller expected. */
  const version = (await uow.query
    .selectFrom('schedule_versions')
    .select(['id', 'period_id', 'state', 'version_number'])
    .where('id', '=', input.versionId)
    .executeTakeFirst()) as VersionRow | undefined;
  if (version === undefined) {
    throw new SchedulePreconditionError('VERSION_NOT_FOUND', 'no such schedule version');
  }
  if (version.period_id !== input.periodId) {
    throw new SchedulePreconditionError(
      'VERSION_PERIOD_MISMATCH',
      'the version does not belong to the period whose lock was taken',
    );
  }
  if (version.state !== expectedState) {
    // The concurrent loser's explicit failure. It names what it found, so the
    // scheduler is told which publication won rather than given a generic error.
    throw new SchedulePreconditionError(
      'VERSION_STATE_UNEXPECTED',
      `version ${input.versionId} is ${version.state}, expected ${expectedState}; ` +
        'another publication may have won the period',
    );
  }

  /* 04 — `publishing`. Durable only in the sense that it is committed with
   *      everything else; a failure rolls it back with the rest. */
  await uow.query
    .updateTable('schedule_versions')
    .set({ state: 'publishing', updated_at: new Date() })
    .where('id', '=', input.versionId)
    .execute();

  /* 05 — prerequisites RE-CHECKED at commit, not only at approval: the world can
   *      change between clicking publish and the transaction committing. */
  await assertNoOpenHardBreach(uow, input.versionId);

  /* 06 — HARD-rule re-validation (SPEC-04 §3.3), landed by OPUS-M3-008.
   *
   *      Until this packet the step was deliberately absent: the typed rule model
   *      was OPUS-M3-002, running in parallel, and packet 32 §6 ruled that
   *      compiled rules and schedule content "become joint inputs only in M4 and
   *      in M3-004's validation display — any earlier join = integration packet".
   *      This IS the integration packet, so the join happens here and nowhere
   *      else.
   *
   *      It is a CHECK over content that already exists — one bounded pass per
   *      active HARD rule. There is no search, no objective and no assignment
   *      generation; SPEC-04 §3.3 calls this the "independent checker" and keeps
   *      it separate from the solver on purpose (non-bypass rule 7).
   *
   *      Re-checked HERE rather than only at approval for the same reason step 05
   *      is: a credential can expire, and a rule can be authored, between the
   *      moment a version was approved and the moment it commits. */
  await assertHardRulesRevalidated(uow, input.versionId);

  /* 07 — gapless version number for the period (D-9), allocated in-transaction. */
  const highest = await uow.query
    .selectFrom('schedule_versions')
    .select(uow.query.fn.max('version_number').as('highest'))
    .where('period_id', '=', input.periodId)
    .executeTakeFirst();
  const versionNumber = Number(highest?.highest ?? 0) + 1;

  /* 08 — clear `is_current` on the outgoing version FIRST. D-16's partial unique
   *      index would otherwise refuse step 09, and there is deliberately never
   *      an instant with two current versions.
   *
   *      NOTE: `updated_at` is NOT touched. On a published row D-15b freezes
   *      every column except the four permitted ones, and `updated_at` is not
   *      among them — writing it would (correctly) raise. */
  const priorCurrent = await uow.query
    .selectFrom('schedule_versions')
    .select(['id'])
    .where('period_id', '=', input.periodId)
    .where('is_current', '=', true)
    .executeTakeFirst();

  const priorCurrentVersionId = priorCurrent?.id ?? null;

  /* The compare-and-set, now UNCONDITIONAL (FAD-22(2)). Read under the step-02
   * period lock, so by the time this compares, no other publication for this
   * period can be between its own read and its own write. */
  if (input.expectedPriorCurrentVersionId !== priorCurrentVersionId) {
    throw new SchedulePreconditionError(
      'CURRENT_VERSION_MOVED',
      `the current version of period ${input.periodId} is ` +
        `${priorCurrentVersionId ?? 'none'}, not the expected ` +
        `${input.expectedPriorCurrentVersionId ?? 'none'}; another publication won the period`,
    );
  }

  if (priorCurrentVersionId !== null) {
    await uow.query
      .updateTable('schedule_versions')
      .set({ is_current: false })
      .where('id', '=', priorCurrentVersionId)
      .execute();
  }

  /* 09 — the incoming version becomes current and published. */
  const publishedAt = new Date();
  await uow.query
    .updateTable('schedule_versions')
    .set({
      state: 'published',
      is_current: true,
      version_number: versionNumber,
      published_at: publishedAt,
      published_by: uow.context.membershipId,
      updated_at: publishedAt,
    })
    .where('id', '=', input.versionId)
    .execute();

  /* 10/11 — supersession is a CONSEQUENCE of publication, never an independent
   *         operation, and it never modifies the prior version in any other way. */
  if (priorCurrentVersionId !== null) {
    await sql`
      INSERT INTO version_supersessions
        (id, organization_id, group_id, superseded_version_id, superseding_version_id)
      VALUES (${randomUUID()}, ${organizationId}, ${groupId},
              ${priorCurrentVersionId}, ${input.versionId})
    `.execute(uow.query);

    await uow.query
      .updateTable('schedule_versions')
      .set({
        state: 'superseded',
        superseded_at: publishedAt,
        superseded_by_version_id: input.versionId,
      })
      .where('id', '=', priorCurrentVersionId)
      .execute();
  }

  /* 12 — reality (V-21 / FD-8). Delete the outgoing version's rows, insert the
   *      incoming version's, under the step-02 period lock. The EXCLUDE
   *      constraint (D-1b) raises HERE and aborts the publication if this
   *      version double-books anyone across periods. */
  if (priorCurrentVersionId !== null) {
    // Through the SECURITY DEFINER prune, not a DELETE: R-05 keeps table-level
    // DELETE off every runtime role, and the function scopes itself to this
    // source version AND this tenant, read from the transaction-local context.
    await sql`SELECT app_schedule_prune_current_assignments(${priorCurrentVersionId})`.execute(
      uow.query,
    );
  }

  const incoming = await uow.query
    .selectFrom('assignment_snapshots')
    .select(['id', 'assignment_identity_id', 'membership_id', 'starts_at', 'ends_at'])
    .where('version_id', '=', input.versionId)
    .where('status', '=', 'active')
    .execute();

  for (const row of incoming) {
    await uow.query
      .insertInto('current_published_assignments')
      .values({
        id: randomUUID(),
        organization_id: organizationId,
        group_id: groupId,
        membership_id: row.membership_id,
        period_id: input.periodId,
        starts_at: row.starts_at,
        ends_at: row.ends_at,
        source_version_id: input.versionId,
        source_snapshot_id: row.id,
        assignment_identity_id: row.assignment_identity_id,
      })
      .execute();
  }

  /* The affected-staff difference, against the version that was current. */
  const before =
    priorCurrentVersionId === null ? [] : await activeSnapshotsOf(uow, priorCurrentVersionId);
  const after = await activeSnapshotsOf(uow, input.versionId);
  const difference = differenceByIdentity(before, after);

  /* 14 — audit, in the same unit of work as the mutation (FAD-12). */
  const audit: RecordedAuditEvent = await recordAuditEvent(uow, {
    eventName: 'schedule.version.published',
    subjectType: 'schedule_version',
    subjectId: input.versionId,
    payload: {
      period: input.periodId,
      number: versionNumber,
      affected: difference.affectedMembershipIds.length,
      changes: difference.changes.length,
    },
  });

  if (priorCurrentVersionId !== null) {
    await recordAuditEvent(uow, {
      eventName: 'schedule.version.superseded',
      subjectType: 'schedule_version',
      subjectId: priorCurrentVersionId,
      payload: { supersededBy: input.versionId, period: input.periodId },
    });
  }

  /* 13 — EXACTLY ONE outbox event per publication, and it is an INTENT.
   *
   *      The payload carries scalars only: `assertClosedAuditPayload` admits no
   *      arrays, so the affected-membership LIST cannot live here. That is a
   *      constraint worth keeping rather than working around — the recipient set
   *      is re-derivable exactly, by differencing the two versions, and both
   *      versions are immutable once published, so the derivation is stable
   *      forever. The count travels so a dispatcher can detect a mismatch. */
  const published = await publishOutbox(uow, audit, {
    kind: 'schedule.version.published',
    idempotencyKey: `schedule-publish:${input.periodId}:${input.idempotencyKey}`,
    payload: {
      period: input.periodId,
      version: input.versionId,
      priorVersion: priorCurrentVersionId ?? 'none',
      affected: difference.affectedMembershipIds.length,
    },
  });

  /* 15 — the append-only publication record. Written last, so its presence means
   *      the whole sequence succeeded; D-17's unique key makes the retry a
   *      replay. No UPDATE/DELETE grant exists on this table (D-15d). */
  await sql`
    INSERT INTO publication_records
      (id, organization_id, group_id, period_id, version_id,
       publication_idempotency_key, actor_membership_id, prerequisites_snapshot, outcome)
    VALUES (${randomUUID()}, ${organizationId}, ${groupId}, ${input.periodId},
            ${input.versionId}, ${input.idempotencyKey}, ${uow.context.membershipId},
            ${JSON.stringify({
              expectedVersionState: expectedState,
              versionNumber,
              priorCurrentVersionId,
              // The LIST, so a replay answers with the real recipients rather
              // than an empty set (FAD-22(3)).
              affectedMembershipIds: difference.affectedMembershipIds,
              affectedCount: difference.affectedMembershipIds.length,
            } satisfies PrerequisitesSnapshot)}::jsonb, 'published')
  `.execute(uow.query);

  return {
    replay: false,
    versionId: input.versionId,
    versionNumber,
    priorCurrentVersionId,
    difference,
    outboxEventId: published.id,
  };
}

/**
 * Revert by publishing FORWARD (SPEC-05 §6.1).
 *
 * "Reverting to v3 creates v5 with v3's content. Deleting v4 would erase the
 * fact that it happened" (doc 07 §2.1). So a revert is exactly: clone the target
 * historical version into a new draft, approve it, publish it. History stays a
 * straight line and the revert is itself a recorded act.
 *
 * The clone is performed by the caller (`cloneVersion`) so that a revert is
 * visibly the same two operations any amendment is; this function is the
 * publication half, distinguished only by its own capability and its own audit
 * event. `schedule.revert` is a DIFFERENT grant from `schedule.publish`.
 */
export async function publishRevert(
  uow: Uow,
  actor: ScheduleActor,
  input: PublishInput & { readonly revertedToVersionId: string },
  deps: PublicationDependencies = {},
): Promise<PublishResult> {
  await requireScheduleCapability(uow, actor, 'revert');
  const result = await publishVersion(uow, actor, input, deps);
  if (!result.replay) {
    await recordAuditEvent(uow, {
      eventName: 'schedule.version.reverted',
      subjectType: 'schedule_version',
      subjectId: input.versionId,
      payload: {
        period: input.periodId,
        revertedTo: input.revertedToVersionId,
        number: result.versionNumber,
      },
    });
  }
  return result;
}

/**
 * The reconciler (SPEC-10 §5, V-16).
 *
 * A `publishing` version with no committed publication record is a publication
 * that did not finish. It is returned to `approved` — never forward to
 * `published`, because the transaction that would have published it did not
 * commit, so its `current_published_assignments` rows, its supersession and its
 * outbox event do not exist.
 *
 * Under this module's single-transaction publication such a row cannot arise
 * from a crash — the transaction rolls back whole. The reconciler exists
 * because "cannot arise" is a claim about today's implementation, and the cost
 * of being wrong about it is a period that can never be published again.
 *
 * A `cancelled` version is deliberately NOT resurrected: the reconciler moves
 * `publishing` rows and nothing else.
 */
export async function reconcileStalePublishing(uow: Uow): Promise<readonly string[]> {
  const stale = await sql<{ id: string }>`
    SELECT v.id
      FROM schedule_versions v
     WHERE v.state = 'publishing'
       AND NOT EXISTS (
             SELECT 1 FROM publication_records p
              WHERE p.version_id = v.id AND p.outcome = 'published')
  `.execute(uow.query);

  const recovered: string[] = [];
  for (const row of stale.rows) {
    await uow.query
      .updateTable('schedule_versions')
      .set({ state: 'approved', updated_at: new Date() })
      .where('id', '=', row.id)
      .execute();
    await recordAuditEvent(uow, {
      eventName: 'schedule.publication.failed',
      subjectType: 'schedule_version',
      subjectId: row.id,
      payload: { recoveredTo: 'approved' },
      systemActor: true,
    });
    recovered.push(row.id);
  }
  return recovered;
}
