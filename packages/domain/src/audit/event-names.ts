/**
 * The audit event vocabulary — a **closed list**, not a convention.
 *
 * An event name is a stable identifier that queries, alerts, retention rules and
 * incident reconstruction all cite. A free-form string here would produce the
 * same defect class as `I-05` meaning two things (CAR-023): a citation that
 * still looks correct after its referent changed.
 *
 * ## The rules
 *
 * | Rule | |
 * |---|---|
 * | `<aggregate>.<action>` in lower snake, dot-separated, 2–4 segments | the CHECK in migration 0003 enforces the shape |
 * | **the list only grows** | removing or renaming a name breaks every stored row that carries it — non-bypass rule 13 |
 * | one name means exactly one thing | if the meaning changes, the name does not: add a `.v2` action |
 *
 * ## Why the list is short
 *
 * It contains the events the mutations that exist today actually emit, and
 * nothing speculative. OPUS-M1-002's authorization mutations add theirs when
 * they land — see `docs/evidence/EV-M1-AUDIT/INDEX.md` for the integration
 * point. A vocabulary padded with names nothing emits is a vocabulary nobody
 * trusts to be complete.
 */

export const AUDIT_EVENT_NAMES = [
  /** The acting membership's `last_active_at` moved (the M1-001 probe mutation). */
  'membership.activity_touched',
  /** A background job ran to completion under a re-evaluated context. */
  'job.completed',
  /** A background job's authorization no longer held at execution (SPEC-06 §5). */
  'job.cancelled_unauthorized',
  /** A background job refused for want of a usable frozen context (SPEC-01 §6). */
  'job.refused_no_context',
  /** A background job failed. The failure never rolls back a domain change (I-11). */
  'job.failed',
  /** An outbox event was handed to its sink. */
  'outbox.dispatched',
  /** A signed checkpoint was written over the chain (SPEC-11 §2). */
  'audit.checkpoint_signed',
  /** Chain verification ran and found the chain intact. */
  'audit.chain_verified',
  /** Chain verification ran and found a break. Always also an operational alert. */
  'audit.chain_broken',
] as const;

export type AuditEventName = (typeof AUDIT_EVENT_NAMES)[number];

const NAMES: ReadonlySet<string> = new Set(AUDIT_EVENT_NAMES);

export function isAuditEventName(value: string): value is AuditEventName {
  return NAMES.has(value);
}

/**
 * The aggregate kinds an audit event may name as its subject.
 *
 * Closed for the same reason the event names are, and separately from them
 * because one aggregate has many events.
 */
export const AUDIT_SUBJECT_TYPES = [
  'organization',
  'group',
  'membership',
  'job',
  'outbox_event',
  'audit_chain',
] as const;

export type AuditSubjectType = (typeof AUDIT_SUBJECT_TYPES)[number];

const SUBJECTS: ReadonlySet<string> = new Set(AUDIT_SUBJECT_TYPES);

export function isAuditSubjectType(value: string): value is AuditSubjectType {
  return SUBJECTS.has(value);
}
