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

export interface Database {
  organizations: OrganizationsTable;
  groups: GroupsTable;
  users: UsersTable;
  memberships: MembershipsTable;
}

/**
 * Every tenant-scoped table, and how its RLS predicate is scoped.
 *
 * SPEC-01 §7.2's preamble requires the concurrency harness to run "against every
 * tenant table". This registry is what makes that literal rather than
 * aspirational: the T-13 fail-closed probe, the T-15 storm probe, the
 * (role, table) privilege check and the final census all iterate it, so adding a
 * tenant table without adding it here fails the coverage assertion.
 */
export type TenantScope =
  /** The row IS the tenant: predicate is `id = app.organization_id`. */
  | 'organization-identity'
  /** Carries `organization_id`; group predicate applies when a group context is in force. */
  | 'organization-and-group'
  /** No tenant column; reachable only through a membership visible in context. */
  | 'through-membership';

export interface TenantTable {
  readonly name: keyof Database & string;
  readonly scope: TenantScope;
}

export const TENANT_TABLES: readonly TenantTable[] = [
  { name: 'organizations', scope: 'organization-identity' },
  { name: 'groups', scope: 'organization-and-group' },
  { name: 'users', scope: 'through-membership' },
  { name: 'memberships', scope: 'organization-and-group' },
] as const;
