-- OPUS-M4-000C — rule revisioning, period lifecycle, publication idempotency
-- binding (doc 34 §4-D and §4-G; doc 35 §5, migration number amended to 0015 by
-- FAD-30).
--
-- ADDITIVE. 0001..0014 are applied and are never edited. This file creates one
-- table, adds two columns to an existing append-only table, adds triggers to
-- existing tables, and replaces no policy. No grant is revoked, no constraint is
-- relaxed, no stable ID is removed or renumbered.
--
-- Four changes, each traced to a packet clause:
--
--   1. `rule_revisions` — an APPEND-ONLY row per rule mutation carrying the full
--      serialized AST, so a build or publication can name the exact revision it
--      consumed and that revision can be reconstructed byte-identically later
--      (clause D: "immutable rule_revisions … historical revisions are
--      reconstructable byte-identically"). Written by a trigger, not by the
--      application: a revision the application could forget to write is a
--      revision history nobody can trust.
--
--   2. Period LIFECYCLE (clause G): a `closed` period refuses new versions and
--      new requirements at the DATABASE, and the status transition itself is
--      restricted to the legal moves and gated on `schedule.period.administer`.
--      Until now `schedule_periods.status` was a column nothing enforced.
--
--   3. Publication idempotency bound to OPERATION TYPE and SEMANTIC REQUEST
--      (clause G): `publication_records` gains `operation_type` and
--      `semantic_request_digest`, so a replayed key that names a different
--      operation, or the same operation with different parameters, is an
--      explicit refusal instead of a replay that answers about something else.
--
--   4. `rules.version` is REPURPOSED AS THE REVISION NUMBER — no DDL, stated
--      here because it is a semantic commitment. 0008 already created a
--      database-owned monotonic counter maintained by
--      `app_maintain_catalogue_version`; clause D asks for "the current row's
--      revision is the CAS token", and minting a second counter beside an
--      existing one is how two answers to the same question appear. The
--      revision row records `rules.version` as `revision`.
--
-- ## Why the revision row is written by a trigger and not by the service
--
-- Clause D requires the revision to be "written in the same unit of work as the
-- mutation". A trigger satisfies that by construction — it runs inside the
-- statement — and satisfies something the service cannot: it also covers the
-- statement a future writer issues without knowing the rule exists. The 0012
-- precedent (`app_bump_staffing_set_version`, SECURITY DEFINER, no runtime
-- INSERT grant on the counter table) is followed exactly, so the application can
-- neither forge a revision nor skip one.
--
-- Normative sources:
--   doc 35 §5 (OPUS-M4-000C)  — the packet; its Required behaviour governs
--   doc 34 §4-D / §4-G        — the prerequisite register rows this closes
--   SPEC-04 §3                — the typed rule model and its schema version
--   SPEC-05 §6                — the publication transaction and D-17 idempotency
--   migration 0008            — `rules`, its version counter, its guards
--   migration 0009            — `schedule_periods`, `publication_records`, D-15d
--   migration 0012            — the SECURITY DEFINER counter/writer precedent

-- Up Migration

------------------------------------------------------------------------------
-- 1. rule_revisions — the immutable history of every rule mutation.
--
-- ## What one row is
--
-- The COMPLETE authored state of one rule at one revision: the full serialized
-- AST (`scope` and `predicate` as stored), the schema version it was authored
-- under, its classification, weight, category and status. Not a diff. A diff
-- history is reconstructable only by replaying every earlier row correctly, and
-- "correctly" is a property of code that will change; a full row is
-- reconstructable by reading it.
--
-- ## Byte-identity
--
-- `scope` and `predicate` are copied from `rules` as `jsonb`, which is how they
-- are stored there. PostgreSQL normalises jsonb key order and whitespace on the
-- way in, and `canonicalStringify` normalises the same things in the
-- application, so `canonicalStringify(revision.predicate)` equals the bytes that
-- were authored — the same property `apps/api/test/rules/round-trip.test.ts`
-- proves for the live row, now proven for history.
--
-- ## Append-only, and the grants that make it so
--
-- No runtime role holds INSERT, UPDATE or DELETE. The rows arrive through
-- `app_record_rule_revision` (SECURITY DEFINER), and `app_guard_append_only`
-- (0009) refuses UPDATE and DELETE for the OWNER as well. A revision that could
-- be edited is not a revision.
------------------------------------------------------------------------------

CREATE TABLE rule_revisions (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id      uuid NOT NULL REFERENCES organizations (id),
    group_id             uuid NOT NULL,
    rule_id              uuid NOT NULL,
    -- The STABLE identifier travels with the revision (non-bypass rule 13), so a
    -- build's citation reads `rule_key@revision` and does not depend on the
    -- surrogate id remaining resolvable.
    rule_key             text NOT NULL,
    revision             integer NOT NULL CHECK (revision > 0),
    rule_schema_version  integer NOT NULL CHECK (rule_schema_version > 0),
    name                 text NOT NULL,
    classification       text NOT NULL CHECK (classification IN ('HARD', 'SOFT')),
    weight               numeric(12, 4),
    category             text NOT NULL CHECK (category IN ('general', 'pattern', 'staff')),
    scope                jsonb NOT NULL CHECK (jsonb_typeof(scope) = 'object'),
    predicate            jsonb NOT NULL CHECK (jsonb_typeof(predicate) = 'object'),
    status               text NOT NULL CHECK (status IN ('active', 'disabled', 'archived')),
    -- The acting membership at the moment of the mutation, from the
    -- transaction-local context. NULL for a system actor.
    recorded_by          uuid,
    recorded_at          timestamptz NOT NULL DEFAULT now(),

    -- The hard/soft discipline holds in history too: a stored revision that
    -- weighted a HARD rule would be a historical record of something the live
    -- table refuses (SPEC-04 §3.3).
    CONSTRAINT rule_revisions_hard_soft_weight CHECK (
        (classification = 'HARD' AND weight IS NULL)
     OR (classification = 'SOFT' AND weight IS NOT NULL AND weight > 0)
    ),

    CONSTRAINT rule_revisions_unique UNIQUE (organization_id, group_id, rule_id, revision),
    CONSTRAINT rule_revisions_tenant_identity UNIQUE (id, organization_id, group_id),
    CONSTRAINT rule_revisions_rule_fk
        FOREIGN KEY (rule_id, organization_id, group_id)
        REFERENCES rules (id, organization_id, group_id),
    CONSTRAINT rule_revisions_actor_fk
        FOREIGN KEY (recorded_by, organization_id)
        REFERENCES memberships (id, organization_id),
    CONSTRAINT rule_revisions_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id)
);

ALTER TABLE rule_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rule_revisions FORCE  ROW LEVEL SECURITY;

-- V-09's conjunctive group predicate, written out in full like every sibling.
CREATE POLICY rule_revisions_group_scope ON rule_revisions
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE INDEX rule_revisions_by_rule
    ON rule_revisions (organization_id, group_id, rule_key, revision DESC);

------------------------------------------------------------------------------
-- 1a. The writer.
--
-- AFTER INSERT OR UPDATE on `rules`, so `rules_maintain_version` (a BEFORE
-- trigger) has already moved `NEW.version` and this records the value the row
-- actually carries. Firing order is by name, and `rules_zz_record_revision`
-- sorts after both `rules_guard_*` and `rules_maintain_version` — deliberately,
-- so an unauthorized or refused write never leaves a revision behind.
--
-- ON CONFLICT DO NOTHING: an UPDATE that somehow reproduced an existing
-- (rule, revision) pair is a contradiction the unique constraint would raise on,
-- and raising there would abort a legitimate rule mutation for a bookkeeping
-- reason. The pair cannot repeat while `app_maintain_catalogue_version` is
-- attached (it increments unconditionally, including for a no-op UPDATE), so
-- this arm is unreachable in practice and exists so that it fails safe rather
-- than loudly if that ever stops being true.
------------------------------------------------------------------------------

CREATE FUNCTION app_record_rule_revision() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    INSERT INTO rule_revisions (
        organization_id, group_id, rule_id, rule_key, revision, rule_schema_version,
        name, classification, weight, category, scope, predicate, status, recorded_by
    )
    VALUES (
        NEW.organization_id, NEW.group_id, NEW.id, NEW.rule_key, NEW.version,
        NEW.rule_schema_version, NEW.name, NEW.classification, NEW.weight, NEW.category,
        NEW.scope, NEW.predicate, NEW.status,
        nullif(current_setting('app.membership_id', true), '')::uuid
    )
    ON CONFLICT (organization_id, group_id, rule_id, revision) DO NOTHING;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION app_record_rule_revision() FROM PUBLIC;

CREATE TRIGGER rules_zz_record_revision
    AFTER INSERT OR UPDATE ON rules
    FOR EACH ROW EXECUTE FUNCTION app_record_rule_revision();

-- D-15d's discipline, reusing 0009's guard rather than declaring a second one.
CREATE TRIGGER rule_revisions_append_only
    BEFORE UPDATE OR DELETE ON rule_revisions
    FOR EACH ROW EXECUTE FUNCTION app_guard_append_only();

------------------------------------------------------------------------------
-- 2. Period lifecycle (clause G).
--
-- `schedule_periods.status` has existed since 0009 with a three-value domain and
-- NOTHING enforcing it: a `closed` period accepted new versions, new
-- requirements and new publications exactly as an open one did, and the status
-- could be moved anywhere by anybody who could UPDATE the row.
--
-- Two guards close that.
--
-- ## 2a. A closed period refuses new children
--
-- INSERT only. An existing draft in a period that is then closed keeps existing
-- — closing a period is a statement about what may be STARTED in it, not a
-- retroactive deletion — and a published version in a closed period is exactly
-- what a closed period is supposed to contain.
--
-- The publication transaction is refused by the same rule from a different
-- angle: it moves a version to `published`, and a version can only exist in the
-- period if it was created before the close. §2c adds the direct refusal so the
-- answer does not depend on that reasoning holding forever.
------------------------------------------------------------------------------

CREATE FUNCTION app_guard_period_not_closed() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_status text;
BEGIN
    SELECT p.status INTO v_status
      FROM schedule_periods p
     WHERE p.id = NEW.period_id;

    IF v_status = 'closed' THEN
        RAISE EXCEPTION
            'PERIOD_CLOSED: schedule period % is closed; it accepts no new %. Reopen the period '
            'through the explicit audited transition first',
            NEW.period_id, TG_TABLE_NAME
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_guard_period_not_closed() FROM PUBLIC;

CREATE TRIGGER schedule_versions_guard_period_closed
    BEFORE INSERT ON schedule_versions
    FOR EACH ROW EXECUTE FUNCTION app_guard_period_not_closed();

CREATE TRIGGER schedule_requirements_guard_period_closed
    BEFORE INSERT ON schedule_requirements
    FOR EACH ROW EXECUTE FUNCTION app_guard_period_not_closed();

------------------------------------------------------------------------------
-- 2b. The status transition itself is legal, and gated.
--
-- Legal moves:
--
--     planning  -> published    the period has a current published version
--     planning  -> closed       nothing was ever published in it
--     published -> closed       the ordinary end of a period
--     closed    -> planning     THE EXPLICIT AUDITED REOPEN
--
-- `closed -> published` is deliberately absent: a reopen is a decision, and
-- routing it through `planning` means the reopen and the republication are two
-- recorded acts rather than one silent one.
--
-- Every status change requires `schedule.period.administer` — the same
-- capability `SCHEDULE_ACTIONS.periodAdminister` names, spelled per the database
-- convention 0004/0008 established. No capability is created, widened or
-- narrowed (non-bypass rule 11).
------------------------------------------------------------------------------

CREATE FUNCTION app_guard_period_status_transition() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
    END IF;

    IF NOT (
        (OLD.status = 'planning'  AND NEW.status IN ('published', 'closed'))
     OR (OLD.status = 'published' AND NEW.status = 'closed')
     OR (OLD.status = 'closed'    AND NEW.status = 'planning')
    ) THEN
        RAISE EXCEPTION
            'PERIOD_TRANSITION_ILLEGAL: a schedule period does not move from % to %',
            OLD.status, NEW.status
            USING ERRCODE = 'restrict_violation';
    END IF;

    PERFORM app_require_capability('schedule.period.administer', NEW.organization_id);
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_guard_period_status_transition() FROM PUBLIC;

CREATE TRIGGER schedule_periods_guard_status_transition
    BEFORE UPDATE ON schedule_periods
    FOR EACH ROW EXECUTE FUNCTION app_guard_period_status_transition();

------------------------------------------------------------------------------
-- 2c. A closed period refuses a PUBLICATION, directly.
--
-- §2a refuses new versions, which makes publishing into a closed period
-- unreachable by the ordinary route. This refuses the act itself, so the
-- property does not depend on that reasoning: a version already in the period
-- when it closed cannot be walked to `published` afterwards either.
--
-- Scoped to the ONE transition that matters. Everything else a draft does inside
-- a closed period (cancelling, editing, being superseded by the publication
-- transaction's own supersession step) is untouched: closing a period must not
-- freeze the ordinary lifecycle of what is already in it, only stop new
-- authoritative schedule from being declared.
------------------------------------------------------------------------------

CREATE FUNCTION app_guard_publish_into_closed_period() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_status text;
BEGIN
    IF NEW.state <> 'published' OR OLD.state = 'published' THEN
        RETURN NEW;
    END IF;

    SELECT p.status INTO v_status
      FROM schedule_periods p
     WHERE p.id = NEW.period_id;

    IF v_status = 'closed' THEN
        RAISE EXCEPTION
            'PERIOD_CLOSED: schedule period % is closed; a version in it cannot be published. '
            'Reopen the period through the explicit audited transition first',
            NEW.period_id
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_guard_publish_into_closed_period() FROM PUBLIC;

-- `_guard_` sorts before D-15's `schedule_versions_*` maintenance triggers by
-- the same naming convention 0008 relies on, so the refusal happens before any
-- counter moves.
CREATE TRIGGER schedule_versions_guard_publish_closed_period
    BEFORE UPDATE ON schedule_versions
    FOR EACH ROW EXECUTE FUNCTION app_guard_publish_into_closed_period();

------------------------------------------------------------------------------
-- 3. Publication idempotency bound to operation type and semantic request.
--
-- D-17 made publication idempotent on (period, key). That answers "have I seen
-- this key?" and not "have I seen this key for THIS request?" — so a client
-- that reused a key for a REVERT after a PUBLISH, or for a publish naming a
-- different expected-prior-current version, was told its operation had already
-- succeeded when a different one had.
--
-- Two columns close it, and the SERVICE compares them: a replay whose operation
-- type or semantic digest differs is an explicit refusal, never a replay. The
-- columns are recorded here rather than derived so that the refusal survives a
-- change in how the digest is computed — an old record keeps the digest it was
-- written with, and a mismatch is then honest rather than universal.
--
-- `operation_type` is NOT NULL DEFAULT 'publish' so the existing rows (all of
-- which are publications; `publishRevert` delegates to `publishVersion` and no
-- other writer exists) keep a true value. `semantic_request_digest` is NULLABLE
-- because a pre-existing record genuinely has no recorded digest, and inventing
-- one would make an unknown look like a match.
------------------------------------------------------------------------------

ALTER TABLE publication_records
    ADD COLUMN operation_type text NOT NULL DEFAULT 'publish',
    ADD COLUMN semantic_request_digest text;

ALTER TABLE publication_records
    ADD CONSTRAINT publication_records_operation_domain
        CHECK (operation_type IN ('publish', 'revert')),
    ADD CONSTRAINT publication_records_semantic_digest_shape
        CHECK (semantic_request_digest IS NULL
               OR semantic_request_digest ~ '^[0-9a-f]{64}$');

------------------------------------------------------------------------------
-- 4. Grants.
--
-- `rule_revisions`: SELECT only for the runtime roles. The rows arrive through
-- the SECURITY DEFINER trigger, so no runtime role needs INSERT and none is
-- given it — the application can neither forge a revision nor write one that
-- disagrees with the rule it claims to record.
--
-- `publication_records`: the two new columns are covered by the existing
-- table-level INSERT grant from 0009. No column-level UPDATE grant is added;
-- the table has none, and D-15d keeps it that way.
------------------------------------------------------------------------------

GRANT SELECT ON rule_revisions TO app_runtime, app_worker;
GRANT SELECT ON rule_revisions TO app_readonly_support, app_breakglass;

-- Down Migration

DROP TRIGGER IF EXISTS schedule_versions_guard_publish_closed_period ON schedule_versions;
DROP TRIGGER IF EXISTS schedule_periods_guard_status_transition      ON schedule_periods;
DROP TRIGGER IF EXISTS schedule_requirements_guard_period_closed     ON schedule_requirements;
DROP TRIGGER IF EXISTS schedule_versions_guard_period_closed         ON schedule_versions;
DROP TRIGGER IF EXISTS rule_revisions_append_only                    ON rule_revisions;
DROP TRIGGER IF EXISTS rules_zz_record_revision                      ON rules;

DROP FUNCTION IF EXISTS app_guard_publish_into_closed_period();
DROP FUNCTION IF EXISTS app_guard_period_status_transition();
DROP FUNCTION IF EXISTS app_guard_period_not_closed();
DROP FUNCTION IF EXISTS app_record_rule_revision();

ALTER TABLE publication_records
    DROP CONSTRAINT IF EXISTS publication_records_semantic_digest_shape,
    DROP CONSTRAINT IF EXISTS publication_records_operation_domain;

ALTER TABLE publication_records
    DROP COLUMN IF EXISTS semantic_request_digest,
    DROP COLUMN IF EXISTS operation_type;

DROP TABLE IF EXISTS rule_revisions;
