-- OPUS-M2-004 — `shift_type_qualifications`: which qualifications a shift type
-- requires. The join OPUS-M2-002 and OPUS-M2-003 deliberately left unowned
-- (packet 30 §5: "a migration both tasks need is an escalation, not a shared
-- edit"), and the one table that could not belong to either parallel packet
-- because it has a composite tenant foreign key into BOTH of their schemas.
--
-- CAP-011 (the shift-type catalogue) x CAP-058 (qualifications). Doc 06 §3.2:
--
--   | `shift_type_qualifications` | group | `shift_type_id`, `qualification_id` |
--   | pair | — | — | `NONE` | — |
--
-- ADDITIVE ONLY. 0001..0005 are applied and are never edited. Every statement
-- below creates a new object or adds a new constraint/trigger/grant to an
-- existing one. Exactly one statement touches a table this migration does not
-- create — `ALTER TABLE qualifications ADD CONSTRAINT … UNIQUE (id,
-- organization_id, group_id)` — and it is additive, drops nothing, and relaxes
-- nothing. Its reason is below, under the foreign keys.
--
-- Normative sources:
--   06 §3.2                    — the row above, and §1's conventions: composite
--                                tenant FK, UUID surrogate key, `version`, audit
--                                fields, soft lifecycle, RLS enabled AND forced
--                                with its policy in the same migration
--   SPEC-01 §4.3               — predicate spelling, the V-09 group predicate,
--                                tenant-qualified uniques
--   SPEC-06 §1.1               — "Everything not in this enumeration is
--                                group-scoped": authoring a shift type's
--                                qualification requirements is catalogue
--                                authoring, so the policy is the group predicate
--   doc 08 §6                  — "Author catalogue & rules" (scheduler, group
--                                admin) is the capability that writes this table
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE PREDICATE SPELLING IS NORMATIVE AND IS WRITTEN OUT IN FULL.
--
--   nullif(current_setting('app.<x>', true), '')::uuid
--
-- The reasoning is in 0001 and is not repeated. What IS repeated is the spelling
-- itself, per reference, because `apps/api/test/tenancy/roles-and-schema.test.ts`
-- (A-03b) reads `pg_policies` and asserts every individual `current_setting`
-- occurrence is nullif-guarded — and a helper function would hide the one that
-- was not.
-- ─────────────────────────────────────────────────────────────────────────────

-- Up Migration

------------------------------------------------------------------------------
-- The second parent needs a GROUP-qualified identity to be pointed at.
--
-- 0004 gave `qualifications` a `qualifications_tenant_identity UNIQUE (id,
-- organization_id)`. A foreign key can only reference a unique constraint, so
-- with that alone the strongest composite key available here would be
-- `(qualification_id, organization_id)` — which would let a shift type in Group
-- One require a qualification defined in Group Two of the SAME organization.
--
-- That is not hypothetical tidiness. Both tables are group-scoped, the RLS
-- policies are group-scoped, and a row whose two ends live in different groups
-- is a row no single group context can ever see in full: the eligibility read
-- would return a requirement whose qualification is invisible to the reader.
-- The database should refuse to record it, and with this constraint it does.
--
-- Additive: a new UNIQUE constraint on a table whose existing constraints,
-- policies and grants are untouched. `(id, organization_id)` already guarantees
-- uniqueness of `id`, so this one can never fail on existing data.
------------------------------------------------------------------------------

ALTER TABLE qualifications
    ADD CONSTRAINT qualifications_tenant_group_identity
    UNIQUE (id, organization_id, group_id);

------------------------------------------------------------------------------
-- shift_type_qualifications — the requirement edge.
--
-- ## What the row means
--
-- "A member assigned to this shift type must hold this qualification." Nothing
-- in this milestone ENFORCES that — enforcement is the M4 engine's, and this
-- table is its input. What ships here is the authoring surface, the tenancy, the
-- authorization, the audit trail, and a read that answers the two questions the
-- engine and the roster author both ask:
--
--   * which qualifications does shift type X require?
--   * which shift types is member M qualified for?
--
-- ## Why `status` and not a DELETE
--
-- Doc 06 §3.2's row shows no state column, and doc 06 §1 shows the reason it
-- needs one anyway: "Hard deletion is prohibited wherever history or audit
-- references the row." A requirement that was in force when a schedule was built
-- is part of why that schedule looks the way it does. Removing the requirement
-- must not make the published roster unexplainable, so removal is
-- `status = 'archived'` and the row stays.
--
-- **This extends doc 06 §3.2's cell, which reads `—` for State.** The packet
-- requires archive-not-delete for this table in as many words; the divergence
-- from the table cell is deliberate, disclosed in the return report, and is an
-- addition rather than a contradiction.
--
-- ## Re-adding an archived requirement
--
-- The unique key is on the PAIR, not on the pair plus status, so re-adding a
-- requirement reactivates the archived row rather than inserting a second one.
-- The alternative — unique on (pair, status) — would accumulate a row per
-- add/remove cycle and make "does this shift type require X?" a question with
-- more than one answer.
------------------------------------------------------------------------------

CREATE TABLE shift_type_qualifications (
    id               uuid PRIMARY KEY,
    organization_id  uuid NOT NULL REFERENCES organizations (id),
    group_id         uuid NOT NULL,
    shift_type_id    uuid NOT NULL,
    qualification_id uuid NOT NULL,

    status           text NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'archived')),

    version          integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    -- The PAIR is unique within the group, per doc 06 §3.2's "pair" uniqueness.
    CONSTRAINT shift_type_qualifications_pair_unique_in_group
        UNIQUE (organization_id, group_id, shift_type_id, qualification_id),

    -- Composite tenant identity, so a future child of this table can point at it
    -- the way this table points at its own parents.
    CONSTRAINT shift_type_qualifications_tenant_identity
        UNIQUE (id, organization_id, group_id),

    -- ── the composite foreign keys, to BOTH parents ────────────────────────
    --
    -- Both carry `organization_id` AND `group_id`, so neither end can be
    -- re-tenanted and neither end can point across a group boundary. A plain
    -- `REFERENCES shift_types (id)` would have been satisfied by a shift type in
    -- another organization entirely; RLS would have hidden the row afterwards,
    -- which is a different and much later kind of finding.
    CONSTRAINT shift_type_qualifications_shift_type_fk
        FOREIGN KEY (shift_type_id, organization_id, group_id)
        REFERENCES shift_types (id, organization_id, group_id),

    CONSTRAINT shift_type_qualifications_qualification_fk
        FOREIGN KEY (qualification_id, organization_id, group_id)
        REFERENCES qualifications (id, organization_id, group_id),

    CONSTRAINT shift_type_qualifications_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id)
);

-- Both directions are read: "what does this shift type require" and "what
-- requires this qualification" (which is what the member-eligibility read walks).
CREATE INDEX shift_type_qualifications_by_shift_type
    ON shift_type_qualifications (organization_id, group_id, shift_type_id, status);

CREATE INDEX shift_type_qualifications_by_qualification
    ON shift_type_qualifications (organization_id, group_id, qualification_id, status);

------------------------------------------------------------------------------
-- Row level security. ENABLE **and** FORCE, with the policy in this same
-- migration (06 §1, I-15; the `migration-rls` gate asserts the pairing and
-- `apps/api/test/catalogue/gate-red-cases.test.ts` proves the gate fails on a
-- violation).
------------------------------------------------------------------------------

ALTER TABLE shift_type_qualifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_type_qualifications FORCE  ROW LEVEL SECURITY;

-- V-09's conjunctive group predicate, in full. All three clauses matter:
--
--   organization_id = app.organization_id   the tenant boundary
--   app.group_id IS NOT NULL                a group-scoped context is REQUIRED;
--                                           without it an organization-scoped
--                                           context would match every row whose
--                                           group_id happened to be NULL
--   group_id = app.group_id                 the CAR-001 defect class, caught
--                                           below the application layer
CREATE POLICY shift_type_qualifications_group_scope ON shift_type_qualifications
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
-- Both reuse 0005's functions unchanged. That reuse is the point: one
-- implementation of "the acting membership holds `schedule.catalogue.administer`"
-- and one implementation of "the database owns `version`". A second copy of
-- either is a second thing that can drift from the control it duplicates.
--
-- `_maintain_` sorts after `_guard_`, and trigger firing order is by name, so an
-- unauthorized write is refused before the counter moves.
------------------------------------------------------------------------------

CREATE TRIGGER shift_type_qualifications_guard_administration
    BEFORE INSERT OR UPDATE ON shift_type_qualifications
    FOR EACH ROW EXECUTE FUNCTION app_guard_catalogue_administration();

CREATE TRIGGER shift_type_qualifications_maintain_version
    BEFORE UPDATE ON shift_type_qualifications
    FOR EACH ROW EXECUTE FUNCTION app_maintain_catalogue_version();

------------------------------------------------------------------------------
-- Archive, never delete — enforced for the table OWNER, not only by a missing
-- grant.
--
-- No runtime role holds DELETE on any tenant table, and
-- `roles-and-schema.test.ts` asserts it. But the runtime is not the only caller
-- a database has: a migration or a maintenance script runs as the OWNER, and
-- "the runtime cannot reach it" is a different claim from "it cannot happen".
-- 0004 makes exactly this argument for `app_guard_qualification_delete` and
-- `app_guard_work_profile_delete`; it applies here verbatim.
--
-- What is lost by a deletion is specific: a requirement that was in force when a
-- schedule was built is part of why that schedule looks the way it does. Delete
-- the row and the roster becomes unexplainable — and, unlike a gap in a
-- sequence, the deletion leaves no trace, because the remaining requirement set
-- is still perfectly well-formed.
------------------------------------------------------------------------------

CREATE FUNCTION app_guard_shift_type_qualification_delete() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION
        'SHIFT_TYPE_QUALIFICATION_RETAINED: a qualification requirement is part of the '
        'explanation of every schedule built while it was in force and is never deleted; '
        'archive it instead (status = ''archived'')'
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER shift_type_qualifications_guard_delete
    BEFORE DELETE ON shift_type_qualifications
    FOR EACH ROW EXECUTE FUNCTION app_guard_shift_type_qualification_delete();

------------------------------------------------------------------------------
-- Grants. Column-level UPDATE, as everywhere else.
--
-- **`version` is not grantable**, for the reason 0005 records: an independent
-- review set it back to 1 as `app_runtime` while it was, and then demonstrated
-- the lost update it is supposed to prevent. The database owns it.
--
-- **`id`, `organization_id`, `group_id`, `shift_type_id` and `qualification_id`
-- are not updatable.** A requirement edge cannot be re-tenanted and cannot be
-- re-pointed: changing which qualification a row names would silently rewrite
-- the meaning of every schedule built against it. Archiving one row and adding
-- another is the way to change a requirement, and it leaves both facts visible.
------------------------------------------------------------------------------

GRANT SELECT, INSERT ON shift_type_qualifications TO app_runtime, app_worker;

GRANT UPDATE (status, updated_at) ON shift_type_qualifications TO app_runtime, app_worker;

GRANT SELECT ON shift_type_qualifications TO app_readonly_support, app_breakglass;

-- PostgreSQL grants EXECUTE to PUBLIC on every new function, so a GRANT without
-- a REVOKE reads as a restriction and is not one. The function is a trigger
-- function, unreachable except through its trigger — revoked anyway rather than
-- relying on that, exactly as 0002 through 0005 do.
REVOKE ALL ON FUNCTION app_guard_shift_type_qualification_delete() FROM PUBLIC;

-- Down Migration

DROP TRIGGER IF EXISTS shift_type_qualifications_guard_delete          ON shift_type_qualifications;
DROP TRIGGER IF EXISTS shift_type_qualifications_maintain_version      ON shift_type_qualifications;
DROP TRIGGER IF EXISTS shift_type_qualifications_guard_administration  ON shift_type_qualifications;

DROP FUNCTION IF EXISTS app_guard_shift_type_qualification_delete();

DROP POLICY IF EXISTS shift_type_qualifications_group_scope ON shift_type_qualifications;

DROP INDEX IF EXISTS shift_type_qualifications_by_qualification;
DROP INDEX IF EXISTS shift_type_qualifications_by_shift_type;

DROP TABLE IF EXISTS shift_type_qualifications;

-- The borrowed unique constraint last: the table that referenced it is gone by
-- here, so dropping it cannot orphan a foreign key.
ALTER TABLE qualifications DROP CONSTRAINT IF EXISTS qualifications_tenant_group_identity;
