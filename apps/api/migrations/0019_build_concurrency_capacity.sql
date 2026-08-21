-- OPUS-M4-005 — D-4b's per-organization concurrency cap: the capacity read.
--
-- ADDITIVE. 0001..0018 are applied and are never edited. This file creates ONE
-- policy and ONE function. It creates no table, revokes no grant, relaxes no
-- constraint, replaces no policy, and removes or renumbers no stable ID.
--
-- ## Why this migration exists at all
--
-- doc 35 §6g allocates `0019_*` "ONLY IF D-4b's per-organization concurrency cap
-- genuinely needs a schema surface". It does, and the need is precise rather
-- than a matter of taste:
--
-- SPEC-04 §6 D-4b bounds concurrency **per organization**. `build_runs` is
-- GROUP-scoped under RLS (0018 `build_runs_group_scope`: organization AND
-- group), so a unit of work opened for one group can see that group's in-flight
-- builds and no others. A cap computed from that read is not a per-organization
-- cap — it is a per-group cap wearing the wrong name, and an organization with
-- five groups would run five times the limit while every test still passed.
--
-- The cap value itself needs no schema: it is a **resource-isolation** parameter,
-- which SPEC-04 §1.1 lists beside "CPU and memory limits per solve" — deployment
-- configuration, not tenant data. What needs schema is the ability to COUNT
-- across the caller's own groups. Hence a policy and a counter, and no table.
--
-- ## Why a policy AND a SECURITY DEFINER function, and not either alone
--
-- 0003's audit-chain note records the property that makes this the only workable
-- shape: **`FORCE ROW LEVEL SECURITY` binds the table owner too**, so a
-- `SECURITY DEFINER` function is not a bypass — it still meets whatever policies
-- exist. The reach therefore has to be a policy that is written down and
-- reviewable, exactly as `audit_chain_heads_maintenance_read` is, rather than a
-- privilege nobody can see.
--
-- ## This is NOT a cross-tenant read
--
-- `audit_chain_heads_maintenance_read` is the system's one cross-tenant read and
-- it stays that way. The policy below is narrower in every dimension:
--
--   * `FOR SELECT` only, `TO app_migrator` only — `app_runtime`, `app_worker`,
--     `app_readonly_support` and `app_breakglass` are all excluded and gain
--     nothing directly;
--   * it is pinned to `current_setting('app.organization_id')`, the
--     transaction-local tenant tuple the unit of work established and the server
--     verified (I-14/I-15). It admits the CALLER'S OWN organization and no
--     other, so it crosses a GROUP boundary and never a tenant one;
--   * `app_migrator` owns these tables and could drop RLS outright. Making the
--     reach explicit is the point — the alternative is a bypass with no record.
--
-- ## The context guard is mandatory, and 0003's R-05 says why
--
-- `app_verify_audit_chain` needed a guard because a `SECURITY DEFINER` function
-- reading a foreign organization id "would read as a clean chain". The same trap
-- is here in a worse form: with the policy above, a foreign `p_organization_id`
-- matches no row and the count returns **0** — which is not an error, it is a
-- confident statement that the tenant has no builds running, and it would
-- silently disable the cap for whoever asked. So the function refuses when its
-- argument is not the caller's own established organization. A refusal is a
-- fact; a zero is a lie that looks like one.
--
-- ## Privacy
--
-- The function returns an INTEGER. No identifier, no name, no timestamp, no
-- group attribution, nothing an actor could not already have counted inside its
-- own group. I-07 has nothing to object to.
--
-- Normative sources:
--   doc 35 §6g       — the packet; ruling (2) binds the cap to the queue
--   SPEC-04 §1.1/§6  — resource isolation; D-4b
--   FAD-14           — the sanctioned maintenance-plane read pattern
--   migration 0003   — the policy-not-bypass discipline and the R-05 guard
--   migration 0018   — `build_runs`, its group-scoped policy, and the states

-- Up Migration

------------------------------------------------------------------------------
-- 1. The capacity read
------------------------------------------------------------------------------

CREATE POLICY build_runs_organization_capacity_read ON build_runs
    FOR SELECT TO app_migrator
    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

------------------------------------------------------------------------------
-- 2. The counter
--
-- `running` alone, deliberately. D-4b bounds what is CONSUMING a solver slot,
-- and a build that is `queued` consumes nothing — it is the thing waiting for a
-- slot. Counting the queued ones too would make a saturated organization
-- permanently saturated by its own backlog, which is a deadlock rather than a
-- cap.
------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_build_running_count(p_organization_id uuid)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $sp_build_capacity$
DECLARE
    v_context uuid;
    v_count   integer;
BEGIN
    v_context := nullif(current_setting('app.organization_id', true), '')::uuid;

    IF v_context IS NULL OR v_context <> p_organization_id THEN
        RAISE EXCEPTION
            'BUILD_CAPACITY_CONTEXT_MISMATCH: the capacity counter answers only for the '
            'organization whose tenant context is in force; asking about another one returns '
            'no rows, which would read as "nothing is running" (migration 0003 R-05)'
            USING ERRCODE = 'restrict_violation';
    END IF;

    SELECT count(*) INTO v_count
      FROM build_runs
     WHERE organization_id = p_organization_id
       AND state = 'running';

    RETURN v_count;
END
$sp_build_capacity$;

REVOKE ALL ON FUNCTION app_build_running_count(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_build_running_count(uuid) TO app_runtime, app_worker;

-- Down Migration

DROP FUNCTION IF EXISTS app_build_running_count(uuid);
DROP POLICY IF EXISTS build_runs_organization_capacity_read ON build_runs;
