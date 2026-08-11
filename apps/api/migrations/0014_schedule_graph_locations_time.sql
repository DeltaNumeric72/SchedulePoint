-- 0014_schedule_graph_locations_time.sql
--
-- OPUS-M4-000B — schedule-graph consistency, group-scoped relationships,
-- locations, and time (doc 34 §4-C, §4-E, §4-F; doc 35 §4).
--
-- Migration number 0014, not 0013: doc 35 §2 as amended 2026-08-10 (FAD-30)
-- records that OPUS-M4-000A's review condition F-1 consumed 0013. 0001..0013
-- are applied and are never edited.
--
-- ADDITIVE ONLY. Every statement below creates a new object, adds a new column,
-- adds a new constraint, or attaches a new trigger/grant. No policy is dropped,
-- no existing constraint is relaxed, no existing function body is replaced, and
-- no grant is widened except onto the two columns this migration adds.
--
-- ── WHAT THIS CLOSES, AND WHY EACH ARM IS THE SHAPE IT IS ────────────────────
--
-- Doc 34 §4-C and §4-E ask for consistency to be proven **at the database**,
-- "composite relationships, invariant checks, or guarded transitions — never UI
-- filtering". The schedule spine already carries composite tenant FKs from 0009,
-- so the row a reference names is already proven to be in the same organization
-- and the same group. What 0009 could NOT express, and what this migration adds,
-- is the second axis: the referenced row must also be in the same **version**,
-- the same **period**, and — for a participant — must actually be a membership
-- OF that group rather than merely of that organization.
--
--   * Where the invariant is expressible as a foreign key, it is one. An FK is
--     checked by the storage engine on every path, cannot be forgotten by a new
--     writer, and cannot be disabled by an application bug. Eleven of the
--     fourteen arms below are FKs, and each needs a new tenant-qualified UNIQUE
--     on the referenced table to point at — those uniques are the only reason
--     they are expressible at all.
--
--   * Where it is not — a DATE inside a range on a grandparent row, a period
--     equality between two rows that share no column, "the reality table holds
--     only the current published version's rows" — it is a trigger. Each states
--     which document clause it enforces and raises a NAMED error, never a bare
--     23514, so a caller is told what it broke.
--
-- ── THE ONE THING THIS MIGRATION DELIBERATELY DOES NOT CREATE ────────────────
--
--   There is still **no `sites` table** and no `locations.site_id`.
--
-- PO-DEC-01's recorded default is "defer a first-class Site; model location as
-- an attribute" (06 §3.2a), and 0010 states at length why a table with foreign
-- keys "is not neutral toward that decision". This migration connects `shifts`
-- to `locations` — which doc 34 §4-F requires — and connects them to nothing
-- else. `site_label` stays a denormalised free-form text attribute. Non-bypass
-- rule 12 is unchanged and is why.
--
-- ── TIMEZONE: TWO COLUMNS, AND THE RULING THEY IMPLEMENT ─────────────────────
--
-- `schedule_versions` gains `timezone_basis` and `tzdb_version`. The RULING they
-- implement (offered for FAD ratification in the packet's return report):
--
--   **A location's `timezone` is DISPLAY METADATA. The GROUP's timezone governs
--   every schedule semantic.**
--
-- 0010 already gives `locations.timezone` and says the two "are different
-- facts", but it does not say which one a schedule resolves against, and an
-- unstated precedence is how a multi-site group ends up with two truths. Doc 06
-- §Time settles it — "shift-local semantics resolve against the group timezone"
-- — so: every `starts_at`/`ends_at` derivation, every day-window read, every
-- DST gap/fold resolution and every calendar-date attribution uses
-- `groups.timezone`, and `locations.timezone` is shown to a human who wants to
-- know what the clock on that wall says. Nothing computes from it. Making it
-- govern would mean one version's shifts resolving in several zones at once,
-- which makes the D-1a/D-1b overlap constraints incomparable across a group.
--
-- Normative sources:
--   doc 34 §4-C / §4-E / §4-F   — the prerequisite register rows this closes
--   doc 35 §4 (OPUS-M4-000B)    — the packet; its Required behaviour governs
--   SPEC-05 §1/§2/§4/§5/§6      — identity vs snapshot, D-1a/D-1b, D-15, current
--   doc 06 §3.2, §3.2a, §Time   — the graph tables, the site boundary, the zone
--   migration 0009 / 0010       — the tables and the composite-FK convention
--   FAD-24                      — the group `settings_version` CAS precedent

-- Up Migration

------------------------------------------------------------------------------
-- 1. The tenant-qualified UNIQUE keys the new composite FKs point at.
--
-- Each is REDUNDANT as a uniqueness statement — every one of these tables has
-- `id` as its primary key, so `(id, …)` is unique for free. That is the point:
-- PostgreSQL requires a UNIQUE or PRIMARY KEY constraint matching a foreign
-- key's referenced column list, so the only way to say "and it must be in the
-- same version" as an FK is to publish `(id, organization_id, group_id,
-- version_id)` as a key. 0009 already uses exactly this device for its
-- `*_tenant_identity` keys.
--
-- They lead with `id` rather than with the tenant columns, unlike a real
-- business key. X-11's rule ("every unique key on a tenant table leads with the
-- tenant columns so a 23505 cannot become a cross-tenant existence oracle") is
-- about keys a caller can COLLIDE with. These cannot be collided with by anyone:
-- `id` alone is already unique, so a duplicate here is unreachable and no 23505
-- can ever be raised from one. `*_tenant_identity` in 0009 is the same shape for
-- the same reason.
------------------------------------------------------------------------------

-- A shift, qualified by the version it belongs to.
ALTER TABLE shifts
    ADD CONSTRAINT shifts_version_identity
        UNIQUE (id, organization_id, group_id, version_id);

-- A snapshot, qualified by its version and by its identity — two different
-- keys, because `credits` must agree with a snapshot on BOTH.
ALTER TABLE assignment_snapshots
    ADD CONSTRAINT assignment_snapshots_version_identity
        UNIQUE (id, organization_id, group_id, version_id);
ALTER TABLE assignment_snapshots
    ADD CONSTRAINT assignment_snapshots_assignment_identity_key
        UNIQUE (id, organization_id, group_id, assignment_identity_id);

-- A version and an assignment identity, each qualified by its period.
ALTER TABLE schedule_versions
    ADD CONSTRAINT schedule_versions_period_identity
        UNIQUE (id, organization_id, group_id, period_id);
ALTER TABLE assignment_identities
    ADD CONSTRAINT assignment_identities_period_identity
        UNIQUE (id, organization_id, group_id, period_id);

-- A membership, qualified by its group.
--
-- `memberships.group_id` is NULLABLE — NULL means an ORGANIZATION membership
-- (0001: "Not a missing value"). NULLs are distinct in a UNIQUE constraint, so
-- adding `group_id` to the key changes nothing about which rows are permitted;
-- what it does is give the schedule tables something to point at. Because every
-- referencing column below is NOT NULL, MATCH SIMPLE requires a matching row
-- with a NON-NULL `group_id` equal to the referencing row's — which is exactly
-- the invariant doc 34 §4-C asks for: **the participant is a member OF THIS
-- GROUP**, not merely of this organization.
ALTER TABLE memberships
    ADD CONSTRAINT memberships_group_identity
        UNIQUE (id, organization_id, group_id);

------------------------------------------------------------------------------
-- 2. Snapshot ↔ shift: the SAME VERSION, not merely the same group.
--
-- 0009's `assignment_snapshots_shift_fk` proves the shift is in the caller's
-- group. It does not prove the shift belongs to the snapshot's own version — so
-- a snapshot in draft V3 could hang on a shift row belonging to published V1,
-- and every downstream read that resolves a snapshot's shift type, date or
-- location through the shift would report V1's values for a V3 assignment. The
-- clone path (`cloneVersion`) exists precisely because the two must not be
-- shared; this makes sharing them unrepresentable rather than merely avoided.
------------------------------------------------------------------------------

ALTER TABLE assignment_snapshots
    ADD CONSTRAINT assignment_snapshots_shift_in_same_version_fk
        FOREIGN KEY (shift_id, organization_id, group_id, version_id)
        REFERENCES shifts (id, organization_id, group_id, version_id);

------------------------------------------------------------------------------
-- 3. Participant ↔ group (doc 34 §4-C).
--
-- Three referencing sites, all previously `(x, organization_id) -> memberships
-- (id, organization_id)`, which accepts an ORGANIZATION membership and accepts a
-- membership of a DIFFERENT group in the same organization. The second is the
-- one that matters: it is the CAR-001 defect class, and the composite tenant FK
-- convention exists to make it structural rather than a query somebody remembers
-- to filter.
--
--   assignment_snapshots.membership_id           who works the shift
--   credits.credited_membership_id               who is scored for it (may
--                                                legitimately differ — doc 07)
--   current_published_assignments.membership_id  who works it in reality
--
-- `published_by`, `moved_by` and `actor_membership_id` are deliberately NOT
-- changed. Those are ACTORS, not participants: an organization administrator
-- publishing a group's schedule is a legitimate, audited act, and group-scoping
-- the actor columns would refuse it. The distinction is the point.
------------------------------------------------------------------------------

ALTER TABLE assignment_snapshots
    ADD CONSTRAINT assignment_snapshots_participant_in_group_fk
        FOREIGN KEY (membership_id, organization_id, group_id)
        REFERENCES memberships (id, organization_id, group_id);

ALTER TABLE credits
    ADD CONSTRAINT credits_credited_participant_in_group_fk
        FOREIGN KEY (credited_membership_id, organization_id, group_id)
        REFERENCES memberships (id, organization_id, group_id);

ALTER TABLE current_published_assignments
    ADD CONSTRAINT current_published_assignments_participant_in_group_fk
        FOREIGN KEY (membership_id, organization_id, group_id)
        REFERENCES memberships (id, organization_id, group_id);

------------------------------------------------------------------------------
-- 4. Credit ↔ snapshot ↔ version ↔ identity (doc 34 §4-E).
--
-- V-23 keys a credit by identity + source_version + source_snapshot, and 0009
-- gives each of the three its own group-qualified FK. What was missing is that
-- the three must AGREE: a credit could name identity A, version V, and a
-- snapshot that belonged to identity B in version W, and the row would be
-- accepted. Every fairness figure derived from it would then be attributed to
-- the wrong person, in the wrong version, with three individually valid foreign
-- keys pointing at it.
--
-- Two FKs, because the snapshot must agree with the credit on two independent
-- columns. They reference the same table through two different unique keys.
------------------------------------------------------------------------------

ALTER TABLE credits
    ADD CONSTRAINT credits_snapshot_in_source_version_fk
        FOREIGN KEY (source_snapshot_id, organization_id, group_id, source_version_id)
        REFERENCES assignment_snapshots (id, organization_id, group_id, version_id);

ALTER TABLE credits
    ADD CONSTRAINT credits_snapshot_carries_identity_fk
        FOREIGN KEY (source_snapshot_id, organization_id, group_id, assignment_identity_id)
        REFERENCES assignment_snapshots (id, organization_id, group_id, assignment_identity_id);

------------------------------------------------------------------------------
-- 5. Reality ↔ its source rows (doc 34 §4-E).
--
-- `current_published_assignments` carries five references and, before this,
-- none of them had to agree with any other. Now:
--
--   the snapshot belongs to the SOURCE VERSION named on the same row;
--   the source version belongs to the PERIOD named on the same row;
--   the assignment identity belongs to that same PERIOD.
--
-- The last two together are what makes "which period is this reality row for?"
-- answerable in one way rather than three.
------------------------------------------------------------------------------

ALTER TABLE current_published_assignments
    ADD CONSTRAINT current_published_assignments_snapshot_in_source_version_fk
        FOREIGN KEY (source_snapshot_id, organization_id, group_id, source_version_id)
        REFERENCES assignment_snapshots (id, organization_id, group_id, version_id);

ALTER TABLE current_published_assignments
    ADD CONSTRAINT current_published_assignments_version_in_period_fk
        FOREIGN KEY (source_version_id, organization_id, group_id, period_id)
        REFERENCES schedule_versions (id, organization_id, group_id, period_id);

ALTER TABLE current_published_assignments
    ADD CONSTRAINT current_published_assignments_identity_in_period_fk
        FOREIGN KEY (assignment_identity_id, organization_id, group_id, period_id)
        REFERENCES assignment_identities (id, organization_id, group_id, period_id);

------------------------------------------------------------------------------
-- 6. Publication ↔ period/version (doc 34 §4-E).
--
-- `publish` already refuses a version whose period differs, in application code
-- (`VERSION_PERIOD_MISMATCH`). That check produces the readable error; this is
-- the control.
------------------------------------------------------------------------------

ALTER TABLE publication_records
    ADD CONSTRAINT publication_records_version_in_period_fk
        FOREIGN KEY (version_id, organization_id, group_id, period_id)
        REFERENCES schedule_versions (id, organization_id, group_id, period_id);

------------------------------------------------------------------------------
-- 7. Shift ↔ location (doc 34 §4-F).
--
-- 0009 created `shifts.location_id` with NO foreign key, because `locations`
-- did not exist yet, and said so: "the column exists per doc 06 §3.2 so a later
-- migration only adds the FK". This is that migration.
--
-- **NULL stays legal, and that is a stated allowed state, not an oversight.**
-- A shift without a location is an ordinary single-site rota; `ensureShift`
-- creates exactly that today and `shifts_unique_in_version` already COALESCEs
-- the NULL into a stable key. MATCH SIMPLE (the default) skips the check when
-- `location_id` is NULL, which is precisely the semantics wanted.
--
-- Group-qualified, like every other reference here: a shift in Group One can
-- never name Group Two's location.
------------------------------------------------------------------------------

ALTER TABLE shifts
    ADD CONSTRAINT shifts_location_in_group_fk
        FOREIGN KEY (location_id, organization_id, group_id)
        REFERENCES locations (id, organization_id, group_id);

------------------------------------------------------------------------------
-- 8. The timezone snapshot (doc 34 §4-F).
--
-- Two nullable columns on `schedule_versions`, so a published version's
-- rendering is reproducible after the group's zone changes:
--
--   `timezone_basis`  the IANA zone the version's instants were derived under
--   `tzdb_version`    the tz DATABASE rule set in use when they were derived
--                     (`process.versions.tz`, e.g. `2026b`)
--
-- ## Why both, and why the second is not paranoia
--
-- A zone identifier alone does not determine a rendering. `America/Santiago`
-- moved its DST dates twice in a decade; a version published under one rule set
-- and re-rendered under another produces different local times from the same
-- stored instants, with the same zone id on both. Recording the rule set makes
-- a divergence DETECTABLE — it does not make it impossible, and nothing here
-- pretends otherwise: this repository has one tz database (the runtime's), so
-- the honest claim is "we can tell you the interpretation changed", not "we can
-- reproduce the old one".
--
-- ## Why they are NOT in the D-15b permitted set
--
-- `app_guard_schedule_version_transition` freezes every column on a
-- published/superseded row except five named ones. These two are deliberately
-- not added to that list, so once a version is published its recorded
-- interpretation is immutable exactly like the rest of its content (I-18). They
-- are written while the version is still a draft and re-affirmed by the
-- publication's own UPDATE, whose OLD.state is `publishing` — a state the guard
-- returns early for.
--
-- ## Nullable, because 0001..0013's rows exist
--
-- Every version created before this migration has no recorded basis, and
-- inventing one would be a backfill that asserts a fact nobody measured. NULL
-- reads as "not recorded", the read surfaces fall back to the group's current
-- zone exactly as they do today, and the fallback is visible rather than
-- disguised as a snapshot.
------------------------------------------------------------------------------

ALTER TABLE schedule_versions ADD COLUMN timezone_basis text;
ALTER TABLE schedule_versions ADD COLUMN tzdb_version text;

ALTER TABLE schedule_versions
    ADD CONSTRAINT schedule_versions_timezone_basis_shape
        CHECK (timezone_basis IS NULL
               OR (length(btrim(timezone_basis)) > 0 AND length(timezone_basis) <= 64));

ALTER TABLE schedule_versions
    ADD CONSTRAINT schedule_versions_tzdb_version_shape
        CHECK (tzdb_version IS NULL
               OR (length(btrim(tzdb_version)) > 0 AND length(tzdb_version) <= 32));

GRANT UPDATE (timezone_basis, tzdb_version) ON schedule_versions TO app_runtime, app_worker;

------------------------------------------------------------------------------
-- 9. The invariants a foreign key cannot express.
--
-- Four triggers. Each raises a NAMED error with `restrict_violation`, the same
-- convention 0009's D-15 guards use, so a caller is told which rule it broke
-- rather than being handed a constraint name.
------------------------------------------------------------------------------

-- 9a. requirement.date ∈ [period.start_date, period.end_date] (doc 34 §4-E).
--
-- A requirement dated outside its own period is demand the solver would be
-- asked to satisfy on a day the period does not contain. There is no FK shape
-- for "a date inside a range on the parent row".
CREATE FUNCTION app_guard_requirement_in_period_range() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_start date;
    v_end   date;
BEGIN
    SELECT start_date, end_date INTO v_start, v_end
      FROM schedule_periods
     WHERE id              = NEW.period_id
       AND organization_id = NEW.organization_id
       AND group_id        = NEW.group_id;

    -- The composite FK already guarantees the row exists and is in this tenant;
    -- if RLS somehow hid it we fail CLOSED rather than skipping the check.
    IF v_start IS NULL THEN
        RAISE EXCEPTION
            'SCHEDULE_REQUIREMENT_PERIOD_UNREADABLE: period % is not readable in this context, '
            'so its date range cannot be checked (doc 34 §4-E)', NEW.period_id
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.date < v_start OR NEW.date > v_end THEN
        RAISE EXCEPTION
            'SCHEDULE_REQUIREMENT_OUT_OF_PERIOD: requirement date % lies outside period % '
            '(% .. %) (doc 34 §4-E)', NEW.date, NEW.period_id, v_start, v_end
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_guard_requirement_in_period_range() FROM PUBLIC;

CREATE TRIGGER schedule_requirements_period_range_guard
    BEFORE INSERT OR UPDATE ON schedule_requirements
    FOR EACH ROW EXECUTE FUNCTION app_guard_requirement_in_period_range();

-- 9b. shifts: the date is inside the version's PERIOD, and a NEW reference to
--     an ARCHIVED location is refused (doc 34 §4-E and §4-F, one trigger
--     because both are checks on the same row at the same moment).
--
-- ## Archived locations: refuse NEW references, retain existing ones
--
-- 0010 gives `locations` `status ∈ {active, archived}` and no delete path,
-- because history references the row. The packet's rule follows from that:
-- archiving must not orphan or rewrite a published schedule, so EXISTING
-- references are retained and rendered with the archived marker, while a NEW
-- reference — an INSERT, or an UPDATE that CHANGES `location_id` — is refused.
-- Any other rule either breaks published history (delete/cascade) or lets a
-- decommissioned place accumulate new rota (accept silently).
--
-- The check is deliberately on the CHANGE, not on the value: an unrelated
-- UPDATE to a shift that already points at an archived location (changing
-- `required_count`, say) is not a new reference and is not refused. A guard
-- written on the value alone would make an archived location's existing shifts
-- permanently uneditable, which is a different bug wearing the same name.
--
-- The trigger is named `shifts_location_and_range_guard`: `l` sorts after the
-- `i` of `shifts_immutable_when_published`, so a write against a PUBLISHED
-- version is refused with the I-18 message first. Trigger firing order is by
-- name and this name is chosen.
CREATE FUNCTION app_guard_shift_graph() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_start          date;
    v_end            date;
    v_period         uuid;
    v_location_state text;
BEGIN
    SELECT p.id, p.start_date, p.end_date
      INTO v_period, v_start, v_end
      FROM schedule_versions v
      JOIN schedule_periods p
        ON p.id              = v.period_id
       AND p.organization_id = v.organization_id
       AND p.group_id        = v.group_id
     WHERE v.id              = NEW.version_id
       AND v.organization_id = NEW.organization_id
       AND v.group_id        = NEW.group_id;

    IF v_period IS NULL THEN
        RAISE EXCEPTION
            'SCHEDULE_SHIFT_PERIOD_UNREADABLE: the period of version % is not readable in this '
            'context, so the shift date cannot be checked (doc 34 §4-E)', NEW.version_id
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.date < v_start OR NEW.date > v_end THEN
        RAISE EXCEPTION
            'SCHEDULE_SHIFT_OUT_OF_PERIOD: shift date % lies outside the period % of version % '
            '(% .. %) (doc 34 §4-E)', NEW.date, v_period, NEW.version_id, v_start, v_end
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.location_id IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.location_id IS DISTINCT FROM OLD.location_id) THEN
        SELECT status INTO v_location_state
          FROM locations
         WHERE id              = NEW.location_id
           AND organization_id = NEW.organization_id
           AND group_id        = NEW.group_id;

        IF v_location_state IS NULL THEN
            RAISE EXCEPTION
                'SCHEDULE_SHIFT_LOCATION_UNREADABLE: location % is not readable in this context',
                NEW.location_id
                USING ERRCODE = 'restrict_violation';
        END IF;

        IF v_location_state <> 'active' THEN
            RAISE EXCEPTION
                'SCHEDULE_SHIFT_LOCATION_ARCHIVED: location % is archived and cannot take a NEW '
                'shift reference; existing references are retained (doc 34 §4-F)', NEW.location_id
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_guard_shift_graph() FROM PUBLIC;

CREATE TRIGGER shifts_location_and_range_guard
    BEFORE INSERT OR UPDATE ON shifts
    FOR EACH ROW EXECUTE FUNCTION app_guard_shift_graph();

-- 9c. assignment_snapshots: the identity's PERIOD equals the version's period,
--     and the participant's MEMBERSHIP STATE admits a new assignment
--     (doc 34 §4-C and §4-E).
--
-- ## The identity/period arm
--
-- An `assignment_identity` belongs to a period; a `schedule_version` belongs to
-- a period; a snapshot joins one of each and carries neither column, so no FK
-- can make them agree. Without this, an identity minted in period P could be
-- carried into a version of period Q, and "what changed between versions?" —
-- which is a join on `assignment_identity_id` and nothing else — would silently
-- compare across periods.
--
-- ## The membership-state arm, and what it deliberately does NOT do
--
-- Doc 34 §4-C: "define and enforce membership kind, active/inactive behaviour,
-- effective dates, ended membership behaviour". The rules, each stated:
--
--   R-B1  A NEW assignment target must be an `active` membership. `invited`,
--         `suspended` and `ended` are refused.
--   R-B2  A NEW assignment must fall inside the membership's effective window:
--         `starts_at >= valid_from`, and `ends_at <= valid_to` when `valid_to`
--         is set. SPEC-06 L3.3 already treats `now ∈ [valid_from, valid_to)` as
--         the authorization window; this is the same window applied to the work
--         rather than to the actor.
--   R-B3  EXISTING assignments are retained when a membership later changes
--         state. The guard fires on INSERT and on a CHANGE of `membership_id`,
--         and on nothing else — so cancelling, pinning or re-timing an
--         assignment that belongs to a since-suspended member still works.
--         Anything else would make a suspension retroactively corrupt a
--         published rota, which is the opposite of what a suspension means.
--
-- **There is no manual-override arm here, and that is a decision.** The packet
-- says "with the manual-override arm and reason where FAD-23 sanctions it", and
-- FAD-23 does not sanction it here. FAD-23's override exists because an
-- eligibility ABSENCE can be an access-control artefact — `staffing.
-- qualification_holding.read` is grant-only, so a scheduler may be unable to see
-- a credential that exists, and rendering that as "not qualified" would
-- manufacture a false safety statement. Membership state has no such ambiguity:
-- it is fully visible to every principal who can reach this surface, and an
-- `ended` membership is not a person with a relationship to this group to be
-- scheduled into. An override would be an override of a fact, not of a judgement.
CREATE FUNCTION app_guard_assignment_snapshot_graph() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_version_period  uuid;
    v_identity_period uuid;
    v_status          text;
    v_valid_from      timestamptz;
    v_valid_to        timestamptz;
    v_kind            text;
BEGIN
    SELECT period_id INTO v_version_period
      FROM schedule_versions
     WHERE id              = NEW.version_id
       AND organization_id = NEW.organization_id
       AND group_id        = NEW.group_id;

    SELECT period_id INTO v_identity_period
      FROM assignment_identities
     WHERE id              = NEW.assignment_identity_id
       AND organization_id = NEW.organization_id
       AND group_id        = NEW.group_id;

    IF v_version_period IS NULL OR v_identity_period IS NULL THEN
        RAISE EXCEPTION
            'SCHEDULE_SNAPSHOT_PARENTS_UNREADABLE: the version or identity of this snapshot is '
            'not readable in this context (doc 34 §4-E)'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF v_version_period <> v_identity_period THEN
        RAISE EXCEPTION
            'SCHEDULE_SNAPSHOT_PERIOD_MISMATCH: assignment identity % belongs to period %, but '
            'version % belongs to period % (doc 34 §4-E)',
            NEW.assignment_identity_id, v_identity_period, NEW.version_id, v_version_period
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- R-B3: only a NEW assignment target is examined.
    IF TG_OP = 'INSERT' OR NEW.membership_id IS DISTINCT FROM OLD.membership_id THEN
        SELECT kind, status, valid_from, valid_to
          INTO v_kind, v_status, v_valid_from, v_valid_to
          FROM memberships
         WHERE id              = NEW.membership_id
           AND organization_id = NEW.organization_id
           AND group_id        = NEW.group_id;

        IF v_status IS NULL THEN
            RAISE EXCEPTION
                'SCHEDULE_ASSIGNEE_UNREADABLE: membership % is not a readable member of this '
                'group (doc 34 §4-C)', NEW.membership_id
                USING ERRCODE = 'restrict_violation';
        END IF;

        -- Kind is already implied by the composite FK (an organization
        -- membership has a NULL group_id and cannot match), and is asserted
        -- anyway so the rule is stated where it is enforced.
        IF v_kind <> 'group' THEN
            RAISE EXCEPTION
                'SCHEDULE_ASSIGNEE_NOT_GROUP_MEMBERSHIP: membership % is a % membership; a '
                'schedule participant is a GROUP membership (doc 34 §4-C)',
                NEW.membership_id, v_kind
                USING ERRCODE = 'restrict_violation';
        END IF;

        -- R-B1.
        IF v_status <> 'active' THEN
            RAISE EXCEPTION
                'SCHEDULE_ASSIGNEE_NOT_ACTIVE: membership % is %; only an active membership is a '
                'NEW assignment target. Existing assignments are retained (doc 34 §4-C, R-B1/R-B3)',
                NEW.membership_id, v_status
                USING ERRCODE = 'restrict_violation';
        END IF;

        -- R-B2.
        IF NEW.starts_at < v_valid_from THEN
            RAISE EXCEPTION
                'SCHEDULE_ASSIGNEE_BEFORE_MEMBERSHIP: the assignment starts at %, before '
                'membership % becomes effective at % (doc 34 §4-C, R-B2)',
                NEW.starts_at, NEW.membership_id, v_valid_from
                USING ERRCODE = 'restrict_violation';
        END IF;

        IF v_valid_to IS NOT NULL AND NEW.ends_at > v_valid_to THEN
            RAISE EXCEPTION
                'SCHEDULE_ASSIGNEE_AFTER_MEMBERSHIP: the assignment ends at %, after membership '
                '% ends at % (doc 34 §4-C, R-B2)',
                NEW.ends_at, NEW.membership_id, v_valid_to
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_guard_assignment_snapshot_graph() FROM PUBLIC;

-- `p` sorts after the `i` of `assignment_snapshots_immutable_when_published`, so
-- a write against a published version is refused with the I-18 message first.
CREATE TRIGGER assignment_snapshots_participant_and_period_guard
    BEFORE INSERT OR UPDATE ON assignment_snapshots
    FOR EACH ROW EXECUTE FUNCTION app_guard_assignment_snapshot_graph();

-- 9d. A supersession relates two versions of the SAME period (doc 34 §4-E,
--     "supersession metadata").
--
-- `version_supersessions` carries two version ids and no period column, so no FK
-- can make them agree. A cross-period supersession row would make the version
-- history of a period a graph rather than the straight line SPEC-05 §6.1
-- depends on ("history stays a straight line").
CREATE FUNCTION app_guard_supersession_same_period() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_superseded  uuid;
    v_superseding uuid;
BEGIN
    SELECT period_id INTO v_superseded
      FROM schedule_versions
     WHERE id = NEW.superseded_version_id
       AND organization_id = NEW.organization_id
       AND group_id = NEW.group_id;

    SELECT period_id INTO v_superseding
      FROM schedule_versions
     WHERE id = NEW.superseding_version_id
       AND organization_id = NEW.organization_id
       AND group_id = NEW.group_id;

    IF v_superseded IS NULL OR v_superseding IS NULL THEN
        RAISE EXCEPTION
            'SCHEDULE_SUPERSESSION_VERSIONS_UNREADABLE: one of the two versions is not readable '
            'in this context (doc 34 §4-E)'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF v_superseded <> v_superseding THEN
        RAISE EXCEPTION
            'SCHEDULE_SUPERSESSION_PERIOD_MISMATCH: version % (period %) cannot be superseded by '
            'version % (period %); supersession is within one period (doc 34 §4-E)',
            NEW.superseded_version_id, v_superseded, NEW.superseding_version_id, v_superseding
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_guard_supersession_same_period() FROM PUBLIC;

CREATE TRIGGER version_supersessions_same_period_guard
    BEFORE INSERT ON version_supersessions
    FOR EACH ROW EXECUTE FUNCTION app_guard_supersession_same_period();

------------------------------------------------------------------------------
-- 10. `current_published_assignments` ↔ the ACTUAL current published version
--     (doc 34 §4-E; V-15c).
--
-- V-15c already proves the EQUALITY holds after a publication, by reading both
-- sides and comparing. That is a test. This is the arm that makes it a control,
-- in two halves, because the property has two ways to break:
--
--   (a) a row appears for a version that is not the current published one —
--       closed by a BEFORE INSERT check on the row itself;
--   (b) a version stops being current and its rows are left behind — closed by
--       a DEFERRED constraint trigger on `schedule_versions`, evaluated at
--       COMMIT.
--
-- Half (b) MUST be deferred, and that is not a performance choice. The
-- publication transaction legitimately spends several statements in the
-- forbidden state: step 08 clears `is_current` on the outgoing version, and its
-- reality rows are not pruned until step 12. An immediate check would refuse the
-- correct sequence. Deferring to commit asks the only question that matters —
-- "when this transaction is over, does reality still name exactly the current
-- published versions?" — and leaves the intermediate states alone.
------------------------------------------------------------------------------

CREATE FUNCTION app_guard_current_assignment_source() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_state      text;
    v_is_current boolean;
BEGIN
    SELECT state, is_current INTO v_state, v_is_current
      FROM schedule_versions
     WHERE id              = NEW.source_version_id
       AND organization_id = NEW.organization_id
       AND group_id        = NEW.group_id;

    IF v_state IS NULL THEN
        RAISE EXCEPTION
            'SCHEDULE_REALITY_VERSION_UNREADABLE: source version % is not readable in this '
            'context', NEW.source_version_id
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF v_state <> 'published' OR NOT v_is_current THEN
        RAISE EXCEPTION
            'SCHEDULE_REALITY_NOT_CURRENT_VERSION: a current_published_assignments row may only '
            'name the CURRENT PUBLISHED version; version % is % (is_current=%) (doc 34 §4-E, V-15c)',
            NEW.source_version_id, v_state, v_is_current
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_guard_current_assignment_source() FROM PUBLIC;

CREATE TRIGGER current_published_assignments_source_guard
    BEFORE INSERT OR UPDATE ON current_published_assignments
    FOR EACH ROW EXECUTE FUNCTION app_guard_current_assignment_source();

-- Half (b). SECURITY DEFINER for the same reason 0009's child guards are: it
-- must be able to see the reality rows it is asserting the absence of, and an
-- absence check that fails OPEN because a row was invisible proves nothing.
-- Scoped to the tenant columns of the row that changed, so it cannot read
-- across tenants.
CREATE FUNCTION app_guard_retired_version_has_no_reality() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_left integer;
BEGIN
    SELECT count(*) INTO v_left
      FROM current_published_assignments
     WHERE source_version_id = OLD.id
       AND organization_id   = OLD.organization_id
       AND group_id          = OLD.group_id;

    IF v_left > 0 THEN
        RAISE EXCEPTION
            'SCHEDULE_REALITY_ORPHANED: version % stopped being current with % reality row(s) '
            'still naming it; the publication transaction retires them at step 12 '
            '(doc 34 §4-E, V-15c)', OLD.id, v_left
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION app_guard_retired_version_has_no_reality() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER schedule_versions_reality_retired_guard
    AFTER UPDATE ON schedule_versions
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (OLD.is_current AND NOT NEW.is_current)
    EXECUTE FUNCTION app_guard_retired_version_has_no_reality();

-- Down Migration

DROP TRIGGER IF EXISTS schedule_versions_reality_retired_guard ON schedule_versions;
DROP TRIGGER IF EXISTS current_published_assignments_source_guard ON current_published_assignments;
DROP TRIGGER IF EXISTS version_supersessions_same_period_guard ON version_supersessions;
DROP TRIGGER IF EXISTS assignment_snapshots_participant_and_period_guard ON assignment_snapshots;
DROP TRIGGER IF EXISTS shifts_location_and_range_guard ON shifts;
DROP TRIGGER IF EXISTS schedule_requirements_period_range_guard ON schedule_requirements;

DROP FUNCTION IF EXISTS app_guard_retired_version_has_no_reality();
DROP FUNCTION IF EXISTS app_guard_current_assignment_source();
DROP FUNCTION IF EXISTS app_guard_supersession_same_period();
DROP FUNCTION IF EXISTS app_guard_assignment_snapshot_graph();
DROP FUNCTION IF EXISTS app_guard_shift_graph();
DROP FUNCTION IF EXISTS app_guard_requirement_in_period_range();

ALTER TABLE schedule_versions DROP CONSTRAINT IF EXISTS schedule_versions_tzdb_version_shape;
ALTER TABLE schedule_versions DROP CONSTRAINT IF EXISTS schedule_versions_timezone_basis_shape;
ALTER TABLE schedule_versions DROP COLUMN IF EXISTS tzdb_version;
ALTER TABLE schedule_versions DROP COLUMN IF EXISTS timezone_basis;

ALTER TABLE shifts DROP CONSTRAINT IF EXISTS shifts_location_in_group_fk;

ALTER TABLE publication_records
    DROP CONSTRAINT IF EXISTS publication_records_version_in_period_fk;

ALTER TABLE current_published_assignments
    DROP CONSTRAINT IF EXISTS current_published_assignments_identity_in_period_fk;
ALTER TABLE current_published_assignments
    DROP CONSTRAINT IF EXISTS current_published_assignments_version_in_period_fk;
ALTER TABLE current_published_assignments
    DROP CONSTRAINT IF EXISTS current_published_assignments_snapshot_in_source_version_fk;
ALTER TABLE current_published_assignments
    DROP CONSTRAINT IF EXISTS current_published_assignments_participant_in_group_fk;

ALTER TABLE credits DROP CONSTRAINT IF EXISTS credits_snapshot_carries_identity_fk;
ALTER TABLE credits DROP CONSTRAINT IF EXISTS credits_snapshot_in_source_version_fk;
ALTER TABLE credits DROP CONSTRAINT IF EXISTS credits_credited_participant_in_group_fk;

ALTER TABLE assignment_snapshots
    DROP CONSTRAINT IF EXISTS assignment_snapshots_participant_in_group_fk;
ALTER TABLE assignment_snapshots
    DROP CONSTRAINT IF EXISTS assignment_snapshots_shift_in_same_version_fk;

ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_group_identity;
ALTER TABLE assignment_identities DROP CONSTRAINT IF EXISTS assignment_identities_period_identity;
ALTER TABLE schedule_versions DROP CONSTRAINT IF EXISTS schedule_versions_period_identity;
ALTER TABLE assignment_snapshots
    DROP CONSTRAINT IF EXISTS assignment_snapshots_assignment_identity_key;
ALTER TABLE assignment_snapshots DROP CONSTRAINT IF EXISTS assignment_snapshots_version_identity;
ALTER TABLE shifts DROP CONSTRAINT IF EXISTS shifts_version_identity;
