-- RED CASE — migration + RLS pairing.
--
-- A tenant table created with no row-level-security policy. The gate must fail
-- (I-15: without a policy every tenant table is readable across organizations).
CREATE TABLE red_case_shift (
    id              uuid PRIMARY KEY,
    organization_id uuid NOT NULL,
    starts_at       timestamptz NOT NULL
);
