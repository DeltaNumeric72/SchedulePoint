-- SPEC-08 §5.6's COMMIT, given the enforcing shape **FAD-59** rules
-- (OPUS-M5-004, doc 42 §5h).
--
-- **This migration is additive, and it says exactly what that means here.** It
-- creates one table, adds one CHECK to `vacation_selections`, WIDENS migration
-- 0009's two assignment-origin CHECKs by one value (§5 below), and adds seven
-- SELECT-only policy arms (§6). It relaxes nothing else, redefines no function,
-- narrows nothing, and widens no grant; 0021–0026 are not edited at all.
--
-- Two of those ARE replacements, and they are the one thing here the down
-- migration CANNOT undo: narrowing a CHECK domain over data the wider domain
-- admitted either fails or destroys rows, and the rows in question are
-- assignment snapshots a published version may carry (I-18). The down side
-- states that in full where it would otherwise have restored them; everything
-- else the down migration simply drops.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Why this table exists: D-23 as SPEC-08 spells it enforces NOTHING
-- ═══════════════════════════════════════════════════════════════════════════
--
-- SPEC-08 §5.4's invariant table gives D-23 as *"Commit is idempotent —
-- `UNIQUE (selection_id, committed_to_version_id)`"*, and migration 0022
-- declared exactly that, with an in-file statement saying so honestly:
--
--   > On THIS table `selection_id` is the primary key, so this unique key is
--   > implied by the primary key and enforces nothing further.
--
-- That was M5-000b finding (2), proven by test and carried forward by doc 42
-- §5b. **FAD-59 rules the enforcing shape** (2026-08-27, under the delegated
-- mandate), and this file is that ruling in SQL:
--
--   > commit idempotency is enforced by a COMMIT-COMMAND LEDGER, the D-26/R-17
--   > recorded-outcome pattern lifted from approvals to the VERSION level.
--
-- 0022's declared D-23 stays exactly as it is — unedited, still true, still
-- vacuous, and still honest about it. This file supersedes the *consequence* of
-- that honesty statement, not the statement: idempotency now has a mechanism,
-- and the mechanism is a row rather than a unique index on a primary key.
--
-- **The per-selection half of D-23 is the §5.3 matrix plus §7 below.**
-- `approved → committed` is the only edge that writes `committed_to_version_id`
-- and it is double-enforced per R-01 — the domain matrix
-- (`VACATION_SELECTION_TRANSITIONS`) and 0022's transition machinery both refuse
-- a second commit of a committed selection, because `committed → committed` is
-- not an edge in either copy.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 2. "Append-only by privilege", read STRICTLY — and what that forces
-- ═══════════════════════════════════════════════════════════════════════════
--
-- FAD-59: *"append-only by privilege (GRANT SELECT, INSERT and nothing else)"*.
-- **And nothing else** is the load-bearing clause, and it rules out the shape
-- this table's sibling uses.
--
-- `vacation_approval_commands` (0022 §4) is written at step 0 with a NULL
-- outcome and UPDATEd at the end of the transaction, which needs a column-level
-- `GRANT UPDATE (outcome)`. FAD-59 forecloses that grant here. So the ledger row
-- is written **once, at the end, complete**:
--
--   ```
--   SELECT the ledger row for this key   -- fast replay path: R-12, writes nothing
--   … the OFF snapshots, the selection updates, the derived root statuses …
--   INSERT the ledger row, outcome = 'committed'
--   COMMIT                               -- one transaction (FAD-59)
--   ```
--
-- **The UNIQUE key is the race control, not the early INSERT.** Two concurrent
-- commands carrying one key both pass the SELECT; both do the work; the second
-- blocks on `vacation_commit_commands_idempotent` and receives `23505` when the
-- first commits, and rolls back with it. Exactly one commit exists either way,
-- which is R-12's required outcome, and the property is a UNIQUE index rather
-- than an ordering somebody has to preserve.
--
-- **So `outcome` has one member today, and that is the truth rather than a
-- stub.** A refused commit leaves NO row — deliberately, and for the reason
-- M5-002 recorded when it made every non-approved `APPROVE-VACATION` outcome
-- roll back: a recorded failure outcome would make D-26's own answer permanent,
-- so a scheduler who fixed the cause and retried the same key would be told the
-- old refusal forever. **The ledger records commands that COMMITTED.** A future
-- outcome value is an added value in the domain below (additive; rule 13 is
-- about removal and renumbering, not about growth), and it arrives with a writer
-- that can record it without rolling back.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 3. The key is X-11-conformant, and the scope is the ORGANIZATION's
-- ═══════════════════════════════════════════════════════════════════════════
--
-- FAD-59 names the key: `UNIQUE (organization_id, idempotency_key)`. Two things
-- follow and both are deliberate:
--
--   * **X-11 is satisfied on the column list**, under the narrowed
--     name-independent exemption that closed FU-19 at M5-H — the tenant column
--     LEADS the key, so a caller choosing a key learns nothing about another
--     tenant's rows from a `23505`. The PRIMARY KEY is `(id, organization_id)`
--     for the same reason and in the same shape as 0024's and 0026's.
--   * **The namespace is the organization, not the period.** One key means one
--     command, org-wide, so a retry that names a different period under the same
--     key is a DIFFERENT command wearing a used name and is refused. That is the
--     stricter reading and it is the one D-7 already took for `requests`
--     (`UNIQUE (membership_id, idempotency_key)`): an idempotency key that means
--     two commands is the failure mode idempotency exists to prevent.
--
-- `idempotency_key`'s shape is 0022's, character for character
-- (`^[A-Za-z0-9_.-]{1,64}$`), because it is the same kind of thing and two
-- spellings of one rule is one spelling too many.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 4. What the row RECORDS, and what it deliberately does not
-- ═══════════════════════════════════════════════════════════════════════════
--
-- FAD-59's list, item for item: *"organization, period, target DRAFT version,
-- acting membership, instant, outcome"*. Every one is a column below and there
-- are no others beyond the tenant/identity columns the house pattern requires.
--
-- **No reason text, in any column.** Commit takes no reason (§5.6 asks for one
-- on REVERSAL, not on commit), and this table is not the place a future one
-- would go: I-07 and non-bypass rule 9 keep free text out of the paths that
-- travel, and a ledger row is read by the replay path on every retry.
--
-- **`target_version_id` is a FK to `schedule_versions` and is NOT constrained to
-- be a draft here.** The draft-only rule is §5.6's and SPEC-05's, it is a rule
-- about the version's state at the INSTANT of the commit, and a state can move
-- afterwards — a version that was a draft when it was committed to and is
-- published now is the NORMAL end state, not a violation. A CHECK could not
-- express the instant, and a trigger that re-asserted it later would refuse
-- every publication. The rule is enforced where it can be true: in the commit
-- transaction, against the version row read in that transaction (I-19), and
-- refused BY NAME (`COMMIT_TARGET_NOT_DRAFT`) rather than by a constraint
-- violation a caller cannot act on.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 5. FAD-59's CHECK on `vacation_selections` — the other half the ruling names
-- ═══════════════════════════════════════════════════════════════════════════
--
--   > plus a CHECK making `(status = 'committed') = (committed_to_version_id IS
--   > NOT NULL)` — the `vacation_selections.request_id` CHECK precedent.
--
-- The precedent is exact: 0022 already pins
-- `(status = 'available') = (request_id IS NULL)` in both directions, for the
-- same reason — a nullable column whose presence MEANS a status is a column that
-- can disagree with that status, and the disagreement is invisible in every row
-- listing.
--
-- **The consequence, stated here rather than discovered later: a REVERSAL clears
-- `committed_to_version_id`.** §5.6's reversal is `committed → reversed`, so the
-- left side of the equality becomes false and the right side must follow. The
-- version the week was committed to is therefore not readable off the selection
-- after a reversal — and it is not lost, because three other records carry it:
-- the ledger row below, the reversal's audit event (an id in the payload, which
-- is what a payload may carry), and the OFF assignment snapshots themselves,
-- which stay exactly where they are. **I-18: reversal never edits a published
-- version**; it raises a revision request and the scheduler decides.
--
-- Nothing in the database violates this CHECK at the moment it is added:
-- `committed_to_version_id` has had no writer since 0022 created it — M5-004 is
-- its first — so the constraint is added over a column that is NULL everywhere.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 6. `vacation_commit` joins the assignment ORIGIN vocabulary — the one thing
--    here that is NOT reversible
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Up-migration section 5 adds `vacation_commit` to migration 0009's origin
-- domain, because §5.6's OFF snapshots are placed by a mechanism 0009's
-- four-value domain does not name, and a snapshot's origin FREEZES the moment
-- its version publishes (I-18, D-15a) — so the label has to be true the first
-- time or it is never true. That section carries the measurement the decision
-- rests on, and the down migration carries the reason it is the one part of
-- this file that cannot be undone.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 7. The SOLVER-PROJECTION read plane
-- ═══════════════════════════════════════════════════════════════════════════
--
-- SPEC-08 §6's projection has to be ASSEMBLED from tables migration 0023
-- narrowed to `SENSITIVE-PII`, and assembling it on the caller's own visibility
-- would produce a build input carrying the builder's absences and nobody else's
-- — a solver that schedules every other member on their approved day off, with
-- §6 (the only gate) having said nothing because the row it would have refused
-- was never visible to be projected. Up-migration section 6 is migration 0012's
-- enforcement-read mechanism applied to that, with 0012's three confinement
-- properties unchanged and its reasoning quoted where it differs. It is read
-- there rather than summarised here, because a widened read plane is the last
-- thing in this file a reader should meet as a footnote.

-- Up Migration

------------------------------------------------------------------------------
-- 1. vacation_commit_commands — FAD-59's ledger
------------------------------------------------------------------------------

CREATE TABLE vacation_commit_commands (
    id                     uuid NOT NULL DEFAULT gen_random_uuid(),
    organization_id        uuid NOT NULL REFERENCES organizations (id),
    group_id               uuid NOT NULL,

    -- FAD-59's "period" and "target DRAFT version". The period is what the
    -- command is ABOUT; the version is where its OFF snapshots landed.
    vacation_period_id     uuid NOT NULL,
    target_version_id      uuid NOT NULL,

    -- FAD-59's "acting membership". Never a system actor: committing a vacation
    -- round is something a person does, and the RLS `WITH CHECK` arm below
    -- additionally requires this to BE the acting membership, so the recorded
    -- actor cannot be somebody the actor was not (0026's mechanism, one table
    -- over).
    acting_membership_id   uuid NOT NULL,

    -- FAD-59's key. Header §3 on why the namespace is the organization's.
    idempotency_key        text NOT NULL,

    -- FAD-59's "instant".
    received_at            timestamptz NOT NULL DEFAULT now(),

    -- FAD-59's "outcome". Header §2 on why it has one member and why that is
    -- the honest shape rather than a stub.
    outcome                text NOT NULL,

    created_at             timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT vacation_commit_commands_pk PRIMARY KEY (id, organization_id),

    CONSTRAINT vacation_commit_commands_outcome_domain
        CHECK (outcome IN ('committed')),

    CONSTRAINT vacation_commit_commands_key_shape
        CHECK (idempotency_key ~ '^[A-Za-z0-9_.-]{1,64}$'),

    --------------------------------------------------------------------------
    -- FAD-59's UNIQUE, verbatim, and the ONLY thing that makes commit
    -- idempotent. Header §2: the race control is this index, not an early
    -- INSERT.
    --------------------------------------------------------------------------
    CONSTRAINT vacation_commit_commands_idempotent
        UNIQUE (organization_id, idempotency_key),

    CONSTRAINT vacation_commit_commands_tenant_identity
        UNIQUE (id, organization_id, group_id),

    CONSTRAINT vacation_commit_commands_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id),
    CONSTRAINT vacation_commit_commands_period_fk
        FOREIGN KEY (vacation_period_id, organization_id, group_id)
        REFERENCES vacation_periods (id, organization_id, group_id),
    CONSTRAINT vacation_commit_commands_version_fk
        FOREIGN KEY (target_version_id, organization_id, group_id)
        REFERENCES schedule_versions (id, organization_id, group_id),
    CONSTRAINT vacation_commit_commands_actor_fk
        FOREIGN KEY (acting_membership_id, organization_id)
        REFERENCES memberships (id, organization_id)
);

ALTER TABLE vacation_commit_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE vacation_commit_commands FORCE  ROW LEVEL SECURITY;

------------------------------------------------------------------------------
-- 2. The policies
--
-- ONE administration arm and one read arm, and the asymmetry is the same one
-- 0024 drew for `approvals`: **committing a vacation round is not a self-scoped
-- act.** There is no own-arm here at all — a member has no version to commit to
-- and no round to commit — which is why this table's shape differs from
-- `request_comments`'s and matches `approvals`'s write side.
--
-- The `WITH CHECK` pins the ACTOR, exactly as 0026's two write arms do: the
-- recorded `acting_membership_id` must be the acting membership, so no path can
-- forge who committed the round. It does not pin the outcome, because the CHECK
-- constraint above already admits one value.
--
-- These are ROW predicates, not operation gates. Whether a caller may perform
-- the commit AT ALL is the ROUTE's declared action key (`vacation.commit`),
-- evaluated by SPEC-06's four layers against current state inside the same
-- transaction (I-19). RLS decides which ROWS; PO-DEC-02's layers decide which
-- OPERATIONS — the division 0023 recorded and 0024 and 0026 restated.
------------------------------------------------------------------------------

CREATE POLICY vacation_commit_commands_group_read ON vacation_commit_commands
    FOR SELECT
    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
       AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
       AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
       AND (app_acting_membership_holds('requests.read_any')
         OR app_acting_membership_holds('requests.administer')));

CREATE POLICY vacation_commit_commands_group_administration ON vacation_commit_commands
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND app_acting_membership_holds('requests.administer'))
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND acting_membership_id = nullif(current_setting('app.membership_id', true), '')::uuid
            AND app_acting_membership_holds('requests.administer'));

-- The replay lookup's index: one key, one row, org-scoped. Named by the
-- question it answers rather than by its columns.
CREATE INDEX vacation_commit_commands_by_period
    ON vacation_commit_commands (organization_id, group_id, vacation_period_id, received_at DESC);

------------------------------------------------------------------------------
-- 3. Grants — SELECT and INSERT for the runtime, and deliberately nothing else
--
-- FAD-59's "GRANT SELECT, INSERT and nothing else", read strictly (header §2).
-- There is no `GRANT UPDATE` on any column — not even on `outcome`, which is
-- where this table differs from `vacation_approval_commands` — and no
-- `GRANT DELETE` for any runtime role. Adding either later would silently remove
-- the append-only property, so the absence is stated here as the rule rather
-- than left to be inferred from a missing line.
--
-- `app_worker` gets SELECT and not INSERT: no job commits a vacation round.
-- A commit is a scheduler's deliberate act with a capability behind it, and an
-- INSERT grant with no writer is the mirror of the rule M5-001 recorded for
-- capability keys — a grant with no user is a grant that lies.
------------------------------------------------------------------------------

GRANT SELECT, INSERT ON vacation_commit_commands TO app_runtime;
GRANT SELECT ON vacation_commit_commands TO app_worker, app_readonly_support, app_breakglass;

------------------------------------------------------------------------------
-- 4. FAD-59's per-selection CHECK (header §5)
--
-- Added to 0022's table rather than edited into 0022's file: additive, and
-- 0021–0026 stay byte-identical.
------------------------------------------------------------------------------

ALTER TABLE vacation_selections
    ADD CONSTRAINT vacation_selections_committed_version_coherent
    CHECK ((status = 'committed') = (committed_to_version_id IS NOT NULL));

------------------------------------------------------------------------------
-- 5. `vacation_commit` joins the ASSIGNMENT ORIGIN vocabulary
--
-- §5.6's commit creates OFF assignment snapshots, and migration 0009's origin
-- domain is `('manual', 'clone', 'solver', 'picklist')` — four mechanisms, none
-- of which is a vacation commit. FAD-44(1) made `origin` mean "which mechanism
-- placed this assignment", and the identity carries it too so that "was this
-- assignment ever solver-made?" is answerable without reading every snapshot.
--
-- **Recording a committed vacation day as `manual` would be false, and the
-- falsehood would be PERMANENT.** A snapshot in a version that later publishes
-- is immutable (I-18, D-15a): nothing can go back and relabel it. So the value
-- is added here, with the commit that creates the rows, rather than deferred to
-- a packet that could only fix the labels it had not already frozen.
--
-- **Measured before it was decided** (doc 42 §5h's FU-28 rule): nothing in the
-- system BRANCHES on an origin value except `apps/web/src/schedule/grid-model.ts`,
-- which marks a cell "cloned" when the origin is `clone` and says nothing about
-- the others; the Python worker never reads the field at all (it validates
-- `fixedAssignments` as a list and nothing inside it); and
-- `schedule-authoring.route.ts`'s grid projection already coerces an
-- unrecognised origin to `manual` for the wire — which is why the value is added
-- to the wire vocabulary in the same change rather than left to that fallback,
-- where it would be silently mislabelled at exactly one surface.
--
-- The two CHECKs are REPLACED rather than dropped: the down migration restores
-- 0009's originals byte-for-byte, which is the standing rule for a replaced
-- constraint.
------------------------------------------------------------------------------

ALTER TABLE assignment_identities
    DROP CONSTRAINT assignment_identities_origin_domain;
ALTER TABLE assignment_identities
    ADD CONSTRAINT assignment_identities_origin_domain
        CHECK (origin IN ('manual', 'clone', 'solver', 'picklist', 'vacation_commit'));

ALTER TABLE assignment_snapshots
    DROP CONSTRAINT assignment_snapshots_origin_domain;
ALTER TABLE assignment_snapshots
    ADD CONSTRAINT assignment_snapshots_origin_domain
        CHECK (origin IN ('manual', 'clone', 'solver', 'picklist', 'vacation_commit'));

------------------------------------------------------------------------------
-- 6. The SOLVER-PROJECTION read plane — migration 0012's mechanism, seven tables
--    over (SPEC-08 §6; FAD-23's warning; FAD-25's standing prohibition)
--
-- ## The problem, which is 0012's exactly
--
-- SPEC-08 §6's projection is *"the solver reads a projection, never the raw
-- tables"* — but the projection has to be ASSEMBLED from those tables, inside
-- the build's own transaction, and migration 0023 narrowed them to
-- `SENSITIVE-PII`: a caller sees their OWN requests, plus the group's only with
-- `requests.read_any` or `requests.administer`.
--
-- A build input assembled on the CALLER's visibility would therefore carry the
-- builder's own absences and NOBODY ELSE'S. The solver would then schedule
-- every other member on their approved day off, with §6 — the only gate — having
-- said nothing, because the row it would have refused was never visible to be
-- projected. That is FAD-23's warning ("an access-control artefact manufacturing
-- a false … statement") in the DANGEROUS direction, and it is the same shape
-- 0012 §5 records for the publication gate's qualification reads.
--
-- **Requiring every builder to hold `requests.read_any` instead is foreclosed**:
-- that makes a build capability imply a read capability, which FAD-25 adopted as
-- a standing prohibition, and it would hand every scheduler who can start a
-- build the whole group's request history as a side effect.
--
-- ## The mechanism, and its confinement — 0012's three properties, unchanged
--
--   1. **Tenant confinement is unchanged.** Each policy below carries the same
--      conjunctive organization+group predicate its siblings do. No tenant
--      boundary moves, RLS stays ENABLED and FORCEd, every existing policy
--      stands, and each of these is one more additive OR-arm. This is not
--      "disabling RLS" (non-bypass rule 3).
--   2. **Only server code can set the token**, through
--      `set_config(name, value, true)` — the sole permitted spelling (non-bypass
--      rule 2), transaction-local, never reachable from anything
--      client-supplied. `apps/api/src/solver/request-projection.ts` opens it
--      immediately before the projection reads and clears it in a `finally`,
--      exactly as `canonical-input.ts` already does for
--      `qualification_requirements`.
--   3. **What leaves the computation is the PROJECTION** — a membership id, a
--      date, and where §6's row carries one, a shift-type or shift-group id.
--      Never a status, never a subtype, never a reason code, never a comment,
--      never an `override_reason`. §6's own design is that the model cannot see
--      a status; the read plane does not widen what the projection carries, only
--      which rows it is computed FROM.
--
-- **A DIFFERENT token from 0012's**, deliberately: `solver_projection` opens
-- these seven tables and `qualification_requirements` opens
-- `qualification_holdings`, and neither opens the other's. One token for both
-- would make the narrower purpose carry the wider plane.
--
-- The `nullif()` guard is the A-03b spelling discipline every policy in this
-- schema follows (and `roles-and-schema.test.ts` scans `pg_policies` to prove
-- it): an unset or empty setting becomes NULL, `NULL = 'token'` is NULL, and the
-- arm admits nothing.
------------------------------------------------------------------------------

CREATE POLICY requests_solver_projection_read ON requests
    FOR SELECT
    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
       AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
       AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
       AND nullif(current_setting('app.solver_projection_read', true), '') = 'solver_projection');

CREATE POLICY request_availability_solver_projection_read ON request_availability
    FOR SELECT
    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
       AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
       AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
       AND nullif(current_setting('app.solver_projection_read', true), '') = 'solver_projection');

CREATE POLICY request_time_off_solver_projection_read ON request_time_off
    FOR SELECT
    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
       AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
       AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
       AND nullif(current_setting('app.solver_projection_read', true), '') = 'solver_projection');

CREATE POLICY request_no_call_solver_projection_read ON request_no_call
    FOR SELECT
    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
       AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
       AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
       AND nullif(current_setting('app.solver_projection_read', true), '') = 'solver_projection');

CREATE POLICY request_shift_preference_solver_projection_read ON request_shift_preference
    FOR SELECT
    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
       AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
       AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
       AND nullif(current_setting('app.solver_projection_read', true), '') = 'solver_projection');

CREATE POLICY request_shift_group_off_solver_projection_read ON request_shift_group_off
    FOR SELECT
    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
       AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
       AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
       AND nullif(current_setting('app.solver_projection_read', true), '') = 'solver_projection');

CREATE POLICY vacation_selections_solver_projection_read ON vacation_selections
    FOR SELECT
    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
       AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
       AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
       AND nullif(current_setting('app.solver_projection_read', true), '') = 'solver_projection');

-- Down Migration

------------------------------------------------------------------------------
-- §5's two CHECKs are DELIBERATELY NOT restored, and this is the one place in
-- this file where the down side does less than the up side.
--
-- **Measured, not assumed.** A first version of this down migration did restore
-- migration 0009's four-value text byte-for-byte, and it FAILED — in the
-- composed unit run, against real rows:
--
--     check constraint "assignment_snapshots_origin_domain" of relation
--     "assignment_snapshots" is violated by some row
--
-- and it took eighteen test files down with it, because a down migration that
-- throws leaves the chain half-reversed.
--
-- **The reason is structural rather than incidental: a WIDENED CHECK is not
-- reversible.** Narrowing a domain over data the wider domain admitted has
-- exactly three outcomes and two of them are unacceptable here:
--
--   1. it FAILS while any `vacation_commit` snapshot exists — the observed one;
--   2. it succeeds after DELETING those rows — which would delete assignment
--      snapshots that a PUBLISHED version may carry. I-18 (non-bypass rule 5)
--      forbids exactly that, and a down migration is not the place to make an
--      exception to it;
--   3. it succeeds as `NOT VALID` — which restores the constraint's forward
--      behaviour but not its state, so it would not be the byte-for-byte
--      restore the rule asks for either, while looking like one.
--
-- So the down leaves the domain WIDENED, and the residue is inert: after a
-- reversal nothing writes `vacation_commit` (the writer is 0027's own commit
-- transaction, and the code that calls it is not in a tree where 0027 is
-- reversed), and a CHECK that admits one unused value constrains nothing less
-- than 0009's did about the four that are used. Re-applying the up migration is
-- idempotent in effect: it replaces the widened constraint with an identical
-- widened constraint.
--
-- **The honest statement, because it belongs in this file rather than in a
-- report:** the ledger, the per-selection CHECK and the read plane in this
-- migration ARE reversible; the origin vocabulary is NOT. Migration 0027 is
-- therefore reversible in every respect except the one that would require
-- destroying schedule rows to reverse.
------------------------------------------------------------------------------

DROP POLICY IF EXISTS vacation_selections_solver_projection_read      ON vacation_selections;
DROP POLICY IF EXISTS request_shift_group_off_solver_projection_read  ON request_shift_group_off;
DROP POLICY IF EXISTS request_shift_preference_solver_projection_read ON request_shift_preference;
DROP POLICY IF EXISTS request_no_call_solver_projection_read          ON request_no_call;
DROP POLICY IF EXISTS request_time_off_solver_projection_read         ON request_time_off;
DROP POLICY IF EXISTS request_availability_solver_projection_read     ON request_availability;
DROP POLICY IF EXISTS requests_solver_projection_read                 ON requests;

ALTER TABLE vacation_selections
    DROP CONSTRAINT IF EXISTS vacation_selections_committed_version_coherent;

DROP POLICY IF EXISTS vacation_commit_commands_group_administration ON vacation_commit_commands;
DROP POLICY IF EXISTS vacation_commit_commands_group_read           ON vacation_commit_commands;

DROP TABLE IF EXISTS vacation_commit_commands;
