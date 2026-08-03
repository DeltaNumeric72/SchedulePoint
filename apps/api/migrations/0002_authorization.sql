-- OPUS-M1-002 — authorization: roles, role capabilities, capability grants,
-- entitlements, and per-group module availability.
--
-- ADDITIVE ONLY. `0001_tenancy_core.sql` is applied and is never edited
-- (packet: "no modification to OPUS-M1-001's migrations"). Everything below
-- either creates a new object or attaches a new trigger/policy to an existing
-- one — no `ALTER TABLE ... ALTER COLUMN`, no policy is dropped, no constraint
-- is relaxed.
--
-- Normative sources:
--   SPEC-06 §1    — PolicyInput; the relations L1..L4 read
--   SPEC-06 §1.1  — the organization-scoped action set
--   SPEC-06 §2    — the truth table (evaluated in packages/domain/src/authz)
--   SPEC-06 §2.1  — P-7: "Overlapping grant windows for one capability are
--                   prohibited by an exclusion constraint"
--   SPEC-06 §4    — the freshness counters an entitlement/grant change bumps
--   SPEC-01 §4.3  — RLS predicate spelling, the group predicate (V-09), FORCE
--                   RLS, composite tenant FKs, tenant-qualified unique keys;
--                   EX-2 and EX-3 as amended 2026-08-02 (FAD-11)
--   06 §3.1       — the table catalogue these five rows come from
--   08 §4         — the named capability grants
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE PREDICATE SPELLING IS NORMATIVE AND IS WRITTEN OUT IN FULL, EVERY TIME.
--
--   nullif(current_setting('app.<x>', true), '')::uuid
--
-- The reasoning is in `0001_tenancy_core.sql` and is not repeated. What matters
-- here is that it holds for EVERY reference: `roles-and-schema.test.ts` (A-03b)
-- reads `pg_policies` and asserts that every individual `current_setting('app.*')`
-- occurrence in every policy is nullif-guarded, and it now covers these tables
-- too.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHAT IS **NOT** HERE, AND WHY:
--
--   `capabilities`, `module_definitions`, `module_dependencies` — doc 06 §3.1
--   gives all three tenant scope `system`. They are reference data identical for
--   every organization, and SPEC-06 A-14/A-16 require an unknown capability key
--   and a both-namespaces key to fail the **build**. A row cannot fail a build.
--   They live in `packages/domain/src/authz/catalogue.ts` as constants, which
--   also keeps the evaluator pure (SPEC-06 §1: "it performs no I/O"). Recorded
--   as a deviation in `docs/evidence/EV-M1-AUTHZ/INDEX.md` §6.
--
--   `membership_roles` — CAP-006 lists it. `memberships.group_role` /
--   `.organization_role` already carry the current role and are NOT NULL by
--   0001's `memberships_kind_shape` CHECK, so a second authoritative store would
--   be two sources of truth for the same fact. The effective-dated,
--   EXCLUDE-constrained store the packet asks for is `capability_grants`, which
--   is where per-membership authorization actually varies over time.

-- Up Migration

------------------------------------------------------------------------------
-- `btree_gist` — required for the EXCLUDE constraints below.
--
-- P-7 needs `EXCLUDE USING gist (… WITH =, … WITH &&)`, and gist has no default
-- operator class for `uuid`/`text` equality without this extension. It is a
-- TRUSTED extension in PostgreSQL 13+, so the database owner (`app_migrator`)
-- can install it without superuser — verified against this cluster before the
-- migration was written, because a migration that needs superuser is a
-- migration that cannot run under the SPEC-01 §4.4 role matrix.
------------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS btree_gist;

------------------------------------------------------------------------------
-- roles — a named bundle of capabilities, per organization.
--
-- doc 06 §3.1 gives `roles` tenant scope "org/system" with `is_system_role`.
-- Here every row is organization-owned; `is_system_role` marks the ones the
-- provisioning path seeds and administration may not delete. That keeps the RLS
-- predicate a plain organization predicate rather than "organization OR NULL",
-- which is the shape that leaks when someone later forgets the OR.
--
-- `scope` is the P-10 namespace. A role is group-scoped or organization-scoped,
-- never both, and the evaluator selects by `(scope, key)` — so an organization
-- role named `scheduler` could never satisfy a group action even if someone
-- created one.
------------------------------------------------------------------------------

CREATE TABLE roles (
    id               uuid PRIMARY KEY,
    organization_id  uuid NOT NULL REFERENCES organizations (id),
    scope            text NOT NULL CHECK (scope IN ('group', 'organization')),
    key              text NOT NULL CHECK (length(btrim(key)) > 0),
    name             text NOT NULL CHECK (length(btrim(name)) > 0),
    is_system_role   boolean NOT NULL DEFAULT false,
    status           text NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'deprecated')),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    -- SPEC-01 §4 amendment (a): the tenant-qualified identity composite FKs
    -- reference. A single-column FK would accept a role from another
    -- organization, because FK checks bypass RLS (X-06).
    CONSTRAINT roles_tenant_identity UNIQUE (id, organization_id),

    -- SPEC-01 §4 amendment (b): tenant-QUALIFIED, and leading with
    -- organization_id, so a 23505 can only ever be raised against a row in the
    -- caller's own organization.
    CONSTRAINT roles_key_unique_in_organization UNIQUE (organization_id, scope, key)
);

CREATE INDEX roles_organization_idx ON roles (organization_id, scope);

------------------------------------------------------------------------------
-- role_capabilities — SPEC-06 L4.2's `role_caps` / `org_role_caps`.
--
-- `capability_key` is deliberately NOT a foreign key: the capability vocabulary
-- is a code constant (see the header), so the referential check is the
-- build-time one in `apps/api/test/http/route-declarations.test.ts` plus the
-- evaluator's P-4 backstop. A CHECK constraint listing twenty keys would have to
-- be edited by a migration every time the catalogue grows, and a stale CHECK
-- that silently rejects a legitimate key is a worse failure than a stale
-- constant that a test catches.
------------------------------------------------------------------------------

CREATE TABLE role_capabilities (
    id               uuid PRIMARY KEY,
    organization_id  uuid NOT NULL,
    role_id          uuid NOT NULL,
    capability_key   text NOT NULL CHECK (length(btrim(capability_key)) > 0),
    created_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT role_capabilities_role_fk
        FOREIGN KEY (role_id, organization_id)
        REFERENCES roles (id, organization_id),

    CONSTRAINT role_capabilities_unique_in_organization
        UNIQUE (organization_id, role_id, capability_key)
);

CREATE INDEX role_capabilities_lookup
    ON role_capabilities (organization_id, role_id, capability_key);

------------------------------------------------------------------------------
-- capability_grants — SPEC-06 L4.1 and L4.2's `grants`.
--
-- `granted = false` is an EXPLICIT DENY and beats every allow inside its window
-- (P-1). That is the entire reason for the exclusion constraint below:
--
--   > **P-7** Overlapping grant windows for one capability are **prohibited by
--   > an exclusion constraint** — P-1 needs a single unambiguous row.
--
-- With two overlapping rows, one allowing and one denying, the answer would
-- depend on which row the planner returned first. The constraint makes that
-- state unrepresentable rather than merely unlikely.
--
-- `group_id` is NULL for a grant on an ORGANIZATION membership and NOT NULL for
-- one on a group membership, mirroring `memberships`. **The binding is enforced,
-- not assumed**: `app_guard_capability_grant_administration` below refuses any
-- row whose `group_id` differs from the referenced membership's, because the
-- composite membership FK is over `(membership_id, organization_id)` only and
-- cannot see `group_id`.
--
-- Without that check a grant filed under the wrong `group_id` would be invisible
-- under the correct group's context (`capability_grants_group_scope` requires
-- `group_id = app.group_id`) — a silent, permanent revocation with no error —
-- while remaining live for an organization-scoped evaluation, which filters by
-- `membership_id` alone.
------------------------------------------------------------------------------

CREATE TABLE capability_grants (
    id                        uuid PRIMARY KEY,
    organization_id           uuid NOT NULL,
    -- NULL means the grant is on an ORGANIZATION membership. Not a missing value.
    group_id                  uuid,
    membership_id             uuid NOT NULL,
    capability_key            text NOT NULL CHECK (length(btrim(capability_key)) > 0),
    granted                   boolean NOT NULL,
    -- Attribution. Nullable only for the provisioning path, which has no actor.
    granted_by_membership_id  uuid,
    reason                    text CHECK (reason IS NULL OR length(btrim(reason)) > 0),
    valid_from                timestamptz NOT NULL DEFAULT now(),
    valid_to                  timestamptz,
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT capability_grants_window CHECK (valid_to IS NULL OR valid_to > valid_from),

    CONSTRAINT capability_grants_membership_fk
        FOREIGN KEY (membership_id, organization_id)
        REFERENCES memberships (id, organization_id),

    CONSTRAINT capability_grants_granted_by_fk
        FOREIGN KEY (granted_by_membership_id, organization_id)
        REFERENCES memberships (id, organization_id),

    CONSTRAINT capability_grants_group_fk
        FOREIGN KEY (group_id, organization_id)
        REFERENCES groups (id, organization_id),

    CONSTRAINT capability_grants_tenant_identity UNIQUE (id, organization_id),

    -- P-7. `[)` matches the half-open window the evaluator uses at every layer:
    -- `now ∈ [valid_from, valid_to)`. A closed upper bound here would make two
    -- windows that merely touch — one ending exactly when the next begins —
    -- collide, and end-dating a grant by starting its replacement at the same
    -- instant is the ordinary way to change one.
    CONSTRAINT capability_grants_no_overlapping_window
        EXCLUDE USING gist (
            organization_id WITH =,
            membership_id   WITH =,
            capability_key  WITH =,
            tstzrange(valid_from, valid_to, '[)') WITH &&
        )
);

CREATE INDEX capability_grants_lookup
    ON capability_grants (organization_id, membership_id, capability_key);

------------------------------------------------------------------------------
-- entitlements — CAP-057, PO-DEC-04. SPEC-06 L1.1..L1.3.
--
-- Organization-level, effective-dated, and non-overlapping per module for the
-- same reason grants are: L1.2 and L1.3 must have exactly one row to read.
--
-- `state ∈ {trial, active, suspended, revoked}` per doc 05 §3.1. Disabling
-- never deletes data (§2.2) — a suspension is a state change on this row and
-- nothing else, which is what makes "re-enable: full access restored, data
-- intact. No migration, no reconstruction" true by construction.
------------------------------------------------------------------------------

CREATE TABLE entitlements (
    id               uuid PRIMARY KEY,
    organization_id  uuid NOT NULL REFERENCES organizations (id),
    module_key       text NOT NULL CHECK (length(btrim(module_key)) > 0),
    state            text NOT NULL
                         CHECK (state IN ('trial', 'active', 'suspended', 'revoked')),
    effective_from   timestamptz NOT NULL DEFAULT now(),
    effective_to     timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT entitlements_window CHECK (effective_to IS NULL OR effective_to > effective_from),
    CONSTRAINT entitlements_tenant_identity UNIQUE (id, organization_id),

    CONSTRAINT entitlements_no_overlapping_window
        EXCLUDE USING gist (
            organization_id WITH =,
            module_key      WITH =,
            tstzrange(effective_from, effective_to, '[)') WITH &&
        )
);

CREATE INDEX entitlements_lookup ON entitlements (organization_id, module_key);

------------------------------------------------------------------------------
-- group_module_availability — SPEC-06 L2.1, the second of the four layers.
--
--   > **Layer 2 · Group/module availability** — *Is this group using it?*
--   > Merging with entitlement means a customer cannot pilot a module in one
--   > group. (doc 05 §1)
--
-- An ABSENT row means NOT available. The evaluator says so and this schema
-- agrees by having no default row: the opposite reading would make every new
-- group silently able to use every entitled module, which is fail-open.
------------------------------------------------------------------------------

CREATE TABLE group_module_availability (
    id               uuid PRIMARY KEY,
    organization_id  uuid NOT NULL,
    group_id         uuid NOT NULL,
    module_key       text NOT NULL CHECK (length(btrim(module_key)) > 0),
    available        boolean NOT NULL DEFAULT false,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT group_module_availability_group_fk
        FOREIGN KEY (group_id, organization_id)
        REFERENCES groups (id, organization_id),

    CONSTRAINT group_module_availability_unique_in_group
        UNIQUE (organization_id, group_id, module_key)
);

CREATE INDEX group_module_availability_lookup
    ON group_module_availability (organization_id, group_id, module_key);

/**
 * "Does the acting membership's ROLE carry this capability" — **role-derived
 * only, and that restriction is what makes it safe inside a POLICY.**
 *
 * `app_acting_membership_holds` reads `capability_grants`, so a policy ON
 * `capability_grants` that called it would recurse. This one reads
 * `memberships`, `roles` and `role_capabilities` and nothing else; none of those
 * tables' policies reads `capability_grants`, so there is no cycle.
 *
 * The trade is deliberate and one-directional: an administrator who holds
 * `organization.role.administer` only through a GRANT rather than through their
 * role cannot read the organization's grants. That is a narrower answer than L4
 * would give, and narrower is the safe direction for a read policy. The
 * application-layer evaluator still applies the full L4 to the action itself.
 */
CREATE FUNCTION app_acting_membership_role_holds(p_capability text) RETURNS boolean
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    acting_id   uuid := nullif(current_setting('app.membership_id', true), '')::uuid;
    acting      memberships%ROWTYPE;
    acting_role text;
BEGIN
    IF acting_id IS NULL THEN
        RETURN false;
    END IF;

    SELECT * INTO acting FROM memberships m WHERE m.id = acting_id;
    IF NOT FOUND OR acting.status <> 'active' THEN
        RETURN false;
    END IF;
    IF now() < acting.valid_from THEN
        RETURN false;
    END IF;
    IF acting.valid_to IS NOT NULL AND now() >= acting.valid_to THEN
        RETURN false;
    END IF;

    acting_role := CASE
        WHEN acting.kind = 'organization' THEN acting.organization_role
        ELSE acting.group_role
    END;
    IF acting_role IS NULL THEN
        RETURN false;
    END IF;

    RETURN EXISTS (
        SELECT 1
          FROM roles r
          JOIN role_capabilities rc
            ON rc.role_id = r.id
           AND rc.organization_id = r.organization_id
         WHERE r.organization_id = acting.organization_id
           AND r.scope = acting.kind
           AND r.key = acting_role
           AND r.status = 'active'
           AND rc.capability_key = p_capability
    );
END;
$$;

------------------------------------------------------------------------------
-- S-22 — INFINITE window bounds are rejected. All of them.
--
-- `timestamptz` accepts `infinity` and `-infinity`, and **every window CHECK
-- written so far is satisfied by them**: `valid_to > valid_from` is true when
-- `valid_to` is `infinity`. A second reviewer wrote infinite bounds successfully
-- to `memberships.valid_to`, `capability_grants.valid_to` AND
-- `entitlements.effective_to`.
--
-- Two consequences, and the second is the one that matters:
--
--   1. node-postgres returns those as the JavaScript **numbers** `Infinity` /
--      `-Infinity`, not `Date`s, so `.toISOString()` throws a `TypeError`. The
--      application guards it (`instantOf`), and the guarded value becomes an
--      unparsable sentinel the evaluator fails closed on.
--   2. `instantOf`'s docblock **claimed this migration already forbade infinite
--      bounds at the CHECK level, and it did not.** That is the third time in
--      this task's history that a comment described a control that was not
--      there. The instruction was to fix the CONTROL, not the comment.
--
-- `ALTER TABLE ... ADD CONSTRAINT` is additive — it creates no table and edits
-- no applied migration file — so it is permitted on 0001's `memberships` as well
-- as on this migration's own tables. The tables are empty at this point in the
-- migration order, so validation of existing rows is trivially satisfied.
------------------------------------------------------------------------------

ALTER TABLE memberships
    ADD CONSTRAINT memberships_finite_window CHECK (
        valid_from > '-infinity'::timestamptz AND valid_from < 'infinity'::timestamptz
    AND (valid_to IS NULL
         OR (valid_to > '-infinity'::timestamptz AND valid_to < 'infinity'::timestamptz))
    );

ALTER TABLE capability_grants
    ADD CONSTRAINT capability_grants_finite_window CHECK (
        valid_from > '-infinity'::timestamptz AND valid_from < 'infinity'::timestamptz
    AND (valid_to IS NULL
         OR (valid_to > '-infinity'::timestamptz AND valid_to < 'infinity'::timestamptz))
    );

ALTER TABLE entitlements
    ADD CONSTRAINT entitlements_finite_window CHECK (
        effective_from > '-infinity'::timestamptz AND effective_from < 'infinity'::timestamptz
    AND (effective_to IS NULL
         OR (effective_to > '-infinity'::timestamptz AND effective_to < 'infinity'::timestamptz))
    );

------------------------------------------------------------------------------
-- Row level security.
------------------------------------------------------------------------------

ALTER TABLE roles                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles                     FORCE  ROW LEVEL SECURITY;
ALTER TABLE role_capabilities         ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_capabilities         FORCE  ROW LEVEL SECURITY;
ALTER TABLE capability_grants         ENABLE ROW LEVEL SECURITY;
ALTER TABLE capability_grants         FORCE  ROW LEVEL SECURITY;
ALTER TABLE entitlements              ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlements              FORCE  ROW LEVEL SECURITY;
ALTER TABLE group_module_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_module_availability FORCE  ROW LEVEL SECURITY;

-- ── roles and role_capabilities ──────────────────────────────────────────────
--
-- READ under any context in the organization; WRITE only under an
-- ORGANIZATION-scoped context.
--
-- The read has to be organization-wide, and it is not a V-09 exception being
-- quietly widened: SPEC-06 L4.2 resolves the GROUP role's capability set during
-- a GROUP-scoped request, and `roles` carries no `group_id` to bind against.
-- There is no group dimension here to leak — a role is an organization-level
-- definition, the same row for every group — so an organization predicate is the
-- narrowest predicate that exists. What a group-scoped context can see is the
-- vocabulary, never who holds it: WHO holds a role is on `memberships`, which
-- keeps its group predicate.
--
-- The WRITE side is EX-2's "Role and capability administration", which SPEC-06
-- §1.1 enumerates as organization-scoped, so the write predicate additionally
-- requires `app.group_id` to be unset.

CREATE POLICY roles_organization_read ON roles
    FOR SELECT
    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

CREATE POLICY roles_organization_write ON roles
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NULL)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NULL);

CREATE POLICY role_capabilities_organization_read ON role_capabilities
    FOR SELECT
    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

CREATE POLICY role_capabilities_organization_write ON role_capabilities
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NULL)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NULL);

-- ── capability_grants ────────────────────────────────────────────────────────
--
-- TWO policies, and the asymmetry between them is deliberate:
--
--   group-scoped context        ALL  only the declared group's grants — V-09's
--                                    conjunctive group predicate, in full
--   organization-scoped context ALL  every grant in the organization, group ones
--                                    included — EX-2's "Role and capability
--                                    administration"
--
-- The organization policy has to reach group-scoped rows, because SPEC-06 §1.1
-- puts "Manage `role_capabilities`, define organization roles" — and by extension
-- writing a membership's grants — in the ORGANIZATION-scoped action set. A
-- policy that admitted only `group_id IS NULL` under an organization context
-- would make it impossible for an organization administrator to grant a group
-- member anything, which is the same shape of contradiction FAD-11 resolved for
-- `groups` and `memberships`.
--
-- What it is NOT is a widening of the group predicate: reaching the
-- organization branch requires `app.group_id` to be unset, which SPEC-01 §2.3
-- step 2's organization branch only permits for a principal holding an
-- organization membership WITH an organization role. And the capability gate on
-- top of it is `capability_grants_guard_administration`.

-- ── S-05: WHO may read a grant, not just which tenant's ─────────────────────
--
-- The first version of these two policies scoped by TENANT only, so **any**
-- member holding **any** organization role — `org_observer` included, which
-- holds no capability at all — could read every capability grant in the
-- organization: who holds `identity.impersonate`, who was explicitly denied
-- `audit.export`, who can publish. An independent review pointed out that this
-- is a strictly larger disclosure than the read-breadth already recorded for
-- `roles` and `entitlements`, because those expose a VOCABULARY and this exposes
-- WHO HOLDS WHAT.
--
-- Narrowed to two readers, and the narrowing is expressible without recursion
-- because `app_acting_membership_role_holds` reads no `capability_grants`:
--
--   * **your own grants**, always — the evaluator needs them on every request,
--     and a principal learning their own capability set discloses nothing;
--   * **every grant in the organization**, for a role-derived holder of
--     `organization.role.administer` under an organization-scoped context —
--     which is EX-2's gate, now actually applied rather than cited.

CREATE POLICY capability_grants_own ON capability_grants
    FOR SELECT
    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
       AND membership_id = nullif(current_setting('app.membership_id', true), '')::uuid);

CREATE POLICY capability_grants_group_scope ON capability_grants
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND membership_id = nullif(current_setting('app.membership_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND membership_id = nullif(current_setting('app.membership_id', true), '')::uuid);

CREATE POLICY capability_grants_organization_administration ON capability_grants
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NULL
            AND app_acting_membership_role_holds('organization.role.administer'))
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NULL
            AND app_acting_membership_role_holds('organization.role.administer'));

-- ── entitlements ─────────────────────────────────────────────────────────────
--
-- Read under any context in the organization — L1 runs for group-scoped actions
-- too, and an entitlement has no group dimension. Write only under an
-- organization-scoped context: EX-3, "`SELECT`, and `INSERT`/`UPDATE` on
-- entitlement rows only".

CREATE POLICY entitlements_organization_read ON entitlements
    FOR SELECT
    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

CREATE POLICY entitlements_organization_write ON entitlements
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NULL)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NULL);

-- ── group_module_availability ────────────────────────────────────────────────
--
-- Group-scoped data, so V-09's conjunctive group predicate applies in full for a
-- group context. The organization-scoped policy is EX-2's "set group module
-- availability", which SPEC-06 §1.1 enumerates as an organization-scoped action.

CREATE POLICY group_module_availability_group_scope ON group_module_availability
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE POLICY group_module_availability_organization_scope ON group_module_availability
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NULL)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NULL);

-- ── memberships: the organization-administration write path ──────────────────
--
-- SPEC-06 §1.1 enumerates "invite a user to the organization, end a membership,
-- **assign a group role**" as ORGANIZATION-scoped. 0001's
-- `memberships_organization_scope` admits only `group_id IS NULL` rows under an
-- organization context, so a group membership could previously be created only
-- from a group-scoped context — the opposite of what SPEC-06 says.
--
-- This ADDITIVE permissive policy closes that: under an organization-scoped
-- context, membership rows may be written anywhere in the organization. It is
-- strictly organization-bounded (SPEC-01 §4.3 EX-2 as amended 2026-08-02: "every
-- DML predicate remains bounded by the organization context"), and the
-- capability gate for it is the trigger below, not the policy — because a policy
-- on `memberships` that reads `memberships` is infinite recursion, which is
-- exactly what FAD-11 ruling 3 records.

CREATE POLICY memberships_organization_administration ON memberships
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NULL)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NULL);

------------------------------------------------------------------------------
-- The non-recursive capability probe.
--
-- ⚠ **THIS FUNCTION MUST NEVER APPEAR IN AN RLS POLICY.** It reads `memberships`
-- and `capability_grants`; a policy ON either of those that called it would
-- re-enter that table's policy evaluation and PostgreSQL would raise infinite
-- recursion — the exact failure FAD-11 ruling 3 records. Called from a TRIGGER
-- there is no recursion at all: a trigger body is ordinary SQL, RLS applies to
-- its reads in the normal way, and a SELECT does not fire INSERT triggers.
-- `apps/api/test/authz/schema.test.ts` reads `pg_policies` and asserts no policy
-- mentions it, so the rule is enforced rather than remembered.
--
-- ## What it is, and what it is NOT
--
-- It is SPEC-06 **L4 only**, plus the L3.2/L3.3 activity checks needed to make
-- L4 meaningful. It is deliberately NOT the truth table: it does not read
-- entitlements, module availability, object policies, proxies or impersonation.
--
-- **The application-layer evaluator is the control; this is defence in depth.**
-- Every layer this omits can only DENY, so a statement this function admits may
-- still be denied above it, and a statement it refuses is refused whatever the
-- application thinks. It is one-directional, which is the only kind of
-- duplication that is safe.
--
-- Not SECURITY DEFINER: it runs as the caller, under the caller's RLS, so it can
-- only ever see the caller's own tenant. A definer-rights version would have to
-- be reasoned about; this one cannot reach anything the caller cannot.
------------------------------------------------------------------------------

CREATE FUNCTION app_membership_holds(p_membership uuid, p_capability text) RETURNS boolean
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    acting_id   uuid := p_membership;
    acting      memberships%ROWTYPE;
    acting_role text;
BEGIN
    -- No acting membership: no capability. This is the case the provisioning
    -- path and every out-of-band probe hit, and it is why EV-M1-TENANCY
    -- residuals 1 and 2 close — both attack a membership INSERT from a unit of
    -- work that declares no acting membership.
    IF acting_id IS NULL THEN
        RETURN false;
    END IF;

    SELECT * INTO acting FROM memberships m WHERE m.id = acting_id;
    IF NOT FOUND THEN
        RETURN false;
    END IF;

    -- SPEC-06 L3.2 / L3.3, so a suspended or expired membership's role and
    -- grants stop working at the database as well as in the evaluator.
    IF acting.status <> 'active' THEN
        RETURN false;
    END IF;
    IF now() < acting.valid_from THEN
        RETURN false;
    END IF;
    IF acting.valid_to IS NOT NULL AND now() >= acting.valid_to THEN
        RETURN false;
    END IF;

    -- L4.1 — an in-window EXPLICIT DENY beats every allow (P-1), and is
    -- evaluated first for that reason.
    IF EXISTS (
        SELECT 1
          FROM capability_grants g
         WHERE g.membership_id = acting_id
           AND g.capability_key = p_capability
           AND g.granted = false
           AND now() >= g.valid_from
           AND (g.valid_to IS NULL OR now() < g.valid_to)
    ) THEN
        RETURN false;
    END IF;

    -- L4.2 (a) — an in-window explicit allow.
    IF EXISTS (
        SELECT 1
          FROM capability_grants g
         WHERE g.membership_id = acting_id
           AND g.capability_key = p_capability
           AND g.granted = true
           AND now() >= g.valid_from
           AND (g.valid_to IS NULL OR now() < g.valid_to)
    ) THEN
        RETURN true;
    END IF;

    -- L4.2 (b) — the role. `r.scope = acting.kind` is P-8/P-9 for the ROLE key:
    -- an organization membership can only match an organization-scoped role and
    -- a group membership only a group-scoped one.
    --
    -- **It is NOT P-10 for the CAPABILITY key, and the first version of this
    -- comment claimed it was.** `role_capabilities.capability_key` is plain
    -- `text` with no scope column and no foreign key, because the capability
    -- vocabulary is a code constant (see the header). Nothing in the database
    -- stops `organization.membership.administer` being written into a
    -- group-scoped role, after which every holder of that group role would
    -- satisfy it from a group-scoped context.
    --
    -- What stands between the database and that crossing is: (a) NO route
    -- writes `role_capabilities` — `provisionAuthorization` is the only writer
    -- in the codebase, and it validates every pair against the catalogue's scope
    -- before inserting (`provisioning.ts`, "P-10 at the point of writing"); and
    -- (b) `apps/api/test/authz/schema.test.ts` re-checks every seeded pair
    -- against the catalogue. Recorded in EV-M1-AUTHZ §5 as a limitation rather
    -- than described here as a control it is not.
    acting_role := CASE
        WHEN acting.kind = 'organization' THEN acting.organization_role
        ELSE acting.group_role
    END;
    IF acting_role IS NULL THEN
        RETURN false;
    END IF;

    RETURN EXISTS (
        SELECT 1
          FROM roles r
          JOIN role_capabilities rc
            ON rc.role_id = r.id
           AND rc.organization_id = r.organization_id
         WHERE r.organization_id = acting.organization_id
           AND r.scope = acting.kind
           AND r.key = acting_role
           AND r.status = 'active'
           AND rc.capability_key = p_capability
    );
END;
$$;

/**
 * The same question for the membership currently in context.
 *
 * A thin wrapper rather than a second implementation: the last-administrator
 * check below has to ask about a membership that is NOT the actor, and two
 * copies of L4 would be two chances to drift.
 */
CREATE FUNCTION app_acting_membership_holds(p_capability text) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
    SELECT app_membership_holds(
        nullif(current_setting('app.membership_id', true), '')::uuid,
        p_capability
    );
$$;

------------------------------------------------------------------------------
-- The provisioning door, stated once and used by every guard.
--
-- An organization with **no memberships at all** has nobody who could authorize
-- anything, so the first statements that bring it into existence cannot be
-- capability-gated without making organization creation impossible. That is the
-- bootstrap problem, and pretending it does not exist is how a permanent
-- `app.membership_id IS NULL` escape hatch ends up in the guard instead.
--
-- The door is as narrow as it can be made:
--
--   * it closes the instant the first membership row exists, and it can never
--     reopen — `memberships` has no DELETE grant for any runtime role (0001),
--     so the count is monotonic;
--   * it opens ONLY under an ORGANIZATION-scoped context. Under a group-scoped
--     context `memberships_group_scope` narrows the count to the declared group,
--     so "no memberships" would mean "no memberships in THIS GROUP" — and an
--     empty group would reopen a door that must stay shut. Provisioning is an
--     organization-scoped action in SPEC-06 §1.1 anyway, so the restriction
--     costs nothing and removes the whole class of mistake;
--   * EV-M1-TENANCY residual 7 (a caller can INSERT an `organizations` row for a
--     UUID it invented) is unchanged by this and remains open — what it can
--     provision is a fresh, empty organization of its own, which is what that
--     residual already says.
------------------------------------------------------------------------------

CREATE FUNCTION app_organization_is_unprovisioned(p_organization_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
    RETURN NOT EXISTS (
        SELECT 1 FROM memberships m WHERE m.organization_id = p_organization_id
    );
END;
$$;

/*
 * The guard body, shared by five triggers.
 *
 * Raises `insufficient_privilege` (42501) — the same SQLSTATE PostgreSQL uses
 * for a privilege failure, so an application that already maps 42501 to a
 * generic error at the edge (`apps/api/src/db/pg-errors.ts`) needs no new case.
 *
 * The message names the capability and nothing else: no user id, no row
 * contents, no tenant identifier beyond the organization already in context
 * (I-07, I-17 — never log payload bodies).
 */
CREATE FUNCTION app_require_capability(p_capability text, p_organization_id uuid) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    -- The bootstrap branch is considered ONLY for the organization currently in
    -- context, and that guard is load-bearing rather than tidy.
    --
    -- `app_organization_is_unprovisioned` runs under the caller's RLS, so for
    -- ANY other organization its subquery matches zero rows and it answers
    -- `true` whether or not that organization has memberships. Without the
    -- comparison below, a row carrying a foreign `organization_id` would skip
    -- the capability check entirely. Every policy in 0001 and 0002 pins
    -- `organization_id = app.organization_id` in `WITH CHECK`, so RLS refuses
    -- such a row a moment later — but a gate whose correctness depends on a
    -- DIFFERENT control is not a gate, and the next table whose `WITH CHECK` is
    -- written differently would reopen the door silently.
    IF nullif(current_setting('app.group_id', true), '') IS NULL
       AND p_organization_id
           IS NOT DISTINCT FROM nullif(current_setting('app.organization_id', true), '')::uuid
       AND app_organization_is_unprovisioned(p_organization_id)
    THEN
        RETURN;
    END IF;
    IF NOT app_acting_membership_holds(p_capability) THEN
        RAISE EXCEPTION
            'the acting membership does not hold % (SPEC-06 L4)', p_capability
            USING ERRCODE = 'insufficient_privilege';
    END IF;
END;
$$;

------------------------------------------------------------------------------
-- memberships — the capability gate that closes EV-M1-TENANCY residuals 1 and 2.
--
-- ## Residual 1: cross-organization user attach
--
-- `memberships_organization_scope`'s WITH CHECK constrains `organization_id` and
-- `group_id`; it never inspects `user_id`, and it cannot, because `users` carries
-- no tenant column by PO-DEC-06's design. An actor reaching a membership INSERT
-- could attach ANY user to its organization, read them, and — because the INSERT
-- fires 0001's counter trigger as owner — irreversibly raise that FOREIGN user's
-- `membership_set_version`, forcing them into `409 CONTEXT_STALE` from outside
-- their own organization, permanently.
--
-- The control EV-M1-TENANCY §5.2 names is "OPUS-M1-002 (SPEC-06 L4.2 on user
-- administration)". This is it: membership creation now requires
-- `organization.membership.administer`, and an actor with no acting membership —
-- which is exactly the probe that demonstrated the residual — holds nothing.
--
-- ## Residual 2: the 23503 global user-id existence oracle
--
-- `memberships.user_id REFERENCES users (id)` is checked outside RLS, so an
-- INSERT naming a non-existent user raised 23503 while one naming an
-- existing-but-invisible user succeeded. **A BEFORE ROW trigger runs before the
-- row is inserted, therefore before the FK constraint is checked** — measured on
-- this cluster before the migration was written, not assumed. An unauthorized
-- actor now receives 42501 for both, so the two are indistinguishable, which is
-- SPEC-01 §2.4's requirement.
--
-- ## Why a trigger and not a policy
--
-- A policy on `memberships` whose predicate reads `memberships` is infinite
-- recursion in PostgreSQL (FAD-11 escalation 3). A trigger on `memberships` that
-- reads `memberships` is not: the read is an ordinary SELECT subject to ordinary
-- RLS, and a SELECT fires no INSERT trigger. FAD-11 ruling 3 permits exactly
-- this — "application-layer inside the unit of work is fine; SQL where
-- non-recursive" — and this is the SQL half.
--
-- ## What it does NOT gate, recorded rather than hidden
--
-- `last_active_at` and other non-privilege-bearing UPDATEs are untouched: the
-- UPDATE trigger's WHEN clause lists exactly the privilege-bearing columns, the
-- same list 0001's counter-bump trigger uses. A routine self-touch must not
-- require an administrative capability.
------------------------------------------------------------------------------

CREATE FUNCTION app_guard_membership_administration() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    acting_id uuid := nullif(current_setting('app.membership_id', true), '')::uuid;
    still_holds boolean;
BEGIN
    PERFORM app_require_capability('organization.membership.administer', NEW.organization_id);

    /* ── the SOLE-ADMINISTRATOR lockout ───────────────────────────────────────
     *
     * **A sole `org_admin` could end their own membership in one authorized
     * request, and nothing could undo it.** The guard fires for the schema owner
     * and for a superuser (a trigger is not RLS), `memberships` has no DELETE
     * grant, `app_acting_membership_holds` requires an ACTIVE membership, and
     * `app_breakglass` holds SELECT only. The organization would be permanently
     * unadministrable with no recovery path short of a migration.
     *
     * Found by an independent review. The same class was already closed for
     * `roles` (a system role may not be deprecated) and recorded as unclosable
     * for `entitlements`; this variant was neither.
     *
     * The check is expressible without recursion for the same reason the rest of
     * this file is: a TRIGGER on `memberships` may query `memberships`. Only a
     * POLICY may not.
     * ──────────────────────────────────────────────────────────────────────── */
    IF TG_OP = 'UPDATE' AND app_membership_holds(OLD.id, 'organization.membership.administer') THEN
        -- Does the row still hold it after this change? Evaluated against NEW's
        -- fields rather than by re-reading, because NEW is not committed yet.
        still_holds := NEW.status = 'active'
                   AND (NEW.valid_to IS NULL OR NEW.valid_to > now())
                   AND NEW.valid_from <= now()
                   AND NEW.kind IS NOT DISTINCT FROM OLD.kind
                   AND NEW.organization_role IS NOT DISTINCT FROM OLD.organization_role
                   AND NEW.group_role IS NOT DISTINCT FROM OLD.group_role;

        IF NOT still_holds THEN
            -- SELF-demotion is refused outright, whatever the count says. An
            -- administrator removing their own authority is the one case where
            -- "ask another administrator" costs nothing and a mistake costs the
            -- organization — and it is the same two-person rule capability
            -- grants already follow.
            IF acting_id IS NOT NULL AND acting_id = OLD.id THEN
                RAISE EXCEPTION
                    'an administrator may not remove their own administration capability — '
                    'another administrator must do it'
                    USING ERRCODE = 'insufficient_privilege';
            END IF;

            IF NOT EXISTS (
                SELECT 1
                  FROM memberships m
                 WHERE m.organization_id = NEW.organization_id
                   AND m.id <> NEW.id
                   AND m.status = 'active'
                   AND m.valid_from <= now()
                   AND (m.valid_to IS NULL OR m.valid_to > now())
                   AND app_membership_holds(m.id, 'organization.membership.administer')
            ) THEN
                RAISE EXCEPTION
                    'this change would leave the organization with no active membership holding '
                    'organization.membership.administer'
                    USING ERRCODE = 'insufficient_privilege';
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER memberships_guard_administration_on_insert
    BEFORE INSERT ON memberships
    FOR EACH ROW EXECUTE FUNCTION app_guard_membership_administration();

-- EV-M1-TENANCY residual 4: **self role escalation.** An actor with UPDATE on
-- `memberships` in its own group could raise its own role. The WHEN clause is
-- 0001's privilege-bearing column list verbatim, so the two triggers agree on
-- what "a privilege change" means — a column that bumps the freshness counter
-- and a column that requires the capability are the same set, by construction.
CREATE TRIGGER memberships_guard_administration_on_privilege_change
    BEFORE UPDATE ON memberships
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status
       OR OLD.kind IS DISTINCT FROM NEW.kind
       OR OLD.group_id IS DISTINCT FROM NEW.group_id
       OR OLD.group_role IS DISTINCT FROM NEW.group_role
       OR OLD.organization_role IS DISTINCT FROM NEW.organization_role
       OR OLD.valid_from IS DISTINCT FROM NEW.valid_from
       OR OLD.valid_to IS DISTINCT FROM NEW.valid_to
       -- `staffing_kind` is NOT in 0001's counter-bump list, and is here anyway.
       -- `memberships_organization_administration` (above) lifts 0001's
       -- `group_id IS NULL` restriction for organization-scoped DML, which put
       -- every group membership's `staffing_kind` in reach of any organization
       -- role — `org_observer` included, which holds no capability at all. Staff
       -- versus locum changes vacation entitlement and fairness-credit treatment
       -- (doc 08 §3), so it is an administrative change and is gated as one.
       -- Found by an independent review of exactly that widening.
       OR OLD.staffing_kind IS DISTINCT FROM NEW.staffing_kind)
    EXECUTE FUNCTION app_guard_membership_administration();

------------------------------------------------------------------------------
-- The remaining administration gates.
--
-- Each names the capability SPEC-06 §1.1 assigns to its action class.
-- `capability_grants` additionally refuses a SELF-grant outright: a membership
-- may never write a grant for itself, whatever it holds. That is not in SPEC-06
-- — it is the database half of residual 4, and it is unconditional because there
-- is no legitimate reason for it and a capability that can grant itself more
-- capability is a privilege-escalation primitive.
------------------------------------------------------------------------------

CREATE FUNCTION app_guard_role_administration() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM app_require_capability('organization.role.administer', NEW.organization_id);
    RETURN NEW;
END;
$$;

/*
 * `roles` gets its own guard rather than sharing the one above, for two reasons
 * that are both about plpgsql rather than about policy:
 *
 *   * a shared function referencing `OLD.is_system_role` fails at plan time on
 *     `role_capabilities`, which has no such column — `record "old" has no field`,
 *     measured;
 *   * `OLD` is not a record on INSERT, so the TG_OP test has to be an outer `IF`
 *     rather than a conjunct.
 */
CREATE FUNCTION app_guard_roles_administration() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    -- A SYSTEM role may not be deprecated, and this is a lockout control rather
    -- than a policy preference.
    --
    -- `app_acting_membership_holds` requires `roles.status = 'active'`, and
    -- `app_runtime` holds `UPDATE (name, status, updated_at)` on `roles`. So a
    -- single statement — deprecate the only role carrying
    -- `organization.role.administer` — destroys the capability needed to undo
    -- it. There is no DELETE grant, no way back to `active`, and no
    -- platform-administration surface (M-25) to recover through. Found by an
    -- independent review; the analogous `entitlements` lockout is recorded in
    -- EV-M1-AUTHZ §5 because it CANNOT be closed the same way (L1 applies to
    -- every action, by design). This one can, so it is.
    IF TG_OP = 'UPDATE' THEN
        IF OLD.is_system_role
           AND NEW.status IS DISTINCT FROM OLD.status
           AND NEW.status <> 'active'
        THEN
            RAISE EXCEPTION
                'a system role may not be deprecated — doing so can destroy the capability '
                'required to restore it'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
    END IF;

    PERFORM app_require_capability('organization.role.administer', NEW.organization_id);
    RETURN NEW;
END;
$$;

CREATE TRIGGER roles_guard_administration
    BEFORE INSERT OR UPDATE ON roles
    FOR EACH ROW EXECUTE FUNCTION app_guard_roles_administration();

CREATE TRIGGER role_capabilities_guard_administration
    BEFORE INSERT OR UPDATE ON role_capabilities
    FOR EACH ROW EXECUTE FUNCTION app_guard_role_administration();

CREATE FUNCTION app_guard_capability_grant_administration() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    acting_id     uuid := nullif(current_setting('app.membership_id', true), '')::uuid;
    acting_user   uuid;
    target_user   uuid;
    target_group  uuid;
    target_found  boolean;
BEGIN
    -- ── the grant must belong to the same group as the membership it names ──
    --
    -- The composite FK is over `(membership_id, organization_id)`; it cannot see
    -- `group_id`. A mismatch is not a harmless data error: it files the grant
    -- where the group-scoped policy cannot see it while leaving it live for an
    -- organization-scoped evaluation.
    SELECT m.user_id, m.group_id, true
      INTO target_user, target_group, target_found
      FROM memberships m
     WHERE m.id = NEW.membership_id;

    IF NOT coalesce(target_found, false) THEN
        -- Not visible in this context. The FK would say so too, less quietly.
        RAISE EXCEPTION
            'the membership named by this grant is not visible in the current context'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF NEW.group_id IS DISTINCT FROM target_group THEN
        RAISE EXCEPTION
            'a capability grant must carry the same group as the membership it names'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- ── no self-grant, keyed on the PRINCIPAL and not on the membership row ──
    --
    -- **This was wrong in the first version of this migration and an independent
    -- review broke it in two requests.** The check compared `NEW.membership_id`
    -- to `app.membership_id`, and a USER holds MANY memberships: 0001's partial
    -- unique indexes explicitly permit one user to hold an organization
    -- membership and a group membership at once. So an `org_admin` — which holds
    -- both `organization.membership.administer` and `organization.role.administer`
    -- — could create a group membership for their OWN user and then grant that
    -- membership any grant-only capability: `schedule.publish`,
    -- `vacation.commit`, `picklist.administer`, `identity.impersonate`,
    -- `audit.export`. Every one of those is documented as never role-implied,
    -- and the two-hop path issued them to self while the old check passed.
    --
    -- Comparing the USER behind both memberships is what the rule always meant.
    -- It makes capability granting a two-person operation, which is the property
    -- "a capability that can grant itself more capability is a
    -- privilege-escalation primitive" was asking for.
    IF acting_id IS NOT NULL THEN
        SELECT m.user_id INTO acting_user FROM memberships m WHERE m.id = acting_id;
        IF acting_user IS NOT NULL AND acting_user = target_user THEN
            RAISE EXCEPTION
                'a principal may not write a capability grant for any of their own memberships'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
    END IF;

    PERFORM app_require_capability('organization.role.administer', NEW.organization_id);
    RETURN NEW;
END;
$$;

CREATE TRIGGER capability_grants_guard_administration
    BEFORE INSERT OR UPDATE ON capability_grants
    FOR EACH ROW EXECUTE FUNCTION app_guard_capability_grant_administration();

CREATE FUNCTION app_guard_entitlement_administration() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM app_require_capability('organization.entitlement.administer', NEW.organization_id);
    RETURN NEW;
END;
$$;

CREATE TRIGGER entitlements_guard_administration
    BEFORE INSERT OR UPDATE ON entitlements
    FOR EACH ROW EXECUTE FUNCTION app_guard_entitlement_administration();

CREATE FUNCTION app_guard_group_administration() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM app_require_capability('organization.group.administer', NEW.organization_id);
    RETURN NEW;
END;
$$;

CREATE TRIGGER group_module_availability_guard_administration
    BEFORE INSERT OR UPDATE ON group_module_availability
    FOR EACH ROW EXECUTE FUNCTION app_guard_group_administration();

------------------------------------------------------------------------------
-- Freshness counters — SPEC-06 §4.
--
--   > **Bump is transactional.** The counter increments **in the same
--   > transaction** as the change that caused it. A committed privilege change
--   > with an unbumped counter is impossible.
--
-- | Counter | Bumped by | Landed here |
-- |---|---|---|
-- | `organization_version` | "Org status, **entitlement**, or module-dependency change" | entitlements |
-- | `group_version` | "Group status or **module-availability** change" | group_module_availability |
-- | `membership_set_version` | "Membership add/remove/status, role change, **grant change**" | capability_grants, role_capabilities |
--
-- 0001 landed the first clause of each row; these are the rest, and 0001's
-- `greatest(OLD + delta, NEW)` maintenance triggers were written to permit
-- exactly this explicit increment.
--
-- SECURITY DEFINER, for the same narrow reason 0001's membership bump is: the
-- application role holds no UPDATE privilege on any counter column. It gains
-- privilege and NO tenant reach — `organizations`, `groups` and `users` are all
-- FORCE RLS, so the owner is bound by the same policies and can only touch rows
-- visible in the caller's context. `search_path = public, pg_temp` with `pg_temp`
-- LAST, because a caller holding TEMP could otherwise shadow the real table.
------------------------------------------------------------------------------

CREATE FUNCTION app_bump_organization_version_for_entitlement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    affected integer;
BEGIN
    UPDATE organizations
       SET organization_version = organization_version + 1,
           updated_at = now()
     WHERE id = NEW.organization_id;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION
            'entitlement change for organization % did not advance organization_version — '
            'the change was made outside a unit of work with transaction-local tenant '
            'context (I-15)', NEW.organization_id
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER entitlements_bump_organization_version
    AFTER INSERT OR UPDATE ON entitlements
    FOR EACH ROW EXECUTE FUNCTION app_bump_organization_version_for_entitlement();

CREATE FUNCTION app_bump_group_version_for_availability() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    affected integer;
BEGIN
    UPDATE groups
       SET group_version = group_version + 1,
           updated_at = now()
     WHERE id = NEW.group_id;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION
            'module-availability change for group % did not advance group_version — '
            'the change was made outside a unit of work with transaction-local tenant '
            'context (I-15)', NEW.group_id
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER group_module_availability_bump_group_version
    AFTER INSERT OR UPDATE ON group_module_availability
    FOR EACH ROW EXECUTE FUNCTION app_bump_group_version_for_availability();

-- A grant change is a privilege change for exactly one person.
CREATE FUNCTION app_bump_membership_set_version_for_grant() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    affected integer;
BEGIN
    UPDATE users
       SET membership_set_version = membership_set_version + 1,
           updated_at = now()
      FROM memberships m
     WHERE m.id = NEW.membership_id
       AND users.id = m.user_id;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION
            'grant change on membership % did not advance membership_set_version — '
            'the change was made outside a unit of work with transaction-local tenant '
            'context (I-15)', NEW.membership_id
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER capability_grants_bump_membership_set_version
    AFTER INSERT OR UPDATE ON capability_grants
    FOR EACH ROW EXECUTE FUNCTION app_bump_membership_set_version_for_grant();

-- A `role_capabilities` change is a privilege change for EVERY holder of that
-- role. The fan-out is the honest reading of SPEC-06 §4 — "membership add/remove/
-- status, ROLE CHANGE, grant change" — and the alternative, bumping nobody,
-- would leave every holder's cached decision valid after their capability set
-- moved.
--
-- Cost is proportional to the number of memberships holding the role, in the
-- same transaction as the administrative change. At organization scale that is
-- small; if a future organization makes it large, the fix is to batch the
-- administrative change, not to skip the bump. Recorded in EV-M1-AUTHZ §5.
CREATE FUNCTION app_bump_membership_set_version_for_role_capability() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    target_role roles%ROWTYPE;
BEGIN
    SELECT * INTO target_role FROM roles r WHERE r.id = NEW.role_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    UPDATE users
       SET membership_set_version = membership_set_version + 1,
           updated_at = now()
      FROM memberships m
     WHERE m.organization_id = target_role.organization_id
       AND m.kind = target_role.scope
       AND CASE WHEN target_role.scope = 'organization'
                THEN m.organization_role
                ELSE m.group_role
           END = target_role.key
       AND users.id = m.user_id;

    -- No assertion on the row count: a role with no holders yet is the ordinary
    -- provisioning case, and zero is the correct answer there. The unit-of-work
    -- enforcement this trigger's siblings provide is already provided for this
    -- table by `role_capabilities`' own RLS policy, which matches nothing without
    -- transaction-local context.
    RETURN NULL;
END;
$$;

CREATE TRIGGER role_capabilities_bump_membership_set_version
    AFTER INSERT OR UPDATE ON role_capabilities
    FOR EACH ROW EXECUTE FUNCTION app_bump_membership_set_version_for_role_capability();

------------------------------------------------------------------------------
-- Grants (SPEC-01 §4.4).
--
-- The same three withholdings as 0001, for the same reasons: no TRUNCATE, no
-- REFERENCES (neither is subject to RLS, S-03), and no DELETE on anything that
-- carries history.
--
-- **DELETE is granted on nothing here either**, `role_capabilities` included.
-- Taking a capability away from an individual is an effective-dated
-- `capability_grants` row with `granted = false`, which is auditable and
-- reversible; taking one away from a ROLE has no runtime path in this milestone
-- and is recorded as a gap in EV-M1-AUTHZ §5 rather than solved with a DELETE
-- grant that also permits silently erasing the reason a role ever had it.
------------------------------------------------------------------------------

GRANT SELECT, INSERT ON roles, role_capabilities, capability_grants,
                         entitlements, group_module_availability
    TO app_runtime, app_worker;

GRANT UPDATE (name, status, updated_at)
    ON roles TO app_runtime, app_worker;

GRANT UPDATE (granted, granted_by_membership_id, reason, valid_from, valid_to, updated_at)
    ON capability_grants TO app_runtime, app_worker;

GRANT UPDATE (state, effective_from, effective_to, updated_at)
    ON entitlements TO app_runtime, app_worker;

GRANT UPDATE (available, updated_at)
    ON group_module_availability TO app_runtime, app_worker;

GRANT SELECT
    ON roles, role_capabilities, capability_grants, entitlements, group_module_availability
    TO app_readonly_support, app_breakglass;

-- PostgreSQL grants EXECUTE to PUBLIC on every new function, so a GRANT without
-- a REVOKE reads as a restriction and is not one. The two directly-callable
-- probes are locked down; the trigger functions are unreachable except through
-- their triggers, and are revoked too rather than relying on that.
REVOKE ALL ON FUNCTION app_acting_membership_holds(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_membership_holds(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_acting_membership_role_holds(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_organization_is_unprovisioned(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_require_capability(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_guard_membership_administration() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_guard_role_administration() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_guard_roles_administration() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_guard_capability_grant_administration() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_guard_entitlement_administration() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_guard_group_administration() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_bump_organization_version_for_entitlement() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_bump_group_version_for_availability() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_bump_membership_set_version_for_grant() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_bump_membership_set_version_for_role_capability() FROM PUBLIC;

-- The three helpers are called from trigger bodies that run as the CALLER (none
-- of them is SECURITY DEFINER, deliberately — see `app_acting_membership_holds`),
-- so the runtime roles need EXECUTE on them or every guarded write fails 42501.
-- MEASURED: revoking without granting these back broke the whole fixture.
--
-- The trigger and bump functions get no grant: PostgreSQL does not check EXECUTE
-- when a trigger fires its own function, and none of them is callable directly
-- (they return `trigger`).
GRANT EXECUTE ON FUNCTION app_acting_membership_holds(text)
    TO app_runtime, app_worker;
GRANT EXECUTE ON FUNCTION app_membership_holds(uuid, text)
    TO app_runtime, app_worker;
GRANT EXECUTE ON FUNCTION app_acting_membership_role_holds(text)
    TO app_runtime, app_worker;
GRANT EXECUTE ON FUNCTION app_organization_is_unprovisioned(uuid)
    TO app_runtime, app_worker;
GRANT EXECUTE ON FUNCTION app_require_capability(text, uuid)
    TO app_runtime, app_worker;

-- Down Migration

DROP TRIGGER IF EXISTS role_capabilities_bump_membership_set_version    ON role_capabilities;
DROP TRIGGER IF EXISTS capability_grants_bump_membership_set_version    ON capability_grants;
DROP TRIGGER IF EXISTS group_module_availability_bump_group_version     ON group_module_availability;
DROP TRIGGER IF EXISTS entitlements_bump_organization_version           ON entitlements;
DROP TRIGGER IF EXISTS group_module_availability_guard_administration   ON group_module_availability;
DROP TRIGGER IF EXISTS entitlements_guard_administration                ON entitlements;
DROP TRIGGER IF EXISTS capability_grants_guard_administration           ON capability_grants;
DROP TRIGGER IF EXISTS role_capabilities_guard_administration           ON role_capabilities;
DROP TRIGGER IF EXISTS roles_guard_administration                       ON roles;
DROP TRIGGER IF EXISTS memberships_guard_administration_on_privilege_change ON memberships;
DROP TRIGGER IF EXISTS memberships_guard_administration_on_insert       ON memberships;

DROP FUNCTION IF EXISTS app_bump_membership_set_version_for_role_capability();
DROP FUNCTION IF EXISTS app_bump_membership_set_version_for_grant();
DROP FUNCTION IF EXISTS app_bump_group_version_for_availability();
DROP FUNCTION IF EXISTS app_bump_organization_version_for_entitlement();
DROP FUNCTION IF EXISTS app_guard_group_administration();
DROP FUNCTION IF EXISTS app_guard_entitlement_administration();
DROP FUNCTION IF EXISTS app_guard_capability_grant_administration();
DROP FUNCTION IF EXISTS app_guard_roles_administration();
DROP FUNCTION IF EXISTS app_guard_role_administration();
DROP FUNCTION IF EXISTS app_guard_membership_administration();
DROP FUNCTION IF EXISTS app_require_capability(text, uuid);
DROP FUNCTION IF EXISTS app_organization_is_unprovisioned(uuid);
DROP FUNCTION IF EXISTS app_acting_membership_holds(text);
DROP FUNCTION IF EXISTS app_membership_holds(uuid, text);

ALTER TABLE IF EXISTS entitlements       DROP CONSTRAINT IF EXISTS entitlements_finite_window;
ALTER TABLE IF EXISTS capability_grants DROP CONSTRAINT IF EXISTS capability_grants_finite_window;
-- On 0001's table, so it must be dropped here or `down` leaves it behind.
ALTER TABLE IF EXISTS memberships       DROP CONSTRAINT IF EXISTS memberships_finite_window;

DROP POLICY IF EXISTS memberships_organization_administration            ON memberships;
DROP POLICY IF EXISTS group_module_availability_organization_scope       ON group_module_availability;
DROP POLICY IF EXISTS group_module_availability_group_scope              ON group_module_availability;
DROP POLICY IF EXISTS entitlements_organization_write                    ON entitlements;
DROP POLICY IF EXISTS entitlements_organization_read                     ON entitlements;
DROP POLICY IF EXISTS capability_grants_organization_administration      ON capability_grants;
DROP POLICY IF EXISTS capability_grants_group_scope                      ON capability_grants;
DROP POLICY IF EXISTS capability_grants_own                             ON capability_grants;
DROP POLICY IF EXISTS role_capabilities_organization_write               ON role_capabilities;
DROP POLICY IF EXISTS role_capabilities_organization_read                ON role_capabilities;
DROP POLICY IF EXISTS roles_organization_write                           ON roles;
DROP POLICY IF EXISTS roles_organization_read                            ON roles;

-- AFTER the policies, not with the other functions: `capability_grants`'
-- organization-administration policy calls it, and PostgreSQL refuses to drop a
-- function a policy depends on.
DROP FUNCTION IF EXISTS app_acting_membership_role_holds(text);

DROP INDEX IF EXISTS group_module_availability_lookup;
DROP INDEX IF EXISTS entitlements_lookup;
DROP INDEX IF EXISTS capability_grants_lookup;
DROP INDEX IF EXISTS role_capabilities_lookup;
DROP INDEX IF EXISTS roles_organization_idx;

DROP TABLE IF EXISTS group_module_availability;
DROP TABLE IF EXISTS entitlements;
DROP TABLE IF EXISTS capability_grants;
DROP TABLE IF EXISTS role_capabilities;
DROP TABLE IF EXISTS roles;

DROP EXTENSION IF EXISTS btree_gist;
