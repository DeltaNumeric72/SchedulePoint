-- Fixture, not a migration. Two dollar-quote spellings the first parser got
-- wrong (R-8 F1), both redefined one file later.

-- (i) A TAGGED body that legitimately contains `$$`. The old parser opened the
-- span on the nested `$$` and closed it on the nested `$$`, so everything below
-- the nested quote — the rule under test included — read as OUTSIDE the body.
CREATE FUNCTION app_fixture_tagged_demo() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
    v_blocking integer;
BEGIN
    EXECUTE $$SELECT 1$$;

    SELECT count(*) INTO v_blocking FROM app_fixture_findings WHERE unresolved;

    IF v_blocking > 0 THEN
        RAISE EXCEPTION 'FIXTURE_BLOCKED: % unresolved finding(s)', v_blocking
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$fn$;

-- (ii) The shape 0019_build_concurrency_capacity.sql actually uses. Safe under
-- the old parser only because that file happens to contain no `$$` at all.
CREATE FUNCTION app_fixture_capacity_demo() RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $sp_fixture_capacity$
BEGIN
    RETURN 1;
END;
$sp_fixture_capacity$;
