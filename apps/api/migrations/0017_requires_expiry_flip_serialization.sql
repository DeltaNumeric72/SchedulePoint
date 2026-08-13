-- OPUS-M4-001S — write-time serialization of the `requires_expiry` flip against
-- an in-flight grant (doc 35 §6c; FAD-36(2); review finding R-1, NR-17).
--
-- ADDITIVE in the migration-file sense: 0001..0016 are applied and are never
-- edited. This file creates NO table, NO policy, NO grant and NO index. It
-- replaces the bodies of exactly two existing guard functions with `CREATE OR
-- REPLACE`, and the down migration restores 0012's bodies VERBATIM — the 0011
-- precedent, which 0012 §5 itself followed.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. The defect, exactly
-- ═══════════════════════════════════════════════════════════════════════════
--
-- FAD-28 R5 is a SEQUENTIAL rule: `requires_expiry` may not be switched ON while
-- open-ended live holdings exist, and 0012 §3b's trigger refuses that with
-- 23001. Under READ COMMITTED the rule was bypassable by two CONCURRENT
-- transactions, and the M4-001R independent review reproduced it (probe D3):
--
--     T_grant : INSERT an open-ended holding of qualification Q ......... open
--     T_flip  : UPDATE Q SET requires_expiry = true ................ COMMITS ✓
--     T_grant : ..................................................... COMMITS ✓
--
--     final state: Q.requires_expiry = true  AND  one open-ended live holding
--
-- That is precisely the state the sequential trigger refuses. Nothing refused
-- it here because neither side could SEE the other: the flip's `EXISTS` ran
-- under a snapshot that predates the holding's commit, and the holding guard's
-- lookup ran under a snapshot that predates the flip's commit.
--
-- **Unlike the retirement race (FAD-28(2)/FAD-35) there is no read-side
-- backstop.** `requires_expiry` is not an input to the shared eligibility
-- verdict, so a race-admitted open-ended holding reads `satisfied` for ever, on
-- every consumer including canonical solver input. FAD-36(2) therefore ruled
-- that the bounded fix here is DATABASE-LEVEL WRITE-TIME SERIALIZATION: adding a
-- verdict dimension would change the frozen eligibility module and FAD-23
-- semantics.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 2. The mechanism: one lock object, two conflicting modes
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The two writers already touch one row in common — the `qualifications` row
-- itself — so no new lock object is introduced. What changes is the MODE each
-- side takes on it, and WHEN.
--
--   holding side   `app_guard_holding_expiry_retirement` takes **FOR KEY SHARE**
--                  on the qualification row, and takes it as part of the same
--                  lookup that reads `requires_expiry`.
--
--   flip side      `app_guard_requires_expiry_flip` takes **FOR UPDATE** on the
--                  row being flipped, before its `EXISTS` over the holdings.
--
-- `FOR UPDATE` (Exclusive) CONFLICTS with `FOR KEY SHARE`, so the two can never
-- be inside their respective checks at the same time. Both interleavings are
-- then refused, and each is refused by the guard that already owns the rule:
--
--   grant first    T_grant holds KEY SHARE from its guard until it commits.
--                  T_flip blocks at its `FOR UPDATE`. When T_grant commits,
--                  T_flip's next statement — a NEW statement, therefore a NEW
--                  READ COMMITTED snapshot — sees the committed open-ended
--                  holding and raises QUALIFICATION_REQUIRES_EXPIRY_CONFLICT.
--
--   flip first     T_flip holds FOR UPDATE. T_grant blocks INSIDE its guard,
--                  before it has read `requires_expiry`. When T_flip commits,
--                  T_grant's locking read follows the update chain (READ
--                  COMMITTED re-evaluation) and returns the LATEST committed
--                  row — `requires_expiry = true` — so the existing
--                  QUALIFICATION_REQUIRES_EXPIRY arm raises 23001 on the grant.
--
-- The invariant either way: **no committed state has `requires_expiry = true`
-- together with an open-ended live holding.**
--
-- ### Why the holding side reads WITH the lock rather than locking separately
--
-- A separate `PERFORM … FOR KEY SHARE` followed by the old unlocked `SELECT`
-- would still read the pre-flip value out of the transaction's snapshot: the
-- lock would be held and the answer would still be stale. Locking IN the lookup
-- is what makes the value current, because a locking read that waits re-checks
-- the row it finally locks (READ COMMITTED EvalPlanQual). One clause, and it is
-- the clause that carries the correctness.
--
-- ### Why the retirement race is NOT affected — deliberately
--
-- FAD-28(2)/FAD-35 make the granted-while-retiring interleaving AUTHORITATIVE:
-- it is admitted at write time and made harmless by the verdict's lifecycle-first
-- `retired` outcome, and `granted-while-retiring-inertness.test.ts` pins it.
-- Nothing here may close it by accident.
--
-- It is not closed, and the reason is mechanical rather than lucky. A retirement
-- is `UPDATE qualifications SET status = …`, which touches no key column, so it
-- holds FOR NO KEY UPDATE — which does **not** conflict with FOR KEY SHARE. The
-- grant's new locking read therefore does not wait, does not re-evaluate, and
-- reads `active` exactly as before. The flip guard's FOR UPDATE is taken ONLY on
-- the `false → true` transition of `requires_expiry`, so a retirement never takes
-- it either. The escalation is confined to the one transition that needs it.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Lock-ordering analysis against the 0003 per-organization audit lock
--    (doc 35 §6c: MANDATORY)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Migration 0003's `app_audit_assign_chain` takes
-- `pg_advisory_xact_lock(hashtext('schedulepoint.audit'),
-- hashtext(organization_id))` on every audit insert and holds it to commit. It
-- is therefore a lock that almost every writing transaction ends up holding, and
-- any second lock acquired around it has to be ordered against it.
--
-- **The rule this migration relies on, and does not change:**
--
--     the `qualifications` ROW LOCK is acquired BEFORE the per-organization
--     AUDIT ADVISORY LOCK, in every shipped writer.
--
-- It holds by construction, statement by statement:
--
--   `grantHolding`            INSERT qualification_holdings   → KEY SHARE on the
--                             qualification row (this guard, and the composite
--                             FK immediately after, in the SAME statement)
--                             THEN `recordAuditEvent`         → audit lock
--   `changeHoldingStatus`     UPDATE qualification_holdings   → KEY SHARE
--                             THEN `recordAuditEvent`         → audit lock
--   `setQualificationStatus`  UPDATE qualifications           → FOR NO KEY UPDATE
--                             THEN `recordAuditEvent`         → audit lock
--   the flip                  has NO service path at all (0012 §3b); the UPDATE
--                             grant includes the column, so the guard is where
--                             the door is closed. A future service that flips
--                             must write its audit row AFTER the UPDATE, like
--                             every one of its siblings.
--
-- Both acquisitions this migration adds land INSIDE the statement that already
-- took a lock on that same row — the holding side moves the FK's KEY SHARE
-- earlier within one INSERT, and the flip side upgrades the UPDATE's own
-- FOR NO KEY UPDATE within one UPDATE. **No other lock is acquired between the
-- old and the new acquisition point**, so the ORDER of every lock in every
-- shipped transaction is unchanged; only the mode on the qualification row is
-- stronger. A cycle needs an inversion, and there is none to invert.
--
-- **The residual, stated rather than glossed.** A transaction that took the
-- audit lock FIRST and then wrote a qualification row would invert the order and
-- could deadlock against a transaction doing the reverse. That inversion is
--   (a) not reachable through any shipped path — every staffing service writes
--       its audit row last; and
--   (b) NOT NEW: it is a property of the audit advisory lock itself, and it is
--       constructible today with 0012 alone, using two retirements and no code
--       from this migration.
-- PostgreSQL's deadlock detector turns such an inversion into a bounded 40P01
-- refusal, which aborts one transaction and commits nothing — the invariant in
-- §2 survives a deadlock as surely as it survives a refusal. All of this is
-- measured, both orders and the inversion, in
-- `apps/api/test/profiles/requires-expiry-flip-serialization.test.ts`.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 4. What is NOT changed
-- ═══════════════════════════════════════════════════════════════════════════
--
-- No table, no column, no policy, no grant, no RLS setting, no index, no
-- constraint. The two functions keep their signatures, their `SET search_path =
-- public, pg_temp`, their SQLSTATEs and their message text; `CREATE OR REPLACE`
-- preserves their grants and the `REVOKE ALL … FROM PUBLIC` below re-states them
-- rather than assuming them (0011's rule: a grant that survives by convention is
-- a grant nobody checks). Every existing arm of both guards is carried across
-- unchanged — this migration ADDS a lock and removes nothing.
--
-- Normative sources:
--   doc 35 §6c                  — the packet; its Required behaviour governs
--   FAD-36(2)                   — the R-1 ruling: write-time exclusion here
--   FAD-28 R5 / FAD-28(2)       — the sequential rule, and the retirement race
--   migration 0012 §3, §3b      — the two bodies replaced below
--   migration 0003              — the per-organization audit advisory lock
--   migration 0011              — the CREATE OR REPLACE / restore-verbatim precedent

-- Up Migration

------------------------------------------------------------------------------
-- 1. The holding-boundary guard reads the qualification UNDER FOR KEY SHARE.
--
-- Byte-identical to 0012 §3 apart from the locking clause and the comment: the
-- NOT FOUND arm still raises `insufficient_privilege` so a cross-tenant id is
-- indistinguishable from a nonexistent one (T-05b); the requires_expiry arm and
-- the INSERT-only retirement arm are unchanged.
--
-- FOR KEY SHARE is the mode the composite foreign key takes a few microseconds
-- later in the same statement, so the holding side acquires NOTHING NEW — it
-- acquires the same lock sooner, which is what puts it before the read instead
-- of after it.
------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_guard_holding_expiry_retirement() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_requires_expiry boolean;
    v_status          text;
BEGIN
    -- OPUS-M4-001S. `FOR KEY SHARE` conflicts with the `FOR UPDATE` the flip
    -- guard now takes, and it is the mode the composite FK takes anyway. Two
    -- consequences, both load-bearing:
    --   * a flip in flight blocks this statement here, BEFORE the values below
    --     are read, and the read that follows the wait sees the flip's COMMITTED
    --     row rather than this transaction's snapshot;
    --   * a flip arriving later blocks on the lock this holds until commit, and
    --     then sees this holding.
    -- A concurrent RETIREMENT holds FOR NO KEY UPDATE, which does not conflict:
    -- the granted-while-retiring interleaving stays ADMITTED exactly as
    -- FAD-28(2)/FAD-35 require, and its named proof stays true.
    SELECT q.requires_expiry, q.status
      INTO v_requires_expiry, v_status
      FROM qualifications q
     WHERE q.id = NEW.qualification_id
       FOR KEY SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'the holding names a qualification that is not visible in this context'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF v_requires_expiry AND NEW.valid_until IS NULL THEN
        RAISE EXCEPTION
            'QUALIFICATION_REQUIRES_EXPIRY: this qualification requires an expiry; a holding of '
            'it must carry valid_until'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF TG_OP = 'INSERT' AND v_status = 'retired' THEN
        RAISE EXCEPTION
            'QUALIFICATION_RETIRED: a retired qualification cannot be newly held; reinstate the '
            'qualification first'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

------------------------------------------------------------------------------
-- 2. The flip guard takes FOR UPDATE before it looks for open-ended holdings.
--
-- Byte-identical to 0012 §3b apart from the lock and the comment. The lock is
-- taken ONLY on the `false → true` transition — the transition the rule is
-- about — so every other UPDATE of a qualification (a rename, a retirement, a
-- reinstatement) keeps exactly the lock strength it had.
--
-- The BEFORE UPDATE trigger already holds FOR NO KEY UPDATE on this row (the
-- row-level lock the UPDATE itself took before firing the trigger); this
-- upgrades it to Exclusive within the same statement, which is why it adds no
-- new position to the transaction's lock order (§3 above).
------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_guard_requires_expiry_flip() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.requires_expiry AND NOT OLD.requires_expiry THEN
        -- OPUS-M4-001S. Serialize against in-flight grants: this waits for any
        -- transaction holding FOR KEY SHARE on this row (a holding INSERT or
        -- status UPDATE inside the guard above, or its composite FK) to settle.
        -- The EXISTS below is then a NEW statement under a NEW READ COMMITTED
        -- snapshot, so it sees whatever that transaction committed.
        PERFORM 1 FROM qualifications WHERE id = OLD.id FOR UPDATE;

        IF EXISTS (
            SELECT 1
              FROM qualification_holdings h
             WHERE h.qualification_id = OLD.id
               AND h.valid_until IS NULL
               AND h.status IN ('pending', 'valid', 'expiring')
        ) THEN
            RAISE EXCEPTION
                'QUALIFICATION_REQUIRES_EXPIRY_CONFLICT: open-ended live holdings of this '
                'qualification exist; requires_expiry cannot be switched on over them'
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

-- `CREATE OR REPLACE` preserves the objects' grants, so 0012's
-- `REVOKE ALL … FROM PUBLIC` still stands on both. Both are re-stated rather
-- than assumed (the 0011 rule).
REVOKE ALL ON FUNCTION app_guard_holding_expiry_retirement() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_guard_requires_expiry_flip()      FROM PUBLIC;

-- Down Migration

-- Both functions are RESTORED to 0012's bodies, not dropped: dropping either
-- would take its trigger with it and leave FAD-28 R1/R5 unenforced, which is a
-- worse outcome than the concurrency hole this migration closes. The bodies
-- below are 0012 §3 and §3b, VERBATIM (the 0011 precedent). Reversing this
-- migration therefore restores the ADMITTED interleaving described in §1 — that
-- is what reversing it means, and saying so is the point.

CREATE OR REPLACE FUNCTION app_guard_holding_expiry_retirement() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_requires_expiry boolean;
    v_status          text;
BEGIN
    SELECT q.requires_expiry, q.status
      INTO v_requires_expiry, v_status
      FROM qualifications q
     WHERE q.id = NEW.qualification_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'the holding names a qualification that is not visible in this context'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF v_requires_expiry AND NEW.valid_until IS NULL THEN
        RAISE EXCEPTION
            'QUALIFICATION_REQUIRES_EXPIRY: this qualification requires an expiry; a holding of '
            'it must carry valid_until'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF TG_OP = 'INSERT' AND v_status = 'retired' THEN
        RAISE EXCEPTION
            'QUALIFICATION_RETIRED: a retired qualification cannot be newly held; reinstate the '
            'qualification first'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app_guard_requires_expiry_flip() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.requires_expiry AND NOT OLD.requires_expiry AND EXISTS (
        SELECT 1
          FROM qualification_holdings h
         WHERE h.qualification_id = OLD.id
           AND h.valid_until IS NULL
           AND h.status IN ('pending', 'valid', 'expiring')
    ) THEN
        RAISE EXCEPTION
            'QUALIFICATION_REQUIRES_EXPIRY_CONFLICT: open-ended live holdings of this '
            'qualification exist; requires_expiry cannot be switched on over them'
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_guard_holding_expiry_retirement() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_guard_requires_expiry_flip()      FROM PUBLIC;
