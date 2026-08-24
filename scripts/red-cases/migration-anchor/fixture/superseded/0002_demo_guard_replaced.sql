-- Fixture. The supersession: the whole body restated, the rule inside it
-- included, exactly as migration 0020 restated 0018's guard.

CREATE OR REPLACE FUNCTION app_fixture_guard_demo() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_blocking integer;
BEGIN
    SELECT count(*) INTO v_blocking FROM app_fixture_findings WHERE unresolved;

    IF v_blocking > 0 THEN
        RAISE EXCEPTION 'FIXTURE_BLOCKED: % unresolved finding(s)', v_blocking
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

-- Down Migration
-- A line outside every function body, for the F2 exemption probe.
