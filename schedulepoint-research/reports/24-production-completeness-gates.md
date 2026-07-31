# 24 — Production Completeness Gates

**Created 2026-07-31.** Companion to [19-schedulepoint-production-capability-baseline.md](19-schedulepoint-production-capability-baseline.md).

**Product name:** `SchedulePoint` — **PO-DEC-00 APPROVED**.

> **No gate is marked passed by this document.** This is a definition of **evidence requirements**. Gates are passed by producing the evidence, not by writing it down.

---

## 1. Gate model

| Gate | Meaning | Count |
|---|---|---:|
| `G-ARCH` | Satisfied before architecture is finalised | 5 capabilities |
| `G-BETA` | Satisfied before controlled beta | 15 capabilities |
| `G-PROD` | Satisfied before production release | 34 capabilities |
| `G-CONN` | Satisfied before **any** hospital connector is certified | 4 capabilities |

Per-capability assignment: [22-functional-traceability-matrix.md](22-functional-traceability-matrix.md) §3.

**Milestones and gates are different things.** A milestone says *when* something is built; a gate says *what evidence is required before a release class*. An internal alpha may omit almost everything; **production may omit nothing in `G-PROD`**.

---

## 2. Minimum production-readiness bar

All fourteen must hold. **None may be waived by asserting a capability is post-MVP.**

| # | Requirement | Evidence |
|---|---|---|
| 1 | **100% of production-required capabilities mapped to implementation and tests** | [22](22-functional-traceability-matrix.md) shows zero unmapped rows |
| 2 | **No unresolved Critical or High-severity functional gap** | Gap register (GAP-01..19) closed or explicitly accepted with rationale |
| 3 | **No unresolved production-blocking contradiction** | C-08 resolved; C-02/C-04 approved and implemented; C-09 gated at `G-CONN` |
| 4 | **Zero unauthorized hard-constraint violations in solver tests** | SBX-015, SBX-016, SBX-031 across all six datasets |
| 5 | **Explainable infeasible-build results** | SBX-015 — every `infeasible` names the conflicting hard constraints in domain terms |
| 6 | **Successful progressive-build testing** | SBX-017 — protected assignments preserved exactly across stages |
| 7 | **Successful multi-session picklist concurrency testing** | SBX-022, SBX-023 — each race repeated ≥50× |
| 8 | **Qualification enforcement** | SBX-019 — blocked on **every** assignment path |
| 9 | **Notification retry and deduplication evidence** | SBX-030a — full delivery ledger, no duplicates, no silent failures |
| 10 | **De-identification validation** | SBX-029 — zero patient-level content persists, including logs |
| 11 | **Tenant-isolation testing** | SBX-004 — 100% denial, server-enforced |
| 12 | **Accessibility conformance** | SBX-032, 033, 034 — SP-HR-3..6 |
| 13 | **Audit-history verification** | SBX-018, SBX-035 — audit survives restore |
| 14 | **Product-owner approval of the final decision register** | §6 signed off |

---

## 3. Gate definitions

Each states its **evidence requirement**, not a status.

### 3.1 Functional capability coverage
**Requires:** every `REQUIRED FOR PRODUCTION` capability implemented, tested, and traceable to a QA case or sandbox test. **Zero capabilities carrying `excluded`, `abandoned`, `optional because difficult`, `indefinitely deferred`, or `post-MVP with no production gate`.**
**Evidence:** [22](22-functional-traceability-matrix.md) regenerated at release, showing full coverage. · **Gate:** `G-PROD`

### 3.2 Automated scheduling
**Requires:** the engine generates schedules meeting §2.4; `infeasible` and `failed` are distinct and both explained; every result carries the full explainability set ([21](21-automated-scheduling-production-requirements.md) §6). **Manual scheduling is not the production mechanism.**
**Evidence:** SBX-015, SBX-031. · **Gate:** `G-PROD` · **Capabilities:** CAP-015, 016, 017, 018

### 3.3 Schedule quality
**Requires:** every §7 quality dimension in [21](21-automated-scheduling-production-requirements.md) measured and within its configured band; reproducibility absolute; **speed never reported without a paired quality measure**.
**Evidence:** SBX-031 across six datasets, ≥5 runs each. · **Gate:** `G-PROD` · **Capabilities:** CAP-015, 045

### 3.4 Conflict detection and build-quality verification
**Requires:** **100% of injected hard violations detected**, each with severity, explanation, and remediation; sign-off blocked while unresolved hard violations remain.
**Evidence:** SBX-016 against a fixture with deliberately injected defects. · **Gate:** `G-PROD` · **Capability:** CAP-059

### 3.5 Qualifications and eligibility
**Requires:** enforcement on **every** assignment path — engine, manual edit, opportunity claim, swap, picklist pick; expiry evaluated against the **assignment date**; overrides reasoned and audited.
**Evidence:** SBX-019 including a future assignment against a credential expiring before it. · **Gate:** `G-PROD` · **Capability:** CAP-058

### 3.6 Tenant isolation
**Requires:** 100% cross-tenant denial across every resource type via UI and API; server- and database-enforced; "not found" indistinguishable from "not permitted".
**Evidence:** SBX-004. · **Gate:** `G-ARCH` (design) and `G-PROD` (verification) · **Capabilities:** CAP-001, 002, 003

### 3.7 Authorization
**Requires:** the four-layer model implemented; **no permission flag without a tested capability difference**; every route carrying an explicit policy or failing the build.
**Evidence:** SBX-001, SBX-002. · **Gate:** `G-ARCH`, `G-PROD` · **Capabilities:** CAP-006, 057

### 3.8 Requests and vacation
**Requires:** every request type has a discoverable creation surface; deadlines enforced server-side; withdrawal and denial distinct; both vacation modes work; **commit is idempotent and reversible**.
**Evidence:** SBX-010, 011, 012, 013. · **Gate:** `G-BETA`, `G-PROD` · **Capabilities:** CAP-021, 022, 023

### 3.9 Opportunities and swaps
**Requires:** email fan-out with explicit recipient rules and opt-outs; staff-over-locum preference; **atomic claim — exactly one winner over ≥50 trials**; swap atomicity (both legs or neither).
**Evidence:** SBX-013b, 014b, 014c. · **Gate:** `G-BETA` · **Capabilities:** CAP-024, 025, 026

### 3.10 Schedule publication and history
**Requires:** publication atomic and prerequisite-checked at commit; **prior versions retained, never deleted**; revert publishes forward; concurrent publication serialised.
**Evidence:** SBX-018. · **Gate:** `G-PROD` · **Capability:** CAP-014

### 3.11 Notification delivery
**Requires:** every channel (email, SMS, voice, **push**) delivering; dispatch only after commit; bounded retry; dead-lettering; explicit `no-destination`; **deduplication**; opt-outs honoured; full ledger.
**Evidence:** SBX-030a, 030b to controlled endpoints only. · **Gate:** `G-PROD` · **Capabilities:** CAP-040, 041, 056

### 3.12 Reporting
**Requires:** all report types generate correct, tenant-scoped output; sharing reaches only selected recipients; fairness statistics assert against known-correct fixtures.
**Evidence:** SBX-031a. · **Gate:** `G-PROD` · **Capabilities:** CAP-045, 046

### 3.13 Calendar feeds
**Requires:** high-entropy hash-stored tokens; rotation invalidates immediately; revocation immediate; **no PII in the URL**; scoped to one membership.
**Evidence:** SBX-031c. · **Gate:** `G-BETA` · **Capability:** CAP-047

### 3.14 Documents
**Requires:** uploader and version recorded; cross-tenant storage-URL access denied; purge invalidates URLs; role-based category visibility; **search** (which the source lacks).
**Evidence:** SBX-031b. · **Gate:** `G-BETA` · **Capability:** CAP-048

### 3.15 Picklist preparation
**Requires:** participants derived from the published schedule; work items manageable; **no control persists before an explicit Save**; readiness validated.
**Evidence:** SBX-020. · **Gate:** `G-PROD` · **Capability:** CAP-030

### 3.16 Picklist execution
**Requires:** the full documented flow reproduced — list-start email, current picker, timer, remaining-choice review, confirmation email, automatic advancement, completion email; server owns turn state and clock.
**Evidence:** SBX-021, 024, 027. · **Gate:** `G-PROD` · **Capabilities:** CAP-031, 033, 034

### 3.17 Picklist concurrency
**Requires:** simultaneous selection resolves to exactly one pick over ≥50 trials; reconnection loses no turn; stale clients converge; staleness visible.
**Evidence:** SBX-022, 023. · **Gate:** `G-ARCH` (transport decision), `G-PROD` (verification) · **Capability:** CAP-032

### 3.18 Picklist modes
**Requires:** paper, manual-entry, and integrated modes each coherent; imported and manual work items coexist; mode switching never destroys an in-flight list.
**Evidence:** SBX-020. · **Gate:** `G-PROD` · **Capability:** CAP-060

### 3.19 Hospital integration
**Requires:** idempotent, atomic, reconciled imports; normalisation applied; failures visible and replayable; **per-connector certification**.
**Evidence:** SBX-028 per connector. · **Gate:** `G-CONN` · **Capabilities:** CAP-055, 061, 063, 064, 065

### 3.20 De-identification
**Requires:** **zero patient-level content persists anywhere — including logs and audit payloads** — when payloads carry identifying fields in expected **and unexpected** positions; positive allow-list enforced; privacy-office sign-off per customer.
**Evidence:** SBX-029. · **Gate:** `G-CONN` — **blocking; no connector ships without it** · **Capability:** CAP-062

### 3.21 Auditability
**Requires:** every mandatory-audit entity produces an append-only, queryable record with actor, on-behalf-of, before/after, mechanism, correlation id; **audit survives a restore**.
**Evidence:** SBX-018, 035. · **Gate:** `G-PROD` · **Capability:** CAP-027

### 3.22 Privacy
**Requires:** **SP-HR-1** — no email address, email-derived hash, or equivalent identifier reaches any third party; CI guard on new third-party hosts; field-level PII minimisation by role; no PII in URLs or logs.
**Evidence:** automated CI network assertions (QA-SEC-001..003) plus SBX-003. · **Gate:** `G-PROD` · **Capabilities:** CAP-068, 042

### 3.23 Security
**Requires:** deny-by-default authorization sweep over the generated route table; anti-forgery on every mutation; cookie protections; stored-XSS resistance on all rich content; errors leaking nothing.
**Evidence:** QA-SEC-007, 008, 011, 012 automated. · **Gate:** `G-PROD`

### 3.24 Accessibility
**Requires:** **SP-HR-3** visible focus · **SP-HR-4** accessible names · **SP-HR-5** keyboard-operable critical workflows **including a timed picklist turn** · **SP-HR-6** programmatic status. Source strengths preserved (modal focus trap, Escape-to-close).
**Evidence:** SBX-032, 033. · **Gate:** `G-PROD` · **Capability:** CAP-066

### 3.25 Responsive behaviour
**Requires:** no page-level horizontal scroll at any supported width; wide tables scroll internally with a visible affordance; no loss of content or function at 400% zoom.
**Evidence:** SBX-034. · **Gate:** `G-BETA` · **Capability:** CAP-066

### 3.26 Performance
**Requires:** **SP-HR-2** — one action, one request, enforced by a CI budget; solver targets met with paired quality measures; schedule grid usable at ≥200 staff × 8 weeks; real-time connection count scaling with users needing live updates, not page views.
**Evidence:** SBX-030, 031. · **Gate:** `G-BETA` (budgets), `G-PROD` (solver) · **Capability:** CAP-067

### 3.27 Reliability
**Requires:** no silent third-party failure; every embedded dependency fails visibly with a usable fallback and synthetic monitoring.
**Evidence:** synthetic monitors + SBX-030a. · **Gate:** `G-PROD` · **Capability:** CAP-051

### 3.28 Backup and recovery
**Requires:** documented RTO/RPO met in rehearsal; forward migration and rollback both exercised; **audit history intact through restore**.
**Evidence:** SBX-035. · **Gate:** `G-PROD` · **Capability:** CAP-051

### 3.29 Observability
**Requires:** requests-per-interaction tracked and alerting; notification delivery visible; import quarantine alerting; build diagnostics retained.
**Evidence:** SBX-030, 030a, 028. · **Gate:** `G-PROD` · **Capability:** CAP-051

### 3.30 External connector certification
**Requires:** per connector — external specification obtained; SBX-028 passed; **SBX-029 de-identification evidence**; privacy-office sign-off; documented failure and reconciliation behaviour.
**Evidence:** a per-connector certification record. · **Gate:** `G-CONN` · **Capabilities:** CAP-061, 063, 064, 065

---

## 4. Beta gate

A controlled beta may run with a restricted feature set **only if** the missing functionality is not required by the participating test users **and** the limitations are **explicitly disclosed** to them.

**Never waivable at beta:** tenant isolation · authorization · audit · privacy (SP-HR-1) · the design-system safety contract (no control persists before Save) · de-identification if any connector is active.

**Waivable with disclosure:** picklist execution (if beta users do not use picklists) · integrations · reporting breadth · push channel · document search.

---

## 5. Architecture gate — **UNBLOCKED 2026-07-31**

### 5.1 Status

The decisions that blocked architecture are **approved**:

| Decision | Subject | Status |
|---|---|---|
| `PO-DEC-02` | Authorization model — entitlement → group/module availability → membership role → explicit action capability | **APPROVED** |
| `PO-DEC-18` | Real-time transport — server-authoritative push for turn-critical picklist state | **APPROVED** |
| `PO-DEC-04` | Entitlement architecture — first-class org-level records, separate from permissions | **APPROVED** *(technical only)* |
| `PO-DEC-08` | De-identification ownership — SchedulePoint owns and enforces the ingestion boundary | **APPROVED** |

**The SchedulePoint architecture-definition phase is now unblocked and ready to begin.**

### 5.2 What approval does and does not mean

Three distinct things must not be conflated. For every capability previously described as an *architecture blocker*:

| Stage | Status |
|---|---|
| **The design decision** | **Approved** — the question of *what to build* is settled |
| **The architectural work** | **Not started** — designing the authorization layers, the real-time topology, the entitlement model, and the ingestion boundary is still to be done |
| **Implementation and verification** | **Future work** — nothing has been built, and no behaviour has been verified |

Specifically, as of this record:

- **Sandbox tests have not been executed.** All 39 remain defined and unrun ([18](18-targeted-sandbox-test-plan.md), [23](23-pre-architecture-evidence-plan.md)).
- **No production-completeness gate has passed.** Every `G-PROD` gate in §3 remains outstanding.
- **No connector-certification gate has passed.** `G-CONN`, including the de-identification gate, remains outstanding.
- **Approving these designs does not count as implementation or verification.** An approved design is an input to architecture, not evidence about a running system.

### 5.3 Remaining architecture inputs

Still to be decided or designed as part of architecture itself — these are **design work**, not blocking approvals: concurrency strategy · audit model · tenancy implementation · storage and retention design · observability design.

See [23](23-pre-architecture-evidence-plan.md) §6 for what may proceed on which evidence.

---

## 6. Product-owner decision package

**Approved (2026-07-31):** `PO-DEC-00` product name = **SchedulePoint** · `PO-DEC-02` authorization model · `PO-DEC-18` real-time transport · `PO-DEC-04` entitlement architecture · `PO-DEC-08` de-identification ownership.

**All others remain pending** — the saved evidence contains no explicit user approval for them. Each carries a recommended default that may be treated as the **working assumption** for planning, except where marked *approval required before architecture*.

| ID | Question | Recommended | Reason | Alternatives | Consequences if rejected | Capabilities | Arch effect | Prod effect | Approve before arch? | Working default? | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **PO-DEC-00** | Product name | **SchedulePoint** | Repository and all 24 reports use it | alternative name | corpus-wide rename | all | naming only | none | — | — | **APPROVED** |
| **PO-DEC-02** | C-02 authorization model | Four-layer: entitlement → group availability → role → capability | No flag without a tested capability difference | flat roles; copy source | authorization defects; C-02 reproduced | CAP-006, 030, 032, 057 | **high** | high | **YES** | n/a — approved | **APPROVED 2026-07-31** |
| **PO-DEC-18** | C-04 real-time transport | Hybrid: server-authoritative push for turn-critical state, refresh for admin lists | Staleness has real consequences only in a live turn | full push; full poll | stale turns or over-engineering | CAP-031, 032, 033 | **high** | high | **YES** | n/a — approved | **APPROVED 2026-07-31** |
| **PO-DEC-04** | C-12 entitlement architecture | First-class org-level entitlements with dependency validation, separate from permissions | Cross-cutting; expensive to retrofit | ad-hoc conditionals | scattered gating; C-02 confusion | CAP-057 + all gated | **high** | medium | **YES** | n/a — approved | **APPROVED 2026-07-31** *(technical architecture only; commercial packaging remains pending)* |
| **PO-DEC-08** | C-09 de-identification ownership | **SchedulePoint owns and enforces** the ingestion privacy boundary; platform-controlled positive allowlist | Privacy posture must not depend on the least careful partner | connector-enforced | patient data may enter | CAP-062, 055 | medium | **connector release** | no | n/a — approved | **APPROVED 2026-07-31** |
| **PO-DEC-03** | C-03 request model | One typed Request domain + linked vacation | Matches the vendor's own conceptual split | two entities | duplicated withdrawal logic | CAP-021, 022 | medium | low | no | yes | pending |
| **PO-DEC-01** | Site as first-class entity | Defer; model as an attribute initially | No evidence customers need it yet | first-class now | migration if wrong | CAP-004 | low | low | no | yes | pending |
| **PO-DEC-05** | Rule authoring: self-service vs. vendor | Self-service + vendor-assist onboarding | Source implies vendor-configured; self-service scales | vendor-only | services dependency | CAP-016 | low | medium | no | yes | pending |
| **PO-DEC-06** | One user, multiple organizations? | No, for first release | Materially complicates isolation | allow | isolation complexity | CAP-001, 005 | medium | low | no | yes | pending |
| **PO-DEC-07** | Push as a channel | Include as first-class | Publicly promised; core to mobile value | omit | narrower than advertised | CAP-041 | low | medium | no | yes | pending |
| **PO-DEC-09** | MFA / SSO | Close the gap; do not inherit the source baseline | Healthcare workforce product | match source | weaker auth posture | CAP-008 | medium | medium | no | yes | pending |
| **PO-DEC-11** | Impersonation | Audited, banner, time-limited, no credential screens | Genuinely useful, genuinely dangerous | omit entirely | support burden | CAP-010 | low | low | no | yes | pending |
| **PO-DEC-12** | Qualification ownership | Administrator-granted with evidence reference and expiry | Patient-safety adjacent | self-declared | unverified credentials | CAP-058 | low | **high** | no | yes | pending |
| **PO-DEC-13** | Conflict-severity taxonomy | Hard breach / unmet demand / eligibility failure / fairness outlier | Maps to constraint classes | flat list | unreviewable output | CAP-059 | low | high | no | yes | pending |
| **PO-DEC-14** | Default vacation mode | Quota/grant; open mode configurable | Matches the observed tenant | open by default | mismatch on onboarding | CAP-022 | low | low | no | yes | pending |
| **PO-DEC-15** | Opportunity recipient filtering | All eligible group members, opt-out honoured | Matches the public claim | scheduler-curated | fewer claimants | CAP-024 | low | low | no | yes | pending |
| **PO-DEC-16** | Staff-over-locum window | Configurable priority window, default 24h | Preserves the publicly claimed rule | none; permanent priority | locums over- or under-used | CAP-025 | low | low | no | yes | pending |
| **PO-DEC-17** | Swap review policy | Counterpart acceptance always; scheduler review per-group | Public source says review is optional | always require review | scheduler workload | CAP-026 | low | low | no | yes | pending |
| **PO-DEC-19** | Proxy default scope | `act-on-behalf`, fully attributed | Public wording indicates the proxy picks | notifications-only | proxy cannot act | CAP-034 | low | low | no | yes | pending |
| **PO-DEC-20** | Directory visibility policy | Person accounts with active membership; functional accounts opt-in | Explains the observed shortfall | include everyone | PII over-exposure | CAP-042 | low | low | no | yes | pending |
| **PO-DEC-21** | Group email ownership | Outbound-first on a vendor-managed domain | Inbound is a larger commitment | customer domain; inbound | rework if replies needed | CAP-056 | low | low | no | yes | pending |
| **PO-DEC-22** | Document retention | Policy-driven per organization, default indefinite | Source has none | fixed period | compliance mismatch | CAP-048 | low | low | no | yes | pending |
| **PO-DEC-23** | Solver performance targets | The conservative targets in [21](21-automated-scheduling-production-requirements.md) §8.3 | Quality before speed | match the public claim | unmet expectations | CAP-015 | medium | **high** | no | yes | pending |

**The three architecture-blocking decisions — PO-DEC-02, PO-DEC-18, PO-DEC-04 — are now APPROVED**, together with PO-DEC-08 (de-identification ownership). **No decision has been silently marked approved:** every other row above remains `pending` and retains its documented recommended working default, which may be used for technical planning but has not been ratified.

**Approval is not implementation.** These four approvals settle *what will be built*. They do not constitute architectural work, implementation, or verification — see §5.1.

---

## 7. Cross-references

Capabilities — [19](19-schedulepoint-production-capability-baseline.md) · Contradictions — [20](20-contradiction-resolution-register.md) · Engine — [21](21-automated-scheduling-production-requirements.md) · Traceability — [22](22-functional-traceability-matrix.md) · Evidence plan — [23](23-pre-architecture-evidence-plan.md) · Tests — [18](18-targeted-sandbox-test-plan.md), [11](11-edge-cases-and-qa.md)
