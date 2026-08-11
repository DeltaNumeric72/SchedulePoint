-- OPUS-M4-000A — staffing-input integrity (doc 34 §4-A/§4-B; doc 35 §3).
--
-- ADDITIVE ONLY in the migration-file sense: 0001..0011 are applied and are
-- never edited. This file creates new objects, attaches new triggers to
-- existing tables, adds columns, and — with the 0011 precedent (`CREATE OR
-- REPLACE` restoring the earlier body verbatim on the way down) — narrows the
-- two work-profile delete guards to admit exactly the one new operation the
-- packet requires. No policy is dropped, no existing constraint is relaxed,
-- and every widened grant is named here with its guard.
--
-- Five changes, each traced to a packet clause:
--
--   1. `staffing_set_versions` — the aggregate consistency counter for the two
--      weekday-demand editors and the shift-type qualification set (packet
--      clause 1 and 4; FAD-24 `settings_version` precedent: DATABASE-OWNED,
--      trigger-maintained, absent from every runtime grant).
--   2. `qualifications.version` / `qualification_holdings.version` — row-level
--      CAS counters for qualification and holding mutations (clause 4;
--      the 0005 `app_maintain_catalogue_version` pattern, function reused).
--   3. `requires_expiry` enforced at the DATABASE boundary (clause 2): a
--      holding without an expiry for a requires-expiry qualification is
--      refused by trigger, and flipping `requires_expiry` on while open-ended
--      live holdings exist is refused too (the bypass the service alone
--      cannot close).
--   4. Retired-qualification refusals (clause 3): a NEW holding naming a
--      retired qualification is refused; a NEW (or reactivated)
--      `shift_type_qualifications` row naming one is refused. Existing rows
--      are retained and remain readable — nothing here deletes or rewrites.
--   5. Future-effective work-profile cancellation (clause 5): DELETE of a
--      work-profile row is admitted ONLY while its window has not begun
--      (`effective_from` strictly in the future); everything in-force or
--      elapsed keeps 0004's unconditional refusal, for the OWNER as well as
--      for the runtime roles.
--
-- Delete-absent is the canonical omitted-entry rule for the demand editors
-- (packet clause 1), which is why `shift_type_weekday_demand` and
-- `schedule_requirements` gain DELETE grants here — each behind a capability
-- guard trigger so the statement class is gated at the database like its
-- INSERT/UPDATE siblings.
--
-- Normative sources:
--   doc 35 §3 (OPUS-M4-000A)     — the packet; its Required behaviour governs
--   doc 34 §4-A / §4-B           — the prerequisite register rows this closes
--   FAD-24                       — DB-owned CAS counter precedent (settings_version)
--   FAD-16 / FAD-17              — the day vocabulary and demand model
--   SPEC-04 §3.4                 — the staffing tables the solver consumes
--   migration 0011               — the CREATE OR REPLACE / restore-verbatim precedent

-- Up Migration

------------------------------------------------------------------------------
-- 1. staffing_set_versions — one aggregate version per replaceable set.
--
-- ## What an "aggregate" is here
--
-- Three whole-set editors exist on the staffing-input surface, and each one
-- replaces a SET in one user action (I-10):
--
--   scope 'weekday_demand'             per shift type   (`shift_type_weekday_demand`)
--   scope 'period_requirements'        per period       (`schedule_requirements`)
--   scope 'qualification_requirements' per shift type   (`shift_type_qualifications`)
--
-- The per-ROW `version` columns those tables carry cannot express "the set
-- moved": a row deleted by one writer is invisible to another writer's row
-- predicate, which is exactly how two concurrent replacements combine into a
-- union. The aggregate counter is the thing an editor reads before opening and
-- presents back on save, and the service refuses the save when it no longer
-- matches (409, never a merge).
--
-- ## Version 1 is the ABSENT row
--
-- A set that has never been written presents version 1. The first content
-- write upserts the counter row at 2. This keeps the counter lazy — no
-- backfill over existing shift types or periods, and no trigger on shift-type
-- or period creation — while keeping "load before edit" meaningful from the
-- first save onwards.
--
-- ## Database-owned, like FAD-24's settings_version
--
-- The counter moves ONLY via `app_bump_staffing_set_version`, a SECURITY
-- DEFINER trigger function fired by content-table writes. No runtime role
-- holds INSERT or UPDATE on this table, so the application can neither forge
-- nor rewind it; `staffing_set_versions_guard_monotonic` refuses a decrease
-- for the owner as well. The application's half of the CAS is a tenant-
-- qualified advisory lock plus `version = <the value this transaction read>`
-- (the M3-004 `lockAnchor` precedent: under READ COMMITTED an unlocked
-- compare-and-set read gives no protection at all — measured, 11/12 rounds
-- both writers won).
------------------------------------------------------------------------------

CREATE TABLE staffing_set_versions (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  uuid NOT NULL REFERENCES organizations (id),
    group_id         uuid NOT NULL,
    scope            text NOT NULL
        CONSTRAINT staffing_set_versions_scope_known
        CHECK (scope IN ('weekday_demand', 'period_requirements', 'qualification_requirements')),
    scope_id         uuid NOT NULL,
    version          integer NOT NULL DEFAULT 1
        CONSTRAINT staffing_set_versions_positive CHECK (version > 0),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT staffing_set_versions_unique
        UNIQUE (organization_id, group_id, scope, scope_id),
    CONSTRAINT staffing_set_versions_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id)
);

ALTER TABLE staffing_set_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE staffing_set_versions FORCE  ROW LEVEL SECURITY;

-- V-09's conjunctive group predicate, written out in full like every sibling.
CREATE POLICY staffing_set_versions_group_scope ON staffing_set_versions
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

-- The counter may never decrease — for the OWNER too, which is who a
-- maintenance script runs as (the settings_version shape, 0010).
CREATE FUNCTION app_guard_staffing_set_version_monotonic() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.version < OLD.version THEN
        RAISE EXCEPTION
            'STAFFING_SET_VERSION_MONOTONIC: an aggregate set version may not decrease (% -> %)',
            OLD.version, NEW.version
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER staffing_set_versions_guard_monotonic
    BEFORE UPDATE ON staffing_set_versions
    FOR EACH ROW EXECUTE FUNCTION app_guard_staffing_set_version_monotonic();

------------------------------------------------------------------------------
-- The bump: fired by every content-table write, SECURITY DEFINER because the
-- runtime roles deliberately hold no write grant on the counter.
--
-- TG_ARGV[0] is the scope token; TG_ARGV[1] is the column on the content table
-- that carries the aggregate's identity (`shift_type_id` or `period_id`),
-- read through `to_jsonb` because plpgsql cannot address a record field by
-- a variable name. The tenant columns are uniform across all three tables and
-- are read directly.
--
-- Runs INSIDE the caller's transaction, under the caller's transaction-local
-- tenant context, so the FORCE-RLS policy on the counter admits exactly the
-- caller's own tenant and nothing else — SECURITY DEFINER here changes which
-- GRANTS apply, not which rows are reachable.
--
-- The bump is conditional on the content actually MOVING (IS DISTINCT FROM on
-- UPDATE): FAD-24's rule is that a no-op write must not invalidate a form
-- somebody has open, and the service additionally never issues no-op
-- statements — this is the belt to that braces.
------------------------------------------------------------------------------

CREATE FUNCTION app_bump_staffing_set_version() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_scope    text := TG_ARGV[0];
    v_column   text := TG_ARGV[1];
    v_org      uuid;
    v_group    uuid;
    v_scope_id uuid;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_org      := OLD.organization_id;
        v_group    := OLD.group_id;
        v_scope_id := (to_jsonb(OLD) ->> v_column)::uuid;
    ELSE
        v_org      := NEW.organization_id;
        v_group    := NEW.group_id;
        v_scope_id := (to_jsonb(NEW) ->> v_column)::uuid;
    END IF;

    -- A no-op UPDATE moves nothing. (INSERT and DELETE always count: a row
    -- arriving or leaving IS the set changing.)
    IF TG_OP = 'UPDATE' AND to_jsonb(OLD) = to_jsonb(NEW) THEN
        RETURN NULL;
    END IF;

    INSERT INTO staffing_set_versions (organization_id, group_id, scope, scope_id, version)
    VALUES (v_org, v_group, v_scope, v_scope_id, 2)
    ON CONFLICT (organization_id, group_id, scope, scope_id)
    DO UPDATE SET version = staffing_set_versions.version + 1, updated_at = now();

    RETURN NULL;  -- AFTER trigger; the return value is ignored.
END;
$$;

-- AFTER, not BEFORE: the counter records that content moved, and a BEFORE
-- trigger would bump it for a statement a later BEFORE trigger then refuses.
CREATE TRIGGER shift_type_weekday_demand_zz_bump_set_version
    AFTER INSERT OR UPDATE OR DELETE ON shift_type_weekday_demand
    FOR EACH ROW
    EXECUTE FUNCTION app_bump_staffing_set_version('weekday_demand', 'shift_type_id');

CREATE TRIGGER schedule_requirements_zz_bump_set_version
    AFTER INSERT OR UPDATE OR DELETE ON schedule_requirements
    FOR EACH ROW
    EXECUTE FUNCTION app_bump_staffing_set_version('period_requirements', 'period_id');

CREATE TRIGGER shift_type_qualifications_zz_bump_set_version
    AFTER INSERT OR UPDATE OR DELETE ON shift_type_qualifications
    FOR EACH ROW
    EXECUTE FUNCTION app_bump_staffing_set_version('qualification_requirements', 'shift_type_id');

-- SELECT is all the application needs: the editors read the version to open,
-- and the service reads it (under the advisory lock) to compare. No INSERT,
-- no UPDATE, no DELETE for any runtime role — the trigger is the only writer.
GRANT SELECT ON staffing_set_versions TO app_runtime, app_worker;
GRANT SELECT ON staffing_set_versions TO app_readonly_support, app_breakglass;

------------------------------------------------------------------------------
-- 2. Row-level CAS counters for qualifications and holdings (packet clause 4).
--
-- The 0005 pattern verbatim: DEFAULT 1, bumped unconditionally by
-- `app_maintain_catalogue_version` (0005's function, reused — one
-- implementation of "the row moved"), and absent from every UPDATE grant so
-- naming it raises 42501 before the row is considered. 0004's grants list
-- columns explicitly, so the new column is outside them from the moment it
-- exists.
------------------------------------------------------------------------------

ALTER TABLE qualifications
    ADD COLUMN version integer NOT NULL DEFAULT 1
        CONSTRAINT qualifications_version_positive CHECK (version > 0);

ALTER TABLE qualification_holdings
    ADD COLUMN version integer NOT NULL DEFAULT 1
        CONSTRAINT qualification_holdings_version_positive CHECK (version > 0);

CREATE TRIGGER qualifications_maintain_version
    BEFORE UPDATE ON qualifications
    FOR EACH ROW EXECUTE FUNCTION app_maintain_catalogue_version();

CREATE TRIGGER qualification_holdings_maintain_version
    BEFORE UPDATE ON qualification_holdings
    FOR EACH ROW EXECUTE FUNCTION app_maintain_catalogue_version();

------------------------------------------------------------------------------
-- 3 + 4a. The holding-boundary guard: requires_expiry, and retirement
-- (packet clauses 2 and 3).
--
-- One function, because both rules are facts about the qualification the
-- holding names and both need the same lookup. Fired BEFORE INSERT OR UPDATE,
-- alphabetically after `qualification_holdings_guard_administration` (0004),
-- so the capability gate and the status machine have already spoken.
--
--   requires_expiry:  a holding of a requires-expiry qualification must carry
--                     `valid_until`, on INSERT and on UPDATE alike. (0004
--                     already freezes `valid_until` after issue, so the UPDATE
--                     arm is defence in depth against that guard ever
--                     narrowing.)
--   retirement:       a NEW holding naming a retired qualification is
--                     refused. UPDATEs are deliberately admitted: an existing
--                     holding of a retired qualification is RETAINED and its
--                     status machine keeps working — revoking a holding of a
--                     retired qualification must still be possible.
--
-- The NOT FOUND arm raises `insufficient_privilege`, the same SQLSTATE the
-- 0004 guards use for an invisible parent, so a cross-tenant qualification id
-- is indistinguishable from a nonexistent one (T-05b).
------------------------------------------------------------------------------

CREATE FUNCTION app_guard_holding_expiry_retirement() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_requires_expiry boolean;
    v_status          text;
BEGIN
    SELECT q.requires_expiry, q.status
      INTO v_requires_expiry, v_status
      FROM qualifications q
     WHERE q.id = NEW.qualification_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'the holding names a qualification that is not visible in this context'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF v_requires_expiry AND NEW.valid_until IS NULL THEN
        RAISE EXCEPTION
            'QUALIFICATION_REQUIRES_EXPIRY: this qualification requires an expiry; a holding of '
            'it must carry valid_until'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF TG_OP = 'INSERT' AND v_status = 'retired' THEN
        RAISE EXCEPTION
            'QUALIFICATION_RETIRED: a retired qualification cannot be newly held; reinstate the '
            'qualification first'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER qualification_holdings_guard_expiry_retirement
    BEFORE INSERT OR UPDATE ON qualification_holdings
    FOR EACH ROW EXECUTE FUNCTION app_guard_holding_expiry_retirement();

------------------------------------------------------------------------------
-- 3b. The flip guard: `requires_expiry` may not be switched ON over live
-- open-ended holdings.
--
-- Without this, the holding-boundary rule is bypassable in two statements:
-- create the qualification without the flag, issue open-ended holdings, then
-- flip the flag — every existing holding now violates a rule that nothing
-- ever checked. The service has no update path for `requires_expiry` at all;
-- the UPDATE grant (0004) nevertheless includes the column, so the door is
-- closed where the write would land.
--
-- Holdings in a terminal-ish state (`expired`, `revoked`) do not block the
-- flip: they confer nothing, and the flag is about what may be HELD.
------------------------------------------------------------------------------

CREATE FUNCTION app_guard_requires_expiry_flip() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.requires_expiry AND NOT OLD.requires_expiry AND EXISTS (
        SELECT 1
          FROM qualification_holdings h
         WHERE h.qualification_id = OLD.id
           AND h.valid_until IS NULL
           AND h.status IN ('pending', 'valid', 'expiring')
    ) THEN
        RAISE EXCEPTION
            'QUALIFICATION_REQUIRES_EXPIRY_CONFLICT: open-ended live holdings of this '
            'qualification exist; requires_expiry cannot be switched on over them'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER qualifications_guard_requires_expiry_flip
    BEFORE UPDATE ON qualifications
    FOR EACH ROW EXECUTE FUNCTION app_guard_requires_expiry_flip();

------------------------------------------------------------------------------
-- 4b. shift_type_qualifications: no NEW requirement may name a retired
-- qualification (packet clause 3).
--
-- Two shapes of "new": a fresh INSERT, and the set-replacement's reactivation
-- of an archived row (`status` archived -> active — the unique key is on the
-- pair, so re-adding reactivates rather than duplicating; 0006). Both are
-- refused. An UPDATE that leaves an already-active row active is admitted:
-- existing requirements are RETAINED, exactly as existing holdings are.
------------------------------------------------------------------------------

CREATE FUNCTION app_guard_requirement_retirement() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_status text;
BEGIN
    IF (TG_OP = 'INSERT' AND NEW.status = 'active')
       OR (TG_OP = 'UPDATE' AND NEW.status = 'active' AND OLD.status = 'archived') THEN
        SELECT q.status INTO v_status FROM qualifications q WHERE q.id = NEW.qualification_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION
                'the requirement names a qualification that is not visible in this context'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF v_status = 'retired' THEN
            RAISE EXCEPTION
                'QUALIFICATION_RETIRED: a retired qualification cannot gain new shift-type '
                'requirements; reinstate it first'
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER shift_type_qualifications_guard_retirement
    BEFORE INSERT OR UPDATE ON shift_type_qualifications
    FOR EACH ROW EXECUTE FUNCTION app_guard_requirement_retirement();

------------------------------------------------------------------------------
-- Delete-absent needs DELETE, and DELETE needs a gate.
--
-- The demand editors' canonical omitted-entry rule is DELETE-ABSENT (packet
-- clause 1): a saved set contains exactly the presented entries, and a row
-- for an entry the save omitted is removed. Demand rows and requirement rows
-- are pure quantities — a day (or a date) and a non-negative count — not
-- history: the record of what demand WAS when a schedule was built lives in
-- the audit chain and, from M4-001, in the immutable `solver_inputs`
-- snapshot. That is why deletion is admissible here and stays refused on
-- every catalogue table that names people or structure.
--
-- Each DELETE is capability-gated at the database like its INSERT/UPDATE
-- siblings — `OLD`-based guard functions, because the row being removed is
-- the one that carries the tenant.
------------------------------------------------------------------------------

CREATE FUNCTION app_guard_catalogue_administration_delete() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM app_require_capability('schedule.catalogue.administer', OLD.organization_id);
    RETURN OLD;
END;
$$;

CREATE TRIGGER shift_type_weekday_demand_guard_delete
    BEFORE DELETE ON shift_type_weekday_demand
    FOR EACH ROW EXECUTE FUNCTION app_guard_catalogue_administration_delete();

GRANT DELETE ON shift_type_weekday_demand TO app_runtime, app_worker;

CREATE FUNCTION app_guard_requirement_administration_delete() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM app_require_capability('schedule.period.administer', OLD.organization_id);
    RETURN OLD;
END;
$$;

CREATE TRIGGER schedule_requirements_guard_delete
    BEFORE DELETE ON schedule_requirements
    FOR EACH ROW EXECUTE FUNCTION app_guard_requirement_administration_delete();

GRANT DELETE ON schedule_requirements TO app_runtime, app_worker;

------------------------------------------------------------------------------
-- 5. Future-effective work-profile cancellation (packet clause 5).
--
-- ## What changes, and what does not
--
-- 0004's rule was unconditional: a work-profile window is never deleted. The
-- packet requires an explicit cancellation operation for rows NOT YET IN
-- FORCE, so the rule narrows to: **a window whose time has begun is never
-- deleted; a strictly-future window may be cancelled.** A future window is
-- not history — nothing was ever worked under it, no schedule was built
-- against an instant inside it that has occurred, and its authoring and its
-- cancellation are both audited events. Everything 0004 refused for in-force
-- and elapsed windows is refused exactly as before, for the OWNER as well.
--
-- The 0011 precedent applies: CREATE OR REPLACE narrows the live function;
-- the Down migration restores 0004's body VERBATIM.
--
-- The comparison uses the millisecond-truncated transaction instant, the same
-- value every window bound in this schema is written with (0004's discipline)
-- — comparing against bare now() would misclassify a row authored "now" in
-- the same transaction up to 999 times in a thousand.
------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_guard_work_profile_delete() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF OLD.effective_from <= date_trunc('milliseconds', now()) THEN
        RAISE EXCEPTION
            'WORK_PROFILE_RETAINED: a work-profile window whose time has begun is the record of '
            'a working arrangement and is never deleted; supersede it instead. Only a '
            'strictly-future window may be cancelled'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END;
$$;

-- Weekday targets belong to a profile version. They may be removed ONLY as
-- part of cancelling a strictly-future version — the parent's window decides,
-- so the two guards cannot disagree about what "future" means.
CREATE OR REPLACE FUNCTION app_guard_weekday_fte_delete() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_from timestamptz;
BEGIN
    SELECT p.effective_from INTO v_from
      FROM membership_work_profiles p
     WHERE p.id = OLD.work_profile_id;
    IF NOT FOUND OR v_from <= date_trunc('milliseconds', now()) THEN
        RAISE EXCEPTION
            'WEEKDAY_TARGET_RETAINED: a weekday target belongs to a work-profile version and is '
            'removed only when a strictly-future version is cancelled'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END;
$$;

-- The runtime roles gain DELETE on exactly these two tables. The guards above
-- bind every role including the owner, so the grant admits nothing the rule
-- does not.
GRANT DELETE ON membership_work_profiles, membership_weekday_fte TO app_runtime;

------------------------------------------------------------------------------
-- 6. The ENFORCEMENT read plane for qualification holdings.
--
-- ## The problem this solves, stated honestly
--
-- Publication now enforces the shift-type qualification requirement edge
-- structurally (packet clause 6: the shared verdict, consumed by publication).
-- The verdict's input is `qualification_holdings` — a SENSITIVE-PII table
-- whose SELECT policies deliberately narrow reads to "your own, always;
-- anybody else's only with `staffing.qualification_holding.read_any`".
--
-- An ENFORCEMENT computation cannot run on caller-visible data: a publisher
-- without the read capability would see every assignee as uncredentialed and
-- the gate would refuse a perfectly valid schedule — FAD-23's exact warning
-- ("an access-control artefact manufacturing a false patient-safety-adjacent
-- statement"), fired in the blocking direction. Requiring every publisher to
-- hold `read_any` instead would make a write capability imply a read, which
-- FAD-25 adopted as a standing prohibition.
--
-- ## The mechanism, and its confinement
--
-- One ADDITIVE policy: rows become selectable when the TRANSACTION-LOCAL
-- setting `app.enforcement_read` carries the literal purpose token. Three
-- properties keep this narrow:
--
--   1. **Tenant confinement is unchanged.** The policy carries the same
--      conjunctive organization+group predicate as every sibling; no tenant
--      boundary moves.
--   2. **Only server code can set it**, via `set_config(name, value, true)` —
--      the sole permitted spelling (non-bypass rule 2); nothing client-
--      supplied reaches `set_config`. The application sets it immediately
--      before the enforcement reads and CLEARS it immediately after
--      (`hard-rule-revalidation.ts`), so the widened plane exists for the
--      span of the verdict computation and no longer.
--   3. **What leaves the computation is a VERDICT** — qualification ids and
--      outcome tokens on a refusal the publisher already receives from the
--      authored-rule path — never the holding rows themselves.
--
-- This is not "disabling RLS" (non-bypass rule 3): RLS stays ENABLED and
-- FORCEd, every existing policy stands unchanged, and the new policy is one
-- more OR-arm with its own predicate — the same additive shape every
-- capability-bearing policy on this table already has.
------------------------------------------------------------------------------

-- The nullif() guard on the purpose token is the A-03b spelling discipline
-- (every current_setting occurrence in every policy is nullif-guarded, and
-- `roles-and-schema.test.ts` scans pg_policies to prove it): an unset or empty
-- setting becomes NULL, NULL = 'token' is NULL, and the arm admits nothing.
CREATE POLICY qualification_holdings_enforcement_read ON qualification_holdings
    FOR SELECT
    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
       AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
       AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
       AND nullif(current_setting('app.enforcement_read', true), '')
           = 'qualification_requirements');

------------------------------------------------------------------------------
-- Function hygiene: nothing new is callable except through its trigger.
------------------------------------------------------------------------------

REVOKE ALL ON FUNCTION app_guard_staffing_set_version_monotonic()   FROM PUBLIC;
REVOKE ALL ON FUNCTION app_bump_staffing_set_version()              FROM PUBLIC;
REVOKE ALL ON FUNCTION app_guard_holding_expiry_retirement()        FROM PUBLIC;
REVOKE ALL ON FUNCTION app_guard_requires_expiry_flip()             FROM PUBLIC;
REVOKE ALL ON FUNCTION app_guard_requirement_retirement()           FROM PUBLIC;
REVOKE ALL ON FUNCTION app_guard_catalogue_administration_delete()  FROM PUBLIC;
REVOKE ALL ON FUNCTION app_guard_requirement_administration_delete() FROM PUBLIC;

-- Down Migration

-- 6. The enforcement read plane comes off.
DROP POLICY IF EXISTS qualification_holdings_enforcement_read ON qualification_holdings;

-- 5. The work-profile delete guards are RESTORED to 0004's bodies, verbatim
-- (the 0011 precedent), and the DELETE grants come off.
REVOKE DELETE ON membership_work_profiles, membership_weekday_fte FROM app_runtime;

CREATE OR REPLACE FUNCTION app_guard_work_profile_delete() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION
        'WORK_PROFILE_RETAINED: a work-profile window is the record of a working '
        'arrangement and is never deleted; supersede it instead'
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE OR REPLACE FUNCTION app_guard_weekday_fte_delete() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION
        'WEEKDAY_TARGET_RETAINED: a weekday target belongs to a work-profile version '
        'and is never deleted; author a new version instead'
        USING ERRCODE = 'restrict_violation';
END;
$$;

-- Delete-absent support comes off.
REVOKE DELETE ON schedule_requirements FROM app_runtime, app_worker;
DROP TRIGGER IF EXISTS schedule_requirements_guard_delete ON schedule_requirements;
DROP FUNCTION IF EXISTS app_guard_requirement_administration_delete();

REVOKE DELETE ON shift_type_weekday_demand FROM app_runtime, app_worker;
DROP TRIGGER IF EXISTS shift_type_weekday_demand_guard_delete ON shift_type_weekday_demand;
DROP FUNCTION IF EXISTS app_guard_catalogue_administration_delete();

-- 4b / 3b / 3+4a. The retirement and expiry guards.
DROP TRIGGER IF EXISTS shift_type_qualifications_guard_retirement ON shift_type_qualifications;
DROP FUNCTION IF EXISTS app_guard_requirement_retirement();

DROP TRIGGER IF EXISTS qualifications_guard_requires_expiry_flip ON qualifications;
DROP FUNCTION IF EXISTS app_guard_requires_expiry_flip();

DROP TRIGGER IF EXISTS qualification_holdings_guard_expiry_retirement ON qualification_holdings;
DROP FUNCTION IF EXISTS app_guard_holding_expiry_retirement();

-- 2. The row-version columns and their maintain triggers.
DROP TRIGGER IF EXISTS qualification_holdings_maintain_version ON qualification_holdings;
DROP TRIGGER IF EXISTS qualifications_maintain_version ON qualifications;
ALTER TABLE qualification_holdings DROP COLUMN IF EXISTS version;
ALTER TABLE qualifications         DROP COLUMN IF EXISTS version;

-- 1. The aggregate counter.
DROP TRIGGER IF EXISTS shift_type_qualifications_zz_bump_set_version ON shift_type_qualifications;
DROP TRIGGER IF EXISTS schedule_requirements_zz_bump_set_version     ON schedule_requirements;
DROP TRIGGER IF EXISTS shift_type_weekday_demand_zz_bump_set_version ON shift_type_weekday_demand;
DROP FUNCTION IF EXISTS app_bump_staffing_set_version();
DROP TRIGGER IF EXISTS staffing_set_versions_guard_monotonic ON staffing_set_versions;
DROP FUNCTION IF EXISTS app_guard_staffing_set_version_monotonic();
DROP TABLE IF EXISTS staffing_set_versions;
