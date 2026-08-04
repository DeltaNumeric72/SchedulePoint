-- OPUS-M3-007 — group settings (request-until, picklist access, timezone
-- administration) and `locations` with the free-form `site_label` attribute.
--
-- Carried M2 items 4, 5, 6 and 7 (packet 32 §2). CAP-004 (the location slice of
-- location/calendar modelling), CAP-021..023 (the request-until SETTING only —
-- its enforcement is M5), CAP-030 / CAP-060 (the picklist-access SETTING only —
-- its enforcement is M9).
--
-- ADDITIVE ONLY. 0001..0009 are applied and are never edited. Every statement
-- below creates a new object, adds a new column, or attaches a new
-- trigger/policy/grant. No policy is dropped, no constraint relaxed, no existing
-- grant widened beyond the four new `groups` columns this migration adds.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT CREATE
--
--   There is **no `sites` table**, no `locations.site_id`, and no foreign key
--   from `locations` to anything site-shaped.
--
-- PO-DEC-01 is `pending` with the working default "defer a first-class Site;
-- model location as an attribute" (06 §3.2, the `~~sites~~ REMOVED (CAR-021)`
-- row, and §3.2a). Non-bypass rule 12 forbids implementing a pending decision's
-- non-default branch, and 06 §3.2a states the reason in the form that matters
-- here: "A first-class table with foreign keys is not neutral toward that
-- decision." Building one — even "just the table, nothing uses it yet" — selects
-- the branch by stealth.
--
-- `site_label` is therefore a **denormalised free-form text attribute** on
-- `locations`, exactly as 06 §3.2 row 237 specifies, and both migration
-- directions of §3.2a are modelled as TEST FIXTURES (`apps/api/test/settings/
-- site-migration-fixtures.test.ts`) in a scratch schema, so the data is proven
-- to move in both directions without either migration being built.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Normative sources:
--   06 §3.2 row 237                — `locations`: group tenant, `name`,
--                                    `site_label?`, `address?`, `timezone?`,
--                                    unique `(group_id, name)`, active/archived,
--                                    versioned, sensitivity `NONE`
--   06 §3.2a                       — the site migration boundary (above)
--   06 §3.1 `groups`               — "`organization_id`, `name`, `timezone`,
--                                    settings": group settings live as columns on
--                                    `groups`, which is what FAD-16 already did
--                                    with `pick_position_count`
--   06 §1                          — conventions: composite tenant FK, uuid
--                                    surrogate key, `version`, audit fields, soft
--                                    lifecycle, RLS enabled AND forced with its
--                                    policy in the same migration
--   SPEC-01 §4.3                   — predicate spelling, the V-09 group predicate,
--                                    tenant-qualified uniques
--   SPEC-06 §1.1                   — "Everything not in this enumeration is
--                                    group-scoped": group settings and locations
--                                    are GROUP-scoped action classes
--   doc 08 §6, "Group settings"    — group admin ✓, org admin ✓, scheduler `—`.
--                                    A `✓` and not a `G`, so the three action keys
--                                    are ROLE-IMPLIED for `group_admin`, not
--                                    grant-only
--   SPEC-08 §5 / doc 09 §3         — `request_until_date` named as the GROUP
--                                    policy from which a request's `expires_at`
--                                    is computed server-side at submission
--   research 01 §ADM-01 [OBSERVED] — a group-level "Request Until Date"
--   research 02 §4  [OBSERVED]     — the per-group window state is "(CLOSED)" or
--                                    "(UNTIL <date>)", and differs per group
--   research 17 GAP-17             — a group-level "Pick List Access" control
--                                    EXISTS. Its SEMANTICS are `UNRESOLVED`
--                                    (C-02; doc 05 §5 states outright that they
--                                    "are not asserted anywhere in this design"),
--                                    so nothing below reproduces them — see the
--                                    picklist section
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE PREDICATE SPELLING IS NORMATIVE AND IS WRITTEN OUT IN FULL, EVERY TIME.
--
--   nullif(current_setting('app.<x>', true), '')::uuid
--
-- The reasoning is in 0001 and is not repeated. What IS repeated is the spelling
-- itself, per reference, on every policy — `apps/api/test/tenancy/
-- roles-and-schema.test.ts` (A-03b) reads `pg_policies` and asserts that every
-- individual `current_setting('app.*')` occurrence in every policy is
-- nullif-guarded, and a helper function would hide the one that was not.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ── NO FREE-FORM JSON SETTINGS COLUMN, ANYWHERE ──────────────────────────────
--
-- The packet requires "typed, CHECK-constrained group-settings columns (no
-- free-form JSON)", and the reason is the same one CAR-006 gives for the typed
-- rule AST: a `settings jsonb` column is an escape hatch, and an escape hatch is
-- where the next unmodelled concept lands instead of getting a migration. Every
-- setting below is a named column with a CHECK the database enforces, so an
-- invalid combination is a refused statement rather than a row nobody validated.
--
-- ── STORAGE AND AUTHORING ONLY. ENFORCEMENT IS RECORDED, NOT BUILT ───────────
--
-- Packet 32 §2 rows 5 and 6 are explicit: request-until is **stored, authored
-- and validated here; enforced at M5** (family = requests, SPEC-08, capabilities
-- CAP-021..023, gate R-01..14 + QA-REQ, evidence EV-M5), and picklist access is
-- **stored and authored here; enforced at M9** (family = picklist, SPEC-02/03,
-- capabilities CAP-030 + CAP-060, gate SBX-020/022 + LIVE-SIM, evidence EV-M9).
-- Nothing in this migration or its module reads either setting to decide
-- anything. Neither capability is dropped, deferred or narrowed (non-bypass rule
-- 11) — each has a named owning milestone, a production gate and an evidence
-- bundle.

-- Up Migration

------------------------------------------------------------------------------
-- groups: the request-until policy.
--
-- ## The shape, and why it is three columns rather than one date
--
-- The OBSERVED product carries a single absolute date (research 01 §ADM-01), and
-- research 02 §4 records the two states staff actually see: **"(CLOSED)"** and
-- **"(UNTIL <date>)"**. SPEC-08 §5 and doc 09 §3 both name the group's
-- `request_until_date` **policy** as the thing a request's `expires_at` is
-- computed from server-side at submission.
--
-- A single nullable date can express exactly two of those three things, and it
-- expresses "closed" and "never configured" as the same value — NULL. That is
-- the distinction that matters most to the M5 enforcement: a group that has
-- deliberately closed its window and a group nobody has configured must not be
-- the same row, because the first is a decision and the second is a gap.
--
-- So the policy is a **discriminated triple**, with the database enforcing that
-- exactly the fields the mode needs are present:
--
--   closed                     no submissions are accepted        (research 02 §4)
--   fixed_date                 accepted until `request_until_date` (research 01
--                                                                   §ADM-01,
--                                                                   SPEC-08 §5)
--   days_before_period_start   accepted until `request_until_lead_days` days
--                              before the schedule period starts
--
-- **`days_before_period_start` is a SCHEDULEPOINT-REQUIREMENT, not an observed
-- fact,** and is recorded as one. It exists because a fixed date is a deadline
-- somebody has to remember to move every period, and `group_holidays` already
-- exists in this schema for the sibling problem ("the deadline is Friday" is
-- ambiguous when Friday is a holiday, CAR-011). It is offered for ratification
-- with that classification attached; it reproduces nothing.
--
-- ## What the columns do NOT do
--
-- Nothing reads them. The enforcement — computing `expires_at`, refusing a late
-- submission, rolling a deadline off a holiday — is M5 (SPEC-08), and building
-- any of it here would be enforcement semantics ahead of the request aggregate
-- that defines them.
------------------------------------------------------------------------------

ALTER TABLE groups
    ADD COLUMN request_until_mode text NOT NULL DEFAULT 'closed'
        CONSTRAINT groups_request_until_mode_known
        CHECK (request_until_mode IN ('closed', 'fixed_date', 'days_before_period_start'));

ALTER TABLE groups ADD COLUMN request_until_date date;

ALTER TABLE groups
    ADD COLUMN request_until_lead_days integer
        CONSTRAINT groups_request_until_lead_days_range
        CHECK (request_until_lead_days IS NULL
               OR (request_until_lead_days >= 0 AND request_until_lead_days <= 365));

-- The discriminator, enforced. A mode with the wrong field populated — or with
-- none populated — is a refused statement, not a row the application has to
-- remember to interpret. This is the database half of the same invariant the
-- contract expresses as a zod discriminated union, exactly as `shift_groups`'
-- `scoring_mode`/`weight` pair is.
ALTER TABLE groups
    ADD CONSTRAINT groups_request_until_shape CHECK (
        (request_until_mode = 'closed'
            AND request_until_date IS NULL
            AND request_until_lead_days IS NULL)
        OR (request_until_mode = 'fixed_date'
            AND request_until_date IS NOT NULL
            AND request_until_lead_days IS NULL)
        OR (request_until_mode = 'days_before_period_start'
            AND request_until_date IS NULL
            AND request_until_lead_days IS NOT NULL)
    );

------------------------------------------------------------------------------
-- groups: the picklist-access policy.
--
-- ## What is OBSERVED here is that a control exists. Nothing else.
--
-- Research 17 GAP-17 records a group-level "Pick List Access" control in the
-- source's group settings, found late and never exercised. Contradiction C-02 is
-- still open and still blocking, and doc 05 §5 says the consequence outright:
-- **"the source's `Picklist Admin` / `Pick List Access` semantics remain
-- UNRESOLVED and are not asserted anywhere in this design."**
--
-- So this column is NOT a reconstruction of that control. It is SchedulePoint's
-- own group-level picklist policy, whose members are drawn from SchedulePoint's
-- own model:
--
--   disabled              this group runs no picklist turns
--   members               members holding the turn capability take their own turns
--                         (doc 08 §6, "Picklist: take own turn / proxy")
--   members_and_proxies   additionally, a proxy grant-holder may act on behalf of
--                         a member (PO-DEC-19 default scope, CAP-034)
--
-- ## The property that keeps this from being a fifth authorization layer
--
-- **The setting can only ever NARROW. It never grants.** PO-DEC-02's four layers
-- decide whether a principal may act; this setting is an additional AND applied
-- after them, so `members_and_proxies` does not confer proxy rights on anybody —
-- it declines to withhold them from a principal who already holds the grant.
--
-- That is not a convention for M9 to remember: it is the reason `disabled` is
-- the DEFAULT. A setting whose default widened anything would be a capability
-- expansion arriving through a migration (non-bypass rule 11), and the safest
-- default is the one that grants nothing to a group nobody has configured.
--
-- Enforcement is M9 (packet 32 §2 row 6). Nothing reads this column here.
------------------------------------------------------------------------------

ALTER TABLE groups
    ADD COLUMN picklist_access_mode text NOT NULL DEFAULT 'disabled'
        CONSTRAINT groups_picklist_access_mode_known
        CHECK (picklist_access_mode IN ('disabled', 'members', 'members_and_proxies'));

------------------------------------------------------------------------------
-- groups.settings_version — optimistic concurrency for the settings facet.
--
-- ## Why a NEW counter and not `group_version`
--
-- `groups` already carries `group_version`, and reusing it was the obvious
-- move. It is the wrong one twice over, and the first reason was **measured,
-- not anticipated**:
--
--  1. **It does not move.** 0001's `app_maintain_group_version` bumps only on a
--     `status` change — "SPEC-06 §4: bumped by group status or
--     module-availability change" — so a settings write guarded by
--     `WHERE group_version = <read value>` matches forever. The first version of
--     this slice did exactly that, and `test/settings/timezone.test.ts` caught
--     it: two writers read the same version, both wrote, and the second
--     silently overwrote the first. A concurrency control that cannot lose is a
--     number that looks like one.
--  2. **Making it move would be worse.** `group_version` is an AUTHORIZATION
--     freshness counter (SPEC-06 §4). Bumping it because somebody edited a
--     request window would invalidate every cached authorization decision for
--     the group on a change that alters no authorization at all — and would
--     quietly redefine a counter five other things already cite.
--
-- So the settings facet gets its own counter, on the same terms the catalogue's
-- `version` is on: **the database owns it**, it is absent from every UPDATE
-- grant (naming it raises 42501 before the row is considered), and it may not
-- decrease. The application's half is the `WHERE settings_version = <the value
-- this transaction read>` predicate, with a zero-row result reported as `409`
-- rather than a silent no-op. Both halves are required and neither is
-- sufficient: the trigger stops the counter being forged, the predicate stops
-- the update being lost.
--
-- It covers the TIMEZONE as well as the two stored settings, because all three
-- are edited from one page against one read.
------------------------------------------------------------------------------

ALTER TABLE groups
    ADD COLUMN settings_version integer NOT NULL DEFAULT 1
        CONSTRAINT groups_settings_version_positive CHECK (settings_version > 0);

CREATE FUNCTION app_maintain_group_settings_version() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.settings_version < OLD.settings_version THEN
        RAISE EXCEPTION
            'settings_version may not decrease (% -> %)',
            OLD.settings_version, NEW.settings_version
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- Conditional, unlike the catalogue's unconditional bump: `groups` is one
    -- row carrying several unrelated facets, and a rename or a pick-position
    -- increase must not invalidate a settings form somebody has open. The
    -- catalogue's tables have one facet each, which is why its counter can move
    -- on every UPDATE and this one cannot.
    IF NEW.request_until_mode      IS DISTINCT FROM OLD.request_until_mode
       OR NEW.request_until_date      IS DISTINCT FROM OLD.request_until_date
       OR NEW.request_until_lead_days IS DISTINCT FROM OLD.request_until_lead_days
       OR NEW.picklist_access_mode    IS DISTINCT FROM OLD.picklist_access_mode
       OR NEW.timezone                IS DISTINCT FROM OLD.timezone THEN
        NEW.settings_version := OLD.settings_version + 1;
    END IF;

    RETURN NEW;
END;
$$;

-- `app_guard_group_settings_trigger` sorts before this one, so an unauthorized
-- write is refused before the counter moves. Trigger firing order is by name and
-- these names are chosen.
CREATE TRIGGER app_maintain_group_settings_version_trigger
    BEFORE UPDATE ON groups
    FOR EACH ROW EXECUTE FUNCTION app_maintain_group_settings_version();

------------------------------------------------------------------------------
-- The capability gate on the `groups` settings columns.
--
-- `app_require_capability` is 0002's, unchanged and reused: one implementation
-- of "does the acting membership hold this?", already encoding L3.2/L3.3 (a
-- suspended or expired membership holds nothing) and P-1 (an explicit deny beats
-- every allow).
--
-- ## Three keys, not one, and the line between them
--
-- `group.settings.administer` covers request-until and picklist access.
-- `group.timezone.administer` is its own key for the same shape of reason
-- `group.pick_positions.administer` is: it is the one settings change whose
-- blast radius reaches ALREADY-PUBLISHED history. Every shift-local boundary in
-- every published version resolves against `groups.timezone`, so changing it
-- re-interprets rows that are otherwise immutable (I-18) without touching them.
-- The change is permitted — packet 32 §10c requires it to be — but it is a
-- separately nameable act.
--
-- ## Why the gate fires only when a column actually MOVES
--
-- `groups` is one table with several independent settings on it, plus `name`,
-- `status` and `pick_position_count`. An unconditional gate would make a group
-- rename require the timezone capability. `IS DISTINCT FROM` is what keeps each
-- key scoped to its own column set — the same shape `app_guard_group_pick_
-- position_count` already uses on this table, and for the same reason.
--
-- ## INSERT: what is gated, what is not, and why they differ
--
-- **The request-until and picklist columns ARE gated at INSERT** when they
-- depart from their defaults. The M2-002 review found the mirror of this hole on
-- `pick_position_count`: a `BEFORE UPDATE`-only guard was one INSERT away from
-- being decorative, because a group could simply be *created* with the value.
-- The same escape exists here and is closed the same way.
--
-- **`timezone` is gated on UPDATE only, and that is a deliberate distinction
-- rather than an omission.** A group's INITIAL zone is part of creating the
-- group — an act `organization.group.administer` already governs — and there is
-- no published history to reinterpret at the instant a group comes into
-- existence. CHANGING it later is the privileged act, because by then there may
-- be published versions whose shift-local boundaries resolve against it. Gating
-- creation would additionally have made `organization.group.administer` alone
-- unable to create a group in a real zone, which is not a privilege anybody
-- decided to remove.
--
-- The INSERT scoping semantics are 0005's, unchanged and worth restating: at
-- INSERT the group being created holds no memberships, `app.group_id` is unset
-- under the organization-scoped context group creation runs in, and
-- `app_require_capability` therefore resolves the key against the acting
-- membership WITHOUT a group qualifier — satisfied by the capability held on any
-- group of the organization. What it still refuses is the case that matters: an
-- organization administrator holding `organization.group.administer` and nothing
-- else cannot create a group with a pre-set request window. Once the group
-- exists every later change goes through the UPDATE branch, where `app.group_id`
-- IS set and the capability is scoped to that group in the ordinary way.
------------------------------------------------------------------------------

CREATE FUNCTION app_guard_group_settings() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.request_until_mode IS DISTINCT FROM 'closed'
           OR NEW.request_until_date IS NOT NULL
           OR NEW.request_until_lead_days IS NOT NULL
           OR NEW.picklist_access_mode IS DISTINCT FROM 'disabled' THEN
            PERFORM app_require_capability('group.settings.administer', NEW.organization_id);
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.request_until_mode      IS DISTINCT FROM OLD.request_until_mode
       OR NEW.request_until_date      IS DISTINCT FROM OLD.request_until_date
       OR NEW.request_until_lead_days IS DISTINCT FROM OLD.request_until_lead_days
       OR NEW.picklist_access_mode    IS DISTINCT FROM OLD.picklist_access_mode THEN
        PERFORM app_require_capability('group.settings.administer', NEW.organization_id);
    END IF;

    IF NEW.timezone IS DISTINCT FROM OLD.timezone THEN
        PERFORM app_require_capability('group.timezone.administer', NEW.organization_id);
    END IF;

    RETURN NEW;
END;
$$;

-- `app_guard_...` sorts before `groups_maintain_version`, so an unauthorized
-- write is refused before any counter is touched. Trigger firing order is by
-- name and this name is chosen, exactly as 0005's is.
CREATE TRIGGER app_guard_group_settings_trigger
    BEFORE INSERT OR UPDATE ON groups
    FOR EACH ROW EXECUTE FUNCTION app_guard_group_settings();

GRANT UPDATE (
        request_until_mode, request_until_date, request_until_lead_days,
        picklist_access_mode, updated_at
    ) ON groups TO app_runtime, app_worker;

------------------------------------------------------------------------------
-- locations — 06 §3.2 row 237, exactly as written.
--
-- ## `site_label` is text, and every word of that is load-bearing
--
-- 06 §3.2 row 237: "`site_label?` *(free-form attribute, not a foreign key)*",
-- and "**`site_label` is a denormalised attribute implementing the PO-DEC-01
-- pending default**". It is therefore:
--
--   * `text`, nullable — a location need not name a site at all;
--   * NOT unique, NOT indexed for uniqueness, and NOT referenced by anything —
--     several locations sharing a label is the ordinary case and is what the
--     §3.2a forward migration would group by;
--   * NOT a foreign key, because there is nothing to point at and creating
--     something to point at is the non-default branch.
--
-- The partial index below is the one the §3.2a forward migration would use
-- ("populate by distinct `locations.site_label` per organization"). It is an
-- index, not a constraint: it makes the query the fixtures execute cheap without
-- asserting anything about the label's uniqueness, which nothing knows.
--
-- ## `timezone` here is per-LOCATION and is not the group's
--
-- 06 §3.2 gives `locations` an optional `timezone?`, and 06 §3.1 gives `groups` a
-- NOT NULL one. They are different facts: the group's zone is what shift-local
-- semantics resolve against (0009), and a location's is a property of the place.
-- Nullable here because most locations sit in their group's zone and recording a
-- copy of it would create two truths that can drift.
--
-- ## Archive, never delete
--
-- `status ∈ {active, archived}`, like every catalogue sibling. 06 §1: "Hard
-- deletion is prohibited wherever history or audit references the row", and
-- `apps/api/test/tenancy/roles-and-schema.test.ts` asserts no runtime role holds
-- DELETE on any tenant table. There is no DELETE grant below.
--
-- Sensitivity `NONE` (06 §3.2). `address` is a facility address — a place, not a
-- person — and carries no patient-identifying information and no clinical free
-- text (I-07). It is length-bounded and trimmed, not because it is sensitive but
-- because an unbounded text column is how a form becomes a notes field.
------------------------------------------------------------------------------

CREATE TABLE locations (
    id               uuid PRIMARY KEY,
    organization_id  uuid NOT NULL REFERENCES organizations (id),
    group_id         uuid NOT NULL,
    name             text NOT NULL
        CONSTRAINT locations_name_shape
        CHECK (length(btrim(name)) > 0 AND length(name) <= 120),
    -- The PO-DEC-01 default, in one column. No FK. No `site_id`. No `sites`.
    site_label       text
        CONSTRAINT locations_site_label_shape
        CHECK (site_label IS NULL
               OR (length(btrim(site_label)) > 0 AND length(site_label) <= 120)),
    address          text
        CONSTRAINT locations_address_shape
        CHECK (address IS NULL OR (length(btrim(address)) > 0 AND length(address) <= 500)),
    timezone         text
        CONSTRAINT locations_timezone_shape
        CHECK (timezone IS NULL OR (length(timezone) >= 1 AND length(timezone) <= 64)),
    status           text NOT NULL DEFAULT 'active'
        CONSTRAINT locations_status_known CHECK (status IN ('active', 'archived')),
    version          integer NOT NULL DEFAULT 1 CONSTRAINT locations_version_positive CHECK (version > 0),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT locations_tenant_identity UNIQUE (id, organization_id, group_id),
    -- 06 §3.2 row 237 gives uniqueness as `(group_id, name)`; tenant-qualified
    -- per SPEC-01 §4.3, so the key cannot collide across organizations.
    CONSTRAINT locations_name_unique_in_group UNIQUE (organization_id, group_id, name),
    CONSTRAINT locations_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id)
);

-- The index the §3.2a forward direction would read ("populate by distinct
-- `locations.site_label` per organization"). Partial, because a NULL label is
-- not a site and would otherwise dominate the index.
CREATE INDEX locations_site_label_idx
    ON locations (organization_id, site_label)
    WHERE site_label IS NOT NULL;

------------------------------------------------------------------------------
-- Row level security. ENABLE **and** FORCE, with the policy in this same
-- migration (06 §1, I-15, D-10; `scripts/gates/migration-rls-check.mjs` asserts
-- the pairing and `scripts/red-cases/migration-rls/` proves the gate fires).
------------------------------------------------------------------------------

ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations FORCE  ROW LEVEL SECURITY;

-- V-09's conjunctive group predicate, in full. All three clauses matter:
--
--   organization_id = app.organization_id   the tenant boundary
--   app.group_id IS NOT NULL                a group-scoped context is REQUIRED
--   group_id = app.group_id                 the CAR-001 defect class, caught
--                                           below the application layer
--
-- Group-scoped ONLY, and no organization-scoped policy: SPEC-06 §1.1 enumerates
-- the organization-scoped action classes and says "Everything not in this
-- enumeration is group-scoped. The default is the narrower scope, deliberately."
-- Location administration is not in that enumeration, so an organization-scoped
-- context sees zero location rows and can write none.
CREATE POLICY locations_group_scope ON locations
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

------------------------------------------------------------------------------
-- The capability gate, and the version counter.
--
-- `app_maintain_catalogue_version` is 0005's, reused — as 0008 reuses it for
-- `rules` and `rule_sets`. The database owns `version`, the column is absent
-- from every UPDATE grant (naming it raises 42501), and the service's UPDATE
-- carries `WHERE version = <the version this transaction read>` so a zero-row
-- result is a 409 rather than a silent lost update. Both halves are required
-- and neither is sufficient.
------------------------------------------------------------------------------

CREATE FUNCTION app_guard_location_administration() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM app_require_capability('group.location.administer', NEW.organization_id);
    RETURN NEW;
END;
$$;

-- `_guard_` sorts before `_maintain_`, so an unauthorized write is refused
-- before the counter moves.
CREATE TRIGGER locations_guard_administration
    BEFORE INSERT OR UPDATE ON locations
    FOR EACH ROW EXECUTE FUNCTION app_guard_location_administration();

CREATE TRIGGER locations_maintain_version
    BEFORE UPDATE ON locations
    FOR EACH ROW EXECUTE FUNCTION app_maintain_catalogue_version();

------------------------------------------------------------------------------
-- Grants.
--
-- SELECT + INSERT, and a column-level UPDATE that names only the mutable fields.
-- Absent, deliberately:
--
--   `version`          — assigned by the trigger; naming it raises 42501. A
--                        concurrency counter the writer can choose is not a
--                        concurrency control (the M2-002 review proved it by
--                        setting one back to 1).
--   `id`, `organization_id`, `group_id`, `created_at`
--                      — a row cannot be re-tenanted.
--   DELETE, for anyone — archive, never delete.
------------------------------------------------------------------------------

GRANT SELECT, INSERT ON locations TO app_runtime, app_worker;

GRANT UPDATE (name, site_label, address, timezone, status, updated_at)
    ON locations TO app_runtime, app_worker;

GRANT SELECT ON locations TO app_readonly_support, app_breakglass;

-- PostgreSQL grants EXECUTE to PUBLIC on every new function, so a GRANT without
-- a REVOKE reads as a restriction and is not one. Both are trigger functions,
-- unreachable except through their triggers — revoked anyway rather than relying
-- on that, exactly as 0002, 0005 and 0008 do.
REVOKE ALL ON FUNCTION app_guard_group_settings()             FROM PUBLIC;
REVOKE ALL ON FUNCTION app_guard_location_administration()    FROM PUBLIC;
REVOKE ALL ON FUNCTION app_maintain_group_settings_version()  FROM PUBLIC;

-- Down Migration

DROP TRIGGER IF EXISTS locations_maintain_version      ON locations;
DROP TRIGGER IF EXISTS locations_guard_administration  ON locations;
DROP TRIGGER IF EXISTS app_maintain_group_settings_version_trigger ON groups;
DROP TRIGGER IF EXISTS app_guard_group_settings_trigger ON groups;

DROP FUNCTION IF EXISTS app_guard_location_administration();
DROP FUNCTION IF EXISTS app_maintain_group_settings_version();
DROP FUNCTION IF EXISTS app_guard_group_settings();

DROP POLICY IF EXISTS locations_group_scope ON locations;

DROP INDEX IF EXISTS locations_site_label_idx;

DROP TABLE IF EXISTS locations;

-- The `groups` columns last: the guard trigger above reads them and is already
-- gone by here. The CHECK constraints are dropped before their columns so the
-- order reads the same way up and down.
ALTER TABLE groups DROP CONSTRAINT IF EXISTS groups_settings_version_positive;
ALTER TABLE groups DROP COLUMN IF EXISTS settings_version;

ALTER TABLE groups DROP CONSTRAINT IF EXISTS groups_request_until_shape;
ALTER TABLE groups DROP CONSTRAINT IF EXISTS groups_picklist_access_mode_known;
ALTER TABLE groups DROP CONSTRAINT IF EXISTS groups_request_until_lead_days_range;
ALTER TABLE groups DROP CONSTRAINT IF EXISTS groups_request_until_mode_known;

ALTER TABLE groups DROP COLUMN IF EXISTS picklist_access_mode;
ALTER TABLE groups DROP COLUMN IF EXISTS request_until_lead_days;
ALTER TABLE groups DROP COLUMN IF EXISTS request_until_date;
ALTER TABLE groups DROP COLUMN IF EXISTS request_until_mode;
