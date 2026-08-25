-- R-5 (FAD-53; review finding REV-A-004) — the termination facts of a build run
-- are frozen once stated.
--
-- ADDITIVE in the migration-file sense: 0001..0019 are applied and are never
-- edited. This file creates no table, no policy, no grant, no index and no
-- trigger. It replaces the body of exactly ONE existing guard function with
-- `CREATE OR REPLACE`, and the down migration restores 0018's body VERBATIM —
-- the 0011 precedent, which 0012 §5 and migration 0017 both followed.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. The defect, exactly
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Reproduced by the REV-A reviewer (arm REV-A/H) and again here before this
-- file was written. As `app_runtime`, inside a unit of work, on a run that had
-- already SETTLED:
--
--     BEFORE build_runs        : state=failed termination_reason=rejected
--                                                    solver_status=FEASIBLE
--     UPDATE build_runs SET termination_reason = 'completed',
--                           solver_status      = 'OPTIMAL'    ... ACCEPTED ✓
--     AFTER  build_runs        : state=failed termination_reason=completed
--                                                    solver_status=OPTIMAL
--     AFTER  build_run_results : termination_reason=rejected  solver_status=FEASIBLE
--     the two records now DISAGREE: true
--
--     verdict from the recorded facts      : interrupted  reproducible=false
--     verdict after the rewrite would read : reproducible reproducible=true
--
-- `runResultReproducibility` (SPEC-04 §4; FAD-49/50/52) reads
-- `build_runs.termination_reason` and `build_runs.solver_status` — the MUTABLE
-- copy — while `build_run_results` holds the same two facts under
-- `build_run_results_append_only`. So a rewrite of two columns turns
-- "interrupted, not reproducible" into "reproducible", with the promise sentence
-- attached, while the immutable copy of the same facts one join away still says
-- the opposite.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 2. The mechanism: the early return, and what it does and does not cover
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 0018's `app_guard_build_run_transition` is a BEFORE UPDATE trigger in two
-- halves, separated by one line:
--
--     ... the unconditional column freezes (epoch, identity, snapshot,
--         canonical input hash, applied version) ...
--
--     IF NEW.state IS NOT DISTINCT FROM OLD.state THEN
--         RETURN NEW;                       <-- the early return
--     END IF;
--
--     ... every STATE-CONDITIONED guard: edge legality, the claim-epoch
--         advance, BUILD_TERMINATION_REASON_REQUIRED, the validation gate,
--         BUILD_APPLIED_VERSION_REQUIRED ...
--
-- **The early return is correct and this file does not touch it.** It exists
-- because `app_build_run_transition_is_legal` has no self-edges — the sixteen
-- states reach each other, never themselves — so without the early return every
-- same-state UPDATE would be refused as `BUILD_TRANSITION_ILLEGAL`, and every
-- same-state UPDATE in the system is legitimate work:
--
--     heartbeat()            `heartbeat_at`, state stays `running`
--     reapStaleBuilds()      the fence: `claim_epoch`, `claimed_by`,
--                            `claimed_at`, `heartbeat_at`; state stays `running`
--     submitBuild()          `snapshot_id`, `canonical_input_hash`;
--                            state stays `validating`
--     runQueuedBuild()       `solver_parameters`, `random_seed`,
--                            `deterministic_worker_count`; state stays `running`
--     persistOutcome()       the SPEC-04 §4 provenance columns
--                            (`solver_version`, `solver_image_digest`,
--                            `compiler_version`, `platform_arch`,
--                            `reproducibility_mode`); state stays `running`
--
-- What the early return DOES do wrong is nothing of its own: the defect is that
-- the two termination facts were never given a freeze in the first half, where
-- identity, snapshot and applied version already have one. They were left to
-- `BUILD_TERMINATION_REASON_REQUIRED` in the second half, which asks only
-- whether a reason is PRESENT on a state change — never whether a recorded one
-- was overwritten.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 3. The repair, and the freeze semantics chosen
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ONE unconditional freeze, in the first half, beside its four siblings:
-- **write-once**. Once `termination_reason` or `solver_status` is non-NULL, its
-- value never changes again — not on a same-state UPDATE, not on a state change,
-- not to NULL, and not by any role including the owner (`FORCE ROW LEVEL
-- SECURITY` binds the owner, and a BEFORE trigger binds everyone).
--
-- Write-once rather than "frozen once the run is settled", and the difference is
-- deliberate:
--
--   * the settled-state spelling would have to be state-conditioned, which is
--     the exact shape the early return skips. A freeze that lives below the
--     early return would be no freeze at all for a same-state UPDATE — this
--     finding, rewritten;
--   * write-once needs no state at all. It compares OLD to NEW and nothing else,
--     so it is evaluated for every UPDATE from every writer on every path;
--   * and it is strictly stronger. The three legitimate writers set these two
--     columns exactly once each, out of NULL, on the transition into a terminal
--     state (§4). "Never rewritten" therefore costs them nothing, while
--     "rewritten only before settling" would leave a window between the first
--     write and the state change that no writer needs and this finding could
--     live in.
--
-- The spelling is the sibling freezes' spelling, verbatim in form:
-- `OLD.x IS NOT NULL AND NEW.x IS DISTINCT FROM OLD.x` — the same shape
-- `BUILD_SNAPSHOT_FROZEN` and `BUILD_APPLIED_VERSION_FROZEN` already use. A
-- writer that re-states the SAME value is not a rewrite and is admitted, so an
-- idempotent replay is unaffected.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Every writer of these two columns, and why each still works
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Found by grepping the whole tree for the column names and their camelCase
-- forms. `build_runs.termination_reason` and `build_runs.solver_status` are
-- written from exactly one function, `transitionRun`, reached from exactly three
-- call sites, and every one of them writes out of NULL on a state change:
--
--   persistOutcome()        `running` -> completed / completed_with_unmet_
--                           preferences / infeasible / failed / cancelled, with
--                           the classified reason and the solver's own status
--   reapStaleBuilds()       `running` -> `failed`, reason `crashed`,
--                           status `FAILED`
--   requestCancellation()   `queued` -> `cancelled`, reason `user_cancelled`,
--                           status `CANCELLED`
--
-- Every other `transitionRun` call — validating, readiness_check, queued,
-- reviewed, progressively_extended, approved, applied_to_draft_schedule,
-- superseded, archived — passes neither option, so `patch` carries neither
-- column and the freeze has nothing to compare. A settled run being archived or
-- superseded keeps the reason it recorded, which is what those edges mean.
--
-- There is no path back: no terminal state has an edge to a non-terminal one, so
-- no run reaches a second terminating transition and no legitimate second write
-- exists. A retry is a NEW row carrying `retry_of_build_run_id` (SPEC-04 §2,
-- "retries are never in-place"), and a new row has NULL in both columns.
--
-- The five same-state UPDATEs listed in §2 touch neither column and are
-- unaffected — which is the property the freeze had to have, since breaking the
-- heartbeat or the reaper's fence would break crash recovery itself.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 5. What this is and is not
-- ═══════════════════════════════════════════════════════════════════════════
--
-- DEFENCE IN DEPTH, and the finding was filed MAJOR rather than BLOCKING for
-- that reason: no shipped route writes these columns outside `transitionRun` and
-- `persistOutcome` — every writer was checked, by the reviewer and again here —
-- so this closes a reachable hole rather than a demonstrated product defect. It
-- is worth a migration because the guarantee FAD-49/50 exist to make is exactly
-- the class this repository insists must be "enforced by database rules rather
-- than application discipline" (SPEC-04 §4), and the immutable copy of the same
-- facts is one join away.
--
-- No policy is added, changed or removed; no row-level security is enabled,
-- disabled or relaxed; the audit chain is untouched; I-18 and I-19 are
-- unaffected. The function keeps its `SET search_path = public, pg_temp` and its
-- invoker rights — it reads `build_run_violations` and `build_run_results` and
-- must keep doing so as the INVOKER, for the reason 0018 records.
--
-- Normative sources:
--   REV-A-004 / FAD-53  — the finding and its adjudicated repair
--   SPEC-04 §2/§4       — the FAD-34 vocabulary; recorded reproducibility
--   FAD-49/50/52        — the verdict this protects
--   migration 0018      — the guard, its early return, and the sibling freezes
--   migration 0017      — the CREATE OR REPLACE / restore-verbatim discipline

-- Up Migration

------------------------------------------------------------------------------
-- The guard, with ONE hunk added: the termination-facts freeze, in the
-- unconditional first half, immediately before the early return.
--
-- Everything else below is 0018's body verbatim. It is restated in full rather
-- than patched because `CREATE OR REPLACE FUNCTION` replaces a body whole; there
-- is no smaller unit of change available, and a reader comparing this against
-- 0018 should find exactly one difference.
------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_guard_build_run_transition() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_blocking integer;
    v_usable   boolean;
BEGIN
    -- The claim epoch is monotonic for everybody, including a repair script.
    -- A decrement is how a fenced worker would become un-fenced.
    IF NEW.claim_epoch < OLD.claim_epoch THEN
        RAISE EXCEPTION
            'BUILD_CLAIM_EPOCH_REGRESSED: claim epoch moves forward only (% -> %)',
            OLD.claim_epoch, NEW.claim_epoch
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- Identity is not editable. A build that could be re-pointed at another
    -- period, configuration, snapshot or source version would make every
    -- recorded answer describe a question it was not asked.
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.group_id IS DISTINCT FROM OLD.group_id
       OR NEW.period_id IS DISTINCT FROM OLD.period_id
       OR NEW.build_configuration_id IS DISTINCT FROM OLD.build_configuration_id
       OR NEW.source_version_id IS DISTINCT FROM OLD.source_version_id
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.semantic_request_digest IS DISTINCT FROM OLD.semantic_request_digest
       OR NEW.retry_of_build_run_id IS DISTINCT FROM OLD.retry_of_build_run_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION
            'BUILD_IDENTITY_FROZEN: a build run''s identity and request binding are immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- The pinned problem is written once and never re-pointed. A snapshot that
    -- could be swapped after the fact would make `input_hash` a decoration.
    IF OLD.snapshot_id IS NOT NULL AND NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id THEN
        RAISE EXCEPTION
            'BUILD_SNAPSHOT_FROZEN: the pinned canonical input of a build run never changes'
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.canonical_input_hash IS NOT NULL
       AND NEW.canonical_input_hash IS DISTINCT FROM OLD.canonical_input_hash THEN
        RAISE EXCEPTION
            'BUILD_SNAPSHOT_FROZEN: the canonical input hash of a build run never changes'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- D-4d's other half: an applied version is stated once and never re-pointed.
    IF OLD.applied_to_version_id IS NOT NULL
       AND NEW.applied_to_version_id IS DISTINCT FROM OLD.applied_to_version_id THEN
        RAISE EXCEPTION
            'BUILD_APPLIED_VERSION_FROZEN: a build result is applied to one version, once'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- R-5 / REV-A-004. WHY the run ended and WHAT the solver answered are stated
    -- ONCE, by the terminating transition, and are never rewritten afterwards.
    --
    -- This sits ABOVE the early return on purpose. Below it, a same-state UPDATE
    -- skips every check, and `UPDATE build_runs SET termination_reason =
    -- 'completed', solver_status = 'OPTIMAL'` on a settled `failed` run was
    -- ACCEPTED — turning the recorded verdict from "interrupted, not
    -- reproducible" into "reproducible" while the append-only
    -- `build_run_results` row went on holding the facts it was actually given.
    -- The two records could be made to disagree, and the honest one was not the
    -- one the verdict reads.
    IF (OLD.termination_reason IS NOT NULL
        AND NEW.termination_reason IS DISTINCT FROM OLD.termination_reason)
       OR (OLD.solver_status IS NOT NULL
           AND NEW.solver_status IS DISTINCT FROM OLD.solver_status)
    THEN
        RAISE EXCEPTION
            'BUILD_TERMINATION_FACTS_FROZEN: a build run states why it ended and what the '
            'solver answered ONCE (reason %, status %); the append-only build_run_results '
            'row records the same two facts and the two may not be made to disagree',
            coalesce(OLD.termination_reason, '(none)'), coalesce(OLD.solver_status, '(none)')
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.state IS NOT DISTINCT FROM OLD.state THEN
        RETURN NEW;
    END IF;

    IF NOT app_build_run_transition_is_legal(OLD.state, NEW.state) THEN
        RAISE EXCEPTION
            'BUILD_TRANSITION_ILLEGAL: a build run does not move from % to %',
            OLD.state, NEW.state
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- A run may only be claimed into `running` with a HIGHER epoch than it had.
    -- This is the half of fencing that lives on the run itself: two claimers
    -- cannot both believe they own epoch N.
    IF NEW.state = 'running' AND NEW.claim_epoch <= OLD.claim_epoch THEN
        RAISE EXCEPTION
            'BUILD_CLAIM_EPOCH_NOT_ADVANCED: claiming a build run advances its epoch'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- A terminated run states WHY, in the FAD-34 vocabulary. Without this, the
    -- first caller who needed one word would leave the reason NULL and the
    -- distinction between a cancellation and a crash would be gone.
    IF NEW.state IN ('completed', 'completed_with_unmet_preferences', 'infeasible',
                     'failed', 'cancelled')
       AND NEW.termination_reason IS NULL THEN
        RAISE EXCEPTION
            'BUILD_TERMINATION_REASON_REQUIRED: a build run that ends states why (state %)',
            NEW.state
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- THE VALIDATION GATE (packet Required behaviour 4; FAD-27 alignment).
    --
    -- `reviewed → approved` requires zero unresolved hard violations AND a
    -- recorded result the INDEPENDENT checker found usable. Both, because either
    -- alone is defeatable: a run with no violation rows and no result has simply
    -- never been checked, and "not checked" must not read as "clean".
    IF NEW.state = 'approved' THEN
        SELECT count(*) INTO v_blocking
        FROM build_run_violations
        WHERE build_run_id = NEW.id
          AND finding IN ('breach', 'not-evaluable');

        IF v_blocking > 0 THEN
            RAISE EXCEPTION
                'BUILD_HARD_VIOLATIONS_UNRESOLVED: % unresolved hard finding(s) block approval',
                v_blocking
                USING ERRCODE = 'restrict_violation';
        END IF;

        SELECT usable INTO v_usable
        FROM build_run_results
        WHERE build_run_id = NEW.id;

        IF v_usable IS NULL THEN
            RAISE EXCEPTION
                'BUILD_RESULT_MISSING: a build run without an independently checked result is not approvable'
                USING ERRCODE = 'restrict_violation';
        END IF;
        IF NOT v_usable THEN
            RAISE EXCEPTION
                'BUILD_CANDIDATE_NOT_USABLE: the independent checker refused this candidate'
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    -- Selection names the version it wrote to, in the same statement that says
    -- it did. A state that claims application without naming a version is the
    -- state from which D-4d cannot be enforced.
    IF NEW.state = 'applied_to_draft_schedule' AND NEW.applied_to_version_id IS NULL THEN
        RAISE EXCEPTION
            'BUILD_APPLIED_VERSION_REQUIRED: applying a build result names the draft version it wrote'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

-- Down Migration

-- The function is RESTORED to 0018's body, not dropped: dropping it would take
-- `build_runs_guard_transition` with it and leave the transition machine, the
-- fencing epoch rule and the validation gate unenforced — a far worse outcome
-- than the rewrite window this migration closes. The body below is 0018 §7,
-- VERBATIM (the 0011 / 0017 precedent). Reversing this migration therefore
-- restores the ACCEPTED same-state rewrite described in §1 — that is what
-- reversing it means, and saying so is the point.

CREATE OR REPLACE FUNCTION app_guard_build_run_transition() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_blocking integer;
    v_usable   boolean;
BEGIN
    -- The claim epoch is monotonic for everybody, including a repair script.
    -- A decrement is how a fenced worker would become un-fenced.
    IF NEW.claim_epoch < OLD.claim_epoch THEN
        RAISE EXCEPTION
            'BUILD_CLAIM_EPOCH_REGRESSED: claim epoch moves forward only (% -> %)',
            OLD.claim_epoch, NEW.claim_epoch
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- Identity is not editable. A build that could be re-pointed at another
    -- period, configuration, snapshot or source version would make every
    -- recorded answer describe a question it was not asked.
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.group_id IS DISTINCT FROM OLD.group_id
       OR NEW.period_id IS DISTINCT FROM OLD.period_id
       OR NEW.build_configuration_id IS DISTINCT FROM OLD.build_configuration_id
       OR NEW.source_version_id IS DISTINCT FROM OLD.source_version_id
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.semantic_request_digest IS DISTINCT FROM OLD.semantic_request_digest
       OR NEW.retry_of_build_run_id IS DISTINCT FROM OLD.retry_of_build_run_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION
            'BUILD_IDENTITY_FROZEN: a build run''s identity and request binding are immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- The pinned problem is written once and never re-pointed. A snapshot that
    -- could be swapped after the fact would make `input_hash` a decoration.
    IF OLD.snapshot_id IS NOT NULL AND NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id THEN
        RAISE EXCEPTION
            'BUILD_SNAPSHOT_FROZEN: the pinned canonical input of a build run never changes'
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.canonical_input_hash IS NOT NULL
       AND NEW.canonical_input_hash IS DISTINCT FROM OLD.canonical_input_hash THEN
        RAISE EXCEPTION
            'BUILD_SNAPSHOT_FROZEN: the canonical input hash of a build run never changes'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- D-4d's other half: an applied version is stated once and never re-pointed.
    IF OLD.applied_to_version_id IS NOT NULL
       AND NEW.applied_to_version_id IS DISTINCT FROM OLD.applied_to_version_id THEN
        RAISE EXCEPTION
            'BUILD_APPLIED_VERSION_FROZEN: a build result is applied to one version, once'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.state IS NOT DISTINCT FROM OLD.state THEN
        RETURN NEW;
    END IF;

    IF NOT app_build_run_transition_is_legal(OLD.state, NEW.state) THEN
        RAISE EXCEPTION
            'BUILD_TRANSITION_ILLEGAL: a build run does not move from % to %',
            OLD.state, NEW.state
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- A run may only be claimed into `running` with a HIGHER epoch than it had.
    -- This is the half of fencing that lives on the run itself: two claimers
    -- cannot both believe they own epoch N.
    IF NEW.state = 'running' AND NEW.claim_epoch <= OLD.claim_epoch THEN
        RAISE EXCEPTION
            'BUILD_CLAIM_EPOCH_NOT_ADVANCED: claiming a build run advances its epoch'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- A terminated run states WHY, in the FAD-34 vocabulary. Without this, the
    -- first caller who needed one word would leave the reason NULL and the
    -- distinction between a cancellation and a crash would be gone.
    IF NEW.state IN ('completed', 'completed_with_unmet_preferences', 'infeasible',
                     'failed', 'cancelled')
       AND NEW.termination_reason IS NULL THEN
        RAISE EXCEPTION
            'BUILD_TERMINATION_REASON_REQUIRED: a build run that ends states why (state %)',
            NEW.state
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- THE VALIDATION GATE (packet Required behaviour 4; FAD-27 alignment).
    --
    -- `reviewed → approved` requires zero unresolved hard violations AND a
    -- recorded result the INDEPENDENT checker found usable. Both, because either
    -- alone is defeatable: a run with no violation rows and no result has simply
    -- never been checked, and "not checked" must not read as "clean".
    IF NEW.state = 'approved' THEN
        SELECT count(*) INTO v_blocking
        FROM build_run_violations
        WHERE build_run_id = NEW.id
          AND finding IN ('breach', 'not-evaluable');

        IF v_blocking > 0 THEN
            RAISE EXCEPTION
                'BUILD_HARD_VIOLATIONS_UNRESOLVED: % unresolved hard finding(s) block approval',
                v_blocking
                USING ERRCODE = 'restrict_violation';
        END IF;

        SELECT usable INTO v_usable
        FROM build_run_results
        WHERE build_run_id = NEW.id;

        IF v_usable IS NULL THEN
            RAISE EXCEPTION
                'BUILD_RESULT_MISSING: a build run without an independently checked result is not approvable'
                USING ERRCODE = 'restrict_violation';
        END IF;
        IF NOT v_usable THEN
            RAISE EXCEPTION
                'BUILD_CANDIDATE_NOT_USABLE: the independent checker refused this candidate'
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    -- Selection names the version it wrote to, in the same statement that says
    -- it did. A state that claims application without naming a version is the
    -- state from which D-4d cannot be enforced.
    IF NEW.state = 'applied_to_draft_schedule' AND NEW.applied_to_version_id IS NULL THEN
        RAISE EXCEPTION
            'BUILD_APPLIED_VERSION_REQUIRED: applying a build result names the draft version it wrote'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;
