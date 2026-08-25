import { randomUUID } from 'node:crypto';

import {
  assertClosedAuditPayload,
  type AuditEventDraft,
  type AuditRecorder,
  type RecordedAuditEvent,
  type UnitOfWork,
} from '@schedulepoint/domain';
import { sql, type Kysely } from 'kysely';

import type { Database } from '../db/schema.js';

/**
 * The audit chain's write path — SPEC-11 §2, ADR-0019, non-bypass rule 6.
 *
 * ## How little this file does, and why that is the design
 *
 * It builds one `INSERT` and returns what came back. It does **not** compute the
 * sequence, the previous hash or the entry hash, and it could not: those columns
 * are absent from the column-level `INSERT` grant in migration 0003, so naming
 * one raises `42501` before the row is considered, and a `BEFORE INSERT` trigger
 * assigns all three inside the same transaction.
 *
 * That division is the whole point. A chain the application computes is a chain
 * the application can quietly recompute — and the actor most likely to want to
 * recompute it is a bug, not an attacker. Here the application supplies facts
 * and the database supplies the chain, so "never write audit rows outside the
 * chain" is not a rule anybody can forget to follow: there is no statement that
 * expresses it.
 *
 * ## Everything tenant-shaped comes from the unit of work
 *
 * Organization, group, acting membership and correlation id are read from
 * `uow.context`, never from the draft. A draft that could name its own
 * organization could file an audit row against the wrong one — and it would look
 * entirely authoritative afterwards. The same property makes wiring a new
 * mutation a three-field call (FAD-12, and the OPUS-M1-002 integration point).
 *
 * ## Raw SQL rather than the query builder, deliberately
 *
 * The column list in the `INSERT` must match the column-level grant exactly, and
 * the reviewer's question is "does this statement name a chain column?" Writing
 * the statement out makes that answerable by reading it. Every value is a bind
 * parameter; nothing is interpolated.
 */

interface InsertedRow {
  sequence: string;
  id: string;
  occurred_at: Date;
  entry_hash: string;
  prev_hash: string;
}

export class PgAuditRecorder implements AuditRecorder<Kysely<Database>> {
  async record(
    uow: UnitOfWork<Kysely<Database>>,
    draft: AuditEventDraft,
  ): Promise<RecordedAuditEvent> {
    const payload = draft.payload ?? {};
    // Thrown BEFORE any statement is issued, so the caller's transaction is
    // untouched and recoverable — the same discipline `NestedTenantChangeError`
    // follows. A payload violation is a programming error, not a tenant's fault.
    assertClosedAuditPayload(payload);

    const { organizationId, groupId, membershipId, correlationId } = uow.context;
    const systemActor = draft.systemActor === true;

    if (!systemActor && membershipId === null) {
      // "Nobody was acting" and "we could not work out who was acting" must not
      // look the same in an audit trail. A caller with no membership must say
      // `systemActor: true` and mean it.
      throw new Error(
        'AUDIT_ACTOR_UNRESOLVED: the unit of work names no acting membership and the draft ' +
          'did not declare itself a system action. Refusing to attribute the event to nobody.',
      );
    }

    const id = randomUUID();

    const result = await sql<InsertedRow>`
      insert into audit_events (
        organization_id, id, event_name, actor_kind, actor_membership_id,
        group_id, subject_type, subject_id, correlation_id, payload
      ) values (
        ${organizationId}::uuid,
        ${id}::uuid,
        ${draft.eventName},
        ${systemActor ? 'system' : 'membership'},
        ${systemActor ? null : membershipId}::uuid,
        ${groupId}::uuid,
        ${draft.subjectType},
        ${draft.subjectId}::uuid,
        ${correlationId},
        ${JSON.stringify(payload)}::jsonb
      )
      returning
        sequence::text                as sequence,
        id::text                      as id,
        occurred_at                   as occurred_at,
        encode(entry_hash, 'hex')     as entry_hash,
        encode(prev_hash,  'hex')     as prev_hash
    `.execute(uow.query);

    const row = result.rows[0];
    if (row === undefined) {
      // Unreachable through RLS — a `WITH CHECK` failure raises rather than
      // returning nothing. Kept because "the insert silently produced no row"
      // must never become "the mutation proceeded without an audit entry".
      throw new Error(
        'AUDIT_APPEND_PRODUCED_NO_ROW: the audit insert returned nothing. The mutation in this ' +
          'transaction must not commit without its audit entry.',
      );
    }

    return {
      organizationId,
      sequence: row.sequence,
      id: row.id,
      occurredAt: row.occurred_at.toISOString(),
      eventName: draft.eventName,
      entryHash: row.entry_hash,
      prevHash: row.prev_hash,
    };
  }
}

/**
 * The process-wide recorder.
 *
 * A module-level instance rather than something threaded through every call
 * site, because the packet's requirement is that **wiring audit emission into a
 * mutation is one line**, and an injected dependency is one line plus a
 * constructor parameter plus a test double. The class above exists so a test can
 * still instantiate its own.
 *
 * It holds no state and no connection: every method takes the unit of work.
 */
export const auditRecorder = new PgAuditRecorder();

/**
 * Record one audit event inside the calling unit of work.
 *
 * ```ts
 * await recordAuditEvent(uow, {
 *   eventName: 'membership.activity_touched',
 *   subjectType: 'membership',
 *   subjectId: context.membershipId,
 * });
 * ```
 *
 * **This is the OPUS-M1-002 integration point.** Every mutation that lands with
 * the authorization evaluator adds exactly this call, inside the same
 * `runtime.run(...)` callback as its write, with an event name added to
 * `packages/domain/src/audit/event-names.ts`. Nothing else is required, and in
 * particular nothing tenant-shaped is passed.
 */
export function recordAuditEvent(
  uow: UnitOfWork<Kysely<Database>>,
  draft: AuditEventDraft,
): Promise<RecordedAuditEvent> {
  return auditRecorder.record(uow, draft);
}

/**
 * **Enter this organization's audit ordering domain, for the rest of the
 * transaction.**
 *
 * Migration 0003's chain trigger takes
 * `pg_advisory_xact_lock(hashtext('schedulepoint.audit'), hashtext(<org>))`
 * before it allocates a chain head, so **every** transaction that writes an
 * audit event holds this lock from its first audit write until it commits. That
 * is a total order over the audited transactions of one organization, and it is
 * already the order the chain's sequence numbers are in.
 *
 * This function takes the same lock EARLY, and it is spelled with the trigger's
 * own key so the two cannot mean different locks. Its purpose is to let a
 * read-then-write sequence be evaluated inside that order rather than beside it:
 * a caller that reads a precondition after this call, and writes after reading
 * it, cannot have a concurrent audited transaction of the same organization
 * commit in between — such a transaction either committed before the lock was
 * granted (so the read sees it) or cannot commit until this one has.
 *
 * **The re-read has to be a NEW snapshot, so the caller must be READ COMMITTED.**
 * `PgUnitOfWorkRunner` issues a plain `BEGIN`, so every unit of work is READ
 * COMMITTED and each statement after this call sees what committed while the
 * transaction waited. Under REPEATABLE READ the post-lock read would return the
 * pre-lock snapshot and this function would order the write without ordering the
 * decision — it would silently stop working rather than fail.
 *
 * **Ordering, and it is a RULE, not a courtesy.** Migration 0017 §3 records it:
 * a row lock is acquired BEFORE the per-organization audit advisory lock, in
 * every shipped writer. So call this AFTER taking every row lock the caller's
 * own writes will take before their first audit write — including the ones an FK
 * takes on its behalf. Calling it earlier than that inverts the order for those
 * rows and is a genuine deadlock, not a theoretical one: a period writer holding
 * `schedule_periods … FOR UPDATE` and waiting on this lock, against a caller
 * holding this lock and waiting on that period row, was reproduced as `40P01`.
 * Taking either lock again later in the same transaction is a no-op.
 *
 * `uow.context.organizationId` is the server-verified tenant of the unit of
 * work; the `::uuid::text` cast makes the hashed text identical to the trigger's
 * `NEW.organization_id::text`, whatever spelling the context carries.
 */
export async function lockAuditOrdering(uow: UnitOfWork<Kysely<Database>>): Promise<void> {
  await sql`
    select pg_advisory_xact_lock(hashtext('schedulepoint.audit'),
                                 hashtext(${uow.context.organizationId}::uuid::text))
  `.execute(uow.query);
}
