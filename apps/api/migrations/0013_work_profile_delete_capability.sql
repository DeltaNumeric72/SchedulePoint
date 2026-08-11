-- OPUS-M4-000A review condition C1 (independent review finding F-1, MEDIUM).
--
-- ## What the review found
--
-- Migration 0012 §5 narrowed the two work-profile DELETE guards so that a
-- STRICTLY-FUTURE window may be cancelled, and granted `app_runtime` DELETE on
-- `membership_work_profiles` and `membership_weekday_fte` to carry it. Both
-- narrowed guard bodies check FUTURENESS and nothing else.
--
-- The HTTP path is gated — `POST …/work-profiles/:id/cancel` carries
-- `AUTHOR_WORK_PROFILE_CONFIG`, whose `action.key` is
-- `staffing.work_profile.administer` (CAP-013), evaluated at SPEC-06 L4 inside
-- the transaction before `cancelFutureWorkProfile` issues a statement. But the
-- DATABASE admitted the same DELETE from any `app_runtime` principal holding no
-- staffing capability at all, because the guard never asked. Every sibling
-- statement class on these tables IS capability-gated at the database:
-- `app_guard_work_profile_administration` (0004) calls
-- `app_require_capability('staffing.work_profile.administer', …)` on INSERT and
-- UPDATE, and 0012's own two new DELETE guards on the demand tables call
-- `app_require_capability` in exactly this shape. DELETE on the work-profile
-- tables was the one widened grant whose guard did not.
--
-- That asymmetry is what this migration closes: defence in depth, in the layer
-- 0004 already chose for this table.
--
-- ## The token, and why it is this one
--
-- `staffing.work_profile.administer` — the SAME capability the service layer
-- checks for this operation (`AUTHOR_WORK_PROFILE_CONFIG.action.key`, the
-- config the cancel route declares), spelled per the database convention that
-- 0004 established for these two tables. No capability is created, widened or
-- narrowed here (non-bypass rule 11): the token already exists in
-- `STAFFING_CAPABILITIES`, is already grant-only, and is already what 0004
-- requires to WRITE these rows.
--
-- ## Ordering inside each guard: retention first, capability second
--
-- The retention rule is ABSOLUTE and capability-independent — a window whose
-- time has begun is never deleted, by anybody, including the OWNER, and 0012's
-- proof of that (`staffing-integrity-red-cases.test.ts`, the in-force arm
-- asserted for the runtime AND for the owner) is exactly the demonstration that
-- must not be lost. Asking the capability question first would replace that
-- observable `restrict_violation` with `insufficient_privilege` for every
-- context that holds no grant, and the retention guard would no longer be
-- observable for the owner at all — a weaker proof of a rule 0012 states in the
-- strongest terms.
--
-- So each guard answers in this order:
--
--   1. is this row in force or elapsed?  → WORK_PROFILE_RETAINED / 23001,
--                                          for every principal, unchanged.
--   2. is this a cancellation the acting membership may perform?
--                                       → 42501 (`insufficient_privilege`)
--                                          from `app_require_capability`.
--
-- The capability gate therefore governs exactly the one operation that is
-- admissible at all: cancelling a window that has not begun.
--
-- ## Discipline
--
-- ADDITIVE. No table is created (the migration+RLS pairing gate has nothing to
-- pair, as in 0011), no policy is created or dropped, RLS is untouched, no
-- grant is widened or revoked, no constraint is relaxed, and no stable ID is
-- removed or renumbered. The only change is two `CREATE OR REPLACE FUNCTION`
-- statements over 0012's bodies — the 0011/0012 precedent — and the Down
-- migration restores 0012's bodies VERBATIM.
--
-- Normative sources:
--   migration 0004               — the capability-gate pattern on these tables
--   migration 0012 §5            — the bodies this narrows, and its own
--                                  `app_require_capability` DELETE guards
--   migration 0011               — the CREATE OR REPLACE / restore-verbatim
--                                  precedent
--   apps/api/src/http/routes/profiles.route.ts
--                                — `AUTHOR_WORK_PROFILE_CONFIG`, the service
--                                  layer's own answer for this operation
--   SPEC-06 L4                   — the capability layer `app_require_capability`
--                                  implements at the database

-- Up Migration

------------------------------------------------------------------------------
-- 1. membership_work_profiles — the parent guard.
------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_guard_work_profile_delete() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF OLD.effective_from <= date_trunc('milliseconds', now()) THEN
        RAISE EXCEPTION
            'WORK_PROFILE_RETAINED: a work-profile window whose time has begun is the record of '
            'a working arrangement and is never deleted; supersede it instead. Only a '
            'strictly-future window may be cancelled'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- F-1, the parent half: cancelling a strictly-future window is a WRITE on
    -- this table and is gated like every other write on it (0004).
    PERFORM app_require_capability('staffing.work_profile.administer', OLD.organization_id);
    RETURN OLD;
END;
$$;

------------------------------------------------------------------------------
-- 2. membership_weekday_fte — the child guard.
--
-- The parent's window still decides what "future" means, so the two guards
-- cannot disagree; the capability question is the same question, asked of the
-- child's own tenant column.
------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_guard_weekday_fte_delete() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_from timestamptz;
BEGIN
    SELECT p.effective_from INTO v_from
      FROM membership_work_profiles p
     WHERE p.id = OLD.work_profile_id;
    IF NOT FOUND OR v_from <= date_trunc('milliseconds', now()) THEN
        RAISE EXCEPTION
            'WEEKDAY_TARGET_RETAINED: a weekday target belongs to a work-profile version and is '
            'removed only when a strictly-future version is cancelled'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- F-1, the child half: the same gate, on the child's own tenant column.
    PERFORM app_require_capability('staffing.work_profile.administer', OLD.organization_id);
    RETURN OLD;
END;
$$;

-- Down Migration

-- 0012's bodies, restored VERBATIM (the 0011 precedent). Nothing else in 0012
-- §5 is touched by this migration, so nothing else needs restoring: the DELETE
-- grants, the triggers and the trigger attachments are 0012's and stay 0012's.

CREATE OR REPLACE FUNCTION app_guard_work_profile_delete() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF OLD.effective_from <= date_trunc('milliseconds', now()) THEN
        RAISE EXCEPTION
            'WORK_PROFILE_RETAINED: a work-profile window whose time has begun is the record of '
            'a working arrangement and is never deleted; supersede it instead. Only a '
            'strictly-future window may be cancelled'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION app_guard_weekday_fte_delete() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_from timestamptz;
BEGIN
    SELECT p.effective_from INTO v_from
      FROM membership_work_profiles p
     WHERE p.id = OLD.work_profile_id;
    IF NOT FOUND OR v_from <= date_trunc('milliseconds', now()) THEN
        RAISE EXCEPTION
            'WEEKDAY_TARGET_RETAINED: a weekday target belongs to a work-profile version and is '
            'removed only when a strictly-future version is cancelled'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END;
$$;
