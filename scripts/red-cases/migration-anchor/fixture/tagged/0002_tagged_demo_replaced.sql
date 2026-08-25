-- Fixture. The supersession of (i): the body restated whole, rule included.

CREATE OR REPLACE FUNCTION app_fixture_tagged_demo() RETURNS trigger
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
