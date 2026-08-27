-- SPEC-08 §4 and §5.4/§5.5 — the DECISION record: `approvals`, the one table
-- §4's "Reversal — a new `approvals` record; the prior decision is never
-- overwritten" needs, shared by the five non-vacation subtypes and by the
-- vacation approval transaction (OPUS-M5-002, doc 42 §5d Parts A and B).
--
-- **This migration is additive.** It creates one table and touches nothing that
-- 0021, 0022 or 0023 wrote — no policy is replaced, no function is redefined, no
-- constraint is relaxed, no grant is widened. The down migration therefore has
-- nothing to restore byte-for-byte: it drops what this file created and stops.
-- (Stated because doc 42 §5d requires "down restores byte-for-byte anything
-- replaced", and the honest report is that this migration replaces nothing.)
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Why a decision needs its own row at all
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `requests` already carries `decided_at` and `decided_by`, and a reader might
-- reasonably ask what a separate table adds. Three things, and each of them is a
-- sentence in SPEC-08 §4 that the root columns cannot express:
--
--   * **"A new `approvals` record. The prior decision is never overwritten."**
--     Two columns on the root are ONE decision. A reversal that wrote them again
--     would erase the decision it reverses, which is the specific outcome that
--     sentence forbids. A row per decision is the only shape in which "who
--     approved this, and who later reversed it, and why" survives.
--   * **The denial REASON.** §4: "an administrator 'withdrawing' for someone is
--     a denial with a reason, recorded as such." The reason is scheduler-authored
--     bounded free text; it belongs on the decision, not on the aggregate root,
--     and — see §3 below — it must never travel anywhere else.
--   * **§5.4's `INSERT approvals`.** The vacation approval transaction names this
--     table explicitly, beside the grant update and the selection update, in the
--     same transaction.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 2. "The prior decision is never overwritten" is a PRIVILEGE, not a promise
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `app_runtime` and `app_worker` hold **SELECT and INSERT on this table and
-- nothing else** (§8 below). There is no `GRANT UPDATE` — not on a column, not
-- on the table — and no `GRANT DELETE` for any runtime role. So the sentence is
-- not a rule somebody has to remember while writing a reversal path: **there is
-- no statement a runtime role can issue that would overwrite a decision.**
--
-- This is the `audit_events` discipline applied one table over. The audit module
-- gets its append-only property the same way — by the absence of the grant that
-- would let it be otherwise — and the reason is identical: a rule enforced by
-- code review is a rule that holds until the review that misses it.
--
-- A reversal is therefore necessarily a SECOND row, pointing at the first
-- through `supersedes_approval_id`. The chain is readable in either direction
-- and neither end of it can be edited.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 3. `reason` — where it may live, and the three places it may NOT
--    (I-07, ADR-0019, non-bypass rules 8 and 9)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `approvals.reason` is **scheduler-authored bounded free text on the DECISION
-- record only**, of exactly the class `schedule_versions.change_summary` and
-- `vacation_selections.override_reason` already are. It is bounded at 1000
-- characters, it is not an ingestion path, and it is not clinical.
--
-- **It never enters an audit payload, an outbox payload, or a notification.**
-- That is not a convention this file asks callers to honour — it is a property
-- the payload validator already enforces on every path:
-- `app_audit_payload_is_closed` (migration 0003) and its TypeScript mirror
-- `auditPayloadViolations` (`packages/domain/src/audit/payload.ts`) both require
-- every payload string to match `^[!-~]*$` and to be at most 64 characters. A
-- reason is prose; prose contains spaces; a payload carrying one is refused
-- before any statement issues. `apps/api/test/requests/decision-reason-closure.test.ts`
-- proves it by feeding a realistic multi-word reason to the recorder and to the
-- SQL predicate and asserting BOTH refuse, and by asserting structurally that no
-- decision payload this packet emits names a reason field at all.
--
-- The doc 06 §3.4 classification of the request aggregate as `SENSITIVE-PII`
-- travels with the reason: the policies in §7 give the reason exactly the same
-- visibility the request itself has, and no more.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 4. What this migration deliberately does NOT do — a DECLARED DECISION
--    (the §5c binding note on `approved`), ratified in-round
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Doc 42 §5d carries M5-001's review note as binding: **"`approved` must be
-- reachable solely through the `requests.administer` (or a new
-- decision-capability) path"**, because 0023's `requests_own` is `FOR ALL` with
-- `status` in the column grant, so at the SQL layer a member's own row can walk
-- every §2 edge.
--
-- **There is no trigger in this file gating a status transition on a
-- capability**, and the omission is a decision rather than an oversight.
--
--   * The note's own sentence says where the control belongs: *"RLS decides
--     rows, never operations; PO-DEC-02's layers decide operations."* For
--     ANOTHER member's row the write already cannot happen at all without
--     `requests.administer` — 0023's `requests_group_administration` is the only
--     arm whose `WITH CHECK` admits it. For a member's OWN row the write is
--     admitted by `requests_own`, and what refuses it is the ROUTE's declared
--     action key (`requests.approve` / `requests.deny`), evaluated by SPEC-06's
--     layers against current state inside the same transaction (I-19).
--   * A capability trigger on `→ approved` / `→ denied` would **retroactively
--     fail four shipped proof suites** — `migration-0021-populated-cycle`
--     (`walk(approved, ['under_review','approved'])`),
--     `migration-0022-populated-cycle` (the vacation two-step, three sites),
--     `migration-0023-populated-cycle` (its status loop) and
--     `lifecycle-service.test.ts` — every one of which walks to `under_review`
--     and `approved` under a MEMBER context deliberately. Curing that would mean
--     editing prior packets' proofs to accommodate a new guard, which is the
--     weakening-a-test shape in reverse.
--
-- **The residue, owned rather than discovered.** Under layers-only, an operator
-- at a psql prompt running under a member's own tenant context CAN move that
-- member's own request along §2's edges, including into `approved`. That is the
-- DELIBERATE division recorded since 0023 ("RLS decides which ROWS, never which
-- OPERATIONS") and verified at the M5-001 review; it is not a gap this migration
-- opens. What this packet adds is the positive proof at the layer that does
-- decide operations: `apps/api/test/requests/decision-authority.test.ts` drives
-- every new write route as a member holding only CAP-021's own-keys, checks the
-- refusal comes from the authorization layer rather than from some neighbouring
-- constraint, and asserts over the REGISTERED route table that every route
-- capable of writing `approved` declares a decision key.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 5. The two-step, and why this table does not enforce it
-- ═══════════════════════════════════════════════════════════════════════════
--
-- M5-000b finding #1 is binding: §5.4's printed single-statement root update
-- (`UPDATE requests SET status = 'approved'`) is **not legal under §2**, which
-- carries no `submitted → approved` cell for any subtype. The implementable
-- writer is the two-step `submitted → under_review → approved` inside ONE
-- transaction, and the deferred D-27 mapping trigger — which reads CURRENT rows
-- at COMMIT — never sees the intermediate.
--
-- That is a property of the WRITER, and 0021's `app_guard_request_transition`
-- already refuses any other spelling: a single-statement `submitted → approved`
-- raises `restrict_violation` today, unchanged by this file. Adding a second
-- copy of the rule here would be a third place for it to drift from §2.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 6. X-11 — every key on this table carries `organization_id`
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Including the PRIMARY KEY, which is `(id, organization_id)` rather than `(id)`.
--
-- FU-19 records that the X-11 control is blind to caller-named primary keys — it
-- checks `UNIQUE` constraints and leaves `PRIMARY KEY` alone — so a bare `id` PK
-- would pass the control and still be an existence oracle: unique checks bypass
-- row-level security, so a caller inserting a chosen id learns `23505` for a row
-- that exists in another tenant and `23503`/success otherwise. Doc 42 §5d's
-- instruction is to **design as if the control were not blind**, which is what
-- the composite PK does. It is the same shape M5-000b applied to the five
-- subtype tables' `(request_id, organization_id)` PKs.
--
-- `id` alone is consequently not unique across organizations, and nothing in
-- this schema needs it to be: every reference to this table is composite and
-- carries the tenant columns with it.
--
-- **The constraint NAME is load-bearing, and it is `approvals_pk` on purpose.**
-- The X-11 registry control walks every unique index on every registered tenant
-- table and exempts the ones it takes to be primary keys by matching
-- `/_pkey$/` on the index name (`apps/api/test/tenancy/roles-and-schema.test.ts`,
-- "the primary keys are on `id`, a server-generated UUIDv4 the caller does not
-- choose"). `approvals_pk` does NOT match that pattern, so this table's primary
-- key is one the control genuinely EVALUATES rather than waves through — and it
-- passes, because `organization_id` participates. Renaming it to
-- `approvals_pkey` would change no behaviour of the database and would silently
-- delete that coverage, which is precisely FU-19's shape: a control that stops
-- looking without anything failing.
--
-- **AMENDMENT 2026-08-26 (OPUS-M5-H, FU-19 discharged): the paragraph above is
-- now HISTORY, and the name is no longer load-bearing.** The X-11 control's
-- exemption was narrowed in the same change that closes FU-19: it is now a
-- statement about an index's COLUMN LIST — exactly `(id)`, or exactly
-- `(id, organization_id)` — and the index name is not consulted at all. So this
-- table's primary key is evaluated because of what it IS rather than because of
-- what it is called, and renaming it to `approvals_pkey` would now change
-- nothing whatsoever. **The name stays `approvals_pk` regardless**: it is a
-- shipped identifier, renaming it would rewrite a landed migration for cosmetic
-- reasons, and the paragraph above must remain readable as the reason it was
-- chosen. The text is amended rather than deleted, per this repository's
-- standing rule that the provenance of a decision stays legible (the NR-20
-- precedent).

-- Up Migration

CREATE TABLE approvals (
    id                     uuid NOT NULL DEFAULT gen_random_uuid(),
    organization_id        uuid NOT NULL REFERENCES organizations (id),
    group_id               uuid NOT NULL,

    -- The aggregate root the decision is ABOUT. Every decision names one,
    -- including a vacation decision — §5.1's linkage is what makes "one audit
    -- trail, one comment surface, one approval mechanism" true of vacation too.
    request_id             uuid NOT NULL,

    -- §4's three acts. `reversed` is the approval-side reversal: a new record
    -- that supersedes an approval without touching it.
    --
    -- There is deliberately no `denied` reversal, and the absence is recorded
    -- rather than worked around: §2's matrix gives `denied` NO outgoing edge for
    -- any subtype, so reversing a denial would require a status move the matrix
    -- forbids. §4's reversal sentence does not name a denied-side edge and a
    -- denied request's remedy is a fresh submission, so there is no internal
    -- contradiction forcing a cell — inventing one would be the opposite error
    -- to FAD-55's. Recorded as the SIXTH item on the M5 exit sweep's SPEC-08
    -- clarification docket.
    decision               text NOT NULL,

    -- WHO decided. Not nullable and not a system actor: a decision is an act a
    -- person takes responsibility for, and the sweeper — the one request-side
    -- writer that is genuinely nobody's decision — writes `expired`, which is
    -- not a decision and produces no row here.
    decided_by             uuid NOT NULL,
    decided_at             timestamptz NOT NULL DEFAULT now(),

    -- §3 of this header. Present exactly when §4 or §5.5 makes it MANDATORY.
    reason                 text,

    -- §5.5's audited over-quota approval. Only ever true for a vacation
    -- decision, because only a vacation approval consumes a quota unit.
    is_override            boolean NOT NULL DEFAULT false,

    -- The selection a vacation decision decided, or NULL for the five
    -- non-vacation subtypes. A nullable discriminant rather than two tables,
    -- because §5 says vacation SHARES the approval mechanism — two tables would
    -- be two mechanisms with one name.
    vacation_selection_id  uuid,

    -- §4: "A new `approvals` record. The prior decision is never overwritten."
    -- A reversal points at what it reverses; nothing else does.
    supersedes_approval_id uuid,

    created_at             timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT approvals_pk PRIMARY KEY (id, organization_id),

    CONSTRAINT approvals_decision_domain
        CHECK (decision IN ('approved', 'denied', 'reversed')),

    --------------------------------------------------------------------------
    -- The reason is MANDATORY for a denial, for a reversal, and for an audited
    -- over-quota override — and PROHIBITED for an ordinary approval.
    --
    -- Both directions, for the reason 0022's `vacation_selections_override_
    -- reason_coherent` gives: neither an unexplained denial nor a reason
    -- attached to a decision that needs none can be stored. An optional note on
    -- an ordinary approval would be new free text on a SENSITIVE-PII aggregate
    -- that no specification asks for, which is a question this packet declines
    -- to open.
    --------------------------------------------------------------------------
    CONSTRAINT approvals_reason_mandatory_where_stated
        CHECK ((reason IS NOT NULL) = (decision <> 'approved' OR is_override)),

    -- Bounded exactly as `vacation_selections.override_reason` is. A bound is
    -- what keeps "an administrative note" from becoming a document store.
    CONSTRAINT approvals_reason_len
        CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 1000),

    -- An override is a QUOTA act (§5.5), and only a vacation decision consumes
    -- quota. `is_override` on a time-off approval would be a field with no
    -- referent.
    CONSTRAINT approvals_override_is_a_vacation_act
        CHECK (NOT is_override OR vacation_selection_id IS NOT NULL),

    -- A reversal names what it reverses, and only a reversal does.
    CONSTRAINT approvals_reversal_names_its_predecessor
        CHECK ((decision = 'reversed') = (supersedes_approval_id IS NOT NULL)),

    CONSTRAINT approvals_tenant_identity UNIQUE (id, organization_id, group_id),

    CONSTRAINT approvals_group_fk
        FOREIGN KEY (group_id, organization_id) REFERENCES groups (id, organization_id),
    CONSTRAINT approvals_request_fk
        FOREIGN KEY (request_id, organization_id, group_id)
        REFERENCES requests (id, organization_id, group_id),
    CONSTRAINT approvals_decided_by_fk
        FOREIGN KEY (decided_by, organization_id)
        REFERENCES memberships (id, organization_id),
    CONSTRAINT approvals_selection_fk
        FOREIGN KEY (vacation_selection_id, organization_id, group_id)
        REFERENCES vacation_selections (id, organization_id, group_id),
    -- The self-reference is composite too, so a reversal cannot point at a
    -- decision in another tenant even though referential-integrity checks run
    -- with row security off.
    CONSTRAINT approvals_supersedes_fk
        FOREIGN KEY (supersedes_approval_id, organization_id, group_id)
        REFERENCES approvals (id, organization_id, group_id)
);

ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals FORCE  ROW LEVEL SECURITY;

------------------------------------------------------------------------------
-- 7. The policies — 0023's three arms, with ONE deliberate difference
--
-- `approvals_own` is `FOR SELECT`, where 0023's `requests_own` is `FOR ALL`.
--
-- That asymmetry is the whole point of this table's authorization posture, and
-- it is the direction 0023's own comment predicts. 0023 made the own-arm
-- `FOR ALL` because *submitting and withdrawing are self-scoped acts* — a member
-- acts on their own request. **Deciding is not a self-scoped act.** A member
-- must be able to READ the decision on their own request (that is how they learn
-- they were denied, and it is what carries the reason to the person it is for),
-- and must not be able to write one. Making the own-arm `FOR ALL` here would
-- hand every member an INSERT into the table that records who decided.
--
-- The own-arm reaches the root and RE-STATES the membership predicate rather
-- than relying on `requests`'s own policy to filter the join, exactly as 0023's
-- five subtype arms do: row security DOES apply to a table referenced inside a
-- policy expression, so the root's policy is the first control and the restated
-- predicate is the second, and it holds even if the first were ever loosened.
------------------------------------------------------------------------------

CREATE POLICY approvals_own ON approvals
    FOR SELECT
    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
       AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
       AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
       AND EXISTS (SELECT 1 FROM requests r
                    WHERE r.id = approvals.request_id
                      AND r.organization_id = approvals.organization_id
                      AND r.membership_id = nullif(current_setting('app.membership_id', true), '')::uuid));

CREATE POLICY approvals_group_read_any ON approvals
    FOR SELECT
    USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
       AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
       AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
       AND app_acting_membership_holds('requests.read_any'));

CREATE POLICY approvals_group_administration ON approvals
    FOR ALL
    USING      (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND app_acting_membership_holds('requests.administer'))
    WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid
            AND nullif(current_setting('app.group_id', true), '') IS NOT NULL
            AND group_id = nullif(current_setting('app.group_id', true), '')::uuid
            AND app_acting_membership_holds('requests.administer'));

-- The decision history of one request, newest first — the queue's detail read
-- and §4's "the prior decision is never overwritten" made queryable.
CREATE INDEX approvals_by_request
    ON approvals (organization_id, group_id, request_id, decided_at DESC);

-- The vacation side's back-reference, partial because most rows have none.
CREATE INDEX approvals_by_selection
    ON approvals (organization_id, group_id, vacation_selection_id)
    WHERE vacation_selection_id IS NOT NULL;

------------------------------------------------------------------------------
-- 8. Grants — SELECT and INSERT, and deliberately nothing else (§2)
--
-- No UPDATE grant on any column and no DELETE grant for any runtime role. This
-- is the whole mechanism behind "the prior decision is never overwritten", and
-- adding either grant later would silently remove it — so the absence is stated
-- here as the rule rather than left to be inferred from a missing line.
------------------------------------------------------------------------------

GRANT SELECT, INSERT ON approvals TO app_runtime, app_worker;
GRANT SELECT ON approvals TO app_readonly_support, app_breakglass;

-- Down Migration

DROP POLICY IF EXISTS approvals_group_administration ON approvals;
DROP POLICY IF EXISTS approvals_group_read_any       ON approvals;
DROP POLICY IF EXISTS approvals_own                  ON approvals;

DROP TABLE IF EXISTS approvals;
