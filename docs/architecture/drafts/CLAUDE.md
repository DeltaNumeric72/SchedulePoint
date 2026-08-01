# CLAUDE.md — SchedulePoint (DRAFT — NOT INSTALLED)

> **This is a draft.** It lives in `docs/architecture/drafts/` and has **not** been installed at the repository root. Installing it is a separate, deliberate act.

---

## What this repository is

**SchedulePoint** is a physician and clinical-staff workforce-scheduling product. It is an **independently designed** product informed by a **clean-room behavioural investigation** of a comparable system.

**Current state: research and architecture only. There is no application code.**

- `schedulepoint-research/reports/` — 24 numbered research reports plus a coverage audit
- `docs/architecture/` — the architecture proposal (19 documents, 15 ADRs), **all `PROPOSED`**

---

## Non-negotiable rules

### 1. The clean-room boundary

**Never reproduce proprietary source code, private APIs, algorithms, assets, copy, or database structures from any source product.**

- The comparable product's **scheduling algorithm is unknown.** Do not reconstruct or approximate it. SchedulePoint has its own model ([08](../08-automated-scheduling-engine.md)).
- **Do not visit or interact with the source product.** Research is complete.
- **Do not introduce any organization, site, or person name from the research** into code, comments, fixtures, or tests.

### 2. Evidence classification is load-bearing

The research corpus classifies every statement as `OBSERVED`, `INFERRED`, `UNRESOLVED`, `SCHEDULEPOINT-REQUIREMENT`, or `SCHEDULEPOINT-RECOMMENDATION`.

**Never convert an inference or a recommendation into an observed fact.** If something is `UNRESOLVED`, it stays `UNRESOLVED` — including when a cleaner narrative would result from resolving it.

### 3. Capabilities are never silently dropped

The **58 capabilities** in [report 19](../../../schedulepoint-research/reports/19-schedulepoint-production-capability-baseline.md) are the authoritative scope.

**A capability may not disappear because it is difficult, expensive, integration-dependent, unobserved, or inconvenient.** These dispositions are prohibited: `excluded`, `abandoned`, `optional because difficult`, `indefinitely deferred`, `post-MVP with no production gate`.

Sequencing by milestone is fine. **Deletion is not.**

### 4. Approved decisions are binding

**PO-DEC-02** (four-layer authorization) · **PO-DEC-18** (server-authoritative real-time) · **PO-DEC-04** (first-class entitlements) · **PO-DEC-08** (platform-enforced ingestion boundary).

**The other 18 product decisions are pending.** Their working defaults may be used for planning. **Do not mark any of them approved.**

### 5. The 12 architectural invariants

Listed in [01](../01-architecture-overview.md) §4. Four deserve naming here:

| Invariant | Rule |
|---|---|
| **I-02** | **Every route declares its required capability. An undeclared route fails the build** |
| **I-13** | **No control labelled Add, New, or Create may persist anything before a completed form, validation, and an explicit Save.** This comes from a real incident in which such a control created a live record on click. **(Renumbered from `I-05`, which means mandatory automated scheduling — the collision was finding CAR-023)** |
| **I-07** | **No patient-identifying information or clinical free text enters the system** — not in tables, logs, errors, queues, audit payloads, traces, or backups |
| **I-11** | **A notification failure never rolls back a domain change** |
| **I-14/I-15** | **Tenant context is client-declared and server-verified; no statement touches a tenant table outside a unit of work with transaction-local context** |
| **I-16** | **A picklist turn produces at most one accepted selection, through one transaction** |
| **I-18** | **A published schedule version is immutable in the database** |
| **I-19** | **Every protected operation re-evaluates authorization against current state** |

### 6. Non-bypass rules — absolute

**Each of these has been bypassed in a real system by someone who believed they had a good reason. None of these is negotiable, and none has an exception you may grant yourself.**

| Never | Why |
|---|---|
| **Never query a tenant table outside the unit of work** | I-15. Outside it, RLS returns zero rows — **if you are tempted to "just add a direct query," that is the failure mode, not the workaround** |
| **Never use `SET` instead of `SET LOCAL` for tenant context** | S-03b. A session-scoped setting survives into the next borrower of a pooled connection |
| **Never disable, weaken, or `SKIP` an RLS policy, entitlement check, or capability check** | Including "temporarily," including in a test that then ships |
| **Never modify a published schedule version, its assignments, or any child row** | I-18. Amend by publishing forward |
| **Never delete an audit row, break the hash chain, or add an update path to the audit module** | ADR-0019 |
| **Never make manual scheduling the production mechanism** | I-05. It is override, recovery, fixed-assignment input, and development-stage only |
| **Never add a free-text field to a protected work-item path** | I-17. Use the controlled vocabulary |
| **Never log, trace, or place in an error a payload body, contact value, or push delivery material** | I-17, SPEC-07 §3 |
| **Never disable or weaken an accessibility test to ship** | CAP-066. A failing axe-core check is a defect, not an obstacle |
| **Never delete or weaken an existing architecture test** | Add tests; do not subtract them |
| **Never drop, defer, or narrow a capability from the 58-capability baseline** | Scope is owner-controlled |
| **Never implement a `pending` product decision as though it were approved** | Nineteen decisions are pending |
| **Never mark an ADR accepted or a gate passed** | Only the product owner does the first; only evidence does the second |

### 6a. Safety when running anything

- **Synthetic data only.** No real patient data, no real staff data, no real customer name — including in screenshots and logs.
- **No test may send a notification to a real person.** Controlled endpoints only.
- **No test runs against a live production organization of any system.**

---

## Working conventions

**Before changing architecture:** read [01](../01-architecture-overview.md) for the invariants and [19](../19-risks-and-decisions.md) for what is decided versus pending. If a change contradicts an ADR, **write a superseding ADR — do not edit the existing one silently.**

**Before adding a capability-bearing feature:** find it in [18](../18-capability-traceability.md). If it is not there, it is out of scope until the baseline changes.

**Changing architecture:** if a change contradicts an ADR, **write a superseding ADR — never edit an existing one silently.** If a change touches an invariant, update [01](../01-architecture-overview.md) §4 and the validator in the same change.

**Terminology:** the glossary ([report 12](../../../schedulepoint-research/reports/12-product-glossary.md)) has 88 defined terms. Use them exactly. Ten distinct schedule concepts are deliberately kept separate ([07](../07-schedule-and-publication.md)) — do not collapse them.

**Report honestly.** If a test fails, say so with the output. If a step was skipped, say that. **Do not describe designed behaviour as verified behaviour.**

---

## Status vocabulary

| Term | Means |
|---|---|
| `PROPOSED` | Written down. Not approved |
| `APPROVED` | The product owner has explicitly agreed |
| Gate `passed` | **Evidence exists.** No gate has passed |
| `UNRESOLVED` | Research could not establish it. It stays that way |
