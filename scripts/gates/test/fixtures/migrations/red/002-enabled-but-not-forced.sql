-- Red fixture: the subtle failure. ENABLE without FORCE means the table owner
-- bypasses the policy — and migrations run as the owner.
CREATE TABLE shift (
    id              uuid PRIMARY KEY,
    organization_id uuid NOT NULL
);

ALTER TABLE shift ENABLE ROW LEVEL SECURITY;

CREATE POLICY shift_tenant ON shift
    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
