-- FU-20's PERIOD-SHRINK half — the vacation_periods-side guard
-- (OPUS-M5-003, doc 42 §5f Part A).
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. What FU-20 recorded, and which of its two exits this file takes
-- ═══════════════════════════════════════════════════════════════════════════
--
-- FU-20 named two guards of one class — "referenced-row properties can drift
-- after the referencing row is written" — and offered each the same two exits:
-- a guard on the referenced side, or a recorded ruling that the drift is
-- acceptable with the readers that tolerate it NAMED.
--
--   * The `allow_request` face was taken at M5-001: migration 0023 §6 ships
--     `app_guard_shift_group_request_stability`.
--   * This file takes the `vacation_periods` face, the same way and for the
--     reason 0023's header §5 records verbatim: a drift ruling "would have to
--     name the readers that tolerate the drift, and one of them is M5-004's
--     solver projection, which does not exist yet; a guard needs no such
--     foresight."
--
-- The defect, precisely: 0022 grants `UPDATE (start_date, end_date, …)` on
-- `vacation_periods`, and `app_guard_vacation_week_in_period` checks
-- `week ∈ period` only when the SELECTION or the GRANT is written. So shrinking
-- a period moves the boundary out from under rows that were legal when made,
-- and nothing objects.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 2. The invariant, stated once, enforced from both sides
-- ═══════════════════════════════════════════════════════════════════════════
--
--     every vacation_selections row and every weekly-capacity vacation_grants
--     row has a `week_start` inside its period
--
-- 0022 enforces it from the ROW side, at row-write time. This file enforces it
-- from the PERIOD side, at period-write time. Neither half is redundant: a
-- one-sided guard is a one-sided guarantee, which is the same argument 0022 §5
-- makes for attaching D-27's trigger to both `requests` and
-- `vacation_selections`.
--
-- Widening a period is never refused. It strands nothing, and a guard that
-- refused it would be blocking the remedy rather than the harm.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 3. WHICH rows the guard counts — decided by MEASUREMENT, not by argument
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 0023's `allow_request` guard counts only NON-TERMINAL requests. An
-- unconditional, status-blind count would have been exactly symmetric with the
-- status-blind row-side guard, and the argument for it is real: a period's
-- bounds are the DEFINITION of what the round covers, so a settled week outside
-- them is a false historical statement rather than a stale permission.
--
-- The argument on the other side is equally real, and it wins, because it is a
-- fact about this schema rather than a preference. **The remediation paths were
-- enumerated before this predicate was written**, per status, and the
-- enumeration is the reason for the exclusion list below:
--
--   | selection status | claims the week? | remediation for a row in a removed week |
--   |---|---|---|
--   | `available`  | no — §5.3's pre-request state, no root row exists   | **none** |
--   | `pending`    | YES — awaiting a decision                          | withdraw (M5-003) or deny (M5-002) |
--   | `approved`   | YES — a promise has been made                      | reversal (M5-004) |
--   | `committed`  | YES — a published version carries it (§5.6)        | reversal (M5-004) |
--   | `denied`     | no — terminal                                      | **none** |
--   | `withdrawn`  | no — terminal                                      | **none** |
--   | `expired`    | no — terminal                                      | **none** |
--   | `reversed`   | no — terminal                                      | **none** |
--
-- "**none**" is measured, not assumed. `vacation_selections` has NO `DELETE`
-- grant for any role (0022 §9 states the absence as the rule), `week_start` is
-- NOT in its column-level `UPDATE` grant, and §2's vacation column carries no
-- outgoing edge from `denied`, `withdrawn`, `expired` or `reversed` — so a row
-- in any of those five states cannot be removed, re-pointed at another week, or
-- moved on. It is inert and it is permanent.
--
-- An unconditional guard would therefore make a period PERMANENTLY unshrinkable
-- past any week that has ever held a selection, including one withdrawn the same
-- afternoon. That is a new operational deadlock, introduced by the guard rather
-- than found by it, and it is worse than the drift it would be preventing:
-- the drift's readers are the ones that ACT on a claim, and an inert row makes
-- no claim to act on.
--
-- **So the exclusion is named rather than silent: `available`, `denied`,
-- `withdrawn`, `expired` and `reversed` are not counted.** Everything that still
-- claims the week is — `pending`, `approved`, `committed` — which is the set
-- M5-004's projection and commit path read.
--
-- `approved` and `committed` have their remediation in M5-004 rather than today,
-- and that is sequencing rather than a deadlock: a live claim SHOULD block the
-- shrink whether or not the undo has shipped, and the undo is a named, scheduled
-- packet.
--
-- ## The same measurement, for weekly-capacity grants
--
-- `vacation_grants` likewise has no `DELETE` grant and an immutable
-- `week_start`. But `units_total` IS in its `UPDATE` grant, and a capacity grant
-- of zero units allocates nothing — so zeroing the counters is a real
-- remediation path, and a grant that still allocates or records units is a live
-- claim on the week with a remedy available. The predicate is therefore
--
--     units_total > 0 OR units_consumed > 0 OR override_units > 0
--
-- which counts every grant that means anything and excludes exactly the inert
-- ones. Personal-entitlement grants carry no `week_start` at all (0022's
-- `vacation_grants_kind_shape`) and are outside this question by construction.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Operational consequence, stated rather than discovered
-- ═══════════════════════════════════════════════════════════════════════════
--
-- An administrator shrinking a vacation round must first deal with the live
-- selections and the allocated weekly capacity in the weeks being removed —
-- decide or withdraw the selections, zero the capacity. The refusal names the
-- COUNT and the offending bound so a surface can say what to do about it, which
-- is the same courtesy 0023's `SHIFT_GROUP_REQUESTS_OUTSTANDING` extends.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Additive only
-- ═══════════════════════════════════════════════════════════════════════════
--
-- One function and one trigger. No table, column, constraint, policy, grant or
-- function body from 0021, 0022, 0023 or 0024 is altered, replaced or dropped,
-- so there is no verbatim body to restore and the down migration is two DROPs.
-- The migration+RLS pairing gate has nothing to pair: this file creates no
-- table.
--
-- Normative sources:
--   SPEC-08 §5.2, §5.5      — the period's bounds, and the mode-stability precedent
--   docs/fable/40 FU-20     — the register row this closes
--   migration 0022 §6, §7, §9 — the row-side guard, the mode guard, the grants measured above
--   migration 0023 §6 and header §5 — FU-20's other face, and its ratified reasoning
--   doc 42 §5f              — this packet's scope

-- Up Migration

------------------------------------------------------------------------------
-- The guard
--
-- BEFORE UPDATE, so it binds every writer including the owner, and so the
-- refusal happens before any dependent trigger has acted on a boundary that is
-- about to be rejected.
--
-- Invoker rights (no `SECURITY DEFINER`): a row this writer cannot see is a row
-- this writer cannot be blocked by, which is the same posture
-- `app_guard_vacation_week_in_period` takes and it keeps RLS the arbiter of
-- visibility rather than this function (non-bypass rule 3).
------------------------------------------------------------------------------

CREATE FUNCTION app_guard_vacation_period_bounds_stable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_selections integer;
    v_grants     integer;
BEGIN
    -- Only a change to the bounds is this trigger's business. A period whose
    -- dates are unchanged may move its mode, its state or its version freely —
    -- and the mode has its own guard (0022 §7).
    IF NEW.start_date IS NOT DISTINCT FROM OLD.start_date
       AND NEW.end_date IS NOT DISTINCT FROM OLD.end_date
    THEN
        RETURN NEW;
    END IF;

    ------------------------------------------------------------------------
    -- The three statuses that still CLAIM the week (§3 of this file's header).
    -- The five excluded ones are inert AND irremediable, and counting them
    -- would make this period unshrinkable forever against rows nobody can
    -- remove.
    ------------------------------------------------------------------------
    SELECT count(*) INTO v_selections
    FROM vacation_selections
    WHERE vacation_period_id = NEW.id
      AND status IN ('pending', 'approved', 'committed')
      AND (week_start < NEW.start_date OR week_start > NEW.end_date);

    ------------------------------------------------------------------------
    -- Weekly-capacity grants that still allocate or record units. A zeroed
    -- grant allocates nothing, and zeroing it is the measured remediation path
    -- (`units_total` is in 0022's column-level UPDATE grant).
    ------------------------------------------------------------------------
    SELECT count(*) INTO v_grants
    FROM vacation_grants
    WHERE vacation_period_id = NEW.id
      AND kind = 'weekly-capacity'
      AND (units_total > 0 OR units_consumed > 0 OR override_units > 0)
      AND (week_start < NEW.start_date OR week_start > NEW.end_date);

    IF v_selections > 0 OR v_grants > 0 THEN
        RAISE EXCEPTION
            'VACATION_PERIOD_BOUNDS_STRAND_ROWS: moving this period to % .. % would leave '
            '% live selection(s) and % allocated weekly-capacity grant(s) outside it '
            '(SPEC-08 §5.2, FU-20) — decide or withdraw the selections and zero the '
            'capacity in the weeks being removed first',
            NEW.start_date, NEW.end_date, v_selections, v_grants
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_guard_vacation_period_bounds_stable() FROM PUBLIC;

-- Named to sort AFTER `vacation_periods_guard_mode_stable`, so a writer changing
-- both the mode and the bounds under live selections is told about the mode
-- first — the rule that has been in force since 0022. Trigger firing order
-- within an event is by name, and that is the whole reason for the spelling.
CREATE TRIGGER vacation_periods_guard_zz_bounds_stable
    BEFORE UPDATE ON vacation_periods
    FOR EACH ROW EXECUTE FUNCTION app_guard_vacation_period_bounds_stable();

-- Down Migration

DROP TRIGGER IF EXISTS vacation_periods_guard_zz_bounds_stable ON vacation_periods;

DROP FUNCTION IF EXISTS app_guard_vacation_period_bounds_stable();
