-- Red fixture: an opt-out marker with an empty reason. The escape hatch must
-- cost something, or it becomes the default.
-- rls: not-tenant-scoped ()
CREATE TABLE country (
    iso_code char(2) PRIMARY KEY
);
