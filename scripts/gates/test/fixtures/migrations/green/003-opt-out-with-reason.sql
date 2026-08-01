-- Green fixture: a genuinely non-tenant table. The opt-out is explicit and
-- carries a reason, so it shows up in the diff and can be argued with.
-- rls: not-tenant-scoped (global country reference data, identical for every organization)
CREATE TABLE country (
    iso_code char(2) PRIMARY KEY,
    name     text NOT NULL
);
