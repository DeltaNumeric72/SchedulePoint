-- OPUS-M2-002 — the shift-type catalogue, shift groups, staff groups, valid
-- combinations, per-shift-type weekday+holiday demand, and the group holiday
-- calendar. CAP-011, CAP-012, and the CAP-004 holiday slice (CAR-011).
--
-- ADDITIVE ONLY. 0001, 0002, 0003 and 0004 are applied and are never edited.
-- Every statement below either creates a new object, adds a new column, or
-- attaches a new trigger/policy/grant to an existing one. No policy is dropped,
-- no constraint relaxed, no grant widened on an existing table beyond the single
-- new column this migration adds to `groups`.
--
-- NUMBERED 0005 AT MERGE. It was 0004 while OPUS-M2-002 and OPUS-M2-003 ran in
-- parallel worktrees; M2-003 merged first, so its
-- `0004_work_profiles_qualifications.sql` holds that number and this one moved
-- (24 §E: the second merger rebases and renumbers). Nothing in the content
-- changed with the rename, and this migration depends on no table 0004 creates —
-- it references only `organizations`, `groups` and `memberships` from 0001/0002.
--
-- Normative sources:
--   06 §3.2 + the 2026-08-03 FAD-16 amendment — the authoritative field set
--   06 §1                                     — conventions: composite tenant FK,
--                                                UUID surrogate key, `version`,
--                                                audit fields, soft lifecycle,
--                                                RLS enabled AND forced with its
--                                                policy in the same migration
--   SPEC-01 §4.3                              — predicate spelling, the V-09 group
--                                                predicate, tenant-qualified uniques
--   SPEC-06 §1.1                              — "Everything not in this enumeration is
--                                                group-scoped": catalogue authoring is a
--                                                GROUP-scoped action class, so every
--                                                policy below is the group predicate
--   doc 08 §6                                 — "Author catalogue & rules" (scheduler,
--                                                group admin) and "Group settings"
--                                                (group admin)
--   research 01 §ADM-07/08/09, 05 §1          — the OBSERVED concept inventory these
--                                                tables preserve. Preserved through the
--                                                approved model; **no legacy column name,
--                                                type, or table shape is copied**, and no
--                                                organization, site, or person name from
--                                                the research appears anywhere
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
-- ── WHY EVERY POLICY HERE IS GROUP-SCOPED ONLY ───────────────────────────────
--
-- The catalogue is group configuration. SPEC-06 §1.1 enumerates the
-- organization-scoped action classes and says "Everything not in this
-- enumeration is group-scoped. The default is the narrower scope, deliberately."
-- Catalogue authoring is not in that enumeration, so an ORGANIZATION-scoped
-- context sees **zero** catalogue rows and can write none. That is not an
-- oversight to be relaxed later by adding an organization policy: the narrower
-- predicate is the correct one, and widening it would need a recorded decision.
--
-- ── WHY THERE IS NO DELETE GRANT, ANYWHERE ───────────────────────────────────
--
-- doc 06 §1: "Hard deletion is prohibited wherever history or audit references
-- the row", and `apps/api/test/tenancy/roles-and-schema.test.ts` asserts that no
-- runtime role holds DELETE on ANY tenant table. Retirement is a `status` move;
-- removing a shift type from a bundle is `is_active = false` on the membership
-- row. Both keep the history that a published schedule, a statistic, or an audit
-- row may later have to be explained against.
--
-- The database half of "a referenced shift type cannot be hard-deleted" is
-- therefore two independent controls, and both are asserted: (a) no DELETE grant
-- for any runtime role, and (b) composite foreign keys from every child.
--
-- **Those foreign keys are `NO ACTION`, not `RESTRICT`** — no referential action
-- is declared and `NO ACTION` is PostgreSQL's default. An earlier version of this
-- comment said RESTRICT, which was simply untrue of the SQL below it. For the
-- purpose stated here the two behave identically: both raise `23503` on a DELETE
-- whose row is still referenced, and the table OWNER is refused as surely as a
-- runtime role. They differ only in WHEN the check runs — `NO ACTION` is
-- deferrable and evaluated at the end of the statement, `RESTRICT` is immediate
-- — and nothing here defers a constraint, so the difference has no effect.
-- Stated accurately rather than made accurate: a comment that names the wrong
-- mechanism is how a reviewer comes to trust a control that is not there.

-- Up Migration

------------------------------------------------------------------------------
-- groups.pick_position_count — the group-wide, MONOTONICALLY-INCREASING-ONLY
-- draft-position count (FAD-16; research 05 §ADM-07).
--
-- The observed constraint is explicit: the number of numbered pick positions may
-- only ever be increased, and existing positions can never be removed. That is a
-- real product rule, not a legacy accident: a position number appears in
-- published history, in statistics, and in every `valid_groups` row that names
-- it, so lowering the count would silently invalidate rows that still reference
-- the positions above the new ceiling.
--
-- Enforced by a trigger rather than a CHECK because a CHECK cannot see OLD.
------------------------------------------------------------------------------

ALTER TABLE groups
    ADD COLUMN pick_position_count integer NOT NULL DEFAULT 0
        CONSTRAINT groups_pick_position_count_non_negative CHECK (pick_position_count >= 0);

CREATE FUNCTION app_guard_group_pick_position_count() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    /* ── INSERT: the path this guard did not cover, and it mattered ──────────
     *
     * The trigger was `BEFORE UPDATE` only. An independent review inserted a
     * group with `pick_position_count = 500` under an organization-scoped
     * context and it was **accepted, ungated** — and because the count is
     * monotonic, that value is then permanent. The whole control was one INSERT
     * away from being decorative.
     *
     * A group created with the DEFAULT of 0 is not an administration of pick
     * positions and is not gated: that is ordinary group creation, which
     * `organization.group.administer` already governs. A group created with a
     * non-zero count IS setting the counter, so it requires the counter's own
     * capability — the same rule the UPDATE path applies, reached from the other
     * direction.
     *
     * ── THE SCOPING SEMANTICS AT INSERT, STATED PRECISELY ──────────────────
     *
     * **At INSERT there is no group context to scope the capability against.**
     * The group being created does not exist yet, so it holds no memberships and
     * no grants; group creation is an ORGANIZATION-scoped action (SPEC-06 §1.1),
     * and under an organization-scoped context `app.group_id` is unset by
     * construction. `app_require_capability` therefore resolves
     * `group.pick_positions.administer` against the acting membership WITHOUT a
     * group qualifier — so the gate is satisfied by the capability held on ANY
     * group of the organization.
     *
     * An independent review demonstrated this directly: a grant scoped to Group
     * One authorized an organization-scoped INSERT that set a NEW group's
     * counter. **That is the deliberate creation-time behaviour, not an
     * oversight.** The alternative — requiring the capability on the group being
     * created — is unsatisfiable by anyone, because that group has no members at
     * the instant it is created, and it would make a non-zero initial count
     * impossible rather than merely privileged.
     *
     * What the gate still refuses is the case that matters: an organization
     * administrator holding `organization.group.administer` and NOTHING ELSE is
     * refused, because holding the pick-position capability somewhere in the
     * organization is a strictly stronger claim than being able to create a
     * group. Once the group exists, every later change goes through the UPDATE
     * branch, where `app.group_id` IS set and the capability is scoped to that
     * group in the ordinary way. */
    IF TG_OP = 'INSERT' THEN
        IF NEW.pick_position_count > 0 THEN
            PERFORM app_require_capability('group.pick_positions.administer', NEW.organization_id);
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.pick_position_count < OLD.pick_position_count THEN
        RAISE EXCEPTION
            'pick_position_count may only increase (% -> %) — a position that has existed is '
            'referenced by published history and by valid combinations, and cannot be withdrawn',
            OLD.pick_position_count, NEW.pick_position_count
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- The capability gate, applied only when the column actually moves. A group
    -- rename must not require the pick-position capability, and 0001's
    -- `groups_maintain_version` trigger is on the same table for other columns.
    IF NEW.pick_position_count IS DISTINCT FROM OLD.pick_position_count THEN
        PERFORM app_require_capability('group.pick_positions.administer', NEW.organization_id);
    END IF;

    RETURN NEW;
END;
$$;

-- `app_guard_...` sorts before `groups_maintain_version`, so the refusal happens
-- before the version counter is touched. Trigger firing order is by name and
-- this one is deliberately named to come first.
CREATE TRIGGER groups_guard_pick_position_count
    BEFORE INSERT OR UPDATE ON groups
    FOR EACH ROW EXECUTE FUNCTION app_guard_group_pick_position_count();

GRANT UPDATE (pick_position_count, updated_at) ON groups TO app_runtime, app_worker;

------------------------------------------------------------------------------
-- shift_types — the master catalogue of every kind of work (CAP-011, ADM-07).
--
-- ## Display metadata is a TOKEN KEY, never a colour value
--
-- `display_palette_key` and `display_text_style` are CHECK-constrained members of
-- a curated set that resolves, in the browser, to design tokens whose contrast
-- has been computed and rendered (SP-E brief §4; SPEC-14 §2 "colour is never the
-- sole carrier"). A free hex column would let an administrator author an
-- unreadable shift type, and no accessibility gate anywhere could catch it —
-- the value would be data, arriving after the build. The closed set is what
-- makes the accessibility claim checkable at all.
--
-- The two lists are duplicated in `packages/domain/src/catalogue/display.ts`; a
-- test asserts the database CHECK and the constant agree, so neither can drift.
--
-- ## "Start day" is not a column, and that is the deliberate divergence
--
-- The observed catalogue has Time Start and Time End and no day. A shift's DAY
-- comes from two places in this model: `crosses_midnight` (which says the end
-- time belongs to the following calendar day) and the weekday dimension of
-- `shift_type_weekday_demand` (which says on which days the type is demanded at
-- all). Adding a `start_day` column would have been a third source of truth for
-- a fact the other two already determine, and the three could disagree.
--
-- ## Effective dating AND archiving, which are two different facts
--
-- `status ∈ {active, retired}` is the ARCHIVE lifecycle: a retired type stays,
-- with everything that references it intact. `effective_from`/`effective_to` is
-- the IN-FORCE WINDOW: when this definition may be used by a build. A type can
-- be active but not yet in force (authored ahead of a rota change), and a
-- retired type's window is closed at retirement. doc 06 §3.2 gives the
-- uniqueness as `(group_id, code)`, and that is kept literally: a code is a
-- group's permanent name for a kind of work and is never re-issued, so the
-- window lives on the one row rather than producing a row per version.
------------------------------------------------------------------------------

CREATE TABLE shift_types (
    id                    uuid PRIMARY KEY,
    organization_id       uuid NOT NULL REFERENCES organizations (id),
    group_id              uuid NOT NULL,

    -- ADM-07 "Short Name" — the code shown in grids. Never a primary key: a
    -- natural key leaks into URLs and cannot be re-issued (06 §1).
    code                  text NOT NULL CHECK (length(btrim(code)) > 0 AND length(code) <= 24),
    -- ADM-07 "Full Name".
    name                  text NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 120),
    description           text CHECK (description IS NULL OR length(btrim(description)) > 0),

    display_palette_key   text NOT NULL DEFAULT 'neutral'
                              CHECK (display_palette_key IN
                                  ('neutral', 'indigo', 'teal', 'amber', 'rose', 'violet')),
    display_text_style    text NOT NULL DEFAULT 'regular'
                              CHECK (display_text_style IN ('regular', 'bold', 'italic')),

    start_time            time NOT NULL,
    end_time              time NOT NULL,
    crosses_midnight      boolean NOT NULL DEFAULT false,

    -- The four orthogonal flags the research records as independent (ADM-07),
    -- plus the four the owner's concept list adds. Each is its own column
    -- because each is separately queried by the engine and separately displayed.
    is_on_call            boolean NOT NULL DEFAULT false,
    attracts_stipend      boolean NOT NULL DEFAULT false,
    is_manual_only        boolean NOT NULL DEFAULT false,
    is_daily_pick         boolean NOT NULL DEFAULT false,
    include_in_statistics boolean NOT NULL DEFAULT true,
    is_leave_of_absence   boolean NOT NULL DEFAULT false,
    allow_on_request      boolean NOT NULL DEFAULT false,
    allow_off_request     boolean NOT NULL DEFAULT false,

    report_order          integer NOT NULL DEFAULT 0 CHECK (report_order >= 0),
    -- The optimization weight. `numeric` rather than float: a fairness credit
    -- that is off by a rounding error is a fairness complaint nobody can answer.
    credit_weight         numeric(8, 3) NOT NULL DEFAULT 1.000
                              CHECK (credit_weight >= 0 AND credit_weight <= 1000),

    status                text NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'retired')),
    effective_from        timestamptz NOT NULL DEFAULT now(),
    effective_to          timestamptz,

    version               integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),

    -- `crosses_midnight` is DERIVED-CONSISTENT, not free. An end time at or
    -- before the start time is an overnight shift and must say so; one after it
    -- is not and must not. Without this, a night shift authored with
    -- `crosses_midnight = false` would silently produce a negative-length
    -- interval in every downstream calculation.
    CONSTRAINT shift_types_overnight_shape CHECK (
        (end_time > start_time AND crosses_midnight = false)
     OR (end_time <= start_time AND crosses_midnight = true)
    ),

    -- A type assigned ONLY by manual administrative action cannot also be one
    -- offered in the daily pick. This is not an invented rule: ADM-07 defines
    -- `Manually` as "assigned only by manual admin action, **not via the
    -- picklist draft**", so the two flags being both true contradicts the
    -- definition of one of them.
    --
    -- `is_leave_of_absence` and `include_in_statistics` are deliberately NOT
    -- constrained against each other. It is tempting — counting an absence as a
    -- staffing contribution looks wrong — but the research records the flags as
    -- independent and says nothing about their interaction, and inventing a rule
    -- the evidence does not support is how an inference becomes a fact
    -- (CLAUDE.md §2).
    CONSTRAINT shift_types_manual_excludes_daily_pick CHECK (
        is_manual_only = false OR is_daily_pick = false
    ),

    CONSTRAINT shift_types_window CHECK (effective_to IS NULL OR effective_to > effective_from),

    -- S-22, the lesson from 0002: `timestamptz` accepts `infinity`, every
    -- ordinary window CHECK is satisfied by it, and node-postgres returns it as
    -- the JavaScript number `Infinity` on which `.toISOString()` throws.
    CONSTRAINT shift_types_finite_window CHECK (
        effective_from > '-infinity'::timestamptz AND effective_from < 'infinity'::timestamptz
    AND (effective_to IS NULL
         OR (effective_to > '-infinity'::timestamptz AND effective_to < 'infinity'::timestamptz))
    ),

    -- SPEC-01 §4 amendment (a): the tenant-qualified identity composite FKs
    -- reference. FK checks bypass RLS (X-06), so a single-column FK would accept
    -- a shift type from another group.
    CONSTRAINT shift_types_tenant_identity UNIQUE (id, organization_id, group_id),

    -- SPEC-01 §4 amendment (b): tenant-QUALIFIED and leading with the tenant
    -- columns, so a 23505 can only ever be raised against a row in the caller's
    -- own group. doc 06 §3.2's `(group_id, code)`, written out with the
    -- organization so the index is usable under the group predicate.
    CONSTRAINT shift_types_code_unique_in_group UNIQUE (organization_id, group_id, code),

    CONSTRAINT shift_types_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id)
);

CREATE INDEX shift_types_group_idx ON shift_types (organization_id, group_id, report_order, code);

------------------------------------------------------------------------------
-- shift_type_weekday_demand — the default per-weekday and holiday demand count
-- (FAD-16; the M4 engine's demand input, authored at the catalogue).
--
-- `holiday` is a member of the same enumeration as the seven weekdays rather
-- than a separate boolean, because that is what it is: a holiday's demand
-- REPLACES the weekday's, it does not modify it. A boolean would have produced
-- eight rows with an ambiguous precedence rule; a ninth day value produces eight
-- rows with none.
--
-- Which calendar dates are holidays is `group_holidays`, below.
------------------------------------------------------------------------------

CREATE TABLE shift_type_weekday_demand (
    id               uuid PRIMARY KEY,
    organization_id  uuid NOT NULL,
    group_id         uuid NOT NULL,
    shift_type_id    uuid NOT NULL,
    day              text NOT NULL
                         CHECK (day IN ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'holiday')),
    demand_count     integer NOT NULL DEFAULT 0
                         CHECK (demand_count >= 0 AND demand_count <= 999),
    version          integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT shift_type_weekday_demand_unique_in_group
        UNIQUE (organization_id, group_id, shift_type_id, day),

    CONSTRAINT shift_type_weekday_demand_shift_type_fk
        FOREIGN KEY (shift_type_id, organization_id, group_id)
        REFERENCES shift_types (id, organization_id, group_id),

    CONSTRAINT shift_type_weekday_demand_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id)
);

CREATE INDEX shift_type_weekday_demand_lookup
    ON shift_type_weekday_demand (organization_id, group_id, shift_type_id);

------------------------------------------------------------------------------
-- shift_groups — named bundles of shift types, for fairness scoring and for
-- "request off" targeting (CAP-012, ADM-08).
--
-- `scoring_mode ∈ {hard, weighted}` with the weight present exactly when the
-- mode is `weighted`, enforced by CHECK. This is the same shape the `rules`
-- table takes for `classification` (06 §3.2, CAR-006), and for the same reason:
-- a weight on a hard constraint is meaningless, and the observed display
-- convention "Hard (0)" is a UI artefact of exactly that meaninglessness
-- (research 05 §1). Modelling it as a nullable weight with a CHECK means the
-- meaningless state cannot be stored at all.
--
-- `request_off_label` is the phrasing shown to staff. It is REQUIRED when
-- `allow_request` is true — an request-off control with no label is a control
-- nobody can describe — and prohibited otherwise, so a stale label cannot
-- linger on a bundle that no longer accepts requests.
------------------------------------------------------------------------------

CREATE TABLE shift_groups (
    id                 uuid PRIMARY KEY,
    organization_id    uuid NOT NULL REFERENCES organizations (id),
    group_id           uuid NOT NULL,
    name               text NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 120),
    description        text CHECK (description IS NULL OR length(btrim(description)) > 0),
    scoring_mode       text NOT NULL CHECK (scoring_mode IN ('hard', 'weighted')),
    weight             numeric(10, 3) CHECK (weight IS NULL OR (weight >= 0 AND weight <= 1000000)),
    allow_request      boolean NOT NULL DEFAULT false,
    request_off_label  text CHECK (request_off_label IS NULL OR length(btrim(request_off_label)) > 0),
    status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    version            integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT shift_groups_scoring_shape CHECK (
        (scoring_mode = 'hard'     AND weight IS NULL)
     OR (scoring_mode = 'weighted' AND weight IS NOT NULL)
    ),

    CONSTRAINT shift_groups_request_label_shape CHECK (
        (allow_request = true  AND request_off_label IS NOT NULL)
     OR (allow_request = false AND request_off_label IS NULL)
    ),

    CONSTRAINT shift_groups_tenant_identity UNIQUE (id, organization_id, group_id),
    CONSTRAINT shift_groups_name_unique_in_group UNIQUE (organization_id, group_id, name),
    CONSTRAINT shift_groups_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id)
);

CREATE INDEX shift_groups_group_idx ON shift_groups (organization_id, group_id);

------------------------------------------------------------------------------
-- shift_group_members — which shift types are in a bundle (CAP-012's
-- `shift_group_members`, doc 18).
--
-- `is_active` rather than a DELETE: no runtime role holds DELETE on any tenant
-- table, and a bundle's composition at the time a schedule was built is part of
-- explaining that schedule.
------------------------------------------------------------------------------

CREATE TABLE shift_group_members (
    id               uuid PRIMARY KEY,
    organization_id  uuid NOT NULL,
    group_id         uuid NOT NULL,
    shift_group_id   uuid NOT NULL,
    shift_type_id    uuid NOT NULL,
    is_active        boolean NOT NULL DEFAULT true,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT shift_group_members_unique_in_group
        UNIQUE (organization_id, group_id, shift_group_id, shift_type_id),

    CONSTRAINT shift_group_members_shift_group_fk
        FOREIGN KEY (shift_group_id, organization_id, group_id)
        REFERENCES shift_groups (id, organization_id, group_id),

    CONSTRAINT shift_group_members_shift_type_fk
        FOREIGN KEY (shift_type_id, organization_id, group_id)
        REFERENCES shift_types (id, organization_id, group_id),

    CONSTRAINT shift_group_members_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id)
);

CREATE INDEX shift_group_members_lookup
    ON shift_group_members (organization_id, group_id, shift_group_id);

------------------------------------------------------------------------------
-- staff_groups — named subsets of people, for scoping eligibility and
-- visibility (CAP-012, ADM-06).
--
-- Deliberately SEPARATE from `shift_groups`, per report 19 CAP-012: "SchedulePoint
-- separates them explicitly". They bundle different things for different reasons
-- and share no field beyond a name.
------------------------------------------------------------------------------

CREATE TABLE staff_groups (
    id               uuid PRIMARY KEY,
    organization_id  uuid NOT NULL REFERENCES organizations (id),
    group_id         uuid NOT NULL,
    name             text NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 120),
    description      text CHECK (description IS NULL OR length(btrim(description)) > 0),
    status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    version          integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT staff_groups_tenant_identity UNIQUE (id, organization_id, group_id),
    CONSTRAINT staff_groups_name_unique_in_group UNIQUE (organization_id, group_id, name),
    CONSTRAINT staff_groups_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id)
);

CREATE INDEX staff_groups_group_idx ON staff_groups (organization_id, group_id);

------------------------------------------------------------------------------
-- staff_group_members — which memberships are in a staff group.
--
-- The composite FK is to `memberships (id, organization_id)` — 0001's tenant
-- identity — and the row's own `group_id` is pinned by the RLS policy, so a
-- membership from another group cannot be filed here without also declaring that
-- group's context, at which point the shift-side FKs fail.
------------------------------------------------------------------------------

CREATE TABLE staff_group_members (
    id               uuid PRIMARY KEY,
    organization_id  uuid NOT NULL,
    group_id         uuid NOT NULL,
    staff_group_id   uuid NOT NULL,
    membership_id    uuid NOT NULL,
    is_active        boolean NOT NULL DEFAULT true,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT staff_group_members_unique_in_group
        UNIQUE (organization_id, group_id, staff_group_id, membership_id),

    CONSTRAINT staff_group_members_staff_group_fk
        FOREIGN KEY (staff_group_id, organization_id, group_id)
        REFERENCES staff_groups (id, organization_id, group_id),

    CONSTRAINT staff_group_members_membership_fk
        FOREIGN KEY (membership_id, organization_id)
        REFERENCES memberships (id, organization_id),

    CONSTRAINT staff_group_members_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id)
);

CREATE INDEX staff_group_members_lookup
    ON staff_group_members (organization_id, group_id, staff_group_id);

------------------------------------------------------------------------------
-- valid_groups — which draft pick positions are legal for a set of shift types
-- (CAP-011/CAP-012, ADM-09, resolved in research 05 §1).
--
-- Two halves, modelled differently, and the asymmetry is deliberate:
--
--   * the SHIFT TYPE set is a child table with a composite foreign key, because
--     a shift type is a row and the foreign key is what makes "a referenced
--     shift type cannot be hard-deleted" true at the database;
--   * the PICK POSITION set is an `integer[]` on the row, because a position is
--     not an entity anywhere in this schema — it is an ordinal between 1 and
--     `groups.pick_position_count` — and a child table of integers would invent
--     an aggregate that nothing else references. doc 06 §3.2 models it as
--     `allowed_pick_positions` for the same reason.
--
-- The array's members are validated by CHECK (sorted, distinct, >= 1) and its
-- ceiling by trigger, because a CHECK cannot read another table.
------------------------------------------------------------------------------

CREATE TABLE valid_groups (
    id                     uuid PRIMARY KEY,
    organization_id        uuid NOT NULL REFERENCES organizations (id),
    group_id               uuid NOT NULL,
    name                   text NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 120),
    allowed_pick_positions integer[] NOT NULL DEFAULT '{}',
    status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    version                integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),

    -- A one-dimensional array with no NULL members. The shape checks a CHECK can
    -- express are here; **sortedness, distinctness and the >= 1 floor are in
    -- `app_guard_valid_group_positions` below**, because expressing them needs a
    -- subquery over `unnest(...)` and PostgreSQL rejects a subquery in a CHECK
    -- constraint outright (measured, not assumed — the first version of this
    -- migration was written with them here and would not apply).
    CONSTRAINT valid_groups_positions_shape CHECK (
        array_ndims(allowed_pick_positions) IS NULL OR array_ndims(allowed_pick_positions) = 1
    ),
    CONSTRAINT valid_groups_positions_not_null CHECK (
        array_position(allowed_pick_positions, NULL) IS NULL
    ),

    CONSTRAINT valid_groups_tenant_identity UNIQUE (id, organization_id, group_id),
    CONSTRAINT valid_groups_name_unique_in_group UNIQUE (organization_id, group_id, name),
    CONSTRAINT valid_groups_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id)
);

CREATE INDEX valid_groups_group_idx ON valid_groups (organization_id, group_id);

CREATE TABLE valid_group_shift_types (
    id               uuid PRIMARY KEY,
    organization_id  uuid NOT NULL,
    group_id         uuid NOT NULL,
    valid_group_id   uuid NOT NULL,
    shift_type_id    uuid NOT NULL,
    is_active        boolean NOT NULL DEFAULT true,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT valid_group_shift_types_unique_in_group
        UNIQUE (organization_id, group_id, valid_group_id, shift_type_id),

    CONSTRAINT valid_group_shift_types_valid_group_fk
        FOREIGN KEY (valid_group_id, organization_id, group_id)
        REFERENCES valid_groups (id, organization_id, group_id),

    CONSTRAINT valid_group_shift_types_shift_type_fk
        FOREIGN KEY (shift_type_id, organization_id, group_id)
        REFERENCES shift_types (id, organization_id, group_id),

    CONSTRAINT valid_group_shift_types_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id)
);

CREATE INDEX valid_group_shift_types_lookup
    ON valid_group_shift_types (organization_id, group_id, valid_group_id);

------------------------------------------------------------------------------
-- group_holidays — the group's holiday calendar (CAR-011).
--
--   > "Deadline rolling needs an explicit calendar: 'the deadline is Friday' is
--   > ambiguous when Friday is a holiday." (doc 06 §3.2)
--
-- It is also what makes `shift_type_weekday_demand`'s `holiday` day meaningful:
-- without a calendar, "holiday demand" names no dates.
--
-- `observed` distinguishes a holiday the group actually observes from one it
-- records but works through — a real distinction in clinical rotas, and a
-- boolean rather than a second table because it has no other attributes.
------------------------------------------------------------------------------

CREATE TABLE group_holidays (
    id               uuid PRIMARY KEY,
    organization_id  uuid NOT NULL REFERENCES organizations (id),
    group_id         uuid NOT NULL,
    holiday_date     date NOT NULL,
    name             text NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 120),
    observed         boolean NOT NULL DEFAULT true,
    version          integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT group_holidays_tenant_identity UNIQUE (id, organization_id, group_id),
    CONSTRAINT group_holidays_date_unique_in_group
        UNIQUE (organization_id, group_id, holiday_date),
    CONSTRAINT group_holidays_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id)
);

CREATE INDEX group_holidays_lookup ON group_holidays (organization_id, group_id, holiday_date);

------------------------------------------------------------------------------
-- Row level security. ENABLE **and** FORCE, on every table, with its policy in
-- this same migration (06 §1, I-15, D-10; the gate asserts the pairing).
------------------------------------------------------------------------------

ALTER TABLE shift_types                ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_types                FORCE  ROW LEVEL SECURITY;
ALTER TABLE shift_type_weekday_demand  ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_type_weekday_demand  FORCE  ROW LEVEL SECURITY;
ALTER TABLE shift_groups               ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_groups               FORCE  ROW LEVEL SECURITY;
ALTER TABLE shift_group_members        ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_group_members        FORCE  ROW LEVEL SECURITY;
ALTER TABLE staff_groups               ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_groups               FORCE  ROW LEVEL SECURITY;
ALTER TABLE staff_group_members        ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_group_members        FORCE  ROW LEVEL SECURITY;
ALTER TABLE valid_groups               ENABLE ROW LEVEL SECURITY;
ALTER TABLE valid_groups               FORCE  ROW LEVEL SECURITY;
ALTER TABLE valid_group_shift_types    ENABLE ROW LEVEL SECURITY;
ALTER TABLE valid_group_shift_types    FORCE  ROW LEVEL SECURITY;
ALTER TABLE group_holidays             ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_holidays             FORCE  ROW LEVEL SECURITY;

-- V-09's conjunctive group predicate, in full, on every table. All three clauses
-- matter and none is redundant:
--
--   organization_id = app.organization_id   the tenant boundary
--   app.group_id IS NOT NULL                a group-scoped context is REQUIRED —
--                                           without it an organization-scoped
--                                           context would match every row whose
--                                           group_id happened to be NULL, and the
--                                           next nullable group column would be a
--                                           leak
--   group_id = app.group_id                 the CAR-001 defect class, caught below
--                                           the application layer

CREATE POLICY shift_types_group_scope ON shift_types
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE POLICY shift_type_weekday_demand_group_scope ON shift_type_weekday_demand
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE POLICY shift_groups_group_scope ON shift_groups
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE POLICY shift_group_members_group_scope ON shift_group_members
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE POLICY staff_groups_group_scope ON staff_groups
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE POLICY staff_group_members_group_scope ON staff_group_members
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE POLICY valid_groups_group_scope ON valid_groups
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE POLICY valid_group_shift_types_group_scope ON valid_group_shift_types
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE POLICY group_holidays_group_scope ON group_holidays
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

------------------------------------------------------------------------------
-- The capability gates.
--
-- SPEC-06's evaluator in the application is the CONTROL; these triggers are
-- defence in depth, in the same one-directional sense 0002 describes: every
-- layer they omit can only DENY, so a statement a trigger admits may still be
-- denied above it, and a statement it refuses is refused whatever the
-- application thinks.
--
-- `app_require_capability` is 0002's, unchanged. Reusing it rather than writing a
-- second gate is the point: one implementation of "does the acting membership
-- hold this?", and it already encodes L3.2/L3.3 (a suspended or expired
-- membership holds nothing) and P-1 (an explicit deny beats every allow).
------------------------------------------------------------------------------

CREATE FUNCTION app_guard_catalogue_administration() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM app_require_capability('schedule.catalogue.administer', NEW.organization_id);
    RETURN NEW;
END;
$$;

CREATE FUNCTION app_guard_holiday_calendar_administration() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM app_require_capability('group.holiday_calendar.administer', NEW.organization_id);
    RETURN NEW;
END;
$$;

CREATE TRIGGER shift_types_guard_administration
    BEFORE INSERT OR UPDATE ON shift_types
    FOR EACH ROW EXECUTE FUNCTION app_guard_catalogue_administration();

CREATE TRIGGER shift_type_weekday_demand_guard_administration
    BEFORE INSERT OR UPDATE ON shift_type_weekday_demand
    FOR EACH ROW EXECUTE FUNCTION app_guard_catalogue_administration();

CREATE TRIGGER shift_groups_guard_administration
    BEFORE INSERT OR UPDATE ON shift_groups
    FOR EACH ROW EXECUTE FUNCTION app_guard_catalogue_administration();

CREATE TRIGGER shift_group_members_guard_administration
    BEFORE INSERT OR UPDATE ON shift_group_members
    FOR EACH ROW EXECUTE FUNCTION app_guard_catalogue_administration();

CREATE TRIGGER staff_groups_guard_administration
    BEFORE INSERT OR UPDATE ON staff_groups
    FOR EACH ROW EXECUTE FUNCTION app_guard_catalogue_administration();

CREATE TRIGGER staff_group_members_guard_administration
    BEFORE INSERT OR UPDATE ON staff_group_members
    FOR EACH ROW EXECUTE FUNCTION app_guard_catalogue_administration();

CREATE TRIGGER valid_groups_guard_administration
    BEFORE INSERT OR UPDATE ON valid_groups
    FOR EACH ROW EXECUTE FUNCTION app_guard_catalogue_administration();

CREATE TRIGGER valid_group_shift_types_guard_administration
    BEFORE INSERT OR UPDATE ON valid_group_shift_types
    FOR EACH ROW EXECUTE FUNCTION app_guard_catalogue_administration();

CREATE TRIGGER group_holidays_guard_administration
    BEFORE INSERT OR UPDATE ON group_holidays
    FOR EACH ROW EXECUTE FUNCTION app_guard_holiday_calendar_administration();

------------------------------------------------------------------------------
-- `version` — optimistic concurrency, made into a CONTROL.
--
-- ## What was wrong
--
-- `version` was a column the APPLICATION incremented, and it was in the
-- column-level UPDATE grant. An independent review set it back to 1 as
-- `app_runtime` — accepted — and then demonstrated the lost update the counter
-- is supposed to prevent: two readers take the same row, both compute
-- `version + 1`, and the second write silently overwrites the first. A counter
-- an attacker (or a bug) can set to any value is not a concurrency control; it
-- is a number that looks like one.
--
-- ## What it is now
--
-- The database owns it, exactly as 0001 owns `organization_version` and
-- `group_version`: a `BEFORE UPDATE` trigger assigns `OLD.version + 1` and the
-- column is **removed from every UPDATE grant**, so naming it raises 42501
-- before the row is considered. The application cannot set it, cannot rewind
-- it, and cannot skip it.
--
-- The other half is in the service: every catalogue UPDATE carries
-- `WHERE version = <the version this transaction read>`, and a zero-row result
-- is a `409 CONFLICT` rather than a silent no-op. Read and write are in the
-- SAME unit of work, so the version the writer checked is the version the
-- reader saw (FAD-12, and the M1 S-01 lesson).
--
-- Both halves are required and neither is sufficient: the trigger stops the
-- counter being forged, the predicate stops the update being lost.
------------------------------------------------------------------------------

CREATE FUNCTION app_maintain_catalogue_version() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    -- Unconditional. A "no-op" UPDATE still bumps, because a writer that read
    -- version N and wrote nothing still has to lose to a writer that read N and
    -- wrote something.
    NEW.version := OLD.version + 1;
    RETURN NEW;
END;
$$;

-- `_maintain_` sorts after `_guard_`, so an unauthorized write is refused before
-- the counter moves. Trigger firing order is by name; these names are chosen.
CREATE TRIGGER shift_types_maintain_version
    BEFORE UPDATE ON shift_types
    FOR EACH ROW EXECUTE FUNCTION app_maintain_catalogue_version();

CREATE TRIGGER shift_type_weekday_demand_maintain_version
    BEFORE UPDATE ON shift_type_weekday_demand
    FOR EACH ROW EXECUTE FUNCTION app_maintain_catalogue_version();

CREATE TRIGGER shift_groups_maintain_version
    BEFORE UPDATE ON shift_groups
    FOR EACH ROW EXECUTE FUNCTION app_maintain_catalogue_version();

CREATE TRIGGER staff_groups_maintain_version
    BEFORE UPDATE ON staff_groups
    FOR EACH ROW EXECUTE FUNCTION app_maintain_catalogue_version();

CREATE TRIGGER valid_groups_maintain_version
    BEFORE UPDATE ON valid_groups
    FOR EACH ROW EXECUTE FUNCTION app_maintain_catalogue_version();

CREATE TRIGGER group_holidays_maintain_version
    BEFORE UPDATE ON group_holidays
    FOR EACH ROW EXECUTE FUNCTION app_maintain_catalogue_version();

------------------------------------------------------------------------------
-- The pick-position set: canonical form, and the ceiling.
--
-- FAD-16: "`valid_groups.allowed_pick_positions` members must be <= it". A CHECK
-- cannot read `groups` — and cannot express sortedness or distinctness either,
-- because both need a subquery over `unnest(...)` and PostgreSQL rejects a
-- subquery in a CHECK constraint. So all four rules live here.
--
-- The ceiling is checked on the `valid_groups` side only. The `groups` side needs
-- no check because `pick_position_count` is monotonic: the count can only rise,
-- so an existing valid-group row can never become invalid by a later change to
-- the group.
--
-- **Canonical form is asserted, not imposed.** The trigger could sort and
-- deduplicate the array silently, and that would be worse: a caller that sent
-- `{3,1,1}` and got back `{1,3}` learned nothing about the two different
-- mistakes it made. A rejected write with a named reason is the feedback an
-- authoring form can render.
------------------------------------------------------------------------------

CREATE FUNCTION app_guard_valid_group_positions() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    ceiling    integer;
    highest    integer;
    lowest     integer;
    canonical  integer[];
BEGIN
    SELECT coalesce(array_agg(DISTINCT p ORDER BY p), '{}'::integer[])
      INTO canonical
      FROM unnest(NEW.allowed_pick_positions) AS p;

    IF NEW.allowed_pick_positions IS DISTINCT FROM canonical THEN
        RAISE EXCEPTION
            'allowed_pick_positions must be sorted ascending and free of duplicates'
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT max(p), min(p) INTO highest, lowest FROM unnest(NEW.allowed_pick_positions) AS p;
    IF highest IS NULL THEN
        RETURN NEW;
    END IF;

    IF lowest < 1 THEN
        RAISE EXCEPTION
            'pick positions are numbered from 1; % is not a position', lowest
            USING ERRCODE = 'check_violation';
    END IF;

    -- Read under the caller's RLS: `groups_group_scope` restricts this to the
    -- declared group's own row, so there is no way to read another group's
    -- ceiling here even by naming it.
    SELECT g.pick_position_count INTO ceiling
      FROM groups g
     WHERE g.id = NEW.group_id AND g.organization_id = NEW.organization_id;

    IF ceiling IS NULL THEN
        RAISE EXCEPTION
            'the group named by this valid combination is not visible in the current context'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF highest > ceiling THEN
        RAISE EXCEPTION
            'pick position % exceeds the group''s pick_position_count (%)', highest, ceiling
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

-- Fires AFTER `valid_groups_guard_administration` (name order: `_guard_a` <
-- `_guard_p`), so an unauthorized caller is refused before it learns anything
-- about the ceiling.
CREATE TRIGGER valid_groups_guard_positions
    BEFORE INSERT OR UPDATE ON valid_groups
    FOR EACH ROW EXECUTE FUNCTION app_guard_valid_group_positions();

------------------------------------------------------------------------------
-- Grants.
--
-- Column-level UPDATE throughout, for the reason 0001 states: the alternative is
-- a table-level grant plus a promise, and a promise is not a control. Adding a
-- mutable column means adding it here, which is the review friction that should
-- exist.
--
-- **No DELETE, on anything.** Retirement is a `status` move and de-bundling is
-- `is_active = false`; `apps/api/test/tenancy/roles-and-schema.test.ts` asserts
-- that no runtime role holds DELETE on any tenant table, and this migration is
-- covered by it from the moment its tables enter `TENANT_TABLES`.
--
-- **`version` is not in any grant.** It is assigned by
-- `app_maintain_catalogue_version` and naming it in an UPDATE raises 42501 —
-- which is the point: a concurrency counter the writer can choose is not a
-- concurrency control. An independent review set it back to 1 as `app_runtime`
-- while it was grantable.
--
-- **`id`, `organization_id`, `group_id`, `code`, `created_at` are not
-- updatable.** A row cannot be re-tenanted, and a shift type's code is its
-- permanent name — changing it would silently rewrite the meaning of every grid,
-- report and audit row that cites it (non-bypass rule 13's shape, applied to
-- tenant data). Renaming is `name`, which is the human-readable label.
------------------------------------------------------------------------------

GRANT SELECT, INSERT ON
        shift_types, shift_type_weekday_demand, shift_groups, shift_group_members,
        staff_groups, staff_group_members, valid_groups, valid_group_shift_types,
        group_holidays
    TO app_runtime, app_worker;

GRANT UPDATE (
        name, description, display_palette_key, display_text_style,
        start_time, end_time, crosses_midnight,
        is_on_call, attracts_stipend, is_manual_only, is_daily_pick,
        include_in_statistics, is_leave_of_absence, allow_on_request, allow_off_request,
        report_order, credit_weight, status, effective_from, effective_to,
        updated_at
    ) ON shift_types TO app_runtime, app_worker;

GRANT UPDATE (demand_count, updated_at)
    ON shift_type_weekday_demand TO app_runtime, app_worker;

GRANT UPDATE (
        name, description, scoring_mode, weight, allow_request, request_off_label,
        status, updated_at
    ) ON shift_groups TO app_runtime, app_worker;

GRANT UPDATE (is_active, updated_at)
    ON shift_group_members TO app_runtime, app_worker;

GRANT UPDATE (name, description, status, updated_at)
    ON staff_groups TO app_runtime, app_worker;

GRANT UPDATE (is_active, updated_at)
    ON staff_group_members TO app_runtime, app_worker;

GRANT UPDATE (name, allowed_pick_positions, status, updated_at)
    ON valid_groups TO app_runtime, app_worker;

GRANT UPDATE (is_active, updated_at)
    ON valid_group_shift_types TO app_runtime, app_worker;

GRANT UPDATE (name, observed, updated_at)
    ON group_holidays TO app_runtime, app_worker;

GRANT SELECT ON
        shift_types, shift_type_weekday_demand, shift_groups, shift_group_members,
        staff_groups, staff_group_members, valid_groups, valid_group_shift_types,
        group_holidays
    TO app_readonly_support, app_breakglass;

-- PostgreSQL grants EXECUTE to PUBLIC on every new function, so a GRANT without
-- a REVOKE reads as a restriction and is not one. All three are trigger
-- functions, unreachable except through their triggers — revoked anyway rather
-- than relying on that, exactly as 0002 does.
REVOKE ALL ON FUNCTION app_guard_catalogue_administration() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_guard_holiday_calendar_administration() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_guard_valid_group_positions() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_guard_group_pick_position_count() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_maintain_catalogue_version() FROM PUBLIC;

-- Down Migration

DROP TRIGGER IF EXISTS group_holidays_maintain_version                 ON group_holidays;
DROP TRIGGER IF EXISTS valid_groups_maintain_version                   ON valid_groups;
DROP TRIGGER IF EXISTS staff_groups_maintain_version                   ON staff_groups;
DROP TRIGGER IF EXISTS shift_groups_maintain_version                   ON shift_groups;
DROP TRIGGER IF EXISTS shift_type_weekday_demand_maintain_version      ON shift_type_weekday_demand;
DROP TRIGGER IF EXISTS shift_types_maintain_version                    ON shift_types;
DROP TRIGGER IF EXISTS valid_groups_guard_positions                    ON valid_groups;
DROP TRIGGER IF EXISTS group_holidays_guard_administration             ON group_holidays;
DROP TRIGGER IF EXISTS valid_group_shift_types_guard_administration    ON valid_group_shift_types;
DROP TRIGGER IF EXISTS valid_groups_guard_administration               ON valid_groups;
DROP TRIGGER IF EXISTS staff_group_members_guard_administration        ON staff_group_members;
DROP TRIGGER IF EXISTS staff_groups_guard_administration               ON staff_groups;
DROP TRIGGER IF EXISTS shift_group_members_guard_administration        ON shift_group_members;
DROP TRIGGER IF EXISTS shift_groups_guard_administration               ON shift_groups;
DROP TRIGGER IF EXISTS shift_type_weekday_demand_guard_administration  ON shift_type_weekday_demand;
DROP TRIGGER IF EXISTS shift_types_guard_administration                ON shift_types;
DROP TRIGGER IF EXISTS groups_guard_pick_position_count                ON groups;

DROP FUNCTION IF EXISTS app_maintain_catalogue_version();
DROP FUNCTION IF EXISTS app_guard_valid_group_positions();
DROP FUNCTION IF EXISTS app_guard_holiday_calendar_administration();
DROP FUNCTION IF EXISTS app_guard_catalogue_administration();
DROP FUNCTION IF EXISTS app_guard_group_pick_position_count();

DROP POLICY IF EXISTS group_holidays_group_scope             ON group_holidays;
DROP POLICY IF EXISTS valid_group_shift_types_group_scope    ON valid_group_shift_types;
DROP POLICY IF EXISTS valid_groups_group_scope               ON valid_groups;
DROP POLICY IF EXISTS staff_group_members_group_scope        ON staff_group_members;
DROP POLICY IF EXISTS staff_groups_group_scope               ON staff_groups;
DROP POLICY IF EXISTS shift_group_members_group_scope        ON shift_group_members;
DROP POLICY IF EXISTS shift_groups_group_scope               ON shift_groups;
DROP POLICY IF EXISTS shift_type_weekday_demand_group_scope  ON shift_type_weekday_demand;
DROP POLICY IF EXISTS shift_types_group_scope                ON shift_types;

DROP INDEX IF EXISTS group_holidays_lookup;
DROP INDEX IF EXISTS valid_group_shift_types_lookup;
DROP INDEX IF EXISTS valid_groups_group_idx;
DROP INDEX IF EXISTS staff_group_members_lookup;
DROP INDEX IF EXISTS staff_groups_group_idx;
DROP INDEX IF EXISTS shift_group_members_lookup;
DROP INDEX IF EXISTS shift_groups_group_idx;
DROP INDEX IF EXISTS shift_type_weekday_demand_lookup;
DROP INDEX IF EXISTS shift_types_group_idx;

-- Children before parents: every composite FK below points upward.
DROP TABLE IF EXISTS group_holidays;
DROP TABLE IF EXISTS valid_group_shift_types;
DROP TABLE IF EXISTS valid_groups;
DROP TABLE IF EXISTS staff_group_members;
DROP TABLE IF EXISTS staff_groups;
DROP TABLE IF EXISTS shift_group_members;
DROP TABLE IF EXISTS shift_groups;
DROP TABLE IF EXISTS shift_type_weekday_demand;
DROP TABLE IF EXISTS shift_types;

-- The column last: `valid_groups`' ceiling trigger reads it, and the trigger is
-- already gone by here.
ALTER TABLE groups DROP COLUMN IF EXISTS pick_position_count;
