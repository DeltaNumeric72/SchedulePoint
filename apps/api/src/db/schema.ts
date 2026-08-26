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
  /* ── OPUS-M3-007 group settings (`migrations/0010_group_settings_locations.sql`)
   *
   * A discriminated triple, not three independent fields: the
   * `groups_request_until_shape` CHECK admits exactly the columns each mode
   * needs and refuses every other combination. The contract mirrors it as a zod
   * discriminated union, so the meaningless states are unrepresentable on the
   * wire as well as in the table.
   *
   * **Stored and authored only at this milestone.** The request window is
   * enforced at M5 (SPEC-08) and the picklist mode at M9 (SPEC-02) — packet 32
   * §2 rows 5 and 6. Nothing in `src/` reads either to decide anything. */
  request_until_mode: Generated<'closed' | 'fixed_date' | 'days_before_period_start'>;
  /** Populated exactly when the mode is `fixed_date`. A `date`, not an instant. */
  request_until_date: string | null;
  /** Populated exactly when the mode is `days_before_period_start`. 0..365. */
  request_until_lead_days: number | null;
  /**
   * SchedulePoint's own closed set. The source's `Pick List Access` semantics
   * are UNRESOLVED (C-02, doc 05 §5) and are not reproduced here. The setting
   * only ever NARROWS — it never grants — which is why `disabled` is the
   * default.
   */
  picklist_access_mode: Generated<'disabled' | 'members' | 'members_and_proxies'>;
  /**
   * Optimistic concurrency for the SETTINGS facet of this row — the two stored
   * settings plus `timezone`.
   *
   * A counter of its own rather than `group_version`, for two reasons and the
   * first was measured: `group_version` bumps only on a `status` change (0001,
   * SPEC-06 §4), so a CAS predicate against it matches forever and the second
   * writer silently overwrites the first — `test/settings/timezone.test.ts`
   * caught exactly that. Making `group_version` move instead would invalidate
   * every cached AUTHORIZATION decision on a change that alters no
   * authorization.
   *
   * Database-owned (`app_maintain_group_settings_version`) and absent from every
   * UPDATE grant.
   */
  settings_version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/**
 * `locations` — doc 06 §3.2 row 237 (`migrations/0010_group_settings_locations.sql`).
 *
 * **`site_label` is a free-form attribute and NOT a foreign key.** PO-DEC-01 is
 * pending with the working default "defer a first-class Site; model location as
 * an attribute" (06 §3.2a), so there is no `sites` table, no `site_id`, and no
 * site-scoped surface anywhere — building one would select the pending
 * decision's non-default branch by stealth (non-bypass rule 12).
 */
export interface LocationsTable {
  id: string;
  organization_id: string;
  group_id: string;
  name: string;
  site_label: string | null;
  address: string | null;
  /** Per-LOCATION zone, distinct from `groups.timezone`. Null = the group's. */
  timezone: string | null;
  status: Generated<'active' | 'archived'>;
  /** Database-owned (`app_maintain_catalogue_version`); absent from every grant. */
  version: Generated<number>;
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
  /** Row CAS counter (migration 0012, the 0005 pattern). DB-owned; absent from every grant. */
  version: Generated<number>;
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
  /** Row CAS counter (migration 0012, the 0005 pattern). DB-owned; absent from every grant. */
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/**
 * `staffing_set_versions` (migration 0012, OPUS-M4-000A).
 *
 * The aggregate consistency counter behind the whole-set staffing editors:
 * per-shift-type weekday demand, per-period requirements, and the per-shift-
 * type qualification-requirement set. One row per aggregate, created lazily by
 * the first content write; **an absent row means version 1**.
 *
 * DATABASE-OWNED on FAD-24's `settings_version` terms: no runtime role holds
 * INSERT or UPDATE — `app_bump_staffing_set_version` (SECURITY DEFINER, fired
 * by the content tables' triggers) is the only writer, and the monotonic guard
 * binds the owner too. The application reads it under a tenant-qualified
 * advisory lock and refuses a stale `expectedVersion` with an explicit 409.
 */
export interface StaffingSetVersionsTable {
  id: Generated<string>;
  organization_id: string;
  group_id: string;
  scope: 'weekday_demand' | 'period_requirements' | 'qualification_requirements';
  scope_id: string;
  version: Generated<number>;
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
  /**
   * OPUS-M4-000B (`migrations/0014`). The IANA zone this version's instants were
   * derived under, and the tz DATABASE rule set in force at the time
   * (`process.versions.tz`). Together they are the interpretation needed to
   * reproduce the version's rendering after the GROUP's timezone changes
   * (doc 34 §4-F). NULL on every version created before 0014 — "not recorded",
   * never a backfilled guess.
   */
  timezone_basis: string | null;
  tzdb_version: string | null;
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
  /**
   * OPUS-M4-000C (migration 0015, doc 34 §4-G). D-17 bound idempotency to
   * (period, key), which answers "have I seen this key?" and not "have I seen
   * this key for THIS request?". A key reused for a REVERT after a PUBLISH was
   * told its operation had already succeeded when a different one had.
   */
  operation_type: 'publish' | 'revert';
  /**
   * A sha-256 over the semantic request — the operation, the period, the
   * version, the expected prior current version and the expected version state.
   * `null` only for records written before 0015.
   */
  semantic_request_digest: string | null;
  created_at: Date;
}

/**
 * `migrations/0015_rule_revisions_and_period_lifecycle.sql` (OPUS-M4-000C).
 *
 * Append-only, and deliberately ABSENT from `Database` for exactly the reason
 * `publication_records` is: a typed `updateTable('rule_revisions')` would be a
 * rewrite path the type system handed out for a table whose whole value is that
 * it cannot be rewritten. Rows arrive through the SECURITY DEFINER trigger
 * `app_record_rule_revision`; reads go through raw `sql` and are typed by this
 * interface. No runtime role holds INSERT, UPDATE or DELETE.
 */
export interface RuleRevisionsTable {
  id: string;
  organization_id: string;
  group_id: string;
  rule_id: string;
  /** The STABLE identifier, carried so a citation reads `rule_key@revision`. */
  rule_key: string;
  /** `rules.version` at the moment of the mutation — the CAS token, as history. */
  revision: number;
  rule_schema_version: number;
  name: string;
  classification: 'HARD' | 'SOFT';
  weight: string | null;
  category: 'general' | 'pattern' | 'staff';
  scope: unknown;
  predicate: unknown;
  status: 'active' | 'disabled' | 'archived';
  recorded_by: string | null;
  recorded_at: Date;
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

/* ────────────────────────────────────────────────────────────────────────────
 * The build lifecycle (`migrations/0018_build_lifecycle.sql`, OPUS-M4-003).
 *
 * The sixteen states of report 21 §4 are spelled out in the union rather than
 * typed as `string`, so a state that is not one of the sixteen is a compile
 * error at the call site rather than a `restrict_violation` at run time. The
 * database CHECK is still the control; this is the readable half.
 * ──────────────────────────────────────────────────────────────────────────── */

/** report 21 §4, in order. `infeasible` and `failed` are never conflated. */
export type BuildRunState =
  | 'draft_configuration'
  | 'validating'
  | 'readiness_check'
  | 'queued'
  | 'running'
  | 'completed'
  | 'completed_with_unmet_preferences'
  | 'infeasible'
  | 'failed'
  | 'cancelled'
  | 'reviewed'
  | 'progressively_extended'
  | 'approved'
  | 'applied_to_draft_schedule'
  | 'superseded'
  | 'archived';

/** FAD-34 / SPEC-04 §2. Mirrors `TERMINATION_REASONS` in the domain. */
export type BuildTerminationReason =
  | 'completed'
  | 'deadline'
  | 'user_cancelled'
  | 'killed'
  | 'crashed'
  | 'rejected';

export type BuildSolverStatus =
  | 'OPTIMAL'
  | 'FEASIBLE'
  | 'INFEASIBLE'
  | 'MODEL_INVALID'
  | 'UNKNOWN'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'FAILED';

export interface BuildConfigurationsTable {
  id: Generated<string>;
  organization_id: string;
  group_id: string;
  period_id: string;
  name: string;
  random_seed: Generated<number>;
  num_search_workers: Generated<number>;
  max_time_seconds: string;
  max_deterministic_time: string | null;
  interleave_search: Generated<boolean>;
  dispatch_timeout_ms: Generated<number>;
  heartbeat_timeout_ms: Generated<number>;
  retry_limit: Generated<number>;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface BuildRunsTable {
  id: Generated<string>;
  organization_id: string;
  group_id: string;
  period_id: string;
  build_configuration_id: string;
  /** The draft the problem is posed AGAINST — never the one a candidate is written to. */
  source_version_id: string;
  state: Generated<BuildRunState>;
  candidate_label: string;
  snapshot_id: string | null;
  canonical_input_hash: string | null;
  retry_of_build_run_id: string | null;
  retry_attempt: Generated<number>;
  parent_build_ids: Generated<string[]>;
  protected_assignment_identities: Generated<string[]>;
  /** Monotonic. Incremented by every claim and every reap; never reset. */
  claim_epoch: Generated<number>;
  claimed_by: string | null;
  claimed_at: Date | null;
  heartbeat_at: Date | null;
  termination_reason: BuildTerminationReason | null;
  solver_status: BuildSolverStatus | null;
  solver_version: string | null;
  solver_image_digest: string | null;
  compiler_version: string | null;
  platform_arch: string | null;
  solver_parameters: Generated<unknown>;
  deterministic_worker_count: number | null;
  random_seed: number | null;
  reproducibility_mode: 'deterministic' | 'best-effort' | null;
  validation_findings: Generated<unknown>;
  readiness_findings: Generated<unknown>;
  applied_to_version_id: string | null;
  applied_at: Date | null;
  superseded_by_build_run_id: string | null;
  idempotency_key: string;
  semantic_request_digest: string;
  initiated_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  submitted_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface BuildRunEventsTable {
  id: Generated<string>;
  organization_id: string;
  group_id: string;
  build_run_id: string;
  kind: 'transition' | 'result_refused' | 'heartbeat_reaped' | 'claim' | 'cancel_requested';
  from_state: string | null;
  to_state: string | null;
  claim_epoch: number;
  current_claim_epoch: number | null;
  reason: string | null;
  detail: Generated<unknown>;
  actor_membership_id: string | null;
  occurred_at: Generated<Date>;
}

export interface BuildRunResultsTable {
  id: Generated<string>;
  organization_id: string;
  group_id: string;
  build_run_id: string;
  claim_epoch: number;
  solver_status: BuildSolverStatus;
  termination_reason: BuildTerminationReason;
  reported_input_hash: string;
  /** The INDEPENDENT checker's verdict — never the worker's opinion. */
  usable: boolean;
  hard_violations: number;
  assignment_count: number;
  candidate_returned: boolean;
  objective_value: string | null;
  quality_metrics: Generated<unknown>;
  objective_tiers: Generated<unknown>;
  explanation_state: string | null;
  explanation: Generated<unknown>;
  rejections: Generated<unknown>;
  elapsed_ms: number;
  recorded_at: Generated<Date>;
}

export interface BuildRunViolationsTable {
  id: Generated<string>;
  organization_id: string;
  group_id: string;
  build_run_id: string;
  claim_epoch: number;
  finding: 'breach' | 'not-evaluable';
  rule_key: string;
  node_kind: string;
  field: string;
  explanation: string;
  recorded_at: Generated<Date>;
}

export interface BuildRunCandidateAssignmentsTable {
  id: Generated<string>;
  organization_id: string;
  group_id: string;
  build_run_id: string;
  claim_epoch: number;
  ordinal: number;
  membership_id: string;
  date: string;
  shift_type_id: string;
  location_id: string | null;
  /** R-8: the fixed input this row mirrors, when it mirrors one. */
  mirrors_assignment_identity_id: string | null;
  mirrors_pinned: Generated<boolean>;
  pick_position: number | null;
}

/* ── OPUS-M5-000b — the request aggregate and its subtypes ────────────────────
 *
 * `migrations/0021_request_aggregate_and_subtypes.sql` (SPEC-08 §1, §2) and
 * `migrations/0022_vacation_lifecycle_carriers.sql` (SPEC-08 §5).
 *
 * These types describe the schema; they enforce nothing — the file's opening
 * paragraph, and nowhere is it more load-bearing than here. D-18, D-19, D-20,
 * D-21, D-27 and the §2 transition matrices are all constraints and triggers in
 * the two migrations. A `RequestsTable` whose `status` were typed as a union of
 * every status would type-check `{ subtype: 'shift-preference', status:
 * 'approved' }` — which is SPEC-08 R-03's illegal row — so the per-subtype
 * domain is deliberately NOT modelled in the type. Narrowing it here would put a
 * second, weaker copy of D-20 in a place where a reader might trust it instead.
 */

export interface RequestsTable {
  id: Generated<string>;
  organization_id: string;
  group_id: string;
  /** The requester. */
  membership_id: string;
  /**
   * The discriminator. Frozen after insert by `app_guard_request_transition`,
   * because it selects the row's status domain, its subtype table and its
   * transition matrix all at once.
   */
  subtype:
    | 'availability'
    | 'time-off'
    | 'no-call'
    | 'shift-preference'
    | 'shift-group-off'
    | 'vacation-selection';
  /**
   * The union across ALL subtypes. **Not every value is legal for every
   * subtype** — `unsatisfied` is shift-preference's alone and `reversed` is
   * vacation's alone — and the legal set per subtype is D-20, a CHECK in 0021.
   */
  status: Generated<
    | 'draft'
    | 'submitted'
    | 'under_review'
    | 'accepted_as_input'
    | 'approved'
    | 'denied'
    | 'withdrawn'
    | 'consumed_by_build'
    | 'reflected_in_version'
    | 'unsatisfied'
    | 'reversed'
    | 'expired'
    | 'superseded_by_revision'
  >;
  submitted_at: Date | null;
  decided_at: Date | null;
  decided_by: string | null;
  withdrawn_at: Date | null;
  /** NOT NULL per SPEC-08 §1.1. Computed server-side at submission (§3, M5-001). */
  expires_at: Date;
  idempotency_key: string;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface RequestAvailabilityTable {
  request_id: string;
  organization_id: string;
  group_id: string;
  subtype: Generated<'availability'>;
  target_date: string;
  created_at: Generated<Date>;
}

export interface RequestTimeOffTable {
  request_id: string;
  organization_id: string;
  group_id: string;
  subtype: Generated<'time-off'>;
  /** Exactly one of `target_date` or the `(range_start, range_end)` pair — D-19. */
  target_date: string | null;
  range_start: string | null;
  range_end: string | null;
  created_at: Generated<Date>;
}

export interface RequestNoCallTable {
  request_id: string;
  organization_id: string;
  group_id: string;
  subtype: Generated<'no-call'>;
  target_date: string;
  created_at: Generated<Date>;
}

export interface RequestShiftPreferenceTable {
  request_id: string;
  organization_id: string;
  group_id: string;
  subtype: Generated<'shift-preference'>;
  target_date: string;
  /** `NOT NULL` — SPEC-08 R-02, the review's named failure. */
  shift_type_id: string;
  preference_strength: 'low' | 'medium' | 'high';
  created_at: Generated<Date>;
}

export interface RequestShiftGroupOffTable {
  request_id: string;
  organization_id: string;
  group_id: string;
  subtype: Generated<'shift-group-off'>;
  target_date: string;
  /** The target's `allow_request` must be true — a trigger, not a foreign key. */
  shift_group_id: string;
  created_at: Generated<Date>;
}

export interface VacationPeriodsTable {
  id: Generated<string>;
  organization_id: string;
  group_id: string;
  /** A Monday, by CHECK. */
  start_date: string;
  /** A Friday, by CHECK. */
  end_date: string;
  /** `quota` has grant rows; `open` has none and approval skips them (V-30). */
  mode: 'quota' | 'open';
  state: Generated<'draft' | 'open' | 'closed' | 'archived'>;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface VacationGrantsTable {
  id: Generated<string>;
  organization_id: string;
  group_id: string;
  vacation_period_id: string;
  kind: 'personal-entitlement' | 'weekly-capacity';
  /** Present for `personal-entitlement` and null for `weekly-capacity`. */
  membership_id: string | null;
  /** Present for `weekly-capacity` and null for `personal-entitlement`. */
  week_start: string | null;
  units_total: number;
  units_consumed: Generated<number>;
  /** V-28. Written only by the audited override path; raises D-21's bound. */
  override_units: Generated<number>;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface VacationSelectionsTable {
  id: Generated<string>;
  organization_id: string;
  group_id: string;
  /** NULL in `available` and only in `available` — a CHECK pins the pair. */
  request_id: string | null;
  subtype: Generated<'vacation-selection'>;
  membership_id: string;
  vacation_period_id: string;
  /** A Monday inside the period — a CHECK and a trigger, respectively. */
  week_start: string;
  /**
   * **The authoritative status.** `requests.status` is derived from this one by
   * SPEC-08 §5.3's mapping, in the same transaction, and D-27 asserts it.
   */
  status: Generated<
    | 'available'
    | 'pending'
    | 'approved'
    | 'committed'
    | 'denied'
    | 'withdrawn'
    | 'expired'
    | 'reversed'
  >;
  /** V-29 — the SELECTION's own counter, not the grant's. */
  version: Generated<number>;
  grant_id: string | null;
  is_override: Generated<boolean>;
  override_reason: string | null;
  approval_idempotency_key: string | null;
  committed_to_version_id: string | null;
  commit_idempotency_key: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface VacationApprovalCommandsTable {
  id: Generated<string>;
  organization_id: string;
  group_id: string;
  selection_id: string;
  approval_idempotency_key: string;
  received_at: Generated<Date>;
  /** NULL while the command is in flight; set by §5.4's last statement. */
  outcome:
    | 'approved'
    | 'denied'
    | 'quota_exhausted'
    | 'version_conflict'
    | 'selection_not_pending'
    | null;
  created_at: Generated<Date>;
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
  /* OPUS-M3-007 (`migrations/0010_group_settings_locations.sql`). */
  locations: LocationsTable;
  /* OPUS-M4-000A (`migrations/0012_staffing_input_integrity.sql`). */
  staffing_set_versions: StaffingSetVersionsTable;
  /* OPUS-M4-003 (`migrations/0018_build_lifecycle.sql`). */
  build_configurations: BuildConfigurationsTable;
  build_runs: BuildRunsTable;
  build_run_events: BuildRunEventsTable;
  build_run_results: BuildRunResultsTable;
  build_run_violations: BuildRunViolationsTable;
  build_run_candidate_assignments: BuildRunCandidateAssignmentsTable;

  /* OPUS-M5-000b — migrations 0021 and 0022 (SPEC-08 §1, §2, §5). */
  requests: RequestsTable;
  request_availability: RequestAvailabilityTable;
  request_time_off: RequestTimeOffTable;
  request_no_call: RequestNoCallTable;
  request_shift_preference: RequestShiftPreferenceTable;
  request_shift_group_off: RequestShiftGroupOffTable;
  vacation_periods: VacationPeriodsTable;
  vacation_grants: VacationGrantsTable;
  vacation_selections: VacationSelectionsTable;
  vacation_approval_commands: VacationApprovalCommandsTable;
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

  /* ── `migrations/0010_group_settings_locations.sql` (OPUS-M3-007) ───────────
   *
   * Registered in the SAME change as the migration that creates it (packet 30
   * §7.2, whose rule exists because 0003's four tenant tables were left out of
   * this registry and stayed unprobed until OPUS-M1-004 noticed). This is the
   * sweep floor this packet raises, and raising it is only meaningful if the
   * table is observed NON-vacuously.
   *
   * `organization-and-group`: both tenant columns, V-09's conjunctive group
   * predicate, and no organization-scoped policy at all — location
   * administration is not in SPEC-06 §1.1's organization-scoped enumeration, so
   * an organization-scoped context sees zero location rows.
   *
   * Non-vacuity is established by **`apps/api/test/support/settings.ts::
   * seedLocationsForSweep`**, called from the files that sweep this registry
   * (`test/sbx/sbx.test.ts`, `test/tenancy/unit-of-work.test.ts`,
   * `test/red-cases/probe-is-not-vacuous.test.ts`). It writes locations into
   * BOTH of Alpha's groups AND into Beta through the production write path, so
   * the cross-GROUP arm has rows it could see if the group predicate were
   * broken — not only the cross-organization arm. That is the M2-002 review's
   * blocking finding applied in advance rather than rediscovered.
   *
   * NOT `provisionMulti`: `test/support/multi.ts` is the single fixture owner
   * and packet 32 §10a gives this packet `test/support/settings.ts` alone, so
   * the seeding reaches the same fixture without editing the shared script —
   * exactly as OPUS-M3-002 did for `rules`. */
  { name: 'locations', scope: 'organization-and-group' },

  /* ── `migrations/0012_staffing_input_integrity.sql` (OPUS-M4-000A) ──────────
   *
   * Registered in the SAME change as the migration that creates it (packet 30
   * §7.2's rule, still binding). `organization-and-group`: both tenant columns,
   * V-09's conjunctive group predicate, no organization-scoped policy. Its
   * non-vacuity in the sweeps is established by `provisionMulti`'s catalogue
   * seeding: the demand writes it already performs fire the bump trigger,
   * which upserts a counter row through the production mechanism. */
  { name: 'staffing_set_versions', scope: 'organization-and-group' },

  /* ── `migrations/0015_rule_revisions_and_period_lifecycle.sql` (OPUS-M4-000C)
   *
   * Registered in the SAME change as the migration that creates it (packet 30
   * §7.2's rule, still binding). `organization-and-group`: both tenant columns
   * and V-09's conjunctive group predicate, with no organization-scoped policy —
   * a rule belongs to a group and so does its history.
   *
   * Non-vacuity in the sweeps is established by
   * `apps/api/test/support/rules.ts::seedRulesForSweep`, which every sweeping
   * file already calls: writing a rule fires `rules_zz_record_revision`, so a
   * revision row exists in each swept group through the production mechanism.
   * Nothing seeds this table directly, and nothing should — a revision the
   * fixture could write is a revision the application could forge. */
  { name: 'rule_revisions', scope: 'organization-and-group' },

  /* ── `migrations/0016_solver_input_snapshots.sql` (OPUS-M4-001) ─────────────
   *
   * Registered in the SAME change as the migration that creates it (packet 30
   * §7.2's rule, still binding). `organization-and-group`, and emphatically so:
   * a snapshot is a description of one group's entire staffing position for one
   * period, which makes it the single most consequential row in this schema to
   * leak. It carries both tenant columns and V-09's conjunctive group predicate,
   * with no organization-scoped policy.
   *
   * Non-vacuity in the sweeps is established by
   * `apps/api/test/support/solver.ts::seedSolverSnapshotsForSweep`, which
   * assembles and persists a snapshot in each swept group **through the
   * production path** — the same discipline `seedRulesForSweep` follows, and for
   * the same reason: a snapshot the fixture could write directly is a snapshot
   * the application could forge. */
  { name: 'solver_input_snapshots', scope: 'organization-and-group' },

  /* ── `migrations/0018_build_lifecycle.sql` (OPUS-M4-003) ────────────────────
   *
   * Six tables, registered in the SAME change as the migration that creates
   * them. All `organization-and-group` with V-09's conjunctive group predicate:
   * a build is a proposal about ONE group's period, and every one of these rows
   * — the configuration, the run, its timeline, its result, its violations, and
   * the candidate assignments themselves — names participants of that group.
   * There is no organization-scoped policy on any of them, and there is no
   * reading in which one would be correct.
   *
   * The sweep floor rises from 48 to 54. Non-vacuity is established by
   * `apps/api/test/support/builds.ts::seedBuildLifecycleForSweep`, which drives
   * a whole build — configure, submit, claim, record a result, review — in each
   * swept group **through the production service**, so every one of the six
   * tables has a row that the application really wrote. A row a fixture could
   * insert directly is a row the application could forge; the same discipline
   * `seedRulesForSweep` and `seedSolverSnapshotsForSweep` follow. */
  { name: 'build_configurations', scope: 'organization-and-group' },
  { name: 'build_runs', scope: 'organization-and-group' },
  { name: 'build_run_events', scope: 'organization-and-group' },
  { name: 'build_run_results', scope: 'organization-and-group' },
  { name: 'build_run_violations', scope: 'organization-and-group' },
  { name: 'build_run_candidate_assignments', scope: 'organization-and-group' },

  /* ── `migrations/0021_request_aggregate_and_subtypes.sql` and
   *    `migrations/0022_vacation_lifecycle_carriers.sql` (OPUS-M5-000b) ───────
   *
   * Ten tables, registered in the SAME change as the migrations that create them
   * (packet 30 §7.2's rule, still binding — it exists because migration 0003's
   * four tenant tables were left out of this registry and stayed unprobed until
   * OPUS-M1-004 noticed).
   *
   * All `organization-and-group` with V-09's conjunctive group predicate, and
   * there is no reading in which an organization-scoped policy would be correct
   * for any of them: a request is one member's request against ONE group's
   * schedule, and a vacation period, grant and selection are all statements
   * about one group's round.
   *
   * The sweep floor rises from 54 to 64. Non-vacuity is established by
   * `apps/api/test/support/requests.ts::seedRequestsForSweep`, which writes one
   * row into each of the ten tables in each swept group, through the unit of
   * work under real tenant context — the same discipline `seedRulesForSweep`,
   * `seedSolverSnapshotsForSweep` and `seedBuildLifecycleForSweep` follow.
   *
   * **The one honest difference from those three, stated rather than glossed:**
   * they drive a production SERVICE, and this one cannot, because doc 42 §5b
   * ships no service — the request and vacation transactions are M5-001 through
   * M5-004. The seed therefore writes through the unit of work and the typed
   * query builder, under `set_config(name, value, true)` tenant context, meeting
   * every constraint and trigger the migrations declare. That is the production
   * DATA path without a production CALLER, and when M5-001's service lands, this
   * helper should be rewritten onto it for the reason the other three give: a
   * row a fixture can write directly is a row the application could forge.
   *
   * `SENSITIVE-PII` on `requests` and the five subtype tables: doc 06 §3.4
   * classifies them so, and the `qualification_holdings` narrowing has NOT been
   * applied — it needs capability keys that do not exist yet, and M5-001 owes it.
   * See `migrations/0021_request_aggregate_and_subtypes.sql` §5 for the record. */
  { name: 'requests', scope: 'organization-and-group' },
  { name: 'request_availability', scope: 'organization-and-group' },
  { name: 'request_time_off', scope: 'organization-and-group' },
  { name: 'request_no_call', scope: 'organization-and-group' },
  { name: 'request_shift_preference', scope: 'organization-and-group' },
  { name: 'request_shift_group_off', scope: 'organization-and-group' },
  { name: 'vacation_periods', scope: 'organization-and-group' },
  { name: 'vacation_grants', scope: 'organization-and-group' },
  { name: 'vacation_selections', scope: 'organization-and-group' },
  { name: 'vacation_approval_commands', scope: 'organization-and-group' },
] as const;
