# Codex Architecture Review — Remediation Record

**Status: `PROPOSED`. This remediation is not self-approved.**

| | |
|---|---|
| **Architecture originally reviewed** | `55bb7d81a170541f4dd62249b668df4ac9a5d6e2` |
| **Independent review checkpoint** | `06df9a8c7e62bb22b49a77c5379c0d0b72d4015e` |
| **Authoritative review** | [docs/reviews/architecture/codex-architecture-review.md](../../reviews/architecture/codex-architecture-review.md) — **unmodified** |
| **Review verdict** | `REDESIGN REQUIRED` — 4 Critical, 11 High, 10 Medium, 2 Low |
| **Remediation date** | 2026-08-01 |
| **Claimed status** | **REMEDIATED — AWAITING INDEPENDENT VERIFICATION** for 25 findings at Phase 14; **amended 2026-08-01:** CAR-026 remediated under explicit authorization → **27 remediated, 0 open** (CAR-025's evidence dependencies tracked separately) |
| **Architecture status** | **NOT APPROVED.** All 23 ADRs `PROPOSED`; no gate passed; nothing implemented |

> **This document does not upgrade the review's verdict.** Only a separate independent reviewer can do that. Every "remediated" claim below means *a design change was made that addresses the finding*, **not** that it was verified, tested, or proven.

---

## 1. Product-owner decisions recorded

> **AMENDMENT NOTE — 2026-08-01 (V-03).** **PO-DEC-10, PO-DEC-01 and PO-DEC-03 were subsequently RESOLVED on 2026-08-01 under the product owner's delegated decision authority**, recorded in [docs/fable/21-decision-resolution.md](../../fable/21-decision-resolution.md) and dispositioned in [internal-verification-corrections.md](internal-verification-corrections.md) §0. PO-DEC-03's resolution adopts the design already recorded here, and [SPEC-08](../specs/SPEC-08-request-subtype-lifecycles.md) and [ADR-0016](../decisions/ADR-0016-request-aggregate-and-subtypes.md) are **no longer marked provisional**.
> **The table below is a historical record of the state at Phase 14 and is deliberately left unchanged.** It said "pending" because they *were* pending when it was written; rewriting it would destroy the sequencing information that V-02 and V-03 are about. Read it as of its own date, and read this note for what changed afterwards.
> **The authority is the product owner's direct instruction of 2026-08-01, given outside the repository** — it is not established by any document in this package, and no document here should be read as establishing it.

**Obtained before any architecture edit. All three remain `pending` — none was approved.** *(As of Phase 14, the date of this table. See the amendment note above.)*

| Decision | Owner's choice | Effect |
|---|---|---|
| **PO-DEC-10** Locum billing | **Restore to the canonical register as `pending`; working default = external commercial policy consuming a versioned read-only membership/FTE projection** | Row restored to [report 24](../../../schedulepoint-research/reports/24-production-completeness-gates.md) §3 with its **original identifier**. No billing capability added. [19](../19-risks-and-decisions.md) §2.2a no longer *assumes* the recommendation |
| **PO-DEC-01** Site model | **Keep pending; location as an attribute with an explicit migration boundary** | `sites` table and `locations.site_id` **withdrawn**; `locations.site_label` attribute; both migration directions modelled in [06](../06-data-architecture.md) §3.2a |
| **PO-DEC-03** Request model | **One Request aggregate + constrained subtype records + linked distinct Vacation lifecycle** | [SPEC-08](../specs/SPEC-08-request-subtype-lifecycles.md) and [ADR-0016](../decisions/ADR-0016-request-aggregate-and-subtypes.md), **explicitly marked provisional** |

**Pending product decisions: 18 → 19.**

---

## 2. Status summary

| Severity | Total | Remediated — awaiting verification | Open |
|---|---:|---:|---:|
| **Critical** | 4 | **4** | 0 |
| **High** | 11 | **11** | 0 |
| **Medium** | 10 | **10** | 0 |
| **Low** | 2 | **2** | 0 |
| **Total** | **27** | **27** | **0** |

> **Amended 2026-08-01 (delegated-authority mandate).** At Phase 14 this table recorded **25 remediated / 2 open** — CAR-026 (source-count correction, then unauthorized) and the evidence half of CAR-025. **CAR-026 was subsequently remediated under explicit product-owner authorization** (see its block below). The *evidence* half of **CAR-025** remains a set of external dependencies (EV-1..EV-8), now carried with provisional resolutions in [docs/fable/21-decision-resolution.md](../../fable/21-decision-resolution.md) §5 — its design half was already remediated at Phase 14. §4 preserves the original open-findings record for history.

---

## 3. Findings

### CAR-001 · Critical · Session-global active group can redirect a valid command to the wrong schedule

- **Disposition:** REMEDIATED
- **Changed:** [01](../01-architecture-overview.md) §4 (I-01 reworded, I-14 added) · [05](../05-tenancy-entitlements-authorization.md) §4.1 (replaced) · [14](../14-security-and-privacy.md) T-01 · **new** [SPEC-01](../specs/SPEC-01-request-context-and-tenant-isolation.md) §§2–3, 5–6
- **Architectural resolution:** The rule "never trust a client tenant identifier" is **inverted to "the client declares, the server verifies."** Context is an immutable request-scoped tuple carrying `expected_organization_id`, `expected_group_id`, `context_version`, and `session_epoch`, validated against server-side membership, freshness, **and the target aggregate**. A mismatch is **rejected** (`409 CONTEXT_STALE` / `CONTEXT_TARGET_MISMATCH`), never substituted. **No session-global active group exists and no handler reads one.** WebSocket commands re-declare context on **every frame**; jobs freeze it at enqueue and re-authorize at execution.
- **ADRs:** [ADR-0022](../decisions/ADR-0022-request-scoped-tenant-context.md) **(new)**, ADR-0003, ADR-0004 (revised)
- **Capabilities:** CAP-001, CAP-002, CAP-003, CAP-006, CAP-014, CAP-019, CAP-031, CAP-032
- **Invariants:** **I-14 new**; I-01 rewritten
- **Architecture test:** `validate.py` check 44 (transaction-local + declared-context language); [SPEC-01](../specs/SPEC-01-request-context-and-tenant-isolation.md) §7.1 T-01..T-06 extending QA-TEN-004/SBX-004
- **Remaining evidence:** T-01..T-06 unexecuted; two-browser-context harness not built
- **Remaining risk:** RISK-11 (raised to med/high) — the mechanism is sound in design and unproven in execution
- **Claimed status:** **REMEDIATED — AWAITING INDEPENDENT VERIFICATION**

### CAR-002 · Critical · Session-scoped RLS variables can survive pooled-connection reuse

- **Disposition:** REMEDIATED
- **Changed:** [05](../05-tenancy-entitlements-authorization.md) §4.3 (replaced) · [02](../02-technology-stack.md) §2.3 · [06](../06-data-architecture.md) D-10 · [references](../references/official-technical-sources.md) **S-03b added** · **new** [SPEC-01](../specs/SPEC-01-request-context-and-tenant-isolation.md) §4
- **Architectural resolution:** **Verified against primary source (S-03b):** `SET LOCAL` lasts only to the end of the current transaction; a plain `SET` persists for the session; `SET LOCAL` outside a transaction block warns and has no effect. Connection-checkout context is therefore **unsafe by construction** and is withdrawn. Every tenant statement runs inside a unit-of-work wrapper that `BEGIN`s, sets context via `set_config(..., true)`, **reads it back**, and ends with the transaction — **so there is no cleanup step to forget.** Outside the wrapper, RLS predicates are false and every tenant table **returns zero rows and rejects every write (fail-closed).** Five database roles defined; **statement-level pooling prohibited**; privileged support and break-glass boundaries specified.
- **ADRs:** [ADR-0022](../decisions/ADR-0022-request-scoped-tenant-context.md) **(new)**, ADR-0003 (revised)
- **Capabilities:** CAP-003 and every tenant-scoped capability
- **Invariants:** **I-15 new**
- **Architecture test:** `validate.py` check 44; [SPEC-01](../specs/SPEC-01-request-context-and-tenant-isolation.md) §7.2 T-07..T-15 — **scheduled at the schema/prototype stage, before feature work**
- **Remaining evidence:** T-07..T-15 unexecuted; TDG-02 and TDG-03 must confirm the ORM and pooler honour `SET LOCAL`
- **Remaining risk:** RISK-03 — RLS performance unmeasured (A-6)
- **Claimed status:** **REMEDIATED — AWAITING INDEPENDENT VERIFICATION**

### CAR-003 · Critical · Picklist selection is not one atomic compare-and-set transition

- **Disposition:** REMEDIATED
- **Changed:** [06](../06-data-architecture.md) §3.5 and §4 (**D-3 split into D-3a/D-3b/D-3c; D-11..D-13 added**) · [10](../10-picklist-and-realtime.md) §§4–8 · [14](../14-security-and-privacy.md) T-18 · **new** [SPEC-02](../specs/SPEC-02-picklist-turn-transaction.md)
- **Architectural resolution:** **The missing constraint is `UNIQUE (turn_id) WHERE accepted` (D-3a)** — the only thing that stops one turn accepting two different work items, which is the physician-and-proxy failure. Added alongside D-3b (one claimant per item, correctly described at last) and D-3c (one open turn). **One authoritative transaction** serialised by `FOR UPDATE` on the picklist row evaluates every predicate — turn open, not expired by **server** clock, list active and unpaused, actor authority, aggregate version, fencing token — and the constraints decide the race. Command idempotency (D-11), gapless per-picklist event sequence (D-12), coordinator leases with monotonic fencing tokens (D-13). **Coordinators relay a durable ordered log; they never generate events, so two coordinators cannot disagree.** Correction and reopening after completion specified.
- **ADRs:** [ADR-0023](../decisions/ADR-0023-picklist-turn-transaction.md) **(new)**, ADR-0008 (revised), ADR-0009
- **Capabilities:** CAP-030, CAP-031, CAP-032, CAP-033, CAP-034, CAP-060
- **Invariants:** **I-16 new**; D-3a/b/c, D-11, D-12, D-13
- **Architecture test:** `validate.py` check 46 (one-result-per-turn + aggregate-version invariants present); [SPEC-02](../specs/SPEC-02-picklist-turn-transaction.md) §10 P-01..P-15 — **P-02 is the case the old design could not satisfy**
- **Remaining evidence:** P-01..P-15 unexecuted, including the ≥50-trial races
- **Remaining risk:** RISK-05 re-scoped; **the source product's picklist execution was never observed, so every lifecycle here is our design**
- **Claimed status:** **REMEDIATED — AWAITING INDEPENDENT VERIFICATION**

### CAR-004 · Critical · The ingestion boundary cannot prove that identifying values never enter the platform

- **Disposition:** REMEDIATED
- **Changed:** [12](../12-integrations-and-ingestion-privacy.md) §§2, 4.1–4.2, 7 · [06](../06-data-architecture.md) §3.5 (work items) and §3.7 (quarantine) · [10](../10-picklist-and-realtime.md) §2 · [14](../14-security-and-privacy.md) T-14 · **new** [SPEC-03](../specs/SPEC-03-raw-ingress-trust-boundary.md)
- **Architectural resolution:** **Three holes closed.** **(1) Boundary placement:** the trusted boundary moves *ahead of* all application observability and durable infrastructure into a **raw-ingress enclave** — no body logging, no payload tracing, no error-reporting SDK in the image, no core dumps, read-only filesystem, no durable queue or DLQ payload, no database credential, egress allowlisted (E-1..E-12). **Replay re-fetches from the source; it never replays a stored body.** **(2) Semantic relabeling:** every accepted field carries a **type, shape, and controlled-vocabulary constraint** — `work_item_label_ref` and `location_ref` must *resolve* to approved rows, so `"John Smith"` cannot pass under an allowed key. Detectors are a **secondary alarm whose completeness is never assumed**. **Rejection, never sanitization.** **(3) Free text:** `picklist_work_items.description` and `title` are **removed**; the vocabulary is the provable safe contract. **Quarantine stores field paths, codes, counts, and value class — never values and never hashes**, because a hash of a patient name is a re-identifiable pseudonym. **SBX-029 redefined as a 16-surface canary sweep** including backups, DLQ, traces, crash artifacts, and support tooling.
- **ADRs:** [ADR-0021](../decisions/ADR-0021-raw-ingress-enclave.md) **(new)**, ADR-0011 (revised), ADR-0012 (revised)
- **Capabilities:** CAP-030, CAP-055, CAP-060, CAP-061, CAP-062, CAP-063, CAP-064, CAP-065, CAP-068
- **Invariants:** **I-17 new**; I-07 re-scoped
- **Architecture test:** `validate.py` check 47 (no unrestricted free text on protected paths); [SPEC-03](../specs/SPEC-03-raw-ingress-trust-boundary.md) §10 I-01..I-12
- **Remaining evidence:** **`G-CONN` blocked on EV-1 (vendor specifications), EV-2 (restorable backup access), EV-3 (error-reporting vendor API).** Stated as blocking, not worked around
- **Remaining risk:** RISK-10 redesigned; **RISK-30 new** — schedulers may reject the loss of free text
- **Claimed status:** **REMEDIATED — AWAITING INDEPENDENT VERIFICATION**

### CAR-005 · High · The selected Node.js topology cannot host the selected solver as documented

- **Disposition:** REMEDIATED
- **Changed:** [01](../01-architecture-overview.md) §2.2 (**4 → 6 process classes; 1 → 3 images**) · [02](../02-technology-stack.md) §§1, 2.1 · [03](../03-system-context-and-containers.md) · [08](../08-automated-scheduling-engine.md) §1 · [17](../17-deployment-and-operations.md) · [references](../references/official-technical-sources.md) **S-04 added** · **new** [SPEC-04](../specs/SPEC-04-solver-runtime-and-rule-model.md) §1, [SPEC-10](../specs/SPEC-10-deployment-topology.md) §2
- **Architectural resolution:** **Verified (S-04): OR-Tools supports C++, Python, Java, and C# — not Node.js.** ADR-0002's "one runtime across all four process classes" is **withdrawn**. A **separately packaged Python solver worker** in its own image, reached over a versioned authenticated RPC, **one solve per subprocess** so cancellation is enforceable by termination, **no database credential**, dedicated CPU pool, per-organization concurrency cap. Cost stated plainly: a second language with its own SBOM, patch stream, and local-development requirement.
- **ADRs:** [ADR-0020](../decisions/ADR-0020-solver-runtime-packaging.md) **(new)**, ADR-0001, ADR-0002, ADR-0006, ADR-0015 (all revised)
- **Capabilities:** CAP-015, CAP-016, CAP-017, CAP-059, CAP-067
- **Architecture test:** `validate.py` check 48 — **solver runtime must be compatible with the declared stack; a document claiming Node.js hosts the solver fails**
- **Remaining evidence:** SP-5 spike (serialise, solve, cancel, timeout, kill, restart, reproduce) unexecuted; TDG-11 open
- **Remaining risk:** **RISK-29 new** — the second language is permanent maintenance surface
- **Claimed status:** **REMEDIATED — AWAITING INDEPENDENT VERIFICATION**

### CAR-006 · High · The solver contract omits required rule data and overpromises control and explanation

- **Disposition:** REMEDIATED
- **Changed:** [06](../06-data-architecture.md) §§3.2–3.3 (**`rules`, `membership_work_profiles`, `membership_weekday_fte` created; D-4 → D-4a/D-4d**) · [08](../08-automated-scheduling-engine.md) §§2–7 · [18](../18-capability-traceability.md) CAP-013/015/016/017/059 · **new** [SPEC-04](../specs/SPEC-04-solver-runtime-and-rule-model.md) §§2–8
- **Architectural resolution:** `Constraint[]` replaced by a **typed, versioned rule AST with a closed node set** covering every report-21 rule class, a compiler whose unmapped node **fails CI**, and schema migrations. **Weekday FTE and maximum-assignment data gain canonical effective-dated tables.** The hard/soft invariant is enforced in data (`CHECK`), in the compiler (no path from `HARD` to an objective term), and by **independent re-validation of every returned solution**. Cancellation is layered — solver deadline, solver callback, **process kill** — because a polled flag cannot interrupt a native solve. Reproducibility records image digest, parameters, worker count, compiler version, and architecture, **and states exactly what is not promised across a solver upgrade or a different worker count.** **The "minimal infeasibility core" and "dominated alternative" promises are withdrawn** in favour of four bounded tiers with **`EXPLANATION_BUDGET_EXCEEDED` and `EXPLANATION_UNAVAILABLE` as honest first-class states.** D-4 rescoped per configuration so candidate builds can be compared.
- **ADRs:** ADR-0006 (revised), [ADR-0020](../decisions/ADR-0020-solver-runtime-packaging.md)
- **Capabilities:** CAP-013, CAP-015, CAP-016, CAP-017, CAP-045, CAP-058, CAP-059, CAP-067
- **Architecture test:** `validate.py` checks 40 (structures resolve) and 48; [SPEC-04](../specs/SPEC-04-solver-runtime-and-rule-model.md) §9 S-01t..S-16t
- **Remaining evidence:** **No benchmark has been run.** `B-*` corpus not built; acceptance bands **undefined and not claimed**; whether CP-SAT exposes the assumption mechanism T1 needs is **unverified**
- **Remaining risk:** RISK-01, RISK-02 unchanged; PO-DEC-13 and PO-DEC-23 pending
- **Claimed status:** **REMEDIATED — AWAITING INDEPENDENT VERIFICATION**

### CAR-007 · High · Assignment constraints make immutable version cloning unsafe or impossible

- **Disposition:** REMEDIATED
- **Changed:** [06](../06-data-architecture.md) §3.3 (**`assignment_identities` + `assignment_snapshots` replace `assignments`; `assignment_versions` removed**) and §4 (**D-1 → D-1a/D-1b; D-14..D-17 added**) · [07](../07-schedule-and-publication.md) §§1–4 · **new** [SPEC-05](../specs/SPEC-05-schedule-version-identity-and-publication.md)
- **Architectural resolution:** **Identity is separated from snapshot** — the root error was treating "an assignment" as one thing. The exclusion constraint gains **`version_id` in its equality columns (D-1a)**, which is the entire fix: V1 and V2 now hold identical assignment sets without conflicting. **D-1b** enforces real-world non-overlap across *current published* versions, which is what D-1 was reaching for. **Published immutability moves from prose into database triggers (D-15a–d)** — chosen over grants because the permission depends on the parent row's state, which only a trigger can evaluate. `locked` becomes one concept (`lock_state` on versions; `is_pinned` on snapshots). The version state set now matches the state machine, including a durable `publishing` state. `is_current` with a partial unique index (D-16); publication idempotency (D-17). **The V1→V2→V3 proof is specified as V-01..V-16.**
- **ADRs:** ADR-0007 (revised)
- **Capabilities:** CAP-014, CAP-017, CAP-018, CAP-019, CAP-020, CAP-023, CAP-027, CAP-045, CAP-046, CAP-047, CAP-049
- **Invariants:** **I-18 new**; D-1a, D-1b, D-14, D-15a–d, D-16, D-17
- **Architecture test:** `validate.py` check 45 — **published-version mutation must be prohibited**; [SPEC-05](../specs/SPEC-05-schedule-version-identity-and-publication.md) §8 V-01..V-16 at the schema stage
- **Remaining evidence:** V-01..V-16 unexecuted; publication latency at scale unmeasured
- **Remaining risk:** RISK-09 unchanged
- **Claimed status:** **REMEDIATED — AWAITING INDEPENDENT VERIFICATION**

### CAR-008 · High · Authorization precedence and freshness are undefined across four layers

- **Disposition:** REMEDIATED
- **Changed:** [05](../05-tenancy-entitlements-authorization.md) §§1, 3, 4.2, 4.4–4.6, 7 · [06](../06-data-architecture.md) §3.1 · [10](../10-picklist-and-realtime.md) §§4–5 · **new** [SPEC-06](../specs/SPEC-06-authorization-truth-table.md)
- **Architectural resolution:** **One pure evaluator and a normative truth table** with fourteen ordered steps and seven precedence rules. **Explicit deny beats every allow (P-1); an explicit allow never rescues an unentitled module or a suspended membership (P-2); entitlement is evaluated before permission (P-3).** Module-dependency failure, expired entitlements, suspended and expired memberships, organization-level roles, and **disabled-module data behaviour** all get defined answers. Freshness by four version counters bumped **in the same transaction as the change**, a 30-second hard TTL, and no caching of object policies or irreversible actions. **Jobs re-authorize at execution and at every checkpoint; WebSockets re-authorize on every command frame; subscriptions are closed on privilege change.** Overlapping grant windows are prohibited by an exclusion constraint so P-1 has an unambiguous row.
- **ADRs:** ADR-0004, ADR-0005, ADR-0008 (all revised)
- **Capabilities:** CAP-006, CAP-008, CAP-010, CAP-032, CAP-034, CAP-042, CAP-044, CAP-057 and every protected capability
- **Invariants:** **I-19 new**
- **Architecture test:** `validate.py` check 43 (all IDs resolve); [SPEC-06](../specs/SPEC-06-authorization-truth-table.md) §8 — generated cross-product executed against **six surfaces, all of which must agree**
- **Remaining evidence:** A-01..A-15 unexecuted; the capability catalogue is not enumerated
- **Remaining risk:** PO-DEC-11 and PO-DEC-19 pending
- **Claimed status:** **REMEDIATED — AWAITING INDEPENDENT VERIFICATION**

### CAR-009 · High · Hash-only Web Push registrations cannot be used for delivery

- **Disposition:** REMEDIATED
- **Changed:** [06](../06-data-architecture.md) §3.1 `push_registrations` · [14](../14-security-and-privacy.md) §5 · [18](../18-capability-traceability.md) CAP-041 · [references](../references/official-technical-sources.md) **S-05 added** · **new** [SPEC-07](../specs/SPEC-07-notification-delivery-contracts.md) §3
- **Architectural resolution:** **Verified (S-05): a `PushSubscription` comprises the endpoint, `p256dh`, and `auth`, and the application server must retain all three to address and encrypt a message.** Hash-only storage could never deliver. Delivery material is now **envelope-encrypted and retrievable only by the delivery-worker role**, with `subscription_lookup_hash` retained separately for deduplication. Key versioning and rotation, endpoint redaction to origin, prohibition from logs/traces/errors/audit, purge on invalidation and revocation, consent required before storage, and **a database reader without the delivery role recovers nothing.**
- **ADRs:** ADR-0010 (revised)
- **Capabilities:** CAP-041
- **Architecture test:** `validate.py` check 49 — **push storage must retain usable encrypted delivery material; a hash-only design fails**
- **Remaining evidence:** N-01, N-02 unexecuted; TDG-06 open
- **Remaining risk:** PO-DEC-07 pending
- **Claimed status:** **REMEDIATED — AWAITING INDEPENDENT VERIFICATION**

### CAR-010 · High · Notification retries and escalation can duplicate messages after ambiguous provider outcomes

- **Disposition:** REMEDIATED
- **Changed:** [06](../06-data-architecture.md) §3.6 (**`notification_intents`, `logical_deliveries`, `provider_callbacks` created; `delivery_attempts` rekeyed**) · [11](../11-notifications-and-communications.md) §§2, 4–7 · **new** [SPEC-07](../specs/SPEC-07-notification-delivery-contracts.md) §§2, 4–6
- **Architectural resolution:** **"Exactly-once apparent" is withdrawn.** The guarantee is stated exactly: **domain state exactly-once; external delivery at-least-once with a recorded ambiguity window.** `attempt` is removed from the deduplication key; the provider idempotency key is the **stable `logical_delivery_id`**. **`ambiguous` and `unresolved` become first-class outcomes** — retry after ambiguity happens **only** where the provider declares idempotency support, otherwise reconciliation and then an honest `unresolved`. Callbacks are signature-verified, timestamp-bounded, and replay-safe by unique `provider_event_id`; an uncorrelatable callback is quarantined rather than applied speculatively. **Acknowledgement is durable state and escalation steps dispatch only through a conditional claim that fails if acknowledged** — with the residual millisecond window documented rather than claimed to be zero. A **normative notification-class matrix** separates `safety-critical` and `security` (quiet hours overridden, cannot be disabled) from suppressible classes.
- **ADRs:** ADR-0009, ADR-0010 (both revised)
- **Capabilities:** CAP-024, CAP-027, CAP-031, CAP-040, CAP-041, CAP-043, CAP-056
- **Invariants:** **I-20 new**
- **Architecture test:** `validate.py` check 51 (**no document claims exactly-once external delivery**); [SPEC-07](../specs/SPEC-07-notification-delivery-contracts.md) §8 N-03..N-15
- **Remaining evidence:** Blocked on TDG-06 and EV-4 (provider sandboxes with fault injection)
- **Remaining risk:** PO-DEC-07, PO-DEC-15, PO-DEC-21 pending
- **Claimed status:** **REMEDIATED — AWAITING INDEPENDENT VERIFICATION**

### CAR-011 · High · The canonical typed-request decision is not represented by safe subtype lifecycles

- **Disposition:** REMEDIATED **(provisional — PO-DEC-03 pending)**
- **Changed:** [06](../06-data-architecture.md) §3.4 (**five subtype tables; `vacation_grants`; D-18..D-23**) · [09](../09-requests-vacation-opportunities-transfers.md) §§1–4 · [18](../18-capability-traceability.md) CAP-021..CAP-023 · **new** [SPEC-08](../specs/SPEC-08-request-subtype-lifecycles.md), [ADR-0016](../decisions/ADR-0016-request-aggregate-and-subtypes.md)
- **Architectural resolution:** One aggregate root with **five constrained subtype tables**; **D-18** exactly one subtype row, **D-19** required and prohibited fields by `CHECK`, **D-20** per-subtype status domains. **`applied` is deleted and split into `consumed_by_build`, `reflected_in_version`, and `unsatisfied`** — three different facts. `accepted_as_input` exists because a shift preference is never approved. Vacation gains **`request_id`**, the canonical link previously promised and absent, plus **D-21 conditional last-unit allocation** so two racing approvals resolve to exactly one winner, an **audited override path** preserving the observed advisory-not-blocking behaviour, prohibited negative balances, explicit weekend/holiday deadline rolling against a `group_holidays` calendar, and a **`reversed`** state that did not previously exist. Withdrawal after `reflected_in_version` raises a **revision request** rather than silently diverging. The solver reads a projection, never raw statuses.
- **ADRs:** [ADR-0016](../decisions/ADR-0016-request-aggregate-and-subtypes.md) **(new)**
- **Capabilities:** CAP-021, CAP-022, CAP-023
- **Architecture test:** `validate.py` check 50 (**no pending decision implemented as approved**); [SPEC-08](../specs/SPEC-08-request-subtype-lifecycles.md) §7 R-01..R-14
- **Remaining evidence:** R-01..R-14 unexecuted
- **Remaining risk:** **PO-DEC-03 pending — migration cost if decided otherwise is high, and [SPEC-08](../specs/SPEC-08-request-subtype-lifecycles.md) §8 states what changes**
- **Claimed status:** **REMEDIATED — AWAITING INDEPENDENT VERIFICATION**

### CAR-012 · High · Asynchronous reports lack a durable authorization and data snapshot

- **Disposition:** REMEDIATED
- **Changed:** [13](../13-reports-calendars-and-documents.md) §§1–4 · [05](../05-tenancy-entitlements-authorization.md) §4.6 · [06](../06-data-architecture.md) §3.7 (**`report_runs` manifest columns; `report_shares` created**) · **new** [SPEC-09](../specs/SPEC-09-report-snapshot-and-artifact-authorization.md), [ADR-0018](../decisions/ADR-0018-report-snapshot-semantics.md)
- **Architectural resolution:** **Every report class declares a snapshot mechanism** — explicit `version_id`, as-of transaction id, or a materialised input manifest with a hash — resolved at request and stored durably, plus the `policy_version` used. **Authorization is evaluated three times** — request, execution, download — because they answer three different questions. A revoked requester's job terminates `cancelled_unauthorized` and **writes no artifact**. Shares target memberships (never addresses), are not a bypass, and are re-evaluated at download so revocation is immediate. Calendar-feed entropy, rotation, revocation, `no-store`/`no-referrer` headers, per-fetch authorization, and stale-version disclosure specified. **A lost artifact is regenerable from its manifest**, which is what makes object-store divergence recoverable. **The signed-URL recall limit is stated honestly.**
- **ADRs:** [ADR-0018](../decisions/ADR-0018-report-snapshot-semantics.md) **(new)**, ADR-0014 (revised)
- **Capabilities:** CAP-020, CAP-044, CAP-045, CAP-046, CAP-047, CAP-048
- **Invariants:** **I-21 new**
- **Architecture test:** `validate.py` check 43; [SPEC-09](../specs/SPEC-09-report-snapshot-and-artifact-authorization.md) §8 F-01..F-14
- **Remaining evidence:** F-01..F-14 unexecuted; TDG-07, TDG-09, TDG-10 open
- **Remaining risk:** PO-DEC-22 pending
- **Claimed status:** **REMEDIATED — AWAITING INDEPENDENT VERIFICATION**

### CAR-013 · High · Deployment has no decided availability, recovery, residency, or coordinator model

- **Disposition:** REMEDIATED **(architecture decided; owner input explicitly recorded as open)**
- **Changed:** [03](../03-system-context-and-containers.md) §§2–4 · [17](../17-deployment-and-operations.md) §§1–9 · [19](../19-risks-and-decisions.md) · **new** [SPEC-10](../specs/SPEC-10-deployment-topology.md); ADR-0015 revised
- **Architectural resolution:** **Deferring the platform *architecture* is withdrawn.** Decided: managed container platform + managed PostgreSQL + managed S3-compatible storage + managed secret store; **six process classes, three images**; primary region with a synchronous standby in a second zone; **synchronous commit** accepted (write latency for zero committed-transaction loss on zone failover); read replicas **excluded** from turn-critical and authorization reads; **application-side fencing via database-resident coordinator leases that composes with provider-managed failover**; queue recovery and a post-failover reconciler; solver isolation; backup/PITR with object-store reconciliation; migration expand/contract with **honestly stated rollback limits**; a failure-mode matrix including **regional loss with an RTO in hours, stated plainly rather than implied to be better**. **OI-1..OI-7 record what remains owner input — RPO/RTO, residency, provider, region, support model, cost — and no residency requirement is invented.**
- **ADRs:** ADR-0001, ADR-0015 (revised), [ADR-0020](../decisions/ADR-0020-solver-runtime-packaging.md), [ADR-0021](../decisions/ADR-0021-raw-ingress-enclave.md)
- **Capabilities:** CAP-003, CAP-031, CAP-032, CAP-040, CAP-051, CAP-055, CAP-067
- **Architecture test:** `validate.py` check 52 (no infrastructure artifacts created); [SPEC-10](../specs/SPEC-10-deployment-topology.md) §11 failure matrix
- **Remaining evidence:** **OI-1..OI-7 open; SBX-035 blocked on EV-5 and EV-6**
- **Remaining risk:** **RISK-27 new** (managed-database split-brain defeats fencing); RISK-25 unchanged
- **Claimed status:** **REMEDIATED — AWAITING INDEPENDENT VERIFICATION**

### CAR-014 · High · Audit append-only controls do not protect against privileged alteration or policy conflict

- **Disposition:** REMEDIATED
- **Changed:** [06](../06-data-architecture.md) §3.7 (**chain columns; `audit_checkpoints` created; D-25**) and §5 (**retention**) · [14](../14-security-and-privacy.md) T-19 · [15](../15-audit-and-observability.md) §§1, 1.4 · **new** [SPEC-11](../specs/SPEC-11-audit-assurance-and-security-boundaries.md) §§1–4, [ADR-0019](../decisions/ADR-0019-audit-assurance-level.md)
- **Architectural resolution:** **The claim that history "cannot be quietly rewritten" is withdrawn.** Assurance levels are named: **A0** application-enforced (the old position), **A1** hash chain with signed checkpoints for `G-BETA`, **A2** external write-once replication in a separate trust domain for `G-PROD`, **A3 notarisation deliberately not claimed.** Privileged sessions are themselves chained; domain, outbox, and audit sequences are reconciled continuously so a missing entry is an observable defect. **"Retained indefinitely" is replaced** by 7 years default with tenant override, **legal hold**, and **anonymisation-rather-than-deletion** so the chain survives a personal-data request. **The tension between an immutable chain and unrestricted erasure is stated, and the jurisdictional question is named as an unmade legal determination.**
- **ADRs:** [ADR-0019](../decisions/ADR-0019-audit-assurance-level.md) **(new)**, ADR-0013 (revised)
- **Capabilities:** CAP-003, CAP-010, CAP-014, CAP-019, CAP-021–CAP-027, CAP-031–CAP-034, CAP-040, CAP-046, CAP-051, CAP-055
- **Invariants:** **D-25 new**
- **Architecture test:** `validate.py` check 43; [SPEC-11](../specs/SPEC-11-audit-assurance-and-security-boundaries.md) §10 X-01..X-07
- **Remaining evidence:** X-01..X-07 unexecuted; chain-write throughput unmeasured; external store gated on TDG-09
- **Remaining risk:** **RISK-28 new** (provider staff — A3 not claimed); **RISK-31 new** (chain throughput)
- **Claimed status:** **REMEDIATED — AWAITING INDEPENDENT VERIFICATION**

### CAR-015 · High · The security architecture omits several production threat and response boundaries

- **Disposition:** REMEDIATED
- **Changed:** [14](../14-security-and-privacy.md) §§1, 10 · [02](../02-technology-stack.md) · [16](../16-testing-and-environments.md) · [17](../17-deployment-and-operations.md) · **new** [SPEC-11](../specs/SPEC-11-audit-assurance-and-security-boundaries.md) §§5–8
- **Architectural resolution:** **T-24..T-38 added** — cross-site WebSocket hijacking (origin verification plus a per-connection token the browser will not auto-send cross-origin), provider callback forgery and replay, **OIDC issuer mix-up with per-organization `iss` pinning**, **account-linking takeover requiring proof of control**, MFA reset abuse, SSRF via connector/document/report inputs, upload decompression bombs, solver and report resource abuse, **privileged database and platform insiders**, support-tool exfiltration, **supply-chain compromise with SBOM, signing, provenance attestation, and an admission policy**, backup-key compromise in a separate trust domain, secret sprawl, and enclave compromise. **Key management is specified per class with separate trust domains.** **Incident response gains structure and an evidence-preservation procedure**, with the playbooks, rotation procedures, and **breach-notification legal determination named as still missing.**
- **ADRs:** ADR-0002, ADR-0008, ADR-0010–ADR-0015 (revised); [ADR-0019](../decisions/ADR-0019-audit-assurance-level.md)
- **Capabilities:** CAP-003, CAP-008, CAP-009, CAP-010, CAP-032, CAP-040, CAP-041, CAP-046, CAP-048, CAP-051, CAP-055, CAP-062, CAP-068
- **Architecture test:** [SPEC-11](../specs/SPEC-11-audit-assurance-and-security-boundaries.md) §10 X-08..X-18
- **Remaining evidence:** No penetration test; **no tabletop exercise**; playbooks unwritten
- **Remaining risk:** RISK-15 partially addressed and still open in substance
- **Claimed status:** **REMEDIATED — AWAITING INDEPENDENT VERIFICATION**

### CAR-016 · Medium · PO-DEC-10 is an unapproved commercial/domain rule that the architecture silently assumes

- **Disposition:** REMEDIATED **(by explicit product-owner decision)**
- **Changed:** [report 24](../../../schedulepoint-research/reports/24-production-completeness-gates.md) §3 (**row restored, register-repair note added**) · [19](../19-risks-and-decisions.md) §2.2a · [architecture-manifest.json](../architecture-manifest.json) · ADR-0005 revised
- **Architectural resolution:** **`PO-DEC-10` is restored to the canonical register with its original identifier and a status of `pending`.** No ID renumbered or reused; no historical record rewritten. The working default — **locum billing is external commercial policy consuming a versioned read-only membership/FTE projection** — is now labelled as a pending default rather than adopted. **No billing capability exists; CAP-025 staff-over-locum priority is a scheduling rule and CAP-011 stipends are compensation configuration, and neither may be treated as billing authority.** If billing becomes product scope, that is a **report-19 baseline change**, not an architecture change. **Pending decisions: 18 → 19.**
- **ADRs:** ADR-0005 (revised)
- **Capabilities:** CAP-005, CAP-013, CAP-025, CAP-057 (projection only)
- **Architecture test:** `validate.py` check 42 — **every referenced decision ID must be present in the canonical register; ID reuse fails**
- **Remaining evidence:** none required for the register repair
- **Remaining risk:** **the decision itself remains unratified**
- **Claimed status:** **REMEDIATED — AWAITING INDEPENDENT VERIFICATION**

### CAR-017 · Medium · Module ownership rules conflict with required cross-module atomic transactions

- **Disposition:** REMEDIATED
- **Changed:** [03](../03-system-context-and-containers.md) · [04](../04-domain-boundaries.md) §§1–3 · [06](../06-data-architecture.md) · [01](../01-architecture-overview.md) §3 · **new** [SPEC-12](../specs/SPEC-12-cross-module-unit-of-work.md), [ADR-0017](../decisions/ADR-0017-cross-module-unit-of-work.md)
- **Architectural resolution:** **Three write classes** — W1 own-aggregate, **W2 in-transaction domain port** (the owning module enforces its invariants on the caller's unit of work, preserving ownership without a second transaction), W3 post-commit outbox. **A normative owner table for all thirteen state-changing workflows.** W2 port cycles prohibited and CI-checked; provider calls inside transactions blocked by lint and runtime guard. **Module count rationalised 25 → 19** where two modules shared every invariant and every transaction — **M-08 Ingestion Privacy and M-24 Audit are never merged.** Sequence overlays for the three highest-risk workflows.
- > **AMENDMENT NOTE — 2026-08-01 (V-05): the module-consolidation claim above is WITHDRAWN.** The internal verification found that **the merge was announced and never performed** — [04](../04-domain-boundaries.md)'s header claimed the rationalisation while the next line of the same file said 25, and the file defines exactly 25 `#### M-nn` sections. **The module count stands at 25.** The claim is withdrawn from [04](../04-domain-boundaries.md)'s header rather than the merge being executed under time pressure: a tidier count is not worth a hurried consolidation of modules that would then have to be un-merged from implementation experience. Consolidation may still happen later, on evidence.
  > **The rest of CAR-017 is unaffected.** The **W1/W2/W3 write classes, the normative owner table, the port-cycle prohibition, and the transaction-boundary lint are the substance of this remediation**, and none of them depended on the module count. The sentence above is left in place as the historical claim; this note is its correction. [Rationale](internal-verification-corrections.md) §0 V-05.
- **ADRs:** [ADR-0017](../decisions/ADR-0017-cross-module-unit-of-work.md) **(new)**, ADR-0001, ADR-0009 (revised)
- **Capabilities:** CAP-014, CAP-019, CAP-023, CAP-026, CAP-027, CAP-031, CAP-040, CAP-046, CAP-055
- **Invariants:** **I-22 new**
- **Architecture test:** [SPEC-12](../specs/SPEC-12-cross-module-unit-of-work.md) §6 U-01..U-07
- **Remaining evidence:** U-01..U-07 unexecuted; no transaction trace captured
- **Remaining risk:** RISK-06 unchanged — boundary erosion must be policed mechanically
- **Claimed status:** **REMEDIATED — AWAITING INDEPENDENT VERIFICATION**

### CAR-018 · Medium · Opportunity and transfer approval do not bind eligibility to assignment versions atomically

- **Disposition:** REMEDIATED
- **Changed:** [06](../06-data-architecture.md) §3.4 (**`opportunities` version binding; D-24**) · [09](../09-requests-vacation-opportunities-transfers.md) §§3–5 · **new** [SPEC-13](../specs/SPEC-13-marketplace-version-binding.md)
- **Architectural resolution:** The claim compare-and-set now binds **`assignment_identity_id`, `source_version_id`, and `source_snapshot_id`** as well as status, so a claim racing a republication fails `STALE_ASSIGNMENT` instead of transferring a snapshot that no longer exists. Eligibility is re-checked **at claim time inside the transaction**. **Deterministic lock order** (ascending `assignment_identity_id`, then a fixed cross-entity order), **bounded deadlock retry with jitter reusing the same `command_id`** so a retry cannot duplicate notifications, and **D-24** with a reconciler that detects orphaned accepted offers. Transfers produce a **new schedule version** and never edit a published one.
- **ADRs:** ADR-0007, ADR-0009 (revised)
- **Capabilities:** CAP-024, CAP-025, CAP-026, CAP-027, CAP-058, CAP-059
- **Architecture test:** [SPEC-13](../specs/SPEC-13-marketplace-version-binding.md) §6 M-01..M-12
- **Remaining evidence:** M-01..M-12 unexecuted
- **Remaining risk:** PO-DEC-12, PO-DEC-15, PO-DEC-16, PO-DEC-17 pending
- **Claimed status:** **REMEDIATED — AWAITING INDEPENDENT VERIFICATION**

### CAR-019 · Medium · The "PII never sent to third parties" rule contradicts required providers

- **Disposition:** REMEDIATED
- **Changed:** [06](../06-data-architecture.md) §1 sensitivity table · [11](../11-notifications-and-communications.md) §§3–6 · [14](../14-security-and-privacy.md) §1 · [drafts/AGENTS.md](../drafts/AGENTS.md) · **new** [SPEC-07](../specs/SPEC-07-notification-delivery-contracts.md) §7
- **Architectural resolution:** **Two rules that were conflated are separated.** **CAP-068 / T-23 remains absolute and unchanged** — no email, email-derived hash, or equivalent identifier may reach *any* third-party host **from the browser or client telemetry**, enforced by a build-breaking CI guard. **Server-side approved subprocessors are permitted** under a processor register recording legal entity, purpose, data elements, lawful basis, contract, region, retention, deletion, sub-processors, and exit plan, with a **declared payload schema per processor and an assertion that no extra field is transmitted.** Two distinct tests — client host allowlist and server egress allowlist — make an approved processor distinguishable from exfiltration.
- **ADRs:** ADR-0010, ADR-0014, ADR-0015 (revised)
- **Capabilities:** CAP-040, CAP-041, CAP-046, CAP-048, CAP-051, CAP-068
- **Architecture test:** [SPEC-07](../specs/SPEC-07-notification-delivery-contracts.md) §7.4
- **Remaining evidence:** **The processor register does not exist — no provider is selected (TDG-06, TDG-09, TDG-12); no data-processing agreement is executed; residency depends on OI-3**
- **Remaining risk:** PO-DEC-07, PO-DEC-21, PO-DEC-22 pending
- **Claimed status:** **REMEDIATED — AWAITING INDEPENDENT VERIFICATION**

### CAR-020 · Medium · Capability traceability references nonexistent structures and understates architecture blockers

- **Disposition:** REMEDIATED
- **Changed:** [18](../18-capability-traceability.md) (fourteen structure references; §3 rewritten) · [06](../06-data-architecture.md) (missing tables created) · [architecture-manifest.json](../architecture-manifest.json) · [validate.py](../validate.py)
- **Architectural resolution:** **Every mismatch resolved explicitly, never by renaming it away.** *Created:* `organization_settings`, `user_identities`, `membership_work_profiles`, `membership_weekday_fte`, `notification_intents`, `broadcast_recipients`. *Renamed to the trace's name:* `proxies` → **`proxy_grants`**. *Trace corrected to the real name:* `assignment_audit` → snapshots joined by identity plus `audit_events`; `request_decisions` → `approvals`; `vacation_entitlements`/`vacation_capacity` → `vacation_grants` kinds; `push_tokens` → `push_registrations`; `import_quarantine` → `quarantined_records`. *Withdrawn with the Site entity:* `group_sites`, `shift_type_sites` (CAR-021). *Column:* CAP-017's `is_fixed` and the schema's `is_locked` both retired for **`is_pinned`**. **The architecture-blocker set is corrected from five to the authoritative seven, adding CAP-003 and CAP-032**, which this document's own prose already called structural.
- **ADRs:** all, through their capability mappings
- **Capabilities:** CAP-001, CAP-003, CAP-004, CAP-005, CAP-013, CAP-017, CAP-019, CAP-021, CAP-022, CAP-025, CAP-032, CAP-034, CAP-040, CAP-041, CAP-043, CAP-062
- **Architecture test:** `validate.py` **checks 40–43** — every referenced data structure, capability, ADR, decision, invariant, and gate ID must resolve, and **check 41 asserts all seven blockers are present**
- **Remaining evidence:** none — this is a documentation-consistency finding, now machine-checked
- **Remaining risk:** none
- **Claimed status:** **REMEDIATED — AWAITING INDEPENDENT VERIFICATION**

### CAR-021 · Medium · The site model implements the unapproved alternative rather than the pending default

- **Disposition:** REMEDIATED **(by explicit product-owner decision)**
- **Changed:** [05](../05-tenancy-entitlements-authorization.md) §2.1 and §9 · [06](../06-data-architecture.md) §§3.1–3.2 and **new §3.2a** · [18](../18-capability-traceability.md) CAP-004, CAP-011
- **Architectural resolution:** **Product-owner direction: keep PO-DEC-01 pending and follow its working default.** The `sites` table and `locations.site_id` are **withdrawn**; location carries a `site_label` attribute. **§3.2a defines the migration boundary in both directions** — attribute → entity and entity → attribute — to be modelled with fixtures before either is built. **No site administration surface, site-scoped API, or site-specific workflow is designed while the decision is pending**, because building one would select the branch by stealth. The trace's third model (`group_sites`, `shift_type_sites`) is removed rather than materialised.
- **ADRs:** ADR-0003 (revised)
- **Capabilities:** CAP-004, CAP-011, CAP-030
- **Architecture test:** `validate.py` check 50 — **a pending decision's non-default branch must not create tables, APIs, or workflows**
- **Remaining evidence:** both migration directions unmodelled in fixtures
- **Remaining risk:** **PO-DEC-01 pending**
- **Claimed status:** **REMEDIATED — AWAITING INDEPENDENT VERIFICATION**

### CAR-022 · Medium · Accessibility is a policy list, not a complete acceptance architecture

- **Disposition:** REMEDIATED
- **Changed:** [10](../10-picklist-and-realtime.md) §10 · [16](../16-testing-and-environments.md) §§3, 5, 7 · [18](../18-capability-traceability.md) CAP-050, CAP-066 · **new** [SPEC-14](../specs/SPEC-14-accessibility-acceptance-matrix.md)
- **Architectural resolution:** A **component × property acceptance matrix** with each cell marked automatable or **manual-evidence-required**, covering semantic schedule grids and their list alternative, colour independence, contrast and forced colors, touch targets, reduced motion, validation summary and focus placement, and **eight supported assistive-technology and browser combinations — none claimed without retained manual evidence.** The previously undefined **real-time interruption policy** is specified: **AX-1** focus is stolen only when the turn becomes yours; **AX-2** focus never lands on `<body>` (a test failure); **AX-3** bursts are **coalesced, not queued**, because a queue reads stale events after the turn has moved on; **AX-4** announcements come from **reconciled state ordered by `picklist_events.sequence`**, so reordered or duplicated frames never reach the live region; **AX-5** a timed turn must be completable via assistive technology, **and if it is not, the allowance changes rather than the requirement.**
- **ADRs:** ADR-0002, ADR-0008 (revised)
- **Capabilities:** CAP-020, CAP-021, CAP-031, CAP-032, CAP-045, CAP-046, CAP-050, CAP-066, CAP-067
- **Architecture test:** [SPEC-14](../specs/SPEC-14-accessibility-acceptance-matrix.md) §5 AC-01..AC-13
- **Remaining evidence:** **No manual evidence has been collected; EV-8 (assistive-technology lab) is a blocking dependency**
- **Remaining risk:** RISK-20 unchanged
- **Claimed status:** **REMEDIATED — AWAITING INDEPENDENT VERIFICATION**

### CAR-023 · Medium · Draft agent instructions omit safeguards and contain contradictory invariants

- **Disposition:** REMEDIATED
- **Changed:** [drafts/CLAUDE.md](../drafts/CLAUDE.md) (**new §6 non-bypass rules**) · [drafts/AGENTS.md](../drafts/AGENTS.md) (**hard-stop table extended; outbound-host rule narrowed; ID discipline**) · [01](../01-architecture-overview.md) §4 · [10](../10-picklist-and-realtime.md) §2 · [18](../18-capability-traceability.md) CAP-050
- **Architectural resolution:** **The `I-05` collision is resolved** — `I-05` keeps its original meaning (mandatory automated scheduling) and the Add/New/Create save contract becomes **`I-13`**, corrected in every location, with a validator check enforcing uniqueness. **Thirteen explicit non-bypass rules added**, covering the unit of work, `SET LOCAL`, RLS, entitlements, capabilities, published-version immutability, the audit chain, manual scheduling as production, free text on protected paths, delivery-material logging, accessibility tests, architecture tests, capability scope, and pending decisions. **The outbound-host prohibition is narrowed correctly**: absolute for the browser and client telemetry (CAP-068), governed-by-register for server-side subprocessors — the previous blanket rule contradicted every required provider. **ID discipline extended** with the PO-DEC-10 lesson: a decision ID that disappears from a register is a defect, not a decision.
- **ADRs:** ADR-0002, ADR-0003, ADR-0004, ADR-0007, ADR-0011, ADR-0013 (revised)
- **Capabilities:** CAP-003, CAP-006, CAP-014, CAP-015, CAP-019, CAP-050, CAP-051, CAP-057, CAP-062, CAP-066, CAP-068
- **Invariants:** **I-13 new (renumbered)**
- **Architecture test:** `validate.py` **check 41** (invariant IDs unique and single-meaning) and check 39 (**drafts still not installed at repository root**)
- **Remaining evidence:** the drafts have not been adversarially linted against the safeguard checklist
- **Remaining risk:** **the drafts remain drafts and must not govern implementation yet**
- **Claimed status:** **REMEDIATED — AWAITING INDEPENDENT VERIFICATION**

### CAR-024 · Medium · Major stack rows are placeholders rather than reviewable technology decisions

- **Disposition:** REMEDIATED
- **Changed:** [02](../02-technology-stack.md) §§1–3 (**`VERIFY` → `GATED (TDG-nn)`**) · [references](../references/official-technical-sources.md) · **new** [SPEC-15](../specs/SPEC-15-technology-decision-gates.md)
- **Architectural resolution:** **Fifteen numbered gates (TDG-01..TDG-15)**, each with what it blocks, what it must resolve, and a required **bounded spike (SP-1..SP-10)**. Standing rule: **no gated row may be described as decided**, and a gate closed without its spike is reopened. Several gates now carry **correctness** requirements rather than preferences — **TDG-02** the data layer must reliably issue `SET LOCAL` inside a caller-controlled transaction and express exclusion constraints, partial unique indexes, and triggers; **TDG-03** statement-level pooling is prohibited; **TDG-07** the report renderer must not execute untrusted HTML or fetch remote resources; **TDG-09** object-lock is required because the audit A2 design depends on it; **TDG-14** a component library that fights accessible defaults is disqualified regardless of other merit. **The document now states plainly which rows are decided and which are gated.**
- **ADRs:** ADR-0002, ADR-0010, ADR-0014, ADR-0015 (revised)
- **Capabilities:** CAP-008, CAP-015, CAP-032, CAP-040, CAP-041, CAP-046–CAP-048, CAP-051, CAP-067
- **Architecture test:** `validate.py` check 48 (solver/runtime compatibility)
- **Remaining evidence:** **No TDG is closed and no spike is run**
- **Remaining risk:** RISK-24 and the technology-selection risk remain until the gates close
- **Claimed status:** **REMEDIATED — AWAITING INDEPENDENT VERIFICATION**

### CAR-025 · Medium · The environment/test plan cannot yet produce several required evidence artifacts

- **Disposition:** **PARTIALLY REMEDIATED — design remediated; evidence dependencies OPEN**
- **Changed:** [16](../16-testing-and-environments.md) §§1–7 · [17](../17-deployment-and-operations.md) · [19](../19-risks-and-decisions.md) · **new** [SPEC-16](../specs/SPEC-16-sbx-evidence-contracts.md)
- **Architectural resolution:** Every SBX test carries a **nine-field evidence contract**. **Subjective criteria are replaced by oracles:** "usable explanation" becomes the `B-infeasible-*` fixtures whose cause is known **by construction**; "quality threshold" becomes `hard_violations = 0` absolute plus **bands that are explicitly undefined until the corpus runs**; "zero patient content" becomes the 16-surface canary sweep; "correct concurrency" becomes exactly one accepted outcome over ≥50 trials. **Deterministic orchestration** replaces wall-clock racing: N clients on one process with a controllable virtual clock and barrier release, with the clock-injection point **compiled out of production images**. **Earliest execution points are reordered** so tenant-isolation, publication, and picklist harnesses run at the **schema/prototype stage** rather than behind late gates. A **meta-test** provisions every fixture from a clean environment and reports **`EVIDENCE_BLOCKED`** rather than passing or silently skipping.
- **ADRs:** ADR-0002, ADR-0006, ADR-0008, ADR-0011, ADR-0015
- **Capabilities:** CAP-003, CAP-015, CAP-016, CAP-031, CAP-032, CAP-040, CAP-041, CAP-046, CAP-051, CAP-055, CAP-062, CAP-066, CAP-067
- **Architecture test:** the meta-test itself
- **Remaining evidence:** **EV-1..EV-8 are open and each keeps its gate explicitly blocked** — vendor specifications, restorable-backup access, error-reporting vendor API, provider sandboxes, RPO/RTO, a provisioned platform, benchmark bands, and an assistive-technology lab
- **Remaining risk:** RISK-22 — **the eight dependencies are owner and procurement matters, not design matters**
- **Claimed status:** **REMEDIATED (design) — AWAITING INDEPENDENT VERIFICATION; EVIDENCE DEPENDENCIES OPEN**

### CAR-026 · Low · Report 18 states 36 tests although it defines 39

- **Disposition:** **REMEDIATED (2026-08-01, under explicit authorization — was OPEN)**
- **Changed:** [report 18](../../../schedulepoint-research/reports/18-targeted-sandbox-test-plan.md) closing prose — the single hand-written figure, replaced by a heading-derived count of **39** with a dated correction note
- **Architectural resolution:** **History:** at Phase 14 this was deliberately left OPEN because research-source modification was not authorized, and the review directed the fix be a separate research-maintenance task. **On 2026-08-01 the product owner delegated that authorization explicitly** (expanded decision authority mandate); the correction was then applied exactly as the review prescribed — a derived count replacing the hand-written figure, in a separate maintenance change, with the correction note dated in-place. `validate.py` check 53 continues to re-derive the count on every run, so any future drift is detected.
- **ADRs:** none
- **Capabilities:** all, through SBX evidence mappings
- **Architecture test:** **`validate.py` check 53 parses unique SBX headings and compares them with every declared count**, so the discrepancy is now *detected and reported* even though the source is untouched
- **Remaining evidence:** independent enumeration confirms **39 unique SBX IDs**, matching the manifest **and, since 2026-08-01, the corrected closing prose**
- **Why open · Owner · Blocking condition · Affected · Latest resolution point · Evidence required (historical, as recorded at Phase 14):** **Why:** modifying a research source was not authorized for that task. **Owner:** product owner. **Blocking condition:** explicit authorization to modify `schedulepoint-research/reports/18-targeted-sandbox-test-plan.md` — **granted 2026-08-01** ("Expanded decision authority" mandate). **Affected:** no capability; gates `G-BETA`, `G-CONN`, `G-PROD` only through reader confusion. **Latest acceptable resolution point:** before the first SBX test is executed — **met; no SBX test has run**. **Evidence required:** a derived count generated from the headings, replacing the hand-written prose figure — **delivered**.
- **Remaining risk:** none — the count is corrected and check 53 re-derives it on every validation run
- **Claimed status:** **REMEDIATED (2026-08-01, under explicit authorization)**

### CAR-027 · Low · Account email immutability is stronger than the required non-self-editability outcome

- **Disposition:** REMEDIATED
- **Changed:** [06](../06-data-architecture.md) §3.1 `users` · [18](../18-capability-traceability.md) CAP-005, CAP-007
- **Architectural resolution:** `email` becomes **`login_email`**, specified as **not self-editable but changeable by an administrator holding `identity.change_login_email` or by a linked identity provider** — audited, with **all sessions invalidated** and pending invitations reconciled. Absolute immutability blocked hospital domain changes, mistyped-invitation correction, and SSO linking, and forced a second account that would lose membership and audit continuity. Account identity remains the immutable `users.id`; `user_identities` carries provider linkage with **proof-of-control required for linking (T-27)**.
- **ADRs:** ADR-0004 (indirect)
- **Capabilities:** CAP-005, CAP-007, CAP-008, CAP-009
- **Architecture test:** `validate.py` check 40 (structures resolve); the change lifecycle is covered by [SPEC-11](../specs/SPEC-11-audit-assurance-and-security-boundaries.md) X-12 alongside MFA reset
- **Remaining evidence:** uniqueness race, active-session, invitation-conflict, and notification-routing cases unexecuted
- **Remaining risk:** PO-DEC-09 pending
- **Claimed status:** **REMEDIATED — AWAITING INDEPENDENT VERIFICATION**

---

## 4. Findings that remain open

> **Historical record (as written at Phase 14).** Both rows below have since been resolved or provisionally carried: CAR-026 was remediated 2026-08-01 under explicit authorization; CAR-025's evidence dependencies carry provisional resolutions in [docs/fable/21-decision-resolution.md](../../fable/21-decision-resolution.md) §5 and remain tracked per-gate. The table is preserved unmodified for history.

| ID | Severity | Why open | Owner | Blocking condition | Affected | Latest resolution point | Evidence required |
|---|---|---|---|---|---|---|---|
| **CAR-026** | Low | **Research-source modification was not authorized**, and the review explicitly directed that it be done separately | Product owner | Explicit authorization to edit report 18 | No capability; reader confusion only | Before the first SBX execution | A count derived from headings, replacing the prose figure |
| **CAR-025** *(evidence half)* | Medium | Eight dependencies are procurement and owner matters, not design matters | Product owner + platform | EV-1..EV-8 | CAP-015, CAP-031, CAP-041, CAP-051, CAP-055, CAP-062, CAP-066 | Before the affected gate is claimed | Vendor specs, backup access, vendor APIs, provider sandboxes, RPO/RTO, platform, bands, AT lab |

---

## 5. What this remediation does not establish

| Claim | Status |
|---|---|
| The findings are fixed | **No — they are *addressed in design*. Nothing is implemented and nothing is tested** |
| The architecture is approvable | **Not our call.** A separate independent reviewer decides |
| Any gate is met | **No gate is passed.** `G-ARCH`, `G-BETA`, `G-PROD`, `G-CONN` all remain unpassed |
| Any ADR is accepted | **None.** All 23 remain `PROPOSED` |
| Any product decision is approved | **None.** 19 pending; the three answered this session were answered **"keep pending"** |
| Compliance | **No claim.** [14](../14-security-and-privacy.md) §11 stands unchanged |
| The source product behaves this way | **Unresolved source facts remain unresolved.** C-02, C-04, C-06 `UNRESOLVED`; C-09 unproven in both directions |

**The architecture remains `PROPOSED` and unapproved. A new independent review is required.**
