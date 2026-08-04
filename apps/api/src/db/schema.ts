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
export type CatalogueDayColumn =
  | 'mon'
  | 'tue'
  | 'wed'
  | 'thu'
  | 'fri'
  | 'sat'
  | 'sun'
  | 'holiday';

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
] as const;
