-- Red fixture: the plain failure. A tenant table with no RLS whatsoever.
CREATE TABLE shift (
    id              uuid PRIMARY KEY,
    organization_id uuid NOT NULL
);
