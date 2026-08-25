-- SPEC-08 §5 — the vacation carriers, the SIXTH subtype table, and D-27
-- (OPUS-M5-000b, doc 42 §5b Part A, second half).
--
-- 0021 created the aggregate root and five subtype tables. This file creates the
-- sixth — `vacation_selections` — and the two things it stands on
-- (`vacation_periods`, `vacation_grants`) plus the approval-command ledger
-- (`vacation_approval_commands`) that makes approval idempotent. The split from
-- 0021 is dependency order and nothing else: a subtype table that references a
-- period and a grant cannot be created before them.
--
-- **Schema only.** `APPROVE-VACATION` (§5.4) is M5-002's; commit and reversal
-- (§5.6) are M5-004's; the selection UX and quota-vs-open behaviour (§5.5) are
-- M5-003's. Every constraint those transactions will be checked against exists
-- and is tested first.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. V-27 / FD-9 — `vacation_selections` IS a subtype table
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The package previously set `requests.subtype = 'vacation-selection'` in §5.1
-- while §1 classified `vacation_selections` as something other than a subtype
-- table. So D-18 was either violated by every vacation request or silently
-- depended on `vacation_selections` doubling as a subtype table, which §1
-- denied; §1.2 had no row for it, so D-19 had nothing to check; §2 had no
-- column, so D-20 had no domain to reference; and **no rule stated what
-- `requests.status` contained for a vacation request**.
--
-- CAR-011's complaint was one overloaded status whose meaning varied by subtype.
-- For the sixth subtype it had been replaced by TWO statuses with no stated
-- relationship — which is worse, because two rows could disagree about whether a
-- vacation request had been withdrawn and nothing would object.
--
-- Both statements are now true and both are enforced here:
--
--   * it is a subtype table — `UNIQUE (request_id)`, the composite FK carrying
--     `subtype`, the discriminator CHECK, and D-18's zero-row guard, exactly as
--     the other five have them;
--   * it carries a distinct quota and commitment lifecycle, and ITS status is
--     the authoritative one, from which `requests.status` is DERIVED by §5.3's
--     mapping — asserted by D-27 below.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 2. A DECLARED TENSION between §2 and §5.3, documented rather than resolved
-- ═══════════════════════════════════════════════════════════════════════════
--
-- §2's `vacation` column carries ✓ for `draft → submitted`,
-- `submitted → under_review` and `approved → superseded_by_revision`. §5.3's
-- mapping produces `submitted`, `approved`, `reflected_in_version`, `denied`,
-- `withdrawn`, `expired` and `reversed` — and produces `draft`, `under_review`
-- and `superseded_by_revision` from NOTHING.
--
-- So for those three root statuses, D-20 (from §2) admits the value and D-27
-- (from §5.3) refuses the row. **That is not a contradiction; it is two layers
-- composing, the stronger one winning, which is what layered enforcement means.**
-- Each is implemented exactly as its section states, and the effective reachable
-- set for a vacation root row is their intersection:
--
--     submitted · approved · reflected_in_version · denied · withdrawn ·
--     expired · reversed
--
-- This file does not amend SPEC-08 and does not pick a side. The observation is
-- recorded here and in the packet's return report so that it is registered
-- through the proper channel rather than settled by an implementer.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 3. `request_id` is NULLABLE, and the CHECK that makes that safe
-- ═══════════════════════════════════════════════════════════════════════════
--
-- §5.2 lists `request_id` without a `?`. §5.3's first mapping row says
-- `available` means "*no request row yet* — a selection becomes a request at
-- submission". Both cannot hold with a `NOT NULL` column: in `available` there
-- is, by §5.3's own words, no request to point at.
--
-- Resolved by making the column nullable and pinning the correspondence exactly:
--
--     CHECK ((status = 'available') = (request_id IS NULL))
--
-- `available` and only `available` has no request; every other status has one.
-- This is the only reading under which §5.3's `available` row is live text
-- rather than a line describing a state the schema forbids, and it costs D-18
-- nothing: PostgreSQL treats NULLs as distinct in a unique index, so
-- `UNIQUE (request_id)` still admits as many unsubmitted selections as a period
-- has weeks while still permitting exactly one selection per request.
--
-- Everything that reads the pair skips the NULL case explicitly — D-18's
-- zero-row guard (a NULL `request_id` matches no root) and D-27 (an `available`
-- selection has no root status to compare against). A guard that raised on those
-- rows would refuse the one state §5.3 defines as pre-request.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 4. D-21's two CHECKs are UNCONDITIONAL, and the override RAISES THE BOUND
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The superseded text said the upper bound was a `CHECK` **and** that it was
-- "relaxed only on the override path". Those cannot both be true. A table
-- `CHECK` is unconditional — it cannot be relaxed per-transaction or per-caller
-- — and `is_override` lives on `vacation_selections`, not on `vacation_grants`,
-- so no `CHECK` on the grant row could even see it. R-07 and the `CHECK` could
-- not both pass.
--
-- V-28 resolves it by raising the bound instead of relaxing the constraint:
--
--     CHECK (units_consumed >= 0)                          -- unconditional
--     CHECK (units_consumed <= units_total + override_units) -- unconditional
--     override_units integer NOT NULL DEFAULT 0 CHECK (override_units >= 0)
--
-- `override_units` is written ONLY by §5.5's audited override path, which
-- increments it in the same transaction as the approval it authorises. The
-- invariant is never suspended; the BOUND moves, and every relaxation is a
-- visible, audited value on the grant row itself rather than an unnoticed one.
-- Reversing an override decrements BOTH counters together (§5.5), so an override
-- cannot silently persist as headroom for a later approval.
--
-- SPEC-08 R-21 is a direct `UPDATE` driving `units_consumed` below zero or above
-- the bound, on every path including override. Both are refused by the CHECKs
-- above, and the populated cycle proves it by issuing the raw statements rather
-- than by going through a writer that could be the thing doing the refusing.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 5. D-23 as SPEC-08 spells it, and what it does NOT enforce
-- ═══════════════════════════════════════════════════════════════════════════
--
-- D-23 is stated as `UNIQUE (selection_id, committed_to_version_id)` and doc 06
-- §3.4 lists it under `vacation_selections`. On `vacation_selections`,
-- `selection_id` IS the row's own primary key, so that unique key is implied by
-- the primary key and **adds no enforcement**. It is declared below because
-- SPEC-08 names it and a stable constraint ID is not something an implementer
-- gets to redefine — but saying it enforces commit idempotency here would be
-- describing designed behaviour as verified behaviour, and it does not.
--
-- D-26, its approval-side sibling, is genuinely enforcing precisely because V-29
-- put it on a SEPARATE ledger table: `UNIQUE (selection_id,
-- approval_idempotency_key)` on `vacation_approval_commands`, where
-- `selection_id` is a foreign key and the pair really can repeat. D-23 in that
-- shape would need a commit-command ledger, which SPEC-08 does not specify.
--
-- Commit idempotency at M5-004 therefore rests on the write path's own guard and
-- on `commit_idempotency_key`, not on D-23's declared form. Recorded in the
-- packet's return report as a specification observation.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 6. Sensitivity, and the same narrowing debt 0021 records
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Doc 06 §3.4 classifies `vacation_selections` `SENSITIVE-PII`, `vacation_grants`
-- and `vacation_approval_commands` `INTERNAL`, and `vacation_periods` `NONE`.
-- The SENSITIVE-PII narrowing on the selection table is M5-001/003's for the
-- same reason 0021 §5 gives: it needs capability keys that do not exist in the
-- catalogue, and inventing one would expand capability scope. No route reads
-- these tables and no service writes them at this milestone.
--
-- Normative sources:
--   SPEC-08 §1.2, §2, §5.1–§5.6, §7   — the sixth subtype, the carriers, R-13/15/16/17..21
--   doc 06 §3.4                       — the carriers' key fields and sensitivities
--   doc 42 §5b                        — this packet's scope and acceptance
--   migration 0021                    — the root, the matrix, D-18's guard
--   migrations 0011 / 0017 / 0020     — the CREATE OR REPLACE / restore-verbatim discipline

-- Up Migration

------------------------------------------------------------------------------
-- 1. vacation_periods
--
-- §5.2: `group_id`, `start_date` (Mon), `end_date` (Fri), `mode ∈ {quota, open}`,
-- `state`. The Monday/Friday constraints are stated by the SPEC and are real
-- CHECKs here, because "the vacation period runs Monday to Friday" enforced
-- nowhere is a sentence that a single off-by-one insert makes false forever.
------------------------------------------------------------------------------

CREATE TABLE vacation_periods (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NOT NULL REFERENCES organizations (id),
    group_id            uuid NOT NULL,

    start_date          date NOT NULL,
    end_date            date NOT NULL,

    -- §5.5 / V-30. `quota` has `vacation_grants` rows and approval consumes a
    -- unit; `open` has NO grant rows and approval skips the grant update
    -- entirely. The previous specification's unconditional grant update made
    -- open-mode approval always fail, which is why the branch is named on the
    -- row rather than inferred from whether any grant happens to exist.
    mode                text NOT NULL,

    state               text NOT NULL DEFAULT 'draft',

    version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT vacation_periods_mode_domain CHECK (mode IN ('quota', 'open')),
    CONSTRAINT vacation_periods_state_domain
        CHECK (state IN ('draft', 'open', 'closed', 'archived')),

    -- §5.2's "(Mon)" and "(Fri)", as constraints. ISO day-of-week: 1 = Monday,
    -- 5 = Friday.
    CONSTRAINT vacation_periods_starts_monday
        CHECK (extract(isodow from start_date) = 1),
    CONSTRAINT vacation_periods_ends_friday
        CHECK (extract(isodow from end_date) = 5),
    CONSTRAINT vacation_periods_ordered CHECK (end_date > start_date),

    CONSTRAINT vacation_periods_tenant_identity
        UNIQUE (id, organization_id, group_id),
    -- doc 06 §3.4's `(group_id, start_date)`, tenant-led per X-11.
    CONSTRAINT vacation_periods_start_unique_in_group
        UNIQUE (organization_id, group_id, start_date),

    CONSTRAINT vacation_periods_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id)
);

ALTER TABLE vacation_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE vacation_periods FORCE  ROW LEVEL SECURITY;

CREATE POLICY vacation_periods_group_scope ON vacation_periods
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE INDEX vacation_periods_by_start
    ON vacation_periods (organization_id, group_id, start_date DESC);

------------------------------------------------------------------------------
-- 2. vacation_grants  (renamed from `vacation_quotas`, CAR-011 / CAR-020)
--
-- §5.2: `period_id`, `kind ∈ {personal-entitlement, weekly-capacity}`,
-- `membership_id?`, `week_start?`, `units_total`, `units_consumed`,
-- `override_units`, `version`.
--
-- The two `?` fields are not independently optional — they are what each `kind`
-- MEANS. A personal entitlement is a per-member allowance across the period; a
-- weekly capacity is a per-week ceiling across the group. `vacation_grants_kind_shape`
-- makes the other three combinations unrepresentable, so "a weekly capacity that
-- somehow names a member" is not a row anyone has to reason about.
--
-- The doc 06 traceability document's `vacation_entitlements` and
-- `vacation_capacity` are these two `kind` values, not separate tables (CAR-020).
------------------------------------------------------------------------------

CREATE TABLE vacation_grants (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NOT NULL REFERENCES organizations (id),
    group_id            uuid NOT NULL,

    vacation_period_id  uuid NOT NULL,
    kind                text NOT NULL,
    membership_id       uuid,
    week_start          date,

    units_total         integer NOT NULL CHECK (units_total >= 0),
    units_consumed      integer NOT NULL DEFAULT 0,

    -- V-28. Written ONLY by §5.5's audited override path, in the same
    -- transaction as the approval it authorises. Default 0, so a grant that has
    -- never been overridden has a bound of exactly `units_total`.
    override_units      integer NOT NULL DEFAULT 0 CHECK (override_units >= 0),

    version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT vacation_grants_kind_domain
        CHECK (kind IN ('personal-entitlement', 'weekly-capacity')),

    CONSTRAINT vacation_grants_kind_shape CHECK (
        (kind = 'personal-entitlement' AND membership_id IS NOT NULL AND week_start IS NULL)
     OR (kind = 'weekly-capacity'      AND membership_id IS NULL     AND week_start IS NOT NULL)),

    -- A week reference is a Monday, everywhere in this module.
    CONSTRAINT vacation_grants_week_is_monday
        CHECK (week_start IS NULL OR extract(isodow from week_start) = 1),

    --------------------------------------------------------------------------
    -- D-21, both halves, both UNCONDITIONAL (§4 of this file's header).
    --
    -- The lower bound applies on EVERY path including override and reversal: a
    -- reversal that would take the counter below zero is a data error, not a
    -- balance. The upper bound is expressed against `units_total +
    -- override_units` precisely so that it can be a real, unconditional CHECK
    -- and still permit the audited override — the override raises the bound, it
    -- does not suspend the rule.
    --------------------------------------------------------------------------
    CONSTRAINT vacation_grants_units_not_negative
        CHECK (units_consumed >= 0),
    CONSTRAINT vacation_grants_units_within_bound
        CHECK (units_consumed <= units_total + override_units),

    CONSTRAINT vacation_grants_tenant_identity
        UNIQUE (id, organization_id, group_id),

    CONSTRAINT vacation_grants_period_fk
        FOREIGN KEY (vacation_period_id, organization_id, group_id)
        REFERENCES vacation_periods (id, organization_id, group_id),
    CONSTRAINT vacation_grants_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id),
    CONSTRAINT vacation_grants_membership_fk
        FOREIGN KEY (membership_id, organization_id)
        REFERENCES memberships (id, organization_id)
);

ALTER TABLE vacation_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE vacation_grants FORCE  ROW LEVEL SECURITY;

CREATE POLICY vacation_grants_group_scope ON vacation_grants
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

-- One grant of each kind per what it is a grant OF. Two partial indexes rather
-- than one composite, because the two kinds key on different columns and a
-- single index over both would admit a duplicate of each.
CREATE UNIQUE INDEX vacation_grants_one_entitlement_per_member
    ON vacation_grants (organization_id, group_id, vacation_period_id, membership_id)
    WHERE kind = 'personal-entitlement';
CREATE UNIQUE INDEX vacation_grants_one_capacity_per_week
    ON vacation_grants (organization_id, group_id, vacation_period_id, week_start)
    WHERE kind = 'weekly-capacity';

------------------------------------------------------------------------------
-- 3. vacation_selections — the SIXTH subtype table (§1, V-27 / FD-9)
--
-- Carries D-18's four mechanisms exactly as the five in 0021 do, plus §5.2's
-- quota and commitment fields. §1.2's row for this subtype: required
-- `vacation_period_id` and `week_start`; prohibited `shift_type_id`,
-- `shift_group_id`, `preference_strength`, `target_date`, `range_start`,
-- `range_end` — and per 0021's header §2 those six are ABSENT rather than
-- present-and-constrained-NULL, which is what makes SPEC-08 R-16's rejection
-- half a refusal before any row is evaluated.
--
-- `vacation_period_id` is §1.2's name for the column §5.2 calls `period_id`.
-- One name is used throughout, and it is the one D-19 and R-16 cite.
------------------------------------------------------------------------------

CREATE TABLE vacation_selections (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id         uuid NOT NULL REFERENCES organizations (id),
    group_id                uuid NOT NULL,

    -- NULL in `available` and only in `available` (§3 of this file's header).
    request_id              uuid,
    subtype                 text NOT NULL DEFAULT 'vacation-selection',

    membership_id           uuid NOT NULL,

    -- D-19's required half for this subtype.
    vacation_period_id      uuid NOT NULL,
    week_start              date NOT NULL,

    -- THE AUTHORITATIVE STATUS (§5.3). `requests.status` is derived from this
    -- one, in the same transaction, and D-27 asserts the correspondence.
    status                  text NOT NULL DEFAULT 'available',

    -- V-29. The SELECTION's own optimistic-concurrency counter. Distinct from
    -- the grant's, and the distinction is the defect V-29 fixed: the version
    -- §5.4 checked was the GRANT's, so a duplicate approval passed the selection
    -- update unguarded and consumed a second quota unit.
    version                 integer NOT NULL DEFAULT 1 CHECK (version >= 1),

    grant_id                uuid,

    -- §5.5's audited override, recorded on the selection. The grant carries the
    -- raised bound; this carries the fact that a human authorised it and why.
    is_override             boolean NOT NULL DEFAULT false,
    override_reason         text,

    -- V-29. The key of the approval command that decided this selection, once
    -- one has. The idempotency LEDGER is `vacation_approval_commands`; this is
    -- the back-reference, so a reader of the selection can find the command
    -- without a scan.
    approval_idempotency_key text,

    committed_to_version_id uuid,
    commit_idempotency_key  text,

    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT vacation_selections_discriminator
        CHECK (subtype = 'vacation-selection'),

    CONSTRAINT vacation_selections_status_domain CHECK (status IN (
        'available', 'pending', 'approved', 'committed',
        'denied', 'withdrawn', 'expired', 'reversed')),

    -- §3 of this file's header. `available` and only `available` has no request.
    CONSTRAINT vacation_selections_request_present_unless_available
        CHECK ((status = 'available') = (request_id IS NULL)),

    CONSTRAINT vacation_selections_week_is_monday
        CHECK (extract(isodow from week_start) = 1),

    -- §5.5: the override "requires an explicit override capability and a
    -- MANDATORY reason". The capability is checked by the write path; the reason
    -- is checked here, in both directions, so neither an unexplained override
    -- nor a reason attached to a non-override can be stored.
    CONSTRAINT vacation_selections_override_reason_coherent
        CHECK (is_override = (override_reason IS NOT NULL)),
    -- Bounded, like `schedule_versions.change_summary`: a scheduler-authored
    -- administrative note. It is not an ingestion path and never enters an audit
    -- payload — the closed-payload rule (ADR-0019) would reject free text there.
    CONSTRAINT vacation_selections_override_reason_len
        CHECK (override_reason IS NULL OR length(btrim(override_reason)) BETWEEN 1 AND 1000),

    CONSTRAINT vacation_selections_approval_key_shape
        CHECK (approval_idempotency_key IS NULL
               OR approval_idempotency_key ~ '^[A-Za-z0-9_.-]{1,64}$'),
    CONSTRAINT vacation_selections_commit_key_shape
        CHECK (commit_idempotency_key IS NULL
               OR commit_idempotency_key ~ '^[A-Za-z0-9_.-]{1,64}$'),

    --------------------------------------------------------------------------
    -- D-18, this table's copy. SPEC-08 spells it `UNIQUE (request_id)`; it
    -- admits many NULLs, which is exactly what an unsubmitted selection grid
    -- needs, and exactly one row per request once there is one.
    --
    -- `organization_id` is APPENDED, for X-11, and it is the same constraint:
    -- `vacation_selections_request_fk` is composite over `(request_id,
    -- organization_id, group_id, subtype)` and `requests.id` is a primary key,
    -- so any two rows sharing a non-null `request_id` necessarily share an
    -- `organization_id`. See migration 0021's D-7 comment for the full argument
    -- — unique checks bypass RLS, so a caller-choosable unique key without the
    -- tenant column is an existence oracle for rows the caller cannot see, and
    -- `test/tenancy/roles-and-schema.test.ts` refuses one.
    --------------------------------------------------------------------------
    CONSTRAINT vacation_selections_one_per_request UNIQUE (request_id, organization_id),

    -- D-22. One selection per (membership, period, week), tenant-led per X-11 —
    -- which costs D-22 nothing, since the period already determines both tenant
    -- columns through `vacation_selections_period_fk`.
    CONSTRAINT vacation_selections_one_per_member_period_week
        UNIQUE (organization_id, group_id, membership_id, vacation_period_id, week_start),

    --------------------------------------------------------------------------
    -- D-23, declared as SPEC-08 spells it. On THIS table `selection_id` is the
    -- primary key, so this unique key is implied by the primary key and enforces
    -- nothing further; see §5 of this file's header, which says so rather than
    -- letting a reader assume otherwise.
    --------------------------------------------------------------------------
    CONSTRAINT vacation_selections_commit_idempotent
        UNIQUE (id, committed_to_version_id, organization_id),

    CONSTRAINT vacation_selections_tenant_identity
        UNIQUE (id, organization_id, group_id),

    -- D-18's composite FK: the root's discriminator and both tenant columns
    -- travel with the reference. Skipped when `request_id` is NULL, which is the
    -- `available` case and is why the CHECK above pins that correspondence.
    CONSTRAINT vacation_selections_request_fk
        FOREIGN KEY (request_id, organization_id, group_id, subtype)
        REFERENCES requests (id, organization_id, group_id, subtype),

    CONSTRAINT vacation_selections_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id),
    CONSTRAINT vacation_selections_membership_fk
        FOREIGN KEY (membership_id, organization_id)
        REFERENCES memberships (id, organization_id),
    CONSTRAINT vacation_selections_period_fk
        FOREIGN KEY (vacation_period_id, organization_id, group_id)
        REFERENCES vacation_periods (id, organization_id, group_id),
    CONSTRAINT vacation_selections_grant_fk
        FOREIGN KEY (grant_id, organization_id, group_id)
        REFERENCES vacation_grants (id, organization_id, group_id),
    CONSTRAINT vacation_selections_committed_version_fk
        FOREIGN KEY (committed_to_version_id, organization_id, group_id)
        REFERENCES schedule_versions (id, organization_id, group_id)
);

ALTER TABLE vacation_selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE vacation_selections FORCE  ROW LEVEL SECURITY;

CREATE POLICY vacation_selections_group_scope ON vacation_selections
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE INDEX vacation_selections_by_period
    ON vacation_selections (organization_id, group_id, vacation_period_id, week_start);
CREATE INDEX vacation_selections_by_membership
    ON vacation_selections (organization_id, group_id, membership_id, vacation_period_id);

------------------------------------------------------------------------------
-- 4. vacation_approval_commands — D-26, the approval idempotency ledger
--
-- V-29. `commit_idempotency_key` covers COMMIT; approval had nothing, so a
-- duplicate approval command, a retry after an ambiguous response, or an
-- approval of an already-withdrawn selection consumed a SECOND quota unit —
-- a quota-accounting error inside the transaction whose purpose is correct quota
-- accounting, and one that D-21, D-22 and D-23 each legitimately permit.
--
-- §5.4 step 0: the INSERT is the FIRST effect of `APPROVE-VACATION`, before any
-- other. Zero rows inserted means replay — return the recorded outcome, consume
-- no unit, emit no event, write no approval row.
--
-- Append-only except for `outcome`, which §5.4's last line sets once the
-- transaction has decided. The grant below is column-level for exactly that
-- reason, and there is no UPDATE trigger on this table because `outcome` is the
-- one column that legitimately moves.
------------------------------------------------------------------------------

CREATE TABLE vacation_approval_commands (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id             uuid NOT NULL REFERENCES organizations (id),
    group_id                    uuid NOT NULL,

    selection_id                uuid NOT NULL,
    approval_idempotency_key    text NOT NULL
        CHECK (approval_idempotency_key ~ '^[A-Za-z0-9_.-]{1,64}$'),

    received_at                 timestamptz NOT NULL DEFAULT now(),
    -- NULL while the command is in flight. A row with no outcome is a command
    -- whose transaction did not reach its last statement.
    outcome                     text,

    created_at                  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT vacation_approval_commands_outcome_domain CHECK (
        outcome IS NULL OR outcome IN (
            'approved', 'denied', 'quota_exhausted', 'version_conflict',
            'selection_not_pending')),

    -- D-26. `selection_id` is a foreign key here, so the pair genuinely can
    -- repeat and this constraint genuinely refuses the repeat — which is the
    -- difference between it and D-23's declared form (§5 of this file's header).
    --
    -- `organization_id` appended for X-11, and the same argument: the composite
    -- selection FK below makes it functionally determined by `selection_id`, so
    -- the set of colliding pairs is unchanged and D-26 keeps its meaning.
    CONSTRAINT vacation_approval_commands_idempotent
        UNIQUE (selection_id, approval_idempotency_key, organization_id),

    CONSTRAINT vacation_approval_commands_tenant_identity
        UNIQUE (id, organization_id, group_id),

    CONSTRAINT vacation_approval_commands_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id),
    CONSTRAINT vacation_approval_commands_selection_fk
        FOREIGN KEY (selection_id, organization_id, group_id)
        REFERENCES vacation_selections (id, organization_id, group_id)
);

ALTER TABLE vacation_approval_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE vacation_approval_commands FORCE  ROW LEVEL SECURITY;

CREATE POLICY vacation_approval_commands_group_scope ON vacation_approval_commands
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE INDEX vacation_approval_commands_by_selection
    ON vacation_approval_commands (organization_id, group_id, selection_id, received_at DESC);

------------------------------------------------------------------------------
-- 5. D-27 — `requests.status` matches the §5.3 mapping
--
-- The mapping, and then the assertion, in that order: the mapping is a lookup
-- table with parentheses and is worth reading on its own.
------------------------------------------------------------------------------

CREATE FUNCTION app_vacation_derived_request_status(p_selection_status text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
    -- §5.3's table, row for row. NULL for `available`, which is the row that
    -- reads "*no request row yet* — a selection becomes a request at submission".
    SELECT CASE p_selection_status
               WHEN 'available' THEN NULL
               WHEN 'pending'   THEN 'submitted'
               WHEN 'approved'  THEN 'approved'
               WHEN 'committed' THEN 'reflected_in_version'
               WHEN 'denied'    THEN 'denied'
               WHEN 'withdrawn' THEN 'withdrawn'
               WHEN 'expired'   THEN 'expired'
               WHEN 'reversed'  THEN 'reversed'
           END;
$$;

REVOKE ALL ON FUNCTION app_vacation_derived_request_status(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_vacation_derived_request_status(text)
    TO app_runtime, app_worker, app_readonly_support, app_breakglass;

CREATE FUNCTION app_guard_vacation_status_mapping() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_request_id        uuid;
    v_selection_status  text;
    v_request_status    text;
    v_expected          text;
BEGIN
    ------------------------------------------------------------------------
    -- The same predicate, reachable from either side of the pair. Which side
    -- fired only decides which row is looked up first.
    --
    -- **Both statuses are read from the TABLES, never from `NEW`.** A deferred
    -- trigger queues one event per row-modification, each carrying the `NEW` its
    -- own statement produced, and fires all of them at commit — so §5.4's
    -- writer, which touches the selection and then the root, arrives here with a
    -- `NEW` that is a statement out of date. Trusting it would refuse the exact
    -- transaction shape §5.4 prescribes. Commit is the instant this check is
    -- asking about, so commit is the state it reads.
    ------------------------------------------------------------------------
    IF TG_TABLE_NAME = 'vacation_selections' THEN
        SELECT request_id, status INTO v_request_id, v_selection_status
        FROM vacation_selections
        WHERE id = NEW.id;

        -- Deleted later in the same transaction. Nothing to assert.
        IF NOT FOUND THEN
            RETURN NULL;
        END IF;

        -- CAUTION, and it is the reason this branch exists: an `available`
        -- selection has NO root row, by §5.3. A guard that raised on it would
        -- refuse the one state the specification defines as pre-request.
        IF v_request_id IS NULL THEN
            RETURN NULL;
        END IF;
    ELSE
        -- Fired on `requests`, for a `vacation-selection` root row.
        v_request_id := NEW.id;

        SELECT status INTO v_selection_status
        FROM vacation_selections
        WHERE request_id = v_request_id;

        IF v_selection_status IS NULL THEN
            -- No selection row by commit time. That is D-18's zero-row guard's
            -- finding to report, and reporting it twice with two different
            -- messages helps nobody.
            RETURN NULL;
        END IF;
    END IF;

    SELECT status INTO v_request_status FROM requests WHERE id = v_request_id;
    IF v_request_status IS NULL THEN
        -- The root was deleted, or is invisible. D-18's guard and the composite
        -- FK both have opinions about that; this one does not need a second.
        RETURN NULL;
    END IF;

    v_expected := app_vacation_derived_request_status(v_selection_status);

    IF v_request_status IS DISTINCT FROM v_expected THEN
        RAISE EXCEPTION
            'VACATION_STATUS_MAPPING_VIOLATED: a vacation selection in % requires its '
            'request to be in % (D-27, SPEC-08 §5.3), and the request is in %',
            v_selection_status, coalesce(v_expected, '(no request row)'), v_request_status
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION app_guard_vacation_status_mapping() FROM PUBLIC;

------------------------------------------------------------------------------
-- Both triggers are DEFERRED, and both sides are attached. Neither half is
-- optional:
--
--   * DEFERRED, because §5.4's legal writer updates `vacation_selections` and
--     then `requests` in two separate statements. Between them the two rows
--     disagree — inside one transaction, which is what §5.3's "there is no
--     window in which they disagree" means, since no other transaction can see
--     an uncommitted row. An IMMEDIATE trigger would refuse every legal writer
--     M5-002 is going to have.
--
--   * BOTH SIDES, because a one-sided trigger is a one-sided guarantee. On
--     `requests` alone, a writer that moved `vacation_selections.status` and
--     never touched the root would go unnoticed — and §5.3's whole complaint is
--     that two rows could disagree about whether a vacation request had been
--     withdrawn.
------------------------------------------------------------------------------

CREATE CONSTRAINT TRIGGER vacation_selections_guard_status_mapping
    AFTER INSERT OR UPDATE ON vacation_selections
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION app_guard_vacation_status_mapping();

CREATE CONSTRAINT TRIGGER requests_guard_vacation_status_mapping
    AFTER INSERT OR UPDATE ON requests
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (NEW.subtype = 'vacation-selection')
    EXECUTE FUNCTION app_guard_vacation_status_mapping();

------------------------------------------------------------------------------
-- 6. The week reference falls inside its period (§1.2)
--
-- "`week_start` (the week reference, which must fall inside the period)". A
-- cross-row condition, so a CHECK cannot express it. BEFORE, so it binds every
-- writer including the owner, and invoker-rights, so a period the writer cannot
-- see is a period the writer cannot select a week in.
------------------------------------------------------------------------------

CREATE FUNCTION app_guard_vacation_week_in_period() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_start date;
    v_end   date;
BEGIN
    -- A missing period or a missing week is D-19's business, not this trigger's,
    -- and `NOT NULL` says so more precisely than anything here could.
    --
    -- The guard is required rather than tidy: a BEFORE ROW trigger fires BEFORE
    -- `NOT NULL` is evaluated, so without it a row with a null
    -- `vacation_period_id` would come back `VACATION_PERIOD_NOT_VISIBLE` —
    -- reporting a tenancy problem about a row whose actual defect is a missing
    -- required field, and burying D-19 behind a message that names the wrong
    -- cause.
    IF NEW.vacation_period_id IS NULL OR NEW.week_start IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT start_date, end_date INTO v_start, v_end
    FROM vacation_periods
    WHERE id = NEW.vacation_period_id;

    IF v_start IS NULL THEN
        RAISE EXCEPTION
            'VACATION_PERIOD_NOT_VISIBLE: the vacation period named by this row is not '
            'visible in this tenant context'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.week_start < v_start OR NEW.week_start > v_end THEN
        RAISE EXCEPTION
            'VACATION_WEEK_OUTSIDE_PERIOD: week % is not inside the period % .. %',
            NEW.week_start, v_start, v_end
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_guard_vacation_week_in_period() FROM PUBLIC;

CREATE TRIGGER vacation_selections_guard_week_in_period
    BEFORE INSERT OR UPDATE ON vacation_selections
    FOR EACH ROW EXECUTE FUNCTION app_guard_vacation_week_in_period();

-- The same condition on a weekly-capacity grant, which names a week for the same
-- period and would otherwise be free to name one outside it.
CREATE TRIGGER vacation_grants_guard_week_in_period
    BEFORE INSERT OR UPDATE ON vacation_grants
    FOR EACH ROW
    WHEN (NEW.week_start IS NOT NULL)
    EXECUTE FUNCTION app_guard_vacation_week_in_period();

------------------------------------------------------------------------------
-- 7. §5.5 — a period's mode does not change under a live approval
--
-- "Mode change mid-period: **prohibited** while selections exist in `pending` or
-- `approved`." V-30 names this as the rule that makes §5.4's mode branch SAFE:
-- the branch reads `vacation_periods.mode` and then acts on it, and a mode that
-- could flip in between would make open-mode approval consume a quota unit that
-- does not exist, or quota-mode approval skip the unit it must consume.
--
-- Beyond doc 42 §5b's enumerated list, and deliberately so — it is a §5
-- invariant, it is database-enforceable, and the packet's own scope sentence is
-- "every table, constraint, and trigger the request/vacation lifecycles stand
-- on". This is one of them, and V-30's correctness argument cites it by name.
------------------------------------------------------------------------------

CREATE FUNCTION app_guard_vacation_mode_stable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_live integer;
BEGIN
    IF NEW.mode IS NOT DISTINCT FROM OLD.mode THEN
        RETURN NEW;
    END IF;

    SELECT count(*) INTO v_live
    FROM vacation_selections
    WHERE vacation_period_id = NEW.id
      AND status IN ('pending', 'approved');

    IF v_live > 0 THEN
        RAISE EXCEPTION
            'VACATION_MODE_CHANGE_PROHIBITED: % selection(s) are pending or approved in '
            'this period, so its mode does not change from % to % (SPEC-08 §5.5)',
            v_live, OLD.mode, NEW.mode
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_guard_vacation_mode_stable() FROM PUBLIC;

CREATE TRIGGER vacation_periods_guard_mode_stable
    BEFORE UPDATE ON vacation_periods
    FOR EACH ROW EXECUTE FUNCTION app_guard_vacation_mode_stable();

------------------------------------------------------------------------------
-- 8. D-18's zero-row guard, widened to the sixth subtype
--
-- 0021's body refused `vacation-selection` outright, because this table did not
-- exist. `CREATE OR REPLACE` is the only unit of change a function body has, so
-- the whole body is restated with ONE branch added; the down migration below
-- restores 0021's body VERBATIM. That is the 0011 / 0017 / 0020 precedent, and a
-- reader comparing the two should find exactly one difference.
------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_guard_request_subtype_row() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_rows    integer;
    v_subtype text;
BEGIN
    SELECT subtype INTO v_subtype FROM requests WHERE id = NEW.id;
    IF v_subtype IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT count(*) INTO v_rows FROM (
        SELECT 1 FROM request_availability       WHERE request_id = NEW.id
        UNION ALL
        SELECT 1 FROM request_time_off           WHERE request_id = NEW.id
        UNION ALL
        SELECT 1 FROM request_no_call            WHERE request_id = NEW.id
        UNION ALL
        SELECT 1 FROM request_shift_preference   WHERE request_id = NEW.id
        UNION ALL
        SELECT 1 FROM request_shift_group_off    WHERE request_id = NEW.id
        UNION ALL
        -- The one added branch. A NULL `request_id` matches nothing here, which
        -- is correct: an `available` selection is not yet anybody's subtype row.
        SELECT 1 FROM vacation_selections        WHERE request_id = NEW.id
    ) AS subtype_rows;

    IF v_rows <> 1 THEN
        RAISE EXCEPTION
            'REQUEST_SUBTYPE_ROW_REQUIRED: a % request carries exactly one subtype row, '
            'and this one carries % (D-18)',
            v_subtype, v_rows
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NULL;
END;
$$;

------------------------------------------------------------------------------
-- 9. Grants
--
-- Column-level UPDATE throughout (0014's discipline). On `vacation_grants` the
-- set is deliberately narrow: `units_consumed`, `override_units`, `units_total`
-- and `version` and nothing else, so a grant cannot be re-pointed at another
-- period, member or week by an UPDATE — which would move a consumed balance onto
-- a different allowance.
--
-- `vacation_approval_commands` has an UPDATE grant on `outcome` alone: §5.4's
-- last statement sets it, and nothing else about a recorded command may move.
--
-- No table here has a DELETE grant for any role.
------------------------------------------------------------------------------

GRANT SELECT, INSERT ON vacation_periods TO app_runtime, app_worker;
GRANT UPDATE (start_date, end_date, mode, state, version, updated_at)
    ON vacation_periods TO app_runtime, app_worker;
GRANT SELECT ON vacation_periods TO app_readonly_support, app_breakglass;

GRANT SELECT, INSERT ON vacation_grants TO app_runtime, app_worker;
GRANT UPDATE (units_total, units_consumed, override_units, version, updated_at)
    ON vacation_grants TO app_runtime, app_worker;
GRANT SELECT ON vacation_grants TO app_readonly_support, app_breakglass;

GRANT SELECT, INSERT ON vacation_selections TO app_runtime, app_worker;
GRANT UPDATE (request_id, status, version, grant_id, is_override, override_reason,
              approval_idempotency_key, committed_to_version_id,
              commit_idempotency_key, updated_at)
    ON vacation_selections TO app_runtime, app_worker;
GRANT SELECT ON vacation_selections TO app_readonly_support, app_breakglass;

GRANT SELECT, INSERT ON vacation_approval_commands TO app_runtime, app_worker;
GRANT UPDATE (outcome) ON vacation_approval_commands TO app_runtime, app_worker;
GRANT SELECT ON vacation_approval_commands TO app_readonly_support, app_breakglass;

-- Down Migration

-- 0021's body, VERBATIM, restored FIRST — before the table it references is
-- dropped. Reversing this migration therefore restores the state in which a
-- `vacation-selection` root row can carry no subtype row at all, because there
-- is no table for one; that is what reversing it means, and saying so is the
-- point (the 0020 precedent).

CREATE OR REPLACE FUNCTION app_guard_request_subtype_row() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_rows    integer;
    v_subtype text;
BEGIN
    SELECT subtype INTO v_subtype FROM requests WHERE id = NEW.id;
    IF v_subtype IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT count(*) INTO v_rows FROM (
        SELECT 1 FROM request_availability       WHERE request_id = NEW.id
        UNION ALL
        SELECT 1 FROM request_time_off           WHERE request_id = NEW.id
        UNION ALL
        SELECT 1 FROM request_no_call            WHERE request_id = NEW.id
        UNION ALL
        SELECT 1 FROM request_shift_preference   WHERE request_id = NEW.id
        UNION ALL
        SELECT 1 FROM request_shift_group_off    WHERE request_id = NEW.id
    ) AS subtype_rows;

    IF v_rows <> 1 THEN
        RAISE EXCEPTION
            'REQUEST_SUBTYPE_ROW_REQUIRED: a % request carries exactly one subtype row, '
            'and this one carries % (D-18)',
            v_subtype, v_rows
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS vacation_periods_guard_mode_stable ON vacation_periods;
DROP TRIGGER IF EXISTS vacation_grants_guard_week_in_period ON vacation_grants;
DROP TRIGGER IF EXISTS vacation_selections_guard_week_in_period ON vacation_selections;
DROP TRIGGER IF EXISTS requests_guard_vacation_status_mapping ON requests;
DROP TRIGGER IF EXISTS vacation_selections_guard_status_mapping ON vacation_selections;

DROP FUNCTION IF EXISTS app_guard_vacation_mode_stable();
DROP FUNCTION IF EXISTS app_guard_vacation_week_in_period();
DROP FUNCTION IF EXISTS app_guard_vacation_status_mapping();
DROP FUNCTION IF EXISTS app_vacation_derived_request_status(text);

DROP TABLE IF EXISTS vacation_approval_commands;
DROP TABLE IF EXISTS vacation_selections;
DROP TABLE IF EXISTS vacation_grants;
DROP TABLE IF EXISTS vacation_periods;
