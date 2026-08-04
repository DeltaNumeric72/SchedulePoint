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
  /* ── OPUS-M2-002's catalogue mutations (CAP-011, CAP-012, CAR-011) ──────────
   *
   * One name per mutation the routes actually perform, and not one more. The list
   * only ever grows (non-bypass rule 13), so a speculative name is a permanent
   * commitment to something nothing emits.
   *
   * `archived` is separate from `updated` deliberately. "This type was retired"
   * is the question a scheduling incident asks; answering it by scanning every
   * `updated` row for a status change makes retirement invisible in a filtered
   * audit query, which is the query that matters. */

  /** A shift type was added to the group's catalogue. */
  'catalogue.shift_type.created',
  /** A shift type's definition changed (any field except its code, which is fixed). */
  'catalogue.shift_type.updated',
  /** A shift type was retired. Archive, never delete: everything referencing it stays. */
  'catalogue.shift_type.archived',
  /** A shift type's per-weekday and holiday demand defaults were set. */
  'catalogue.shift_type_demand.set',
  /** A shift group (a scoring / request-off bundle) was created. */
  'catalogue.shift_group.created',
  /** A shift group's scoring mode, weight, request settings or membership changed. */
  'catalogue.shift_group.updated',
  /** A staff group was created. */
  'catalogue.staff_group.created',
  /** A valid combination of shift types and pick positions was created. */
  'catalogue.valid_group.created',
  /** The group's count of numbered draft pick positions was increased. Irreversible. */
  'catalogue.pick_positions.increased',
  /** A date was added to the group's holiday calendar. */
  'catalogue.group_holiday.created',

  /* ── OPUS-M2-004: the shift-type x qualification join (CAP-011 x CAP-058) ───
   *
   * ONE name, because the write is one action: an author sends the complete
   * requirement set and the server works out which rows to add, reactivate and
   * archive. Three names for those three internal outcomes would be an audit
   * trail of the implementation rather than of the decision — and the payload
   * already carries the before/after COUNTS (added, reactivated, archived). It
   * carries counts rather than the ids: `app_audit_payload_is_closed` admits
   * only scalar values, so an array of qualification ids cannot be expressed,
   * and `catalogue/service.ts` records why that is sufficient — requirements are
   * archived rather than deleted, so the rows themselves are the full history. */

  /** A shift type's qualification requirement set was replaced. */
  'catalogue.shift_type_qualifications.set',

  /* ── OPUS-M3-001: the `authn.*` namespace (packet 32 §6) ────────────────────
   *
   * **Why a failure is a first-class name.** `authn.sign_in.succeeded` and
   * `authn.sign_in.failed` are separate names rather than one name with an
   * outcome field, because the queries differ: an incident review searches for
   * failures by name and by rate, and burying them inside a generic sign-in
   * stream makes "how many failures preceded this success" a question the audit
   * log answers only after a payload scan.
   *
   * **What a failure payload may NOT say.** 14 §2: lockout "does not
   * distinguish 'no such account' from 'wrong password'". The failure event
   * therefore carries a `reason` drawn from a closed set that makes the same
   * non-distinction — and `apps/api/src/authn/audit.ts` is where that set lives,
   * so the property is one function rather than a rule at every call site.
   *
   * **`authn.session.revoked` covers every revocation cause.** The cause is in
   * the payload as the closed `revoked_reason` vocabulary, which the database
   * column also enforces; a name per cause would put the same closed set in two
   * places and let them drift.
   *
   * **`security.privileged_session.*` is SPEC-11 §3.2**, not authentication. It
   * is here because this packet is what makes privileged access auditable, and
   * it is named `security.*` because the actor is an operator with a ticket
   * reference rather than a member of the organization. */

  /** A credential was accepted. Bumps `session_epoch`; issues a session. */
  'authn.sign_in.succeeded',
  /** A credential was refused. The reason NEVER distinguishes unknown-account from wrong-password. */
  'authn.sign_in.failed',
  /** Progressive lockout engaged for an account (T-22). */
  'authn.account.locked',
  /** A session ended. The cause is the closed `revoked_reason` vocabulary. */
  'authn.session.revoked',
  /** A session was replaced by a new one on a privilege change (14 §3 rotation). */
  'authn.session.rotated',
  /** A TOTP secret was provisioned. The factor is NOT yet in force. */
  'authn.mfa.enrolment_started',
  /** A valid code confirmed the enrolment; the factor is now in force. */
  'authn.mfa.enrolled',
  /** An MFA challenge was satisfied on a session. */
  'authn.mfa.challenge_succeeded',
  /** An MFA challenge was refused — wrong code, replayed step, or exhausted attempts. */
  'authn.mfa.challenge_failed',
  /** SPEC-11 X-12: MFA was reset by an administrator. Notified; sessions invalidated. */
  'authn.mfa.reset',
  /** A single-use recovery code was consumed. */
  'authn.mfa.recovery_code_consumed',
  /** An invitation was issued to a synthetic destination (STM-017). */
  'authn.invitation.issued',
  /** An invitation token was consumed, atomically and exactly once. */
  'authn.invitation.accepted',
  /** An invitation was revoked before consumption. */
  'authn.invitation.revoked',
  /** An invitation was reconciled against a changed login email (CAR-027). */
  'authn.invitation.reconciled',
  /** An account activated: password set, STM-018 `invited` -> `active`. */
  'authn.account.activated',
  /** A password reset was requested. Existence is never disclosed by the response. */
  'authn.password_reset.requested',
  /** A password reset token was consumed and the credential replaced. */
  'authn.password.changed',
  /** CAR-027: an administrator changed a login email. Sessions invalidated. */
  'authn.login_email.changed',

  /** SPEC-11 §3.2: a privileged (break-glass / support / migrator) session opened. */
  'security.privileged_session.opened',
  /** SPEC-11 §3.2: it closed, with the statements executed and rows touched. */
  'security.privileged_session.closed',

  /* ── OPUS-M3-002 — the typed rule model (CAR-006, SPEC-04 §3) ───────────────
   *
   * The `rules.*` namespace, which packet 32 §6 assigns to this task alone. One
   * name per shipped mutation and not one more, as the header requires.
   *
   * `rules.rule.disabled` and `rules.rule.archived` are separate names rather
   * than one `state_changed` carrying the target, because "when did this rule
   * stop applying to builds" and "when was it retired from authoring" are
   * different questions asked by different investigations, and a single name
   * makes the first unanswerable without parsing a payload. */
  /** A rule was authored. Its `rule_key` is stable from this moment (rule 13). */
  'rules.rule.created',
  /** A rule's content was amended — a new version of the same `rule_key`. */
  'rules.rule.updated',
  /** A rule was disabled: it stays authored but no build consumes it. */
  'rules.rule.disabled',
  /** A rule was re-enabled after being disabled. */
  'rules.rule.enabled',
  /** A rule was archived. Never deleted — the key is cited by sets and builds. */
  'rules.rule.archived',
  /** A rule set was created. */
  'rules.rule_set.created',
  /** A rule set's membership or name changed. */
  'rules.rule_set.updated',
  /** A rule set was archived. */
  'rules.rule_set.archived',
  /* ── OPUS-M3-003: the `schedule.*` namespace (packet 32 §5, SPEC-05) ─────────
   *
   * One name per mutation the schedule module actually performs. The list only
   * grows (non-bypass rule 13), so nothing speculative is added here.
   *
   * **`schedule.version.state_changed` covers the lifecycle transitions**
   * (draft ↔ in_review ↔ approved, and → cancelled), with the closed
   * `{from,to}` pair in the payload — exactly as `authn.session.revoked` carries
   * its cause. `published` and `superseded` are NOT folded into it: becoming
   * authoritative (a version acquires `is_current`, a version_number, and staff
   * visibility) and losing authority are distinct facts an incident review asks
   * for by name, not by scanning a generic state stream.
   *
   * **`schedule.version.superseded` is emitted in addition to
   * `schedule.version.published`** on the prior current version, for the same
   * reason `staffing.work_profile.superseded` is: a publication is two facts —
   * one version became current, a different one stopped being current.
   *
   * **Assignment events file under `assignment_identity`** (SPEC-05 §9): "what
   * changed for this assignment" must be answerable across versions, which the
   * stable identity — not the per-version snapshot — is the key for. */

  /** A schedule period was created (a bounded planning date range). */
  'schedule.period.created',
  /** A schedule period's fields or status changed (e.g. planning → closed). */
  'schedule.period.updated',
  /** A draft schedule version was created — from scratch or cloned (SPEC-05 §7). */
  'schedule.version.created',
  /** A version's lifecycle state moved. The closed `{from,to}` pair is in the payload. */
  'schedule.version.state_changed',
  /** A version became the current, immutable, staff-visible schedule (I-18, D-16). */
  'schedule.version.published',
  /** A prior current version lost authority when a later one published (D-15b transition). */
  'schedule.version.superseded',
  /** A revert: a new version was published forward carrying an earlier version's content (§6.1). */
  'schedule.version.reverted',
  /** A publication attempt failed or was reconciled back to `approved` (V-16). No partial state. */
  'schedule.publication.failed',
  /** A manual assignment was added to a draft version, with origin and provenance. */
  'schedule.assignment.added',
  /** A manual assignment was removed (its snapshot cancelled) on a draft version. */
  'schedule.assignment.removed',
  /** A manual assignment was reassigned to a different membership, identity preserved. */
  'schedule.assignment.reassigned',
  /** A manual override was applied, carrying its required reason. */
  'schedule.assignment.overridden',
  /** A snapshot's fixed-assignment pin (solver input) was set or cleared on a draft. */
  'schedule.assignment.pinned',
  /** A fairness credit was moved to a membership that may differ from the assignee (V-23). */
  'schedule.credit.moved',
  /** A fairness credit was voided. */
  'schedule.credit.voided',
  /**
   * A validation conflict was recorded against a draft version.
   *
   * Added by FAD-22(1)'s service half: `recordConflict` used to emit nothing at
   * all, which made an `open` `hard-breach` — the thing that BLOCKS publication
   * — the only schedule mutation with no audit trail.
   */
  'schedule.conflict.recorded',

  /* ── OPUS-M3-007: the `settings.*` namespace (packet 32 §10a) ───────────────
   *
   * One name per mutation the settings module actually performs, and not one
   * more. Three of them are worth reading twice.
   *
   * **`settings.request_until.changed` and `settings.picklist_access.changed`
   * are separate names**, not one `settings.changed` carrying which field
   * moved. They are enforced by different milestones (M5 SPEC-08 and M9
   * SPEC-02, packet 32 §2 rows 5-6), so "when did this group's request window
   * change" and "when did its picklist policy change" are questions two
   * different investigations ask — and a single name makes both answerable only
   * by scanning payloads.
   *
   * **`settings.timezone.changed` is its own name and carries the count of
   * published versions that existed at the moment of the change.** That is the
   * audited half of the packet's warning requirement: a timezone change is
   * permitted while published schedules exist, and the record of the change has
   * to say whether it happened over an empty group or over months of published
   * history. Scalars only (I-07): the from-zone, the to-zone and a count.
   *
   * **A location is archived, never deleted**, so `settings.location.archived`
   * is a real event with a real row behind it — the same discipline
   * `catalogue.shift_type.archived` follows, and for the same reason: "when did
   * this place stop being used" must be answerable from a filtered audit query
   * rather than by scanning every update for a status field. */

  /** The group's request-until policy changed (mode and its one populated field). */
  'settings.request_until.changed',
  /** The group's picklist-access mode changed. Stored only; enforcement is M9. */
  'settings.picklist_access.changed',
  /** The group's timezone changed. Payload carries the published-version count. */
  'settings.timezone.changed',
  /** A location was added to the group. */
  'settings.location.created',
  /** A location's name, site label, address or zone changed. */
  'settings.location.updated',
  /** A location was archived. Archive, never delete: everything referencing it stays. */
  'settings.location.archived',
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

  /* ── OPUS-M2-002 ────────────────────────────────────────────────────────────
   * Each catalogue concept is its own aggregate and is filed as one. A shift
   * type's demand is filed under `shift_type` rather than gaining a subject type
   * of its own, because demand has no life apart from the type it belongs to —
   * "everything that happened to this shift type" must return its demand changes.
   * The pick-position count is a property of the GROUP, and `group` already
   * exists. */
  'shift_type',
  'shift_group',
  'staff_group',
  'valid_group',
  'group_holiday',

  /* ── OPUS-M3-001 ────────────────────────────────────────────────────────────
   * `user` is the identity aggregate: activation, password change and login-email
   * change happen TO it. `session`, `invitation` and `mfa_enrolment` are their
   * own aggregates for the reason `capability_grant` is: "everything that
   * happened to this session" is what a stolen-token investigation asks, and it
   * is unanswerable if the events are filed under the person who held it.
   *
   * `privileged_session` is SPEC-11 §3.2's subject and is deliberately NOT
   * `session` — an operator's break-glass access and a member's browser session
   * are different things, and one query must not return both. */
  'user',
  'session',
  'invitation',
  'mfa_enrolment',
  'privileged_session',

  /* ── OPUS-M3-002 ────────────────────────────────────────────────────────────
   * A rule and a rule set are separate aggregates. A rule set is not filed under
   * the rules it names, for the reason `capability_grant` is not filed under its
   * membership: "everything that happened to this rule" must not return edits to
   * a collection that merely cites it.
   *
   * The subject id for both is the ROW uuid, because `audit_events.subject_id`
   * is a uuid column. For a rule the STABLE `rule_key` travels beside it in the
   * closed audit payload (identifiers only — never rule content, I-07), so
   * "everything that happened to this rule_key" stays answerable without the
   * audit module changing. */
  'rule',
  'rule_set',
  /* ── OPUS-M3-003 (SPEC-05) ──────────────────────────────────────────────────
   * Each schedule concept is its own aggregate (doc 07 §1 keeps ten of them
   * distinct). Assignment events file under `assignment_identity` — the stable
   * thing that spans versions — not under a per-version snapshot, so "everything
   * that happened to this assignment" is answerable across versions (SPEC-05 §9).
   * Publication and supersession events file under `schedule_version`. */
  'schedule_period',
  'schedule_version',
  'assignment_identity',
  'credit',
  /* ── OPUS-M3-007 ────────────────────────────────────────────────────────────
   * `location` is its own aggregate. The three GROUP-settings events file under
   * the existing `group` subject, because a request window, a picklist mode and
   * a timezone are properties OF the group and "everything that happened to this
   * group" must return them. A location is a different thing with its own
   * lifecycle, and filing its events under the group would bury them in that
   * same stream. */
  'location',
] as const;

export type AuditSubjectType = (typeof AUDIT_SUBJECT_TYPES)[number];

const SUBJECTS: ReadonlySet<string> = new Set(AUDIT_SUBJECT_TYPES);

export function isAuditSubjectType(value: string): value is AuditSubjectType {
  return SUBJECTS.has(value);
}
