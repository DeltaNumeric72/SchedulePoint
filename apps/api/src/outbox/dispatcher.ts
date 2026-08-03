import type { TenantContext } from '@schedulepoint/domain';
import { sql } from 'kysely';

import { recordAuditEvent } from '../audit/recorder.js';
import type { PgUnitOfWorkRunner } from '../db/unit-of-work.js';
import type { OutboxDelivery, OutboxSink } from './sink.js';

/**
 * Dispatching one outbox event — the consumer half of the async kernel.
 *
 * ## The shape, and the invariant it protects (I-11)
 *
 * ```
 *   ── transaction 1 (the request or the parent job) ────────────────
 *      domain mutation + audit event + outbox row + enqueue   COMMIT
 *
 *   ── the queue, later, in another process ─────────────────────────
 *
 *   ── transaction 2 ────────────────────────────────────────────────
 *      CLAIM the row: state -> 'dispatching', CAS on state <> 'dispatched'
 *
 *   ── the sink, in a transaction of ITS OWN ────────────────────────
 *      insert the effect (idempotency key is the primary key)
 *
 *   ── transaction 3 ────────────────────────────────────────────────
 *      MARK: state -> 'dispatched' | 'failed', CAS on state = 'dispatching',
 *            + the audit event, only if the CAS won
 * ```
 *
 * **The delivery is outside every transaction the domain change touched, and
 * that change committed before this job existed.** That is I-11 made structural
 * rather than promised: there is no code path along which a sink failure can
 * reach the domain write, because by the time the sink is called the writing
 * transaction is over and this process holds no handle to it.
 *
 * The multi-transaction shape costs round trips and buys the property. A single
 * transaction spanning claim → deliver → mark would hold a database transaction
 * open across a call to a provider, which is how a provider outage becomes a
 * connection-pool outage.
 *
 * ## Two compare-and-sets, and what each one is worth
 *
 * The second review measured **two windows in which the same event was delivered
 * twice**: two concurrent dispatchers, and a dispatcher killed after its effect
 * but before its mark. Both are closed, and it is worth being precise about
 * which mechanism closes which:
 *
 * | Mechanism | Prevents |
 * |---|---|
 * | **CLAIM CAS** (`state <> 'dispatched'`) | a second dispatcher picking up an event that is already finished, and the attempt counter double-counting |
 * | **MARK CAS** (`state = 'dispatching'`) | two dispatchers both writing `outbox.dispatched` — only the winner audits |
 * | **`outbox_effects` primary key** | **the duplicate EFFECT.** This is the one that actually matters |
 *
 * The claim is deliberately re-takeable from `dispatching`: a dispatcher that is
 * SIGKILLed mid-flight must not strand its row forever. That re-openable window
 * is precisely why the effect table exists — a claim can always be re-taken, so
 * a claim can never be the exactly-once guarantee.
 *
 * ## Failure is recorded as a CODE, never a message
 *
 * `outbox_events.last_error_code` takes `^[a-z][a-z0-9_]{0,63}$` and nothing
 * else. An exception message is the single most common way a payload body or a
 * recipient address reaches a database column (rule 9), and "we will be careful
 * about what we put in the string" is not a control.
 */

export interface DispatchJobPayload {
  readonly organizationId: string;
  readonly outboxEventId: string;
}

export type DispatchOutcome =
  | { readonly status: 'delivered'; readonly idempotencyKey: string }
  | { readonly status: 'already_dispatched'; readonly idempotencyKey: string }
  | { readonly status: 'suppressed_duplicate'; readonly idempotencyKey: string }
  | { readonly status: 'missing' }
  | { readonly status: 'failed'; readonly errorCode: string };

interface ClaimedRow {
  id: string;
  group_id: string | null;
  kind: string;
  idempotency_key: string;
  correlation_id: string;
  attempts: number;
}

/**
 * A stable, non-revealing code for a delivery failure.
 *
 * Deliberately coarse. A code space that grew a member per provider error string
 * would be the error string again, spelled with underscores.
 */
function errorCodeFor(error: unknown): string {
  if (error instanceof Error && error.message.startsWith('SINK_UNAVAILABLE')) {
    return 'sink_unavailable';
  }
  return 'delivery_failed';
}

/**
 * An ORGANIZATION-scoped context, used only to claim the row.
 *
 * The row carries the group the originating mutation ran under, and everything
 * after the claim runs under that tuple — but the group is not known until the
 * row has been read, so the claim itself has to be organization-scoped.
 */
function bootstrapContext(organizationId: string): TenantContext {
  return {
    organizationId,
    groupId: null,
    membershipId: null,
    correlationId: 'outbox-dispatch-claim',
  };
}

function rowContext(organizationId: string, row: ClaimedRow): TenantContext {
  return {
    organizationId,
    // The SAME tenant tuple the audit row was written with. A dispatcher that
    // opened an organization-scoped context for a group-scoped event would write
    // its follow-up audit row with `group_id` null, and the two halves of one
    // action would be attributed differently.
    groupId: row.group_id,
    // No acting membership: the dispatcher is a system actor, and it says so
    // rather than borrowing the requester's identity for work they did not do.
    membershipId: null,
    correlationId: row.correlation_id,
  };
}

export async function dispatchOutboxEvent(
  worker: PgUnitOfWorkRunner,
  sink: OutboxSink,
  payload: DispatchJobPayload,
  options: { readonly abortSignal?: AbortSignal } = {},
): Promise<DispatchOutcome> {
  /* ── transaction 2: CLAIM ────────────────────────────────────────────────── */
  //
  // A single read-modify-write. Two concurrent dispatchers serialise on the row
  // lock this UPDATE takes, and the loser observes `dispatched` and stops.
  const claim = await worker.run(bootstrapContext(payload.organizationId), async ({ query }) => {
    const claimed = await sql<ClaimedRow>`
      update outbox_events
         set state = 'dispatching',
             attempts = attempts + 1
       where organization_id = ${payload.organizationId}::uuid
         and id              = ${payload.outboxEventId}::uuid
         and state          <> 'dispatched'
      returning id::text        as id,
                group_id::text  as group_id,
                kind            as kind,
                idempotency_key as idempotency_key,
                correlation_id  as correlation_id,
                attempts        as attempts
    `.execute(query);
    const row = claimed.rows[0];
    if (row !== undefined) return { kind: 'claimed' as const, row };

    // Zero rows means one of two very different things, and an operator needs
    // them distinguished: the row is finished, or it was never there.
    const existing = await sql<{ idempotency_key: string }>`
      select idempotency_key from outbox_events
       where organization_id = ${payload.organizationId}::uuid
         and id              = ${payload.outboxEventId}::uuid
    `.execute(query);
    const found = existing.rows[0];
    return found === undefined
      ? { kind: 'missing' as const }
      : { kind: 'already' as const, idempotencyKey: found.idempotency_key };
  });

  // A job whose outbox row does not exist is a job for another tenant's row, or
  // a hand-crafted payload. There is nothing to deliver, and inventing something
  // would be worse.
  if (claim.kind === 'missing') return { status: 'missing' };
  if (claim.kind === 'already') {
    return { status: 'already_dispatched', idempotencyKey: claim.idempotencyKey };
  }

  const row = claim.row;
  const context = rowContext(payload.organizationId, row);

  /* ── the sink, in a transaction of its own ───────────────────────────────── */
  const delivery: OutboxDelivery = {
    organizationId: payload.organizationId,
    groupId: row.group_id,
    outboxEventId: row.id,
    kind: row.kind,
    idempotencyKey: row.idempotency_key,
    correlationId: row.correlation_id,
    attempt: row.attempts,
  };

  // C-3: honour the abort signal. SP-D E-2.4b measured what a handler that
  // ignores it costs — the process does not exit on the first SIGTERM at all.
  if (options.abortSignal?.aborted === true) {
    await markFailed(worker, context, payload, row, 'aborted_before_delivery');
    return { status: 'failed', errorCode: 'aborted_before_delivery' };
  }

  let accepted: boolean;
  try {
    accepted = await sink.deliver(delivery);
  } catch (error) {
    const errorCode = errorCodeFor(error);
    /* ── transaction 3a: record the failure. The DOMAIN change is untouched. ── */
    await markFailed(worker, context, payload, row, errorCode);
    return { status: 'failed', errorCode };
  }

  /* ── transaction 3b: mark dispatched, and audit it — if the CAS wins ─────── */
  const won = await worker.run(context, async (uow) => {
    const marked = await sql`
      update outbox_events
         set state = 'dispatched',
             dispatched_at = now(),
             last_error_code = null
       where organization_id = ${payload.organizationId}::uuid
         and id              = ${row.id}::uuid
         and state           = 'dispatching'
    `.execute(uow.query);
    if (Number(marked.numAffectedRows ?? 0n) === 0) return false;

    // Inside the winning transaction, so the audit event and the state change
    // commit together — a dispatch recorded but not audited, or audited but not
    // recorded, is exactly the reconciliation gap SPEC-11 §3.3 names.
    await recordAuditEvent(uow, {
      eventName: 'outbox.dispatched',
      subjectType: 'outbox_event',
      subjectId: row.id,
      systemActor: true,
      payload: { kind: row.kind, attempt: row.attempts, deduplicated: !accepted },
    });
    return true;
  });

  if (!won) {
    // Another dispatcher marked it between our delivery and our mark. The effect
    // table already decided which of us actually delivered.
    return { status: 'already_dispatched', idempotencyKey: row.idempotency_key };
  }
  return accepted
    ? { status: 'delivered', idempotencyKey: row.idempotency_key }
    : { status: 'suppressed_duplicate', idempotencyKey: row.idempotency_key };
}

async function markFailed(
  worker: PgUnitOfWorkRunner,
  context: TenantContext,
  payload: DispatchJobPayload,
  row: ClaimedRow,
  errorCode: string,
): Promise<void> {
  await worker.run(context, async (uow) => {
    await sql`
      update outbox_events
         set state = 'failed',
             last_error_code = ${errorCode}
       where organization_id = ${payload.organizationId}::uuid
         and id              = ${row.id}::uuid
         and state           = 'dispatching'
    `.execute(uow.query);
    await recordAuditEvent(uow, {
      eventName: 'job.failed',
      subjectType: 'outbox_event',
      subjectId: row.id,
      systemActor: true,
      payload: { kind: row.kind, errorCode, attempt: row.attempts },
    });
  });
}

/** Narrows an untrusted graphile-worker payload. */
export function parseDispatchPayload(payload: unknown): DispatchJobPayload | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const { organizationId, outboxEventId } = payload as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof organizationId !== 'string' || !uuid.test(organizationId)) return undefined;
  if (typeof outboxEventId !== 'string' || !uuid.test(outboxEventId)) return undefined;
  return { organizationId, outboxEventId };
}
