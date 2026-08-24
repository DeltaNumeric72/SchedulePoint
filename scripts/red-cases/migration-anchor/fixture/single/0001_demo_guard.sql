-- Fixture, not a migration. Never applied to any database; the RLS gate scans
-- apps/api/migrations only. It exists so migration-anchor/check.mjs can assert
-- the SUPERSEDED direction on a function that is redefined one file later.

CREATE FUNCTION app_fixture_guard_demo() RETURNS trigger
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

-- Written AFTER the function on purpose: a trigger must not be read as part of
-- the function body above, and the body span is what decides that.
CREATE TRIGGER app_fixture_demo_guard
    BEFORE UPDATE ON app_fixture_rows
    FOR EACH ROW EXECUTE FUNCTION app_fixture_guard_demo();
