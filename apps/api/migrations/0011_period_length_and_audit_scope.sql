-- OPUS-M3-008 — integration and hardening. Exactly two changes, both
-- pre-approved by packet 32 §10f and nothing else:
--
--   1. `schedule_periods_length` — the DATABASE half of the 366-day period bound
--      that OPUS-M3-004's review (fold-in N-4) added to the CONTRACT only. A
--      bound enforced in one layer is a bound a second writer does not have.
--
--   2. `app_verify_audit_chain` gains an explicit GROUP-SCOPE refusal — the
--      M3-003 review's N-8 false alarm. The audit module is frozen to every M3
--      packet except this one, and this one is unfrozen for exactly this fix and
--      the read surface (packet 32 §10f).
--
-- NO NEW TABLE. The migration+RLS pairing gate has nothing to pair here, and
-- that is correct rather than an omission: `CREATE TABLE` is what the gate keys
-- on, and this migration creates none. No policy is dropped, no constraint
-- relaxed, no grant widened. 0001..0010 are applied and are never edited.
--
-- Normative sources:
--   packages/contracts/src/schedule/authoring.ts `MAX_PERIOD_DAYS`
--                                  — the 366-day contract bound this mirrors
--   SPEC-11 §2                     — chain verification and its scope
--   apps/api/src/audit/verification.ts
--                                  — the TypeScript wrapper that already refuses
--                                    a group-scoped call; this closes the
--                                    function's own door
--   06 §1                          — CHECK constraints are the database's half of
--                                    a bound the application also states

-- Up Migration

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. schedule_periods_length — the 366-day bound, at the database
--
-- `end_date >= start_date` already exists (`schedule_periods_dates`); this adds
-- the upper bound. 366 is one year including a leap day — the number is a
-- product bound recorded in the contract, and the two are asserted equal by
-- `apps/api/test/schedule/period-length.test.ts` so they cannot drift.
--
-- Inclusive on both ends, matching `schedule_periods_no_overlap`'s `'[]'`
-- daterange: `end_date` is the period's LAST INCLUDED day, so a period from the
-- 1st to the 1st is one day long, not zero.
--
-- NOT VALID is deliberately NOT used. Every existing row is synthetic fixture
-- data well inside the bound, and a NOT VALID constraint would leave a
-- retrospective hole that nothing ever closes — the class of "temporarily
-- disabled control" this repository treats as a defect.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE schedule_periods
    ADD CONSTRAINT schedule_periods_length
    CHECK (end_date - start_date <= 365);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. app_verify_audit_chain — refuse a GROUP-scoped invocation explicitly
--
-- ## The false alarm this closes (M3-003 independent review, N-8)
--
-- `audit_events` carries a group-scoped RLS predicate: under a context that
-- declares `app.group_id`, a SELECT sees only that group's rows. The walk below
-- is `ORDER BY sequence` over whatever it can see, and `sequence` is gapless
-- across the ORGANIZATION — so a group-scoped call walks a SUBSET and reports
-- `sequence_gap` at every row belonging to a sibling group.
--
-- Those gaps are not there. Reporting them is worse than useless: it is the
-- textbook way to train an operator to ignore the one report that matters.
--
-- `apps/api/src/audit/verification.ts` already refuses the wrong scope before
-- calling, and did from the start. What it could not do is speak for anyone who
-- calls the FUNCTION — a psql session during an incident, a future module, a
-- test. The guard belongs where the read happens, which is here.
--
-- ## Refusing rather than reading past the group predicate
--
-- The other available fix is to make the function group-blind — it is
-- `SECURITY DEFINER`, so widening its reach is mechanically possible. It is
-- rejected: `audit_events` is FORCE-RLS precisely so that no code path reads
-- another group's audit rows, and quietly exempting a function that any
-- group-scoped session may execute would be a hole punched in a tenant control
-- to improve an error message. SPEC-11 §2's verification job runs
-- organization-scoped by design (`apps/api/src/audit/periodic.ts`), so nothing
-- legitimate loses reach.
--
-- The refusal reuses `restrict_violation`, the SQLSTATE the existing
-- foreign-organization guard directly above it already raises, so a caller
-- handles one class rather than two.
--
-- Everything else in this function is BYTE-IDENTICAL to 0003's. Only the
-- DECLARE list gains `v_session_group` and the block gains the guard below.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION app_verify_audit_chain(p_organization_id uuid)
RETURNS TABLE (sequence bigint, problem text, expected bytea, actual bytea)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    r               record;
    v_expected_seq  bigint := 1;
    v_prev_hash     bytea;
    v_recomputed    bytea;
    v_session_org   uuid;
    v_session_group text;
    v_chain_max     bigint;
    v_chain_hash    bytea;
    v_head_seq      bigint;
    v_head_hash     bytea;
BEGIN
    -- R-05. The reads below are RLS-confined to the SESSION's organization, so a
    -- foreign id would walk nothing and report a clean chain. Refusing is the
    -- only honest answer; "no problems found" for an organization this session
    -- cannot see is a lie an incident responder would act on.
    v_session_org := nullif(current_setting('app.organization_id', true), '')::uuid;
    IF v_session_org IS NULL OR v_session_org <> p_organization_id THEN
        RAISE EXCEPTION
            'audit chain verification is confined to the session tenant: asked for %, '
            'session context is %', p_organization_id, coalesce(v_session_org::text, '(none)')
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- N-8 (OPUS-M3-008). A group-scoped context sees a SUBSET of the chain, and
    -- the walk would report a `sequence_gap` at every sibling group's row. The
    -- chain is per ORGANIZATION; a group-scoped verification is a question this
    -- function cannot answer, so it says so instead of answering it wrongly.
    v_session_group := nullif(current_setting('app.group_id', true), '');
    IF v_session_group IS NOT NULL THEN
        RAISE EXCEPTION
            'audit chain verification requires an organization-scoped context: this session '
            'declares group %. A group-scoped read sees a subset of the chain and would report '
            'gaps that are not there.', v_session_group
            USING ERRCODE = 'restrict_violation';
    END IF;

    v_prev_hash := sha256(convert_to('sp.audit.genesis.v1:' || p_organization_id::text, 'UTF8'));

    FOR r IN
        SELECT * FROM audit_events e
         WHERE e.organization_id = p_organization_id
         ORDER BY e.sequence
    LOOP
        IF r.sequence <> v_expected_seq THEN
            sequence := r.sequence; problem := 'sequence_gap';
            expected := NULL; actual := NULL;
            RETURN NEXT;
            -- Resynchronise so one gap does not report every later row as broken.
            v_expected_seq := r.sequence;
        END IF;

        IF r.prev_hash IS DISTINCT FROM v_prev_hash THEN
            sequence := r.sequence; problem := 'prev_hash_mismatch';
            expected := v_prev_hash; actual := r.prev_hash;
            RETURN NEXT;
        END IF;

        -- The row's OWN prev_hash, not the expected one. "Is this row internally
        -- consistent?" and "does it follow the row before it?" are different
        -- questions, and collapsing them would report one tampered row as two
        -- problems and a reordered pair as none.
        v_recomputed := sha256(app_audit_canonical_bytes(
            r.organization_id, r.prev_hash, r.sequence, r.id, r.occurred_at,
            r.event_name, r.actor_kind, r.actor_membership_id, r.group_id,
            r.subject_type, r.subject_id, r.correlation_id, r.payload));

        IF r.entry_hash IS DISTINCT FROM v_recomputed THEN
            sequence := r.sequence; problem := 'entry_hash_mismatch';
            expected := v_recomputed; actual := r.entry_hash;
            RETURN NEXT;
        END IF;

        -- Continue from what the row CLAIMS, not from what it should have been,
        -- so a single altered row reports one break rather than every row after
        -- it. X-02 (a consistently rewritten segment) is caught by the
        -- checkpoint signature instead, which is exactly the division of labour
        -- SPEC-11 §2 describes.
        v_prev_hash    := r.entry_hash;
        v_expected_seq := r.sequence + 1;
        v_chain_max    := r.sequence;
        v_chain_hash   := r.entry_hash;
    END LOOP;

    /* ── the tail, which the walk above cannot see (R-01) ─────────────────── */

    SELECT h.sequence, h.entry_hash INTO v_head_seq, v_head_hash
      FROM audit_chain_heads h
     WHERE h.organization_id = p_organization_id;

    IF v_head_seq IS NULL THEN
        -- No head row. Benign only when the organization has never recorded an
        -- audit event; otherwise the row that would have exposed a truncation
        -- has itself been removed, and that is the finding.
        IF v_chain_max IS NOT NULL THEN
            sequence := v_chain_max; problem := 'chain_head_missing';
            expected := NULL; actual := v_chain_hash;
            RETURN NEXT;
        END IF;
    ELSIF v_head_seq <> coalesce(v_chain_max, 0) THEN
        -- `sequence` is the FIRST MISSING one, matching `sequence_gap`'s
        -- convention, so an operator reads both problems the same way.
        -- `expected` is what the head says the tip hash is; `actual` is the hash
        -- the chain actually ends on, or NULL when nothing is left.
        sequence := coalesce(v_chain_max, 0) + 1;
        problem  := 'head_sequence_ahead_of_chain';
        expected := v_head_hash; actual := v_chain_hash;
        RETURN NEXT;
    END IF;

    RETURN;
END;
$$;

-- `CREATE OR REPLACE` preserves the object's grants, so 0003's
-- `REVOKE ALL … FROM PUBLIC` and its narrow `GRANT EXECUTE` still stand. Both
-- are re-stated rather than assumed: a grant that survives by convention is a
-- grant nobody checks.
REVOKE ALL ON FUNCTION app_verify_audit_chain(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_verify_audit_chain(uuid)
    TO app_runtime, app_worker, app_readonly_support, app_breakglass;

-- Down Migration

-- The 366-day bound comes off cleanly.
ALTER TABLE schedule_periods DROP CONSTRAINT IF EXISTS schedule_periods_length;

-- The function is RESTORED to 0003's body, not dropped: dropping it would take
-- `apps/api/src/audit/verification.ts` and the SPEC-11 §2 periodic job with it,
-- and a down migration that disables audit verification is a worse outcome than
-- the false alarm this migration fixed. The body below is 0003's, verbatim.
CREATE OR REPLACE FUNCTION app_verify_audit_chain(p_organization_id uuid)
RETURNS TABLE (sequence bigint, problem text, expected bytea, actual bytea)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    r              record;
    v_expected_seq bigint := 1;
    v_prev_hash    bytea;
    v_recomputed   bytea;
    v_session_org  uuid;
    v_chain_max    bigint;
    v_chain_hash   bytea;
    v_head_seq     bigint;
    v_head_hash    bytea;
BEGIN
    v_session_org := nullif(current_setting('app.organization_id', true), '')::uuid;
    IF v_session_org IS NULL OR v_session_org <> p_organization_id THEN
        RAISE EXCEPTION
            'audit chain verification is confined to the session tenant: asked for %, '
            'session context is %', p_organization_id, coalesce(v_session_org::text, '(none)')
            USING ERRCODE = 'restrict_violation';
    END IF;

    v_prev_hash := sha256(convert_to('sp.audit.genesis.v1:' || p_organization_id::text, 'UTF8'));

    FOR r IN
        SELECT * FROM audit_events e
         WHERE e.organization_id = p_organization_id
         ORDER BY e.sequence
    LOOP
        IF r.sequence <> v_expected_seq THEN
            sequence := r.sequence; problem := 'sequence_gap';
            expected := NULL; actual := NULL;
            RETURN NEXT;
            v_expected_seq := r.sequence;
        END IF;

        IF r.prev_hash IS DISTINCT FROM v_prev_hash THEN
            sequence := r.sequence; problem := 'prev_hash_mismatch';
            expected := v_prev_hash; actual := r.prev_hash;
            RETURN NEXT;
        END IF;

        v_recomputed := sha256(app_audit_canonical_bytes(
            r.organization_id, r.prev_hash, r.sequence, r.id, r.occurred_at,
            r.event_name, r.actor_kind, r.actor_membership_id, r.group_id,
            r.subject_type, r.subject_id, r.correlation_id, r.payload));

        IF r.entry_hash IS DISTINCT FROM v_recomputed THEN
            sequence := r.sequence; problem := 'entry_hash_mismatch';
            expected := v_recomputed; actual := r.entry_hash;
            RETURN NEXT;
        END IF;

        v_prev_hash    := r.entry_hash;
        v_expected_seq := r.sequence + 1;
        v_chain_max    := r.sequence;
        v_chain_hash   := r.entry_hash;
    END LOOP;

    SELECT h.sequence, h.entry_hash INTO v_head_seq, v_head_hash
      FROM audit_chain_heads h
     WHERE h.organization_id = p_organization_id;

    IF v_head_seq IS NULL THEN
        IF v_chain_max IS NOT NULL THEN
            sequence := v_chain_max; problem := 'chain_head_missing';
            expected := NULL; actual := v_chain_hash;
            RETURN NEXT;
        END IF;
    ELSIF v_head_seq <> coalesce(v_chain_max, 0) THEN
        sequence := coalesce(v_chain_max, 0) + 1;
        problem  := 'head_sequence_ahead_of_chain';
        expected := v_head_hash; actual := v_chain_hash;
        RETURN NEXT;
    END IF;

    RETURN;
END;
$$;

REVOKE ALL ON FUNCTION app_verify_audit_chain(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_verify_audit_chain(uuid)
    TO app_runtime, app_worker, app_readonly_support, app_breakglass;
