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
 * nothing speculative. OPUS-M1-002's authorization mutations added theirs at
 * integration (OPUS-M1-004) — three names, one per shipped mutation, and not
 * one more. A vocabulary padded with names nothing emits is a vocabulary nobody
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

  /* ── OPUS-M1-002's authorization mutations, wired at OPUS-M1-004 ───────────
   *
   * The names are the ones `apps/api/src/http/routes/authorization.route.ts`
   * exported as `AUDIT_EVENTS` when the routes shipped — a contract with this
   * milestone rather than three strings invented at the integration. That file
   * still exports them and a test compares the two, so they cannot drift. */

  /** A membership was created by an administrator (SPEC-06 §1.1). */
  'authorization.membership.created',
  /** A capability grant was written — an allow OR an explicit deny (P-1). */
  'authorization.capability_grant.written',
  /** An entitlement's state moved: trial/active/suspended/revoked (CAP-057). */
  'authorization.entitlement.state_changed',

  /* ── OPUS-M2-003 — staffing parameters (CAP-013, CAP-058) ───────────────────
   *
   * Six names, one per shipped mutation, and not one more. Two of them are worth
   * reading twice:
   *
   *   `staffing.work_profile.superseded` is emitted **in addition to**
   *   `…authored` when a new profile closes an outgoing one. A supersession is
   *   two facts — a window ended, and a different window began — and filing them
   *   under one name makes "when did this member's 80% arrangement end" a
   *   question the audit log cannot answer.
   *
   *   `staffing.qualification_holding.revoked` is separate from `…status_changed`
   *   because PO-DEC-12 calls qualifications patient-safety adjacent: a revocation
   *   is the event an incident review searches for, and it must not be one row of
   *   a generic status-change stream. */

  /** A work profile was authored — the first for a membership, or a successor. */
  'staffing.work_profile.authored',
  /** An in-force work profile's window was closed by its successor. */
  'staffing.work_profile.superseded',
  /** A qualification was added to the group's vocabulary, or retired. */
  'staffing.qualification.written',
  /** A credential was issued to a membership. */
  'staffing.qualification_holding.granted',
  /** A credential moved through its expiry states: pending -> valid -> expiring -> expired. */
  'staffing.qualification_holding.status_changed',
  /** A credential was REVOKED. Its own name, per PO-DEC-12's patient-safety framing. */
  'staffing.qualification_holding.revoked',
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
  /* ── OPUS-M1-004 ────────────────────────────────────────────────────────────
   * The two aggregates OPUS-M1-002's mutations act on that were not already
   * here. `authorization.membership.created` reuses `membership`; a grant and an
   * entitlement are their own aggregates and must not be filed under the
   * membership they happen to reference — a query for "everything that happened
   * to this membership" would then return rows about a module. */
  'capability_grant',
  'entitlement',
  /* ── OPUS-M2-003 ────────────────────────────────────────────────────────────
   * Three aggregates, each with its own lifecycle. A holding is NOT filed under
   * the membership it names, for the reason `capability_grant` is not: "everything
   * that happened to this credential" is the question a credentialing incident
   * asks, and it becomes unanswerable if the events live under the person. */
  'work_profile',
  'qualification',
  'qualification_holding',
] as const;

export type AuditSubjectType = (typeof AUDIT_SUBJECT_TYPES)[number];

const SUBJECTS: ReadonlySet<string> = new Set(AUDIT_SUBJECT_TYPES);

export function isAuditSubjectType(value: string): value is AuditSubjectType {
  return SUBJECTS.has(value);
}
