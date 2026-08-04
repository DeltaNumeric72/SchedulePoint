-- OPUS-M3-002 — the typed scheduling-rule model: `rules` and `rule_sets`.
-- CAP-015, CAP-045, CAR-006. SPEC-04 §3.
--
-- ADDITIVE ONLY. 0001–0007 are applied and are never edited. Every statement
-- below creates a new object or attaches a new trigger/policy/grant to one of
-- them. No policy is dropped, no constraint relaxed, no existing grant widened.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THERE IS NO `pattern_rules` AND NO `staff_rules` TABLE HERE — FAD-21
--
-- doc 06 §3.2 listed `pattern_rules` and `staff_rules` alongside `rules`. The
-- OPUS-M3-002 pre-migration escalation put the relationship to Fable, and
-- **FAD-21 (2026-08-04) ruled they are CATEGORIES of the one typed model, not
-- separate tables** (doc 06 §3.2 amendment, ruling commit 18237aa):
--
--   > SPEC-04 §3.1 is binding — "Rules are stored as a typed abstract syntax
--   > tree … not as free-form constraint objects" … Building
--   > `pattern_rules.segments` and `staff_rules.{conditions, action,
--   > action_params}` as separate free-form/JSON columns would re-open the exact
--   > CAR-006 escape hatch the typed `rules` table exists to close.
--
-- So this migration creates `rules` + `rule_sets` only, and `rules` carries the
-- ruling's additive, CHECK-constrained discriminator
-- `category ∈ {general, pattern, staff}` (default `general`) so the two observed
-- rule classes stay first-class and queryable. **No capability is dropped**
-- (non-bypass rule 11): every column of both superseded rows maps to a typed
-- node or scope element — the field mapping of record is in the FAD-21 amendment
-- and in `docs/evidence/EV-M3-RULES/ESCALATION-pattern-staff-rules.md`.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Normative sources:
--   06 §3.2 + the FAD-21 amendment  — the authoritative field set for `rules`
--                                     (`rule_key`, `rule_schema_version`,
--                                     `classification`, `weight?`, `scope`,
--                                     typed `predicate`) and for `rule_sets`
--                                     ("name, rule id arrays")
--   06 §1                           — conventions: composite tenant FK, uuid
--                                     surrogate key, `version`, audit fields,
--                                     soft lifecycle, RLS enabled AND forced
--                                     with its policy in the same migration
--   SPEC-04 §3.1                    — the CLOSED node set. Enforced here too:
--                                     `rules_predicate_kind_is_closed` below
--   SPEC-04 §3.3                    — the hard/soft invariant. The CAR-006 CHECK
--                                     is its DATABASE half
--   SPEC-01 §4.3                    — predicate spelling, the V-09 group
--                                     predicate, tenant-qualified uniques
--   SPEC-06 §1.1                    — "Everything not in this enumeration is
--                                     group-scoped": rule authoring is a
--                                     GROUP-scoped action class
--   doc 08 §6                       — "Author catalogue & rules" (scheduler ✓,
--                                     group admin ✓) — the row that defines the
--                                     `schedule.catalogue.administer` population
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE PREDICATE SPELLING IS NORMATIVE AND IS WRITTEN OUT IN FULL, EVERY TIME.
--
--   nullif(current_setting('app.<x>', true), '')::uuid
--
-- The reasoning is in 0001 and is not repeated. What IS repeated is the spelling
-- itself, per reference, on every policy — `roles-and-schema.test.ts` (A-03b)
-- reads `pg_policies` and asserts every individual `current_setting('app.*')`
-- occurrence is nullif-guarded, and a helper would hide the one that was not.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ── WHICH CAPABILITY GATES RULES, AND WHY NO NEW KEY IS MINTED ───────────────
--
-- `schedule.catalogue.administer`. doc 08 §6's row is literally **"Author
-- catalogue & rules"** (scheduler ✓, group admin ✓) — the existing key's own
-- documented population already covers rule authoring, so gating rules with it
-- is INTEGRATION with the SPEC-06 evaluator, not an expansion of capability
-- scope (non-bypass rule 11) and not a change to the evaluator (which this task
-- may not touch). `packages/domain/src/authz/catalogue.ts` is unmodified.
--
-- ── INTERNAL SENSITIVITY, AND THE FAD-17(2) RECURSION DISCIPLINE ─────────────
--
-- doc 06 §3.2 classifies `rules` **`INTERNAL`**. A read is not something a
-- trigger can gate, so — exactly as 0004 does for `SENSITIVE-PII`
-- `qualification_holdings` (FAD-17(2)) — the `rules` policy carries a capability
-- predicate calling `app_acting_membership_holds`.
--
-- **What actually narrows access is that ONE uniform policy**, and it is worth
-- being exact because an earlier version of this comment was not: every row in
-- `rules` — `staff`-category or otherwise — is readable and writable only by a
-- holder of `schedule.catalogue.administer` in the row's own group. FAD-21's
-- `ruleSensitivity(rule) = INTERNAL whenever scope.memberships is non-empty` and
-- the `category` discriminator are a derived CLASSIFICATION of the content, and
-- `rules_staff_category_matches_scope` keeps the two honest against each other.
-- Neither is an access-control mechanism, and neither is consulted at read time.
-- The uniform predicate is at least as narrow as a per-category one would be, so
-- nothing is under-protected — but saying "the derivation narrows access" would
-- describe a control that does not exist.
--
-- **The recursion rule holds, checked rather than assumed.** 0002 had to use the
-- role-only function because a policy ON `capability_grants` whose predicate
-- READS `capability_grants` is infinite recursion. No policy here is on
-- `capability_grants`: `rules`/`rule_sets` are new leaf tables, and
-- `capability_grants`' own policies read `memberships`, `roles` and
-- `role_capabilities` — none of which has a policy that reads back into this
-- migration's tables. The predicate therefore terminates.
--
-- Consequence, stated rather than discovered: `app_readonly_support` holds no
-- EXECUTE on `app_acting_membership_holds`, so its read of `rules` raises 42501
-- rather than returning rows — the same narrowing 0004 documents for
-- `qualification_holdings`, and the SBX-004 sweep records it distinctly.
-- `app_breakglass` has BYPASSRLS (0001, SPEC-01 §4.4) and reads across tenants;
-- that is the declared exception working as designed, audited under SPEC-11 §3.2
-- since OPUS-M3-001.
--
-- `rule_sets` is sensitivity **`NONE`** in doc 06 §3.2 — it holds a name and rule
-- keys, no rule content — so it carries the plain V-09 group predicate like its
-- catalogue siblings, and `app_readonly_support` can read it.

-- Up Migration

------------------------------------------------------------------------------
-- rules — the typed AST (CAR-006, SPEC-04 §3.1).
--
-- `rule_key` is the STABLE identifier (non-bypass rule 13 applies to it exactly
-- as it applies to an invariant id): every rule set and every future build cites
-- it, and a key that silently changes meaning corrupts each citation while the
-- citation still looks correct. It is therefore NOT in the UPDATE grant below —
-- renaming a rule is `name`, which is the human-readable label.
--
-- `predicate` and `scope` are `jsonb` because the AST is a tree, and a tree in
-- relational columns is a table per node kind. **`jsonb` here is a typed tree,
-- not a free-form blob**, and three controls say so — each with a DIFFERENT
-- reach, stated exactly rather than blurred together:
--
--   1. `rules_predicate_kind_is_closed` (below) pins **the discriminant only**.
--      A `{"kind":"RawJson"}` predicate is refused BY THE DATABASE, not merely
--      by the application. It does NOT constrain the other keys of the object:
--      the database will store `{"kind":"RequiredCount","count":1,"extra":…}`.
--      That is the honest limit of a CHECK over jsonb;
--   2. `packages/contracts/src/rules/index.ts` — a zod discriminated union with
--      `.strict()`, which rejects an unknown kind AND an unknown sibling key at
--      the HTTP boundary;
--   3. `packages/domain/src/rules/validate.ts` — exhaustive per-node validation
--      PLUS `RULE_NODE_KEYS`, an allowlist of the keys each node may carry. This
--      is the layer a background job or a future non-HTTP writer calls, and
--      until OPUS-M3-002's second review it ignored keys it did not recognise —
--      so a smuggled `customExpression` beside valid fields validated cleanly.
--      It does not any more.
--
-- **Stored-permissive, read-strict, and that is deliberate.** Because control 1
-- pins only the kind, a row written out of band (by the table owner, bypassing
-- 2 and 3) can carry an extra key. Reading it back through the service
-- re-validates and refuses, so such a row surfaces as a failure rather than as a
-- rule that quietly means something else — fail-closed, not silently tolerated.
--
-- Together that is what makes "a rule the AST cannot express is a schema change
-- with a migration, never an escape hatch" (SPEC-04 §3.1) true of every writer
-- that goes through the application, and detectable for any that does not.
------------------------------------------------------------------------------

CREATE TABLE rules (
    id                   uuid PRIMARY KEY,
    organization_id      uuid NOT NULL REFERENCES organizations (id),
    group_id             uuid NOT NULL,
    rule_key             text NOT NULL
        CHECK (rule_key ~ '^[a-z][a-z0-9_]*$' AND length(rule_key) <= 64),
    name                 text NOT NULL
        CHECK (length(btrim(name)) > 0 AND length(name) <= 120),
    rule_schema_version  integer NOT NULL CHECK (rule_schema_version > 0),
    classification       text NOT NULL CHECK (classification IN ('HARD', 'SOFT')),
    weight               numeric(12, 4),
    category             text NOT NULL DEFAULT 'general'
        CHECK (category IN ('general', 'pattern', 'staff')),
    scope                jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(scope) = 'object'),
    predicate            jsonb NOT NULL
        CHECK (jsonb_typeof(predicate) = 'object'),
    status               text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disabled', 'archived')),
    version              integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),

    -- ── The DATABASE half of the hard/soft invariant (CAR-006, SPEC-04 §3.3) ──
    --
    -- Quoted from doc 06 §3.2 and SPEC-04 §3.3 verbatim in intent: a `HARD` rule
    -- "can never be relaxed, downgraded, weighted, or skipped by any code path",
    -- and a rule that carries a weight is a rule something can trade away. The
    -- compiler enforces the same thing structurally (no path from HARD to an
    -- objective term); this refuses the row regardless of what the compiler does.
    CONSTRAINT rules_hard_soft_weight CHECK (
        (classification = 'HARD' AND weight IS NULL)
     OR (classification = 'SOFT' AND weight IS NOT NULL AND weight > 0)
    ),

    -- ── The CLOSED node set, at the storage layer (SPEC-04 §3.1) ─────────────
    --
    -- Thirty kinds, ten families, enumerated. Adding a node is a schema change
    -- WITH A MIGRATION — which is precisely the property SPEC-04 §3.1 asks for,
    -- and this constraint is what makes the sentence true of stored data.
    CONSTRAINT rules_predicate_kind_is_closed CHECK (
        predicate->>'kind' IN (
            'RequiredCount', 'MinCoverage', 'MaxCoverage',
            'RequiresQualification', 'MemberOfStaffGroup', 'ValidGroupRestriction',
            'PickPositionRestriction',
            'MaxAssignmentsInWindow', 'WeekdayFteLimit', 'WorkPercentageTarget',
            'MaxConsecutive',
            'MinimumRestBetween', 'CallSpacing', 'NoAdjacent', 'ForbiddenSequence',
            'PatternRule', 'AlternatingWeek', 'TemplateAdherence',
            'LinkedShifts', 'ImpliesAssignment', 'MutuallyExclusive',
            'RequestHonoured', 'ShiftPreference', 'AvoidDate',
            'FairnessBalance', 'CreditDistribution',
            'StaffOverLocumPriority', 'LocumRestriction',
            'FixedAssignment', 'ProtectedRange'
        )
    ),

    -- ── FAD-21's derived classification, as a database invariant ────────────
    --
    -- A rule that names individuals IS a `staff`-category rule, and nothing else
    -- is. Derivation in the application and a discriminator in the database
    -- drift the moment one of them is written by hand, so the database refuses
    -- the disagreement. (This is a CLASSIFICATION invariant, not an access
    -- control — see the header.)
    --
    -- **`coalesce` is load-bearing, and its absence was a real hole.** With no
    -- `memberships` key at all, `scope->'memberships'` is SQL NULL, so
    -- `jsonb_typeof(...) = 'array'` was NULL, the conjunction was NULL, and
    -- `NULL = (category = 'staff')` is NULL — which a CHECK **accepts**. A row
    -- could therefore be `category = 'staff'` while naming nobody. Wrapping the
    -- left side in `coalesce(..., false)` makes the equality total, so the
    -- constraint is genuinely bidirectional: staff-without-memberships is
    -- refused, and memberships-without-staff is refused.
    CONSTRAINT rules_staff_category_matches_scope CHECK (
        coalesce(
            jsonb_typeof(scope->'memberships') = 'array'
            AND jsonb_array_length(scope->'memberships') > 0,
            false
        ) = (category = 'staff')
    ),

    -- `scope.memberships`, when present, must be an array — the shape the
    -- constraint above and the domain's `ruleSensitivity` classifier both read.
    CONSTRAINT rules_scope_memberships_shape CHECK (
        scope->'memberships' IS NULL OR jsonb_typeof(scope->'memberships') = 'array'
    ),

    CONSTRAINT rules_tenant_identity UNIQUE (id, organization_id, group_id),
    CONSTRAINT rules_key_unique_in_group UNIQUE (organization_id, group_id, rule_key),
    CONSTRAINT rules_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id)
);

CREATE INDEX rules_lookup ON rules (organization_id, group_id, status, rule_key);
CREATE INDEX rules_category ON rules (organization_id, group_id, category);

------------------------------------------------------------------------------
-- rule_sets — "name, rule id arrays" (doc 06 §3.2), "Referenced by builds".
--
-- An ARRAY column rather than a junction table, because doc 06 says "rule id
-- arrays" and a junction table is a schema shape doc 06 does not sanction —
-- inventing one would be exactly the improvisation the packet forbids.
--
-- The members are `rule_key`s, not row ids: a rule set is a statement about
-- STABLE identifiers, so it survives any future re-keying of the physical rows
-- and means the same thing when a build cites it a year later.
------------------------------------------------------------------------------

CREATE TABLE rule_sets (
    id               uuid PRIMARY KEY,
    organization_id  uuid NOT NULL REFERENCES organizations (id),
    group_id         uuid NOT NULL,
    name             text NOT NULL
        CHECK (length(btrim(name)) > 0 AND length(name) <= 120),
    rule_keys        text[] NOT NULL DEFAULT '{}',
    status           text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'archived')),
    version          integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT rule_sets_tenant_identity UNIQUE (id, organization_id, group_id),
    CONSTRAINT rule_sets_name_unique_in_group UNIQUE (organization_id, group_id, name),
    CONSTRAINT rule_sets_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id)
);

CREATE INDEX rule_sets_lookup ON rule_sets (organization_id, group_id, status, name);

------------------------------------------------------------------------------
-- Row level security. ENABLE **and** FORCE, on every table, with its policy in
-- this same migration (06 §1, I-15, D-10; the gate asserts the pairing).
------------------------------------------------------------------------------

ALTER TABLE rules      ENABLE ROW LEVEL SECURITY;
ALTER TABLE rules      FORCE  ROW LEVEL SECURITY;
ALTER TABLE rule_sets  ENABLE ROW LEVEL SECURITY;
ALTER TABLE rule_sets  FORCE  ROW LEVEL SECURITY;

-- `rules` — the V-09 conjunctive group predicate PLUS the INTERNAL capability
-- predicate (FAD-17(2); the recursion argument is in this file's header).
--
-- One `FOR ALL` policy, so read and write are narrowed identically. That is the
-- same deliberate choice OPUS-M2-002 recorded for the catalogue — there is no
-- separate rules-read key, doc 08 §6 has no "view rules" row to read one off,
-- and deny-by-default is the correct direction to be wrong in (I-02). The later
-- surfaces that need to READ compiled rules (the M3-004 validation display, the
-- M4 build pipeline) declare their own actions when they ship.
CREATE POLICY rules_group_administration ON rules
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND app_acting_membership_holds('schedule.catalogue.administer'))
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND app_acting_membership_holds('schedule.catalogue.administer'));

-- `rule_sets` — sensitivity NONE, so the plain group predicate, like the
-- catalogue tables. It names rules; it does not carry rule content.
CREATE POLICY rule_sets_group_scope ON rule_sets
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
-- defence in depth, in the one-directional sense 0002 describes: every layer
-- can only DENY, so a statement a trigger admits may still be denied above it,
-- and a statement it refuses is refused whatever the application thinks.
------------------------------------------------------------------------------

CREATE FUNCTION app_guard_rule_administration() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM app_require_capability('schedule.catalogue.administer', NEW.organization_id);
    RETURN NEW;
END;
$$;

/* A rule is archived, never deleted: `rule_key` is cited by rule sets and by
 * every build that ever consumed it, and a deleted key turns those citations
 * into dangling references that still look correct (non-bypass rule 13). No
 * runtime role holds DELETE below, so this guards the OWNER path. */
CREATE FUNCTION app_guard_rule_delete() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION 'RULE_DELETE_FORBIDDEN'
        USING ERRCODE = 'raise_exception',
              HINT    = 'Archive the rule instead; rule_key is cited by rule sets and builds.';
END;
$$;

CREATE TRIGGER rules_guard_administration
    BEFORE INSERT OR UPDATE ON rules
    FOR EACH ROW EXECUTE FUNCTION app_guard_rule_administration();

CREATE TRIGGER rules_guard_delete
    BEFORE DELETE ON rules
    FOR EACH ROW EXECUTE FUNCTION app_guard_rule_delete();

CREATE TRIGGER rule_sets_guard_administration
    BEFORE INSERT OR UPDATE ON rule_sets
    FOR EACH ROW EXECUTE FUNCTION app_guard_rule_administration();

/* `rule_key` is immutable once written — the stable-identifier discipline
 * (non-bypass rule 13) made mechanical. It is also absent from the UPDATE grant
 * below, so a runtime role cannot name it; this refuses the OWNER path too, and
 * it is the trigger that makes "a rule_key never silently changes meaning" a
 * property of the database rather than of everybody's care. */
CREATE FUNCTION app_guard_rule_key_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.rule_key IS DISTINCT FROM OLD.rule_key THEN
        RAISE EXCEPTION 'RULE_KEY_IMMUTABLE'
            USING ERRCODE = 'raise_exception',
                  HINT    = 'A rule_key is a stable identifier. Archive and author a new rule.';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER rules_guard_key_immutable
    BEFORE UPDATE ON rules
    FOR EACH ROW EXECUTE FUNCTION app_guard_rule_key_immutable();

-- `_maintain_` sorts after `_guard_`, so an unauthorized write is refused before
-- the counter moves. Trigger firing order is by name; these names are chosen.
-- The version counter itself is 0005's `app_maintain_catalogue_version`, reused
-- rather than re-declared — the same optimistic-concurrency control, and a
-- second copy of it would be a second thing to get wrong.
CREATE TRIGGER rules_maintain_version
    BEFORE UPDATE ON rules
    FOR EACH ROW EXECUTE FUNCTION app_maintain_catalogue_version();

CREATE TRIGGER rule_sets_maintain_version
    BEFORE UPDATE ON rule_sets
    FOR EACH ROW EXECUTE FUNCTION app_maintain_catalogue_version();

------------------------------------------------------------------------------
-- Grants.
--
-- `rule_key`, `organization_id`, `group_id`, `id`, `created_at`, `version` are
-- absent from every UPDATE grant: naming one raises 42501 before any trigger
-- runs. `version` is database-owned (0005's finding — an application-incremented
-- counter is not a concurrency control).
------------------------------------------------------------------------------

GRANT SELECT, INSERT ON rules, rule_sets TO app_runtime, app_worker;

GRANT UPDATE (
        name, rule_schema_version, classification, weight, category,
        scope, predicate, status, updated_at
    ) ON rules TO app_runtime, app_worker;

GRANT UPDATE (name, rule_keys, status, updated_at)
    ON rule_sets TO app_runtime, app_worker;

-- The two support roles, and they are NOT the same case (0004's distinction,
-- which applies here for the same reasons):
--
--   `app_readonly_support`  is narrowed. On `rules` it is narrowed to NOTHING:
--                           the policy calls `app_acting_membership_holds`, on
--                           which this role holds no EXECUTE, so the read raises
--                           42501 rather than returning rows. That is the
--                           INTERNAL classification working. On `rule_sets`
--                           (sensitivity NONE) it reads normally.
--
--   `app_breakglass`        has BYPASSRLS (0001, SPEC-01 §4.4). No policy here
--                           constrains it. That is the declared break-glass
--                           exception working as designed — audited under
--                           SPEC-11 §3.2 since OPUS-M3-001 — not an oversight.
--
-- The grants are present so the (role, table) privilege matrix in
-- `roles-and-schema.test.ts` has an explicit answer for every cell rather than
-- an accidental one.
GRANT SELECT ON rules, rule_sets TO app_readonly_support, app_breakglass;

-- PostgreSQL grants EXECUTE to PUBLIC on every new function, so a GRANT without
-- a REVOKE reads as a restriction and is not one. All three are trigger
-- functions, unreachable except through their triggers — revoked anyway rather
-- than relying on that, exactly as 0002/0004/0005 do.
REVOKE ALL ON FUNCTION app_guard_rule_administration() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_guard_rule_delete()         FROM PUBLIC;
REVOKE ALL ON FUNCTION app_guard_rule_key_immutable()  FROM PUBLIC;

-- Down Migration

DROP TRIGGER IF EXISTS rule_sets_maintain_version     ON rule_sets;
DROP TRIGGER IF EXISTS rules_maintain_version         ON rules;
DROP TRIGGER IF EXISTS rules_guard_key_immutable      ON rules;
DROP TRIGGER IF EXISTS rule_sets_guard_administration ON rule_sets;
DROP TRIGGER IF EXISTS rules_guard_delete             ON rules;
DROP TRIGGER IF EXISTS rules_guard_administration     ON rules;

DROP FUNCTION IF EXISTS app_guard_rule_key_immutable();
DROP FUNCTION IF EXISTS app_guard_rule_delete();
DROP FUNCTION IF EXISTS app_guard_rule_administration();

DROP POLICY IF EXISTS rule_sets_group_scope         ON rule_sets;
DROP POLICY IF EXISTS rules_group_administration    ON rules;

DROP INDEX IF EXISTS rule_sets_lookup;
DROP INDEX IF EXISTS rules_category;
DROP INDEX IF EXISTS rules_lookup;

-- `rules` before `rule_sets` is not required (no FK between them — a rule set
-- cites rule KEYS, not rows), but the order mirrors the creation order reversed
-- so the file reads the same in both directions.
DROP TABLE IF EXISTS rule_sets;
DROP TABLE IF EXISTS rules;
