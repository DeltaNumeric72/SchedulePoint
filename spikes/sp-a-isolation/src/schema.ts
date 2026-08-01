import type { Generated } from 'kysely';

export interface OrganizationsTable {
  id: string;
  name: string;
  active: Generated<boolean>;
}

export interface GroupsTable {
  id: string;
  organization_id: string;
  name: string;
}

export interface ThingsTable {
  id: string;
  organization_id: string;
  group_id: string;
  name: string;
  created_at: Generated<Date>;
}

export interface ThingNotesTable {
  id: string;
  organization_id: string;
  group_id: string;
  thing_id: string;
  body: string;
}

export interface ScheduleVersionsTable {
  id: string;
  organization_id: string;
  group_id: string;
  version: number;
  status: 'draft' | 'published';
  label: string;
}

export interface AssignmentsTable {
  id: string;
  organization_id: string;
  group_id: string;
  membership_id: string;
  schedule_version_id: string;
  during: string;
}

export interface PicklistTurnsTable {
  id: string;
  organization_id: string;
  group_id: string;
  turn_id: string;
  membership_id: string;
  status: 'offered' | 'declined' | 'accepted' | 'expired';
}

export interface DB {
  organizations: OrganizationsTable;
  groups: GroupsTable;
  things: ThingsTable;
  thing_notes_naive: ThingNotesTable;
  thing_notes_scoped: ThingNotesTable;
  schedule_versions: ScheduleVersionsTable;
  assignments: AssignmentsTable;
  picklist_turns: PicklistTurnsTable;
}
