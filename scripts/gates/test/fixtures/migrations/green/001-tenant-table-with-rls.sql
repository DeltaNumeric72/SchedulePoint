-- Green fixture: the correct shape. Table, RLS enabled, RLS forced, policy —
-- all in ONE file, per SPEC-01 §4.
CREATE TABLE shift (
    id              uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    starts_at       timestamptz NOT NULL
);

ALTER TABLE shift ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift FORCE ROW LEVEL SECURITY;

CREATE POLICY shift_tenant_isolation ON shift
    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
