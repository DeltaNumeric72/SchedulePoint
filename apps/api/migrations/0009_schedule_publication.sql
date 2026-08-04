-- 0009_schedule_publication.sql
--
-- OPUS-M3-003 — Schedule periods, the identity/snapshot assignment model, and
-- the publication spine (SPEC-05). Manual content only: NO solver, NO build
-- pipeline, NO UI. Manual scheduling is override / recovery / fixed-assignment
-- input, never the production mechanism (non-bypass rule 7).
--
-- Governing documents: SPEC-05 (identity vs snapshot §1; D-1a/D-1b §2+§2.1;
-- states+lock §3; D-15a/b/c §4+§4.1; current selection §5; publication §6;
-- amend/revert §6.1; cloning §7), doc 06 §3.2/§3.3 schedule tables + §4
-- invariants (D-1a, D-1b, D-2, D-9, D-14, D-15a-d, D-16, D-17), doc 07.
--
-- Numbering: 0008 is reserved for OPUS-M3-002 (the parallel packet); this file
-- is 0009 per packet 32 §6. The second merger renumbers if 002 merges first.
--
-- `btree_gist` is already created by migration 0002 (`CREATE EXTENSION IF NOT
-- EXISTS btree_gist`), so every `EXCLUDE USING gist (… WITH =, … WITH &&)`
-- below has its operator classes.
--
-- Tenant model: every table carries organization_id + group_id, is RLS
-- ENABLE+FORCE with the conjunctive group predicate, and references its parents
-- through COMPOSITE tenant keys so a single-column FK cannot bypass RLS (X-06).

-- Up Migration

------------------------------------------------------------------------------
-- groups.timezone (carried M2 item 4).
--
-- Shift-local semantics (doc 06 §Time: "Shift-local semantics resolve against
-- the group timezone") need a per-group zone. NOT NULL with a backfilling
-- DEFAULT: existing synthetic fixtures created before this migration take
-- 'UTC'. This is a DECLARED backfill default (there is no real customer data;
-- every fixture is synthetic), recorded here per the packet. The administration
-- surface that lets a group change it is OPUS-M3-007; this migration only makes
-- the column exist and be non-null.
------------------------------------------------------------------------------

ALTER TABLE groups ADD COLUMN timezone text NOT NULL DEFAULT 'UTC';

ALTER TABLE groups
    ADD CONSTRAINT groups_timezone_nonempty CHECK (length(timezone) BETWEEN 1 AND 64);

GRANT UPDATE (timezone) ON groups TO app_runtime, app_worker;

------------------------------------------------------------------------------
-- schedule_periods — a bounded planning date range (doc 07 §1: "NOT a
-- schedule"). D-2: no overlapping periods per group.
------------------------------------------------------------------------------

CREATE TABLE schedule_periods (
    id               uuid PRIMARY KEY,
    organization_id  uuid NOT NULL REFERENCES organizations (id),
    group_id         uuid NOT NULL,
    name             text NOT NULL,
    start_date       date NOT NULL,
    end_date         date NOT NULL,
    status           text NOT NULL DEFAULT 'planning',
    period_version   bigint NOT NULL DEFAULT 1,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT schedule_periods_name_len CHECK (length(name) BETWEEN 1 AND 200),
    CONSTRAINT schedule_periods_status_domain
        CHECK (status IN ('planning', 'published', 'closed')),
    CONSTRAINT schedule_periods_dates CHECK (end_date >= start_date),

    CONSTRAINT schedule_periods_tenant_identity UNIQUE (id, organization_id, group_id),
    CONSTRAINT schedule_periods_name_unique_in_group UNIQUE (organization_id, group_id, name),
    CONSTRAINT schedule_periods_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id),

    -- D-2: no overlapping periods per group. daterange is inclusive on both
    -- ends ('[]') because end_date is the period's last included day, so two
    -- periods that share a boundary day genuinely overlap.
    CONSTRAINT schedule_periods_no_overlap
        EXCLUDE USING gist (
            organization_id WITH =,
            group_id        WITH =,
            daterange(start_date, end_date, '[]') WITH &&
        )
);

ALTER TABLE schedule_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_periods FORCE  ROW LEVEL SECURITY;
CREATE POLICY schedule_periods_group_scope ON schedule_periods
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

------------------------------------------------------------------------------
-- schedule_versions — draft/in_review/approved/publishing/published/superseded/
-- cancelled. `lock_state` is the single editability concept (SPEC-05 §3.2),
-- CHECK-rejected on a published/superseded row. D-9 gapless version_number per
-- period; D-16 exactly one current per period. Never hard-deleted (D-15c).
--
-- Declared BEFORE schedule_periods' children that only reference versions, and
-- AFTER schedule_periods, because a version belongs to a period. Self-references
-- (cloned_from, superseded_by) are added as FKs after the table exists.
------------------------------------------------------------------------------

CREATE TABLE schedule_versions (
    id                        uuid PRIMARY KEY,
    organization_id           uuid NOT NULL REFERENCES organizations (id),
    group_id                  uuid NOT NULL,
    period_id                 uuid NOT NULL,
    -- NULL until published; allocated gaplessly inside the publication
    -- transaction (D-9). A draft/approved version has no number yet.
    version_number            integer,
    -- No FK: build_runs is the M4 solver pipeline and does not exist. Manual
    -- content leaves this NULL; the column exists per doc 06 §3.2 so a later
    -- build-applied version can record its provenance without a schema change.
    source_build_id           uuid,
    cloned_from_version_id     uuid,
    state                     text NOT NULL DEFAULT 'draft',
    lock_state                text NOT NULL DEFAULT 'unlocked',
    is_current                boolean NOT NULL DEFAULT false,
    circulation_state         text NOT NULL DEFAULT 'not_circulated',
    -- Scheduler-authored administrative note (not a clinical or ingestion path;
    -- I-07 governs patient data and audit PAYLOADS, and this value never enters
    -- an audit payload — the closed-payload rule would reject free text anyway).
    change_summary            text,
    published_at              timestamptz,
    published_by              uuid,
    superseded_at             timestamptz,
    superseded_by_version_id  uuid,
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT schedule_versions_state_domain
        CHECK (state IN ('draft', 'in_review', 'approved', 'publishing',
                         'published', 'superseded', 'cancelled')),
    CONSTRAINT schedule_versions_lock_domain
        CHECK (lock_state IN ('unlocked', 'locked')),
    CONSTRAINT schedule_versions_circulation_domain
        CHECK (circulation_state IN ('not_circulated', 'circulated')),
    CONSTRAINT schedule_versions_summary_len
        CHECK (change_summary IS NULL OR length(change_summary) BETWEEN 1 AND 1000),
    -- SPEC-05 §3.2: lock is meaningless on a published/superseded row, which is
    -- immutable regardless — a published version must be unlocked.
    CONSTRAINT schedule_versions_no_lock_when_frozen
        CHECK (state NOT IN ('published', 'superseded') OR lock_state = 'unlocked'),
    -- A numbered version is a published/superseded one; drafts have no number.
    CONSTRAINT schedule_versions_number_when_published
        CHECK ((state IN ('published', 'superseded')) = (version_number IS NOT NULL)),
    CONSTRAINT schedule_versions_supersession_pair
        CHECK ((superseded_at IS NULL) = (superseded_by_version_id IS NULL)),
    CONSTRAINT schedule_versions_published_meta
        CHECK ((state IN ('published', 'superseded')) OR
               (published_at IS NULL AND published_by IS NULL)),

    CONSTRAINT schedule_versions_tenant_identity UNIQUE (id, organization_id, group_id),
    -- D-9: gapless version numbers per period. NULLs are distinct, so many
    -- unnumbered drafts coexist.
    CONSTRAINT schedule_versions_number_unique UNIQUE (organization_id, group_id, period_id, version_number),
    CONSTRAINT schedule_versions_period_fk
        FOREIGN KEY (period_id, organization_id, group_id)
        REFERENCES schedule_periods (id, organization_id, group_id),
    CONSTRAINT schedule_versions_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id)
);

-- Self-references (same table), added after the table exists.
ALTER TABLE schedule_versions
    ADD CONSTRAINT schedule_versions_cloned_from_fk
        FOREIGN KEY (cloned_from_version_id, organization_id, group_id)
        REFERENCES schedule_versions (id, organization_id, group_id);
ALTER TABLE schedule_versions
    ADD CONSTRAINT schedule_versions_superseded_by_fk
        FOREIGN KEY (superseded_by_version_id, organization_id, group_id)
        REFERENCES schedule_versions (id, organization_id, group_id);
ALTER TABLE schedule_versions
    ADD CONSTRAINT schedule_versions_published_by_fk
        FOREIGN KEY (published_by, organization_id)
        REFERENCES memberships (id, organization_id);

-- D-16: exactly one current version per period. A partial unique index is the
-- mechanism the SPEC names — it makes "two current versions" unrepresentable.
--
-- TENANT-QUALIFIED, and that is not decoration. X-11 requires every unique key
-- on a tenant table to lead with the tenant columns so a 23505 stays inside the
-- caller's own tenant and cannot become a cross-tenant existence oracle. This
-- costs D-16 nothing: `period_id` already determines the organization and group
-- (a period belongs to exactly one of each, enforced by the composite FK), so
-- "one current per (organization, group, period)" and "one current per period"
-- are the same constraint — one of them just cannot leak.
CREATE UNIQUE INDEX schedule_versions_one_current_per_period
    ON schedule_versions (organization_id, group_id, period_id)
    WHERE is_current;

CREATE INDEX schedule_versions_by_period ON schedule_versions (organization_id, group_id, period_id);

ALTER TABLE schedule_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_versions FORCE  ROW LEVEL SECURITY;
CREATE POLICY schedule_versions_group_scope ON schedule_versions
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

------------------------------------------------------------------------------
-- schedule_requirements — period-scoped staffing demand (doc 07 §1: "How much
-- staffing is needed on a date for a shift type"). Period instances; the
-- catalogue's per-weekday demand defaults (FAD-16) stay in M2.
------------------------------------------------------------------------------

CREATE TABLE schedule_requirements (
    id               uuid PRIMARY KEY,
    organization_id  uuid NOT NULL REFERENCES organizations (id),
    group_id         uuid NOT NULL,
    period_id        uuid NOT NULL,
    date             date NOT NULL,
    shift_type_id    uuid NOT NULL,
    required_count   integer NOT NULL,
    requirement_version bigint NOT NULL DEFAULT 1,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT schedule_requirements_count_nonneg CHECK (required_count >= 0),
    CONSTRAINT schedule_requirements_tenant_identity UNIQUE (id, organization_id, group_id),
    CONSTRAINT schedule_requirements_unique
        UNIQUE (organization_id, group_id, period_id, date, shift_type_id),
    CONSTRAINT schedule_requirements_period_fk
        FOREIGN KEY (period_id, organization_id, group_id)
        REFERENCES schedule_periods (id, organization_id, group_id),
    CONSTRAINT schedule_requirements_shift_type_fk
        FOREIGN KEY (shift_type_id, organization_id, group_id)
        REFERENCES shift_types (id, organization_id, group_id),
    CONSTRAINT schedule_requirements_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id)
);

ALTER TABLE schedule_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_requirements FORCE  ROW LEVEL SECURITY;
CREATE POLICY schedule_requirements_group_scope ON schedule_requirements
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

------------------------------------------------------------------------------
-- shifts — an instance of a shift type on a date within a version (doc 07 §1).
-- A version child (D-15a). location_id is nullable with NO FK: the `locations`
-- table lands in OPUS-M3-007; the column exists per doc 06 §3.2 so a later
-- migration only adds the FK.
------------------------------------------------------------------------------

CREATE TABLE shifts (
    id               uuid PRIMARY KEY,
    organization_id  uuid NOT NULL REFERENCES organizations (id),
    group_id         uuid NOT NULL,
    version_id       uuid NOT NULL,
    date             date NOT NULL,
    shift_type_id    uuid NOT NULL,
    location_id      uuid,
    required_count   integer NOT NULL DEFAULT 0,
    shift_version    bigint NOT NULL DEFAULT 1,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT shifts_count_nonneg CHECK (required_count >= 0),
    CONSTRAINT shifts_tenant_identity UNIQUE (id, organization_id, group_id),
    CONSTRAINT shifts_version_fk
        FOREIGN KEY (version_id, organization_id, group_id)
        REFERENCES schedule_versions (id, organization_id, group_id),
    CONSTRAINT shifts_shift_type_fk
        FOREIGN KEY (shift_type_id, organization_id, group_id)
        REFERENCES shift_types (id, organization_id, group_id),
    CONSTRAINT shifts_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id)
);

-- One shift per (version, date, shift_type, location). COALESCE gives a stable
-- key when location is absent (NULLs would otherwise be distinct).
CREATE UNIQUE INDEX shifts_unique_in_version
    ON shifts (organization_id, group_id, version_id, date, shift_type_id,
               coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid));

ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts FORCE  ROW LEVEL SECURITY;
CREATE POLICY shifts_group_scope ON shifts
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

------------------------------------------------------------------------------
-- assignment_identities — the stable thing a human means by "that assignment"
-- (SPEC-05 §1). Spans versions, carries no schedule values, NEVER deleted.
------------------------------------------------------------------------------

CREATE TABLE assignment_identities (
    id               uuid PRIMARY KEY,
    organization_id  uuid NOT NULL REFERENCES organizations (id),
    group_id         uuid NOT NULL,
    period_id        uuid NOT NULL,
    origin           text NOT NULL DEFAULT 'manual',
    created_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT assignment_identities_origin_domain
        CHECK (origin IN ('manual', 'clone', 'solver', 'picklist')),
    CONSTRAINT assignment_identities_tenant_identity UNIQUE (id, organization_id, group_id),
    CONSTRAINT assignment_identities_period_fk
        FOREIGN KEY (period_id, organization_id, group_id)
        REFERENCES schedule_periods (id, organization_id, group_id),
    CONSTRAINT assignment_identities_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id)
);

ALTER TABLE assignment_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignment_identities FORCE  ROW LEVEL SECURITY;
CREATE POLICY assignment_identities_group_scope ON assignment_identities
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

------------------------------------------------------------------------------
-- assignment_snapshots — one person, one shift, one date, in one version
-- (SPEC-05 §1). D-14: one snapshot per identity per version. D-1a: overlap
-- exclusion scoped BY version_id (incl. across midnight), which is what makes
-- cloning possible. `is_pinned` (renamed from is_locked, SPEC-05 §3.2) is a
-- solver input, not an editing control. Immutable once its version is published
-- (D-15a, trigger). Optimistic draft-edit concurrency via snapshot_version
-- (doc 07 §3.1).
------------------------------------------------------------------------------

CREATE TABLE assignment_snapshots (
    id                       uuid PRIMARY KEY,
    organization_id          uuid NOT NULL REFERENCES organizations (id),
    group_id                 uuid NOT NULL,
    assignment_identity_id   uuid NOT NULL,
    version_id               uuid NOT NULL,
    membership_id            uuid NOT NULL,
    shift_id                 uuid NOT NULL,
    date                     date NOT NULL,
    starts_at                timestamptz NOT NULL,
    ends_at                  timestamptz NOT NULL,
    origin                   text NOT NULL DEFAULT 'manual',
    pick_position            integer,
    is_pinned                boolean NOT NULL DEFAULT false,
    status                   text NOT NULL DEFAULT 'active',
    supersedes_snapshot_id   uuid,
    -- The required reason a manual OVERRIDE carries. Non-clinical admin text;
    -- never placed in an audit payload.
    override_reason          text,
    snapshot_version         bigint NOT NULL DEFAULT 1,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT assignment_snapshots_origin_domain
        CHECK (origin IN ('manual', 'clone', 'solver', 'picklist')),
    CONSTRAINT assignment_snapshots_status_domain
        CHECK (status IN ('active', 'cancelled')),
    CONSTRAINT assignment_snapshots_interval CHECK (ends_at > starts_at),
    CONSTRAINT assignment_snapshots_pick_nonneg
        CHECK (pick_position IS NULL OR pick_position >= 0),
    CONSTRAINT assignment_snapshots_reason_len
        CHECK (override_reason IS NULL OR length(override_reason) BETWEEN 1 AND 500),
    CONSTRAINT assignment_snapshots_tenant_identity UNIQUE (id, organization_id, group_id),
    -- D-14: one snapshot per identity per version.
    CONSTRAINT assignment_snapshots_one_per_identity_version
        UNIQUE (organization_id, group_id, version_id, assignment_identity_id),
    CONSTRAINT assignment_snapshots_identity_fk
        FOREIGN KEY (assignment_identity_id, organization_id, group_id)
        REFERENCES assignment_identities (id, organization_id, group_id),
    CONSTRAINT assignment_snapshots_version_fk
        FOREIGN KEY (version_id, organization_id, group_id)
        REFERENCES schedule_versions (id, organization_id, group_id),
    CONSTRAINT assignment_snapshots_shift_fk
        FOREIGN KEY (shift_id, organization_id, group_id)
        REFERENCES shifts (id, organization_id, group_id),
    CONSTRAINT assignment_snapshots_membership_fk
        FOREIGN KEY (membership_id, organization_id)
        REFERENCES memberships (id, organization_id),
    CONSTRAINT assignment_snapshots_supersedes_fk
        FOREIGN KEY (supersedes_snapshot_id, organization_id, group_id)
        REFERENCES assignment_snapshots (id, organization_id, group_id),
    CONSTRAINT assignment_snapshots_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id),

    -- D-1a: no overlapping ACTIVE assignments for one membership within a
    -- single version, including across midnight. version_id in the equality
    -- columns is the entire fix — the old D-1 omitted it, so cloning a published
    -- version collided with its own identical rows. tstzrange spans midnight
    -- naturally, so an overnight pair is caught.
    CONSTRAINT assignment_snapshots_no_overlap_in_version
        EXCLUDE USING gist (
            version_id    WITH =,
            membership_id WITH =,
            tstzrange(starts_at, ends_at) WITH &&
        ) WHERE (status = 'active')
);

CREATE INDEX assignment_snapshots_by_version
    ON assignment_snapshots (organization_id, group_id, version_id);
CREATE INDEX assignment_snapshots_by_identity
    ON assignment_snapshots (organization_id, group_id, assignment_identity_id);

ALTER TABLE assignment_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignment_snapshots FORCE  ROW LEVEL SECURITY;
CREATE POLICY assignment_snapshots_group_scope ON assignment_snapshots
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

------------------------------------------------------------------------------
-- credits — fairness accounting, deliberately separate from the assignment
-- (doc 07 "tenth concept"). V-23 keying: identity + source_version +
-- source_snapshot. Credited membership may differ from the assignee, by design.
-- A version child (D-15a): a credit's route to its parent version is
-- source_version_id.
------------------------------------------------------------------------------

CREATE TABLE credits (
    id                       uuid PRIMARY KEY,
    organization_id          uuid NOT NULL REFERENCES organizations (id),
    group_id                 uuid NOT NULL,
    assignment_identity_id   uuid NOT NULL,
    source_version_id        uuid NOT NULL,
    source_snapshot_id       uuid NOT NULL,
    credited_membership_id   uuid NOT NULL,
    weight                   numeric(6, 3) NOT NULL DEFAULT 1.0,
    reason                   text,
    moved_by                 uuid,
    status                   text NOT NULL DEFAULT 'active',
    credit_version           bigint NOT NULL DEFAULT 1,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT credits_status_domain CHECK (status IN ('active', 'reassigned', 'voided')),
    CONSTRAINT credits_weight_nonneg CHECK (weight >= 0),
    CONSTRAINT credits_reason_len CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
    CONSTRAINT credits_tenant_identity UNIQUE (id, organization_id, group_id),
    -- V-23: keyed exactly as opportunities is (CAR-018 parity).
    CONSTRAINT credits_unique_per_identity_version
        UNIQUE (organization_id, group_id, assignment_identity_id, source_version_id),
    CONSTRAINT credits_identity_fk
        FOREIGN KEY (assignment_identity_id, organization_id, group_id)
        REFERENCES assignment_identities (id, organization_id, group_id),
    CONSTRAINT credits_source_version_fk
        FOREIGN KEY (source_version_id, organization_id, group_id)
        REFERENCES schedule_versions (id, organization_id, group_id),
    CONSTRAINT credits_source_snapshot_fk
        FOREIGN KEY (source_snapshot_id, organization_id, group_id)
        REFERENCES assignment_snapshots (id, organization_id, group_id),
    CONSTRAINT credits_credited_membership_fk
        FOREIGN KEY (credited_membership_id, organization_id)
        REFERENCES memberships (id, organization_id),
    CONSTRAINT credits_moved_by_fk
        FOREIGN KEY (moved_by, organization_id)
        REFERENCES memberships (id, organization_id),
    CONSTRAINT credits_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id)
);

CREATE INDEX credits_by_source_version
    ON credits (organization_id, group_id, source_version_id);

ALTER TABLE credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE credits FORCE  ROW LEVEL SECURITY;
CREATE POLICY credits_group_scope ON credits
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

------------------------------------------------------------------------------
-- schedule_conflicts — sign-off is blocked while any hard-breach is open
-- (doc 06 §3.3). A version child (D-15a): version_id (nullable — a conflict may
-- attach to a build result instead, which is M4 and left NULL here).
------------------------------------------------------------------------------

CREATE TABLE schedule_conflicts (
    id               uuid PRIMARY KEY,
    organization_id  uuid NOT NULL REFERENCES organizations (id),
    group_id         uuid NOT NULL,
    version_id       uuid,
    severity         text NOT NULL,
    refs             jsonb NOT NULL DEFAULT '{}'::jsonb,
    explanation      text,
    remediation      text,
    state            text NOT NULL DEFAULT 'open',
    conflict_version bigint NOT NULL DEFAULT 1,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT schedule_conflicts_severity_domain
        CHECK (severity IN ('hard-breach', 'soft', 'info')),
    CONSTRAINT schedule_conflicts_state_domain
        CHECK (state IN ('open', 'accepted', 'resolved')),
    CONSTRAINT schedule_conflicts_explanation_len
        CHECK (explanation IS NULL OR length(explanation) BETWEEN 1 AND 2000),
    CONSTRAINT schedule_conflicts_remediation_len
        CHECK (remediation IS NULL OR length(remediation) BETWEEN 1 AND 2000),
    CONSTRAINT schedule_conflicts_tenant_identity UNIQUE (id, organization_id, group_id),
    CONSTRAINT schedule_conflicts_version_fk
        FOREIGN KEY (version_id, organization_id, group_id)
        REFERENCES schedule_versions (id, organization_id, group_id),
    CONSTRAINT schedule_conflicts_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id)
);

CREATE INDEX schedule_conflicts_by_version
    ON schedule_conflicts (organization_id, group_id, version_id);

ALTER TABLE schedule_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_conflicts FORCE  ROW LEVEL SECURITY;
CREATE POLICY schedule_conflicts_group_scope ON schedule_conflicts
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

------------------------------------------------------------------------------
-- publication_records — the append-only record of a publication (doc 06 §3.3,
-- D-15d, D-17). SINGLE-transaction publication writes one row at commit with
-- outcome='published'; a failed attempt rolls back and leaves no row. D-17:
-- unique (period, idempotency_key) makes a retried publication publish once.
-- Grant model gives it INSERT+SELECT only (no UPDATE/DELETE) — D-15d literal.
------------------------------------------------------------------------------

CREATE TABLE publication_records (
    id                          uuid PRIMARY KEY,
    organization_id             uuid NOT NULL REFERENCES organizations (id),
    group_id                    uuid NOT NULL,
    period_id                   uuid NOT NULL,
    version_id                  uuid NOT NULL,
    publication_idempotency_key text NOT NULL,
    actor_membership_id         uuid,
    prerequisites_snapshot      jsonb NOT NULL DEFAULT '{}'::jsonb,
    outcome                     text NOT NULL DEFAULT 'published',
    created_at                  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT publication_records_outcome_domain
        CHECK (outcome IN ('published', 'failed')),
    -- FAD-22(3): ONE domain for the publication idempotency key, validated at
    -- the contract layer and CHECK-enforced here. 64 characters is sized so the
    -- composed outbox key (`schedule-publish:<period uuid>:<key>`) also
    -- satisfies SPEC-07's outbox-key constraint. The contract layer answers 422
    -- for a key outside the domain, so this CHECK is the backstop and never the
    -- first thing a caller meets.
    CONSTRAINT publication_records_key_domain
        CHECK (publication_idempotency_key ~ '^[A-Za-z0-9_.-]{1,64}$'),
    CONSTRAINT publication_records_tenant_identity UNIQUE (id, organization_id, group_id),
    -- D-17: publication is idempotent.
    CONSTRAINT publication_records_idempotent
        UNIQUE (organization_id, group_id, period_id, publication_idempotency_key),
    -- One published record per version.
    CONSTRAINT publication_records_one_per_version UNIQUE (organization_id, group_id, version_id),
    CONSTRAINT publication_records_period_fk
        FOREIGN KEY (period_id, organization_id, group_id)
        REFERENCES schedule_periods (id, organization_id, group_id),
    CONSTRAINT publication_records_version_fk
        FOREIGN KEY (version_id, organization_id, group_id)
        REFERENCES schedule_versions (id, organization_id, group_id),
    CONSTRAINT publication_records_actor_fk
        FOREIGN KEY (actor_membership_id, organization_id)
        REFERENCES memberships (id, organization_id),
    CONSTRAINT publication_records_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id)
);

ALTER TABLE publication_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE publication_records FORCE  ROW LEVEL SECURITY;
CREATE POLICY publication_records_group_scope ON publication_records
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

------------------------------------------------------------------------------
-- version_supersessions — append-only supersession log (doc 06 §3.3, D-15d).
------------------------------------------------------------------------------

CREATE TABLE version_supersessions (
    id                       uuid PRIMARY KEY,
    organization_id          uuid NOT NULL REFERENCES organizations (id),
    group_id                 uuid NOT NULL,
    superseded_version_id    uuid NOT NULL,
    superseding_version_id   uuid NOT NULL,
    superseded_at            timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT version_supersessions_distinct
        CHECK (superseded_version_id <> superseding_version_id),
    CONSTRAINT version_supersessions_tenant_identity UNIQUE (id, organization_id, group_id),
    CONSTRAINT version_supersessions_pair_unique
        UNIQUE (organization_id, group_id, superseded_version_id, superseding_version_id),
    CONSTRAINT version_supersessions_superseded_fk
        FOREIGN KEY (superseded_version_id, organization_id, group_id)
        REFERENCES schedule_versions (id, organization_id, group_id),
    CONSTRAINT version_supersessions_superseding_fk
        FOREIGN KEY (superseding_version_id, organization_id, group_id)
        REFERENCES schedule_versions (id, organization_id, group_id),
    CONSTRAINT version_supersessions_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id)
);

ALTER TABLE version_supersessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE version_supersessions FORCE  ROW LEVEL SECURITY;
CREATE POLICY version_supersessions_group_scope ON version_supersessions
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

------------------------------------------------------------------------------
-- current_published_assignments — reality (V-21 / FD-8). A REAL table (not a
-- view) so D-1b's EXCLUDE constraint can live on it and it is inside the
-- fail-closed RLS model. Maintained ONLY inside the publication transaction
-- (delete outgoing / insert incoming). D-1b: a person is not double-booked in
-- reality, regardless of which period's schedule put them there — deliberately
-- NO version_id / period_id in the equality columns (SPEC-05 §2.1).
------------------------------------------------------------------------------

CREATE TABLE current_published_assignments (
    id                       uuid PRIMARY KEY,
    organization_id          uuid NOT NULL REFERENCES organizations (id),
    group_id                 uuid NOT NULL,
    membership_id            uuid NOT NULL,
    period_id                uuid NOT NULL,
    starts_at                timestamptz NOT NULL,
    ends_at                  timestamptz NOT NULL,
    source_version_id        uuid NOT NULL,
    source_snapshot_id       uuid NOT NULL,
    assignment_identity_id   uuid NOT NULL,

    CONSTRAINT current_published_assignments_interval CHECK (ends_at > starts_at),
    CONSTRAINT current_published_assignments_tenant_identity UNIQUE (id, organization_id, group_id),
    CONSTRAINT current_published_assignments_period_fk
        FOREIGN KEY (period_id, organization_id, group_id)
        REFERENCES schedule_periods (id, organization_id, group_id),
    CONSTRAINT current_published_assignments_version_fk
        FOREIGN KEY (source_version_id, organization_id, group_id)
        REFERENCES schedule_versions (id, organization_id, group_id),
    CONSTRAINT current_published_assignments_snapshot_fk
        FOREIGN KEY (source_snapshot_id, organization_id, group_id)
        REFERENCES assignment_snapshots (id, organization_id, group_id),
    CONSTRAINT current_published_assignments_identity_fk
        FOREIGN KEY (assignment_identity_id, organization_id, group_id)
        REFERENCES assignment_identities (id, organization_id, group_id),
    CONSTRAINT current_published_assignments_membership_fk
        FOREIGN KEY (membership_id, organization_id)
        REFERENCES memberships (id, organization_id),
    CONSTRAINT current_published_assignments_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id),

    -- D-1b: no overlapping assignments for one membership across the current
    -- published versions of different periods. A cross-period double-booking
    -- fails the PUBLISHING transaction here (SPEC-05 §2.1, §6 step 12).
    --
    -- `organization_id` leads the equality columns (N-5, from the independent
    -- review). Without it, a 23P01 raised against a row in ANOTHER organization
    -- is a cross-tenant existence oracle: the violation message discloses that
    -- somebody, somewhere, holds an overlapping interval. This does NOT weaken
    -- D-1b, because a membership belongs to exactly one organization — two rows
    -- sharing a `membership_id` necessarily share an `organization_id`, so the
    -- added equality can never separate a pair the old form caught. It stays
    -- deliberately free of `group_id` and `period_id`: a person cannot be in two
    -- places in reality regardless of which group's or period's schedule put
    -- them there, and the cross-GROUP same-organization collision is asserted.
    CONSTRAINT current_published_assignments_no_double_book
        EXCLUDE USING gist (
            organization_id WITH =,
            membership_id   WITH =,
            tstzrange(starts_at, ends_at) WITH &&
        )
);

CREATE INDEX current_published_assignments_by_source_version
    ON current_published_assignments (organization_id, group_id, source_version_id);

ALTER TABLE current_published_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE current_published_assignments FORCE  ROW LEVEL SECURITY;
CREATE POLICY current_published_assignments_group_scope ON current_published_assignments
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

------------------------------------------------------------------------------
-- D-15: database-enforced published immutability (I-18).
--
-- Triggers rather than grants, because the permission depends on the PARENT
-- row's state — which only a trigger can evaluate (SPEC-05 §4). The application
-- legitimately holds UPDATE on assignment_snapshots — for DRAFT versions.
------------------------------------------------------------------------------

-- Helper: is a version's row frozen (published or superseded)? SECURITY DEFINER
-- so the immutability guard reads the parent state even where RLS would hide it
-- — an immutability check must never fail OPEN because a row was invisible.
CREATE FUNCTION app_schedule_version_is_frozen(p_version_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_state text;
BEGIN
    IF p_version_id IS NULL THEN
        RETURN false;
    END IF;
    SELECT state INTO v_state FROM schedule_versions WHERE id = p_version_id;
    RETURN v_state IN ('published', 'superseded');
END;
$$;

REVOKE ALL ON FUNCTION app_schedule_version_is_frozen(uuid) FROM PUBLIC;

-- D-15a: child rows of a published/superseded version are immutable. Two static
-- functions (no dynamic SQL): one for children whose parent link is `version_id`
-- (assignment_snapshots, shifts, schedule_conflicts) and one for `credits`,
-- whose parent link is `source_version_id` (V-23 keying). BEFORE DELETE returns
-- OLD; BEFORE UPDATE returns NEW.
-- SECURITY DEFINER on the two child guards, for the same reason 0007's
-- `app_session_assign_epoch` is: they call a SECURITY DEFINER helper that is
-- deliberately `REVOKE ALL ... FROM PUBLIC`. Running the guard as its owner is
-- what lets it reach the helper WITHOUT granting the application roles EXECUTE
-- on it — a direct grant would let any runtime caller ask "is this arbitrary
-- version id frozen?" about a version in another tenant, which is a small
-- cross-tenant existence oracle and not one worth opening to spare a keyword.
CREATE FUNCTION app_guard_version_child_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_incoming uuid;
    v_outgoing uuid;
BEGIN
    -- FAD-22(1): INSERT is covered too. A `BEFORE UPDATE OR DELETE`-only guard
    -- let a published version's child SET GROW — a new snapshot attached to a
    -- published `version_id` changes the version's content and its re-derived
    -- affected-staff set while every pre-existing row stays "immutable". I-18
    -- says "its row and EVERY CHILD ROW are immutable", which is
    -- set-immutability, not row-immutability.
    --
    -- Both sides of an UPDATE are checked: moving a row INTO a published
    -- version is the same attack as editing one already there.
    IF TG_OP <> 'DELETE' THEN v_incoming := NEW.version_id; END IF;
    IF TG_OP <> 'INSERT' THEN v_outgoing := OLD.version_id; END IF;

    IF app_schedule_version_is_frozen(v_incoming) THEN
        RAISE EXCEPTION
            'SCHEDULE_PUBLISHED_IMMUTABLE: % on % is refused because version % is published or '
            'superseded (D-15a, I-18); amend by cloning and publishing forward',
            TG_OP, TG_TABLE_NAME, v_incoming
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF app_schedule_version_is_frozen(v_outgoing) THEN
        RAISE EXCEPTION
            'SCHEDULE_PUBLISHED_IMMUTABLE: % on %.id=% is refused because its version % is '
            'published or superseded (D-15a, I-18); amend by cloning and publishing forward',
            TG_OP, TG_TABLE_NAME, OLD.id, v_outgoing
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

REVOKE ALL ON FUNCTION app_guard_version_child_immutable() FROM PUBLIC;

CREATE FUNCTION app_guard_credit_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_incoming uuid;
    v_outgoing uuid;
BEGIN
    -- FAD-22(1), the `credits` arm: its route to a parent version is
    -- `source_version_id` (V-23 keying). A credit INSERTed against a published
    -- version was accepted and then permanently frozen — an uncorrectable
    -- credit written against immutable history. A post-publication credit
    -- correction belongs on a DRAFT of the next version.
    IF TG_OP <> 'DELETE' THEN v_incoming := NEW.source_version_id; END IF;
    IF TG_OP <> 'INSERT' THEN v_outgoing := OLD.source_version_id; END IF;

    IF app_schedule_version_is_frozen(v_incoming) THEN
        RAISE EXCEPTION
            'SCHEDULE_PUBLISHED_IMMUTABLE: % on credits is refused because source version % is '
            'published or superseded (D-15a, V-23, I-18); credit a draft of the next version',
            TG_OP, v_incoming
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF app_schedule_version_is_frozen(v_outgoing) THEN
        RAISE EXCEPTION
            'SCHEDULE_PUBLISHED_IMMUTABLE: % on credits.id=% is refused because its source '
            'version % is published or superseded (D-15a, V-23, I-18)',
            TG_OP, OLD.id, v_outgoing
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

REVOKE ALL ON FUNCTION app_guard_credit_immutable() FROM PUBLIC;

CREATE TRIGGER assignment_snapshots_immutable_when_published
    BEFORE INSERT OR UPDATE OR DELETE ON assignment_snapshots
    FOR EACH ROW EXECUTE FUNCTION app_guard_version_child_immutable();
CREATE TRIGGER shifts_immutable_when_published
    BEFORE INSERT OR UPDATE OR DELETE ON shifts
    FOR EACH ROW EXECUTE FUNCTION app_guard_version_child_immutable();
CREATE TRIGGER schedule_conflicts_immutable_when_published
    BEFORE INSERT OR UPDATE OR DELETE ON schedule_conflicts
    FOR EACH ROW EXECUTE FUNCTION app_guard_version_child_immutable();
CREATE TRIGGER credits_immutable_when_published
    BEFORE INSERT OR UPDATE OR DELETE ON credits
    FOR EACH ROW EXECUTE FUNCTION app_guard_credit_immutable();

-- D-15b: on a published/superseded version row, permit ONLY the transitions in
-- SPEC-05 §4.1, each via its defined transition; freeze every other column. The
-- generic jsonb diff (everything except the four permitted columns) makes "no
-- column untested" (V-18) structural rather than a hand-maintained list.
CREATE FUNCTION app_guard_schedule_version_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
    -- Only frozen rows are restricted; drafts and pre-publication states edit
    -- freely (the publication transition approved -> publishing -> published is
    -- OLD.state NOT IN (published, superseded), so it is never gated here).
    IF OLD.state NOT IN ('published', 'superseded') THEN
        RETURN NEW;
    END IF;

    -- 1. Every column EXCEPT the five permitted ones must be byte-identical.
    --
    --    `lock_state` is in the permitted set because SPEC-05 §4.1 puts it
    --    there — "listed here so the trigger's set is complete and reviewable".
    --    In practice it cannot actually move to 'locked' on a frozen row: the
    --    §3.2 CHECK (`schedule_versions_no_lock_when_frozen`) rejects that
    --    independently. So the trigger permits the column and the CHECK refuses
    --    the value, which is exactly the division §4.1 describes, and V-17
    --    proves it by observing WHICH control refuses.
    IF (to_jsonb(NEW) - 'is_current' - 'state' - 'superseded_at'
                      - 'superseded_by_version_id' - 'lock_state')
       IS DISTINCT FROM
       (to_jsonb(OLD) - 'is_current' - 'state' - 'superseded_at'
                      - 'superseded_by_version_id' - 'lock_state') THEN
        RAISE EXCEPTION
            'SCHEDULE_VERSION_FROZEN_COLUMN: a frozen column changed on published/superseded '
            'version % — only is_current, lock_state, state, superseded_at and '
            'superseded_by_version_id may change, and only via their defined transitions (D-15b)',
            OLD.id
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- 2. Each permitted column, only via its defined transition (V-19 gates the
    --    transition, not merely the column name).
    IF NEW.is_current IS DISTINCT FROM OLD.is_current
       AND NOT (OLD.is_current = true AND NEW.is_current = false) THEN
        RAISE EXCEPTION
            'SCHEDULE_VERSION_ISCURRENT_TRANSITION: is_current may only move true->false on a '
            'frozen version (the outgoing version); false->true happens only in the publication '
            'that sets state=published (D-15b, V-19)'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.state IS DISTINCT FROM OLD.state
       AND NOT (OLD.state = 'published' AND NEW.state = 'superseded') THEN
        RAISE EXCEPTION
            'SCHEDULE_VERSION_STATE_TRANSITION: a frozen version''s state may only move '
            'published->superseded (D-15b, V-19)'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.superseded_at IS DISTINCT FROM OLD.superseded_at
       AND NOT (OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL
                AND NEW.state = 'superseded') THEN
        RAISE EXCEPTION
            'SCHEDULE_VERSION_SUPERSEDED_AT_TRANSITION: superseded_at is set once, NULL->timestamp, '
            'only together with state->superseded (D-15b, V-19)'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.superseded_by_version_id IS DISTINCT FROM OLD.superseded_by_version_id
       AND NOT (OLD.superseded_by_version_id IS NULL AND NEW.superseded_by_version_id IS NOT NULL
                AND NEW.state = 'superseded') THEN
        RAISE EXCEPTION
            'SCHEDULE_VERSION_SUPERSEDED_BY_TRANSITION: superseded_by_version_id is set once, '
            'NULL->id, only together with state->superseded (D-15b, V-19)'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_guard_schedule_version_transition() FROM PUBLIC;

CREATE TRIGGER schedule_versions_transition_guard
    BEFORE UPDATE ON schedule_versions
    FOR EACH ROW EXECUTE FUNCTION app_guard_schedule_version_transition();

-- D-15c: a published/superseded version is never deleted (deletion of history).
CREATE FUNCTION app_guard_schedule_version_no_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
    IF OLD.state IN ('published', 'superseded') THEN
        RAISE EXCEPTION
            'SCHEDULE_VERSION_NO_DELETE: a published or superseded version is never deleted; '
            'supersession retains history and revert publishes forward (D-15c, I-18)'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION app_guard_schedule_version_no_delete() FROM PUBLIC;

CREATE TRIGGER schedule_versions_no_delete_when_published
    BEFORE DELETE ON schedule_versions
    FOR EACH ROW EXECUTE FUNCTION app_guard_schedule_version_no_delete();

-- Append-only enforcement for the publication and supersession records, beyond
-- the grant model (D-15d): even a role that somehow held UPDATE/DELETE is
-- refused. "Rewriting the publication record" is what this prevents.
CREATE FUNCTION app_guard_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
    RAISE EXCEPTION
        'APPEND_ONLY: %.% is append-only; a publication record is never rewritten or deleted (D-15d)',
        TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$;

REVOKE ALL ON FUNCTION app_guard_append_only() FROM PUBLIC;

CREATE TRIGGER publication_records_append_only
    BEFORE UPDATE OR DELETE ON publication_records
    FOR EACH ROW EXECUTE FUNCTION app_guard_append_only();
CREATE TRIGGER version_supersessions_append_only
    BEFORE UPDATE OR DELETE ON version_supersessions
    FOR EACH ROW EXECUTE FUNCTION app_guard_append_only();

------------------------------------------------------------------------------
-- Grants. app_runtime + app_worker write; support/breakglass read. Immutability
-- is enforced by the D-15 triggers and by withholding UPDATE where a table is
-- append-only (publication_records, version_supersessions, assignment_identities).
------------------------------------------------------------------------------

GRANT SELECT, INSERT ON
    schedule_periods, schedule_requirements, schedule_versions, shifts,
    assignment_identities, assignment_snapshots, credits, schedule_conflicts,
    publication_records, version_supersessions, current_published_assignments
    TO app_runtime, app_worker;

-- NOTE: `current_published_assignments` gets NO table-level DELETE grant, even
-- though the publication transaction must delete the outgoing version's rows
-- (§6 step 12). R-05 is standing: **no runtime role holds DELETE on any tenant
-- table** — doc 09 §4 permits no hard delete of tenant data — and a grant here
-- would have quietly widened that envelope for every statement the role can
-- issue, not only for the one the publication needs.
--
-- The prune is therefore a SECURITY DEFINER function. It is NOT a general
-- per-version delete primitive, and the first version of it was — which is the
-- defect the independent review found (B-1): as plain `app_runtime`, in an
-- ordinary unit of work with no publication in flight, it deleted an arbitrary
-- own-tenant version's reality rows, unrecoverably, disarming D-1b within the
-- tenant so a later publication could double-book against emptied reality.
--
-- It is now bound to the publication path by the state of the version itself.
-- Publication clears the outgoing version's `is_current` at step 08 and marks it
-- `superseded` at step 11, BOTH before the step-12 prune — so the legitimate
-- caller always presents a version that is `superseded` and no longer current,
-- and every other caller is refused. Two conditions rather than one, because
-- each fails a different attack:
--
--   * `is_current` must be false — refuses the review's exact probe, which
--     targeted the period's CURRENT version (the only one whose rows are the
--     live reality D-1b is defending);
--   * the state must be `published` or `superseded` — refuses pruning against a
--     draft/approved version, which has no business owning reality rows at all.
--
-- The capability the runtime gains is therefore "retire the reality rows of a
-- version that publication has just stopped being current", not "delete from
-- this table".
CREATE FUNCTION app_schedule_prune_current_assignments(p_source_version_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_organization uuid;
    v_group        uuid;
    v_state        text;
    v_is_current   boolean;
    v_deleted      integer;
BEGIN
    v_organization := nullif(current_setting('app.organization_id', true), '')::uuid;
    v_group        := nullif(current_setting('app.group_id', true), '')::uuid;

    -- Fail closed. Without a tenant context this function would be exactly the
    -- cross-tenant delete the grant model exists to prevent.
    IF v_organization IS NULL OR v_group IS NULL THEN
        RAISE EXCEPTION
            'SCHEDULE_PRUNE_REQUIRES_CONTEXT: current_published_assignments is pruned only '
            'inside a group-scoped unit of work (I-15)'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- The version is read WITHIN the caller's tenant, so this cannot become an
    -- oracle about another tenant's versions either: an id from elsewhere simply
    -- finds no row and is refused as "not prunable".
    SELECT state, is_current
      INTO v_state, v_is_current
      FROM schedule_versions
     WHERE id              = p_source_version_id
       AND organization_id = v_organization
       AND group_id        = v_group;

    IF v_state IS NULL THEN
        RAISE EXCEPTION
            'SCHEDULE_PRUNE_UNKNOWN_VERSION: no such version in this tenant'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF v_is_current THEN
        RAISE EXCEPTION
            'SCHEDULE_PRUNE_VERSION_IS_CURRENT: version % is still the current published '
            'version; its reality rows ARE the live schedule D-1b defends. Only the '
            'publication transaction retires them, after clearing is_current (step 08)',
            p_source_version_id
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF v_state NOT IN ('published', 'superseded') THEN
        RAISE EXCEPTION
            'SCHEDULE_PRUNE_VERSION_NOT_PUBLISHED: version % is %; only a version publication '
            'has superseded owns reality rows to retire',
            p_source_version_id, v_state
            USING ERRCODE = 'restrict_violation';
    END IF;

    DELETE FROM current_published_assignments
     WHERE source_version_id = p_source_version_id
       AND organization_id   = v_organization
       AND group_id          = v_group;

    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION app_schedule_prune_current_assignments(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_schedule_prune_current_assignments(uuid)
    TO app_runtime, app_worker;

GRANT UPDATE (name, start_date, end_date, status, period_version, updated_at)
    ON schedule_periods TO app_runtime, app_worker;
GRANT UPDATE (required_count, requirement_version, updated_at)
    ON schedule_requirements TO app_runtime, app_worker;
GRANT UPDATE (version_number, source_build_id, cloned_from_version_id, state, lock_state,
              is_current, circulation_state, change_summary, published_at, published_by,
              superseded_at, superseded_by_version_id, updated_at)
    ON schedule_versions TO app_runtime, app_worker;
GRANT UPDATE (date, shift_type_id, location_id, required_count, shift_version, updated_at)
    ON shifts TO app_runtime, app_worker;
GRANT UPDATE (membership_id, shift_id, date, starts_at, ends_at, origin, pick_position,
              is_pinned, status, supersedes_snapshot_id, override_reason, snapshot_version, updated_at)
    ON assignment_snapshots TO app_runtime, app_worker;
GRANT UPDATE (credited_membership_id, weight, reason, moved_by, status, credit_version, updated_at)
    ON credits TO app_runtime, app_worker;
GRANT UPDATE (severity, refs, explanation, remediation, state, conflict_version, updated_at)
    ON schedule_conflicts TO app_runtime, app_worker;
-- assignment_identities: no UPDATE — an identity carries no schedule values and
-- is never mutated (SPEC-05 §1). publication_records/version_supersessions: no
-- UPDATE/DELETE grant — append-only (D-15d).

GRANT SELECT ON
    schedule_periods, schedule_requirements, schedule_versions, shifts,
    assignment_identities, assignment_snapshots, credits, schedule_conflicts,
    publication_records, version_supersessions, current_published_assignments
    TO app_readonly_support, app_breakglass;

-- Down Migration

DROP TRIGGER IF EXISTS version_supersessions_append_only ON version_supersessions;
DROP TRIGGER IF EXISTS publication_records_append_only ON publication_records;
DROP TRIGGER IF EXISTS schedule_versions_no_delete_when_published ON schedule_versions;
DROP TRIGGER IF EXISTS schedule_versions_transition_guard ON schedule_versions;
DROP TRIGGER IF EXISTS credits_immutable_when_published ON credits;
DROP TRIGGER IF EXISTS schedule_conflicts_immutable_when_published ON schedule_conflicts;
DROP TRIGGER IF EXISTS shifts_immutable_when_published ON shifts;
DROP TRIGGER IF EXISTS assignment_snapshots_immutable_when_published ON assignment_snapshots;

DROP FUNCTION IF EXISTS app_schedule_prune_current_assignments(uuid);
DROP FUNCTION IF EXISTS app_guard_append_only();
DROP FUNCTION IF EXISTS app_guard_schedule_version_no_delete();
DROP FUNCTION IF EXISTS app_guard_schedule_version_transition();
DROP FUNCTION IF EXISTS app_guard_credit_immutable();
DROP FUNCTION IF EXISTS app_guard_version_child_immutable();
DROP FUNCTION IF EXISTS app_schedule_version_is_frozen(uuid);

DROP TABLE IF EXISTS current_published_assignments;
DROP TABLE IF EXISTS version_supersessions;
DROP TABLE IF EXISTS publication_records;
DROP TABLE IF EXISTS schedule_conflicts;
DROP TABLE IF EXISTS credits;
DROP TABLE IF EXISTS assignment_snapshots;
DROP TABLE IF EXISTS assignment_identities;
DROP TABLE IF EXISTS shifts;
DROP TABLE IF EXISTS schedule_requirements;
DROP TABLE IF EXISTS schedule_versions;
DROP TABLE IF EXISTS schedule_periods;

ALTER TABLE groups DROP CONSTRAINT IF EXISTS groups_timezone_nonempty;
ALTER TABLE groups DROP COLUMN IF EXISTS timezone;
