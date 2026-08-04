-- OPUS-M2-003 — effective-dated work profiles, weekday/holiday FTE targets, and
-- qualifications with expiry (CAP-013, CAP-058).
--
-- ADDITIVE ONLY. 0001, 0002 and 0003 are applied and are never edited. Everything
-- below either creates a new object or attaches a new trigger to one of its own
-- tables. No existing policy is dropped, no existing constraint is relaxed, and
-- no existing grant is widened.
--
-- **Numbering is assigned at merge.** OPUS-M2-002 adds its own migrations in a
-- parallel worktree; the second merger rebases and renumbers (packet 30 §5).
--
-- Normative sources:
--   06 §3.2 rows      — `membership_work_profiles`, `membership_weekday_fte`,
--                       `qualifications`, `qualification_holdings` (CAR-006, CAR-020)
--   PO-DEC-12         — working default: qualifications are ADMINISTRATOR-GRANTED
--                       and patient-safety adjacent. This migration implements the
--                       default and nothing else (non-bypass rule 12)
--   SPEC-01 §4.3      — RLS predicate spelling, V-09's conjunctive group predicate,
--                       FORCE RLS, composite tenant FKs, tenant-qualified uniques
--   SPEC-06 §2.1 P-7  — the exclusion-constraint pattern, borrowed here from
--                       `capability_grants` / `entitlements` in 0002
--   EV-M1-AUTHZ S-01  — **the lesson this migration exists to reuse.** An
--                       effective-dated table read without a window predicate
--                       returns an arbitrary row, and the symptom is a silent,
--                       organization-wide wrong answer with nothing in the logs
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE PREDICATE SPELLING IS NORMATIVE AND IS WRITTEN OUT IN FULL, EVERY TIME.
--
--   nullif(current_setting('app.<x>', true), '')::uuid
--
-- The reasoning is in `0001_tenancy_core.sql` and is not repeated.
-- `roles-and-schema.test.ts` (A-03b) reads `pg_policies` and asserts that every
-- individual `current_setting('app.*')` occurrence in every policy is
-- nullif-guarded; it now covers these four tables too.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY AN OPEN END IS SPELLED `NULL` AND NEVER `infinity`
--
-- `timestamptz` accepts `infinity`, and node-postgres returns it as the
-- JavaScript number `Infinity` rather than a `Date` — so `.toISOString()` throws
-- and an ordinary read becomes a 500. 0002 closed that at the CHECK level for
-- `memberships`, `capability_grants` and `entitlements` after a reviewer wrote
-- infinite bounds to all three. The same `*_finite_window` CHECK is on every
-- window column below, written the same way, for the same reason (S-22).
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WINDOW BOUNDS ARE STORED AT MILLISECOND PRECISION, DELIBERATELY
--
-- `now()` has microsecond resolution. JavaScript's `Date` and ISO-8601 over JSON
-- both have millisecond resolution, so a bound written with bare `now()` **cannot
-- round-trip**: the API returns an instant up to 999 µs earlier than the one
-- stored, and a client that hands that instant back names a different point in
-- time.
--
-- For an ordinary timestamp that is harmless. For a window BOUND it is not: the
-- successor's start is written from the predecessor's end, so a truncating
-- round-trip opens a sub-millisecond gap in which no profile is in force — a
-- period that is invisible in every human-readable rendering of the data and
-- perfectly real to the selection rule.
--
-- So every bound this schema chooses for itself is `date_trunc('milliseconds',
-- now())`, and the values in the database are exactly the values the API can
-- express. `created_at` / `updated_at` keep full `now()`: they are observations,
-- never boundaries, and nothing computes against them.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE DIVISION OF LABOUR BETWEEN RLS AND TRIGGERS, RESTATED
--
--   RLS policy   answers "whose tenant is this row?"       — always
--   trigger      answers "may this actor write it?"        — 0002's
--                `app_require_capability` pattern, reused verbatim
--
-- With ONE deliberate exception. `qualification_holdings` is classified
-- **`SENSITIVE-PII`** in 06 §3.2, so *reads* have to be narrowed as well — and a
-- read is not something a trigger can gate. Its SELECT policies therefore carry a
-- capability predicate, and they call `app_acting_membership_holds` (the
-- grant-aware function) rather than `app_acting_membership_role_holds` (the
-- role-only one 0002's `capability_grants` policies use).
--
-- **That difference is deliberate and it is safe here for a reason that does not
-- hold there.** 0002 had to use the role-only function because a policy ON
-- `capability_grants` whose predicate READS `capability_grants` is infinite
-- recursion. No policy below is on `capability_grants`, so reading it from these
-- predicates terminates: `capability_grants`' own policies read `memberships`,
-- `roles` and `role_capabilities`, none of which has a policy that reads back
-- into this migration's tables.
--
-- The grant-aware function is also the only one that WORKS here, because all six
-- capabilities below are **grant-only** — no system role carries them
-- (`SYSTEM_ROLE_CAPABILITIES` is OPUS-M1-002's file and is not this task's to
-- edit), exactly as `schedule.publish`, `vacation.commit` and `audit.export`
-- already are. doc 08 §4's named-grant class is the established shape for
-- "requires an administrative capability", which is what CAP-013 and CAP-058 both
-- ask for.
-- ─────────────────────────────────────────────────────────────────────────────

-- Up Migration

------------------------------------------------------------------------------
-- membership_work_profiles — CAP-013, 06 §3.2, CAR-006/CAR-020.
--
-- One authoritative row in force per membership per instant, guaranteed by an
-- EXCLUDE constraint over `tstzrange(effective_from, effective_to, '[)')` —
-- 0002's `capability_grants_no_overlapping_window` pattern, and the half-open
-- bound is the same choice for the same reason: end-dating a profile by starting
-- its replacement at the same instant is the ordinary way to change one, and a
-- closed upper bound would make those two windows collide.
--
-- **More than one row per membership is the DESIGNED steady state**, not a
-- corruption: a history of closed windows plus at most one live or future one is
-- what supersession produces. Every reader therefore has to select the row in
-- force at an instant, and `packages/domain/src/profiles/in-force.ts` is the one
-- implementation that does it. Nothing in this schema hands out a defensible
-- "just take the first row".
--
-- `group_id` is NOT NULL: 06 §3.2 gives the table tenant scope `org+group`, and a
-- work profile belongs to a GROUP membership. The composite FK below binds it to
-- the membership's organization; `app_guard_work_profile_scope` binds it to the
-- membership's GROUP, which the composite FK cannot see (the same gap 0002's
-- `app_guard_capability_grant_administration` exists to close, and the same
-- consequence if it were left open — a row filed under the wrong group is
-- invisible under the right one, with no error).
------------------------------------------------------------------------------

CREATE TABLE membership_work_profiles (
    id                          uuid PRIMARY KEY,
    organization_id             uuid NOT NULL,
    group_id                    uuid NOT NULL,
    membership_id               uuid NOT NULL,

    effective_from              timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
    -- NULL means OPEN-ENDED. Never `infinity` — see the header.
    effective_to                timestamptz,

    -- 06 §3.2: `0 < work_percentage <= 100`.
    work_percentage             numeric(5,2) NOT NULL
                                    CHECK (work_percentage > 0 AND work_percentage <= 100),
    max_assignments_per_week    integer CHECK (max_assignments_per_week    IS NULL OR max_assignments_per_week    >= 0),
    max_assignments_per_period  integer CHECK (max_assignments_per_period  IS NULL OR max_assignments_per_period  >= 0),
    max_consecutive_days        integer CHECK (max_consecutive_days        IS NULL OR max_consecutive_days        >= 0),

    created_at                  timestamptz NOT NULL DEFAULT now(),
    updated_at                  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT membership_work_profiles_window
        CHECK (effective_to IS NULL OR effective_to > effective_from),

    CONSTRAINT membership_work_profiles_finite_window CHECK (
        effective_from > '-infinity'::timestamptz AND effective_from < 'infinity'::timestamptz
    AND (effective_to IS NULL
         OR (effective_to > '-infinity'::timestamptz AND effective_to < 'infinity'::timestamptz))
    ),

    CONSTRAINT membership_work_profiles_membership_fk
        FOREIGN KEY (membership_id, organization_id)
        REFERENCES memberships (id, organization_id),

    CONSTRAINT membership_work_profiles_group_fk
        FOREIGN KEY (group_id, organization_id)
        REFERENCES groups (id, organization_id),

    CONSTRAINT membership_work_profiles_tenant_identity UNIQUE (id, organization_id),

    -- THE CENTREPIECE CONSTRAINT. Overlap is refused by the database, so "one
    -- authoritative row in force" is a property of the schema rather than a
    -- promise made by the writer.
    CONSTRAINT membership_work_profiles_no_overlapping_window
        EXCLUDE USING gist (
            organization_id WITH =,
            membership_id   WITH =,
            tstzrange(effective_from, effective_to, '[)') WITH &&
        )
);

CREATE INDEX membership_work_profiles_lookup
    ON membership_work_profiles (organization_id, membership_id, effective_from);

------------------------------------------------------------------------------
-- membership_weekday_fte — CAP-013, 06 §3.2, "the canonical home weekday FTE
-- previously lacked".
--
-- ## The one place this migration extends 06 §3.2, stated plainly
--
-- 06 §3.2 gives the key field as `weekday (0–6)`. The packet requires "per
-- weekday {Mon..Sun} **+ holiday** targets", and a holiday is not a weekday
-- number. The column is therefore `day text` over the closed set
-- `{mon..sun, holiday}` — **the same eight-member domain FAD-16 already
-- established for `shift_type_weekday_demand`** at OPUS-M2-002's issuance, so the
-- two demand/target dimensions in M2 agree rather than each inventing a spelling.
--
-- This is a divergence from a written document and it is disclosed as one in the
-- return report and in `docs/evidence/EV-M2-PROFILES/INDEX.md`; it needs an
-- orchestrator amendment to 06 §3.2 of exactly the kind FAD-16 made for M2-002.
-- It is implemented rather than escalated because the packet specifies the shape
-- itself — the escalation trigger is "doc 06's shape proves insufficient **for the
-- owner's target list**", and the packet has already resolved that by naming the
-- holiday dimension in its own required-implementation text.
--
-- ## Why there is no UPDATE path
--
-- These rows belong to a profile VERSION. Changing a weekday target is a change
-- to the member's working arrangement, and the whole point of the table above is
-- that such a change supersedes rather than overwrites — so weekday targets are
-- INSERT-only, no runtime role holds UPDATE or DELETE on them, and a new set of
-- targets arrives with the new profile row that owns them.
------------------------------------------------------------------------------

CREATE TABLE membership_weekday_fte (
    id                uuid PRIMARY KEY,
    organization_id   uuid NOT NULL,
    group_id          uuid NOT NULL,
    work_profile_id   uuid NOT NULL,

    day               text NOT NULL
                          CHECK (day IN ('mon','tue','wed','thu','fri','sat','sun','holiday')),

    -- 06 §3.2: `0 <= fte_fraction <= 1`.
    fte_fraction      numeric(4,3) NOT NULL CHECK (fte_fraction >= 0 AND fte_fraction <= 1),
    max_assignments   integer CHECK (max_assignments IS NULL OR max_assignments >= 0),

    created_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT membership_weekday_fte_profile_fk
        FOREIGN KEY (work_profile_id, organization_id)
        REFERENCES membership_work_profiles (id, organization_id),

    CONSTRAINT membership_weekday_fte_group_fk
        FOREIGN KEY (group_id, organization_id)
        REFERENCES groups (id, organization_id),

    CONSTRAINT membership_weekday_fte_tenant_identity UNIQUE (id, organization_id),

    -- 06 §3.2's `(work_profile_id, weekday)`, tenant-qualified per SPEC-01 §4.3.
    CONSTRAINT membership_weekday_fte_unique_day
        UNIQUE (organization_id, work_profile_id, day)
);

CREATE INDEX membership_weekday_fte_lookup
    ON membership_weekday_fte (organization_id, work_profile_id);

------------------------------------------------------------------------------
-- qualifications — CAP-058, 06 §3.2. The group's credential vocabulary.
--
-- "Not deleted while holdings exist" (06 §3.2) is enforced twice and neither is
-- decorative: no runtime role holds DELETE, and a BEFORE DELETE trigger refuses
-- the statement even for the table owner — because the owner is exactly who a
-- migration or a maintenance script runs as, and "the runtime cannot reach it"
-- is not the same claim as "it cannot happen".
--
-- Retiring is a `status` change. It is reversible, it destroys nothing, and every
-- holding that referenced the qualification still resolves.
------------------------------------------------------------------------------

CREATE TABLE qualifications (
    id               uuid PRIMARY KEY,
    organization_id  uuid NOT NULL,
    group_id         uuid NOT NULL,

    -- A KEY, not a label: lower-case token, no spaces. `name` carries the human
    -- text. The pattern is what lets `key` appear in an audit payload at all —
    -- `app_audit_payload_is_closed` refuses any string with a space (I-07), so a
    -- free-form key would make every qualification audit row a 500 the first time
    -- somebody typed two words. The constraint is the reason the payload is safe.
    key              text NOT NULL
                         CHECK (key ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
    name             text NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 200),
    requires_expiry  boolean NOT NULL DEFAULT false,
    issuing_body     text CHECK (issuing_body IS NULL
                                 OR (length(btrim(issuing_body)) > 0 AND length(issuing_body) <= 200)),
    status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),

    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT qualifications_group_fk
        FOREIGN KEY (group_id, organization_id)
        REFERENCES groups (id, organization_id),

    CONSTRAINT qualifications_tenant_identity UNIQUE (id, organization_id),
    CONSTRAINT qualifications_unique_key UNIQUE (organization_id, group_id, key)
);

CREATE INDEX qualifications_lookup ON qualifications (organization_id, group_id, status);

------------------------------------------------------------------------------
-- qualification_holdings — CAP-058, 06 §3.2. **`SENSITIVE-PII`.**
--
-- ## `evidence_ref` is a REFERENCE, and the CHECK is what keeps it one
--
-- I-07: no patient-identifying information and no clinical free text enters the
-- system. A nullable `text` column beside the words "evidence" is precisely where
-- a free-text note about a person ends up, so the column is constrained to an
-- opaque token shape — letters, digits, and `. _ : -`, at most 128 characters, no
-- spaces. A sentence cannot be stored in it. The document itself lives outside
-- this system; this is the handle.
--
-- ## Retained after expiry
--
-- 06 §3.2: "Retained after expiry for audit". No runtime role holds DELETE and a
-- BEFORE DELETE trigger refuses the statement for the owner as well, so an
-- expired or revoked credential stays readable to the people entitled to read it.
--
-- ## Revocation does not move the window
--
-- A revoked holding keeps its `valid_from`/`valid_until` exactly as issued and
-- moves `status` to `revoked`. Shortening the window would be rewriting what the
-- credential said, which is the same class of mistake as rewriting a profile row —
-- and eligibility already asks for `status IN ('valid','expiring')`, so a revoked
-- holding stops conferring eligibility the instant its status moves.
------------------------------------------------------------------------------

CREATE TABLE qualification_holdings (
    id                uuid PRIMARY KEY,
    organization_id   uuid NOT NULL,
    group_id          uuid NOT NULL,
    membership_id     uuid NOT NULL,
    qualification_id  uuid NOT NULL,

    valid_from        timestamptz NOT NULL DEFAULT date_trunc('milliseconds', now()),
    -- NULL means no expiry recorded. Never `infinity` — see the header.
    valid_until       timestamptz,

    evidence_ref      text CHECK (evidence_ref IS NULL OR evidence_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),

    status            text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'valid', 'expiring', 'expired', 'revoked')),

    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT qualification_holdings_window
        CHECK (valid_until IS NULL OR valid_until > valid_from),

    CONSTRAINT qualification_holdings_finite_window CHECK (
        valid_from > '-infinity'::timestamptz AND valid_from < 'infinity'::timestamptz
    AND (valid_until IS NULL
         OR (valid_until > '-infinity'::timestamptz AND valid_until < 'infinity'::timestamptz))
    ),

    CONSTRAINT qualification_holdings_membership_fk
        FOREIGN KEY (membership_id, organization_id)
        REFERENCES memberships (id, organization_id),

    CONSTRAINT qualification_holdings_qualification_fk
        FOREIGN KEY (qualification_id, organization_id)
        REFERENCES qualifications (id, organization_id),

    CONSTRAINT qualification_holdings_group_fk
        FOREIGN KEY (group_id, organization_id)
        REFERENCES groups (id, organization_id),

    CONSTRAINT qualification_holdings_tenant_identity UNIQUE (id, organization_id),

    -- 06 §3.2's `(membership_id, qualification_id, valid_from)`, tenant-qualified.
    -- Deliberately NOT an EXCLUDE: overlapping holdings of the same credential are
    -- legitimate (a renewal is issued before the previous certificate expires), so
    -- "which holdings are in force at T" is a FILTER, not a single-row selection.
    -- The window predicate is shared with the profile loader all the same — see
    -- `packages/domain/src/profiles/in-force.ts`.
    CONSTRAINT qualification_holdings_unique_issue
        UNIQUE (organization_id, membership_id, qualification_id, valid_from)
);

CREATE INDEX qualification_holdings_lookup
    ON qualification_holdings (organization_id, membership_id, qualification_id);

CREATE INDEX qualification_holdings_by_group
    ON qualification_holdings (organization_id, group_id, status);

------------------------------------------------------------------------------
-- Row-level security. ENABLE **and** FORCE, per table, in this migration
-- (SPEC-01 §4.3 A-04; `scripts/gates/migration-rls-check.mjs` fails the build
-- otherwise, and that gate is why this block cannot drift into a later file).
------------------------------------------------------------------------------

ALTER TABLE membership_work_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_work_profiles FORCE  ROW LEVEL SECURITY;
ALTER TABLE membership_weekday_fte   ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_weekday_fte   FORCE  ROW LEVEL SECURITY;
ALTER TABLE qualifications           ENABLE ROW LEVEL SECURITY;
ALTER TABLE qualifications           FORCE  ROW LEVEL SECURITY;
ALTER TABLE qualification_holdings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE qualification_holdings   FORCE  ROW LEVEL SECURITY;

-- ── membership_work_profiles, membership_weekday_fte, qualifications ─────────
--
-- Group-scoped data, so V-09's conjunctive group predicate applies in full under
-- a group context. The organization-scoped policy mirrors
-- `group_module_availability_organization_scope` in 0002: an organization
-- administrator administers the organization's groups, and a policy that admitted
-- only `group_id IS NULL` rows under an organization context would make that
-- impossible for tables whose every row carries a group.

CREATE POLICY membership_work_profiles_group_scope ON membership_work_profiles
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE POLICY membership_work_profiles_organization_scope ON membership_work_profiles
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NULL)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NULL);

CREATE POLICY membership_weekday_fte_group_scope ON membership_weekday_fte
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE POLICY membership_weekday_fte_organization_scope ON membership_weekday_fte
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NULL)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NULL);

CREATE POLICY qualifications_group_scope ON qualifications
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE POLICY qualifications_organization_scope ON qualifications
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NULL)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NULL);

-- ── qualification_holdings: the SENSITIVE-PII narrowing ──────────────────────
--
-- Three policies, and the asymmetry with the three tables above is the whole
-- point. Tenant scope is NOT sufficient here: 06 §3.2 classifies holdings
-- `SENSITIVE-PII`, and "every member of the group can read every colleague's
-- credential history and its expiry dates" is a disclosure of employment and
-- credentialing data about identified individuals, not a tenancy question.
--
-- The same reasoning 0002 applied to `capability_grants` at S-05, one step
-- further: those policies expose WHO HOLDS WHAT authority; these expose WHO HOLDS
-- WHAT CREDENTIAL, and the second is personal data about the holder.
--
--   * **your own holdings, always.** A member reading their own credential
--     record discloses nothing, and refusing it would make the ordinary "when
--     does my certification expire" question unanswerable.
--   * **another member's holdings** require `staffing.qualification_holding.read_any`
--     under a group-scoped context. This is a READ capability with no write power,
--     so a scheduler who must check eligibility does not thereby gain the ability
--     to grant credentials.
--   * **writing** requires `staffing.qualification_holding.administer` — PO-DEC-12's
--     recorded default: administrator-granted.
--
-- There is deliberately **no organization-scoped blanket policy** on this table,
-- unlike the three above. An organization-scoped context sees only its own
-- acting membership's holdings. Administering someone else's credentials is a
-- group-scoped action performed in the group the credential applies to.

CREATE POLICY qualification_holdings_own ON qualification_holdings
    FOR SELECT
    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
       AND membership_id = nullif(current_setting('app.membership_id', true), '')::uuid);

CREATE POLICY qualification_holdings_group_read_any ON qualification_holdings
    FOR SELECT
    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
       AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
       AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
       AND app_acting_membership_holds('staffing.qualification_holding.read_any'));

CREATE POLICY qualification_holdings_group_administration ON qualification_holdings
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND app_acting_membership_holds('staffing.qualification_holding.administer'))
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND app_acting_membership_holds('staffing.qualification_holding.administer'));

------------------------------------------------------------------------------
-- The capability gates. `app_require_capability` is 0002's shared guard body; it
-- raises `insufficient_privilege` (42501), which `src/db/pg-errors.ts` already
-- maps, and its message names the capability and nothing else (I-07, I-17).
--
-- Each guard also binds `group_id` to the referenced row's, which the composite
-- foreign keys cannot: they are over `(x_id, organization_id)` and have no sight
-- of `group_id`. Without that check a profile filed under the wrong group would
-- be invisible under the right one — a silent, permanent loss of a member's FTE
-- with no error anywhere, which is the same failure shape 0002's
-- `app_guard_capability_grant_administration` exists to prevent.
------------------------------------------------------------------------------

CREATE FUNCTION app_guard_work_profile_administration() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    target memberships%ROWTYPE;
BEGIN
    PERFORM app_require_capability('staffing.work_profile.administer', NEW.organization_id);

    SELECT * INTO target FROM memberships m WHERE m.id = NEW.membership_id;
    IF NOT FOUND THEN
        -- Unreachable through the composite FK, which fires later. Kept so the
        -- group check below cannot silently read a NULL and pass.
        RAISE EXCEPTION 'the work profile names a membership that is not visible in this context'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF target.group_id IS DISTINCT FROM NEW.group_id THEN
        RAISE EXCEPTION
            'the work profile''s group does not match the membership''s group'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER membership_work_profiles_guard_administration
    BEFORE INSERT OR UPDATE ON membership_work_profiles
    FOR EACH ROW EXECUTE FUNCTION app_guard_work_profile_administration();

/*
 * **History is immutable, and this is the trigger that says so.**
 *
 * The packet's rule: "historical rows are never rewritten (supersede via
 * date-bounded rows); administrative corrections create new rows with an audit
 * trail, never UPDATE history".
 *
 * ## What "history" precisely means, and why the obvious rule was wrong
 *
 * The first version of this guard refused every UPDATE to a row with a non-NULL
 * `effective_to`, on the reasoning that a closed window is history. That is not
 * what a closed window is. Author a change for the 1st of next month and the
 * CURRENT row is immediately bounded — by an instant that has not happened yet.
 * Under the naive rule, scheduling a future change made it impossible to change
 * anything today, and the product's answer to "reduce this person's FTE now"
 * became a 409 with no explanation. The round-trip test found it.
 *
 * History is the part of a window that has ALREADY ELAPSED. So the rule is:
 *
 *   **a window may only ever be SHORTENED, and only into the future.**
 *
 * Which admits exactly three things and refuses everything else:
 *
 *   | | |
 *   |---|---|
 *   | close an open-ended window at an instant ≥ now | ordinary supersession |
 *   | bring a future-bounded window's end FORWARD, to ≥ now | supersession while a change is already scheduled |
 *   | anything else | refused |
 *
 * Refused, explicitly: touching a window that has already ended; moving a start
 * instant; changing a percentage, a maximum, a membership or a group; re-opening
 * a bounded window; extending an end LATER; closing in the past.
 *
 * The column-level UPDATE grant below already keeps the runtime roles to
 * `effective_to` and `updated_at`. This trigger is what binds the TABLE OWNER,
 * which is who a migration or a maintenance script runs as, and it is the control
 * the named test and the red case actually exercise.
 */
CREATE FUNCTION app_guard_work_profile_history() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    at timestamptz := date_trunc('milliseconds', now());
BEGIN
    -- Entirely elapsed: nothing about this window is still in the future, so
    -- every part of it is history.
    IF OLD.effective_to IS NOT NULL AND OLD.effective_to <= at THEN
        RAISE EXCEPTION
            'WORK_PROFILE_HISTORY_IMMUTABLE: a work-profile window that has already ended may '
            'not be updated; record the correction as a new row'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.id                         IS DISTINCT FROM OLD.id
    OR NEW.organization_id            IS DISTINCT FROM OLD.organization_id
    OR NEW.group_id                   IS DISTINCT FROM OLD.group_id
    OR NEW.membership_id              IS DISTINCT FROM OLD.membership_id
    OR NEW.effective_from             IS DISTINCT FROM OLD.effective_from
    OR NEW.work_percentage            IS DISTINCT FROM OLD.work_percentage
    OR NEW.max_assignments_per_week   IS DISTINCT FROM OLD.max_assignments_per_week
    OR NEW.max_assignments_per_period IS DISTINCT FROM OLD.max_assignments_per_period
    OR NEW.max_consecutive_days       IS DISTINCT FROM OLD.max_consecutive_days
    THEN
        RAISE EXCEPTION
            'WORK_PROFILE_HISTORY_IMMUTABLE: the only permitted update to a work profile is '
            'closing its open window; every other change is a new row'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.effective_to IS NULL THEN
        RAISE EXCEPTION
            'WORK_PROFILE_HISTORY_IMMUTABLE: re-opening a work-profile window is not a supersession'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- Shortening only. Extending a window's end is not supersession, and it would
    -- silently reclaim time that a later row may already have been authored to
    -- cover — the EXCLUDE constraint would catch the collision, but only when one
    -- exists, so the intent is stated here rather than left to a side effect.
    IF OLD.effective_to IS NOT NULL AND NEW.effective_to > OLD.effective_to THEN
        RAISE EXCEPTION
            'WORK_PROFILE_HISTORY_IMMUTABLE: a work-profile window may only be shortened, never '
            'extended; author a new row instead'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- Compared against the MILLISECOND-TRUNCATED transaction instant, which is
    -- the same value the writer uses to close a window "now". Comparing against
    -- bare `now()` would reject a close at exactly the current instant up to 999
    -- times in a thousand — a defect at the worst possible frequency, because it
    -- would look like flakiness rather than like a rule.
    IF NEW.effective_to < at THEN
        RAISE EXCEPTION
            'WORK_PROFILE_RETROACTIVE_CLOSE: a work-profile window may not be closed in the past; '
            'record the correction as a new row taking effect from now'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER membership_work_profiles_guard_history
    BEFORE UPDATE ON membership_work_profiles
    FOR EACH ROW EXECUTE FUNCTION app_guard_work_profile_history();

/*
 * **DELETE is refused on the profile tables too, for the OWNER.**
 *
 * The reasoning is the one this migration already states for the qualification
 * tables, and an independent review pointed out that it applies here verbatim and
 * was not implemented: no runtime role holds DELETE, but the runtime is not the
 * only caller a database has. A migration or a maintenance script runs as the
 * OWNER, and "the runtime cannot reach it" is a different claim from "it cannot
 * happen" — which is the whole reason `app_guard_qualification_delete` exists.
 *
 * A work profile is the record of what someone was contracted to work. Deleting
 * one does not correct history, it erases it, and the EXCLUDE constraint means
 * the erasure is invisible afterwards: the remaining windows are still perfectly
 * non-overlapping.
 */
CREATE FUNCTION app_guard_work_profile_delete() RETURNS trigger
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

CREATE TRIGGER membership_work_profiles_guard_delete
    BEFORE DELETE ON membership_work_profiles
    FOR EACH ROW EXECUTE FUNCTION app_guard_work_profile_delete();

/* Weekday targets belong to a profile version, so deleting one silently changes
 * what that version said — the same erasure, one table down. */
CREATE FUNCTION app_guard_weekday_fte_delete() RETURNS trigger
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

CREATE TRIGGER membership_weekday_fte_guard_delete
    BEFORE DELETE ON membership_weekday_fte
    FOR EACH ROW EXECUTE FUNCTION app_guard_weekday_fte_delete();

/* Weekday targets belong to a profile version, so they may not be attached to a
 * window that has already ended — that would be adding facts to history. */
CREATE FUNCTION app_guard_weekday_fte_administration() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    parent membership_work_profiles%ROWTYPE;
BEGIN
    PERFORM app_require_capability('staffing.work_profile.administer', NEW.organization_id);

    SELECT * INTO parent
      FROM membership_work_profiles p
     WHERE p.id = NEW.work_profile_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'the weekday target names a work profile that is not visible in this context'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF parent.group_id IS DISTINCT FROM NEW.group_id THEN
        RAISE EXCEPTION 'the weekday target''s group does not match its work profile''s group'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF parent.effective_to IS NOT NULL AND parent.effective_to <= now() THEN
        RAISE EXCEPTION
            'WORK_PROFILE_HISTORY_IMMUTABLE: weekday targets cannot be added to a window that '
            'has already ended'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER membership_weekday_fte_guard_administration
    BEFORE INSERT OR UPDATE ON membership_weekday_fte
    FOR EACH ROW EXECUTE FUNCTION app_guard_weekday_fte_administration();

CREATE FUNCTION app_guard_qualification_administration() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM app_require_capability('staffing.qualification.administer', NEW.organization_id);
    RETURN NEW;
END;
$$;

CREATE TRIGGER qualifications_guard_administration
    BEFORE INSERT OR UPDATE ON qualifications
    FOR EACH ROW EXECUTE FUNCTION app_guard_qualification_administration();

/* Archive, never delete, "while holdings exist" (06 §3.2) — enforced for the
 * OWNER, because no runtime role can reach a DELETE at all. */
CREATE FUNCTION app_guard_qualification_delete() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM qualification_holdings h WHERE h.qualification_id = OLD.id) THEN
        RAISE EXCEPTION
            'QUALIFICATION_HAS_HOLDINGS: retire the qualification instead of deleting it'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END;
$$;

CREATE TRIGGER qualifications_guard_delete
    BEFORE DELETE ON qualifications
    FOR EACH ROW EXECUTE FUNCTION app_guard_qualification_delete();

/*
 * Holdings: the capability gate, the group binding, and the status machine.
 *
 * `status` transitions are constrained here rather than left to the application,
 * because "an expired credential quietly went back to valid" is a
 * patient-safety-adjacent outcome (PO-DEC-12) and the application is not the only
 * writer a database ever has. `revoked` is terminal.
 */
CREATE FUNCTION app_guard_qualification_holding_administration() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    target memberships%ROWTYPE;
    legal  text[];
BEGIN
    PERFORM app_require_capability('staffing.qualification_holding.administer', NEW.organization_id);

    SELECT * INTO target FROM memberships m WHERE m.id = NEW.membership_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'the holding names a membership that is not visible in this context'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF target.group_id IS DISTINCT FROM NEW.group_id THEN
        RAISE EXCEPTION 'the holding''s group does not match the membership''s group'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF NEW.id               IS DISTINCT FROM OLD.id
        OR NEW.organization_id  IS DISTINCT FROM OLD.organization_id
        OR NEW.group_id         IS DISTINCT FROM OLD.group_id
        OR NEW.membership_id    IS DISTINCT FROM OLD.membership_id
        OR NEW.qualification_id IS DISTINCT FROM OLD.qualification_id
        OR NEW.valid_from       IS DISTINCT FROM OLD.valid_from
        OR NEW.valid_until      IS DISTINCT FROM OLD.valid_until
        OR NEW.evidence_ref     IS DISTINCT FROM OLD.evidence_ref
        THEN
            RAISE EXCEPTION
                'QUALIFICATION_HOLDING_IMMUTABLE: only the status of an issued holding may change; '
                'a correction is a new holding'
                USING ERRCODE = 'restrict_violation';
        END IF;

        legal := CASE OLD.status
            WHEN 'pending'  THEN ARRAY['valid', 'revoked']
            WHEN 'valid'    THEN ARRAY['expiring', 'expired', 'revoked']
            WHEN 'expiring' THEN ARRAY['expired', 'revoked']
            WHEN 'expired'  THEN ARRAY['revoked']
            ELSE ARRAY[]::text[]     -- `revoked` is terminal
        END;
        IF NOT (NEW.status = ANY (legal)) THEN
            RAISE EXCEPTION
                'QUALIFICATION_HOLDING_TRANSITION: % -> % is not a legal transition',
                OLD.status, NEW.status
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER qualification_holdings_guard_administration
    BEFORE INSERT OR UPDATE ON qualification_holdings
    FOR EACH ROW EXECUTE FUNCTION app_guard_qualification_holding_administration();

/* "Retained after expiry for audit" (06 §3.2), enforced for the owner too. */
CREATE FUNCTION app_guard_qualification_holding_delete() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION
        'QUALIFICATION_HOLDING_RETAINED: a qualification holding is retained after expiry for '
        'audit; revoke it instead of deleting it'
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER qualification_holdings_guard_delete
    BEFORE DELETE ON qualification_holdings
    FOR EACH ROW EXECUTE FUNCTION app_guard_qualification_holding_delete();

------------------------------------------------------------------------------
-- Privileges. Column-level UPDATE grants, and DELETE on nothing.
--
-- The pattern is 0002's and the reasoning is the same: a grant is the cheapest
-- control to state and the hardest to bypass, so the columns a role may change
-- are enumerated rather than assumed. Read them as the specification of what an
-- update to each table is ALLOWED to mean:
--
--   membership_work_profiles  `effective_to` only  — supersession, nothing else
--   membership_weekday_fte    none                 — INSERT-only by design
--   qualifications            the descriptive fields and `status` — archive, never delete
--   qualification_holdings    `status` only        — revoke and expire; never re-issue
------------------------------------------------------------------------------

GRANT SELECT, INSERT ON membership_work_profiles, membership_weekday_fte,
                        qualifications, qualification_holdings
    TO app_runtime, app_worker;

GRANT UPDATE (effective_to, updated_at)
    ON membership_work_profiles TO app_runtime, app_worker;

GRANT UPDATE (name, issuing_body, requires_expiry, status, updated_at)
    ON qualifications TO app_runtime, app_worker;

GRANT UPDATE (status, updated_at)
    ON qualification_holdings TO app_runtime, app_worker;

-- The two support roles read, and **they are not the same case**. The first
-- version of this comment said "RLS still narrows what they see" of both, which
-- is false of one of them and the kind of false that matters.
--
--   `app_readonly_support`  is narrowed. It is an ordinary RLS-bound role, and on
--                           `qualification_holdings` it is narrowed to NOTHING:
--                           the SENSITIVE-PII SELECT policies call
--                           `app_acting_membership_holds`, on which this role
--                           holds no EXECUTE, so the read raises 42501 rather
--                           than returning rows. Verified in the SBX-004 sweep,
--                           which records that refusal distinctly.
--
--   `app_breakglass`        **has BYPASSRLS** (0001, SPEC-01 §4.4). No policy in
--                           this migration or any other constrains it, so it
--                           reads across every tenant — including SENSITIVE-PII
--                           credential holdings. That is the declared break-glass
--                           exception working as designed, not an oversight, and
--                           it is pinned by A-08. What it means for THIS table is
--                           recorded in `docs/evidence/EV-M2-PROFILES/INDEX.md`
--                           §5 alongside the M1 residual that break-glass session
--                           auditing (SPEC-11 §3.2) is not yet implemented.
--
-- The grants are present so the (role, table) privilege matrix in
-- `roles-and-schema.test.ts` has an explicit answer for every cell rather than an
-- accidental one.
GRANT SELECT
    ON membership_work_profiles, membership_weekday_fte, qualifications, qualification_holdings
    TO app_readonly_support, app_breakglass;

-- PostgreSQL grants EXECUTE to PUBLIC on every new function, so a GRANT without a
-- REVOKE reads as a restriction and is not one. None of these is callable except
-- through its trigger, and PostgreSQL does not check EXECUTE when a trigger fires
-- its own function — they are revoked anyway rather than relying on that.
REVOKE ALL ON FUNCTION app_guard_work_profile_administration()            FROM PUBLIC;
REVOKE ALL ON FUNCTION app_guard_work_profile_history()                   FROM PUBLIC;
REVOKE ALL ON FUNCTION app_guard_work_profile_delete()                    FROM PUBLIC;
REVOKE ALL ON FUNCTION app_guard_weekday_fte_delete()                     FROM PUBLIC;
REVOKE ALL ON FUNCTION app_guard_weekday_fte_administration()             FROM PUBLIC;
REVOKE ALL ON FUNCTION app_guard_qualification_administration()           FROM PUBLIC;
REVOKE ALL ON FUNCTION app_guard_qualification_delete()                   FROM PUBLIC;
REVOKE ALL ON FUNCTION app_guard_qualification_holding_administration()   FROM PUBLIC;
REVOKE ALL ON FUNCTION app_guard_qualification_holding_delete()           FROM PUBLIC;

-- Down Migration

DROP TRIGGER IF EXISTS qualification_holdings_guard_delete         ON qualification_holdings;
DROP TRIGGER IF EXISTS qualification_holdings_guard_administration ON qualification_holdings;
DROP TRIGGER IF EXISTS qualifications_guard_delete                 ON qualifications;
DROP TRIGGER IF EXISTS qualifications_guard_administration         ON qualifications;
DROP TRIGGER IF EXISTS membership_weekday_fte_guard_delete         ON membership_weekday_fte;
DROP TRIGGER IF EXISTS membership_weekday_fte_guard_administration ON membership_weekday_fte;
DROP TRIGGER IF EXISTS membership_work_profiles_guard_delete       ON membership_work_profiles;
DROP TRIGGER IF EXISTS membership_work_profiles_guard_history      ON membership_work_profiles;
DROP TRIGGER IF EXISTS membership_work_profiles_guard_administration ON membership_work_profiles;

DROP FUNCTION IF EXISTS app_guard_qualification_holding_delete();
DROP FUNCTION IF EXISTS app_guard_qualification_holding_administration();
DROP FUNCTION IF EXISTS app_guard_qualification_delete();
DROP FUNCTION IF EXISTS app_guard_qualification_administration();
DROP FUNCTION IF EXISTS app_guard_weekday_fte_delete();
DROP FUNCTION IF EXISTS app_guard_weekday_fte_administration();
DROP FUNCTION IF EXISTS app_guard_work_profile_delete();
DROP FUNCTION IF EXISTS app_guard_work_profile_history();
DROP FUNCTION IF EXISTS app_guard_work_profile_administration();

DROP POLICY IF EXISTS qualification_holdings_group_administration ON qualification_holdings;
DROP POLICY IF EXISTS qualification_holdings_group_read_any       ON qualification_holdings;
DROP POLICY IF EXISTS qualification_holdings_own                  ON qualification_holdings;
DROP POLICY IF EXISTS qualifications_organization_scope           ON qualifications;
DROP POLICY IF EXISTS qualifications_group_scope                  ON qualifications;
DROP POLICY IF EXISTS membership_weekday_fte_organization_scope   ON membership_weekday_fte;
DROP POLICY IF EXISTS membership_weekday_fte_group_scope          ON membership_weekday_fte;
DROP POLICY IF EXISTS membership_work_profiles_organization_scope ON membership_work_profiles;
DROP POLICY IF EXISTS membership_work_profiles_group_scope        ON membership_work_profiles;

DROP INDEX IF EXISTS qualification_holdings_by_group;
DROP INDEX IF EXISTS qualification_holdings_lookup;
DROP INDEX IF EXISTS qualifications_lookup;
DROP INDEX IF EXISTS membership_weekday_fte_lookup;
DROP INDEX IF EXISTS membership_work_profiles_lookup;

-- Order matters: holdings reference qualifications, weekday targets reference
-- profiles. `DROP TABLE` fires no BEFORE DELETE trigger, so the retention guards
-- above do not block the down migration — which is the intended behaviour and is
-- stated in the packet's rollback note: **the down migration destroys
-- SENSITIVE-PII holding rows.** That is acceptable in development, where the only
-- rows are synthetic, and it is why a production rollback would follow SPEC-10's
-- expand/contract rules instead of this file.
DROP TABLE IF EXISTS qualification_holdings;
DROP TABLE IF EXISTS qualifications;
DROP TABLE IF EXISTS membership_weekday_fte;
DROP TABLE IF EXISTS membership_work_profiles;
