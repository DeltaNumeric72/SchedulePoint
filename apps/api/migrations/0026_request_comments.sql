-- SPEC-08 §4's FIFTH row — COMMENTS: "Append-only; author recorded;
-- `SENSITIVE-PII`; visible per capability" — implemented under **FAD-58**
-- (OPUS-M5-00C, doc 42 §5g).
--
-- **This migration is additive.** It creates one table and touches nothing that
-- 0021–0025 wrote: no policy is replaced, no function is redefined, no
-- constraint is relaxed, no grant is widened. The down migration therefore has
-- nothing to restore byte-for-byte — it drops what this file created and stops.
-- (Stated because the standing rule asks for "down restores byte-for-byte
-- anything replaced", and the honest report is that this migration replaces
-- nothing.)
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Why this table did not exist until a FAD ruled on it
-- ═══════════════════════════════════════════════════════════════════════════
--
-- §4 has five rows and OPUS-M5-002 shipped four of them. The fifth was
-- ESCALATED out of that packet rather than squeezed into it, and the escalation
-- record lives in `apps/api/src/http/routes/requests.route.ts`'s header. Its
-- sentence, because a reader who arrives at this table deserves the reason here
-- rather than in a register:
--
--   Every bounded-free-text precedent this repository holds is SCHEDULER-authored
--   administrative text about a scheduling act — `schedule_versions.change_summary`,
--   `vacation_selections.override_reason`, `approvals.reason`. §4's comments are
--   REQUESTER-authored text about the requester's own circumstances, on a
--   `SENSITIVE-PII` aggregate, in a product where the honest answer to "why that
--   Friday?" is frequently a medical one. I-07 is not patient-scoped — "no
--   patient-identifying information **or clinical free text** enters the system" —
--   and a length bound bounds SIZE, not KIND.
--
-- **FAD-58 ruled, 2026-08-27**, and this file is points 1–3 of it in SQL. No
-- column here exists that the ruling did not decide.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 2. TWO CHANNELS, and the exactly-one-of rule that keeps them apart
-- ═══════════════════════════════════════════════════════════════════════════
--
-- FAD-58.1: **the requester-side channel is a CONTROLLED VOCABULARY,
-- permanently.** The requester attaches at most one reason CODE per turn from a
-- curated non-clinical list (I-17). There is **no "other, specify" text field**:
-- `other` is a TERMINAL code, because that field would be the free-text channel
-- under another name.
--
-- FAD-58.2: **the scheduler-side channel joins the existing administrative
-- bounded-text class** — the same class, the same 1000-character bound, and the
-- same posture as `approvals.reason` beside it.
--
-- One table, two channels, because §4 describes ONE comment surface. The
-- separation is a pair of CHECKs written in BOTH directions:
--
--   * `request_comments_requester_channel_is_a_code`
--       `(channel = 'requester') = (reason_code IS NOT NULL)`
--   * `request_comments_scheduler_channel_is_text`
--       `(channel = 'scheduler') = (body IS NOT NULL)`
--
-- Read together they say: a requester row carries a code and NO body, and a
-- scheduler row carries a body and NO code. **There is no state of this table in
-- which requester-authored free text exists**, and that is a property of the
-- schema rather than of the callers — the same discipline 0024's
-- `approvals_reason_mandatory_where_stated` applies to a reason.
--
-- Both directions, deliberately. A CHECK that only forbade a body on a requester
-- row would still admit a scheduler row with a code, which would let a decider
-- attribute a circumstance to the person whose request it is.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 3. "Append-only" is a PRIVILEGE, not a promise — the `approvals` pattern
-- ═══════════════════════════════════════════════════════════════════════════
--
-- FAD-58.3, and it is migration 0024's mechanism applied one table over.
-- `app_runtime` holds **SELECT and INSERT on this table and nothing else** (§8
-- below). There is no `GRANT UPDATE` — not on a column, not on the table — and
-- no `GRANT DELETE` for any runtime role. So §4's "append-only" is not a rule
-- somebody has to remember while writing an edit path: **there is no statement a
-- runtime role can issue that would edit or remove a comment.**
--
-- Correction is therefore a NEW COMMENT, which is what FAD-58.3 says and what
-- `audit_events` and `approvals` already do. A retraction that erased what it
-- retracted would be the outcome §4's "append-only" forbids.
--
-- **`app_worker` is granted SELECT and NOT INSERT, and that is a deliberate
-- narrowing from 0024's shape.** 0024 grants `app_worker` both; that was correct
-- for a table §5.4's transaction might one day be driven into from a job. No job
-- writes a comment: FAD-58.5 forbids notification work on this surface entirely,
-- the expiry sweeper writes `expired` and nothing else, and an INSERT grant with
-- no writer is the mirror of the rule M5-001 recorded for capability keys — a
-- grant with no user is a grant that lies. If a worker path ever needs to append
-- a comment, the grant is one line and it arrives with its writer.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 4. What a comment PUBLISHES, and the three places it may not go
--    (I-07, ADR-0019, non-bypass rules 8 and 9)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- FAD-58.5's closure, and it has two halves that are NOT the same strength.
--
-- **The body.** `body` is prose, and prose contains spaces.
-- `app_audit_payload_is_closed` (migration 0003) and its TypeScript mirror
-- `auditPayloadViolations` both require every payload string to match
-- `^[!-~]*$` and to be at most 64 characters, so a payload carrying a comment
-- body is refused before any statement issues, on every path, including one that
-- never touched this module. That is the same mechanism that closes
-- `approvals.reason`, and it is mechanical rather than remembered.
--
-- **The code is DIFFERENT, and this is the part worth reading twice.** A reason
-- code is a token — `childcare` has no space and is well under 64 characters —
-- so the validator would ADMIT it. Its absence from every payload is therefore a
-- CHOICE this packet makes rather than a consequence of a control it inherits,
-- and it was ruled at the packet's visibility round: **the audit chain records
-- THAT a code was attached, by whom, and when — never WHICH.** The reason is
-- narrower-never-wider applied to readers: the audit chain is immutable and has
-- its own reader population behind `audit.export`, so a code in a payload would
-- put a fact about the requester's circumstances somewhere the comment table's
-- own RLS does not reach. The emitted payload is `{ requestId, commentId,
-- channel }` and nothing else.
--
-- **And no outbox row at all** (FAD-58.5: "comment events may enqueue nothing in
-- this packet"). I-11's posture is untouched because nothing on this surface
-- notifies anybody; an outbound surface is a later packet against SPEC-07.
--
-- `apps/api/test/requests/comment-body-closure.test.ts` proves all three —
-- the body refused in both layers, the code admissible-but-absent, and the
-- outbox untouched — rather than leaving this paragraph as the only control.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 5. The reason-code vocabulary lives in THREE places, and they are held to
--    each other by test
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `request_comments_reason_code_domain` below, `REQUEST_REASON_CODES` in
-- `packages/domain/src/requests/comments.ts`, and `requestReasonCodeSchema` in
-- `packages/contracts/src/requests/index.ts`. Three copies of a closed set are
-- three truths that can drift, so they are not left to agree by inspection: the
-- api suite asserts the three are equal as SETS, exactly as the request subtype
-- and status vocabularies already are.
--
-- The list is a **SCHEDULEPOINT-REQUIREMENT** (never an `OBSERVED` fact) and is
-- extensible only by a recorded decision. The contracts docblock carries the
-- curation reasoning, including the one thing a future reader most needs to
-- know: **the absence of a medical or sick code is the design, not an
-- oversight.**
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 6. X-11 — every key on this table carries `organization_id`
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Including the PRIMARY KEY, which is `(id, organization_id)` rather than `(id)`.
--
-- Under the NARROWED, name-independent exemption that closed FU-19 at M5-H, a
-- unique index is exempted on its COLUMN LIST — exactly `(id)` or exactly
-- `(id, organization_id)` — and never on its name. A bare `(id)` PK would
-- consequently be exempt and would still be an existence oracle: unique checks
-- bypass row-level security, so a caller inserting a chosen id learns `23505`
-- for a row that exists in another tenant and something else otherwise. The
-- composite PK closes it at the schema rather than relying on callers never
-- choosing an id. It is the shape 0024 and the five subtype tables already use.
--
-- `request_comments_tenant_identity` carries the group as well, so the
-- composite foreign keys below can name `(id, organization_id, group_id)` and a
-- comment cannot be attached across a tenant or a group boundary even though
-- referential-integrity checks run with row security off.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 7. What this migration deliberately does NOT do
-- ═══════════════════════════════════════════════════════════════════════════
--
--   * **No status predicate.** There is no CHECK and no trigger gating a comment
--     on the request's lifecycle status, and the omission is a ruled decision
--     rather than an oversight: §4's comments row states four properties and a
--     status gate is not among them, and FAD-58.3's "correction is a new
--     comment" wants headroom rather than a gate. A code can therefore be
--     attached to a withdrawn, denied or expired request. The consequence is
--     owned and bounded by the next paragraph.
--   * **No status MOVEMENT.** Appending a comment does not touch
--     `requests.status` or `requests.version`, there is no trigger here that
--     could, and no `comment` member joins `REQUEST_OPERATIONS` — a comment is
--     not a lifecycle operation, and adding one would require inventing a target
--     status for an operation that has none.
--     `apps/api/test/requests/request-comments.test.ts` proves the root is
--     byte-identical across an append.
--   * **No volume bound.** Neither §4 nor FAD-58 bounds how many comments one
--     request may carry, and inventing a cap would be a rule §4 does not have.
--     Recorded as an observation for M5-006's integration sweep, not as a gap
--     this file papers over.
--   * **No internal-note class.** Both channels are visible to everyone who may
--     see the request (§9 below). §4 names ONE comment surface; a decider-private
--     note would be a NEW visibility concept, and a new concept needs its own
--     recorded decision rather than a policy arm somebody wrote quietly.

-- Up Migration

CREATE TABLE request_comments (
    id                     uuid NOT NULL DEFAULT gen_random_uuid(),
    organization_id        uuid NOT NULL REFERENCES organizations (id),
    group_id               uuid NOT NULL,

    -- The aggregate root the comment is ABOUT. §4's comments are a property of
    -- the REQUEST, not of a subtype row and not of a decision — which is why a
    -- vacation selection's comments live here too (§5.1: "one audit trail, one
    -- comment surface, one approval mechanism").
    request_id             uuid NOT NULL,

    -- FAD-58's two channels. See header §2: which channel a row belongs to
    -- decides which of the two content columns it may populate, in both
    -- directions.
    channel                text NOT NULL,

    -- The requester's controlled vocabulary (FAD-58.1). NULL on a scheduler row,
    -- and there is no column beside it a requester could write prose into.
    reason_code            text,

    -- The scheduler's bounded administrative text (FAD-58.2), of exactly the
    -- class `approvals.reason` and `schedule_versions.change_summary` are. NULL
    -- on a requester row.
    body                   text,

    -- §4: "author recorded". Not nullable and never a system actor: a comment is
    -- something a person said, and the RLS `WITH CHECK` arms in §9 additionally
    -- require this to BE the acting membership, so the recorded author cannot be
    -- somebody the author was not.
    author_membership_id   uuid NOT NULL,

    created_at             timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT request_comments_pk PRIMARY KEY (id, organization_id),

    CONSTRAINT request_comments_channel_domain
        CHECK (channel IN ('requester', 'scheduler')),

    --------------------------------------------------------------------------
    -- Header §2's exactly-one-of rule, in both directions.
    --
    -- Together these two CHECKs are the schema-level statement of FAD-58.1: no
    -- state of this table holds requester-authored free text, because a
    -- requester row has a code and no body and there is nowhere else to put one.
    --------------------------------------------------------------------------
    CONSTRAINT request_comments_requester_channel_is_a_code
        CHECK ((channel = 'requester') = (reason_code IS NOT NULL)),

    CONSTRAINT request_comments_scheduler_channel_is_text
        CHECK ((channel = 'scheduler') = (body IS NOT NULL)),

    -- Header §5. The third copy of the vocabulary; the api suite holds all three
    -- to each other as sets so this cannot drift from the domain or the wire.
    CONSTRAINT request_comments_reason_code_domain
        CHECK (reason_code IS NULL OR reason_code IN (
            'personal',
            'family',
            'childcare',
            'bereavement',
            'travel',
            'education',
            'religious-observance',
            'professional-obligation',
            'other'
        )),

    -- Bounded exactly as `approvals.reason` is, and for the reason 0024 gives: a
    -- bound is what keeps "an administrative note" from becoming a document
    -- store. Whitespace is not a comment.
    CONSTRAINT request_comments_body_len
        CHECK (body IS NULL OR length(btrim(body)) BETWEEN 1 AND 1000),

    CONSTRAINT request_comments_tenant_identity UNIQUE (id, organization_id, group_id),

    CONSTRAINT request_comments_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id),
    CONSTRAINT request_comments_request_fk
        FOREIGN KEY (request_id, organization_id, group_id)
        REFERENCES requests (id, organization_id, group_id),
    CONSTRAINT request_comments_author_fk
        FOREIGN KEY (author_membership_id, organization_id)
        REFERENCES memberships (id, organization_id)
);

ALTER TABLE request_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_comments FORCE  ROW LEVEL SECURITY;

------------------------------------------------------------------------------
-- 9. The policies — FAD-58.4's reader table, at the row layer
--
-- The governing sentence, ratified at this packet's visibility round and taken
-- from migration 0024's header §3 where it was already shipped for a decision
-- reason: **a comment is visible exactly where the REQUEST it is on is visible,
-- and no wider.** §4 says "visible per capability" and names no reader; the
-- capability that decides whether somebody may see a request is the capability
-- that decides whether they may see what is attached to it. Anything else would
-- be a second visibility rule that can drift from the first.
--
-- Three arms, 0023's and 0024's shape, with TWO deliberate differences from
-- `approvals`:
--
--   1. **`request_comments_own` is `FOR ALL`, where `approvals_own` is
--      `FOR SELECT`.** 0024's asymmetry was the right one for a DECISION —
--      "deciding is not a self-scoped act", so a member may read the decision on
--      their own request and may not write one. Commenting IS a self-scoped act
--      on the requester side: FAD-58.1 gives the requester the code channel on
--      THEIR OWN request. The own-arm therefore admits an INSERT, and its
--      `WITH CHECK` is what keeps the admission narrow.
--   2. **Both write arms pin the CHANNEL and the AUTHOR.** The own-arm admits
--      only `channel = 'requester'` authored BY the acting membership; the
--      administration arm admits only `channel = 'scheduler'`, likewise authored
--      by the acting membership. Two properties fall out that no application
--      code has to maintain: **a requester-channel row's author is necessarily
--      the requester of the request it is on**, and **no path can forge an
--      author.** Without the channel predicate a holder of `requests.administer`
--      could attach a CODE to a colleague's request — attributing a circumstance
--      to the person whose request it is, which is the specific thing FAD-58.1
--      exists to prevent.
--
-- These are ROW predicates, not operation gates. What decides whether a caller
-- may perform the comment operations at all is the ROUTE's declared action key
-- (`requests.own.comment`, `requests.comment_any`), evaluated by SPEC-06's
-- layers against current state inside the same transaction (I-19). RLS decides
-- which ROWS; PO-DEC-02's layers decide which OPERATIONS — the division 0023
-- recorded and 0024 restated.
--
-- Each own-arm reaches the root and RE-STATES the membership predicate rather
-- than relying on `requests`'s own policy to filter the join, exactly as 0023's
-- five subtype arms and 0024's own-arm do: row security DOES apply to a table
-- referenced inside a policy expression, so the root's policy is the first
-- control and the restated predicate is the second, and it holds even if the
-- first were ever loosened.
------------------------------------------------------------------------------

CREATE POLICY request_comments_own ON request_comments
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND EXISTS (SELECT 1 FROM requests r
                         WHERE r.id = request_comments.request_id
                           AND r.organization_id = request_comments.organization_id
                           AND r.membership_id = nullif(current_setting('app.membership_id', true), '')::uuid))
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND channel = 'requester'
            AND author_membership_id = nullif(current_setting('app.membership_id', true), '')::uuid
            AND EXISTS (SELECT 1 FROM requests r
                         WHERE r.id = request_comments.request_id
                           AND r.organization_id = request_comments.organization_id
                           AND r.membership_id = nullif(current_setting('app.membership_id', true), '')::uuid));

CREATE POLICY request_comments_group_read_any ON request_comments
    FOR SELECT
    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
       AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
       AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
       AND app_acting_membership_holds('requests.read_any'));

CREATE POLICY request_comments_group_administration ON request_comments
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND app_acting_membership_holds('requests.administer'))
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND channel = 'scheduler'
            AND author_membership_id = nullif(current_setting('app.membership_id', true), '')::uuid
            AND app_acting_membership_holds('requests.administer'));

-- The thread of one request, OLDEST first — a conversation is read from the
-- top, which is the opposite of `approvals_by_request`'s newest-first ordering
-- and deliberately so: a decision history answers "what is the current
-- decision", a comment thread answers "how did this conversation go".
CREATE INDEX request_comments_by_request
    ON request_comments (organization_id, group_id, request_id, created_at, id);

------------------------------------------------------------------------------
-- 8. Grants — SELECT and INSERT for the runtime, and deliberately nothing else
--
-- No UPDATE grant on any column and no DELETE grant for any runtime role. This
-- is the whole mechanism behind §4's "append-only", and adding either grant
-- later would silently remove it — so the absence is stated here as the rule
-- rather than left to be inferred from a missing line.
--
-- `app_worker` gets SELECT and not INSERT; header §3 records why that is a
-- narrowing from 0024's shape rather than an omission.
------------------------------------------------------------------------------

GRANT SELECT, INSERT ON request_comments TO app_runtime;
GRANT SELECT ON request_comments TO app_worker, app_readonly_support, app_breakglass;

-- Down Migration

DROP POLICY IF EXISTS request_comments_group_administration ON request_comments;
DROP POLICY IF EXISTS request_comments_group_read_any       ON request_comments;
DROP POLICY IF EXISTS request_comments_own                  ON request_comments;

DROP TABLE IF EXISTS request_comments;
