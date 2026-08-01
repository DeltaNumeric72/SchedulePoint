-- SPEC-01 §4.3 / §4.4 — tenant schema, RLS predicates, role grants.
--
-- Every tenant-scoped table below:
--   * ENABLE ROW LEVEL SECURITY   (policies apply)
--   * FORCE ROW LEVEL SECURITY    (policies apply to the table OWNER too — app_migrator)
--   * carries the organization predicate, and, where the table carries group_id,
--     the CONJUNCTIVE group predicate required by SPEC-01 §4.3 as amended (V-09).
--
-- NOTE ON `nullif(...)`: `set_config(name, NULL, true)` stores the EMPTY STRING,
-- not NULL. `''::uuid` raises 22P02 rather than yielding NULL, which would turn a
-- fail-closed predicate into a runtime error (and, under some plans, into an error
-- that leaks nothing but also stops the fail-closed SELECT from returning 0 rows
-- cleanly). `nullif(current_setting(...), '')::uuid` yields NULL in both the
-- never-set and the set-to-null cases, so the predicate is uniformly false.

-- Up Migration

------------------------------------------------------------------------------
-- Organization-scoped tables
------------------------------------------------------------------------------

CREATE TABLE organizations (
    id    uuid PRIMARY KEY,
    name  text NOT NULL,
    active boolean NOT NULL DEFAULT true
);

CREATE TABLE groups (
    id               uuid PRIMARY KEY,
    organization_id  uuid NOT NULL REFERENCES organizations (id),
    name             text NOT NULL
);

------------------------------------------------------------------------------
-- Group-scoped tenant table
------------------------------------------------------------------------------

CREATE TABLE things (
    id               uuid PRIMARY KEY,
    organization_id  uuid NOT NULL,
    group_id         uuid NOT NULL,
    name             text NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    -- Unique on the tenant-qualified identity so that a COMPOSITE foreign key
    -- can be declared against it (see thing_notes_scoped below).
    CONSTRAINT things_tenant_identity UNIQUE (id, organization_id, group_id)
);

------------------------------------------------------------------------------
-- Two child tables that differ ONLY in how their foreign key is declared.
-- They exist to demonstrate a sharp edge: PostgreSQL referential-integrity
-- checks are NOT subject to RLS (SPEC-01 §4.5, S-03). A single-column FK to a
-- tenant table therefore succeeds against a row the caller cannot see.
------------------------------------------------------------------------------

-- Naive: FK on thing_id alone. RLS on this table only checks THIS row's tenant
-- columns, so a row here can legally point at another tenant's thing.
CREATE TABLE thing_notes_naive (
    id               uuid PRIMARY KEY,
    organization_id  uuid NOT NULL,
    group_id         uuid NOT NULL,
    thing_id         uuid NOT NULL REFERENCES things (id),
    body             text NOT NULL
);

-- Scoped: composite FK. The reference itself carries the tenant columns, so a
-- cross-tenant reference is structurally impossible regardless of RLS.
CREATE TABLE thing_notes_scoped (
    id               uuid PRIMARY KEY,
    organization_id  uuid NOT NULL,
    group_id         uuid NOT NULL,
    thing_id         uuid NOT NULL,
    body             text NOT NULL,
    CONSTRAINT thing_notes_scoped_thing_fk
        FOREIGN KEY (thing_id, organization_id, group_id)
        REFERENCES things (id, organization_id, group_id)
);

------------------------------------------------------------------------------
-- Row level security
------------------------------------------------------------------------------

ALTER TABLE organizations       ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations       FORCE  ROW LEVEL SECURITY;
ALTER TABLE groups              ENABLE ROW LEVEL SECURITY;
ALTER TABLE groups              FORCE  ROW LEVEL SECURITY;
ALTER TABLE things              ENABLE ROW LEVEL SECURITY;
ALTER TABLE things              FORCE  ROW LEVEL SECURITY;
ALTER TABLE thing_notes_naive   ENABLE ROW LEVEL SECURITY;
ALTER TABLE thing_notes_naive   FORCE  ROW LEVEL SECURITY;
ALTER TABLE thing_notes_scoped  ENABLE ROW LEVEL SECURITY;
ALTER TABLE thing_notes_scoped  FORCE  ROW LEVEL SECURITY;

-- organizations: organization predicate only (the table has no group_id).
CREATE POLICY organizations_tenant ON organizations
    USING      (id = nullif(current_setting('app.organization_id', true), '')::uuid)
    WITH CHECK (id = nullif(current_setting('app.organization_id', true), '')::uuid);

-- groups: organization predicate only, and no group predicate.
--
-- SPIKE-ONLY, AND DELIBERATELY BROADER THAN EX-2. SPEC-01 §4.3's exception
-- EX-2 permits `SELECT` on `groups` *only* under an organization-scoped
-- context (`app.group_id IS NULL`) held by a membership carrying an
-- organization role. This policy implements NONE of those three gates: it
-- allows all of SELECT/INSERT/UPDATE/DELETE (and the grants below match), it
-- applies under group-scoped contexts too, and it tests no capability.
--
-- That is adequate for a spike whose subject is the transaction-local context
-- mechanism, and inadequate as a model of EX-2. Production MUST implement EX-2
-- as specified: a SELECT-only policy, gated on `app.group_id IS NULL` and on
-- the organization-administration capability from SPEC-06 §3.
CREATE POLICY groups_tenant ON groups
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

-- things: CONJUNCTIVE organization AND group predicate (SPEC-01 §4.3, V-09).
CREATE POLICY things_tenant ON things
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND group_id        = nullif(current_setting('app.group_id',        true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND group_id        = nullif(current_setting('app.group_id',        true), '')::uuid);

CREATE POLICY thing_notes_naive_tenant ON thing_notes_naive
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND group_id        = nullif(current_setting('app.group_id',        true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND group_id        = nullif(current_setting('app.group_id',        true), '')::uuid);

CREATE POLICY thing_notes_scoped_tenant ON thing_notes_scoped
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND group_id        = nullif(current_setting('app.group_id',        true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND group_id        = nullif(current_setting('app.group_id',        true), '')::uuid);

------------------------------------------------------------------------------
-- Grants (SPEC-01 §4.4). TRUNCATE and REFERENCES are deliberately withheld from
-- every runtime role: neither is subject to RLS (S-03), so the only control is
-- the grant.
------------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO app_runtime, app_worker, app_readonly_support, app_breakglass;

GRANT SELECT, INSERT, UPDATE, DELETE
    ON organizations, groups, things, thing_notes_naive, thing_notes_scoped
    TO app_runtime, app_worker;

GRANT SELECT
    ON organizations, groups, things, thing_notes_naive, thing_notes_scoped
    TO app_readonly_support, app_breakglass;

-- Down Migration

DROP POLICY IF EXISTS thing_notes_scoped_tenant ON thing_notes_scoped;
DROP POLICY IF EXISTS thing_notes_naive_tenant  ON thing_notes_naive;
DROP POLICY IF EXISTS things_tenant             ON things;
DROP POLICY IF EXISTS groups_tenant             ON groups;
DROP POLICY IF EXISTS organizations_tenant      ON organizations;

DROP TABLE IF EXISTS thing_notes_scoped;
DROP TABLE IF EXISTS thing_notes_naive;
DROP TABLE IF EXISTS things;
DROP TABLE IF EXISTS groups;
DROP TABLE IF EXISTS organizations;
