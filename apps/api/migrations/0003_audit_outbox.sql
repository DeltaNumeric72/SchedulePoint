-- OPUS-M1-003 — audit chain (SPEC-11 A1), signed checkpoints, and the outbox.
--
-- Normative sources:
--   SPEC-11 §1                            — assurance level A1 is the G-BETA target;
--                                            A2 (external immutable replication) is NOT
--                                            in this migration and is NOT claimed
--   SPEC-11 §2                            — hash chain: gapless `sequence` per
--                                            organization, `prev_hash`,
--                                            `entry_hash = H(prev_hash ‖ canonical(row))`,
--                                            allocated INSIDE the writing transaction
--                                            under a per-organization lock
--   SPEC-11 §3.3                          — `outbox_events` exists so that domain,
--                                            outbox and audit can be reconciled
--   SPEC-11 §10 X-01..X-03                — the test contract this schema must satisfy
--   ADR-0019 / non-bypass rule 6          — never write audit rows outside the chain,
--                                            never break it, never add an update path
--   FAD-12                                — the audit write joins the SAME unit of work
--                                            as the mutation and its authorization
--   I-07                                  — no free text, anywhere, ever
--   SPEC-01 §4.3 (as amended 2026-08-01)  — predicate spelling, FORCE RLS,
--                                            composite tenant FKs
--
-- THE FILE NUMBER: 0003, with 0002 deliberately absent from this branch. OPUS-M1-002
-- owns 0002 and is being built in a sibling worktree; a filename gap is the packet's
-- instruction and is preferable to two branches both claiming 0002.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE PREDICATE SPELLING IS NORMATIVE AND IS WRITTEN OUT IN FULL, EVERY TIME.
--
--   nullif(current_setting('app.<x>', true), '')::uuid
--
-- The reasoning is in 0001 and is not repeated here. What IS repeated is the
-- spelling itself, per reference, on every policy — because
-- `apps/api/test/tenancy/roles-and-schema.test.ts` (A-03b) reads `pg_policies`
-- and asserts that every individual `current_setting('app.*')` reference in every
-- policy is nullif-guarded, and a helper function would hide the one that was not.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ── WHAT MAKES THIS APPEND-ONLY, IN ORDER OF HOW MUCH IT IS WORTH ────────────
--
--   1. NO `UPDATE`, `DELETE` OR `TRUNCATE` GRANT on `audit_events` or
--      `audit_checkpoints`, to any role, ever. A grant that does not exist cannot
--      be misused.
--   2. `ENABLE ALWAYS` refusal TRIGGERS that raise on UPDATE, DELETE and TRUNCATE.
--      `ENABLE ALWAYS` rather than plain `ENABLE` is the point: an ordinary
--      trigger is silently skipped when `session_replication_role = replica`,
--      which a superuser can set, and skipping it is exactly what an actor
--      rewriting history would do first.
--   3. THE CHAIN, which is the only one of the three that survives an actor
--      privileged enough to drop the other two. SPEC-11 §2 is explicit that this
--      buys **detection, not prevention**, and this migration does not pretend
--      otherwise: `app_verify_audit_chain` is the control, and the signed
--      checkpoints are what a rewriter cannot forge without the signing key.
--
--   NOT CLAIMED: protection against an actor holding BOTH database access AND
--   the signing key. That is A2 (SPEC-11 §3.1) and it is not in this milestone.
--
-- ── WHY THE CHAIN COLUMNS ARE TRIGGER-ASSIGNED ───────────────────────────────
--
-- `sequence`, `prev_hash`, `entry_hash` and `occurred_at` are EXCLUDED from the
-- column-level INSERT grants, so the application cannot name them in a statement
-- at all. A BEFORE INSERT trigger sets them. PostgreSQL checks column-level
-- privilege against the columns named in the statement, not against columns a
-- BEFORE trigger changes — the same mechanism 0001 uses for the freshness
-- counters, and the reason "never write audit rows outside the chain" is
-- structural here rather than a convention someone has to remember.

-- Up Migration

------------------------------------------------------------------------------
-- Payload closedness — I-07, enforced by the DATABASE.
--
-- An audit payload may contain identifiers, enumerated tokens, numbers and
-- booleans. It may not contain free text, and "may not" is a CHECK constraint
-- rather than a code review:
--
--   * the payload is a flat object — no nested object, no array, no null;
--   * at most 16 keys, each a short lowerCamel identifier;
--   * every value is a string, number or boolean;
--   * a string value is at most 64 characters and is PRINTABLE ASCII WITH NO
--     SPACE — `[!-~]*`, i.e. 0x21 through 0x7E.
--
-- The last rule is the one doing the work, and it is written as an allowlist
-- rather than as "no whitespace" for a measured reason: `[[:space:]]` does not
-- match U+00A0 under this cluster's ctype, so a non-breaking space passed a
-- whitespace test that the TypeScript mirror (`\s`, Unicode-aware) failed. Two
-- validators disagreeing about what free text is would make the weaker one the
-- real rule. `[!-~]` has no locale, no Unicode table and no ambiguity: a uuid, an
-- enum token, an ISO timestamp and a correlation id all match it; a sentence,
-- any control character and any non-ASCII character do not.
--
-- It is a blunt instrument, and blunt is correct here — I-07 is not a preference
-- to be balanced against expressiveness, and the failure mode of the alternative
-- is a clinician's free-text note reaching an audit row and then a backup.
--
-- This also bounds the canonical byte string the hash is computed over, which
-- keeps chain verification cheap.
------------------------------------------------------------------------------

CREATE FUNCTION app_audit_payload_is_closed(p_payload jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
    SELECT jsonb_typeof(p_payload) = 'object'
       AND (SELECT count(*) FROM jsonb_object_keys(p_payload)) <= 16
       AND NOT EXISTS (
             SELECT 1
               FROM jsonb_each(p_payload) AS entry(k, v)
              WHERE k !~ '^[a-z][a-zA-Z0-9]{0,39}$'
                 OR jsonb_typeof(v) NOT IN ('string', 'number', 'boolean')
                 OR (jsonb_typeof(v) = 'string'
                     AND (length(v #>> '{}') > 64 OR (v #>> '{}') !~ '^[!-~]*$'))
           );
$$;

------------------------------------------------------------------------------
-- Canonical bytes — the input to the hash.
--
-- Written out field by field rather than by serialising a row, because the
-- verifier must produce byte-identical input to the writer and a row-to-text
-- cast is a promise about a PostgreSQL output routine rather than a definition.
--
-- Three choices are deliberate:
--
--   * `occurred_at` is hashed as INTEGER MICROSECONDS SINCE THE EPOCH, not as a
--     formatted timestamp. `to_char` and the default timestamp output both
--     depend on session settings (`DateStyle`, `lc_time`); an integer does not.
--   * the payload is folded as `key=value` pairs joined by RECORD SEPARATOR
--     (0x1e) and sorted BY KEY, rather than by casting the jsonb to text. jsonb's own text output
--     orders keys by length-then-bytes, which is deterministic but is an
--     implementation detail of a version we do not control. The payload is
--     guaranteed flat and scalar by the CHECK above, so this fold is total.
--   * the twelve FIELDS are separated by UNIT SEPARATOR (0x1f); the payload's
--     internal key=value RECORDS are separated by RECORD SEPARATOR (0x1e).
--     Two different delimiters, and the docblock said 0x1f for both until the
--     second review caught it — the hash-input definition is the one place in
--     this file where a description that does not match the code is worse than
--     no description. Neither delimiter can occur in any field: uuids and
--     numbers cannot contain them, and the payload CHECK rejects whitespace and
--     any string over 64 characters. So the encoding is unambiguous — two
--     different events cannot produce the same bytes by moving a delimiter.
--
-- STABLE rather than IMMUTABLE: `extract(epoch from timestamptz)` is not marked
-- immutable by PostgreSQL. This function is never used in an index, only in the
-- trigger and the verifier, so STABLE is both correct and sufficient.
------------------------------------------------------------------------------

CREATE FUNCTION app_audit_canonical_bytes(
    p_organization_id     uuid,
    -- SPEC-11 §2: `entry_hash = H(prev_hash ‖ canonical(row))`. The PREVIOUS
    -- HASH IS PART OF THE HASHED INPUT, and that is the entire difference
    -- between a chain and a column of independent checksums.
    --
    -- THIS WAS WRONG IN THE FIRST VERSION OF THIS MIGRATION and the X-02 test
    -- caught it: with `prev_hash` omitted, every `entry_hash` depended only on
    -- its own row, so altering row 1 left rows 2..n verifying perfectly and the
    -- head hash unchanged. Rows could be reordered or removed and the entry
    -- hashes would not notice — only the separate `prev_hash` comparison would,
    -- which an attacker rewriting the chain fixes for free. Recorded here rather
    -- than quietly corrected, because the failure was invisible in review and
    -- visible only to a test that rewrote a segment and measured the head.
    p_prev_hash           bytea,
    p_sequence            bigint,
    p_id                  uuid,
    p_occurred_at         timestamptz,
    p_event_name          text,
    p_actor_kind          text,
    p_actor_membership_id uuid,
    p_group_id            uuid,
    p_subject_type        text,
    p_subject_id          uuid,
    p_correlation_id      text,
    p_payload             jsonb
) RETURNS bytea
LANGUAGE sql STABLE AS $$
    SELECT convert_to(
        concat_ws(
            E'\x1f',
            'sp.audit.v1',
            p_organization_id::text,
            encode(p_prev_hash, 'hex'),
            p_sequence::text,
            p_id::text,
            ((extract(epoch FROM p_occurred_at) * 1000000)::bigint)::text,
            p_event_name,
            p_actor_kind,
            coalesce(p_actor_membership_id::text, ''),
            coalesce(p_group_id::text, ''),
            p_subject_type,
            p_subject_id::text,
            p_correlation_id,
            (SELECT coalesce(
                        string_agg(entry.k || '=' || (entry.v #>> '{}'), E'\x1e' ORDER BY entry.k),
                        '')
               FROM jsonb_each(p_payload) AS entry(k, v))
        ),
        'UTF8');
$$;

------------------------------------------------------------------------------
-- audit_chain_heads — one row per organization: the tip of that organization's
-- chain.
--
-- ## Why this table exists at all
--
-- SPEC-11 §2 says the sequence and `prev_hash` are assigned inside the writing
-- transaction "under a per-organization advisory lock". Reading
-- `max(sequence) FROM audit_events` under that lock would work — except that
-- `audit_events` is read-scoped BY GROUP under a group context (below), so a
-- group-scoped writer would only see its own group's rows and would allocate
-- sequence 1 forever. **The chain is per ORGANIZATION and the read that
-- allocates it must be too.**
--
-- Splitting the tip into its own organization-scoped table solves that without
-- widening what a group-scoped actor can READ from `audit_events`, and the
-- `INSERT … ON CONFLICT DO UPDATE` below takes a row lock on the tip, which is
-- a per-organization mutual exclusion with no hash-collision keyspace to
-- reason about. The advisory lock is taken as well, because SPEC-11 names it
-- and it costs nothing.
--
-- ## What a group-scoped actor can infer from it
--
-- Its `sequence` — that is, how many audit events the organization has recorded.
-- No group attribution, no subject, no actor. Recorded here rather than
-- discovered later; if that count is later judged sensitive, the fix is to move
-- the tip behind a SECURITY DEFINER accessor with no policy at all.
--
-- ## No role holds ANY grant on it
--
-- Not SELECT, not INSERT, not UPDATE. It is reachable only through
-- `app_audit_assign_chain`, which is SECURITY DEFINER. See that function for why
-- that gains privilege and no tenant reach.
------------------------------------------------------------------------------

CREATE TABLE audit_chain_heads (
    organization_id  uuid PRIMARY KEY REFERENCES organizations (id),
    sequence         bigint NOT NULL CHECK (sequence > 0),
    entry_hash       bytea NOT NULL CHECK (length(entry_hash) = 32),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE audit_chain_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_chain_heads FORCE  ROW LEVEL SECURITY;

-- Organization-scoped ONLY, with no group predicate — see the note above. FORCE
-- means this binds the SECURITY DEFINER function's owner too, which is the
-- entire reason that function is safe.
CREATE POLICY audit_chain_heads_organization ON audit_chain_heads
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

-- ── THE ONE CROSS-TENANT READ IN THE SYSTEM, NAMED ───────────────────────────
--
-- The periodic checkpoint and verification jobs (SPEC-11 §2) have to answer
-- "which organizations are due?" before they can open a per-tenant unit of work
-- for any of them, and there is no tenant context in which that question can be
-- asked. `FORCE` RLS binds the table owner like everyone else, so a
-- `SECURITY DEFINER` function alone does not reach it — the reach has to be a
-- policy, written down, rather than a bypass nobody can see.
--
--   * `TO app_migrator` ONLY. `app_runtime`, `app_worker`, `app_readonly_support`
--     and `app_breakglass` are all excluded, and hold no grant on this table
--     regardless.
--   * `FOR SELECT` only. Nothing may be written cross-tenant.
--   * It grants app_migrator nothing it did not already have: it OWNS these
--     tables and could drop RLS outright. Making the reach explicit is the point.
--   * The only caller is `app_audit_organizations_due()` below, which returns
--     **counters and timestamps and no tenant content beyond the organization
--     identifier itself** — which it must return, since naming the organizations
--     to process is the whole job.
--
-- The consequence for `app_verify_audit_chain` is why R-05's guard is mandatory
-- rather than defensive: that function is `SECURITY DEFINER` too, so it can now
-- read ANY organization's head row, and without the guard a foreign
-- organization id would read as a clean chain.
CREATE POLICY audit_chain_heads_maintenance_read ON audit_chain_heads
    FOR SELECT TO app_migrator
    USING (true);

------------------------------------------------------------------------------
-- audit_events — the chain.
------------------------------------------------------------------------------

CREATE TABLE audit_events (
    organization_id       uuid NOT NULL REFERENCES organizations (id),
    -- Gapless per organization, assigned by the trigger. NOT a global sequence:
    -- a global one would leak cross-tenant volume and would make one
    -- organization's write rate another's contention.
    sequence              bigint NOT NULL CHECK (sequence > 0),
    -- Application-supplied identity, so a caller can correlate the row it asked
    -- for with the row that exists without reading the sequence back.
    id                    uuid NOT NULL,
    occurred_at           timestamptz NOT NULL,

    -- Controlled vocabulary, structurally. The authoritative list lives in
    -- `packages/domain/src/audit/event-names.ts`; this CHECK is the shape rule
    -- that stops a sentence being used as an event name.
    event_name            text NOT NULL
                              CHECK (event_name ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*){1,3}$'
                                     AND length(event_name) <= 64),

    actor_kind            text NOT NULL CHECK (actor_kind IN ('membership', 'system')),
    actor_membership_id   uuid,
    group_id              uuid,

    subject_type          text NOT NULL
                              CHECK (subject_type ~ '^[a-z][a-z0-9_]{0,39}$'),
    subject_id            uuid NOT NULL,

    -- The correlation id is generated and allowlisted by
    -- `apps/api/src/http/correlation-id.ts`; the CHECK re-states its shape here
    -- so a caller reaching this table by another route cannot smuggle text in.
    correlation_id        text NOT NULL
                              CHECK (correlation_id ~ '^[A-Za-z0-9_-]{1,64}$'),

    payload               jsonb NOT NULL DEFAULT '{}'::jsonb
                              CHECK (app_audit_payload_is_closed(payload)),

    prev_hash             bytea NOT NULL CHECK (length(prev_hash) = 32),
    entry_hash            bytea NOT NULL CHECK (length(entry_hash) = 32),

    PRIMARY KEY (organization_id, sequence),

    CONSTRAINT audit_events_identity_unique UNIQUE (organization_id, id),

    -- Redundant as a uniqueness rule — `(organization_id, sequence)` is already
    -- the primary key — and load-bearing as a FOREIGN KEY TARGET. It is what
    -- lets `audit_checkpoints` reference `(organization_id, sequence,
    -- entry_hash)` compositely, so a checkpoint cannot name a hash the chain
    -- never had.
    --
    -- WITHOUT IT: `app_worker` holds INSERT on `audit_checkpoints`, and could
    -- sign a checkpoint over an arbitrary `entry_hash` at a real sequence. The
    -- checkpoint table is append-only, so that row would be PERMANENT, and
    -- `matchesChain` would report `false` forever — poisoning the X-02 signal
    -- and training an operator to ignore the one alert that catches a competent
    -- rewrite. Found by the second review (R-04).
    CONSTRAINT audit_events_sequence_hash_unique
        UNIQUE (organization_id, sequence, entry_hash),

    -- A system actor has no membership; a membership actor must name one. The
    -- shapes are structurally exclusive so an audit row cannot claim both, and
    -- cannot claim neither.
    CONSTRAINT audit_events_actor_shape CHECK (
        (actor_kind = 'membership' AND actor_membership_id IS NOT NULL)
     OR (actor_kind = 'system'     AND actor_membership_id IS NULL)
    ),

    -- SPEC-01 §4 amendment (a): COMPOSITE tenant FKs. FK checks bypass RLS
    -- (X-06), so a single-column reference would accept an actor or a group from
    -- another organization and the audit row would name them convincingly.
    CONSTRAINT audit_events_actor_fk
        FOREIGN KEY (actor_membership_id, organization_id)
        REFERENCES memberships (id, organization_id),
    CONSTRAINT audit_events_group_fk
        FOREIGN KEY (group_id, organization_id)
        REFERENCES groups (id, organization_id)
);

-- Chain verification walks a whole organization in sequence order; the primary
-- key already serves that. This index serves the ordinary product query — "what
-- happened to this thing" — and the reconciler's subject lookup.
CREATE INDEX audit_events_subject_idx
    ON audit_events (organization_id, subject_type, subject_id, sequence DESC);

CREATE INDEX audit_events_correlation_idx
    ON audit_events (organization_id, correlation_id);

------------------------------------------------------------------------------
-- audit_checkpoints — SPEC-11 §2, signed with a key the application role cannot
-- read.
--
-- ## The key separation is NOT achieved in this milestone, and that is recorded
--    here rather than in a release note.
--
-- SPEC-11 §6 requires the checkpoint signing key to live in a **separate trust
-- domain**, accessible to a signing service and "never the application". TDG-15
-- selects KMS for that, and TDG-11's platform account is a reserved owner action
-- (FAD-7). What this milestone ships is a LOCAL STUB: an ed25519 key held by the
-- process, behind a `CheckpointSigner` port so the KMS implementation is a
-- swap rather than a rewrite.
--
-- **A local stub key signs checkpoints an actor who holds that key can forge.**
-- The stub is therefore worth exactly one thing — proving the mechanism and the
-- schema — and it is worth nothing as an assurance control until the key moves.
-- Real KMS is a named CI/deployment condition; see
-- `docs/evidence/EV-M1-AUDIT/INDEX.md` §5.
------------------------------------------------------------------------------

CREATE TABLE audit_checkpoints (
    organization_id  uuid NOT NULL,
    sequence         bigint NOT NULL,
    entry_hash       bytea NOT NULL CHECK (length(entry_hash) = 32),
    signed_at        timestamptz NOT NULL DEFAULT now(),
    -- Which key signed it. Old public keys are retained for verification
    -- (SPEC-11 §6), so a rotated key must not make old checkpoints unverifiable.
    key_id           text NOT NULL CHECK (key_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
    algorithm        text NOT NULL CHECK (algorithm IN ('ed25519')),
    signature        bytea NOT NULL CHECK (length(signature) BETWEEN 32 AND 256),

    PRIMARY KEY (organization_id, sequence),

    -- A checkpoint must name a real entry in the same organization's chain
    -- **AND the hash that entry actually had**. The third column is the whole
    -- point: with only `(organization_id, sequence)` the writer could sign any
    -- hash it liked at a real sequence, and append-only would make the lie
    -- permanent (R-04).
    CONSTRAINT audit_checkpoints_entry_fk
        FOREIGN KEY (organization_id, sequence, entry_hash)
        REFERENCES audit_events (organization_id, sequence, entry_hash)
);

------------------------------------------------------------------------------
-- outbox_events — SPEC-11 §3.3, and the atomic half of the async kernel.
--
-- Written in the SAME unit of work as the domain mutation and its audit event,
-- so the three commit together or not at all. The queue job is enqueued in that
-- same transaction (SP-D E-1), and the outbox row is what makes the enqueue
-- RECONCILABLE — an outbox row with no audit event, or a dispatched job with no
-- outbox row, is an observable defect rather than a silent gap.
--
-- ## This table IS mutable, and that is not a contradiction
--
-- Non-bypass rule 6 is about `audit_events`. The outbox is a work queue: its
-- `state` moves pending → dispatched | failed, and pretending otherwise would
-- mean encoding progress as more rows in a table that cannot be indexed for it.
-- What the outbox may never do is lose its link to the audit event, which is why
-- `audit_sequence` is `NOT NULL` with a composite foreign key and no UPDATE
-- grant on that column.
--
-- ## Idempotency
--
-- `idempotency_key` is unique per organization and is what the consumer passes
-- to the sink. graphile-worker is AT-LEAST-ONCE (SP-D §6) — a lease expiry
-- re-runs a job that may already have had its effect — so exactly-once is a
-- property of this key and of the sink that honours it, never of the queue.
------------------------------------------------------------------------------

CREATE TABLE outbox_events (
    organization_id  uuid NOT NULL REFERENCES organizations (id),
    id               uuid NOT NULL,
    group_id         uuid,

    -- The audit event this dispatch belongs to. SPEC-11 §3.3's reconciliation
    -- is a join on this pair.
    audit_sequence   bigint NOT NULL,

    kind             text NOT NULL
                         CHECK (kind ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*){1,3}$'
                                AND length(kind) <= 64),
    idempotency_key  text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{1,128}$'),
    correlation_id   text NOT NULL CHECK (correlation_id ~ '^[A-Za-z0-9_-]{1,64}$'),

    payload          jsonb NOT NULL DEFAULT '{}'::jsonb
                         CHECK (app_audit_payload_is_closed(payload)),

    -- `dispatching` is a CLAIM, and it exists because two dispatchers racing on
    -- the same row both delivered in a measured window (R-02). The claim is a
    -- compare-and-set: `... SET state = 'dispatching' WHERE state <> 'dispatched'`
    -- takes the row lock, so the two serialise, and the mark-dispatched step is
    -- itself a CAS on `state = 'dispatching'` so only one of them audits the
    -- dispatch.
    --
    -- The claim is NOT what makes delivery exactly-once — `outbox_effects` is.
    -- A claim can always be re-taken after a crash (it must be, or a killed
    -- dispatcher would strand the row forever), which reopens the window that
    -- the effect table's primary key closes for good.
    state            text NOT NULL DEFAULT 'pending'
                         CHECK (state IN ('pending', 'dispatching', 'dispatched', 'failed')),
    attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),

    -- A CODE, never a message. Rule 9: no payload body and no delivery material
    -- in a log, an error or an audit payload — and an exception message is the
    -- most common way one arrives.
    last_error_code  text CHECK (last_error_code IS NULL
                                 OR last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),

    -- The graphile-worker job id, captured in the same transaction as the
    -- enqueue. Null for a row whose dispatch is not queue-backed.
    job_id           bigint,

    enqueued_at      timestamptz NOT NULL DEFAULT now(),
    dispatched_at    timestamptz,
    updated_at       timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (organization_id, id),

    CONSTRAINT outbox_events_idempotency_unique UNIQUE (organization_id, idempotency_key),

    CONSTRAINT outbox_events_audit_fk
        FOREIGN KEY (organization_id, audit_sequence)
        REFERENCES audit_events (organization_id, sequence),

    CONSTRAINT outbox_events_group_fk
        FOREIGN KEY (group_id, organization_id)
        REFERENCES groups (id, organization_id),

    CONSTRAINT outbox_events_dispatch_shape CHECK (
        (state = 'dispatched' AND dispatched_at IS NOT NULL)
     OR (state <> 'dispatched' AND dispatched_at IS NULL)
    )
);

------------------------------------------------------------------------------
-- outbox_effects — where exactly-once actually lives.
--
-- ## Why an in-process Map was not enough, measured
--
-- The first version deduplicated in the delivering process. That is worth
-- nothing across a restart and nothing across two workers, and the second review
-- measured both: two concurrent dispatchers each delivered, and a dispatcher
-- killed after applying its effect had it applied again by its replacement.
-- graphile-worker is **at-least-once** (SP-D §6) — the queue will re-run a job
-- whose effect already happened, by design — so the deduplication has to be as
-- durable as the effect.
--
-- This is the spike's own `spike_effects` design, promoted: **the idempotency key
-- is a PRIMARY KEY**, and applying an effect IS inserting the row. A duplicate is
-- a constraint violation rather than an argument.
--
-- ## The honest limit
--
-- For an effect that lives in THIS database, `insert … on conflict do nothing`
-- makes exactly-once real: the row and the effect are the same object. For a
-- real external provider (TDG-06) they are not, and no database can make them
-- one — the best available is to commit the key BEFORE calling the provider and
-- to require the provider to honour an idempotency key of its own. Recorded in
-- `docs/evidence/EV-M1-AUDIT/INDEX.md` §5 rather than implied away here.
------------------------------------------------------------------------------

CREATE TABLE outbox_effects (
    organization_id  uuid NOT NULL REFERENCES organizations (id),
    idempotency_key  text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{1,128}$'),
    group_id         uuid,
    outbox_event_id  uuid NOT NULL,
    kind             text NOT NULL
                         CHECK (kind ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*){1,3}$'
                                AND length(kind) <= 64),
    correlation_id   text NOT NULL CHECK (correlation_id ~ '^[A-Za-z0-9_-]{1,64}$'),
    attempt          integer NOT NULL CHECK (attempt > 0),
    applied_at       timestamptz NOT NULL DEFAULT now(),

    -- THE control. Not an index, not a convention: the primary key.
    PRIMARY KEY (organization_id, idempotency_key),

    CONSTRAINT outbox_effects_event_fk
        FOREIGN KEY (organization_id, outbox_event_id)
        REFERENCES outbox_events (organization_id, id),
    CONSTRAINT outbox_effects_group_fk
        FOREIGN KEY (group_id, organization_id)
        REFERENCES groups (id, organization_id)
);

ALTER TABLE outbox_effects ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_effects FORCE  ROW LEVEL SECURITY;

CREATE POLICY outbox_effects_group_scope ON outbox_effects
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE POLICY outbox_effects_organization_scope ON outbox_effects
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NULL)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NULL
            AND group_id IS NULL);

CREATE INDEX outbox_events_pending_idx
    ON outbox_events (organization_id, enqueued_at)
    WHERE state = 'pending';

------------------------------------------------------------------------------
-- queue_pools — the registry SP-D condition C-2 requires.
--
-- ## Why this table exists
--
-- SP-D E-2.1/E-2.3 measured graphile-worker's lease: a job held by a worker that
-- is SIGKILLed stays locked for **four hours**, hard-coded, with only the sweep
-- interval configurable. E-2.4 measured the worse half — a *graceful* shutdown
-- does not release the in-flight job either, so an ordinary rolling deploy
-- strands every in-flight job for the same four hours.
--
-- `force_unlock_workers(text[])` clears a dead pool's lease in about a
-- millisecond (E-2.5), but it needs the dead pool's id and graphile-worker keeps
-- no registry of pools. This is that registry: a row per worker pool, a
-- heartbeat while it lives, `released_at` on a clean shutdown. A row that is
-- unreleased and has stopped heartbeating is a pool that died, and its jobs are
-- the ones to reclaim. E-2.6 measured the recovery at 316 ms against four hours.
--
-- ## The narrow reading, recorded so nobody over-claims it
--
-- This reclaims pools **the registry knows about**. A cold registry cannot
-- reclaim a pool it never saw, and a pool killed between `run()` and its
-- registration insert is not in it. The four-hour lease remains the backstop.
--
-- The RLS opt-out below is deliberately ONE LINE and immediately above the
-- CREATE TABLE, because that is where `scripts/gates/migration-rls-check.mjs`
-- looks — a multi-line justification above it reads better and fails the gate,
-- which is the correct trade in the gate's favour. The long form:
--
--   A worker pool serves every tenant. This row records the lifecycle of an OS
--   process: a pool id, a label, a host, a pid and three timestamps. It has no
--   tenant column because there is no tenant it belongs to, and giving it a
--   fabricated one would make the reclaim query wrong rather than safer. Only
--   `app_worker` may read or write it.
--
-- rls: not-tenant-scoped (worker-process lifecycle; no tenant column, no tenant data, app_worker only)
CREATE TABLE queue_pools (
    pool_id       text PRIMARY KEY CHECK (pool_id ~ '^[A-Za-z0-9_.:-]{1,64}$'),
    label         text NOT NULL CHECK (label ~ '^[a-z][a-z0-9_-]{0,63}$'),
    hostname      text NOT NULL CHECK (hostname ~ '^[A-Za-z0-9_.-]{1,253}$'),
    process_id    integer NOT NULL CHECK (process_id > 0),
    started_at    timestamptz NOT NULL DEFAULT now(),
    heartbeat_at  timestamptz NOT NULL DEFAULT now(),
    released_at   timestamptz
);

CREATE INDEX queue_pools_unreleased_idx
    ON queue_pools (heartbeat_at)
    WHERE released_at IS NULL;

GRANT SELECT, INSERT ON queue_pools TO app_worker;
GRANT UPDATE (heartbeat_at, released_at) ON queue_pools TO app_worker;

------------------------------------------------------------------------------
-- Row level security.
------------------------------------------------------------------------------

ALTER TABLE audit_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events      FORCE  ROW LEVEL SECURITY;
ALTER TABLE audit_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_checkpoints FORCE  ROW LEVEL SECURITY;
ALTER TABLE outbox_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events     FORCE  ROW LEVEL SECURITY;

-- ── audit_events ─────────────────────────────────────────────────────────────
--
-- FOUR policies, split by command as well as by scope, because reading and
-- writing want different answers:
--
--   group context        SELECT   only this group's audit rows
--   organization context SELECT   every audit row in the organization  [EX-2 shape]
--   group context        INSERT   group_id must BE the declared group
--   organization context INSERT   group_id must be NULL
--
-- The read asymmetry is the same one 0001 established for `memberships`: an
-- organization-wide read is available only under an organization-scoped context,
-- which is where the organization-administration capability gate sits.
--
-- The write asymmetry is stricter than the read on purpose. A group-scoped
-- mutation must not be able to file its audit row against a sibling group — that
-- would be an attribution attack, and it would produce an audit trail that looks
-- authoritative while naming the wrong group.
--
-- There is deliberately NO `FOR UPDATE` and NO `FOR DELETE` policy. Under RLS a
-- command with no permissive policy matches no rows, so even a role that somehow
-- acquired the grant would update nothing — a third layer under the two the
-- header describes.

CREATE POLICY audit_events_group_read ON audit_events
    FOR SELECT
    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
       AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
       AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE POLICY audit_events_organization_read ON audit_events
    FOR SELECT
    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
       AND nullif(current_setting('app.group_id', true), '') IS NULL);

CREATE POLICY audit_events_group_insert ON audit_events
    FOR INSERT
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE POLICY audit_events_organization_insert ON audit_events
    FOR INSERT
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NULL
            AND group_id IS NULL);

-- ── audit_checkpoints ────────────────────────────────────────────────────────
--
-- Organization-scoped only, for both reads and writes. A checkpoint covers an
-- organization's whole chain, so it has no group to be scoped to, and signing
-- one is an organization-administration action.
--
-- The READ policy carries the `app.group_id IS NULL` clause too. It did not
-- until the second review pointed out that the comment above said
-- "organization-scoped only" while the predicate let a GROUP-scoped context read
-- every checkpoint in the organization (R-06). Of the two readings the stricter
-- one is the stated intent, so the predicate moved to meet the comment rather
-- than the other way round.

CREATE POLICY audit_checkpoints_organization_read ON audit_checkpoints
    FOR SELECT
    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
       AND nullif(current_setting('app.group_id', true), '') IS NULL);

-- The checkpoint half of the maintenance read described at
-- `audit_chain_heads_maintenance_read`. Same terms: SELECT only, app_migrator
-- only, and `app_audit_organizations_due()` is the only caller.
CREATE POLICY audit_checkpoints_maintenance_read ON audit_checkpoints
    FOR SELECT TO app_migrator
    USING (true);

CREATE POLICY audit_checkpoints_organization_insert ON audit_checkpoints
    FOR INSERT
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NULL);

-- ── outbox_events ────────────────────────────────────────────────────────────
--
-- Same scope asymmetry as `audit_events`, plus an UPDATE policy — the outbox is
-- a work queue and its state moves. The UPDATE's `WITH CHECK` repeats the
-- `USING` predicate so a state transition cannot also re-tenant the row.

CREATE POLICY outbox_events_group_scope ON outbox_events
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid);

CREATE POLICY outbox_events_organization_scope ON outbox_events
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NULL)
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NULL);

------------------------------------------------------------------------------
-- The chain, assigned inside the writing transaction.
--
-- SECURITY DEFINER, narrowly and for one reason: no runtime role holds any
-- grant on `audit_chain_heads`, so the tip can only move through this function.
-- It gains PRIVILEGE and NO TENANT REACH — `audit_chain_heads` is FORCE RLS and
-- its policy is organization-scoped, so the owner running this function is
-- confined to the tenant whose context is in force, exactly as the caller is.
-- Outside a unit of work `app.organization_id` is NULL or '' and the policy is
-- false, so the INSERT fails and the audit row cannot be written at all. **That
-- is an enforcement point, not a limitation:** an audit row written outside a
-- unit of work would be an audit row with no verified tenant context.
--
-- `SET search_path = public, pg_temp` — **`pg_temp` LAST**, for the reason 0001
-- spells out at length: PostgreSQL searches `pg_temp` first when it is not named
-- explicitly, so a caller holding TEMP could shadow `audit_chain_heads` with a
-- temporary table and fork the chain silently. No runtime role holds TEMP either
-- (the bootstrap revokes it); this is the inner half of that defence.
------------------------------------------------------------------------------

CREATE FUNCTION app_audit_assign_chain() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_genesis   bytea;
    v_sequence  bigint;
    v_prev_hash bytea;
    v_now       timestamptz := clock_timestamp();
BEGIN
    -- SPEC-11 §2 names a per-organization advisory lock. The ON CONFLICT DO
    -- UPDATE below already serialises on the tip row, which is a stronger and
    -- collision-free form of the same mutual exclusion; the advisory lock is
    -- taken as well because the specification names it and it is free. Both are
    -- transaction-scoped, so neither can outlive the unit of work.
    PERFORM pg_advisory_xact_lock(hashtext('schedulepoint.audit'),
                                  hashtext(NEW.organization_id::text));

    -- The genesis link is bound to the organization, so two organizations'
    -- chains cannot be spliced together by moving rows between them.
    v_genesis := sha256(convert_to('sp.audit.genesis.v1:' || NEW.organization_id::text, 'UTF8'));

    INSERT INTO audit_chain_heads AS head (organization_id, sequence, entry_hash, updated_at)
    VALUES (NEW.organization_id, 1, v_genesis, v_now)
    ON CONFLICT (organization_id) DO UPDATE
        SET sequence = head.sequence + 1,
            updated_at = v_now
    -- On the INSERT path this returns (1, genesis); on the UPDATE path it
    -- returns the NEW sequence and the UNCHANGED entry_hash, which is the
    -- previous entry's hash. Both are exactly what the new row needs.
    RETURNING head.sequence, head.entry_hash INTO v_sequence, v_prev_hash;

    IF v_sequence IS NULL THEN
        RAISE EXCEPTION
            'audit chain head could not be allocated for organization % — the insert ran '
            'outside a unit of work with transaction-local tenant context (I-15)',
            NEW.organization_id
            USING ERRCODE = 'restrict_violation';
    END IF;

    NEW.sequence    := v_sequence;
    NEW.prev_hash   := v_prev_hash;
    NEW.occurred_at := v_now;
    NEW.entry_hash  := sha256(app_audit_canonical_bytes(
        NEW.organization_id, NEW.prev_hash, NEW.sequence, NEW.id, NEW.occurred_at,
        NEW.event_name, NEW.actor_kind, NEW.actor_membership_id, NEW.group_id,
        NEW.subject_type, NEW.subject_id, NEW.correlation_id, NEW.payload));

    UPDATE audit_chain_heads
       SET entry_hash = NEW.entry_hash,
           updated_at = v_now
     WHERE organization_id = NEW.organization_id;

    RETURN NEW;
END;
$$;

CREATE TRIGGER audit_events_assign_chain
    BEFORE INSERT ON audit_events
    FOR EACH ROW EXECUTE FUNCTION app_audit_assign_chain();

------------------------------------------------------------------------------
-- Refusal triggers — non-bypass rule 6, at the database.
--
-- `ENABLE ALWAYS` is the whole point. A plain trigger is skipped when
-- `session_replication_role = replica`, which any superuser can set with one
-- statement, and setting it is the first thing an actor rewriting history would
-- do. `ENABLE ALWAYS` fires in replica mode too.
--
-- What remains possible for a sufficiently privileged actor: `ALTER TABLE …
-- DISABLE TRIGGER`, or dropping the trigger outright. Neither is prevented, and
-- SPEC-11 §2 does not claim otherwise — that is what the chain and the signed
-- checkpoints are for, and X-01/X-02 are the tests that prove detection works.
------------------------------------------------------------------------------

CREATE FUNCTION app_audit_refuse_modification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION
        'audit records are append-only: % on % is refused (ADR-0019, non-bypass rule 6)',
        TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER audit_events_refuse_update
    BEFORE UPDATE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION app_audit_refuse_modification();
ALTER TABLE audit_events ENABLE ALWAYS TRIGGER audit_events_refuse_update;

CREATE TRIGGER audit_events_refuse_delete
    BEFORE DELETE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION app_audit_refuse_modification();
ALTER TABLE audit_events ENABLE ALWAYS TRIGGER audit_events_refuse_delete;

CREATE TRIGGER audit_events_refuse_truncate
    BEFORE TRUNCATE ON audit_events
    FOR EACH STATEMENT EXECUTE FUNCTION app_audit_refuse_modification();
ALTER TABLE audit_events ENABLE ALWAYS TRIGGER audit_events_refuse_truncate;

CREATE TRIGGER audit_checkpoints_refuse_update
    BEFORE UPDATE ON audit_checkpoints
    FOR EACH ROW EXECUTE FUNCTION app_audit_refuse_modification();
ALTER TABLE audit_checkpoints ENABLE ALWAYS TRIGGER audit_checkpoints_refuse_update;

CREATE TRIGGER audit_checkpoints_refuse_delete
    BEFORE DELETE ON audit_checkpoints
    FOR EACH ROW EXECUTE FUNCTION app_audit_refuse_modification();
ALTER TABLE audit_checkpoints ENABLE ALWAYS TRIGGER audit_checkpoints_refuse_delete;

-- The head row is the input to R-01's tail-truncation check, so an actor who
-- truncates the tail would delete or rewind it next. Monotonic and undeletable,
-- on the same ENABLE ALWAYS terms as the audit rows: without this the new check
-- has an input the attacker controls.
CREATE FUNCTION app_audit_guard_chain_head() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP <> 'UPDATE' THEN
        RAISE EXCEPTION
            'the audit chain head is not deletable: it is what detects a truncated chain '
            '(SPEC-11 §2, review finding R-01)'
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
        RAISE EXCEPTION 'the audit chain head may not be re-tenanted'
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.sequence < OLD.sequence THEN
        RAISE EXCEPTION
            'the audit chain head may not move backwards (% -> %)', OLD.sequence, NEW.sequence
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER audit_chain_heads_guard
    BEFORE UPDATE OR DELETE ON audit_chain_heads
    FOR EACH ROW EXECUTE FUNCTION app_audit_guard_chain_head();
ALTER TABLE audit_chain_heads ENABLE ALWAYS TRIGGER audit_chain_heads_guard;

CREATE TRIGGER audit_chain_heads_refuse_truncate
    BEFORE TRUNCATE ON audit_chain_heads
    FOR EACH STATEMENT EXECUTE FUNCTION app_audit_refuse_modification();
ALTER TABLE audit_chain_heads ENABLE ALWAYS TRIGGER audit_chain_heads_refuse_truncate;

-- An applied effect is a record of something that happened outside this
-- database. Nothing may edit or remove one — that is the entire basis on which
-- a redelivery is suppressed.
CREATE TRIGGER outbox_effects_refuse_modification
    BEFORE UPDATE OR DELETE ON outbox_effects
    FOR EACH ROW EXECUTE FUNCTION app_audit_refuse_modification();
ALTER TABLE outbox_effects ENABLE ALWAYS TRIGGER outbox_effects_refuse_modification;

CREATE TRIGGER audit_checkpoints_refuse_truncate
    BEFORE TRUNCATE ON audit_checkpoints
    FOR EACH STATEMENT EXECUTE FUNCTION app_audit_refuse_modification();
ALTER TABLE audit_checkpoints ENABLE ALWAYS TRIGGER audit_checkpoints_refuse_truncate;

-- The outbox is a work queue and its state moves, but a dispatched row is still
-- a record: nothing may delete one, and no state transition may re-point it at a
-- different audit event or a different tenant.
CREATE FUNCTION app_outbox_refuse_relink() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
            'outbox rows are not deletable: they are one of the three sequences SPEC-11 §3.3 '
            'reconciles, and a deleted one is indistinguishable from one that never existed'
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.id             IS DISTINCT FROM OLD.id
       OR NEW.group_id       IS DISTINCT FROM OLD.group_id
       OR NEW.audit_sequence IS DISTINCT FROM OLD.audit_sequence
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.kind           IS DISTINCT FROM OLD.kind
       OR NEW.payload        IS DISTINCT FROM OLD.payload THEN
        RAISE EXCEPTION
            'an outbox row''s identity, tenancy, audit link and payload are immutable; only '
            'its dispatch state may change'
            USING ERRCODE = 'restrict_violation';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER outbox_events_refuse_relink
    BEFORE UPDATE OR DELETE ON outbox_events
    FOR EACH ROW EXECUTE FUNCTION app_outbox_refuse_relink();
ALTER TABLE outbox_events ENABLE ALWAYS TRIGGER outbox_events_refuse_relink;

------------------------------------------------------------------------------
-- Chain verification — SPEC-11 §2 "recomputes the chain between checkpoints and
-- alerts on any mismatch", and the X-01/X-02/X-03 detector.
--
-- Returns ONE row per problem found, ordered by sequence, and nothing at all for
-- an intact chain. It reports every break rather than stopping at the first,
-- because "the chain broke at 41" and "the chain broke at 41 and again at 900"
-- are different incidents.
--
-- ## The hole the second review measured, and what closes it
--
-- Walking the rows that EXIST can never notice rows that no longer do **at the
-- end**. Measured: checkpoint at sequence 10, append to 15, delete 11–15 → the
-- walk reported `intact`, every checkpoint still verified and matched, and
-- `audit_chain_heads` still said 15 with nothing comparing the two. A tail
-- truncation above the last checkpoint was invisible (R-01).
--
-- So the walk is now followed by a comparison against the registered head, and
-- two problem kinds exist for what that comparison can find:
--
--   `head_sequence_ahead_of_chain`  the head says N, the chain stops at M < N.
--                                   Rows are missing from the tail.
--   `chain_head_missing`            rows exist and the head row does not. An
--                                   attacker truncating the tail would delete
--                                   the head row next, so the absence of the
--                                   comparison's input is itself the finding.
--
-- The head row is additionally protected: it is monotonic and undeletable
-- (`audit_chain_heads_guard`), on the same `ENABLE ALWAYS` terms as the audit
-- rows themselves.
--
-- ## SECURITY DEFINER, and why R-05's guard is not optional
--
-- No role holds any grant on `audit_chain_heads`, so reading it requires
-- `SECURITY DEFINER`. The definer is the owner, and the owner can now read every
-- organization's head row (`audit_chain_heads_maintenance_read`). The reads of
-- `audit_events` are still confined by RLS to the SESSION's organization — so
-- calling this with a foreign organization id would walk zero rows and report a
-- clean chain, which is the worst possible answer to give a support or
-- break-glass operator during an incident. **It raises instead.**
--
-- `SET search_path = public, pg_temp` — `pg_temp` LAST, for the reason 0001
-- spells out.
--
-- It still requires an ORGANIZATION-scoped unit of work: a group-scoped context
-- sees only its own group's rows and would report a break at the first row
-- belonging to another group. `apps/api/src/audit/verification.ts` refuses the
-- wrong scope before calling.
------------------------------------------------------------------------------

CREATE FUNCTION app_verify_audit_chain(p_organization_id uuid)
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

------------------------------------------------------------------------------
-- app_audit_organizations_due — the input to SPEC-11 §2's periodic jobs.
--
-- "Every N entries and at least daily" needs to know which organizations are
-- behind, and that question cannot be asked inside any one tenant's context.
-- This is the only function in the system that reads across tenants, it reads
-- **counters and timestamps only** — no event, no actor, no subject, no payload
-- — and the reach it uses is the explicitly named
-- `audit_chain_heads_maintenance_read` / `audit_checkpoints_maintenance_read`
-- policies, not a hidden bypass.
--
-- The caller then opens a NORMAL per-tenant unit of work for each organization
-- it returns, so every byte of actual audit content is read under RLS with a
-- tenant context, exactly as a request would.
--
-- `SECURITY DEFINER` with `search_path = public, pg_temp` — `pg_temp` LAST.
-- EXECUTE is granted to `app_worker` alone: the request path has no business
-- knowing that other organizations exist.
------------------------------------------------------------------------------

CREATE FUNCTION app_audit_organizations_due(
    p_entry_interval bigint,
    p_max_age        interval
) RETURNS TABLE (
    organization_id           uuid,
    head_sequence             bigint,
    last_checkpoint_sequence  bigint,
    last_checkpoint_at        timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT h.organization_id,
           h.sequence,
           c.sequence,
           c.signed_at
      FROM audit_chain_heads h
      LEFT JOIN LATERAL (
            SELECT c2.sequence, c2.signed_at
              FROM audit_checkpoints c2
             WHERE c2.organization_id = h.organization_id
             ORDER BY c2.sequence DESC
             LIMIT 1
      ) c ON true
     WHERE c.sequence IS NULL
        OR h.sequence - c.sequence >= p_entry_interval
        OR c.signed_at < now() - p_max_age
     ORDER BY h.organization_id;
$$;

REVOKE ALL ON FUNCTION app_audit_organizations_due(bigint, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_audit_organizations_due(bigint, interval) TO app_worker;

-- The bytes a checkpoint signature covers. Exposed as a function so the signer
-- and the verifier cannot disagree about what was signed.
CREATE FUNCTION app_audit_checkpoint_bytes(
    p_organization_id uuid, p_sequence bigint, p_entry_hash bytea
) RETURNS bytea
LANGUAGE sql IMMUTABLE AS $$
    SELECT convert_to(
        concat_ws(E'\x1f', 'sp.audit.checkpoint.v1',
                  p_organization_id::text, p_sequence::text, encode(p_entry_hash, 'hex')),
        'UTF8');
$$;

------------------------------------------------------------------------------
-- Grants.
--
-- Read the negative space first — it is the security property:
--
--   audit_chain_heads      NO GRANT TO ANY ROLE. Reachable only through
--                          `app_audit_assign_chain` (SECURITY DEFINER).
--   audit_events           NO UPDATE. NO DELETE. NO TRUNCATE. NO REFERENCES.
--                          INSERT is COLUMN-LEVEL and excludes `sequence`,
--                          `prev_hash`, `entry_hash` and `occurred_at`, so the
--                          application cannot name a chain column in a statement.
--   audit_checkpoints      NO UPDATE. NO DELETE. NO TRUNCATE. INSERT to the
--                          WORKER ONLY — checkpointing is a background job, and
--                          a request path that could write a checkpoint could
--                          checkpoint a chain it had just corrupted.
--   outbox_events          NO DELETE. UPDATE is column-level and covers only the
--                          dispatch state.
--
-- `app_readonly_support` and `app_breakglass` get SELECT and nothing else, which
-- is the same posture 0001 gives them. SPEC-11 §3.2 requires their reads to be
-- audited to the same chain; that lands with the support tooling, and is
-- recorded as NOT DONE in the evidence index rather than implied by this grant.
------------------------------------------------------------------------------

GRANT SELECT ON audit_events, audit_checkpoints, outbox_events, outbox_effects
    TO app_runtime, app_worker, app_readonly_support, app_breakglass;

-- The effect row IS the effect (see the table's own note), so only the role that
-- performs deliveries may write one, and nobody may edit or remove one.
GRANT INSERT (organization_id, idempotency_key, group_id, outbox_event_id, kind,
              correlation_id, attempt)
    ON outbox_effects TO app_worker;

GRANT INSERT (organization_id, id, event_name, actor_kind, actor_membership_id,
              group_id, subject_type, subject_id, correlation_id, payload)
    ON audit_events TO app_runtime, app_worker;

GRANT INSERT (organization_id, sequence, entry_hash, key_id, algorithm, signature)
    ON audit_checkpoints TO app_worker;

GRANT INSERT (organization_id, id, group_id, audit_sequence, kind, idempotency_key,
              correlation_id, payload, job_id)
    ON outbox_events TO app_runtime, app_worker;

GRANT UPDATE (state, attempts, last_error_code, dispatched_at, job_id, updated_at)
    ON outbox_events TO app_worker;

-- Verification is a read. Both application roles may run it; the support and
-- break-glass roles may too, because "is the chain intact" is exactly the
-- question they exist to answer during an incident.
--
-- The REVOKE is not decoration. PostgreSQL grants `EXECUTE` on a new function to
-- `PUBLIC` by default, and this one became `SECURITY DEFINER` when R-01 gave it
-- the head-row read — so the inherited grant would have let any role call it as
-- the owner. The R-05 guard confines what it can answer, but a function that
-- runs as the schema owner should not be reachable by a role nobody granted it
-- to. Same hygiene `app_audit_organizations_due` already gets, and the same rule
-- this migration states for the trigger functions below.
REVOKE ALL ON FUNCTION app_verify_audit_chain(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_verify_audit_chain(uuid)
    TO app_runtime, app_worker, app_readonly_support, app_breakglass;
GRANT EXECUTE ON FUNCTION app_audit_checkpoint_bytes(uuid, bigint, bytea)
    TO app_runtime, app_worker, app_readonly_support, app_breakglass;

-- `app_audit_assign_chain` is a trigger function; PostgreSQL does not check
-- EXECUTE on trigger functions, and it is not callable directly. Revoking from
-- PUBLIC anyway, so a future change that made it callable does not inherit a
-- grant nobody intended.
REVOKE ALL ON FUNCTION app_audit_assign_chain() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_audit_refuse_modification() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_outbox_refuse_relink() FROM PUBLIC;

-- Down Migration

DROP TRIGGER IF EXISTS outbox_effects_refuse_modification ON outbox_effects;
DROP TRIGGER IF EXISTS audit_chain_heads_refuse_truncate  ON audit_chain_heads;
DROP TRIGGER IF EXISTS audit_chain_heads_guard            ON audit_chain_heads;
DROP TRIGGER IF EXISTS outbox_events_refuse_relink        ON outbox_events;
DROP TRIGGER IF EXISTS audit_checkpoints_refuse_truncate  ON audit_checkpoints;
DROP TRIGGER IF EXISTS audit_checkpoints_refuse_delete    ON audit_checkpoints;
DROP TRIGGER IF EXISTS audit_checkpoints_refuse_update    ON audit_checkpoints;
DROP TRIGGER IF EXISTS audit_events_refuse_truncate       ON audit_events;
DROP TRIGGER IF EXISTS audit_events_refuse_delete         ON audit_events;
DROP TRIGGER IF EXISTS audit_events_refuse_update         ON audit_events;
DROP TRIGGER IF EXISTS audit_events_assign_chain          ON audit_events;

DROP FUNCTION IF EXISTS app_audit_guard_chain_head();
DROP FUNCTION IF EXISTS app_audit_organizations_due(bigint, interval);
DROP FUNCTION IF EXISTS app_outbox_refuse_relink();
DROP FUNCTION IF EXISTS app_audit_refuse_modification();
DROP FUNCTION IF EXISTS app_audit_assign_chain();
DROP FUNCTION IF EXISTS app_audit_checkpoint_bytes(uuid, bigint, bytea);
DROP FUNCTION IF EXISTS app_verify_audit_chain(uuid);

DROP POLICY IF EXISTS outbox_effects_organization_scope    ON outbox_effects;
DROP POLICY IF EXISTS outbox_effects_group_scope           ON outbox_effects;
DROP POLICY IF EXISTS outbox_events_organization_scope     ON outbox_events;
DROP POLICY IF EXISTS outbox_events_group_scope            ON outbox_events;
DROP POLICY IF EXISTS audit_checkpoints_organization_insert ON audit_checkpoints;
DROP POLICY IF EXISTS audit_checkpoints_maintenance_read   ON audit_checkpoints;
DROP POLICY IF EXISTS audit_checkpoints_organization_read   ON audit_checkpoints;
DROP POLICY IF EXISTS audit_events_organization_insert     ON audit_events;
DROP POLICY IF EXISTS audit_events_group_insert            ON audit_events;
DROP POLICY IF EXISTS audit_events_organization_read       ON audit_events;
DROP POLICY IF EXISTS audit_events_group_read              ON audit_events;
DROP POLICY IF EXISTS audit_chain_heads_maintenance_read   ON audit_chain_heads;
DROP POLICY IF EXISTS audit_chain_heads_organization       ON audit_chain_heads;

DROP INDEX IF EXISTS queue_pools_unreleased_idx;
DROP INDEX IF EXISTS outbox_events_pending_idx;
DROP INDEX IF EXISTS audit_events_correlation_idx;
DROP INDEX IF EXISTS audit_events_subject_idx;

DROP TABLE IF EXISTS queue_pools;
DROP TABLE IF EXISTS outbox_effects;
DROP TABLE IF EXISTS outbox_events;
DROP TABLE IF EXISTS audit_checkpoints;
DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS audit_chain_heads;

DROP FUNCTION IF EXISTS app_audit_canonical_bytes(
    uuid, bytea, bigint, uuid, timestamptz, text, text, uuid, uuid, text, uuid, text, jsonb);
DROP FUNCTION IF EXISTS app_audit_payload_is_closed(jsonb);
