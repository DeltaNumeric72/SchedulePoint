-- SPEC-08 §2, §3 and §4 — the request lifecycle's DATABASE half: the
-- initial-INSERT status ruling, the §3 deadline policy columns, FAD-55's
-- withdrawal-after-reflection edge, the `allow_request` stability guard, and the
-- `SENSITIVE-PII` narrowing that migration 0021 recorded as owed
-- (OPUS-M5-001, doc 42 §5c Parts A/B/C/D/E).
--
-- **This migration creates no table.** It adds four columns to two existing
-- tables, widens one function, adds three guards, and REPLACES the tenancy
-- policies on seven tables with narrower ones. The RLS pairing gate is satisfied
-- vacuously (no `CREATE TABLE`), and every table it touches already has ENABLE +
-- FORCE from the migration that created it — 0021, 0022 and 0005.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. The initial-INSERT status ruling, and why it is an AFTER trigger
--    **A DECLARED DESIGN DECISION. Read this before comparing the guard to
--    D-20.**
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 0021's header §4 left this open in as many words: "D-20 answers *may this
-- subtype's row EVER hold this status*… The §2 matrix answers *may this
-- subtype's row move from THIS status to THAT one*." Neither bounds the status a
-- row is BORN at, and a row that could be INSERTed at any status in its D-20
-- domain could reach `approved` without ever having been submitted, reviewed or
-- decided — every edge in §2 walked AROUND rather than through.
--
-- Doc 42 §5c Part A decides it:
--
--   * `draft` for the five non-vacation subtypes. **Submission is a TRANSITION,
--     never an insert state.**
--   * `submitted` for `vacation-selection` alone. §5.3's mapping reads
--     `available` → *no request row yet* and `pending` → `submitted`: a vacation
--     selection lives without a root until it is submitted, and the root's first
--     instant IS the submission. There is no state of the world in which a
--     vacation root exists at `draft`.
--
-- ## Trigger, not CHECK — and the reason is not style
--
-- A `CHECK` constraint cannot tell an INSERT from an UPDATE. It is re-evaluated
-- on every UPDATE that touches the row, so a CHECK expressing "status must be
-- the initial status" would refuse every legal transition, and one weakened to
-- permit the whole domain would enforce nothing. There is no CHECK that says
-- what this rule says. A row trigger firing `AFTER INSERT` says it exactly.
--
-- ## AFTER, not BEFORE — and this is the part worth reading twice
--
-- A `BEFORE INSERT` trigger fires before the table's CHECK constraints. That
-- would put this guard IN FRONT of D-20, so `shift-preference` INSERTed at
-- `approved` — SPEC-08 R-03, the review's named failure — would come back with a
-- message about a creation status instead of D-20's `23514`, and D-20's
-- INSERT-time arm would become unreachable and therefore unprovable.
--
-- `AFTER INSERT` fires after every CHECK on the statement, which orders the two
-- refusals by specificity, from the most general true reason to the narrowest:
--
--   status outside the subtype's domain     →  D-20 (23514).  "no such status
--                                               for this subtype, ever"
--   status in the domain, not the initial   →  this guard.    "in the domain,
--                                               but not a status a row is born
--                                               at"
--
-- Both are true of the second case; the second is more useful, and it is the one
-- the caller gets. **D-20 is untouched and still enforcing on every path**, which
-- `migration-0023-populated-cycle.test.ts` asserts directly rather than assuming.
--
-- ## NOT deferred, and NOT a constraint trigger
--
-- D-18's zero-row guard is `DEFERRABLE INITIALLY DEFERRED` because the question
-- it asks ("does this request have its subtype row?") has no answer until commit.
-- This question is the opposite: it is about the row AS INSERTED, and the answer
-- is only available at the instant of the insert. A submission service creates a
-- request at `draft` and transitions it to `submitted` in ONE unit of work — a
-- deferred guard reading the CURRENT row would refuse that entirely legal
-- transaction, and one reading `NEW` would meet the staleness problem 0021's
-- header §4 documents. Immediate, reading `NEW`, is the only correct shape.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 2. FAD-55 — `reflected_in_version → withdrawn`
--    **An ADDITION to SPEC-08 §2's matrix, escalated and ratified, with the
--    specification amended in the same change.**
-- ═══════════════════════════════════════════════════════════════════════════
--
-- SPEC-08 §4's withdrawal row and R-10 require a transition §2's printed matrix
-- did not contain:
--
--   > **Withdrawal after `reflected_in_version`** — Does not silently revert the
--   > schedule. It raises a `ScheduleRevisionRequested` event; the scheduler
--   > decides. **The request moves to `withdrawn` with
--   > `revision_requested = true`.**
--
-- §2 had no `reflected_in_version → withdrawn` cell for any subtype. The V-31
-- amendment swept this section — it added `accepted_as_input → withdrawn` and
-- rewrote the expiry rows — but never added the row §4's own sentence requires,
-- so §2 and §4 disagreed, and 0021, implementing §2 literally and correctly for
-- its own packet, refused the edge R-10 needs. **R-10 could not pass against the
-- shipped schema.** This is the fourth SPEC-08 internal finding, in the class
-- M5-000b found three of.
--
-- Escalated rather than resolved in the implementation, and ratified as FAD-55:
-- resolve ADDITIVELY, in favour of the explicit behavioural requirement.
-- SPEC-08 §2 carries a dated amendment landed by this same packet, so the
-- specification and the enforcement do not disagree after this.
--
-- **Nothing is narrowed.** V-31's enumerated expiry sources are untouched and no
-- wildcard is reintroduced. D-20 needs no change at all, because `withdrawn` is
-- already in every subtype's status domain — this was a missing EDGE, never a
-- missing status.
--
-- **The cell is guarded, not bare.** `app_guard_request_revision_requested`
-- refuses a `reflected_in_version → withdrawn` write that does not set
-- `revision_requested` in the same row write, so the only thing the new cell
-- permits is the scenario §4 describes. The published version is NEVER touched
-- (I-18); the withdrawal produces an event and a scheduler decision.
--
-- **`vacation-selection` is excluded.** A committed vacation week's undo is
-- §5.6's REVERSAL — `reflected_in_version → reversed`, which §2 already carries
-- and 0021 already permits. A second spelling of one act would leave §5.3's
-- mapping unable to say which one a `withdrawn` selection meant.
--
-- **Why the pairing with R-22 is coherent rather than odd.** Refusal at
-- `consumed_by_build` and permission at the later `reflected_in_version` look
-- inverted until you ask what has been PROMISED. At `consumed_by_build` a solver
-- run has taken the request as input and nothing has been promised to anybody —
-- there is nothing to revise and a live run to protect. At
-- `reflected_in_version` a published version honours the request, a promise
-- exists, and a person asking out of a promise must produce a visible revision
-- request rather than either silence or a refusal.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 3. §3's policy columns — `deadline_rolls`, `late_submission_policy`, `is_late`
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Migration 0010 landed the request-until POLICY (`request_until_mode`,
-- `request_until_date`, `request_until_lead_days`) and said in its own header
-- that "nothing reads them… the enforcement is M5 (SPEC-08)". This is that
-- packet, and it adds the two configuration columns §3 names and 0010 did not:
--
--   `groups.deadline_rolls ∈ {forward, backward, exact}`  — §3's roll, against
--       `group_holidays`, which has existed since 0005. (Doc 42 §5b's "group
--       holidays lands there" was imprecise; the TABLE is 0005's and the POLICY
--       is this packet's, as §5b's own acceptance record corrects.)
--   `groups.late_submission_policy ∈ {reject, accept_as_late}` — §3's "Late
--       submission … **configured, never implicit**".
--
-- and the one column on the root that 0021 deliberately withheld:
--
--   `requests.is_late` — 0021's header §6: "doc 06 §3.4 lists it on the root;
--       SPEC-08 §1.1 … does not, and doc 42 §5b binds this packet to the exact
--       field list of §1.1. §3's late-submission policy is M5-001's, and the
--       column lands with the machinery that reads it." It lands here, with it.
--
-- **Both DEFAULTs are the strict direction, and that is deliberate.**
-- `deadline_rolls` defaults to `exact` and `late_submission_policy` to `reject`,
-- so a group that existed before this migration and has chosen nothing gets the
-- behaviour that grants nobody anything they did not have: the printed date is
-- the date, and a late submission is refused. A default of `forward` would
-- silently extend every existing group's window, and `accept_as_late` would
-- silently open one that was shut. A migration must not make a policy decision
-- on a group's behalf in the permissive direction.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 4. `SENSITIVE-PII` — the narrowing 0021 recorded as owed
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 0021's header §5, verbatim: "**M5-001 owes the SENSITIVE-PII narrowing** when
-- it adds the capability keys its routes need." Both halves happen here — the
-- keys land in `packages/domain/src/authz/catalogue.ts` in the same change, and
-- the policies land below.
--
-- The precedent is `qualification_holdings` (0004): own-row access always,
-- another member's row behind a READ capability, writes behind an
-- ADMINISTRATION capability, and deliberately **no organization-scoped blanket
-- policy**. The reasoning transfers exactly: doc 06 §3.4 classifies `requests`
-- and every subtype table `SENSITIVE-PII`, and "every member of the group can
-- read every colleague's time-off requests and the dates of them" is a
-- disclosure about identified individuals — when a named person asked to be off,
-- and what for — not a tenancy question.
--
-- Three arms per table:
--
--   `<table>_own`                  a member's OWN requests. `FOR ALL`, not
--                                  `FOR SELECT` — and the difference from 0004
--                                  is the point. Submitting and withdrawing are
--                                  SELF-SCOPED acts (CAP-021: "Submitting is
--                                  self-scoped"), whereas a member may not grant
--                                  themselves a credential, which is why 0004's
--                                  own-arm is read-only. What a member may do to
--                                  their own request is still bounded by the
--                                  transition matrix, the column-level UPDATE
--                                  grant, and SPEC-06 — RLS decides which ROWS,
--                                  never which OPERATIONS.
--   `<table>_group_read_any`       `FOR SELECT` behind `requests.read_any`. A
--                                  READ key with no write power, so a scheduler
--                                  reading the queue does not thereby gain the
--                                  ability to decide anything.
--   `<table>_group_administration` `FOR ALL` behind `requests.administer`. The
--                                  key M5-002's approvals will need, and the key
--                                  this packet's expiry sweeper runs under.
--
-- ## The five subtype tables reach the root, and the indirection is deliberate
--
-- `requests` carries `membership_id`; the five non-vacation subtype tables do
-- not, and adding one would be duplicating the requester onto six tables where
-- it could drift from the root. So their own-arm is an `EXISTS` against
-- `requests`.
--
-- **The predicate is self-sufficient, on purpose.** It does not merely join to
-- `requests` and rely on the root's own policy to filter it — it re-states
-- `r.membership_id = app.membership_id` itself. Row security DOES apply to a
-- table referenced inside a policy expression, so the root's policy is the first
-- control; the restated predicate is the second, and it holds even if the first
-- were ever loosened. Two independent controls in the same direction, which is
-- the discipline 0021 §7 already applies to its grants.
--
-- `vacation_selections` needs no indirection: it carries `membership_id NOT
-- NULL` of its own (0022), and its `available` rows have no `request_id` at all
-- (§5.3), so an `EXISTS` would have hidden exactly the state that has no root.
--
-- ## The expiry sweeper needs no exemption, and that is worth stating
--
-- A sweeper that had to see other people's requests without holding anything
-- would have forced a system arm into these policies — a hole that any code path
-- forgetting to set a membership would fall through. It does not: the job worker
-- REFUSES a job whose frozen context names no membership
-- (`apps/api/src/jobs/worker.ts`), and re-evaluates authorization against current
-- state at execution (I-19, SPEC-06 §5). So the sweeper runs under a real acting
-- membership holding `requests.administer` and meets the `_group_administration`
-- arm like any other administrative caller. **No system arm, no
-- `SECURITY DEFINER`, no role-targeted policy, and no RLS bypass anywhere in
-- this file** (non-bypass rule 3).
--
-- **Two different actors, and this comment previously conflated them.** The
-- AUTHORIZATION actor is a real membership — that is the whole point above, and
-- it is what removes the need for a policy exemption. The AUDIT actor is
-- deliberately NOT: `expireRequest` records its event with `systemActor: true`,
-- because a deadline passed and nobody DECIDED to expire the request. The audit
-- port's own rule is that "nobody was acting" and "we failed to resolve who was
-- acting" must not look the same, and marking the sweeper's rows system is how
-- the first is said out loud. An earlier draft of this paragraph claimed the
-- sweeper's "audit rows name a real actor", which is false and would have
-- misled anyone reading the chain.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 5. FU-20's `allow_request` half — the shift_groups-side guard
-- ═══════════════════════════════════════════════════════════════════════════
--
-- FU-20 recorded two exits and this packet takes the first, ratified in-round:
-- a guard refusing an `allow_request` flip while non-terminal `shift-group-off`
-- requests name the group, rather than a written ruling that the drift is
-- acceptable.
--
-- The reason the guard wins over the ruling: 0021 already ships
-- `app_guard_shift_group_off_target`, which refuses a `shift-group-off` request
-- naming a group whose `allow_request` is false. With that in place a FLIP is the
-- only remaining way to bring a violating row into existence — a request that was
-- legal when made, naming a group that no longer admits requests. A drift ruling
-- would have to name the readers that tolerate the drift, and one of them is
-- M5-004's solver projection, which does not exist yet; a guard needs no such
-- foresight. §5.5's mode-stability rule ("Mode change mid-period … **Prohibited**
-- while selections exist in `pending` or `approved`") is the house precedent for
-- exactly this shape.
--
-- **The operational consequence, stated rather than discovered:** an
-- administrator who wants to stop accepting off-requests for a shift group must
-- first resolve the outstanding ones — decide them, or let them expire. That is
-- the honest cost of the invariant, it is inherited by M5-005's UX as a known
-- behaviour, and the refusal names the blocking condition so the surface can say
-- what to do about it.
--
-- The guard is one-directional: turning `allow_request` ON is never blocked, and
-- a group with no outstanding requests flips either way freely.
--
-- Normative sources:
--   SPEC-08 §2 (as amended 2026-08-26, FAD-55), §3, §4, §7  — the matrix, the deadlines, R-09/R-10/R-22/R-23
--   doc 42 §5c                                              — this packet's scope and acceptance
--   migration 0021 headers §4 and §5                        — the two obligations discharged here
--   migration 0010                                          — the request-until policy this reads
--   migration 0004 §`qualification_holdings`                — the SENSITIVE-PII narrowing precedent
--   migration 0005                                          — `group_holidays`, and `allow_request`

-- Up Migration

------------------------------------------------------------------------------
-- 1. §3's group policy columns
------------------------------------------------------------------------------

ALTER TABLE groups
    ADD COLUMN deadline_rolls text NOT NULL DEFAULT 'exact'
        CONSTRAINT groups_deadline_rolls_known
        CHECK (deadline_rolls IN ('forward', 'backward', 'exact'));

ALTER TABLE groups
    ADD COLUMN late_submission_policy text NOT NULL DEFAULT 'reject'
        CONSTRAINT groups_late_submission_policy_known
        CHECK (late_submission_policy IN ('reject', 'accept_as_late'));

------------------------------------------------------------------------------
-- 2. The root's two new columns
--
-- `is_late` — §3, and 0021's header §6 reserved it for this packet by name.
-- `revision_requested` — §4's withdrawal-after-reflection row and R-10.
--
-- Both are `NOT NULL DEFAULT false`, so every existing row acquires the
-- statement that nothing unusual happened to it, which is true of every row that
-- exists at this migration: no service has ever written one.
------------------------------------------------------------------------------

ALTER TABLE requests ADD COLUMN is_late boolean NOT NULL DEFAULT false;

ALTER TABLE requests ADD COLUMN revision_requested boolean NOT NULL DEFAULT false;

------------------------------------------------------------------------------
-- 3. FAD-55 — the matrix gains one cell
--
-- `CREATE OR REPLACE` of 0021's function, with 0021's body otherwise byte-for-
-- byte. The down migration restores 0021's body verbatim — the 0011 / 0017 /
-- 0020 precedent for a function whose body one migration widens, and the same
-- precedent 0022 used on `app_guard_request_subtype_row`.
------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_request_transition_is_legal(p_subtype text, p_from text, p_to text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT
        -- `draft → submitted`: every subtype.
        (p_from = 'draft' AND p_to = 'submitted')

        -- `submitted → under_review`: every subtype EXCEPT shift-preference,
        -- which is never reviewed because it is never approved or denied.
     OR (p_from = 'submitted' AND p_to = 'under_review'
         AND p_subtype IN ('availability', 'time-off', 'no-call',
                           'shift-group-off', 'vacation-selection'))

        -- `submitted → accepted_as_input`: availability and shift-preference.
        -- A non-binding input is ACCEPTED, not approved (§2.1).
     OR (p_from = 'submitted' AND p_to = 'accepted_as_input'
         AND p_subtype IN ('availability', 'shift-preference'))

     OR (p_from = 'under_review' AND p_to IN ('approved', 'denied')
         AND p_subtype IN ('availability', 'time-off', 'no-call',
                           'shift-group-off', 'vacation-selection'))

        -- Withdrawal. Requester-initiated only (§4) — an administrator
        -- "withdrawing" for someone is a denial with a reason, and this
        -- predicate says nothing about who: it says from where.
     OR (p_from = 'submitted' AND p_to = 'withdrawn')
     OR (p_from IN ('under_review', 'approved') AND p_to = 'withdrawn'
         AND p_subtype IN ('availability', 'time-off', 'no-call',
                           'shift-group-off', 'vacation-selection'))
        -- V-31. Without this edge a shift preference became unwithdrawable the
        -- instant it was accepted, which for a non-binding preference is wrong;
        -- it is forbidden only AFTER a build consumes it, and then because the
        -- build already used it.
     OR (p_from = 'accepted_as_input' AND p_to = 'withdrawn'
         AND p_subtype IN ('availability', 'shift-preference'))

        --------------------------------------------------------------------
        -- FAD-55 (2026-08-26). §4's withdrawal-after-reflection row and R-10,
        -- which §2's printed matrix did not carry — see §2 of this file's
        -- header. Five subtypes; vacation's undo is §5.6's REVERSAL, below.
        --
        -- `app_guard_request_revision_requested` refuses a write on this edge
        -- that does not set `revision_requested`, so the cell cannot be used
        -- for a quiet withdrawal. The published version is never touched.
        --------------------------------------------------------------------
     OR (p_from = 'reflected_in_version' AND p_to = 'withdrawn'
         AND p_subtype IN ('availability', 'time-off', 'no-call',
                           'shift-preference', 'shift-group-off'))

        -- Consumption by a solver run. Says nothing about the outcome (§2.1).
     OR (p_from = 'approved' AND p_to = 'consumed_by_build'
         AND p_subtype IN ('availability', 'time-off', 'no-call', 'shift-group-off'))
     OR (p_from = 'accepted_as_input' AND p_to = 'consumed_by_build'
         AND p_subtype = 'shift-preference')

     OR (p_from = 'consumed_by_build' AND p_to = 'reflected_in_version'
         AND p_subtype IN ('availability', 'time-off', 'no-call',
                           'shift-preference', 'shift-group-off'))
        -- Vacation reaches a version by COMMIT (§5.6), not by a build.
     OR (p_from = 'approved' AND p_to = 'reflected_in_version'
         AND p_subtype = 'vacation-selection')

        -- Consumed and not honoured. A reportable outcome for a soft
        -- preference, and NOT a denial (§2.1).
     OR (p_from = 'consumed_by_build' AND p_to = 'unsatisfied'
         AND p_subtype = 'shift-preference')

        -- §5.6's undo. Vacation only.
     OR (p_from = 'reflected_in_version' AND p_to = 'reversed'
         AND p_subtype = 'vacation-selection')

        --------------------------------------------------------------------
        -- V-31: `expired` has EXACTLY THREE legal sources, enumerated.
        -- Untouched by FAD-55, and stated here so that is visible rather than
        -- inferred: no wildcard is reintroduced and no source is added.
        --------------------------------------------------------------------
     OR (p_from IN ('submitted', 'under_review', 'accepted_as_input')
         AND p_to = 'expired')

        -- §4's post-reflection revision path. Vacation carries it because a
        -- committed vacation week is amended the same way.
     OR (p_from = 'approved' AND p_to = 'superseded_by_revision'
         AND p_subtype IN ('availability', 'time-off', 'no-call',
                           'shift-group-off', 'vacation-selection'));
$$;

------------------------------------------------------------------------------
-- 4. The initial-INSERT status guard (§1 of this file's header)
------------------------------------------------------------------------------

-- The ruling as a callable predicate, for the same reason 0021 made the matrix
-- one: a rule a test can ask about directly is a rule whose domain copy can be
-- compared to it cell by cell, rather than by inspection.
CREATE FUNCTION app_request_initial_status(p_subtype text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT CASE WHEN p_subtype = 'vacation-selection' THEN 'submitted' ELSE 'draft' END;
$$;

REVOKE ALL ON FUNCTION app_request_initial_status(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app_request_initial_status(text)
    TO app_runtime, app_worker, app_readonly_support, app_breakglass;

CREATE FUNCTION app_guard_request_initial_status() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_initial text;
BEGIN
    v_initial := app_request_initial_status(NEW.subtype);

    IF NEW.status IS DISTINCT FROM v_initial THEN
        RAISE EXCEPTION
            'REQUEST_INITIAL_STATUS_ILLEGAL: a % request is created at %, not % — '
            'submission is a transition, not an insert state',
            NEW.subtype, v_initial, NEW.status
            USING ERRCODE = 'restrict_violation';
    END IF;

    --------------------------------------------------------------------------
    -- C-1 — neither lifecycle flag may be BORN true.
    --
    -- `app_guard_request_revision_requested` is BEFORE **UPDATE**, so it bounds
    -- how these two flags MOVE and says nothing about how a row arrives. The
    -- INSERT grant on `requests` is table-level (0021 §7), so any writer holding
    -- it could name the columns directly — and an independent review's probe,
    -- issued as an ordinary member, created
    -- `{"status":"draft","revision_requested":true,"is_late":true}`.
    --
    -- **That row is a lie the system then protects.** `revision_requested` is
    -- R-10's claim that a PUBLISHED version's promise was retracted and a
    -- scheduler owes a decision; born `true` it asserts that of a `draft` nobody
    -- ever submitted, with no `ScheduleRevisionRequested` event and no audit row
    -- behind it — and the monotonicity rule in the UPDATE guard, which exists so
    -- the flag cannot be quietly cleared, then makes the false claim PERMANENT.
    -- `is_late` born `true` is milder but the same shape: §3's late marker is a
    -- fact about a SUBMISSION measured against a server-computed deadline, and a
    -- row created with it has been measured against nothing.
    --
    -- No shipped path can produce either — `PgRequestStore.create` enumerates
    -- its columns and names neither. That is exactly why this belongs here: R-01
    -- asks for the domain AND the database to refuse, and the database's half is
    -- the one that binds **a writer nobody has written yet**, which is this
    -- packet's own stated reason for having two layers at all.
    --
    -- This guard is the right home rather than a narrowed column grant: it is
    -- already `AFTER INSERT` on this table and already the authority on what a
    -- request may be BORN as, so the rule lands beside the rule it belongs with
    -- and produces a NAMED error instead of a bare privilege refusal. A
    -- column-level grant would also have to be kept in step with every future
    -- role, and would refuse the write with `42501`, which says nothing about
    -- why.
    --------------------------------------------------------------------------
    IF NEW.revision_requested OR NEW.is_late THEN
        RAISE EXCEPTION
            'REQUEST_LIFECYCLE_FLAG_AT_CREATION: a request is created with '
            'revision_requested and is_late both false — revision_requested is set '
            'only by a withdrawal from reflected_in_version (SPEC-08 §4, R-10) and '
            'is_late only by a submission measured against the group deadline (§3)'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION app_guard_request_initial_status() FROM PUBLIC;

-- AFTER, so every CHECK on the statement — D-20 first among them — has already
-- spoken. See §1 of this file's header for why that ordering is the design and
-- not an accident.
CREATE TRIGGER requests_guard_initial_status
    AFTER INSERT ON requests
    FOR EACH ROW EXECUTE FUNCTION app_guard_request_initial_status();

------------------------------------------------------------------------------
-- 5. FAD-55's guard — the new cell cannot be used for a quiet withdrawal
--
-- Named to sort AFTER `requests_guard_transition`, so a caller attempting an
-- illegal edge is told that first: `requests_guard_transition` <
-- `requests_guard_transition_revision`, and both sort before `requests_zz_touch`.
-- Trigger firing order within an event is by name, and that is the whole reason
-- for the spelling.
--
-- Two claims, and the second is not the first restated:
--
--   * a `reflected_in_version → withdrawn` write MUST set `revision_requested`.
--     Without it the row would say a published version's promise was retracted
--     and nothing was asked of the scheduler, which is the silent divergence
--     §4 exists to prevent.
--   * `revision_requested` is MONOTONIC. It is never cleared, and it is never
--     set on any other transition. A flag that could be turned off is a flag
--     that can be turned off after somebody notices it, and a flag that any
--     transition could set is not evidence of the transition it names.
------------------------------------------------------------------------------

CREATE FUNCTION app_guard_request_revision_requested() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF OLD.revision_requested AND NOT NEW.revision_requested THEN
        RAISE EXCEPTION
            'REQUEST_REVISION_FLAG_IMMUTABLE: revision_requested is never cleared'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.status = 'reflected_in_version' AND NEW.status = 'withdrawn' THEN
        IF NOT NEW.revision_requested THEN
            RAISE EXCEPTION
                'REQUEST_REVISION_REQUIRED: withdrawing a % request that a published '
                'version already honours must set revision_requested (SPEC-08 §4, R-10)',
                NEW.subtype
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF NOT OLD.revision_requested AND NEW.revision_requested THEN
        RAISE EXCEPTION
            'REQUEST_REVISION_NOT_APPLICABLE: revision_requested is set only by a '
            'withdrawal from reflected_in_version, and this row moved from % to %',
            OLD.status, NEW.status
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_guard_request_revision_requested() FROM PUBLIC;

CREATE TRIGGER requests_guard_transition_revision
    BEFORE UPDATE ON requests
    FOR EACH ROW EXECUTE FUNCTION app_guard_request_revision_requested();

------------------------------------------------------------------------------
-- 6. FU-20 — `allow_request` stability (§5 of this file's header)
------------------------------------------------------------------------------

CREATE FUNCTION app_guard_shift_group_request_stability() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_outstanding integer;
BEGIN
    -- Only a true → false flip is constrained. Opening a group to requests can
    -- invalidate nothing, and a group whose `allow_request` is unchanged is not
    -- this trigger's business however else the row moves.
    IF NOT (OLD.allow_request AND NOT NEW.allow_request) THEN
        RETURN NEW;
    END IF;

    -- Non-terminal is the SAME three statuses §3's sweeper acts on plus the two
    -- decided-but-unconsumed ones: a request still capable of reaching the
    -- schedule. `denied`, `withdrawn`, `expired`, `unsatisfied`,
    -- `superseded_by_revision` and `reflected_in_version` are settled — nothing
    -- further will be asked of the group on their account.
    SELECT count(*) INTO v_outstanding
    FROM request_shift_group_off sgo
    JOIN requests r
      ON r.id = sgo.request_id
     AND r.organization_id = sgo.organization_id
    WHERE sgo.shift_group_id = OLD.id
      AND sgo.organization_id = OLD.organization_id
      AND r.status IN ('draft', 'submitted', 'under_review', 'approved',
                       'consumed_by_build');

    IF v_outstanding > 0 THEN
        RAISE EXCEPTION
            'SHIFT_GROUP_REQUESTS_OUTSTANDING: shift group % cannot stop admitting off '
            'requests while % outstanding request(s) name it — decide them or let them '
            'expire first',
            OLD.id, v_outstanding
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_guard_shift_group_request_stability() FROM PUBLIC;

CREATE TRIGGER shift_groups_guard_request_stability
    BEFORE UPDATE ON shift_groups
    FOR EACH ROW EXECUTE FUNCTION app_guard_shift_group_request_stability();

------------------------------------------------------------------------------
-- 7. The `SENSITIVE-PII` narrowing (§4 of this file's header)
--
-- The seven group-scope policies 0021 and 0022 created are DROPPED and replaced
-- by three arms each. The down migration recreates them byte-for-byte from those
-- files, so the cycle is honest about what it restores.
------------------------------------------------------------------------------

DROP POLICY requests_group_scope                 ON requests;
DROP POLICY request_availability_group_scope     ON request_availability;
DROP POLICY request_time_off_group_scope         ON request_time_off;
DROP POLICY request_no_call_group_scope          ON request_no_call;
DROP POLICY request_shift_preference_group_scope ON request_shift_preference;
DROP POLICY request_shift_group_off_group_scope  ON request_shift_group_off;
DROP POLICY vacation_selections_group_scope      ON vacation_selections;

-- ── requests — the root carries `membership_id`, so its own-arm is direct ────

CREATE POLICY requests_own ON requests
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND membership_id = nullif(current_setting('app.membership_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND membership_id = nullif(current_setting('app.membership_id', true), '')::uuid);

CREATE POLICY requests_group_read_any ON requests
    FOR SELECT
    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
       AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
       AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
       AND app_acting_membership_holds('requests.read_any'));

CREATE POLICY requests_group_administration ON requests
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND app_acting_membership_holds('requests.administer'))
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND app_acting_membership_holds('requests.administer'));

-- ── the five subtype tables — own-arm reaches the root, twice-guarded ────────

CREATE POLICY request_availability_own ON request_availability
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND EXISTS (SELECT 1 FROM requests r
                         WHERE r.id = request_availability.request_id
                           AND r.organization_id = request_availability.organization_id
                           AND r.membership_id = nullif(current_setting('app.membership_id', true), '')::uuid))
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND EXISTS (SELECT 1 FROM requests r
                         WHERE r.id = request_availability.request_id
                           AND r.organization_id = request_availability.organization_id
                           AND r.membership_id = nullif(current_setting('app.membership_id', true), '')::uuid));

CREATE POLICY request_availability_group_read_any ON request_availability
    FOR SELECT
    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
       AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
       AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
       AND app_acting_membership_holds('requests.read_any'));

CREATE POLICY request_availability_group_administration ON request_availability
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND app_acting_membership_holds('requests.administer'))
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND app_acting_membership_holds('requests.administer'));

CREATE POLICY request_time_off_own ON request_time_off
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND EXISTS (SELECT 1 FROM requests r
                         WHERE r.id = request_time_off.request_id
                           AND r.organization_id = request_time_off.organization_id
                           AND r.membership_id = nullif(current_setting('app.membership_id', true), '')::uuid))
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND EXISTS (SELECT 1 FROM requests r
                         WHERE r.id = request_time_off.request_id
                           AND r.organization_id = request_time_off.organization_id
                           AND r.membership_id = nullif(current_setting('app.membership_id', true), '')::uuid));

CREATE POLICY request_time_off_group_read_any ON request_time_off
    FOR SELECT
    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
       AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
       AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
       AND app_acting_membership_holds('requests.read_any'));

CREATE POLICY request_time_off_group_administration ON request_time_off
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND app_acting_membership_holds('requests.administer'))
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND app_acting_membership_holds('requests.administer'));

CREATE POLICY request_no_call_own ON request_no_call
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND EXISTS (SELECT 1 FROM requests r
                         WHERE r.id = request_no_call.request_id
                           AND r.organization_id = request_no_call.organization_id
                           AND r.membership_id = nullif(current_setting('app.membership_id', true), '')::uuid))
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND EXISTS (SELECT 1 FROM requests r
                         WHERE r.id = request_no_call.request_id
                           AND r.organization_id = request_no_call.organization_id
                           AND r.membership_id = nullif(current_setting('app.membership_id', true), '')::uuid));

CREATE POLICY request_no_call_group_read_any ON request_no_call
    FOR SELECT
    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
       AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
       AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
       AND app_acting_membership_holds('requests.read_any'));

CREATE POLICY request_no_call_group_administration ON request_no_call
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND app_acting_membership_holds('requests.administer'))
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND app_acting_membership_holds('requests.administer'));

CREATE POLICY request_shift_preference_own ON request_shift_preference
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND EXISTS (SELECT 1 FROM requests r
                         WHERE r.id = request_shift_preference.request_id
                           AND r.organization_id = request_shift_preference.organization_id
                           AND r.membership_id = nullif(current_setting('app.membership_id', true), '')::uuid))
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND EXISTS (SELECT 1 FROM requests r
                         WHERE r.id = request_shift_preference.request_id
                           AND r.organization_id = request_shift_preference.organization_id
                           AND r.membership_id = nullif(current_setting('app.membership_id', true), '')::uuid));

CREATE POLICY request_shift_preference_group_read_any ON request_shift_preference
    FOR SELECT
    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
       AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
       AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
       AND app_acting_membership_holds('requests.read_any'));

CREATE POLICY request_shift_preference_group_administration ON request_shift_preference
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND app_acting_membership_holds('requests.administer'))
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND app_acting_membership_holds('requests.administer'));

CREATE POLICY request_shift_group_off_own ON request_shift_group_off
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND EXISTS (SELECT 1 FROM requests r
                         WHERE r.id = request_shift_group_off.request_id
                           AND r.organization_id = request_shift_group_off.organization_id
                           AND r.membership_id = nullif(current_setting('app.membership_id', true), '')::uuid))
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND EXISTS (SELECT 1 FROM requests r
                         WHERE r.id = request_shift_group_off.request_id
                           AND r.organization_id = request_shift_group_off.organization_id
                           AND r.membership_id = nullif(current_setting('app.membership_id', true), '')::uuid));

CREATE POLICY request_shift_group_off_group_read_any ON request_shift_group_off
    FOR SELECT
    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
       AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
       AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
       AND app_acting_membership_holds('requests.read_any'));

CREATE POLICY request_shift_group_off_group_administration ON request_shift_group_off
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND app_acting_membership_holds('requests.administer'))
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND app_acting_membership_holds('requests.administer'));

-- ── vacation_selections — carries its own `membership_id`, so no indirection ──
--
-- And that matters beyond tidiness: §5.3's `available` rows have NO
-- `request_id`, so an `EXISTS` against `requests` would have hidden exactly the
-- state that has no root — a member would lose sight of their own unsubmitted
-- selection. The direct predicate sees it.

CREATE POLICY vacation_selections_own ON vacation_selections
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND membership_id = nullif(current_setting('app.membership_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND membership_id = nullif(current_setting('app.membership_id', true), '')::uuid);

CREATE POLICY vacation_selections_group_read_any ON vacation_selections
    FOR SELECT
    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
       AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
       AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
       AND app_acting_membership_holds('requests.read_any'));

CREATE POLICY vacation_selections_group_administration ON vacation_selections
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND app_acting_membership_holds('requests.administer'))
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND app_acting_membership_holds('requests.administer'));

------------------------------------------------------------------------------
-- 8. Grants for the new columns
--
-- 0021's UPDATE grant on `requests` is COLUMN-LEVEL and names the columns a
-- transition legitimately moves. Two more columns exist now, and both are moved
-- by a transition: `is_late` at submission, `revision_requested` at R-10's
-- withdrawal. `groups`' existing UPDATE grant is checked and widened the same
-- way, because a group's §3 policy is administered like the rest of its
-- settings.
------------------------------------------------------------------------------

GRANT UPDATE (is_late, revision_requested) ON requests TO app_runtime, app_worker;

GRANT UPDATE (deadline_rolls, late_submission_policy) ON groups TO app_runtime, app_worker;

-- Down Migration

DROP TRIGGER IF EXISTS shift_groups_guard_request_stability ON shift_groups;
DROP TRIGGER IF EXISTS requests_guard_transition_revision   ON requests;
DROP TRIGGER IF EXISTS requests_guard_initial_status        ON requests;

DROP FUNCTION IF EXISTS app_guard_shift_group_request_stability();
DROP FUNCTION IF EXISTS app_guard_request_revision_requested();
DROP FUNCTION IF EXISTS app_guard_request_initial_status();
DROP FUNCTION IF EXISTS app_request_initial_status(text);

-- The narrowing, reversed. The three arms per table are dropped and 0021's and
-- 0022's group-scope policies are recreated BYTE-FOR-BYTE from those files, so a
-- cycle test that asserts the schema is enforcing again is asserting about the
-- policy that was actually there before.

DROP POLICY IF EXISTS vacation_selections_group_administration      ON vacation_selections;
DROP POLICY IF EXISTS vacation_selections_group_read_any            ON vacation_selections;
DROP POLICY IF EXISTS vacation_selections_own                       ON vacation_selections;
DROP POLICY IF EXISTS request_shift_group_off_group_administration  ON request_shift_group_off;
DROP POLICY IF EXISTS request_shift_group_off_group_read_any        ON request_shift_group_off;
DROP POLICY IF EXISTS request_shift_group_off_own                   ON request_shift_group_off;
DROP POLICY IF EXISTS request_shift_preference_group_administration ON request_shift_preference;
DROP POLICY IF EXISTS request_shift_preference_group_read_any       ON request_shift_preference;
DROP POLICY IF EXISTS request_shift_preference_own                  ON request_shift_preference;
DROP POLICY IF EXISTS request_no_call_group_administration          ON request_no_call;
DROP POLICY IF EXISTS request_no_call_group_read_any                ON request_no_call;
DROP POLICY IF EXISTS request_no_call_own                           ON request_no_call;
DROP POLICY IF EXISTS request_time_off_group_administration         ON request_time_off;
DROP POLICY IF EXISTS request_time_off_group_read_any               ON request_time_off;
DROP POLICY IF EXISTS request_time_off_own                          ON request_time_off;
DROP POLICY IF EXISTS request_availability_group_administration     ON request_availability;
DROP POLICY IF EXISTS request_availability_group_read_any           ON request_availability;
DROP POLICY IF EXISTS request_availability_own                      ON request_availability;
DROP POLICY IF EXISTS requests_group_administration                 ON requests;
DROP POLICY IF EXISTS requests_group_read_any                       ON requests;
DROP POLICY IF EXISTS requests_own                                  ON requests;

CREATE POLICY requests_group_scope ON requests
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE POLICY request_availability_group_scope ON request_availability
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE POLICY request_time_off_group_scope ON request_time_off
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE POLICY request_no_call_group_scope ON request_no_call
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE POLICY request_shift_preference_group_scope ON request_shift_preference
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE POLICY request_shift_group_off_group_scope ON request_shift_group_off
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE POLICY vacation_selections_group_scope ON vacation_selections
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

-- FAD-55, reversed: 0021's body, verbatim.

CREATE OR REPLACE FUNCTION app_request_transition_is_legal(p_subtype text, p_from text, p_to text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT
        (p_from = 'draft' AND p_to = 'submitted')
     OR (p_from = 'submitted' AND p_to = 'under_review'
         AND p_subtype IN ('availability', 'time-off', 'no-call',
                           'shift-group-off', 'vacation-selection'))
     OR (p_from = 'submitted' AND p_to = 'accepted_as_input'
         AND p_subtype IN ('availability', 'shift-preference'))
     OR (p_from = 'under_review' AND p_to IN ('approved', 'denied')
         AND p_subtype IN ('availability', 'time-off', 'no-call',
                           'shift-group-off', 'vacation-selection'))
     OR (p_from = 'submitted' AND p_to = 'withdrawn')
     OR (p_from IN ('under_review', 'approved') AND p_to = 'withdrawn'
         AND p_subtype IN ('availability', 'time-off', 'no-call',
                           'shift-group-off', 'vacation-selection'))
     OR (p_from = 'accepted_as_input' AND p_to = 'withdrawn'
         AND p_subtype IN ('availability', 'shift-preference'))
     OR (p_from = 'approved' AND p_to = 'consumed_by_build'
         AND p_subtype IN ('availability', 'time-off', 'no-call', 'shift-group-off'))
     OR (p_from = 'accepted_as_input' AND p_to = 'consumed_by_build'
         AND p_subtype = 'shift-preference')
     OR (p_from = 'consumed_by_build' AND p_to = 'reflected_in_version'
         AND p_subtype IN ('availability', 'time-off', 'no-call',
                           'shift-preference', 'shift-group-off'))
     OR (p_from = 'approved' AND p_to = 'reflected_in_version'
         AND p_subtype = 'vacation-selection')
     OR (p_from = 'consumed_by_build' AND p_to = 'unsatisfied'
         AND p_subtype = 'shift-preference')
     OR (p_from = 'reflected_in_version' AND p_to = 'reversed'
         AND p_subtype = 'vacation-selection')
     OR (p_from IN ('submitted', 'under_review', 'accepted_as_input')
         AND p_to = 'expired')
     OR (p_from = 'approved' AND p_to = 'superseded_by_revision'
         AND p_subtype IN ('availability', 'time-off', 'no-call',
                           'shift-group-off', 'vacation-selection'));
$$;

ALTER TABLE requests DROP COLUMN IF EXISTS revision_requested;
ALTER TABLE requests DROP COLUMN IF EXISTS is_late;

ALTER TABLE groups DROP COLUMN IF EXISTS late_submission_policy;
ALTER TABLE groups DROP COLUMN IF EXISTS deadline_rolls;
