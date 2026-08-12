-- OPUS-M4-001 — the canonical solver input snapshot (doc 35 §6a; SPEC-04 §3.4).
--
-- ADDITIVE. 0001..0015 are applied and are never edited. This file creates one
-- table and one trigger. No grant is revoked, no constraint is relaxed, no
-- policy is replaced, no stable ID is removed or renumbered.
--
-- ## What one row is
--
-- **The complete, immutable problem a build was posed**, plus everything needed
-- to defend or reproduce the answer. SPEC-04 §3.4: `solver_inputs` captures "a
-- complete immutable snapshot … `input_hash` covers all of it". Doc 35 §6a
-- enumerates the constituents and this table records every one of them:
-- organization/group/version identity, the period, the timezone basis, the date
-- range, locations, demand, active effective participants and their type,
-- in-force profiles and weekday FTE, qualifications with expiry, shift-type
-- qualification requirements, pins/protected/manual assignments, the applicable
-- rule revisions and the configuration revisions — carried in `payload` as the
-- canonical document, with `constituents` as the revision citation index and
-- `canonical_input_hash` over the whole canonical form.
--
-- ## Why the payload is one jsonb column and not thirty tables
--
-- Because it is a **snapshot**, and a snapshot's value is that it does not
-- change when the world does. Normalising it would make every row a set of
-- foreign keys into tables that are still being edited, so "the input this build
-- used" would silently become "the input as it looks now" — which is exactly the
-- property the snapshot exists to defeat. The live tables remain the source of
-- truth for the present; this is the record of one past instant.
--
-- The constituent revisions ARE indexed separately (`constituents`), because
-- "which revision of rule X did this build use" is a question asked without
-- reading the whole document, and answering it by scanning a payload would make
-- it expensive enough that nobody asks it.
--
-- ## Immutability, enforced by the database rather than by discipline
--
-- The 0015 `rule_revisions` precedent, followed exactly:
--
--   * no runtime role holds UPDATE or DELETE — the statement fails 42501 before
--     any policy is consulted;
--   * `app_guard_append_only` (0009) refuses UPDATE and DELETE **for the table
--     owner too**, so `app_migrator` and a superuser-adjacent path cannot edit a
--     row either;
--   * the hash column is shape-checked, so a row cannot carry a hash that is not
--     a sha-256.
--
-- A snapshot that could be edited would be worse than no snapshot: it would
-- carry the authority of a record while describing something that never
-- happened. That is the same reason D-15d exists for publication history.
--
-- ## Privacy
--
-- The payload carries qualification ids, validity windows and holding statuses —
-- what SPEC-04 §3.4 names ("qualification holdings with validity"). It does NOT
-- carry `evidence_ref`, issuing bodies, display names, or any operator free
-- text; the assembly (`apps/api/src/solver/canonical-input.ts`) selects the
-- fields explicitly and a test pins the exclusion. I-07 and non-bypass rule 9
-- are not relaxed because the consumer is a solver.
--
-- Normative sources:
--   doc 35 §6a       — the packet; its Required behaviour governs
--   SPEC-04 §1, §3.4, §4 — the worker boundary, the input snapshot, reproducibility
--   SPEC-12 U-07     — assembly inside the transaction, dispatch outside it
--   migration 0009   — `app_guard_append_only`, the schedule spine
--   migration 0014   — `schedule_versions.timezone_basis` / `tzdb_version`
--   migration 0015   — the append-only + no-UPDATE-grant precedent

-- Up Migration

------------------------------------------------------------------------------
-- 1. solver_input_snapshots
------------------------------------------------------------------------------

CREATE TABLE solver_input_snapshots (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id          uuid NOT NULL REFERENCES organizations (id),
    group_id                 uuid NOT NULL,
    period_id                uuid NOT NULL,
    version_id               uuid NOT NULL,

    -- The shape of `payload`, so a reader never has to infer it, and a future
    -- shape change is a version bump rather than a silent reinterpretation.
    snapshot_schema_version  integer NOT NULL CHECK (snapshot_schema_version > 0),
    -- SPEC-04 §4: the AST -> model translation. Recorded per build because a
    -- compiler change can move a result without any input moving.
    compiler_version         integer NOT NULL CHECK (compiler_version >= 0),
    rule_schema_version      integer NOT NULL CHECK (rule_schema_version > 0),

    -- SPEC-04 §3.4's `input_hash`, over the CANONICAL form of `payload`.
    canonical_input_hash     text NOT NULL
        CHECK (canonical_input_hash ~ '^[0-9a-f]{64}$'),

    -- The problem itself.
    payload                  jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    -- Every constituent revision, as `[{kind, key, revision}]`. The citation
    -- index: "which revision of X did this build consume?".
    constituents             jsonb NOT NULL CHECK (jsonb_typeof(constituents) = 'array'),

    -- The 0014 basis, denormalised out of the payload because a stale-basis
    -- question is asked about the snapshot without reading it (R-B7).
    timezone_basis           text NOT NULL CHECK (length(btrim(timezone_basis)) > 0),
    tzdb_version             text NOT NULL CHECK (length(btrim(tzdb_version)) > 0),

    -- The period's date range, likewise denormalised for the same reason.
    start_date               date NOT NULL,
    end_date                 date NOT NULL,

    -- Who asked. NULL for a system actor, exactly as `rule_revisions.recorded_by`.
    initiated_by             uuid,
    created_at               timestamptz NOT NULL DEFAULT now(),

    -- Idempotency information (doc 35 §6a). Bound to the SEMANTIC request, the
    -- 0015 `publication_records` lesson applied a milestone early: a key that
    -- answers "have I seen this key?" instead of "have I seen this key for THIS
    -- request?" tells a client its operation succeeded when a different one did.
    idempotency_key          text NOT NULL CHECK (length(btrim(idempotency_key)) > 0),
    semantic_request_digest  text NOT NULL
        CHECK (semantic_request_digest ~ '^[0-9a-f]{64}$'),

    CONSTRAINT solver_input_snapshots_range CHECK (start_date <= end_date),

    -- The tenant-identity uniqueness every child FK in this schema binds against.
    CONSTRAINT solver_input_snapshots_tenant_identity
        UNIQUE (id, organization_id, group_id),

    -- One snapshot per (period, idempotency key). A retry with the same key
    -- returns the same snapshot instead of assembling a second one, which is
    -- what makes "re-runnable from the same pinned snapshot" (SPEC-04 §2) true
    -- rather than approximately true.
    CONSTRAINT solver_input_snapshots_idempotent
        UNIQUE (organization_id, group_id, period_id, idempotency_key),

    -- Composite tenant foreign keys, 0014's discipline: neither end can be
    -- re-tenanted and neither can point across a group boundary.
    CONSTRAINT solver_input_snapshots_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id),
    CONSTRAINT solver_input_snapshots_period_fk
        FOREIGN KEY (period_id, organization_id, group_id)
        REFERENCES schedule_periods (id, organization_id, group_id),
    CONSTRAINT solver_input_snapshots_version_fk
        FOREIGN KEY (version_id, organization_id, group_id)
        REFERENCES schedule_versions (id, organization_id, group_id),
    CONSTRAINT solver_input_snapshots_initiator_fk
        FOREIGN KEY (initiated_by, organization_id)
        REFERENCES memberships (id, organization_id)
);

ALTER TABLE solver_input_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE solver_input_snapshots FORCE  ROW LEVEL SECURITY;

-- V-09's conjunctive group predicate, written out in full like every sibling.
-- A snapshot is group-scoped in the strongest sense: it is a description of one
-- group's entire staffing position for one period.
CREATE POLICY solver_input_snapshots_group_scope ON solver_input_snapshots
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE INDEX solver_input_snapshots_by_version
    ON solver_input_snapshots (organization_id, group_id, version_id, created_at DESC);

CREATE INDEX solver_input_snapshots_by_hash
    ON solver_input_snapshots (organization_id, group_id, canonical_input_hash);

------------------------------------------------------------------------------
-- 2. Immutability.
--
-- 0009's `app_guard_append_only`, reused rather than re-declared. It refuses
-- UPDATE and DELETE unconditionally, including for the OWNER — which is the arm
-- that matters, because the grants below already stop the runtime roles and a
-- guard that only repeated the grants would prove nothing the grants did not.
------------------------------------------------------------------------------

CREATE TRIGGER solver_input_snapshots_append_only
    BEFORE UPDATE OR DELETE ON solver_input_snapshots
    FOR EACH ROW EXECUTE FUNCTION app_guard_append_only();

------------------------------------------------------------------------------
-- 3. Grants.
--
-- SELECT and INSERT for the two application roles; **no UPDATE, no DELETE for
-- anyone**. The application assembles and inserts; nothing in the platform has
-- a path to change a snapshot afterwards, which is what "immutable" has to mean
-- to be worth writing down.
--
-- `app_readonly_support` and `app_breakglass` get SELECT on the same terms as
-- `rule_revisions`: an operator investigating a build must be able to read the
-- problem it was posed, and the RLS predicate still confines them to a tenant.
------------------------------------------------------------------------------

GRANT SELECT, INSERT ON solver_input_snapshots TO app_runtime, app_worker;
GRANT SELECT         ON solver_input_snapshots TO app_readonly_support, app_breakglass;

-- Down Migration

DROP TRIGGER IF EXISTS solver_input_snapshots_append_only ON solver_input_snapshots;
DROP TABLE IF EXISTS solver_input_snapshots;
