/**
 * The audit and outbox ports — **interfaces only**.
 *
 * The interfaces live in `packages/domain`; the implementations live in
 * `apps/api/src/audit/` and `apps/api/src/outbox/`, and the dependency-cruiser
 * boundary makes it impossible for that direction to reverse.
 *
 * ## The one rule these interfaces exist to make structural (FAD-12)
 *
 * **The audit write joins the SAME unit of work as the mutation and its
 * authorization.** So every method here takes the `UnitOfWork` as its first
 * argument and none of them can obtain one: there is no `run`, no runner, no
 * pool. A caller who wants to record an audit event must already be inside the
 * transaction that made the change — which is the whole of non-bypass rule 6's
 * "never write audit rows outside the chain", expressed as a type rather than as
 * a review checklist.
 *
 * The corollary is worth stating because it looks like a limitation: **there is
 * no way to record an audit event for something that has not been committed
 * with it.** A fire-and-forget audit call cannot be written against this
 * interface. That is deliberate.
 *
 * ## One line per mutation
 *
 * The draft carries only what the *event* knows. Everything the *context* knows
 * — organization, group, acting membership, correlation id — is read from
 * `uow.context` by the implementation, so a call site looks like:
 *
 * ```ts
 * await recordAuditEvent(uow, {
 *   eventName: 'membership.activity_touched',
 *   subjectType: 'membership',
 *   subjectId: context.membershipId,
 * });
 * ```
 *
 * That shape is the OPUS-M1-002 integration point: wiring a new mutation is one
 * call with three fields, and it cannot be wired wrongly with respect to tenancy
 * because tenancy is not one of the fields.
 */

import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { AuditEventName, AuditSubjectType } from './event-names.js';
import type { AuditPayload } from './payload.js';

/**
 * What a mutation says about itself.
 *
 * Note what is ABSENT: no organization, no group, no actor, no correlation id,
 * and no timestamp. All five are the unit of work's to supply (the first four)
 * or the database's (the last). A draft that could name its own organization
 * could file an audit row against the wrong one.
 */
export interface AuditEventDraft {
  readonly eventName: AuditEventName;
  readonly subjectType: AuditSubjectType;
  readonly subjectId: string;
  /** Identifiers and tokens only. Never free text (I-07). Defaults to `{}`. */
  readonly payload?: AuditPayload;
  /**
   * `true` when there is no human actor — a scheduled job, a reconciler.
   *
   * Defaults to `false`, meaning the acting membership in `uow.context` is the
   * actor. An explicit marker rather than "membership happens to be null",
   * because "nobody was acting" and "we failed to resolve who was acting" must
   * not look the same in an audit trail.
   */
  readonly systemActor?: boolean;
}

/** What the chain assigned. Returned so the caller can link an outbox row to it. */
export interface RecordedAuditEvent {
  readonly organizationId: string;
  /** Gapless per organization, assigned by the database (SPEC-11 §2). */
  readonly sequence: string;
  readonly id: string;
  readonly occurredAt: string;
  readonly eventName: AuditEventName;
  /** Hex-encoded `sha256`. The chain link this row contributes. */
  readonly entryHash: string;
  readonly prevHash: string;
}

export interface AuditRecorder<Q = unknown> {
  /**
   * Appends one event to the organization's chain, inside `uow`'s transaction.
   *
   * @throws AuditPayloadNotClosedError if the payload carries anything I-07
   *         prohibits — before any statement is issued, so the caller's
   *         transaction is untouched and recoverable.
   */
  record(uow: UnitOfWork<Q>, draft: AuditEventDraft): Promise<RecordedAuditEvent>;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Outbox
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * An intent to do something outside the transaction, recorded inside it.
 *
 * SPEC-11 §3.3 names `outbox_events` as one of the three sequences that are
 * reconciled continuously, which is why publishing requires the
 * `RecordedAuditEvent` it belongs to: an outbox row with no audit event is a
 * defect the reconciler must be able to see, and the cheapest way to make it
 * impossible to create one accidentally is to demand the link at the call site.
 */
export interface OutboxPublication {
  readonly kind: string;
  /**
   * The key the SINK deduplicates on.
   *
   * graphile-worker is **at-least-once** (SP-D §6): lease expiry re-runs a job
   * whose effect may already have happened. Exactly-once is a property of this
   * key and of a sink that honours it, never of the queue. A publication without
   * a meaningful key is a publication that will eventually double-send.
   */
  readonly idempotencyKey: string;
  readonly payload?: AuditPayload;
}

export interface PublishedOutboxEvent {
  readonly organizationId: string;
  readonly id: string;
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly auditSequence: string;
  /** The queue job id, when the enqueue happened in this transaction. */
  readonly jobId: string | null;
}

export interface OutboxPublisher<Q = unknown> {
  publish(
    uow: UnitOfWork<Q>,
    audit: RecordedAuditEvent,
    publication: OutboxPublication,
  ): Promise<PublishedOutboxEvent>;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Checkpoint signing
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * SPEC-11 §2 / §6 — signing a checkpoint over the chain.
 *
 * The port exists so that the **local development stub and a real KMS are the
 * same shape**, and so that the one property that matters can be stated in one
 * place: *the signing key must not be readable by the application role.* The
 * stub in this milestone **violates that property** — it holds the key in the
 * process — and is therefore worth proving the mechanism and nothing else. It is
 * not an assurance control until the key moves to a separate trust domain
 * (TDG-15, a named deployment condition).
 */
export interface CheckpointSignature {
  readonly keyId: string;
  readonly algorithm: 'ed25519';
  /** Hex-encoded. */
  readonly signature: string;
}

export interface CheckpointSigner {
  /** @param message hex-encoded bytes, exactly as `app_audit_checkpoint_bytes` produces them. */
  sign(message: Uint8Array): Promise<CheckpointSignature>;
  verify(message: Uint8Array, signature: CheckpointSignature): Promise<boolean>;
  /**
   * `true` when the key lives somewhere the application cannot read it.
   *
   * Exists so that a deployment check, an evidence index and a test can all ask
   * the question rather than assume the answer. The local stub returns `false`
   * and says so loudly.
   */
  readonly keyIsIsolated: boolean;
}
