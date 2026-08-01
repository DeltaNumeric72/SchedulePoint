-- Red fixture: RLS statements are present in the file, but for a table this
-- migration did not create. A "does the file mention RLS" check passes this.
CREATE TABLE shift (
    id              uuid PRIMARY KEY,
    organization_id uuid NOT NULL
);

ALTER TABLE assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignment FORCE ROW LEVEL SECURITY;
CREATE POLICY assignment_tenant ON assignment USING (true);
