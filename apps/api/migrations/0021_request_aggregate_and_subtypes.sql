-- SPEC-08 §1 and §2 — the request aggregate root, five of its six constrained
-- subtype tables, and the per-subtype transition matrices, enforced in the
-- database (OPUS-M5-000b, doc 42 §5b Part A).
--
-- The sixth subtype table (`vacation_selections`) and the vacation carriers
-- arrive in 0022, because they need `vacation_periods` and `vacation_grants`
-- underneath them and this file creates neither. The two files are ONE design
-- split across two migrations for dependency order, not two designs.
--
-- **This migration creates schema and nothing else.** There is no service, no
-- route, no lifecycle transaction and no writer. Doc 42 §5b is explicit about
-- why: every table, constraint and trigger the request/vacation lifecycles
-- stand on lands and is PROVEN before any transaction exists, so M5-001/002/003
-- build on a schema whose invariants are already enforced and already tested.
-- A schema that arrives with its first writer is a schema whose constraints
-- were shaped by that writer's convenience.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. What CAR-011 found, and what the shape below is answering
-- ═══════════════════════════════════════════════════════════════════════════
--
-- One `requests.status` covered five subtypes whose lifecycles genuinely
-- differ; subtype fields were nullable columns on the single table with no
-- per-type constraint; and `applied` meant three different things depending on
-- which subtype you were looking at. The specific reachable defect SPEC-08
-- names: a `shift-preference` row could reach a terminal state **with no shift
-- type**, because the column was nullable for everyone.
--
-- The answer is one aggregate root carrying only what EVERY subtype has, and a
-- constrained subtype table per subtype:
--
--   D-7    UNIQUE (membership_id, idempotency_key)          (retained)
--   D-18   exactly one subtype row per request              (new)
--   D-19   required non-null / prohibited absent per §1.2   (new)
--   D-20   per-subtype status domain on the root            (new)
--   §2     per-subtype transition matrix, as a trigger      (new)
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 2. D-19's prohibition half is ABSENCE, not an always-NULL column
--    **A DECLARED DESIGN DECISION taken at latitude — read this before
--    reviewing §1.2 against the tables below.**
-- ═══════════════════════════════════════════════════════════════════════════
--
-- SPEC-08 D-19 reads "`CHECK` per subtype table: every required field non-null
-- and **every prohibited field null**". Read literally, that asks each subtype
-- table to CARRY the columns §1.2 prohibits for it and constrain them to NULL —
-- six such columns would land on `vacation_selections` alone.
--
-- They are not carried. A prohibited field is absent from its subtype table, so
-- the statement that writes one is refused with `undefined_column` (42703)
-- before any row is evaluated. The reasons, in order of weight:
--
--   1. A column whose only legal value is NULL is the CAR-011 defect in a
--      smaller box. It is a box someone can later decide to use, and the only
--      thing standing in the way is exactly the kind of per-type CHECK whose
--      absence CAR-011 was filed about.
--   2. Absence cannot be relaxed. `ALTER TABLE … DROP CONSTRAINT` un-prohibits a
--      CHECK; restoring a column is a migration, which the review and the RLS
--      pairing gate both see.
--   3. It is what doc 06 §3.4 already describes. The key-field list there for
--      each subtype table contains its REQUIRED fields and no prohibited one.
--
-- What this gives up, stated plainly rather than glossed: for a prohibited
-- field the rejecting mechanism is the schema rather than a constraint named
-- D-19, and SPEC-08's R-16 names D-19 ("D-19 rejects a vacation row … carrying
-- `shift_type_id`"). Two things keep that from being a weakening. The row is
-- still REJECTED, earlier and unconditionally. And the prohibition is a
-- TESTED, ENUMERATED property rather than an accident of which columns someone
-- happened to declare: the populated-cycle suite walks §1.2's prohibited list
-- subtype by subtype and asserts the column does not exist, so a later ALTER
-- that added one back would fail the battery.
--
-- D-19's REQUIRED half is a real constraint on every table below — `NOT NULL`
-- where §1.2 says required, plus `request_time_off`'s exactly-one-of.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 2a. X-11 — every unique key on these tables carries `organization_id`
--     **A DECLARED DESIGN DECISION covering NINE constraints across 0021 and
--     0022. It is one analysis; this is where it lives.**
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Unique and primary-key checks BYPASS row-level security. So a unique key on a
-- tenant table whose values a caller can CHOOSE is an existence oracle for rows
-- the caller cannot see: the 23505 names a collision with an invisible row, and
-- that is a disclosure no policy prevents. X-11 is the rule, and
-- `test/tenancy/roles-and-schema.test.ts` asserts it over every table registered
-- in `TENANT_TABLES`, with one narrow, documented exemption
-- (`users_login_email_unique`, global by PO-DEC-06).
--
-- SPEC-08 spells four of its constraints without the tenant column, and doc 06
-- §3.4 spells the five subtype tables' key as `(request_id)`:
--
--   D-7   `UNIQUE (membership_id, idempotency_key)`                 on `requests`
--   D-18  `UNIQUE (request_id)`                     on each of the six subtypes
--   D-23  `UNIQUE (selection_id, committed_to_version_id)`  (0022)
--   D-26  `UNIQUE (selection_id, approval_idempotency_key)` (0022)
--
-- **`organization_id` is APPENDED to every one of them**, the spec's columns
-- kept first, and each constraint keeps its name and its meaning. Three things
-- make that the right call rather than a redefinition:
--
--   1. **It is the same constraint.** In each case a composite foreign key makes
--      `organization_id` functionally determined by the leading column —
--      `memberships.id` and `requests.id` are primary keys, so two `requests`
--      rows sharing a `membership_id` necessarily share an `organization_id`,
--      and two subtype rows sharing a `request_id` necessarily do too. Appending
--      a functionally determined column changes which rows collide not at all.
--      D-18's `UNIQUE (request_id)` holds derivationally: the pair is unique
--      exactly when `request_id` alone is.
--   2. **Rule 13 is respected.** No stable ID is removed, renumbered, or given a
--      different meaning. The reader meets the spec's columns first.
--   3. **Order is free.** X-11 requires the tenant column to PARTICIPATE, not to
--      lead — "whether it leads is a performance question, not a disclosure
--      one" — so leading with the spec's column costs nothing and keeps the
--      access path the idempotency lookup (R-11) needs.
--
-- The five subtype tables are the part worth reading twice. Their key is the
-- PRIMARY key, and X-11's test EXEMPTS primary keys — but that exemption is
-- written for a PK on `id`, "a server-generated UUIDv4 the caller does not
-- choose", and `request_id` is not that: a caller names it. So the oracle X-11
-- exists to close was reachable there and the exemption would have hidden it:
-- an INSERT naming another tenant's request id hits the unique index (23505)
-- before the composite FK's after-statement trigger (23503) fires. The primary
-- key is therefore `(request_id, organization_id)` on all five, closing it now
-- rather than leaving a known hole with a note — this migration is the schema
-- FOUNDATION, nothing depends on it yet, and it is never cheaper to change.
--
-- The populated cycle proves the closure rather than asserting it: a cross-tenant
-- INSERT naming another tenant's EXISTING request and one naming a NONEXISTENT
-- uuid must produce the SAME error class. If they differed, the oracle would
-- have survived.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 3. D-18, and why the zero-row half is a DEFERRED constraint trigger
-- ═══════════════════════════════════════════════════════════════════════════
--
-- D-18 is "exactly one subtype row per request … A request with zero or two
-- subtype rows is impossible". Three of its four mechanisms are declarative and
-- immediate:
--
--   * `UNIQUE (request_id)` on each subtype table            — never two of a kind
--   * a composite FK carrying `subtype`                       — the root's own
--     discriminator is part of the reference, so a subtype row cannot attach to
--     a request of a different subtype
--   * `CHECK (subtype = '<literal>')` on the subtype table    — and cannot
--     attach to a request of a different subtype by lying about its own
--
-- Together those make TWO rows impossible: a second row in the same table hits
-- the UNIQUE, and a row in a different table cannot satisfy the composite FK
-- because the root carries one `subtype` value.
--
-- ZERO rows is not a declarative property. It is asserted by
-- `requests_require_subtype_row`, a `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY
-- DEFERRED`, evaluated at COMMIT. Deferred is not a convenience: a writer
-- necessarily inserts the root before the subtype row that references it, so an
-- immediate check would refuse every legal writer that exists. Commit time is
-- the first instant at which "this request has its subtype row" is a question
-- with an answer. The unit-of-work runner owns the transaction boundary
-- (I-15), so no caller can commit early around it.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 4. D-20 and the §2 matrix are two different claims
-- ═══════════════════════════════════════════════════════════════════════════
--
-- D-20 answers "may this subtype's row EVER hold this status" — a per-subtype
-- domain, checked on every INSERT and UPDATE. The §2 matrix answers "may this
-- subtype's row move from THIS status to THAT one" — a per-subtype edge set,
-- checked by a trigger on UPDATE. Neither implies the other, and a design with
-- only the first is the one in which `shift-preference` reaches `approved`
-- through a path nobody enumerated.
--
-- Two consequences of §2 that are enumerated rather than abbreviated, because
-- abbreviating them is how each was got wrong before (V-31):
--
--   * **`expired` has exactly three legal sources** — `submitted`,
--     `under_review`, `accepted_as_input`. The previous spelling was a literal
--     `*`, which as a database rule permits `reflected_in_version → expired`:
--     expiring a request a PUBLISHED version already honours. The predicate
--     below lists the three; it never matches a wildcard.
--   * **`accepted_as_input → withdrawn` exists for `availability` and
--     `shift-preference`.** A shift preference moves `submitted →
--     accepted_as_input` immediately, because nobody approves a non-binding
--     preference — so without this edge it became unwithdrawable the moment it
--     was accepted.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 5. `SENSITIVE-PII`, and the narrowing that is NOT in this file
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Doc 06 §3.4 classifies `requests` and every subtype table `SENSITIVE-PII`.
-- The precedent for a SENSITIVE-PII narrowing is `qualification_holdings`
-- (0004): own-row SELECT always, another member's row behind a READ capability,
-- writes behind an administration capability.
--
-- **That narrowing is deliberately not attempted here, and this is the reason.**
-- It requires capability keys — a request read-any, a request administer —
-- which do not exist in `packages/domain/src/authz/catalogue.ts`. Inventing them
-- would be expanding capability scope, which is prohibited to any packet
-- (CLAUDE.md non-bypass rule 11), and the authorization surface for requests is
-- M5-001's scope, not this packet's: doc 42 §5b says NO routes and leaves the
-- route-policy registry untouched.
--
-- So these tables carry the standard V-09 conjunctive group-scope policy and
-- nothing narrower, and **M5-001 owes the SENSITIVE-PII narrowing** when it
-- adds the capability keys its routes need. Nothing is exposed in the interim:
-- no route reads these tables and no service writes them. Recorded here rather
-- than left to be noticed, because a narrowing nobody wrote down is
-- indistinguishable from one nobody thought of.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 6. What is deliberately NOT here
-- ═══════════════════════════════════════════════════════════════════════════
--
--   * `is_late` — doc 06 §3.4 lists it on the root; SPEC-08 §1.1, which
--     SUPERSEDES doc 06 §3.4 for `requests`, does not, and doc 42 §5b binds this
--     packet to "the exact field list" of §1.1. §3's late-submission policy is
--     M5-001's, and the column lands with the machinery that reads it.
--   * Deadlines and the expiry sweeper (§3), `group_holidays` roll policy —
--     M5-001. `expires_at` exists and is NOT NULL because §1.1 says so; nothing
--     in this migration computes or enforces it.
--   * Approvals, denials, comments, batch (§4) — M5-002. `approvals` and
--     `request_comments` are not created here.
--   * The solver projection (§6) — M5-004.
--
-- Normative sources:
--   SPEC-08 §1, §1.1, §1.2, §2, §2.1, §7   — the structure, the matrices, R-01..R-04, R-22, R-23
--   doc 06 §3.4                            — the subtype tables' key fields
--   doc 42 §5b                             — this packet's scope and acceptance
--   migration 0018                         — the transition-guard shape this follows
--   migration 0009                         — `app_guard_append_only`, the schedule spine

-- Up Migration

------------------------------------------------------------------------------
-- 1. requests — the aggregate root
--
-- SPEC-08 §1.1's field list exactly, plus `created_at`/`updated_at`, which every
-- table in this schema carries and which are common to every subtype (so they
-- are not the "nullable subtype columns on the root" the rule forbids).
------------------------------------------------------------------------------

CREATE TABLE requests (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     uuid NOT NULL REFERENCES organizations (id),
    group_id            uuid NOT NULL,

    -- The requester. A subject column rather than an actor column, but
    -- organization-qualified for the same reason 0014 gives for actors:
    -- `memberships` offers `(id, organization_id)` as its tenant identity and
    -- no group-qualified key, so this is the strongest reference available.
    membership_id       uuid NOT NULL,

    -- THE DISCRIMINATOR. Frozen after insert (§4 below): a subtype that could
    -- change would move a row out from under its own subtype table, its own
    -- status domain and its own transition matrix in one statement.
    subtype             text NOT NULL,

    status              text NOT NULL DEFAULT 'draft',

    submitted_at        timestamptz,
    decided_at          timestamptz,
    decided_by          uuid,
    withdrawn_at        timestamptz,

    -- §3: "computed server-side from the group's `request_until_date` policy at
    -- submission. A client-side deadline is not a deadline." NOT NULL because
    -- §1.1 carries no `?` on it. The COMPUTATION is M5-001's; this column being
    -- NOT NULL is what stops a request existing with no deadline at all.
    expires_at          timestamptz NOT NULL,

    idempotency_key     text NOT NULL
        CHECK (idempotency_key ~ '^[A-Za-z0-9_.-]{1,64}$'),

    -- Optimistic concurrency for §4's "conditional update on `expected_version`;
    -- first decision wins, the second gets an explicit conflict". Application
    -- owned, like every other `version` counter in this schema that a caller
    -- must be able to present.
    version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT requests_subtype_domain CHECK (subtype IN (
        'availability', 'time-off', 'no-call', 'shift-preference',
        'shift-group-off', 'vacation-selection')),

    --------------------------------------------------------------------------
    -- D-20 — the per-subtype status domain.
    --
    -- Spelled as one CHECK with a branch per subtype rather than as a call to
    -- the transition predicate, because it is a DIFFERENT claim (§4 of the
    -- header) and because a domain a reader can check against §2's columns by
    -- eye is worth more than a shared helper.
    --
    -- Each branch is §2's column for that subtype: every status appearing at
    -- either end of a ✓ cell in it, and no other.
    --
    --   `unsatisfied` is `shift-preference`'s ALONE. It is consumed-and-not-
    --   honoured, which is a normal reportable outcome for a soft preference and
    --   is NOT a denial; giving it to any other subtype would be inventing an
    --   outcome that subtype has no way to reach.
    --
    --   `reversed` is `vacation-selection`'s ALONE (§5.6, V-27). D-20's
    --   per-subtype domains are what make that legal: a status may exist for one
    --   subtype and not for others, which is the entire point of per-subtype
    --   domains rather than one enum.
    --
    --   `shift-preference` has NO `approved`, `denied` or `under_review`. That
    --   is SPEC-08 R-03: a shift preference reaching `approved` is refused HERE,
    --   by the domain, and not only by the transition matrix — the matrix stops
    --   the edge, the domain stops the value, and an INSERT has no edge to stop.
    --------------------------------------------------------------------------
    CONSTRAINT requests_status_domain_per_subtype CHECK (
        (subtype = 'availability' AND status IN (
            'draft', 'submitted', 'under_review', 'accepted_as_input', 'approved',
            'denied', 'withdrawn', 'consumed_by_build', 'reflected_in_version',
            'expired', 'superseded_by_revision'))
     OR (subtype = 'time-off' AND status IN (
            'draft', 'submitted', 'under_review', 'approved', 'denied', 'withdrawn',
            'consumed_by_build', 'reflected_in_version', 'expired',
            'superseded_by_revision'))
     OR (subtype = 'no-call' AND status IN (
            'draft', 'submitted', 'under_review', 'approved', 'denied', 'withdrawn',
            'consumed_by_build', 'reflected_in_version', 'expired',
            'superseded_by_revision'))
     OR (subtype = 'shift-preference' AND status IN (
            'draft', 'submitted', 'accepted_as_input', 'withdrawn',
            'consumed_by_build', 'reflected_in_version', 'unsatisfied', 'expired'))
     OR (subtype = 'shift-group-off' AND status IN (
            'draft', 'submitted', 'under_review', 'approved', 'denied', 'withdrawn',
            'consumed_by_build', 'reflected_in_version', 'expired',
            'superseded_by_revision'))
     OR (subtype = 'vacation-selection' AND status IN (
            'draft', 'submitted', 'under_review', 'approved', 'denied', 'withdrawn',
            'reflected_in_version', 'reversed', 'expired', 'superseded_by_revision'))
    ),

    -- A decision names its decider and its instant together, or names neither.
    CONSTRAINT requests_decision_coherent
        CHECK ((decided_at IS NULL) = (decided_by IS NULL)),

    --------------------------------------------------------------------------
    -- D-7 (retained from doc 06 §3.4), which SPEC-08 §1.1 spells
    -- `UNIQUE (membership_id, idempotency_key)`.
    --
    -- `organization_id` is APPENDED, and the key is otherwise that spelling
    -- exactly. Both halves of that sentence matter:
    --
    --   * **It is the same constraint.** `requests_membership_fk` below is
    --     composite over `(membership_id, organization_id)` and `memberships.id`
    --     is a primary key, so one membership belongs to exactly one
    --     organization: any two `requests` rows sharing a `membership_id`
    --     necessarily share an `organization_id`. Appending a functionally
    --     determined column changes which rows collide not at all. D-7 keeps its
    --     ID and its meaning (CLAUDE.md rule 13).
    --
    --   * **It is required by X-11**, which is not advisory. Unique checks
    --     bypass row-level security, so a unique key on a tenant table that a
    --     caller can choose values for is an existence oracle for rows the
    --     caller cannot see. `test/tenancy/roles-and-schema.test.ts` asserts
    --     every unique key on every registered tenant table carries
    --     `organization_id`, with one narrow, documented exemption
    --     (`users_login_email_unique`, global by PO-DEC-06). This is not that
    --     exemption, and inventing a second one to preserve a column ORDER would
    --     be trading a real control for a cosmetic fidelity.
    --
    -- The order — tenant column last rather than first — is deliberate too. X-11
    -- requires the tenant column to PARTICIPATE, not to lead ("whether it leads
    -- is a performance question, not a disclosure one"), and keeping
    -- `(membership_id, idempotency_key)` at the front preserves both the index's
    -- access path for the lookup R-11 performs and the spec's spelling as the
    -- reader meets it.
    --------------------------------------------------------------------------
    CONSTRAINT requests_idempotent
        UNIQUE (membership_id, idempotency_key, organization_id),

    CONSTRAINT requests_tenant_identity UNIQUE (id, organization_id, group_id),

    --------------------------------------------------------------------------
    -- D-18's anchor. The subtype tables reference THIS, not the primary key, so
    -- that the discriminator and both tenant columns travel with the reference.
    -- A subtype row therefore cannot attach to a request of another subtype, and
    -- cannot attach to a request in another tenant even though referential
    -- integrity checks run with row security off.
    --------------------------------------------------------------------------
    CONSTRAINT requests_subtype_identity
        UNIQUE (id, organization_id, group_id, subtype),

    CONSTRAINT requests_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id),
    CONSTRAINT requests_membership_fk
        FOREIGN KEY (membership_id, organization_id)
        REFERENCES memberships (id, organization_id),
    CONSTRAINT requests_decided_by_fk
        FOREIGN KEY (decided_by, organization_id)
        REFERENCES memberships (id, organization_id)
);

ALTER TABLE requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE requests FORCE  ROW LEVEL SECURITY;

CREATE POLICY requests_group_scope ON requests
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

-- The requester's own list, and the scheduler's queue for a subtype.
CREATE INDEX requests_by_membership
    ON requests (organization_id, group_id, membership_id, created_at DESC);
CREATE INDEX requests_by_subtype_and_status
    ON requests (organization_id, group_id, subtype, status);
-- §3's sweeper reads exactly this: undecided rows past their deadline. Partial,
-- because every other status is uninteresting to it.
CREATE INDEX requests_undecided_by_expiry
    ON requests (organization_id, group_id, expires_at)
    WHERE status IN ('submitted', 'under_review', 'accepted_as_input');

------------------------------------------------------------------------------
-- 2. The five subtype tables
--
-- Each carries, and carries only:
--
--   `request_id`  + `organization_id` + `group_id` + `subtype`  — D-18's
--                   composite reference, with the discriminator CHECK beside it
--   the fields §1.2 marks REQUIRED for that subtype, `NOT NULL`  — D-19
--   the fields §1.2 leaves unmarked for that subtype, nullable
--
-- and NOT the fields §1.2 marks prohibited, per §2 of this file's header.
------------------------------------------------------------------------------

-- ── request_availability — the ON request ────────────────────────────────────
--
-- §1.2: required `target_date`; prohibited `shift_group_id`. `shift_type_id` and
-- `preference_strength` are named in neither column for this subtype, so they
-- are neither required nor prohibited and are simply not modelled — an ON
-- request says "I am available on this date", and doc 06 §3.4's key fields for
-- this table are `request_id, target_date` and nothing else.
CREATE TABLE request_availability (
    request_id          uuid NOT NULL,
    organization_id     uuid NOT NULL REFERENCES organizations (id),
    group_id            uuid NOT NULL,
    subtype             text NOT NULL DEFAULT 'availability',

    target_date         date NOT NULL,

    created_at          timestamptz NOT NULL DEFAULT now(),

    -- D-18's `UNIQUE (request_id)`, tenant-qualified. See §2a of this file's
    -- header: `request_id` leads, `organization_id` participates, and the pair is
    -- unique exactly when `request_id` alone is, because the composite reference
    -- below makes the tenant column functionally determined by it.
    CONSTRAINT request_availability_pkey PRIMARY KEY (request_id, organization_id),

    CONSTRAINT request_availability_discriminator CHECK (subtype = 'availability'),
    CONSTRAINT request_availability_request_fk
        FOREIGN KEY (request_id, organization_id, group_id, subtype)
        REFERENCES requests (id, organization_id, group_id, subtype)
);

ALTER TABLE request_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_availability FORCE  ROW LEVEL SECURITY;

CREATE POLICY request_availability_group_scope ON request_availability
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE INDEX request_availability_by_date
    ON request_availability (organization_id, group_id, target_date);

-- ── request_time_off — the OFF request ───────────────────────────────────────
--
-- §1.2: required `target_date` **or** `(range_start, range_end)`, EXACTLY ONE;
-- prohibited `shift_type_id`, `shift_group_id`.
--
-- "Exactly one" is spelled as the two admissible shapes rather than as a NOT of
-- the inadmissible ones, so that the half-stated range — a `range_start` with no
-- `range_end` — is refused by the same constraint and not by a second one
-- somebody has to remember to add.
CREATE TABLE request_time_off (
    request_id          uuid NOT NULL,
    organization_id     uuid NOT NULL REFERENCES organizations (id),
    group_id            uuid NOT NULL,
    subtype             text NOT NULL DEFAULT 'time-off',

    target_date         date,
    range_start         date,
    range_end           date,

    created_at          timestamptz NOT NULL DEFAULT now(),

    -- D-18's `UNIQUE (request_id)`, tenant-qualified. See §2a of this file's
    -- header: `request_id` leads, `organization_id` participates, and the pair is
    -- unique exactly when `request_id` alone is, because the composite reference
    -- below makes the tenant column functionally determined by it.
    CONSTRAINT request_time_off_pkey PRIMARY KEY (request_id, organization_id),

    CONSTRAINT request_time_off_discriminator CHECK (subtype = 'time-off'),

    -- D-19, the exactly-one-of half.
    CONSTRAINT request_time_off_date_or_range CHECK (
        (target_date IS NOT NULL AND range_start IS NULL AND range_end IS NULL)
     OR (target_date IS NULL AND range_start IS NOT NULL AND range_end IS NOT NULL)),
    -- A range that ends before it starts is not a range. Single-day ranges are
    -- admitted: `range_start = range_end` is a legitimate way to express one day
    -- and refusing it would push callers into the other shape for no reason.
    CONSTRAINT request_time_off_range_ordered
        CHECK (range_end IS NULL OR range_end >= range_start),

    CONSTRAINT request_time_off_request_fk
        FOREIGN KEY (request_id, organization_id, group_id, subtype)
        REFERENCES requests (id, organization_id, group_id, subtype)
);

ALTER TABLE request_time_off ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_time_off FORCE  ROW LEVEL SECURITY;

CREATE POLICY request_time_off_group_scope ON request_time_off
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE INDEX request_time_off_by_date
    ON request_time_off (organization_id, group_id, target_date);
CREATE INDEX request_time_off_by_range
    ON request_time_off (organization_id, group_id, range_start, range_end);

-- ── request_no_call ──────────────────────────────────────────────────────────
--
-- §1.2: required `target_date`; prohibited `shift_type_id`, `shift_group_id`,
-- `preference_strength`. Doc 06 §3.4: "Excludes **all** on-call shift types for
-- the date" — which is exactly why no shift type is nameable here. The
-- prohibition is the meaning of the subtype, not a restriction on it.
CREATE TABLE request_no_call (
    request_id          uuid NOT NULL,
    organization_id     uuid NOT NULL REFERENCES organizations (id),
    group_id            uuid NOT NULL,
    subtype             text NOT NULL DEFAULT 'no-call',

    target_date         date NOT NULL,

    created_at          timestamptz NOT NULL DEFAULT now(),

    -- D-18's `UNIQUE (request_id)`, tenant-qualified. See §2a of this file's
    -- header: `request_id` leads, `organization_id` participates, and the pair is
    -- unique exactly when `request_id` alone is, because the composite reference
    -- below makes the tenant column functionally determined by it.
    CONSTRAINT request_no_call_pkey PRIMARY KEY (request_id, organization_id),

    CONSTRAINT request_no_call_discriminator CHECK (subtype = 'no-call'),
    CONSTRAINT request_no_call_request_fk
        FOREIGN KEY (request_id, organization_id, group_id, subtype)
        REFERENCES requests (id, organization_id, group_id, subtype)
);

ALTER TABLE request_no_call ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_no_call FORCE  ROW LEVEL SECURITY;

CREATE POLICY request_no_call_group_scope ON request_no_call
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE INDEX request_no_call_by_date
    ON request_no_call (organization_id, group_id, target_date);

-- ── request_shift_preference ─────────────────────────────────────────────────
--
-- §1.2: required `target_date`, **`shift_type_id`**, `preference_strength`;
-- prohibited `shift_group_id`.
--
-- **These two `NOT NULL`s are the review's named failure, closed.** A shift
-- preference could previously reach a terminal state with no shift type because
-- the column was nullable on the shared table for everyone. SPEC-08 R-02 is a
-- shift-preference row with no `shift_type_id`, and it is refused here.
--
-- `preference_strength` is a closed vocabulary rather than a number, and its
-- provenance is a DECLARED DESIGN DECISION taken at latitude:
--
--   * SPEC-08 §1.2 and doc 06 §3.4 both NAME the field and NEITHER states its
--     type. There is no specified spelling to follow.
--   * §6's projection row is `SoftPreference(membership, date, shift_type,
--     strength)`, which needs an ORDERED strength and nothing finer.
--   * A three-value ordered set is therefore the smallest thing that carries the
--     distinction the projection makes, and a closed set cannot acquire a `7`
--     that no objective term knows how to weigh — the open-integer spelling
--     would.
--   * It is NOT report 12's rule-strength vocabulary ("Hard Penalty", "Weight
--     Penalty"). That belongs to typed RULES; this is a person's stated
--     preference, and reusing the rule words here would collapse two glossary
--     terms that are deliberately separate.
--
-- The mapping from these values to solver weights is M5-004's and is
-- deliberately not here: a weight chosen now would be a scheduling decision
-- taken by a schema migration.
CREATE TABLE request_shift_preference (
    request_id          uuid NOT NULL,
    organization_id     uuid NOT NULL REFERENCES organizations (id),
    group_id            uuid NOT NULL,
    subtype             text NOT NULL DEFAULT 'shift-preference',

    target_date         date NOT NULL,
    shift_type_id       uuid NOT NULL,
    preference_strength text NOT NULL,

    created_at          timestamptz NOT NULL DEFAULT now(),

    -- D-18's `UNIQUE (request_id)`, tenant-qualified. See §2a of this file's
    -- header: `request_id` leads, `organization_id` participates, and the pair is
    -- unique exactly when `request_id` alone is, because the composite reference
    -- below makes the tenant column functionally determined by it.
    CONSTRAINT request_shift_preference_pkey PRIMARY KEY (request_id, organization_id),

    CONSTRAINT request_shift_preference_discriminator
        CHECK (subtype = 'shift-preference'),
    CONSTRAINT request_shift_preference_strength_domain
        CHECK (preference_strength IN ('low', 'medium', 'high')),

    CONSTRAINT request_shift_preference_request_fk
        FOREIGN KEY (request_id, organization_id, group_id, subtype)
        REFERENCES requests (id, organization_id, group_id, subtype),
    CONSTRAINT request_shift_preference_shift_type_fk
        FOREIGN KEY (shift_type_id, organization_id, group_id)
        REFERENCES shift_types (id, organization_id, group_id)
);

ALTER TABLE request_shift_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_shift_preference FORCE  ROW LEVEL SECURITY;

CREATE POLICY request_shift_preference_group_scope ON request_shift_preference
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE INDEX request_shift_preference_by_date
    ON request_shift_preference (organization_id, group_id, target_date, shift_type_id);

-- ── request_shift_group_off ──────────────────────────────────────────────────
--
-- §1.2: required `target_date`, **`shift_group_id`** (whose `allow_request` is
-- true); prohibited `shift_type_id`.
--
-- The `allow_request` condition is a property of the REFERENCED row, so no
-- foreign key can carry it. It is enforced by `app_guard_shift_group_off_target`
-- below — a BEFORE trigger, which binds every writer including the owner,
-- rather than an application check, which binds only the writers that remember.
CREATE TABLE request_shift_group_off (
    request_id          uuid NOT NULL,
    organization_id     uuid NOT NULL REFERENCES organizations (id),
    group_id            uuid NOT NULL,
    subtype             text NOT NULL DEFAULT 'shift-group-off',

    target_date         date NOT NULL,
    shift_group_id      uuid NOT NULL,

    created_at          timestamptz NOT NULL DEFAULT now(),

    -- D-18's `UNIQUE (request_id)`, tenant-qualified. See §2a of this file's
    -- header: `request_id` leads, `organization_id` participates, and the pair is
    -- unique exactly when `request_id` alone is, because the composite reference
    -- below makes the tenant column functionally determined by it.
    CONSTRAINT request_shift_group_off_pkey PRIMARY KEY (request_id, organization_id),

    CONSTRAINT request_shift_group_off_discriminator
        CHECK (subtype = 'shift-group-off'),

    CONSTRAINT request_shift_group_off_request_fk
        FOREIGN KEY (request_id, organization_id, group_id, subtype)
        REFERENCES requests (id, organization_id, group_id, subtype),
    CONSTRAINT request_shift_group_off_shift_group_fk
        FOREIGN KEY (shift_group_id, organization_id, group_id)
        REFERENCES shift_groups (id, organization_id, group_id)
);

ALTER TABLE request_shift_group_off ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_shift_group_off FORCE  ROW LEVEL SECURITY;

CREATE POLICY request_shift_group_off_group_scope ON request_shift_group_off
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE INDEX request_shift_group_off_by_date
    ON request_shift_group_off (organization_id, group_id, target_date, shift_group_id);

------------------------------------------------------------------------------
-- 3. The §2 transition matrices
--
-- One IMMUTABLE predicate, edge for edge, subtype for subtype. Shaped after
-- 0018's `app_build_run_transition_is_legal`: a lookup table with parentheses,
-- reading no row, so it is safe to grant and cheap to call.
------------------------------------------------------------------------------

CREATE FUNCTION app_request_transition_is_legal(p_subtype text, p_from text, p_to text)
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
        --
        -- The superseded spelling was a literal `*`. As a database rule that
        -- permits `reflected_in_version → expired` — expiring a request a
        -- PUBLISHED version already honours — and `approved → expired`, which
        -- silently un-decides a decision. SPEC-08 R-23 is those two attempts,
        -- and they are refused here.
        --
        -- The three are the UNDECIDED states. `approved`, `consumed_by_build`,
        -- `reflected_in_version`, `unsatisfied`, `denied`, `withdrawn` and
        -- `reversed` are not among them, and are not matched by anything.
        --------------------------------------------------------------------
     OR (p_from IN ('submitted', 'under_review', 'accepted_as_input')
         AND p_to = 'expired')

        -- §4's post-reflection revision path. Vacation carries it because a
        -- committed vacation week is amended the same way.
     OR (p_from = 'approved' AND p_to = 'superseded_by_revision'
         AND p_subtype IN ('availability', 'time-off', 'no-call',
                           'shift-group-off', 'vacation-selection'));
$$;

REVOKE ALL ON FUNCTION app_request_transition_is_legal(text, text, text) FROM PUBLIC;

-- Granted back to the roles that must call it, and to the read-only roles
-- deliberately: an operator asking "was that transition legal?" should not have
-- to read this migration to find out. 0018's reasoning, unchanged — the function
-- is `LANGUAGE sql IMMUTABLE`, takes three `text` arguments, reads no table, and
-- returns a boolean.
GRANT EXECUTE ON FUNCTION app_request_transition_is_legal(text, text, text)
    TO app_runtime, app_worker, app_readonly_support, app_breakglass;

CREATE FUNCTION app_guard_request_transition() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    -- Identity is not editable. A request that could be re-pointed at another
    -- member, or re-labelled as another subtype, would make every constraint
    -- above describe a request that is no longer the one they were checked
    -- against — and `subtype` in particular selects the row's status domain,
    -- its subtype table and its transition matrix all at once.
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.group_id IS DISTINCT FROM OLD.group_id
       OR NEW.membership_id IS DISTINCT FROM OLD.membership_id
       OR NEW.subtype IS DISTINCT FROM OLD.subtype
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION
            'REQUEST_IDENTITY_FROZEN: a request''s tenant, requester, subtype and '
            'idempotency key are immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- The early return, and the 0018 reasoning for it: the matrix has no
    -- self-edges, so without this every same-status UPDATE would be refused as
    -- `REQUEST_TRANSITION_ILLEGAL` — and stamping `decided_at`, recording
    -- `expires_at` after a deadline recomputation, or bumping `version` are all
    -- legitimate same-status work.
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
    END IF;

    IF NOT app_request_transition_is_legal(NEW.subtype, OLD.status, NEW.status) THEN
        RAISE EXCEPTION
            'REQUEST_TRANSITION_ILLEGAL: a % request does not move from % to %',
            NEW.subtype, OLD.status, NEW.status
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_guard_request_transition() FROM PUBLIC;

CREATE TRIGGER requests_guard_transition
    BEFORE UPDATE ON requests
    FOR EACH ROW EXECUTE FUNCTION app_guard_request_transition();

CREATE FUNCTION app_touch_request() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_touch_request() FROM PUBLIC;

-- `zz_` so it sorts AFTER every guard (0018's discipline): the legality decision
-- is taken against the row the caller wrote, not one this trigger has amended.
CREATE TRIGGER requests_zz_touch
    BEFORE UPDATE ON requests
    FOR EACH ROW EXECUTE FUNCTION app_touch_request();

------------------------------------------------------------------------------
-- 4. D-18's zero-row half — a DEFERRED constraint trigger
--
-- Evaluated at COMMIT, for the reason §3 of this file's header gives: the root
-- necessarily exists before the subtype row that references it, so an immediate
-- check refuses every legal writer.
--
-- `vacation-selection` is refused OUTRIGHT by this body, because
-- `vacation_selections` does not exist yet. Migration 0022 replaces this body
-- with one that admits it, and 0022's down migration restores THIS body
-- verbatim — the 0011 / 0017 / 0020 precedent for a function whose body one
-- migration widens.
--
-- **The body reads the CURRENT row, never `NEW`, and that is not fastidiousness.**
-- A deferred trigger queues one event per row-modification, each carrying the
-- `NEW` its own statement produced, and fires ALL of them at commit. A
-- transaction that inserts a request and then updates it therefore arrives here
-- twice, the first time holding a `NEW` that is two statements out of date. A
-- guard that trusted it would refuse transactions that are correct at commit,
-- which is the only instant a deferred check is asking about.
------------------------------------------------------------------------------

CREATE FUNCTION app_guard_request_subtype_row() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_rows    integer;
    v_subtype text;
BEGIN
    -- The row may have been deleted later in the same transaction; a deferred
    -- trigger fires for a row that no longer exists. Nothing to assert then.
    SELECT subtype INTO v_subtype FROM requests WHERE id = NEW.id;
    IF v_subtype IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT count(*) INTO v_rows FROM (
        SELECT 1 FROM request_availability       WHERE request_id = NEW.id
        UNION ALL
        SELECT 1 FROM request_time_off           WHERE request_id = NEW.id
        UNION ALL
        SELECT 1 FROM request_no_call            WHERE request_id = NEW.id
        UNION ALL
        SELECT 1 FROM request_shift_preference   WHERE request_id = NEW.id
        UNION ALL
        SELECT 1 FROM request_shift_group_off    WHERE request_id = NEW.id
    ) AS subtype_rows;

    IF v_rows <> 1 THEN
        RAISE EXCEPTION
            'REQUEST_SUBTYPE_ROW_REQUIRED: a % request carries exactly one subtype row, '
            'and this one carries % (D-18)',
            v_subtype, v_rows
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION app_guard_request_subtype_row() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER requests_require_subtype_row
    AFTER INSERT OR UPDATE ON requests
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION app_guard_request_subtype_row();

------------------------------------------------------------------------------
-- 5. The `allow_request` condition on a shift-group-off target
--
-- §1.2: the shift group named by a `shift-group-off` request is one "whose
-- `allow_request` is true". A property of the referenced row, so a foreign key
-- cannot carry it. 0005 pairs `allow_request` with a mandatory
-- `request_off_label`, so a group admitting requests is one that has a label to
-- show for them, and this trigger is what makes the pairing mean something on
-- the request side.
------------------------------------------------------------------------------

CREATE FUNCTION app_guard_shift_group_off_target() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_allow boolean;
BEGIN
    SELECT allow_request INTO v_allow
    FROM shift_groups
    WHERE id = NEW.shift_group_id;

    -- Invoker rights, so this SELECT runs under the writer's own RLS context. A
    -- group the writer cannot see is a group the writer may not request off.
    IF v_allow IS NULL THEN
        RAISE EXCEPTION
            'SHIFT_GROUP_NOT_VISIBLE: the shift group named by this request is not '
            'visible in this tenant context'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NOT v_allow THEN
        RAISE EXCEPTION
            'SHIFT_GROUP_REQUESTS_NOT_ALLOWED: shift group % does not admit off '
            'requests (allow_request is false)',
            NEW.shift_group_id
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_guard_shift_group_off_target() FROM PUBLIC;

CREATE TRIGGER request_shift_group_off_guard_target
    BEFORE INSERT OR UPDATE ON request_shift_group_off
    FOR EACH ROW EXECUTE FUNCTION app_guard_shift_group_off_target();

------------------------------------------------------------------------------
-- 6. A subtype row is written once and never rewritten
--
-- 0009's `app_guard_append_only`, reused rather than re-declared. What a request
-- IS does not change: amending a request is a new request superseding the old
-- one (§4's `superseded_by_revision`), never an edit of the date or the shift
-- type under a decision somebody already made. The root's mutable facts —
-- status, decision, expiry, version — all live on the root.
--
-- This also closes the one route by which D-18's composite FK could be walked
-- past: with no UPDATE, a subtype row cannot be re-pointed at another request.
------------------------------------------------------------------------------

CREATE TRIGGER request_availability_append_only
    BEFORE UPDATE ON request_availability
    FOR EACH ROW EXECUTE FUNCTION app_guard_append_only();
CREATE TRIGGER request_time_off_append_only
    BEFORE UPDATE ON request_time_off
    FOR EACH ROW EXECUTE FUNCTION app_guard_append_only();
CREATE TRIGGER request_no_call_append_only
    BEFORE UPDATE ON request_no_call
    FOR EACH ROW EXECUTE FUNCTION app_guard_append_only();
CREATE TRIGGER request_shift_preference_append_only
    BEFORE UPDATE ON request_shift_preference
    FOR EACH ROW EXECUTE FUNCTION app_guard_append_only();
CREATE TRIGGER request_shift_group_off_append_only
    BEFORE UPDATE ON request_shift_group_off
    FOR EACH ROW EXECUTE FUNCTION app_guard_append_only();

------------------------------------------------------------------------------
-- 7. Grants
--
-- `requests` is the only table with an UPDATE grant and it is COLUMN-LEVEL
-- (0014's discipline, 0018's application of it): the columns a transition
-- legitimately moves, and nothing else. `subtype`, `membership_id`,
-- `idempotency_key` and both tenant columns are NOT in the set, so the transition
-- guard's identity clause is the redundant control rather than the only one.
--
-- The subtype tables get SELECT and INSERT and no UPDATE at all — the
-- append-only triggers above are the redundant control there, in the same
-- direction.
--
-- No table here has a DELETE grant for any role. A request that should not have
-- been made is `withdrawn`; one that ran out of time is `expired`.
------------------------------------------------------------------------------

GRANT SELECT, INSERT ON requests TO app_runtime, app_worker;
GRANT UPDATE (status, submitted_at, decided_at, decided_by, withdrawn_at,
              expires_at, version, updated_at)
    ON requests TO app_runtime, app_worker;
GRANT SELECT ON requests TO app_readonly_support, app_breakglass;

GRANT SELECT, INSERT ON request_availability TO app_runtime, app_worker;
GRANT SELECT ON request_availability TO app_readonly_support, app_breakglass;

GRANT SELECT, INSERT ON request_time_off TO app_runtime, app_worker;
GRANT SELECT ON request_time_off TO app_readonly_support, app_breakglass;

GRANT SELECT, INSERT ON request_no_call TO app_runtime, app_worker;
GRANT SELECT ON request_no_call TO app_readonly_support, app_breakglass;

GRANT SELECT, INSERT ON request_shift_preference TO app_runtime, app_worker;
GRANT SELECT ON request_shift_preference TO app_readonly_support, app_breakglass;

GRANT SELECT, INSERT ON request_shift_group_off TO app_runtime, app_worker;
GRANT SELECT ON request_shift_group_off TO app_readonly_support, app_breakglass;

-- Down Migration

DROP TRIGGER IF EXISTS request_shift_group_off_append_only ON request_shift_group_off;
DROP TRIGGER IF EXISTS request_shift_preference_append_only ON request_shift_preference;
DROP TRIGGER IF EXISTS request_no_call_append_only ON request_no_call;
DROP TRIGGER IF EXISTS request_time_off_append_only ON request_time_off;
DROP TRIGGER IF EXISTS request_availability_append_only ON request_availability;

DROP TRIGGER IF EXISTS request_shift_group_off_guard_target ON request_shift_group_off;
DROP TRIGGER IF EXISTS requests_require_subtype_row ON requests;
DROP TRIGGER IF EXISTS requests_zz_touch ON requests;
DROP TRIGGER IF EXISTS requests_guard_transition ON requests;

DROP FUNCTION IF EXISTS app_guard_shift_group_off_target();
DROP FUNCTION IF EXISTS app_guard_request_subtype_row();
DROP FUNCTION IF EXISTS app_touch_request();
DROP FUNCTION IF EXISTS app_guard_request_transition();
DROP FUNCTION IF EXISTS app_request_transition_is_legal(text, text, text);

DROP TABLE IF EXISTS request_shift_group_off;
DROP TABLE IF EXISTS request_shift_preference;
DROP TABLE IF EXISTS request_no_call;
DROP TABLE IF EXISTS request_time_off;
DROP TABLE IF EXISTS request_availability;
DROP TABLE IF EXISTS requests;
