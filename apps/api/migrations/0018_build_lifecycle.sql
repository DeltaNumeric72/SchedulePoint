-- OPUS-M4-003 — the build lifecycle (doc 35 §6e; report 21 §4; SPEC-04 §2/§6/§7).
--
-- ADDITIVE. 0001..0017 are applied and are never edited. This file creates six
-- tables, four trigger functions and their triggers. No grant is revoked, no
-- constraint is relaxed, no policy is replaced, no stable ID is removed or
-- renumbered.
--
-- ## What this schema is for
--
-- A build is the only production mechanism by which a schedule is produced
-- (I-05). Everything about it that a scheduler, an operator, or an auditor may
-- later need to ask has to be a **row**, not an inference:
--
--   * which of the sixteen states it is in, and how it got there;
--   * which worker owns it right now, and at which **claim epoch** — so a stale
--     worker's answer to a question that has since been re-asked cannot
--     overwrite the current one;
--   * whether its candidate was independently re-validated, and what the
--     independent checker found;
--   * whether it was applied to a draft version, and to which one;
--   * whether it was cancelled, timed out, crashed, killed, or was refused —
--     each of which is a **different word** (FAD-34, SPEC-04 §2).
--
-- ## The sixteen states — report 21 §4 governs
--
--   draft_configuration · validating · readiness_check · queued · running ·
--   completed · completed_with_unmet_preferences · infeasible · failed ·
--   cancelled · reviewed · progressively_extended · approved ·
--   applied_to_draft_schedule · superseded · archived
--
-- `infeasible` and `failed` are different states and are never conflated: the
-- first is a statement about the **problem**, the second about the **system**.
-- A timeout is neither — it is `failed` with `termination_reason = 'deadline'`,
-- and the reason column is what keeps the distinction from being lost the first
-- time somebody needs one word for it.
--
-- ## Where this file departs from report 21's edge table, and why
--
-- Two departures, both from the packet's governing-text rulings (doc 35 §6e),
-- which record that **SPEC-04 supersedes doc 08 §§1–7 wherever they touch**:
--
--  1. **`infeasible → draft_configuration` is NOT a legal edge here.** Report 21
--     draws it as "relax constraints and retry". SPEC-04 §2 rules that "a retry
--     is a **new** `build_run` … **Retries are never in-place**". An in-place
--     edge would rewrite the record of a build that really did run and really
--     was infeasible. The retry is expressed instead as a new row carrying
--     `retry_of_build_run_id`, which preserves both facts.
--  2. **`queued → cancelled` IS a legal edge here**, where report 21 lists
--     cancellation only from `running`. SPEC-04 §2 makes cancellation a
--     guarantee rather than a hope. Without this edge, a scheduler who cancels a
--     build that has not yet been claimed has no outcome available except to
--     wait for the reaper to record it as `failed` — which would report a
--     deliberate human decision as a system fault, the exact conflation §2 and
--     FAD-34 exist to prevent. The edge is DISCLOSED as an extension rather than
--     assumed; the transition is guarded, audited, and carries
--     `termination_reason = 'user_cancelled'` like its sibling.
--
-- ## Why the transition machine lives in the database as well as the service
--
-- The service refuses illegal transitions and returns a typed error a route can
-- map. That is the readable control. It is not the *last* control, because it is
-- only reached by callers that go through it — and the probe that matters is the
-- one that does not: a psql session as `app_runtime`, an ORM write, a repair
-- script. `app_guard_build_run_transition` is evaluated for every UPDATE from
-- every role including the owner, so "a hard-violating candidate can never reach
-- `approved`" is a property of the database rather than a property of the code
-- paths somebody remembered to route through.
--
-- ## Fencing, stated exactly
--
-- `build_runs.claim_epoch` increments on every claim and on every reap. A worker
-- receives the epoch it claimed at and must present it when it writes a result.
-- The result-writing tables carry `claim_epoch` and
-- `app_guard_build_result_fencing` refuses any row whose epoch is not the run's
-- current one. A worker that was reaped, restarted, or superseded therefore
-- cannot land its answer — not because the service checks (it does), but because
-- the row will not go in.
--
-- The refusal is **recorded**, not merely denied: the service writes a
-- `build_run_events` row of kind `result_refused` before it re-raises, so a
-- stale worker is a visible fact rather than an absence.
--
-- ## Privacy
--
-- Nothing here carries clinical content or operator free text (I-07). Findings
-- carry rule keys, node kinds, identifiers, and system-authored detail strings
-- of the same class the solver's `StructuralFinding.detail` already carries.
-- `build_configurations.name` is administrative text of the same class as
-- `schedule_periods.name`. There is no reason field a user types into.
--
-- Normative sources:
--   doc 35 §6e         — the packet; its Required behaviour governs
--   report 21 §4/§5    — the sixteen states; progressive builds
--   SPEC-04 §2/§6/§7   — cancellation/timeout, D-4a..d, quality metrics
--   SPEC-05 §4/§7      — published immutability; cloning
--   doc 06 §3.3        — the `build_runs` column set (CAR-006)
--   migration 0009     — `app_guard_append_only`, the schedule spine
--   migration 0014     — composite tenant+group FK discipline
--   migration 0015     — state-transition guard precedent, idempotency domain
--   migration 0016     — the snapshot this lifecycle poses and re-poses

-- Up Migration

------------------------------------------------------------------------------
-- 1. build_configurations
--
-- A named, reusable statement of HOW to build a period: the solver parameters,
-- the dispatch timeout, the retry bound, and the heartbeat window the reaper
-- measures against. It is the unit D-4a scopes concurrency by, which is what
-- makes candidate comparison possible at all: two configurations may run for one
-- period concurrently (D-4b) and be compared afterwards (D-4c), where the old
-- D-4 allowed only one build per period and therefore nothing to compare.
--
-- `rule_set_id` from doc 06 §3.3 is deliberately NOT a column here. Rule
-- selection at M4 is resolved by the canonical-input assembly from the
-- **in-force rule revisions** (migration 0015); a configuration-scoped rule set
-- would be a second, different selection mechanism with no implementation behind
-- it, and inventing the column would make a reader believe one exists.
------------------------------------------------------------------------------

CREATE TABLE build_configurations (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id           uuid NOT NULL REFERENCES organizations (id),
    group_id                  uuid NOT NULL,
    period_id                 uuid NOT NULL,

    name                      text NOT NULL,

    -- SPEC-04 §4's recorded parameters. Every one is pinned per configuration so
    -- that "the same parameters" is a fact about a row rather than about whatever
    -- the process defaults happened to be on the day.
    random_seed               integer NOT NULL DEFAULT 0,
    num_search_workers        integer NOT NULL DEFAULT 1
        CHECK (num_search_workers > 0),
    max_time_seconds          numeric(10, 3) NOT NULL
        CHECK (max_time_seconds > 0),
    -- NULL means "not pinned", which is honestly not reproducible (EV-M0-SPC H-6).
    max_deterministic_time    numeric(10, 3)
        CHECK (max_deterministic_time IS NULL OR max_deterministic_time > 0),
    interleave_search         boolean NOT NULL DEFAULT true,

    -- The parent-enforced wall clock (SPEC-04 §2 mechanism 3) and the grace
    -- before the subprocess is killed.
    dispatch_timeout_ms       integer NOT NULL DEFAULT 60000
        CHECK (dispatch_timeout_ms > 0),
    -- The reaper's window. A `running` build whose heartbeat is older than this
    -- is dead, and saying so is more useful than leaving it running forever.
    heartbeat_timeout_ms      integer NOT NULL DEFAULT 120000
        CHECK (heartbeat_timeout_ms > 0),
    -- SPEC-04 §2 "Retry limit: bounded; exhausted retries surface to the
    -- scheduler with the last `termination_reason`".
    retry_limit               integer NOT NULL DEFAULT 2
        CHECK (retry_limit >= 0 AND retry_limit <= 10),

    created_by                uuid,
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT build_configurations_name_len CHECK (length(btrim(name)) BETWEEN 1 AND 120),

    CONSTRAINT build_configurations_tenant_identity
        UNIQUE (id, organization_id, group_id),
    -- doc 06 §3.3's `(period_id, name)`, tenant-led per X-11.
    CONSTRAINT build_configurations_name_unique_in_period
        UNIQUE (organization_id, group_id, period_id, name),

    CONSTRAINT build_configurations_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id),
    CONSTRAINT build_configurations_period_fk
        FOREIGN KEY (period_id, organization_id, group_id)
        REFERENCES schedule_periods (id, organization_id, group_id),
    -- An ACTOR column: organization-qualified only, never group-qualified. An
    -- organization administrator acting into a group is legitimate and a
    -- group-qualified FK would refuse it (0014's stated discipline).
    CONSTRAINT build_configurations_creator_fk
        FOREIGN KEY (created_by, organization_id)
        REFERENCES memberships (id, organization_id)
);

ALTER TABLE build_configurations ENABLE ROW LEVEL SECURITY;
ALTER TABLE build_configurations FORCE  ROW LEVEL SECURITY;

CREATE POLICY build_configurations_group_scope ON build_configurations
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE INDEX build_configurations_by_period
    ON build_configurations (organization_id, group_id, period_id, created_at DESC);

------------------------------------------------------------------------------
-- 2. build_runs — the state machine
------------------------------------------------------------------------------

CREATE TABLE build_runs (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id           uuid NOT NULL REFERENCES organizations (id),
    group_id                  uuid NOT NULL,
    period_id                 uuid NOT NULL,
    build_configuration_id    uuid NOT NULL,

    -- The draft version the problem is posed AGAINST — the one whose pins and
    -- manual assignments are the fixed inputs. NOT the version a selected
    -- candidate is written to; that is `applied_to_version_id` and it is a
    -- different, later, always-new version (I-18).
    source_version_id         uuid NOT NULL,

    state                     text NOT NULL DEFAULT 'draft_configuration',

    -- D-4c: what distinguishes one candidate from another in the comparison.
    candidate_label           text NOT NULL,

    -- Set once the readiness check has assembled and pinned the problem.
    snapshot_id               uuid,
    canonical_input_hash      text
        CHECK (canonical_input_hash IS NULL OR canonical_input_hash ~ '^[0-9a-f]{64}$'),

    -- SPEC-04 §2 retry chain. A retry is a NEW row; this is the link, never an
    -- in-place rewrite.
    retry_of_build_run_id     uuid,
    retry_attempt             integer NOT NULL DEFAULT 0 CHECK (retry_attempt >= 0),

    -- report 21 §5 / doc 08 §5 (V-23): the progressive chain and its protected
    -- inputs, recorded rather than inferred. `protected_assignment_identities`
    -- and not `..._ids`: protection is expressed against the STABLE identity, so
    -- it survives the clone into the next candidate version.
    parent_build_ids                  uuid[] NOT NULL DEFAULT '{}',
    protected_assignment_identities   uuid[] NOT NULL DEFAULT '{}',

    ---------------------------------------------------------------------------
    -- Claim ownership and fencing
    ---------------------------------------------------------------------------
    -- Monotonic. Incremented by every claim and by every reap, never reset. The
    -- number a worker was handed is the number it must present with its result.
    claim_epoch               integer NOT NULL DEFAULT 0 CHECK (claim_epoch >= 0),
    -- A worker identity token, not a credential and not a hostname a reader
    -- could act on. Free of tenant data by construction (the service generates it).
    claimed_by                text
        CHECK (claimed_by IS NULL OR claimed_by ~ '^[A-Za-z0-9_.:-]{1,64}$'),
    claimed_at                timestamptz,
    heartbeat_at              timestamptz,

    ---------------------------------------------------------------------------
    -- Outcome
    ---------------------------------------------------------------------------
    -- FAD-34 / SPEC-04 §2 vocabulary, unabridged. `NULL` while the run has not
    -- terminated; a terminated run always has one.
    termination_reason        text,
    -- The solver's own status, kept SEPARATE from the state so that FEASIBLE and
    -- UNKNOWN are never collapsed into "done" (SPEC-04 §2).
    solver_status             text,

    -- SPEC-04 §4 provenance, recorded per run because a worker change moves a
    -- result without any input moving.
    solver_version            text,
    solver_image_digest       text,
    compiler_version          text,
    platform_arch             text,
    solver_parameters         jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(solver_parameters) = 'object'),
    deterministic_worker_count integer
        CHECK (deterministic_worker_count IS NULL OR deterministic_worker_count > 0),
    random_seed               integer,
    reproducibility_mode      text
        CHECK (reproducibility_mode IS NULL
               OR reproducibility_mode IN ('deterministic', 'best-effort')),

    ---------------------------------------------------------------------------
    -- Itemised, explained refusals (report 21 §4's two "back to
    -- draft_configuration" edges). Codes and identifiers; no user free text.
    ---------------------------------------------------------------------------
    validation_findings       jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(validation_findings) = 'array'),
    readiness_findings        jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(readiness_findings) = 'array'),

    ---------------------------------------------------------------------------
    -- Selection (D-4d) and supersession
    ---------------------------------------------------------------------------
    applied_to_version_id     uuid,
    applied_at                timestamptz,
    superseded_by_build_run_id uuid,

    ---------------------------------------------------------------------------
    -- Idempotency, the D-17 one-domain form (0015's lesson, 0016's shape): the
    -- key alone answers "have I seen this key?"; the digest is what makes it
    -- answer "have I seen this key for THIS request?".
    ---------------------------------------------------------------------------
    idempotency_key           text NOT NULL
        CHECK (idempotency_key ~ '^[A-Za-z0-9_.-]{1,64}$'),
    semantic_request_digest   text NOT NULL
        CHECK (semantic_request_digest ~ '^[0-9a-f]{64}$'),

    initiated_by              uuid,
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now(),
    submitted_at              timestamptz,
    started_at                timestamptz,
    finished_at               timestamptz,

    CONSTRAINT build_runs_state_domain CHECK (state IN (
        'draft_configuration', 'validating', 'readiness_check', 'queued',
        'running', 'completed', 'completed_with_unmet_preferences', 'infeasible',
        'failed', 'cancelled', 'reviewed', 'progressively_extended', 'approved',
        'applied_to_draft_schedule', 'superseded', 'archived')),

    CONSTRAINT build_runs_termination_reason_domain CHECK (
        termination_reason IS NULL OR termination_reason IN (
            'completed', 'deadline', 'user_cancelled', 'killed', 'crashed', 'rejected')),

    CONSTRAINT build_runs_solver_status_domain CHECK (
        solver_status IS NULL OR solver_status IN (
            'OPTIMAL', 'FEASIBLE', 'INFEASIBLE', 'MODEL_INVALID', 'UNKNOWN',
            'CANCELLED', 'TIMEOUT', 'FAILED')),

    CONSTRAINT build_runs_candidate_label_len
        CHECK (length(btrim(candidate_label)) BETWEEN 1 AND 120),

    -- A claimed run names its claimant and its instant together, or names
    -- neither. A half-recorded claim is the state from which nobody can tell
    -- whether a worker exists.
    CONSTRAINT build_runs_claim_coherent CHECK (
        (claimed_by IS NULL AND claimed_at IS NULL AND heartbeat_at IS NULL)
     OR (claimed_by IS NOT NULL AND claimed_at IS NOT NULL AND heartbeat_at IS NOT NULL)),

    -- D-4d's other half: a run that names an applied version names when.
    CONSTRAINT build_runs_applied_coherent CHECK (
        (applied_to_version_id IS NULL AND applied_at IS NULL)
     OR (applied_to_version_id IS NOT NULL AND applied_at IS NOT NULL)),

    CONSTRAINT build_runs_tenant_identity UNIQUE (id, organization_id, group_id),

    CONSTRAINT build_runs_idempotent
        UNIQUE (organization_id, group_id, period_id, idempotency_key),

    CONSTRAINT build_runs_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id),
    CONSTRAINT build_runs_period_fk
        FOREIGN KEY (period_id, organization_id, group_id)
        REFERENCES schedule_periods (id, organization_id, group_id),
    CONSTRAINT build_runs_configuration_fk
        FOREIGN KEY (build_configuration_id, organization_id, group_id)
        REFERENCES build_configurations (id, organization_id, group_id),
    CONSTRAINT build_runs_source_version_fk
        FOREIGN KEY (source_version_id, organization_id, group_id, period_id)
        REFERENCES schedule_versions (id, organization_id, group_id, period_id),
    CONSTRAINT build_runs_applied_version_fk
        FOREIGN KEY (applied_to_version_id, organization_id, group_id, period_id)
        REFERENCES schedule_versions (id, organization_id, group_id, period_id),
    CONSTRAINT build_runs_snapshot_fk
        FOREIGN KEY (snapshot_id, organization_id, group_id)
        REFERENCES solver_input_snapshots (id, organization_id, group_id),
    CONSTRAINT build_runs_retry_of_fk
        FOREIGN KEY (retry_of_build_run_id, organization_id, group_id)
        REFERENCES build_runs (id, organization_id, group_id),
    CONSTRAINT build_runs_superseded_by_fk
        FOREIGN KEY (superseded_by_build_run_id, organization_id, group_id)
        REFERENCES build_runs (id, organization_id, group_id),
    CONSTRAINT build_runs_initiator_fk
        FOREIGN KEY (initiated_by, organization_id)
        REFERENCES memberships (id, organization_id)
);

ALTER TABLE build_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE build_runs FORCE  ROW LEVEL SECURITY;

CREATE POLICY build_runs_group_scope ON build_runs
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

-- D-4a (SPEC-04 §6). At most ONE non-terminal build per (period,
-- configuration). "Non-terminal" is spelled out rather than negated so that a
-- future state addition cannot silently join or leave the set: the five states
-- below are the ones in which a build is IN FLIGHT — being configured,
-- validated, checked for readiness, queued, or solved. Everything after that has
-- an answer, and a second build of the same configuration is then a legitimate
-- new question rather than a duplicate run of the same one.
CREATE UNIQUE INDEX build_runs_one_in_flight_per_configuration
    ON build_runs (organization_id, group_id, period_id, build_configuration_id)
    WHERE state IN ('draft_configuration', 'validating', 'readiness_check', 'queued', 'running');

-- D-4d (SPEC-04 §6). At most one build result may be applied to a given
-- schedule version. Tenant-led per X-11.
CREATE UNIQUE INDEX build_runs_one_result_per_applied_version
    ON build_runs (organization_id, group_id, applied_to_version_id)
    WHERE applied_to_version_id IS NOT NULL;

CREATE INDEX build_runs_by_period
    ON build_runs (organization_id, group_id, period_id, created_at DESC);

-- The reaper's access path: running builds ordered by how stale their heartbeat
-- is. Partial, because every other state is uninteresting to it.
CREATE INDEX build_runs_running_heartbeat
    ON build_runs (organization_id, group_id, heartbeat_at)
    WHERE state = 'running';

------------------------------------------------------------------------------
-- 3. build_run_events — the transition and refusal record
--
-- Append-only. This is NOT the audit chain and does not pretend to be: the
-- chain is `audit_events` (ADR-0019) and the service writes to it as well, LAST,
-- per FAD-37(2). This table is the build's own timeline — what the scheduler's
-- monitoring screen reads, and where a REFUSED stale-epoch result is recorded so
-- that a fenced worker is a visible fact rather than an absence.
------------------------------------------------------------------------------

CREATE TABLE build_run_events (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NOT NULL REFERENCES organizations (id),
    group_id            uuid NOT NULL,
    build_run_id        uuid NOT NULL,

    kind                text NOT NULL,
    from_state          text,
    to_state            text,
    -- The epoch in force when the event happened. For `result_refused` this is
    -- the epoch the REJECTED writer presented, and `current_claim_epoch` is the
    -- one that beat it — the pair is the whole story.
    claim_epoch         integer NOT NULL CHECK (claim_epoch >= 0),
    current_claim_epoch integer CHECK (current_claim_epoch IS NULL OR current_claim_epoch >= 0),

    -- A CODE from a closed vocabulary, never operator free text (I-07).
    reason              text
        CHECK (reason IS NULL OR reason ~ '^[a-z][a-z0-9_]{0,63}$'),
    -- Identifiers and scalars only.
    detail              jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(detail) = 'object'),

    actor_membership_id uuid,
    occurred_at         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT build_run_events_kind_domain CHECK (kind IN (
        'transition', 'result_refused', 'heartbeat_reaped', 'claim', 'cancel_requested')),

    CONSTRAINT build_run_events_tenant_identity
        UNIQUE (id, organization_id, group_id),
    CONSTRAINT build_run_events_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id),
    CONSTRAINT build_run_events_run_fk
        FOREIGN KEY (build_run_id, organization_id, group_id)
        REFERENCES build_runs (id, organization_id, group_id),
    CONSTRAINT build_run_events_actor_fk
        FOREIGN KEY (actor_membership_id, organization_id)
        REFERENCES memberships (id, organization_id)
);

ALTER TABLE build_run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE build_run_events FORCE  ROW LEVEL SECURITY;

CREATE POLICY build_run_events_group_scope ON build_run_events
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE INDEX build_run_events_by_run
    ON build_run_events (organization_id, group_id, build_run_id, occurred_at);

------------------------------------------------------------------------------
-- 4. build_run_results — one row per run that produced an answer
--
-- Written in the SAME transaction as the violations and the candidate rows
-- (doc 08 §4.1 "Result persistence: result + violations + quality metrics
-- written in one transaction"). Nothing here is written before the independent
-- checker has run: `usable` is the checker's verdict, not the worker's opinion.
------------------------------------------------------------------------------

CREATE TABLE build_run_results (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id          uuid NOT NULL REFERENCES organizations (id),
    group_id                 uuid NOT NULL,
    build_run_id             uuid NOT NULL,
    claim_epoch              integer NOT NULL CHECK (claim_epoch >= 0),

    solver_status            text NOT NULL,
    termination_reason       text NOT NULL,
    -- The hash the WORKER echoed. Kept beside the run's own
    -- `canonical_input_hash` rather than replacing it, because a mismatch is a
    -- rejection class and collapsing them would destroy the evidence for it.
    reported_input_hash      text NOT NULL
        CHECK (reported_input_hash ~ '^[0-9a-f]{64}$'),

    -- SPEC-04 §3.3 / §7. The INDEPENDENT checker's verdict and count. `usable`
    -- is false whenever the checker refused for ANY of its five classes.
    usable                   boolean NOT NULL,
    hard_violations          integer NOT NULL CHECK (hard_violations >= 0),
    assignment_count         integer NOT NULL CHECK (assignment_count >= 0),
    -- NULL where the solve returned no candidate at all — which is not the same
    -- fact as "a candidate with no assignments" (SPEC-04 §2 / the `null` vs `[]`
    -- distinction the outcome contract is built around).
    candidate_returned       boolean NOT NULL,

    objective_value          numeric(20, 6),
    -- SPEC-04 §7's measurable metrics, as a recorded object rather than columns,
    -- because every band except `hard_violations = 0` is UNDEFINED until the
    -- benchmark corpus is run and inventing columns for undefined bands would
    -- imply thresholds that do not exist.
    quality_metrics          jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(quality_metrics) = 'object'),
    objective_tiers          jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(objective_tiers) = 'array'),
    -- SPEC-04 §5's bounded tiers with honest degraded states.
    explanation_state        text
        CHECK (explanation_state IS NULL OR explanation_state IN (
            'EXPLAINED_EXACT', 'EXPLAINED_SUBSET', 'EXPLAINED_MINIMAL',
            'EXPLANATION_BUDGET_EXCEEDED', 'EXPLANATION_UNAVAILABLE')),
    explanation              jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(explanation) = 'object'),
    -- The checker's rejection classes, so "why is this unusable" survives.
    rejections               jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(rejections) = 'array'),

    elapsed_ms               integer NOT NULL CHECK (elapsed_ms >= 0),
    recorded_at              timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT build_run_results_status_domain CHECK (solver_status IN (
        'OPTIMAL', 'FEASIBLE', 'INFEASIBLE', 'MODEL_INVALID', 'UNKNOWN',
        'CANCELLED', 'TIMEOUT', 'FAILED')),
    CONSTRAINT build_run_results_reason_domain CHECK (termination_reason IN (
        'completed', 'deadline', 'user_cancelled', 'killed', 'crashed', 'rejected')),

    -- A candidate that was not returned cannot have been found usable, and a
    -- usable one cannot carry a hard violation. Both are also true in the
    -- service; both are enforced here because the service is not the only writer
    -- a probe can be.
    CONSTRAINT build_run_results_usable_is_earned CHECK (
        (NOT usable) OR (candidate_returned AND hard_violations = 0)),

    CONSTRAINT build_run_results_tenant_identity
        UNIQUE (id, organization_id, group_id),
    -- One result per run. A second result for a run is not an update, it is a
    -- different run (SPEC-04 §2: retries are never in-place).
    CONSTRAINT build_run_results_one_per_run
        UNIQUE (organization_id, group_id, build_run_id),
    CONSTRAINT build_run_results_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id),
    CONSTRAINT build_run_results_run_fk
        FOREIGN KEY (build_run_id, organization_id, group_id)
        REFERENCES build_runs (id, organization_id, group_id)
);

ALTER TABLE build_run_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE build_run_results FORCE  ROW LEVEL SECURITY;

CREATE POLICY build_run_results_group_scope ON build_run_results
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

------------------------------------------------------------------------------
-- 5. build_run_violations — every independently measured HARD finding
--
-- Both kinds are recorded, and both are fatal (FAD-27): a `breach` is a rule the
-- candidate broke; a `not-evaluable` is a HARD rule the checker could not check,
-- and "this version cannot be asserted to satisfy it" is the same answer for
-- publication purposes. `app_guard_build_run_transition` reads this table on the
-- `reviewed → approved` edge, which is what makes "zero unresolved hard
-- violations" a database fact.
------------------------------------------------------------------------------

CREATE TABLE build_run_violations (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NOT NULL REFERENCES organizations (id),
    group_id            uuid NOT NULL,
    build_run_id        uuid NOT NULL,
    claim_epoch         integer NOT NULL CHECK (claim_epoch >= 0),

    finding             text NOT NULL,
    -- The STABLE rule identifier (non-bypass rule 13).
    rule_key            text NOT NULL CHECK (length(btrim(rule_key)) BETWEEN 1 AND 200),
    node_kind           text NOT NULL CHECK (length(btrim(node_kind)) BETWEEN 1 AND 100),
    -- A snapshot handle, a membership id, or the literal 'rule'. Identifiers.
    field               text NOT NULL CHECK (length(field) BETWEEN 1 AND 200),
    -- System-authored, non-clinical, identifier-bearing (I-07). Never user text.
    explanation         text NOT NULL CHECK (length(explanation) BETWEEN 1 AND 2000),

    recorded_at         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT build_run_violations_finding_domain
        CHECK (finding IN ('breach', 'not-evaluable')),

    CONSTRAINT build_run_violations_tenant_identity
        UNIQUE (id, organization_id, group_id),
    CONSTRAINT build_run_violations_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id),
    CONSTRAINT build_run_violations_run_fk
        FOREIGN KEY (build_run_id, organization_id, group_id)
        REFERENCES build_runs (id, organization_id, group_id)
);

ALTER TABLE build_run_violations ENABLE ROW LEVEL SECURITY;
ALTER TABLE build_run_violations FORCE  ROW LEVEL SECURITY;

CREATE POLICY build_run_violations_group_scope ON build_run_violations
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE INDEX build_run_violations_by_run
    ON build_run_violations (organization_id, group_id, build_run_id);

------------------------------------------------------------------------------
-- 6. build_run_candidate_assignments — the candidate itself
--
-- The solver's answer, persisted so that selection can materialise it into a
-- NEW draft version without re-running the solve. **Persisting it is not the
-- same as making it usable**: the packet's "no candidate persisted usable before
-- independent validation" is honoured by `build_run_results.usable`, which the
-- `approved` guard requires — the rows exist for inspection and comparison
-- (D-4c) whether or not they may ever become a schedule.
--
-- `pick_position` (R-8): a solver-produced assignment has none (RK-RULING-04's
-- vacuous arm). A candidate row that MIRRORS a pinned fixed input carries the
-- real pick position of the assignment it mirrors, resolved at result-recording
-- time from the source version's snapshot row, so that selection reproduces the
-- pinned assignment faithfully rather than flattening it to NULL.
------------------------------------------------------------------------------

CREATE TABLE build_run_candidate_assignments (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id          uuid NOT NULL REFERENCES organizations (id),
    group_id                 uuid NOT NULL,
    build_run_id             uuid NOT NULL,
    claim_epoch              integer NOT NULL CHECK (claim_epoch >= 0),

    ordinal                  integer NOT NULL CHECK (ordinal >= 0),
    membership_id            uuid NOT NULL,
    date                     date NOT NULL,
    shift_type_id            uuid NOT NULL,
    location_id              uuid,

    -- The fixed input this row mirrors, when it mirrors one. NULL for a row the
    -- solver genuinely chose.
    mirrors_assignment_identity_id uuid,
    mirrors_pinned           boolean NOT NULL DEFAULT false,
    pick_position            integer CHECK (pick_position IS NULL OR pick_position >= 0),

    CONSTRAINT build_run_candidate_assignments_pin_coherent CHECK (
        mirrors_pinned = false OR mirrors_assignment_identity_id IS NOT NULL),
    -- R-8, stated as a constraint rather than as a comment: only a row that
    -- mirrors a real fixed input may carry a pick position, because only such a
    -- row has one to carry.
    CONSTRAINT build_run_candidate_assignments_pick_position_earned CHECK (
        pick_position IS NULL OR mirrors_assignment_identity_id IS NOT NULL),

    CONSTRAINT build_run_candidate_assignments_tenant_identity
        UNIQUE (id, organization_id, group_id),
    -- The candidate is a set: one membership on one date and shift type, once.
    -- The independent checker rejects a duplicate; this refuses to store one.
    CONSTRAINT build_run_candidate_assignments_unique_placement
        UNIQUE (organization_id, group_id, build_run_id, membership_id, date, shift_type_id),
    CONSTRAINT build_run_candidate_assignments_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id),
    CONSTRAINT build_run_candidate_assignments_run_fk
        FOREIGN KEY (build_run_id, organization_id, group_id)
        REFERENCES build_runs (id, organization_id, group_id),
    CONSTRAINT build_run_candidate_assignments_participant_fk
        FOREIGN KEY (membership_id, organization_id, group_id)
        REFERENCES memberships (id, organization_id, group_id),
    CONSTRAINT build_run_candidate_assignments_shift_type_fk
        FOREIGN KEY (shift_type_id, organization_id, group_id)
        REFERENCES shift_types (id, organization_id, group_id),
    CONSTRAINT build_run_candidate_assignments_location_fk
        FOREIGN KEY (location_id, organization_id, group_id)
        REFERENCES locations (id, organization_id, group_id)
);

ALTER TABLE build_run_candidate_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE build_run_candidate_assignments FORCE  ROW LEVEL SECURITY;

CREATE POLICY build_run_candidate_assignments_group_scope ON build_run_candidate_assignments
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE INDEX build_run_candidate_assignments_by_run
    ON build_run_candidate_assignments (organization_id, group_id, build_run_id, ordinal);

------------------------------------------------------------------------------
-- 7. The transition guard
--
-- Firing order is alphabetical by trigger name and it is load-bearing here:
-- `build_runs_guard_transition` sorts before `build_runs_zz_touch`, so the
-- legality decision is made before `updated_at` is stamped.
------------------------------------------------------------------------------

CREATE FUNCTION app_build_run_transition_is_legal(p_from text, p_to text) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT
        -- report 21 §4, edge for edge.
        (p_from = 'draft_configuration' AND p_to = 'validating')
     OR (p_from = 'validating'          AND p_to IN ('draft_configuration', 'readiness_check'))
     OR (p_from = 'readiness_check'     AND p_to IN ('draft_configuration', 'queued'))
     OR (p_from = 'queued'              AND p_to IN ('running', 'cancelled'))
     OR (p_from = 'running'             AND p_to IN ('completed',
                                                     'completed_with_unmet_preferences',
                                                     'infeasible', 'failed', 'cancelled'))
     OR (p_from IN ('completed', 'completed_with_unmet_preferences') AND p_to = 'reviewed')
     OR (p_from = 'reviewed'                AND p_to IN ('progressively_extended', 'approved'))
     OR (p_from = 'progressively_extended'  AND p_to = 'reviewed')
     OR (p_from = 'approved'                AND p_to = 'applied_to_draft_schedule')
        -- "any completed state → superseded: a later build for the period is
        -- approved". The completed FAMILY, not the single state.
     OR (p_from IN ('completed', 'completed_with_unmet_preferences', 'reviewed',
                    'progressively_extended', 'approved', 'applied_to_draft_schedule')
         AND p_to = 'superseded')
        -- "any terminal state → archived: period closed". Terminal = settled:
        -- every state in which the build has an answer. An in-flight build is
        -- not archived, it is cancelled or reaped first.
     OR (p_from IN ('completed', 'completed_with_unmet_preferences', 'infeasible',
                    'failed', 'cancelled', 'reviewed', 'progressively_extended',
                    'approved', 'applied_to_draft_schedule', 'superseded')
         AND p_to = 'archived');
$$;

REVOKE ALL ON FUNCTION app_build_run_transition_is_legal(text, text) FROM PUBLIC;

-- ...and then granted back to the roles that must call it, which is a different
-- statement from leaving it public.
--
-- The trigger below is NOT `SECURITY DEFINER` — it reads `build_run_violations`
-- and `build_run_results` and must do so as the INVOKER, under the invoker's RLS
-- context, so that the validation gate cannot be walked past by a role that
-- could not see the violations it is being judged on. That means the trigger
-- calls this predicate as `app_runtime`/`app_worker`, and a revoked-from-
-- everyone predicate would make EVERY transition fail with `permission denied`.
--
-- Granting it is safe in the strongest sense available: the function is
-- `LANGUAGE sql IMMUTABLE`, takes two `text` arguments, reads no table, and
-- returns a boolean. It is a lookup table with parentheses. It is also granted
-- to the read-only roles deliberately — an operator asking "was that transition
-- legal?" should not have to read the migration to find out.
GRANT EXECUTE ON FUNCTION app_build_run_transition_is_legal(text, text)
    TO app_runtime, app_worker, app_readonly_support, app_breakglass;

CREATE FUNCTION app_guard_build_run_transition() RETURNS trigger
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

REVOKE ALL ON FUNCTION app_guard_build_run_transition() FROM PUBLIC;

CREATE TRIGGER build_runs_guard_transition
    BEFORE UPDATE ON build_runs
    FOR EACH ROW EXECUTE FUNCTION app_guard_build_run_transition();

-- A build run is never deleted. History of a build that ran is not the kind of
-- thing an application gets to remove; `archived` is what "done with it" means.
CREATE FUNCTION app_guard_build_run_no_delete() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION
        'BUILD_RUN_NOT_DELETABLE: a build run is archived, never deleted'
        USING ERRCODE = 'restrict_violation';
END;
$$;

REVOKE ALL ON FUNCTION app_guard_build_run_no_delete() FROM PUBLIC;

CREATE TRIGGER build_runs_guard_no_delete
    BEFORE DELETE ON build_runs
    FOR EACH ROW EXECUTE FUNCTION app_guard_build_run_no_delete();

CREATE FUNCTION app_touch_build_run() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_touch_build_run() FROM PUBLIC;

-- `zz_` so it sorts AFTER every guard: the legality decision is taken against
-- the row the caller wrote, not against one this trigger has already amended.
CREATE TRIGGER build_runs_zz_touch
    BEFORE UPDATE ON build_runs
    FOR EACH ROW EXECUTE FUNCTION app_touch_build_run();

------------------------------------------------------------------------------
-- 8. The fencing guard
--
-- Every result-bearing row presents the epoch its writer was claimed at. It goes
-- in only if that epoch is the run's CURRENT one and the run is still `running`.
--
-- This is the control that a service check cannot be. The service checks too —
-- and returns a typed refusal a route can map, and records the refusal — but a
-- worker writing through any other path meets this.
------------------------------------------------------------------------------

CREATE FUNCTION app_guard_build_result_fencing() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_state text;
    v_epoch integer;
BEGIN
    SELECT state, claim_epoch INTO v_state, v_epoch
    FROM build_runs
    WHERE id = NEW.build_run_id;

    IF v_state IS NULL THEN
        RAISE EXCEPTION
            'BUILD_RUN_NOT_VISIBLE: %.% names a build run this session cannot see',
            TG_TABLE_NAME, TG_OP
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.claim_epoch <> v_epoch THEN
        RAISE EXCEPTION
            'BUILD_RESULT_FENCED: a result at claim epoch % cannot be written for a build run at epoch %',
            NEW.claim_epoch, v_epoch
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF v_state <> 'running' THEN
        RAISE EXCEPTION
            'BUILD_RESULT_NOT_RUNNING: a result is written while the build run is running, not in state %',
            v_state
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_guard_build_result_fencing() FROM PUBLIC;

CREATE TRIGGER build_run_results_guard_fencing
    BEFORE INSERT ON build_run_results
    FOR EACH ROW EXECUTE FUNCTION app_guard_build_result_fencing();

CREATE TRIGGER build_run_violations_guard_fencing
    BEFORE INSERT ON build_run_violations
    FOR EACH ROW EXECUTE FUNCTION app_guard_build_result_fencing();

CREATE TRIGGER build_run_candidate_assignments_guard_fencing
    BEFORE INSERT ON build_run_candidate_assignments
    FOR EACH ROW EXECUTE FUNCTION app_guard_build_result_fencing();

------------------------------------------------------------------------------
-- 9. Append-only on everything a result is made of
--
-- 0009's `app_guard_append_only`, reused rather than re-declared. It refuses
-- UPDATE and DELETE unconditionally, including for the OWNER — the arm that
-- matters, because the grants below already stop the runtime roles.
------------------------------------------------------------------------------

CREATE TRIGGER build_run_events_append_only
    BEFORE UPDATE OR DELETE ON build_run_events
    FOR EACH ROW EXECUTE FUNCTION app_guard_append_only();

CREATE TRIGGER build_run_results_append_only
    BEFORE UPDATE OR DELETE ON build_run_results
    FOR EACH ROW EXECUTE FUNCTION app_guard_append_only();

CREATE TRIGGER build_run_violations_append_only
    BEFORE UPDATE OR DELETE ON build_run_violations
    FOR EACH ROW EXECUTE FUNCTION app_guard_append_only();

CREATE TRIGGER build_run_candidate_assignments_append_only
    BEFORE UPDATE OR DELETE ON build_run_candidate_assignments
    FOR EACH ROW EXECUTE FUNCTION app_guard_append_only();

------------------------------------------------------------------------------
-- 10. Grants
--
-- `build_runs` is the only table with an UPDATE grant, and it is COLUMN-LEVEL
-- (0014's discipline): the columns a transition legitimately moves, and nothing
-- else. `state` is in the set because transitions are the point; the transition
-- guard is what makes the grant safe. Identity, the request binding, and the
-- pinned snapshot are NOT in the set, so the guard's identity clause is the
-- redundant control rather than the only one.
--
-- No table here has a DELETE grant for any role.
------------------------------------------------------------------------------

GRANT SELECT, INSERT ON build_configurations TO app_runtime, app_worker;
GRANT UPDATE (name, random_seed, num_search_workers, max_time_seconds,
              max_deterministic_time, interleave_search, dispatch_timeout_ms,
              heartbeat_timeout_ms, retry_limit, updated_at)
    ON build_configurations TO app_runtime, app_worker;
GRANT SELECT ON build_configurations TO app_readonly_support, app_breakglass;

GRANT SELECT, INSERT ON build_runs TO app_runtime, app_worker;
GRANT UPDATE (state, candidate_label, snapshot_id, canonical_input_hash,
              parent_build_ids, protected_assignment_identities,
              claim_epoch, claimed_by, claimed_at, heartbeat_at,
              termination_reason, solver_status, solver_version,
              solver_image_digest, compiler_version, platform_arch,
              solver_parameters, deterministic_worker_count, random_seed,
              reproducibility_mode, validation_findings, readiness_findings,
              applied_to_version_id, applied_at, superseded_by_build_run_id,
              retry_attempt, updated_at, submitted_at, started_at, finished_at)
    ON build_runs TO app_runtime, app_worker;
GRANT SELECT ON build_runs TO app_readonly_support, app_breakglass;

GRANT SELECT, INSERT ON build_run_events TO app_runtime, app_worker;
GRANT SELECT ON build_run_events TO app_readonly_support, app_breakglass;

GRANT SELECT, INSERT ON build_run_results TO app_runtime, app_worker;
GRANT SELECT ON build_run_results TO app_readonly_support, app_breakglass;

GRANT SELECT, INSERT ON build_run_violations TO app_runtime, app_worker;
GRANT SELECT ON build_run_violations TO app_readonly_support, app_breakglass;

GRANT SELECT, INSERT ON build_run_candidate_assignments TO app_runtime, app_worker;
GRANT SELECT ON build_run_candidate_assignments TO app_readonly_support, app_breakglass;

-- Down Migration

DROP TRIGGER IF EXISTS build_run_candidate_assignments_append_only ON build_run_candidate_assignments;
DROP TRIGGER IF EXISTS build_run_violations_append_only ON build_run_violations;
DROP TRIGGER IF EXISTS build_run_results_append_only ON build_run_results;
DROP TRIGGER IF EXISTS build_run_events_append_only ON build_run_events;

DROP TRIGGER IF EXISTS build_run_candidate_assignments_guard_fencing ON build_run_candidate_assignments;
DROP TRIGGER IF EXISTS build_run_violations_guard_fencing ON build_run_violations;
DROP TRIGGER IF EXISTS build_run_results_guard_fencing ON build_run_results;

DROP TRIGGER IF EXISTS build_runs_zz_touch ON build_runs;
DROP TRIGGER IF EXISTS build_runs_guard_no_delete ON build_runs;
DROP TRIGGER IF EXISTS build_runs_guard_transition ON build_runs;

DROP FUNCTION IF EXISTS app_guard_build_result_fencing();
DROP FUNCTION IF EXISTS app_touch_build_run();
DROP FUNCTION IF EXISTS app_guard_build_run_no_delete();
DROP FUNCTION IF EXISTS app_guard_build_run_transition();
DROP FUNCTION IF EXISTS app_build_run_transition_is_legal(text, text);

DROP TABLE IF EXISTS build_run_candidate_assignments;
DROP TABLE IF EXISTS build_run_violations;
DROP TABLE IF EXISTS build_run_results;
DROP TABLE IF EXISTS build_run_events;
DROP TABLE IF EXISTS build_runs;
DROP TABLE IF EXISTS build_configurations;
