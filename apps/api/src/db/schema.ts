import type { Generated } from 'kysely';

/**
 * Kysely table types for the tenancy core (`migrations/0001_tenancy_core.sql`).
 *
 * These types describe the schema; they enforce nothing. The enforcement is the
 * RLS policy and the CHECK constraint in the migration — a type cannot stop a
 * cross-tenant read, and pretending otherwise is how a "typed" data layer
 * becomes the reason nobody checked.
 */

export interface OrganizationsTable {
  id: string;
  name: string;
  status: Generated<'active' | 'inactive'>;
  organization_version: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface GroupsTable {
  id: string;
  organization_id: string;
  name: string;
  status: Generated<'active' | 'inactive'>;
  group_version: Generated<string>;
  /**
   * The group-wide count of numbered draft pick positions
   * (`migrations/0005_shift_catalogue.sql`, FAD-16).
   *
   * **MONOTONICALLY INCREASING ONLY**, enforced by
   * `app_guard_group_pick_position_count`. The type cannot say so — which is
   * exactly why the rule lives in a trigger rather than in a comment.
   */
  pick_position_count: Generated<number>;
  /**
   * IANA-style zone the group's shift-local semantics resolve against
   * (`migrations/0009_schedule_publication.sql`, OPUS-M3-003; doc 06 §Time).
   * NOT NULL with a backfilling DEFAULT `'UTC'`; the administration surface is
   * OPUS-M3-007.
   */
  timezone: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface UsersTable {
  id: string;
  login_email: string;
  display_name: string;
  status: Generated<'active' | 'deactivated'>;
  membership_set_version: Generated<string>;
  session_epoch: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;

  /* ── `migrations/0007_authentication_sessions_invitations.sql` (OPUS-M3-001) ─
   *
   * Credential and lockout state. The same warning at the top of this file
   * applies with the most force here: these types describe the schema and
   * enforce nothing. What refuses a bare digest is
   * `users_password_hash_encoded`; what refuses a negative failure count is a
   * CHECK; what keeps `session_epoch` out of reach is the absence of a grant.
   *
   * `password_hash` is the ENCODED form (`scrypt$N$r$p$salt$digest`), never a
   * bare digest — see `apps/api/src/authn/passwords.ts`. It is `SECRET` in doc
   * 06's classification and appears in no contract, no response and no log. */

  /** `null` for an account that has not activated (STM-018 `invited`). */
  password_hash: string | null;
  password_updated_at: Date | null;
  /** `null` until activation. With `status`, this derives STM-018's account state. */
  activated_at: Date | null;
  failed_sign_in_count: Generated<number>;
  last_failed_sign_in_at: Date | null;
  /** T-22 progressive lockout: compared against the INJECTED clock, never `now()`. */
  locked_until: Date | null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * `migrations/0007_authentication_sessions_invitations.sql` — OPUS-M3-001.
 *
 * Four organization-tenanted tables. Three of them store `token_hash bytea` and
 * have no column that could hold a presented token; the fourth, `user_mfa`,
 * cannot hash its secret (a TOTP verifier has to recompute HMAC over it) and so
 * stores it under AES-256-GCM with the nonce, tag and key version beside it.
 *
 * `session_epoch_at_issue` and `absolute_expires_at` are read-only after insert
 * — a trigger says so, not a comment — and neither is in this file's power to
 * protect.
 * ──────────────────────────────────────────────────────────────────────────── */

export type SessionRevokedReason =
  | 'sign_out'
  | 'privilege_change'
  | 'membership_suspended'
  | 'membership_ended'
  | 'user_deactivated'
  | 'password_changed'
  | 'mfa_reset'
  | 'login_email_changed'
  | 'rotated'
  | 'administrative';

export interface SessionsTable {
  id: string;
  organization_id: string;
  user_id: string;
  /** SHA-256 of the presented secret. `bytea` — a `Buffer` on the wire. */
  token_hash: Buffer;
  issued_at: Generated<Date>;
  last_seen_at: Generated<Date>;
  /** The IDLE deadline. Slides on use. */
  expires_at: Date;
  /** The ABSOLUTE deadline. Frozen at issue by `sessions_guard_absolute_deadline`. */
  absolute_expires_at: Date;
  state: Generated<'active' | 'revoked'>;
  revoked_at: Date | null;
  revoked_reason: SessionRevokedReason | null;
  mfa_satisfied: Generated<boolean>;
  /** Assigned by `sessions_assign_epoch`; never application-supplied. */
  session_epoch_at_issue: Generated<string>;
  persistent: Generated<boolean>;
  rotated_from_session_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface InvitationsTable {
  id: string;
  organization_id: string;
  user_id: string;
  email: string;
  token_hash: Buffer;
  expires_at: Date;
  /** Set by a CONDITIONAL UPDATE. That statement IS the single-use mechanism. */
  consumed_at: Date | null;
  state: Generated<'pending' | 'accepted' | 'expired' | 'revoked'>;
  issued_by_membership_id: string | null;
  revoked_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PasswordResetTokensTable {
  id: string;
  organization_id: string;
  user_id: string;
  token_hash: Buffer;
  expires_at: Date;
  consumed_at: Date | null;
  state: Generated<'pending' | 'consumed' | 'expired' | 'revoked'>;
  revoked_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface UserMfaTable {
  id: string;
  organization_id: string;
  user_id: string;
  method: Generated<'totp'>;
  secret_ciphertext: Buffer;
  secret_nonce: Buffer;
  secret_tag: Buffer;
  key_version: number;
  algorithm: Generated<'SHA1' | 'SHA256'>;
  digits: Generated<number>;
  period_seconds: Generated<number>;
  /** `provisioned` means the factor is NOT yet in force (14 §2). */
  state: Generated<'provisioned' | 'active'>;
  enrolled_at: Date | null;
  /** Monotonic, enforced by `user_mfa_guard_step_monotonic`. RFC 6238 replay defence. */
  last_accepted_time_step: string | null;
  /** `[{ "h": <hex hash>, "c": <iso|null> }]`. Hashed, never the code. */
  recovery_codes: Generated<unknown>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface MembershipsTable {
  id: string;
  organization_id: string;
  /** `null` means an ORGANIZATION membership. Not a missing value. */
  group_id: string | null;
  user_id: string;
  kind: 'organization' | 'group';
  staffing_kind: Generated<'staff' | 'locum'>;
  status: Generated<'invited' | 'active' | 'suspended' | 'ended'>;
  organization_role: string | null;
  group_role: string | null;
  valid_from: Generated<Date>;
  valid_to: Date | null;
  last_active_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/* ────────────────────────────────────────────────────────────────────────────
 * `migrations/0002_authorization.sql` — the SPEC-06 relations.
 *
 * The capability VOCABULARY is not here: `capabilities`, `module_definitions`
 * and `module_dependencies` are doc 06 §3.1 `system`-scoped reference data and
 * live in `packages/domain/src/authz/catalogue.ts` as constants, so that an
 * unknown capability key fails the build (A-14) rather than a query.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface RolesTable {
  id: string;
  organization_id: string;
  /** The P-10 namespace. A role is group-scoped or organization-scoped, never both. */
  scope: 'group' | 'organization';
  key: string;
  name: string;
  is_system_role: Generated<boolean>;
  status: Generated<'active' | 'deprecated'>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface RoleCapabilitiesTable {
  id: string;
  organization_id: string;
  role_id: string;
  capability_key: string;
  created_at: Generated<Date>;
}

export interface CapabilityGrantsTable {
  id: string;
  organization_id: string;
  /** `null` means the grant is on an ORGANIZATION membership. Not a missing value. */
  group_id: string | null;
  membership_id: string;
  capability_key: string;
  /** `false` is an EXPLICIT DENY and beats every allow in its window (SPEC-06 P-1). */
  granted: boolean;
  granted_by_membership_id: string | null;
  reason: string | null;
  valid_from: Generated<Date>;
  valid_to: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface EntitlementsTable {
  id: string;
  organization_id: string;
  module_key: string;
  state: 'trial' | 'active' | 'suspended' | 'revoked';
  effective_from: Generated<Date>;
  effective_to: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface GroupModuleAvailabilityTable {
  id: string;
  organization_id: string;
  group_id: string;
  module_key: string;
  available: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/* ────────────────────────────────────────────────────────────────────────────
 * `migrations/0004_work_profiles_qualifications.sql` — OPUS-M2-003.
 *
 * Effective-dated staffing parameters (CAP-013) and credentials (CAP-058). The
 * same warning at the top of this file applies with more force here: these types
 * describe the schema and enforce nothing. What guarantees one profile row in
 * force per membership is the EXCLUDE constraint; what guarantees history is not
 * rewritten is `app_guard_work_profile_history`; what narrows a credential read
 * is the RLS policy. A `numeric` typed as `string` cannot do any of that.
 *
 * `numeric` columns are `string`, not `number`, and deliberately: node-postgres
 * returns `numeric` as a string to avoid the float64 rounding that would silently
 * turn a 33.33% work percentage into something else. The loader parses them
 * explicitly at the boundary, where the conversion is visible.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface MembershipWorkProfilesTable {
  id: string;
  organization_id: string;
  group_id: string;
  membership_id: string;
  effective_from: Generated<Date>;
  /** `null` means OPEN-ENDED. Never `infinity` — a CHECK constraint refuses it. */
  effective_to: Date | null;
  work_percentage: string;
  max_assignments_per_week: number | null;
  max_assignments_per_period: number | null;
  max_consecutive_days: number | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface MembershipWeekdayFteTable {
  id: string;
  organization_id: string;
  group_id: string;
  work_profile_id: string;
  /** `mon`..`sun` plus `holiday` — FAD-16's eight-member day domain. */
  day: 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun' | 'holiday';
  fte_fraction: string;
  max_assignments: number | null;
  created_at: Generated<Date>;
}

export interface QualificationsTable {
  id: string;
  organization_id: string;
  group_id: string;
  key: string;
  name: string;
  requires_expiry: Generated<boolean>;
  issuing_body: string | null;
  status: Generated<'active' | 'retired'>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface QualificationHoldingsTable {
  id: string;
  organization_id: string;
  group_id: string;
  membership_id: string;
  qualification_id: string;
  valid_from: Generated<Date>;
  valid_until: Date | null;
  /** An opaque REFERENCE to a document held elsewhere. Never free text (I-07). */
  evidence_ref: string | null;
  status: Generated<'pending' | 'valid' | 'expiring' | 'expired' | 'revoked'>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/* ────────────────────────────────────────────────────────────────────────────
 * `migrations/0005_shift_catalogue.sql` — the scheduling-structure catalogue
 * (OPUS-M2-002; CAP-011, CAP-012, and the CAR-011 holiday slice).
 *
 * Every one of these is GROUP-scoped: it carries both tenant columns, its RLS
 * policy is V-09's conjunctive group predicate, and an organization-scoped
 * context sees none of it. SPEC-06 §1.1 puts catalogue authoring outside the
 * organization-scoped action set, so the narrow scope is the correct one rather
 * than a restriction to be relaxed later.
 *
 * `numeric` columns arrive from node-postgres as **strings**, not numbers, and
 * they are typed as such here. A `number` on `credit_weight` would be a type that
 * lies at run time, and the lie would surface as `NaN` in a fairness calculation.
 * ──────────────────────────────────────────────────────────────────────────── */

export type ShiftPaletteKeyColumn = 'neutral' | 'indigo' | 'teal' | 'amber' | 'rose' | 'violet';
export type ShiftTextStyleColumn = 'regular' | 'bold' | 'italic';
export type CatalogueDayColumn = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun' | 'holiday';

export interface ShiftTypesTable {
  id: string;
  organization_id: string;
  group_id: string;
  code: string;
  name: string;
  description: string | null;
  display_palette_key: Generated<ShiftPaletteKeyColumn>;
  display_text_style: Generated<ShiftTextStyleColumn>;
  /** `HH:MM:SS` as PostgreSQL renders `time`. */
  start_time: string;
  end_time: string;
  /** DERIVED from the two times and enforced by `shift_types_overnight_shape`. */
  crosses_midnight: Generated<boolean>;
  is_on_call: Generated<boolean>;
  attracts_stipend: Generated<boolean>;
  is_manual_only: Generated<boolean>;
  is_daily_pick: Generated<boolean>;
  include_in_statistics: Generated<boolean>;
  is_leave_of_absence: Generated<boolean>;
  allow_on_request: Generated<boolean>;
  allow_off_request: Generated<boolean>;
  report_order: Generated<number>;
  /** `numeric` — a string on the wire. */
  credit_weight: Generated<string>;
  status: Generated<'active' | 'retired'>;
  effective_from: Generated<Date>;
  effective_to: Date | null;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ShiftTypeWeekdayDemandTable {
  id: string;
  organization_id: string;
  group_id: string;
  shift_type_id: string;
  day: CatalogueDayColumn;
  demand_count: Generated<number>;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ShiftGroupsTable {
  id: string;
  organization_id: string;
  group_id: string;
  name: string;
  description: string | null;
  scoring_mode: 'hard' | 'weighted';
  /** `numeric` — a string on the wire. NULL exactly when `scoring_mode` is `hard`. */
  weight: string | null;
  allow_request: Generated<boolean>;
  request_off_label: string | null;
  status: Generated<'active' | 'archived'>;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ShiftGroupMembersTable {
  id: string;
  organization_id: string;
  group_id: string;
  shift_group_id: string;
  shift_type_id: string;
  /** De-bundling is `false`, never a DELETE: no runtime role holds one. */
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface StaffGroupsTable {
  id: string;
  organization_id: string;
  group_id: string;
  name: string;
  description: string | null;
  status: Generated<'active' | 'archived'>;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface StaffGroupMembersTable {
  id: string;
  organization_id: string;
  group_id: string;
  staff_group_id: string;
  membership_id: string;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ValidGroupsTable {
  id: string;
  organization_id: string;
  group_id: string;
  name: string;
  /** Ascending, distinct, each `<= groups.pick_position_count`. Trigger-enforced. */
  allowed_pick_positions: Generated<number[]>;
  status: Generated<'active' | 'archived'>;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ValidGroupShiftTypesTable {
  id: string;
  organization_id: string;
  group_id: string;
  valid_group_id: string;
  shift_type_id: string;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/**
 * `shift_type_qualifications` (migration 0006, OPUS-M2-004).
 *
 * The requirement edge: "a member assigned to this shift type must hold this
 * qualification". Composite tenant foreign keys into BOTH parents, so neither
 * end can be re-tenanted and neither can point across a group boundary.
 *
 * `status` rather than a DELETE: a requirement in force when a schedule was
 * built is part of why that schedule looks the way it does, and the database
 * refuses the deletion for the table OWNER as well as for the runtime roles.
 */
export interface ShiftTypeQualificationsTable {
  id: string;
  organization_id: string;
  group_id: string;
  shift_type_id: string;
  qualification_id: string;
  status: Generated<'active' | 'archived'>;
  /** Database-owned. Not in any UPDATE grant — naming it raises 42501. */
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface GroupHolidaysTable {
  id: string;
  organization_id: string;
  group_id: string;
  /** `date` — a calendar date with no time zone, as `YYYY-MM-DD`. */
  holiday_date: string;
  name: string;
  observed: Generated<boolean>;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/* ── OPUS-M3-002 — the typed rule model (migration 0008, CAR-006, SPEC-04 §3) ──
 *
 * FAD-21: `pattern_rules`/`staff_rules` are CATEGORIES of this one model, not
 * separate tables, so `category` is the discriminator and there are exactly two
 * tables here.
 */
export interface RulesTable {
  id: string;
  organization_id: string;
  group_id: string;
  /**
   * The STABLE identifier (non-bypass rule 13). Immutable after insert — the
   * `rules_guard_key_immutable` trigger refuses a change, and the column is
   * absent from the UPDATE grant so a runtime role cannot even name it.
   */
  rule_key: string;
  name: string;
  rule_schema_version: number;
  classification: 'HARD' | 'SOFT';
  /**
   * `numeric` — a string on the wire, and `null` for every `HARD` rule. The
   * `rules_hard_soft_weight` CHECK is the database half of SPEC-04 §3.3.
   */
  weight: string | null;
  /** FAD-21's discriminator. `staff` iff `scope.memberships` is non-empty. */
  category: Generated<'general' | 'pattern' | 'staff'>;
  /** The typed `RuleScope`. Shape-constrained by CHECK, not a free-form blob. */
  scope: Generated<unknown>;
  /**
   * The typed `RuleNode`. `rules_predicate_kind_is_closed` restricts the
   * discriminant to the thirty kinds of SPEC-04 §3.1 — the storage-layer half of
   * "the node set is closed, and there is no escape hatch".
   */
  predicate: unknown;
  status: Generated<'active' | 'disabled' | 'archived'>;
  /** Database-owned. Not in any UPDATE grant — naming it raises 42501. */
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface RuleSetsTable {
  id: string;
  organization_id: string;
  group_id: string;
  name: string;
  /** `text[]` of `rule_key`s — doc 06 §3.2's "rule id arrays", by stable key. */
  rule_keys: Generated<string[]>;
  status: Generated<'active' | 'archived'>;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/* ── `migrations/0009_schedule_publication.sql` (OPUS-M3-003, SPEC-05) ─────────
 *
 * The publication spine. `publication_records` and `version_supersessions` are
 * DELIBERATELY absent from the `Database` interface below, for the reason
 * `audit_events` is (see `TenantTable`): they are append-only history (D-15d),
 * and a typed `updateTable('publication_records')` would be a rewrite path the
 * type system handed out. They are written through raw `sql` inserts and the
 * database refuses UPDATE/DELETE (grant + `app_guard_append_only`). Their
 * interfaces are defined here only for typing raw-SQL result rows. */

export interface SchedulePeriodsTable {
  id: string;
  organization_id: string;
  group_id: string;
  name: string;
  /** `date` — a calendar date, `YYYY-MM-DD`. */
  start_date: string;
  end_date: string;
  status: Generated<'planning' | 'published' | 'closed'>;
  period_version: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ScheduleRequirementsTable {
  id: string;
  organization_id: string;
  group_id: string;
  period_id: string;
  date: string;
  shift_type_id: string;
  required_count: number;
  requirement_version: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ScheduleVersionsTable {
  id: string;
  organization_id: string;
  group_id: string;
  period_id: string;
  /** NULL until published; allocated gaplessly in the publication transaction (D-9). */
  version_number: number | null;
  source_build_id: string | null;
  cloned_from_version_id: string | null;
  state: Generated<
    'draft' | 'in_review' | 'approved' | 'publishing' | 'published' | 'superseded' | 'cancelled'
  >;
  lock_state: Generated<'unlocked' | 'locked'>;
  is_current: Generated<boolean>;
  circulation_state: Generated<'not_circulated' | 'circulated'>;
  change_summary: string | null;
  published_at: Date | null;
  published_by: string | null;
  superseded_at: Date | null;
  superseded_by_version_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ShiftsTable {
  id: string;
  organization_id: string;
  group_id: string;
  version_id: string;
  date: string;
  shift_type_id: string;
  location_id: string | null;
  required_count: Generated<number>;
  shift_version: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AssignmentIdentitiesTable {
  id: string;
  organization_id: string;
  group_id: string;
  period_id: string;
  origin: Generated<'manual' | 'clone' | 'solver' | 'picklist'>;
  created_at: Generated<Date>;
}

export interface AssignmentSnapshotsTable {
  id: string;
  organization_id: string;
  group_id: string;
  assignment_identity_id: string;
  version_id: string;
  membership_id: string;
  shift_id: string;
  date: string;
  starts_at: Date;
  ends_at: Date;
  origin: Generated<'manual' | 'clone' | 'solver' | 'picklist'>;
  pick_position: number | null;
  is_pinned: Generated<boolean>;
  status: Generated<'active' | 'cancelled'>;
  supersedes_snapshot_id: string | null;
  override_reason: string | null;
  snapshot_version: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CreditsTable {
  id: string;
  organization_id: string;
  group_id: string;
  assignment_identity_id: string;
  source_version_id: string;
  source_snapshot_id: string;
  credited_membership_id: string;
  /** `numeric` — node-pg returns it as a string. */
  weight: Generated<string>;
  reason: string | null;
  moved_by: string | null;
  status: Generated<'active' | 'reassigned' | 'voided'>;
  credit_version: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ScheduleConflictsTable {
  id: string;
  organization_id: string;
  group_id: string;
  version_id: string | null;
  severity: 'hard-breach' | 'soft' | 'info';
  refs: Generated<unknown>;
  explanation: string | null;
  remediation: string | null;
  state: Generated<'open' | 'accepted' | 'resolved'>;
  conflict_version: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CurrentPublishedAssignmentsTable {
  id: string;
  organization_id: string;
  group_id: string;
  membership_id: string;
  period_id: string;
  starts_at: Date;
  ends_at: Date;
  source_version_id: string;
  source_snapshot_id: string;
  assignment_identity_id: string;
}

/** Append-only (D-15d); not in `Database`. Defined for raw-SQL row typing only. */
export interface PublicationRecordsTable {
  id: string;
  organization_id: string;
  group_id: string;
  period_id: string;
  version_id: string;
  publication_idempotency_key: string;
  actor_membership_id: string | null;
  prerequisites_snapshot: unknown;
  outcome: 'published' | 'failed';
  created_at: Date;
}

/** Append-only (D-15d); not in `Database`. Defined for raw-SQL row typing only. */
export interface VersionSupersessionsTable {
  id: string;
  organization_id: string;
  group_id: string;
  superseded_version_id: string;
  superseding_version_id: string;
  superseded_at: Date;
}

export interface Database {
  organizations: OrganizationsTable;
  groups: GroupsTable;
  users: UsersTable;
  memberships: MembershipsTable;
  roles: RolesTable;
  role_capabilities: RoleCapabilitiesTable;
  capability_grants: CapabilityGrantsTable;
  entitlements: EntitlementsTable;
  group_module_availability: GroupModuleAvailabilityTable;
  membership_work_profiles: MembershipWorkProfilesTable;
  membership_weekday_fte: MembershipWeekdayFteTable;
  qualifications: QualificationsTable;
  qualification_holdings: QualificationHoldingsTable;
  shift_types: ShiftTypesTable;
  shift_type_weekday_demand: ShiftTypeWeekdayDemandTable;
  shift_groups: ShiftGroupsTable;
  shift_group_members: ShiftGroupMembersTable;
  staff_groups: StaffGroupsTable;
  staff_group_members: StaffGroupMembersTable;
  valid_groups: ValidGroupsTable;
  valid_group_shift_types: ValidGroupShiftTypesTable;
  group_holidays: GroupHolidaysTable;
  shift_type_qualifications: ShiftTypeQualificationsTable;
  sessions: SessionsTable;
  invitations: InvitationsTable;
  password_reset_tokens: PasswordResetTokensTable;
  user_mfa: UserMfaTable;
  rules: RulesTable;
  rule_sets: RuleSetsTable;
  /* OPUS-M3-003 (SPEC-05). `publication_records` and `version_supersessions`
   * are intentionally excluded — append-only history, written via raw SQL. */
  schedule_periods: SchedulePeriodsTable;
  schedule_requirements: ScheduleRequirementsTable;
  schedule_versions: ScheduleVersionsTable;
  shifts: ShiftsTable;
  assignment_identities: AssignmentIdentitiesTable;
  assignment_snapshots: AssignmentSnapshotsTable;
  credits: CreditsTable;
  schedule_conflicts: ScheduleConflictsTable;
  current_published_assignments: CurrentPublishedAssignmentsTable;
}

/**
 * Every tenant-scoped table, and how its RLS predicate is scoped.
 *
 * SPEC-01 §7.2's preamble requires the concurrency harness to run "against every
 * tenant table". This registry is what makes that literal rather than
 * aspirational: the T-13 fail-closed probe, the T-15 storm probe, the
 * (role, table) privilege check and the final census all iterate it, so adding a
 * tenant table without adding it here fails the coverage assertion.
 *
 * The tables that are deliberately NOT here are declared, with reasons, in
 * `apps/api/test/support/schema-census.ts`, and a test asserts that the two
 * lists together account for every table in the schema. They live there rather
 * than beside this registry for a reason worth stating: naming the chain-tip
 * table in a module under `src/` trips
 * `apps/api/test/audit/architecture.test.ts`'s absolute rule that no TypeScript
 * module names it at all — a rule worth keeping absolute.
 */
export type TenantScope =
  /** The row IS the tenant: predicate is `id = app.organization_id`. */
  | 'organization-identity'
  /** Carries `organization_id`; group predicate applies when a group context is in force. */
  | 'organization-and-group'
  /**
   * Carries `organization_id` and **no** `group_id`, and is readable under a
   * group-scoped context as well as an organization-scoped one.
   *
   * Only three tables are in this class — `roles`, `role_capabilities`,
   * `entitlements` — and each has the same justification: SPEC-06 evaluates it
   * during a GROUP-scoped request (L4.2 needs the group role's capability set,
   * L1 needs the organization's entitlement) and the row has no group dimension
   * to bind against. An organization predicate is the narrowest one that exists
   * for them, not a relaxation of V-09's group predicate. Their WRITE policies
   * are still organization-context-only.
   */
  | 'organization-only'
  /**
   * Carries `organization_id`, has **no group dimension at all**, and is
   * readable **only** under an organization-scoped context.
   *
   * The difference from `organization-only` is not pedantry. Those three tables
   * are deliberately readable during a group-scoped request, because the
   * evaluator needs them there. `audit_checkpoints` is the opposite: a checkpoint
   * covers an organization's whole chain, so a group-scoped context must see
   * none of them, and its policy carries the `app.group_id IS NULL` clause that
   * says so (0003, R-06 — a second review moved the predicate to meet the
   * comment rather than the other way round). Under a group context the probe
   * expects zero visible rows, which is the control working.
   */
  | 'organization-context-only'
  /** No tenant column; reachable only through a membership visible in context. */
  | 'through-membership';

export interface TenantTable {
  /**
   * The table's name in the database.
   *
   * **Deliberately `string`, and it was `keyof Database` until OPUS-M1-004.**
   *
   * Registering the audit and outbox tables would otherwise have required adding
   * them to the Kysely `Database` interface — which would make
   * `query.updateTable('audit_events')` a statement that type-checks. That is an
   * update path to the audit chain, handed out by the type system, in exchange
   * for a constraint that only ever proved a name appeared in a hand-written
   * interface.
   *
   * The names are checked against the **database** instead, which is the
   * stronger check and the one that can actually be wrong:
   * `apps/api/test/tenancy/roles-and-schema.test.ts` asserts that every entry
   * here is a real table, and that every real table is either registered here or
   * declared in `NON_TENANT_TABLES` with a reason.
   */
  readonly name: string;
  readonly scope: TenantScope;
}

export const TENANT_TABLES: readonly TenantTable[] = [
  { name: 'organizations', scope: 'organization-identity' },
  { name: 'groups', scope: 'organization-and-group' },
  { name: 'users', scope: 'through-membership' },
  { name: 'memberships', scope: 'organization-and-group' },
  { name: 'roles', scope: 'organization-only' },
  { name: 'role_capabilities', scope: 'organization-only' },
  { name: 'capability_grants', scope: 'organization-and-group' },
  { name: 'entitlements', scope: 'organization-only' },
  { name: 'group_module_availability', scope: 'organization-and-group' },

  /* ── `migrations/0003_audit_outbox.sql` (OPUS-M1-004, FAD-13 item 3) ────────
   *
   * OPUS-M1-003 left these out because `db/schema.ts` was OPUS-M1-002's file
   * scope while it was being written. They are tenant tables in every sense the
   * registry means — `organization_id` column, RLS enabled and FORCEd,
   * organization-scoped policies, a SELECT grant for both application roles — so
   * every generic assertion that iterates this registry now covers them: the
   * pool-cleanliness probe, the wrong-tenant probe, the (role, table) privilege
   * matrix, the nullif-guard scan and the T-15 storm. */
  { name: 'audit_events', scope: 'organization-and-group' },
  { name: 'audit_checkpoints', scope: 'organization-context-only' },
  { name: 'outbox_events', scope: 'organization-and-group' },
  { name: 'outbox_effects', scope: 'organization-and-group' },

  /* ── `migrations/0004_work_profiles_qualifications.sql` (OPUS-M2-003) ───────
   *
   * Registered in the SAME change as the migration, per packet 30 §7.2 — which
   * exists because migration 0003's four tenant tables were left out of this
   * registry and stayed unprobed until OPUS-M1-004 noticed. Registration is what
   * puts them into the generic assertions: the pool-cleanliness probe, the
   * wrong-tenant probe, the (role, table) privilege matrix, the nullif-guard scan,
   * the T-15 storm, and — the one that would have caught 0003's omission —
   * SBX-004's non-vacuity check, which fails the sweep if a registered table is
   * never seen with a visible row.
   *
   * All four are `organization-and-group`: every row carries both columns, and
   * each table has a V-09 conjunctive group policy plus an organization-context
   * policy. `qualification_holdings` is the exception in READ breadth rather than
   * in scope — its SELECT policies additionally require a capability, because 06
   * §3.2 classifies it `SENSITIVE-PII`. */
  { name: 'membership_work_profiles', scope: 'organization-and-group' },
  { name: 'membership_weekday_fte', scope: 'organization-and-group' },
  { name: 'qualifications', scope: 'organization-and-group' },
  { name: 'qualification_holdings', scope: 'organization-and-group' },
  /* ── `migrations/0005_shift_catalogue.sql` (OPUS-M2-002) ────────────────────
   *
   * Registered in the SAME change as the migration that creates them (packet 30
   * §7.2). Every one is `organization-and-group`: both tenant columns, V-09's
   * conjunctive group predicate, and no organization-scoped policy at all — so
   * every generic assertion that iterates this registry covers them, and each is
   * probed under a GROUP context where its policy can actually admit a row.
   *
   * Their non-vacuity in those probes is established by `provisionMulti`
   * (`apps/api/test/support/multi.ts`), which seeds one of every catalogue row
   * through the production write path for any fixture that asks for it. The
   * seeding lived in a per-file module while OPUS-M2-002 and OPUS-M2-003 ran in
   * parallel and packet 30 §5 held the MULTI provisioning script read-only; the
   * D-1 ruling moved it back, so there is one fixture owner again. */
  { name: 'shift_types', scope: 'organization-and-group' },
  { name: 'shift_type_weekday_demand', scope: 'organization-and-group' },
  { name: 'shift_groups', scope: 'organization-and-group' },
  { name: 'shift_group_members', scope: 'organization-and-group' },
  { name: 'staff_groups', scope: 'organization-and-group' },
  { name: 'staff_group_members', scope: 'organization-and-group' },
  { name: 'valid_groups', scope: 'organization-and-group' },
  { name: 'valid_group_shift_types', scope: 'organization-and-group' },
  { name: 'group_holidays', scope: 'organization-and-group' },

  /* ── `migrations/0006_shift_type_qualifications.sql` (OPUS-M2-004) ──────────
   *
   * Registered in the SAME change as the migration that creates it (packet 30
   * §7.2, whose rule exists because 0003's four tenant tables were left out of
   * this registry and stayed unprobed until OPUS-M1-004 noticed).
   *
   * `organization-and-group`: both tenant columns, V-09's conjunctive group
   * predicate, no organization-scoped policy. Its non-vacuity in the sweeps is
   * established by `provisionMulti`'s catalogue seeding, which writes
   * requirement rows in Group One AND in the sibling group through the
   * production write path — so the cross-GROUP arm has something it could see if
   * the group predicate were broken, not only the cross-organization one. */
  { name: 'shift_type_qualifications', scope: 'organization-and-group' },

  /* ── `migrations/0007_authentication_sessions_invitations.sql` (OPUS-M3-001) ─
   *
   * Registered in the SAME change as the migration that creates them (packet 30
   * §7.2, whose rule exists because 0003's four tenant tables were left out of
   * this registry and stayed unprobed until OPUS-M1-004 noticed).
   *
   * All four are `organization-and-group` in the registry's ROW SHAPE sense —
   * they carry `organization_id` — but note what their policies do NOT carry: a
   * group clause. An authentication artifact belongs to an identity in an
   * organization and has no group dimension, and it must stay resolvable while a
   * GROUP-scoped request is being served, so `app.group_id` is deliberately
   * absent from each predicate.
   *
   * That is the same shape `roles`/`role_capabilities`/`entitlements` have, and
   * so the scope is `organization-only`: an organization column, no group
   * column, readable under a group-scoped context because the request pipeline
   * genuinely needs it there. Declaring them `organization-and-group` would make
   * `wrongTenantProbe` demand a `group_id` column that does not exist. */
  { name: 'sessions', scope: 'organization-only' },
  { name: 'invitations', scope: 'organization-only' },
  { name: 'password_reset_tokens', scope: 'organization-only' },
  { name: 'user_mfa', scope: 'organization-only' },

  /* ── `migrations/0008_typed_rules.sql` (OPUS-M3-002) ────────────────────────
   *
   * Registered in the SAME change as the migration that creates them (packet 30
   * §7.2). Both are `organization-and-group`: both tenant columns, V-09's
   * conjunctive group predicate, no organization-scoped policy — rule authoring
   * is not in SPEC-06 §1.1's organization-scoped enumeration, so an
   * organization-scoped context sees zero rule rows.
   *
   * Their non-vacuity in the sweep is established by
   * **`apps/api/test/support/rules.ts::seedRulesForSweep`**, called from the
   * files that sweep this registry (`test/sbx/sbx.test.ts`,
   * `test/tenancy/unit-of-work.test.ts`,
   * `test/red-cases/probe-is-not-vacuous.test.ts`). It writes a rule and a rule
   * set into Alpha's two groups AND into Beta through the production write path,
   * so the cross-GROUP arm has something it could see if the group predicate
   * were broken, not only the cross-organization one.
   *
   * NOT `provisionMulti`: `test/support/multi.ts` is the single fixture owner and
   * was prohibited to OPUS-M3-002 (packet 32 §4/§6), so this packet seeds from
   * its own support file rather than editing the shared script.
   *
   * `rules` additionally carries the INTERNAL capability predicate (FAD-17(2)),
   * so `app_readonly_support` is narrowed to 42501 on it — recorded distinctly
   * by the sweep, exactly as `qualification_holdings` is. */
  { name: 'rules', scope: 'organization-and-group' },
  { name: 'rule_sets', scope: 'organization-and-group' },

  /* ── `migrations/0009_schedule_publication.sql` (OPUS-M3-003, SPEC-05) ───────
   *
   * Registered in the SAME change as the migration that creates them (packet 30
   * §7.2). Every one is `organization-and-group`: both tenant columns and V-09's
   * conjunctive group predicate, no organization-scoped policy — so every
   * generic assertion that iterates this registry covers them, and each is
   * probed under a GROUP context where its policy can admit a row. Their
   * non-vacuity in SBX-004's sweep is established by `provisionMulti`'s
   * `schedule` seed (`apps/api/test/support/multi.ts`), which drives the
   * production publication path so that every one of these tables — including
   * `version_supersessions` (two publications) and `current_published_assignments`
   * (maintained inside the publication transaction) — carries a visible row. */
  { name: 'schedule_periods', scope: 'organization-and-group' },
  { name: 'schedule_requirements', scope: 'organization-and-group' },
  { name: 'schedule_versions', scope: 'organization-and-group' },
  { name: 'shifts', scope: 'organization-and-group' },
  { name: 'assignment_identities', scope: 'organization-and-group' },
  { name: 'assignment_snapshots', scope: 'organization-and-group' },
  { name: 'credits', scope: 'organization-and-group' },
  { name: 'schedule_conflicts', scope: 'organization-and-group' },
  { name: 'publication_records', scope: 'organization-and-group' },
  { name: 'version_supersessions', scope: 'organization-and-group' },
  { name: 'current_published_assignments', scope: 'organization-and-group' },
] as const;
