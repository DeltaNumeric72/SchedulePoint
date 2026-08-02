-- OPUS-M1-001 — tenancy core: organizations, groups, users, memberships.
--
-- Normative sources:
--   SPEC-01 §4.3 (as amended 2026-08-01)  — RLS predicate spelling, group predicate,
--                                            FORCE RLS, composite tenant FKs,
--                                            tenant-qualified unique keys
--   SPEC-01 §4.4                          — the five-role matrix and its grants
--   SPEC-06 §4                            — the freshness counters this schema stores
--   docs/fable/09-domain-model.md §1      — entity shapes (Tenancy & identity)
--   docs/fable/21-decision-resolution.md  — PO-DEC-06 default: NO multi-organization
--                                            users for the first release; `users` is
--                                            global and per-organization membership
--                                            keeps the door open
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE PREDICATE SPELLING IS NORMATIVE AND IS WRITTEN OUT IN FULL, EVERY TIME.
--
--   nullif(current_setting('app.<x>', true), '')::uuid
--
-- `SET LOCAL` / `set_config(..., true)` reverts a GUC's VALUE at the end of the
-- transaction; it does not undefine the GUC. A pooled connection that has ever
-- carried context therefore reads back the EMPTY STRING, not NULL — and in
-- production, where every connection is reused, `''` is the steady state, not the
-- edge case (SPIKE-REPORT §6.1 / X-09). The naive `current_setting(...)::uuid`
-- raises 22P02 on every query on a reused connection instead of returning zero
-- rows. `nullif(..., '')` yields NULL in the never-set case AND the reverted case,
-- so the predicate is uniformly false and every tenant table is fail-closed.
--
-- It is spelled out inline rather than hidden behind a helper function so that a
-- reviewer reading this file sees the actual predicate on every table. A typo is
-- guarded against behaviourally: `apps/api/test/tenancy/roles-and-schema.test.ts`
-- (A-03b) reads `pg_policies` and asserts that **every individual**
-- `current_setting('app.*')` reference in every policy is nullif-guarded.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ROLES ARE NOT CREATED HERE. Roles are cluster objects and `app_migrator`
-- deliberately holds neither CREATEROLE nor CREATEDB nor superuser (SPEC-01 §4.4,
-- SPIKE-REPORT §3). They are created by the cluster bootstrap step —
-- `apps/api/src/db/bootstrap.sql`, run once by a superuser. This migration owns
-- the GRANTS, which are schema objects and are `app_migrator`'s to give.

-- Up Migration

------------------------------------------------------------------------------
-- organizations — the tenancy root.
--
-- Its RLS predicate is the IDENTITY predicate (`id = app.organization_id`)
-- rather than an `organization_id` column predicate, because the row IS the
-- tenant.
------------------------------------------------------------------------------

CREATE TABLE organizations (
    id                    uuid PRIMARY KEY,
    name                  text NOT NULL CHECK (length(btrim(name)) > 0),
    status                text NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'inactive')),
    -- SPEC-06 §4: bumped by organization status, entitlement, or module-dependency
    -- change, in the SAME transaction as the change that caused it.
    organization_version  bigint NOT NULL DEFAULT 1 CHECK (organization_version > 0),
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);

------------------------------------------------------------------------------
-- groups — organization-owned, and the unit the group predicate binds to.
------------------------------------------------------------------------------

CREATE TABLE groups (
    id               uuid PRIMARY KEY,
    organization_id  uuid NOT NULL REFERENCES organizations (id),
    name             text NOT NULL CHECK (length(btrim(name)) > 0),
    status           text NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'inactive')),
    -- SPEC-06 §4: bumped by group status or module-availability change.
    group_version    bigint NOT NULL DEFAULT 1 CHECK (group_version > 0),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    -- SPEC-01 §4 amendment (a): the tenant-qualified identity that COMPOSITE
    -- foreign keys from other tenant tables reference. FK checks bypass RLS
    -- (X-06), so a single-column FK would happily accept a cross-tenant parent.
    CONSTRAINT groups_tenant_identity UNIQUE (id, organization_id),

    -- SPEC-01 §4 amendment (b): tenant-QUALIFIED unique key. `UNIQUE (name)`
    -- would be a cross-tenant existence oracle — unique checks bypass RLS
    -- (X-11), so a 23505 would disclose a name held by an invisible organization.
    CONSTRAINT groups_name_unique_in_organization UNIQUE (organization_id, name)
);

CREATE INDEX groups_organization_idx ON groups (organization_id);

------------------------------------------------------------------------------
-- users — GLOBAL identity, per PO-DEC-06's recorded default.
--
-- PO-DEC-06 ("one user across multiple organizations") resolves to **no, for the
-- first release**, with `users` global and per-organization `memberships` keeping
-- the door open. A user row therefore carries NO tenant column.
--
-- Global does NOT mean unreachable. The RLS policy below makes a user row visible
-- only to a context in which that user holds a membership, so a **read-only**
-- actor — `app_runtime` outside a unit of work, or inside one for another
-- organization — reads zero rows.
--
-- IT IS NOT A CONTROL AGAINST A WRITER, AND THE ORIGINAL WORDING HERE CLAIMED
-- OTHERWISE. An actor who can INSERT a membership can attach any user to its own
-- organization and then read them. That is residual (1) below. Corrected after
-- the independent review disproved the claim with a one-statement probe.
--
-- ── THREE RESIDUALS, RECORDED RATHER THAN HIDDEN ─────────────────────────────
--
-- (1) CROSS-ORGANIZATION USER ATTACH. `memberships_organization_scope`'s
--     WITH CHECK constrains `organization_id` and `group_id`; it never inspects
--     `user_id`, and it cannot — `users` carries no tenant column by
--     PO-DEC-06's design, so there is no tenant to compare against. An actor
--     that reaches a membership INSERT can therefore name **any** user id,
--     including one whose only other membership is in another organization, and
--     that user's row becomes readable.
--
--     IT IS ALSO A CROSS-TENANT AVAILABILITY EFFECT, AND IRREVERSIBLY SO. The
--     INSERT fires `memberships_bump_membership_set_version_on_insert`, which
--     runs as the owner and increments the FOREIGN user's
--     `membership_set_version`. That counter is monotonic by construction — the
--     `users_maintain_counters` trigger refuses any decrease, for a superuser
--     too — so the bump cannot be undone even by deleting the membership again.
--     An Org-A actor holding an Org-B user's UUID can therefore repeat the
--     attach at will and force that user into `409 CONTEXT_STALE` on every
--     in-flight request, from outside their organization, permanently raising a
--     counter nobody can lower.
--
--     The control is the authorization layer (SPEC-06 L4.2 on the
--     user-administration capability), which lands in OPUS-M1-002. Until then it
--     is an application-layer gate only. Documented by
--     `apps/api/test/tenancy/roles-and-schema.test.ts`, describe block
--     "residuals this milestone leaves open".
--
-- (2) GLOBAL USER-ID EXISTENCE ORACLE at the membership-creation edge.
--     `memberships.user_id REFERENCES users (id)` is checked outside RLS, so a
--     membership INSERT naming a non-existent user raises 23503 while one naming
--     an existing-but-invisible user succeeds. The pair distinguishes "this user
--     id exists somewhere" from "it does not" — over a UUIDv4 space that is
--     expensive rather than impossible, but it is real. Same test, same block;
--     same owner (OPUS-M1-002's capability gate on the INSERT).
--
-- (3) `login_email` UNIQUENESS. Globally unique because it is the authentication
--     identity, which is exactly the existence oracle of SPIKE-REPORT §6.5 /
--     SPEC-01 §4 amendment (b), and it cannot be tenant-qualified without
--     breaking global login. The amendment's second mitigation is applied
--     instead: 23505 is translated to a generic error at the edge
--     (`apps/api/src/db/pg-errors.ts`), the constraint name never reaches a
--     client, and this milestone ships no route that inserts a user.
--
-- All three are recorded in `docs/evidence/EV-M1-TENANCY/INDEX.md` §5. None is
-- closed by recursive SQL tightening — a policy on `memberships` that queries
-- `memberships` is infinite recursion in PostgreSQL, and the orchestrator ruled
-- against attempting it.
------------------------------------------------------------------------------

CREATE TABLE users (
    id                      uuid PRIMARY KEY,
    -- Immutable id; `login_email` is admin-changeable (CAR-027, doc 09 §1).
    login_email             text NOT NULL CHECK (length(btrim(login_email)) > 0),
    display_name            text NOT NULL CHECK (length(btrim(display_name)) > 0),
    status                  text NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'deactivated')),
    -- SPEC-06 §4, per user: bumped by membership add/remove/status, role change,
    -- grant change, proxy change.
    membership_set_version  bigint NOT NULL DEFAULT 1 CHECK (membership_set_version > 0),
    -- SPEC-01 §2.1 / SPEC-06 §4: bumped on authentication, privilege change,
    -- impersonation start/end.
    session_epoch           bigint NOT NULL DEFAULT 1 CHECK (session_epoch > 0),
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT users_login_email_unique UNIQUE (login_email)
);

------------------------------------------------------------------------------
-- memberships — where the role lives (doc 09 §2 decision 1).
--
-- ONE table carries BOTH kinds SPEC-01 §2.3 distinguishes:
--
--   kind = 'group'         group_id NOT NULL, group_role NOT NULL
--                          Satisfies a GROUP-scoped action (§2.3 step 2, group branch)
--   kind = 'organization'  group_id NULL,     organization_role NOT NULL
--                          Satisfies an ORGANIZATION-scoped action (§2.3 step 2, org branch)
--
-- SPEC-06 P-8/P-9/P-10: the two are DISJOINT. A group role never satisfies an
-- organization-scoped action and an organization role never satisfies a
-- group-scoped one. The CHECK below makes the two shapes structurally exclusive
-- so the disjointness cannot be violated by a bad row, only by a bad evaluator.
------------------------------------------------------------------------------

CREATE TABLE memberships (
    id                 uuid PRIMARY KEY,
    organization_id    uuid NOT NULL REFERENCES organizations (id),
    -- NULL means an ORGANIZATION membership. Not a missing value.
    group_id           uuid,
    user_id            uuid NOT NULL REFERENCES users (id),

    kind               text NOT NULL CHECK (kind IN ('organization', 'group')),
    -- doc 09 §1: kinds staff/locum; suspension states.
    staffing_kind      text NOT NULL DEFAULT 'staff'
                           CHECK (staffing_kind IN ('staff', 'locum')),
    status             text NOT NULL DEFAULT 'active'
                           CHECK (status IN ('invited', 'active', 'suspended', 'ended')),

    organization_role  text CHECK (organization_role IS NULL
                                   OR length(btrim(organization_role)) > 0),
    group_role         text CHECK (group_role IS NULL
                                   OR length(btrim(group_role)) > 0),

    -- SPEC-06 L3.3: `now ∈ [valid_from, valid_to)`. NULL valid_to = open-ended.
    valid_from         timestamptz NOT NULL DEFAULT now(),
    valid_to           timestamptz,
    last_active_at     timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT memberships_kind_shape CHECK (
        (kind = 'organization'
             AND group_id IS NULL
             AND organization_role IS NOT NULL
             AND group_role IS NULL)
     OR (kind = 'group'
             AND group_id IS NOT NULL
             AND group_role IS NOT NULL
             AND organization_role IS NULL)
    ),
    CONSTRAINT memberships_window CHECK (valid_to IS NULL OR valid_to > valid_from),

    -- SPEC-01 §4 amendment (a): COMPOSITE tenant FK. `REFERENCES groups (id)`
    -- alone would accept a group belonging to a different organization, because
    -- the FK check runs outside RLS (X-06). Carrying organization_id in the
    -- reference makes a cross-tenant membership structurally impossible.
    -- MATCH SIMPLE (the default) means the check is skipped when group_id is
    -- NULL, which is exactly right for an organization membership.
    CONSTRAINT memberships_group_fk
        FOREIGN KEY (group_id, organization_id)
        REFERENCES groups (id, organization_id),

    -- The tenant-qualified identity other tenant tables reference compositely
    -- (capability grants, audit rows, assignments — M1-002 onward).
    CONSTRAINT memberships_tenant_identity UNIQUE (id, organization_id)
);

-- Tenant-qualified unique keys. Both lead with organization_id, so a 23505 can
-- only ever be raised against a row in the caller's own organization.
CREATE UNIQUE INDEX memberships_one_per_user_and_group
    ON memberships (organization_id, group_id, user_id)
    WHERE group_id IS NOT NULL;

CREATE UNIQUE INDEX memberships_one_org_membership_per_user
    ON memberships (organization_id, user_id)
    WHERE group_id IS NULL;

CREATE INDEX memberships_principal_lookup
    ON memberships (user_id, organization_id, group_id);

------------------------------------------------------------------------------
-- Row level security.
--
-- ENABLE makes the policies apply. FORCE makes them apply to the table OWNER as
-- well — `app_migrator` owns every table here, and without FORCE the owner
-- bypass would silently defeat the whole design if a process were ever
-- misconfigured to connect as the migrator (SPEC-01 §4.3).
------------------------------------------------------------------------------

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE  ROW LEVEL SECURITY;
ALTER TABLE groups        ENABLE ROW LEVEL SECURITY;
ALTER TABLE groups        FORCE  ROW LEVEL SECURITY;
ALTER TABLE users         ENABLE ROW LEVEL SECURITY;
ALTER TABLE users         FORCE  ROW LEVEL SECURITY;
ALTER TABLE memberships   ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships   FORCE  ROW LEVEL SECURITY;

-- organizations: the identity predicate. The row IS the tenant.
CREATE POLICY organizations_tenant ON organizations
    USING      (id = nullif(current_setting('app.organization_id', true), '')::uuid)
    WITH CHECK (id = nullif(current_setting('app.organization_id', true), '')::uuid);

-- ── groups ───────────────────────────────────────────────────────────────────
--
-- TWO policies, one per context scope, rather than one policy with a disjunction.
-- Splitting them is what makes the group-scoped rule readable as the strict rule
-- it is, and it lets the organization-scoped rule be reviewed on its own terms.
--
-- Multiple PERMISSIVE policies are OR-ed, and exactly one of the two can be true
-- at a time (`app.group_id` is either set or it is not), so the split changes
-- nothing about what is reachable.

-- Group-scoped context: ONLY the declared group's row (SPEC-01 §4.3, V-09).
-- An application bug that resolves the wrong group inside the right organization
-- — the CAR-001 defect class — is caught here, below the application layer.
CREATE POLICY groups_group_scope ON groups
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND id = nullif(current_setting('app.group_id', true), '')::uuid);
--
-- Organization-scoped context: every group in the organization.
--
-- This covers SPEC-01 §4.3 exception EX-2's read case AND the `Group
-- administration` action class SPEC-06 §1.1 enumerates as organization-scoped
-- (create, rename, deactivate a group).
--
-- DIVERGENCE FROM EX-2, DELIBERATE AND RECORDED: EX-2's `Grants` column says
-- `SELECT`. Taken literally, and combined with the group-scoped policy above,
-- that would make it impossible to create a group at all — under a group-scoped
-- context you can only touch a group that already exists, and under an
-- organization-scoped one you could only read. SPEC-06 §1.1 explicitly
-- enumerates group creation as a real organization-scoped action, so the two
-- documents cannot both be read literally. The reading adopted here is that
-- §4.3's exception list governs the **cross-group READ** problem it says it is
-- about ("A conjunctive group predicate would otherwise break legitimate
-- organization-wide reads"), and does not purport to enumerate the write
-- policies for organization administration — which is also how EX-3 reads, since
-- it separately grants INSERT/UPDATE on entitlement rows. Flagged in the return
-- report for a recorded decision.
--
-- The capability gate on this policy (EX-2's "organization membership with an
-- organization role") is enforced ABOVE the database, at SPEC-01 §2.3 step 2's
-- organization branch. See the note on `memberships_organization_read` below for
-- why it is not enforced in SQL yet.
CREATE POLICY groups_organization_scope ON groups
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NULL)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NULL);

-- ── memberships ──────────────────────────────────────────────────────────────
--
-- THREE policies, and the asymmetry between them is the whole design:
--
--   group-scoped context        ALL     only GROUP memberships of the declared group
--   organization-scoped context ALL     only ORGANIZATION memberships (group_id NULL)
--   organization-scoped context SELECT  every membership in the organization  [EX-2]
--
-- Note what is NOT reachable: under a GROUP-scoped context, another group's
-- memberships are invisible for reading and unwritable — T-13b. The organization
-- -wide read is available only under an organization-scoped context, which is
-- exactly EX-2's gate.
--
-- A single `group_id = app.group_id` conjunction would have made every
-- organization membership permanently invisible (`NULL = NULL` is not true),
-- which would make SPEC-01 §2.3's organization branch unimplementable. A single
-- organization-only predicate would expose every group's memberships under a
-- group context. Neither is fail-closed in both directions; three narrow
-- policies are.

CREATE POLICY memberships_group_scope ON memberships
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE POLICY memberships_organization_scope ON memberships
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NULL
            AND group_id IS NULL)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NULL
            AND group_id IS NULL);

-- EX-2, `organization administration`: SELECT on `memberships`, under an
-- organization-scoped context. This is also what makes SPEC-01 §3's target
-- resolution possible: "an identifier from Group A is *resolvable* but never
-- *usable* under Group B's context". Resolution reads the target's tenant
-- coordinates in a separate, read-only, ORGANIZATION-scoped unit of work — so
-- the organization boundary is never crossed (a foreign organization's id
-- resolves to nothing and is a plain 404, §2.4) while a sibling group's id
-- resolves and yields `409 CONTEXT_TARGET_MISMATCH` (§2.3 step 6).
--
-- The application performs that resolution **only for an actor who has already
-- passed the capability check in their declared tenant** (V-07), which is EX-2's
-- capability gate applied where it can currently be applied.
--
-- WHY THE GATE IS NOT IN SQL YET, RECORDED RATHER THAN HIDDEN: expressing
-- "the acting membership carries an organization role" inside a policy ON
-- `memberships` requires the policy to query `memberships`, which PostgreSQL
-- rejects as infinite recursion. The non-recursive relations that can carry the
-- test — `role_capabilities`, `capability_grants` — arrive with the SPEC-06
-- evaluator in OPUS-M1-002, and the gate belongs in that migration. Until then
-- the organization boundary is enforced in SQL and the capability gate is
-- enforced in the middleware.
CREATE POLICY memberships_organization_read ON memberships
    FOR SELECT
    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
       AND nullif(current_setting('app.group_id', true), '') IS NULL);

-- users: a global row, reachable only through a membership visible in the
-- current context. The subquery is itself subject to `memberships_tenant`, so
-- outside a unit of work it matches nothing and every user row is invisible —
-- the same fail-closed behaviour as a directly tenant-columned table, without
-- giving `users` a tenant column PO-DEC-06 says it must not have.
--
-- There is no recursion: `memberships_tenant` reads no table.
CREATE POLICY users_readable_through_membership ON users
    FOR SELECT
    USING (EXISTS (
        SELECT 1
          FROM memberships m
         WHERE m.user_id = users.id
           AND m.organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    ));

-- User provisioning is an organization-administration action, so it requires an
-- organization-scoped context. Outside a unit of work `app.organization_id` is
-- NULL or '' and the predicate is false, so the table is fail-closed for writes
-- exactly as it is for reads.
CREATE POLICY users_writable_under_organization_context ON users
    FOR INSERT
    WITH CHECK (nullif(current_setting('app.organization_id', true), '') IS NOT NULL
            AND nullif(current_setting('app.group_id', true), '') IS NULL);

CREATE POLICY users_updatable_through_membership ON users
    FOR UPDATE
    USING (EXISTS (
        SELECT 1
          FROM memberships m
         WHERE m.user_id = users.id
           AND m.organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    ))
    WITH CHECK (EXISTS (
        SELECT 1
          FROM memberships m
         WHERE m.user_id = users.id
           AND m.organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
    ));

------------------------------------------------------------------------------
-- Freshness counters are TRIGGER-MAINTAINED, never application-writable.
--
-- SPEC-06 §4 requires the counters to advance "in the SAME transaction as the
-- change that caused it", and the whole `409 CONTEXT_STALE` mechanism rests on
-- them being trustworthy. Two properties are therefore enforced below rather
-- than assumed:
--
--   MONOTONIC   a counter can never move backwards. A decrease raises
--               `restrict_violation` rather than being silently clamped —
--               clamping would hide the bug that caused it.
--   ADVANCED    a counter moves because the underlying change happened, not
--               because a caller asked for it.
--
-- The BEFORE triggers set the column on the NEW row. PostgreSQL checks
-- column-level UPDATE privilege against the columns named in the statement's SET
-- clause, not against columns a BEFORE trigger changes — so the triggers can
-- maintain columns the application role is not permitted to name at all.
------------------------------------------------------------------------------

CREATE FUNCTION app_maintain_organization_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.organization_version < OLD.organization_version THEN
        RAISE EXCEPTION
            'organization_version may not decrease (% -> %)',
            OLD.organization_version, NEW.organization_version
            USING ERRCODE = 'restrict_violation';
    END IF;
    -- SPEC-06 §4: bumped by organization status, entitlement, or
    -- module-dependency change. Only the first exists at this milestone; the
    -- entitlement and module-dependency triggers arrive with those tables and
    -- will bump this counter explicitly, which the `greatest` below permits.
    NEW.organization_version := greatest(
        OLD.organization_version
            + (CASE WHEN NEW.status IS DISTINCT FROM OLD.status THEN 1 ELSE 0 END),
        NEW.organization_version);
    RETURN NEW;
END;
$$;

CREATE TRIGGER organizations_maintain_version
    BEFORE UPDATE ON organizations
    FOR EACH ROW EXECUTE FUNCTION app_maintain_organization_version();

CREATE FUNCTION app_maintain_group_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.group_version < OLD.group_version THEN
        RAISE EXCEPTION
            'group_version may not decrease (% -> %)', OLD.group_version, NEW.group_version
            USING ERRCODE = 'restrict_violation';
    END IF;
    -- SPEC-06 §4: bumped by group status or module-availability change.
    NEW.group_version := greatest(
        OLD.group_version
            + (CASE WHEN NEW.status IS DISTINCT FROM OLD.status THEN 1 ELSE 0 END),
        NEW.group_version);
    RETURN NEW;
END;
$$;

CREATE TRIGGER groups_maintain_version
    BEFORE UPDATE ON groups
    FOR EACH ROW EXECUTE FUNCTION app_maintain_group_version();

CREATE FUNCTION app_maintain_user_counters() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.membership_set_version < OLD.membership_set_version THEN
        RAISE EXCEPTION
            'membership_set_version may not decrease (% -> %)',
            OLD.membership_set_version, NEW.membership_set_version
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.session_epoch < OLD.session_epoch THEN
        RAISE EXCEPTION
            'session_epoch may not decrease (% -> %)', OLD.session_epoch, NEW.session_epoch
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER users_maintain_counters
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION app_maintain_user_counters();

-- `membership_set_version` lives on `users` but is caused by a change to
-- `memberships`, so it is advanced from there.
--
-- SECURITY DEFINER, deliberately and narrowly: the application role holds no
-- UPDATE privilege on `users.membership_set_version` — that is the point — so
-- the bump has to run as the owner. It gains PRIVILEGE and NO TENANT REACH:
-- `users` is FORCE RLS, so the owner is subject to
-- `users_readable_through_membership` and `users_updatable_through_membership`
-- exactly as anyone else is, and the function can only touch a user visible in
-- the caller's current context.
--
-- MEASURED, and it is the reason there is no owner-exempt policy here: an
-- attempt to give the owner an UPDATE-only exemption does not work, because
-- `UPDATE users SET membership_set_version = membership_set_version + 1
-- WHERE id = $1` READS columns, so the SELECT policy applies to the row lookup
-- as well. The only way to make an out-of-context bump succeed would be to let
-- the owner SELECT every user row without a tenant context — which is precisely
-- the property A-04 exists to assert, and it is not for sale.
--
-- The consequence is deliberate and is an ENFORCEMENT POINT rather than a
-- limitation: **a membership change outside a unit of work is refused.** It
-- already violates I-15 and non-bypass rule 1; now it fails loudly at the
-- database instead of silently leaving `membership_set_version` behind, which
-- would make every later `409 CONTEXT_STALE` decision wrong. A privilege change
-- that committed with an unbumped counter is the exact condition SPEC-06 §4
-- calls impossible, so the trigger makes it impossible rather than unlikely.
--
-- A migration or administrative path that legitimately needs to change a
-- membership must open a unit of work for the affected tenant, like everything
-- else. Asserted by `apps/api/test/tenancy/roles-and-schema.test.ts`, describe
-- block "the counter bump enforces the unit of work".
--
-- `SET search_path = public, pg_temp` — **`pg_temp` LAST, and that ordering is
-- the security property.** PostgreSQL searches `pg_temp` FIRST when it is not
-- named explicitly, so a caller holding TEMP on the database could create a
-- temporary table called `users` and shadow the real one. The function would
-- then update the decoy, `GET DIAGNOSTICS` would see its one row, the guard
-- would be satisfied, and the real `membership_set_version` would never move —
-- a privilege change committing with a stale counter, which is exactly the
-- condition this trigger exists to make impossible. Naming `pg_temp` last
-- forces it to be searched last.
--
-- The second line of defence is that no runtime role holds TEMP at all: the
-- cluster bootstrap revokes it (`REVOKE ALL ON DATABASE … FROM PUBLIC`, then
-- granting back `CONNECT` only). That was previously an untested assumption and
-- is now asserted per role — A-05b.
CREATE FUNCTION app_bump_membership_set_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    affected integer;
BEGIN
    UPDATE users
       SET membership_set_version = membership_set_version + 1,
           updated_at = now()
     WHERE id = NEW.user_id;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION
            'membership change for user % did not advance membership_set_version — '
            'the change was made outside a unit of work with transaction-local tenant '
            'context (I-15), so the counter could not be maintained', NEW.user_id
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER memberships_bump_membership_set_version_on_insert
    AFTER INSERT ON memberships
    FOR EACH ROW EXECUTE FUNCTION app_bump_membership_set_version();

-- Only PRIVILEGE-BEARING changes bump the counter. SPEC-01 §2.1 (V-08) is
-- explicit that a routine, high-frequency, privilege-free edit must NOT bump a
-- freshness counter — doing so would make `409 CONTEXT_STALE` an everyday
-- occurrence and train users and implementers alike to engineer around it.
-- `last_active_at` is exactly such an edit, and it is absent from this list.
CREATE TRIGGER memberships_bump_membership_set_version_on_change
    AFTER UPDATE ON memberships
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status
       OR OLD.kind IS DISTINCT FROM NEW.kind
       OR OLD.group_id IS DISTINCT FROM NEW.group_id
       OR OLD.group_role IS DISTINCT FROM NEW.group_role
       OR OLD.organization_role IS DISTINCT FROM NEW.organization_role
       OR OLD.valid_from IS DISTINCT FROM NEW.valid_from
       OR OLD.valid_to IS DISTINCT FROM NEW.valid_to)
    EXECUTE FUNCTION app_bump_membership_set_version();

------------------------------------------------------------------------------
-- Grants (SPEC-01 §4.4).
--
-- Three things are withheld from every runtime role, and each is withheld
-- because the grant is the ONLY available control:
--
--   TRUNCATE / REFERENCES   neither is subject to RLS (S-03).
--
--   DELETE                  doc 09 §4: "Hard-delete permitted: nothing
--                           tenant-scoped." Revocation is end-dating a
--                           membership (`valid_to`, `status = 'ended'`), never
--                           removing the row — an audit chain cannot reference a
--                           row that was deleted, and a deleted membership is
--                           indistinguishable from one that never existed.
--
--   THE FRESHNESS COUNTERS  `organization_version`, `group_version`,
--                           `membership_set_version` and `session_epoch` are
--                           excluded from the column-level UPDATE grants, so
--                           `app_runtime` cannot name them in a SET clause at
--                           all. They move only through the triggers above.
--
-- Column-level grants are verbose and that is the trade: the alternative is a
-- table-level grant plus a promise, and a promise is not a control. Adding a
-- column means adding it here, which is the review friction that should exist.
------------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public
    TO app_runtime, app_worker, app_readonly_support, app_breakglass;

GRANT SELECT, INSERT ON organizations, groups, memberships, users
    TO app_runtime, app_worker;

GRANT UPDATE (name, status, updated_at)
    ON organizations TO app_runtime, app_worker;

GRANT UPDATE (name, status, updated_at)
    ON groups TO app_runtime, app_worker;

GRANT UPDATE (login_email, display_name, status, updated_at)
    ON users TO app_runtime, app_worker;

GRANT UPDATE (
        kind, staffing_kind, status, organization_role, group_role,
        valid_from, valid_to, last_active_at, updated_at
    )
    ON memberships TO app_runtime, app_worker;

GRANT SELECT
    ON organizations, groups, users, memberships
    TO app_readonly_support, app_breakglass;

-- Down Migration

DROP TRIGGER IF EXISTS memberships_bump_membership_set_version_on_change ON memberships;
DROP TRIGGER IF EXISTS memberships_bump_membership_set_version_on_insert ON memberships;
DROP TRIGGER IF EXISTS users_maintain_counters                           ON users;
DROP TRIGGER IF EXISTS groups_maintain_version                           ON groups;
DROP TRIGGER IF EXISTS organizations_maintain_version                    ON organizations;

DROP FUNCTION IF EXISTS app_bump_membership_set_version();
DROP FUNCTION IF EXISTS app_maintain_user_counters();
DROP FUNCTION IF EXISTS app_maintain_group_version();
DROP FUNCTION IF EXISTS app_maintain_organization_version();

DROP POLICY IF EXISTS users_updatable_through_membership        ON users;
DROP POLICY IF EXISTS users_writable_under_organization_context ON users;
DROP POLICY IF EXISTS users_readable_through_membership         ON users;
DROP POLICY IF EXISTS memberships_organization_read             ON memberships;
DROP POLICY IF EXISTS memberships_organization_scope            ON memberships;
DROP POLICY IF EXISTS memberships_group_scope                   ON memberships;
DROP POLICY IF EXISTS groups_organization_scope                 ON groups;
DROP POLICY IF EXISTS groups_group_scope                        ON groups;
DROP POLICY IF EXISTS organizations_tenant                      ON organizations;

DROP INDEX IF EXISTS memberships_principal_lookup;
DROP INDEX IF EXISTS memberships_one_org_membership_per_user;
DROP INDEX IF EXISTS memberships_one_per_user_and_group;
DROP INDEX IF EXISTS groups_organization_idx;

DROP TABLE IF EXISTS memberships;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS groups;
DROP TABLE IF EXISTS organizations;
