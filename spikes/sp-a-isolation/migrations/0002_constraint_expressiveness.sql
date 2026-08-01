-- SP-2 / TDG-02 — constraint expressiveness in plain-SQL migrations.
--
-- Three forms are required by SPEC-15 SP-2 (for SPEC-05 publication and SPEC-02
-- picklist turns):
--   1. an EXCLUSION CONSTRAINT (no overlapping tstzrange per membership+version)
--   2. a PARTIAL UNIQUE INDEX  (at most one accepted holder per turn)
--   3. a BEFORE UPDATE TRIGGER (a published schedule version is immutable)
-- `FOR UPDATE` needs no DDL; it is exercised by the harness against
-- schedule_versions.

-- Up Migration

-- btree_gist supplies the `=` operator to GiST so that scalar equality columns
-- can participate in an exclusion constraint alongside a range `&&`.
-- It is a TRUSTED extension from PostgreSQL 13 onwards, so the (non-superuser)
-- database owner app_migrator can install it.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE schedule_versions (
    id               uuid PRIMARY KEY,
    organization_id  uuid NOT NULL,
    group_id         uuid NOT NULL,
    version          integer NOT NULL,
    status           text NOT NULL CHECK (status IN ('draft', 'published')),
    label            text NOT NULL,
    CONSTRAINT schedule_versions_unique_version UNIQUE (group_id, version)
);

CREATE TABLE assignments (
    id                   uuid PRIMARY KEY,
    organization_id      uuid NOT NULL,
    group_id             uuid NOT NULL,
    membership_id        uuid NOT NULL,
    schedule_version_id  uuid NOT NULL,
    during               tstzrange NOT NULL,
    -- (1) EXCLUSION CONSTRAINT: within one group and one schedule version, one
    -- membership may not hold two overlapping assignments.
    CONSTRAINT assignments_no_overlap EXCLUDE USING gist (
        group_id            WITH =,
        schedule_version_id WITH =,
        membership_id       WITH =,
        during              WITH &&
    )
);

CREATE TABLE picklist_turns (
    id               uuid PRIMARY KEY,
    organization_id  uuid NOT NULL,
    group_id         uuid NOT NULL,
    turn_id          uuid NOT NULL,
    membership_id    uuid NOT NULL,
    status           text NOT NULL
        CHECK (status IN ('offered', 'declined', 'accepted', 'expired'))
);

-- (2) PARTIAL UNIQUE INDEX: at most one 'accepted' row per turn_id. Any number
-- of offered/declined/expired rows are permitted.
CREATE UNIQUE INDEX picklist_turns_one_accepted
    ON picklist_turns (turn_id)
    WHERE status = 'accepted';

-- (3) BEFORE UPDATE TRIGGER: a published schedule version is immutable.
CREATE FUNCTION reject_published_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION
        'schedule_version % is published and is immutable', OLD.id
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER schedule_versions_published_is_immutable
    BEFORE UPDATE ON schedule_versions
    FOR EACH ROW
    WHEN (OLD.status = 'published')
    EXECUTE FUNCTION reject_published_mutation();

------------------------------------------------------------------------------
-- RLS for the three new tables (same conjunctive predicate as 0001)
------------------------------------------------------------------------------

ALTER TABLE schedule_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_versions FORCE  ROW LEVEL SECURITY;
ALTER TABLE assignments       ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignments       FORCE  ROW LEVEL SECURITY;
ALTER TABLE picklist_turns    ENABLE ROW LEVEL SECURITY;
ALTER TABLE picklist_turns    FORCE  ROW LEVEL SECURITY;

CREATE POLICY schedule_versions_tenant ON schedule_versions
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND group_id        = nullif(current_setting('app.group_id',        true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND group_id        = nullif(current_setting('app.group_id',        true), '')::uuid);

CREATE POLICY assignments_tenant ON assignments
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND group_id        = nullif(current_setting('app.group_id',        true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND group_id        = nullif(current_setting('app.group_id',        true), '')::uuid);

CREATE POLICY picklist_turns_tenant ON picklist_turns
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND group_id        = nullif(current_setting('app.group_id',        true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND group_id        = nullif(current_setting('app.group_id',        true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE
    ON schedule_versions, assignments, picklist_turns
    TO app_runtime, app_worker;

GRANT SELECT
    ON schedule_versions, assignments, picklist_turns
    TO app_readonly_support, app_breakglass;

-- Down Migration

DROP POLICY IF EXISTS picklist_turns_tenant    ON picklist_turns;
DROP POLICY IF EXISTS assignments_tenant       ON assignments;
DROP POLICY IF EXISTS schedule_versions_tenant ON schedule_versions;

DROP TRIGGER IF EXISTS schedule_versions_published_is_immutable ON schedule_versions;
DROP FUNCTION IF EXISTS reject_published_mutation();

DROP INDEX IF EXISTS picklist_turns_one_accepted;

DROP TABLE IF EXISTS picklist_turns;
DROP TABLE IF EXISTS assignments;
DROP TABLE IF EXISTS schedule_versions;

DROP EXTENSION IF EXISTS btree_gist;
