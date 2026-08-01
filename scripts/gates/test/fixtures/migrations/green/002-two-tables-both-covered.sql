-- Green fixture: more than one table in a file; every one of them covered.
CREATE TABLE IF NOT EXISTS assignment (
    id              uuid PRIMARY KEY,
    organization_id uuid NOT NULL
);
CREATE TABLE assignment_note (
    id              uuid PRIMARY KEY,
    organization_id uuid NOT NULL
);

ALTER TABLE assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignment FORCE ROW LEVEL SECURITY;
CREATE POLICY assignment_tenant ON assignment
    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

ALTER TABLE assignment_note ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignment_note FORCE ROW LEVEL SECURITY;
CREATE POLICY assignment_note_tenant ON assignment_note
    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
