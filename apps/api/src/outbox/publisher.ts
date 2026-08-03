import { randomUUID } from 'node:crypto';

import {
  assertClosedAuditPayload,
  type OutboxPublication,
  type OutboxPublisher,
  type PublishedOutboxEvent,
  type RecordedAuditEvent,
  type UnitOfWork,
} from '@schedulepoint/domain';
import { sql, type Kysely } from 'kysely';

import type { Database } from '../db/schema.js';

/**
 * The outbox write — SPEC-11 §3.3, and the atomic half of the async kernel.
 *
 * ## What happens in ONE transaction
 *
 * ```
 *   BEGIN                                   (the unit of work)
 *     …the domain mutation
 *     insert into audit_events              (chain assigned by the trigger)
 *     insert into outbox_events             (linked to that audit sequence)
 *     select app_enqueue_job(...)           (graphile-worker, same transaction)
 *   COMMIT
 * ```
 *
 * All four commit together or none of them does. SP-D E-1 measured the part that
 * is not obvious: `app_enqueue_job` is `SECURITY DEFINER`, and `SECURITY
 * DEFINER` does **not** open a transaction of its own — a rolled-back domain
 * transaction enqueues nothing (E-1.1), and a domain write that fails *after* the
 * enqueue takes the enqueue down with it (E-1.3).
 *
 * ## Ordering and idempotency — what we ACTUALLY have
 *
 * Stated as measured, not as hoped (SP-D §6):
 *
 * | Property | Reality |
 * |---|---|
 * | **Delivery** | **at-least-once.** Retries on failure; re-execution after lease expiry |
 * | **Ordering** | **none across jobs.** graphile-worker orders by `(priority, run_at)` and takes batches `for update skip locked`, so concurrent workers interleave freely |
 * | **Enqueue atomicity** | exact, inside the caller's transaction |
 * | **at-most-once** | not available, and not requested |
 *
 * The only ordering primitive graphile-worker offers is a **named queue**, which
 * serialises the jobs within it. This milestone uses none, so **there is no
 * ordering guarantee between two outbox events at all** — not even for the same
 * subject. A handler that needs per-entity order must be given a named queue
 * keyed by that entity, and that is a change to this file plus the wrapper's
 * signature, not a configuration flag.
 *
 * Exactly-once is a property of `idempotency_key` and of a sink that honours it,
 * never of the queue. The unique index on `(organization_id, idempotency_key)`
 * makes a duplicate *publication* impossible; the sink is responsible for a
 * duplicate *delivery* after a retry.
 */

interface InsertedRow {
  id: string;
  job_id: string | null;
}

export class PgOutboxPublisher implements OutboxPublisher<Kysely<Database>> {
  async publish(
    uow: UnitOfWork<Kysely<Database>>,
    audit: RecordedAuditEvent,
    publication: OutboxPublication,
  ): Promise<PublishedOutboxEvent> {
    const payload = publication.payload ?? {};
    assertClosedAuditPayload(payload);

    const { organizationId, groupId, correlationId } = uow.context;
    if (audit.organizationId !== organizationId) {
      // The audit event was recorded in a different tenant's transaction. This
      // cannot happen through `recordAuditEvent` (which reads the same context),
      // so reaching it means a caller passed an event it did not just create.
      throw new Error(
        'OUTBOX_AUDIT_TENANT_MISMATCH: refusing to link an outbox row to an audit event from ' +
          'another organization.',
      );
    }

    const id = randomUUID();

    // The enqueue and the row are one statement's worth of work apart, in the
    // same transaction. The job id is captured into the outbox row so the
    // reconciler can join the three sequences SPEC-11 §3.3 names.
    const enqueued = await sql<{ job_id: string }>`
      select app_enqueue_job(
        ${OUTBOX_DISPATCH_TASK},
        ${JSON.stringify({ organizationId, outboxEventId: id })}::json
      )::text as job_id
    `.execute(uow.query);
    const jobId = enqueued.rows[0]?.job_id ?? null;

    const inserted = await sql<InsertedRow>`
      insert into outbox_events (
        organization_id, id, group_id, audit_sequence, kind,
        idempotency_key, correlation_id, payload, job_id
      ) values (
        ${organizationId}::uuid,
        ${id}::uuid,
        ${groupId}::uuid,
        ${audit.sequence}::bigint,
        ${publication.kind},
        ${publication.idempotencyKey},
        ${correlationId},
        ${JSON.stringify(payload)}::jsonb,
        ${jobId}::bigint
      )
      returning id::text as id, job_id::text as job_id
    `.execute(uow.query);

    const row = inserted.rows[0];
    if (row === undefined) {
      throw new Error('OUTBOX_INSERT_PRODUCED_NO_ROW: the outbox insert returned nothing.');
    }

    return {
      organizationId,
      id: row.id,
      kind: publication.kind,
      idempotencyKey: publication.idempotencyKey,
      auditSequence: audit.sequence,
      jobId: row.job_id,
    };
  }
}

/**
 * The single task name this milestone enqueues.
 *
 * One generic dispatch task rather than one task per event kind: the job payload
 * carries only `(organizationId, outboxEventId)`, and the handler reads
 * everything else from the outbox row **inside a unit of work**. That keeps the
 * queue payload free of anything I-07 could object to, and it means a job whose
 * outbox row was rolled back has nothing to act on rather than a stale copy of
 * the data.
 */
export const OUTBOX_DISPATCH_TASK = 'outbox.dispatch';

export const outboxPublisher = new PgOutboxPublisher();

/**
 * Publish one outbox event inside the calling unit of work.
 *
 * ```ts
 * await publishOutboxEvent(uow, recorded, {
 *   kind: 'membership.activity_touched',
 *   idempotencyKey: `membership-touch:${recorded.id}`,
 * });
 * ```
 *
 * **This is the second half of the OPUS-M1-002 integration point.** A mutation
 * that needs no asynchronous follow-up records its audit event and stops; one
 * that does adds this line.
 */
export function publishOutboxEvent(
  uow: UnitOfWork<Kysely<Database>>,
  audit: RecordedAuditEvent,
  publication: OutboxPublication,
): Promise<PublishedOutboxEvent> {
  return outboxPublisher.publish(uow, audit, publication);
}
