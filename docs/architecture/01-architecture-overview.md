# 01 — Architecture Overview

**Status: `PROPOSED`.** Created 2026-07-31. **This is architecture documentation only — no application code, migration, service, UI component, or infrastructure resource was created.**

**Product:** `SchedulePoint` (PO-DEC-00 **APPROVED**).

---

## 1. What this package is

A complete architecture proposal for SchedulePoint, derived from the authoritative research corpus. It is a **clean-room design driven by required outcomes**, not by the source application's implementation. No proprietary source code, algorithm, schema, or private API informed any decision here.

**Authoritative inputs, and what each governs:**

| Document | Governs |
|---|---|
| [19 — Production Capability Baseline](../../schedulepoint-research/reports/19-schedulepoint-production-capability-baseline.md) | **Product scope** — 58 capabilities. Not reducible here. |
| [20 — Contradiction Resolution Register](../../schedulepoint-research/reports/20-contradiction-resolution-register.md) | **Approved architecture decisions** |
| [21 — Automated Scheduling Production Requirements](../../schedulepoint-research/reports/21-automated-scheduling-production-requirements.md) | **Scheduling engine requirements** |
| [22 — Functional Traceability Matrix](../../schedulepoint-research/reports/22-functional-traceability-matrix.md) | **Traceability** |
| [24 — Production Completeness Gates](../../schedulepoint-research/reports/24-production-completeness-gates.md) | **Release gates** |

**This proposal does not reduce, defer, exclude, or simplify the capability baseline.** All 58 capabilities have an architectural owner — see [18-capability-traceability.md](18-capability-traceability.md).

---

## 2. Recommended architecture

> **A modular monolith with dedicated background workers, on PostgreSQL, with a separate real-time coordinator process.**

One deployable web application containing strictly-bounded domain modules, plus a small number of independently-scalable worker processes that share the same codebase and database but run different entry points.

### 2.1 Why

The forces are genuinely in tension. A small initial team needs low operational overhead; enterprise healthcare customers need strong isolation and auditability; the scheduling solver is a fundamentally different workload from serving web requests; and real-time picklist execution has latency and concurrency characteristics unlike anything else in the product.

A modular monolith resolves most of this. **The workloads that genuinely differ get their own processes** — not their own services, databases, or deployment pipelines. That gives us workload isolation without distributed-systems cost.

### 2.2 The four process classes

| Process class | Why separate | Scaling driver |
|---|---|---|
| **Web / API** | Request-latency sensitive | Concurrent users |
| **Background workers** | Long-running, retryable, must not block requests | Queue depth |
| **Scheduling workers** | **CPU-bound, minutes-long, memory-hungry.** A solver run must never compete with a request thread | Build submissions × solver time |
| **Real-time coordinator** | Stateful connections, server-authoritative turn state and clock | Concurrent live picklists |

All four share one codebase and one database. They differ in entry point and in what they are allowed to do.

### 2.3 Alternatives evaluated

| Option | Verdict |
|---|---|
| **Single-process monolith** (web + jobs in one process) | **Rejected.** A multi-minute solver run in a web process is unacceptable, and picklist turn state cannot be owned safely by an arbitrary request handler. |
| **Modular monolith + workers** | **RECOMMENDED.** Simplest architecture that safely supports the complete product. |
| **Service-oriented (5–8 services)** | **Rejected initially.** Every domain boundary would become a network boundary and a distributed transaction. The publication → notification → audit path would need a saga where a database transaction suffices. Real cost, no current benefit. |
| **Microservices** | **Rejected.** Would impose distributed tracing, service discovery, per-service datastores, and eventual consistency on a team that has not yet shipped a schedule. The capability baseline does not require it. |

**Governing principle:** *prefer the simplest architecture capable of safely supporting the complete product.* "Safely" is doing real work in that sentence — it is why workers and the real-time coordinator are separate from day one, and why nothing else is.

---

## 3. Extraction boundaries

Modules are designed so that high-load or specialised components can be extracted **without redesigning the domain**. Extraction should be a deployment change, not a modelling change.

| Candidate | Readiness | Extraction trigger |
|---|---|---|
| **Scheduling-engine workers** | **Already a separate process.** Communicates only through a queued job + a persisted result | Solver capacity contention; need for specialised (e.g. high-memory) hosts |
| **Real-time picklist coordinator** | **Already a separate process.** Owns turn state and the authoritative clock | Concurrent live picklists exceed one process |
| **Notification delivery** | Behind a provider-agnostic port; outbox-driven | Delivery volume, or provider isolation needs |
| **Hospital connectors** | Behind a connector interface + the ingestion boundary | Per-connector isolation, or customer-specific deployment |
| **Report generation** | Async jobs producing stored artifacts | Report volume or long-running exports |

**What makes extraction cheap:** modules communicate through explicit published operations and domain events, never through each other's tables. A module that reaches into another module's tables cannot be extracted at any price — so that is prohibited (see [04-domain-boundaries.md](04-domain-boundaries.md) §3).

**Not everything on that list should start separate.** Notifications, connectors, and reports begin as in-process modules with worker entry points. Starting them as services would buy isolation we do not yet need at a cost we would pay every day.

---

## 4. Architectural invariants

Twelve properties that must hold everywhere. Each traces to an approved decision or a production gate.

| # | Invariant | Source |
|---|---|---|
| **I-01** | Tenant context is resolved **server-side from the session**, never from a client-supplied parameter | CAP-003, PO-DEC-02 |
| **I-02** | Authorization is **deny-by-default**; an operation with no policy fails closed and fails its automated test | PO-DEC-02 |
| **I-03** | **Entitlement ≠ permission.** Entitlement asks whether the organization has the module; permission asks whether this person may act | PO-DEC-04 |
| **I-04** | Published schedules are **immutable versions**; supersession never deletes history | CAP-014 |
| **I-05** | **Automated scheduling is the production mechanism.** Manual scheduling is override, recovery, fixed-assignment input, and development-stage only | C-08, PO-DEC-08 context |
| **I-06** | Every mutation is **audited** with actor, on-behalf-of, before/after, mechanism, correlation id | CAP-027 |
| **I-07** | **No patient-identifying information enters the platform** — enforced at the ingestion boundary by a positive allowlist | PO-DEC-08 |
| **I-08** | Picklist turn state and the clock are **server-authoritative** | PO-DEC-18 |
| **I-09** | State-changing operations are **idempotent** under retry | SP-HR-2 |
| **I-10** | **One user action produces one request** — no amplification | SP-HR-2 |
| **I-11** | Notifications dispatch **only after the triggering transaction commits** | CAP-040 |
| **I-12** | Every interactive element meets **SP-HR-3..6** accessibility requirements | CAP-066 |

**These are testable properties, not aspirations.** [16-testing-and-environments.md](16-testing-and-environments.md) maps each to an automated check; an invariant with no failing-test path is not an invariant.

---

## 5. Approved decisions applied

| Decision | Where applied |
|---|---|
| **PO-DEC-00** — name `SchedulePoint` | Throughout |
| **PO-DEC-02** — authorization: `org entitlement → group/module availability → membership role → explicit capability` | [05](05-tenancy-entitlements-authorization.md), [ADR-0004](decisions/ADR-0004-authorization-architecture.md) |
| **PO-DEC-18** — server-authoritative push for turn-critical state | [10](10-picklist-and-realtime.md), [ADR-0008](decisions/ADR-0008-realtime-picklist-transport.md) |
| **PO-DEC-04** — first-class org-level entitlements, separate from permissions | [05](05-tenancy-entitlements-authorization.md), [ADR-0005](decisions/ADR-0005-entitlement-architecture.md) |
| **PO-DEC-08** — platform-owned ingestion privacy boundary | [12](12-integrations-and-ingestion-privacy.md), [ADR-0011](decisions/ADR-0011-ingestion-privacy-boundary.md) |

**No approved decision is reopened.** Where this proposal adds detail, it elaborates within the approved decision rather than revisiting it.

---

## 6. What this proposal does *not* do

- **No gate is declared passed.** Every `G-PROD` and `G-CONN` gate remains outstanding. Architecture documentation is not evidence about a running system.
- **No sandbox test has been executed.** All 39 remain defined and unrun.
- **No ADR is accepted.** All are `PROPOSED`.
- **No pending product decision is approved.** All 18 remain pending with their recommended working defaults ([19-risks-and-decisions.md](19-risks-and-decisions.md) §3).
- **No application code, migration, service, UI component, or infrastructure resource was created.**
- **No source-product research was performed** and iSchedule.MD was not visited.

---

## 7. Reading order

**For a reviewer:** this document → [02 stack](02-technology-stack.md) → [03 context](03-system-context-and-containers.md) → [05 tenancy](05-tenancy-entitlements-authorization.md) → [08 engine](08-automated-scheduling-engine.md) → [18 traceability](18-capability-traceability.md) → [19 risks](19-risks-and-decisions.md).

**For the highest-risk areas specifically:** [08 engine](08-automated-scheduling-engine.md), [10 picklist concurrency](10-picklist-and-realtime.md), [12 ingestion privacy](12-integrations-and-ingestion-privacy.md), [14 security](14-security-and-privacy.md).

| Doc | Subject |
|---|---|
| [01](01-architecture-overview.md) | This overview |
| [02](02-technology-stack.md) | Technology stack |
| [03](03-system-context-and-containers.md) | Context and containers |
| [04](04-domain-boundaries.md) | Domain boundaries |
| [05](05-tenancy-entitlements-authorization.md) | Tenancy, entitlements, authorization |
| [06](06-data-architecture.md) | Data architecture |
| [07](07-schedule-and-publication.md) | Schedule and publication |
| [08](08-automated-scheduling-engine.md) | Automated scheduling engine |
| [09](09-requests-vacation-opportunities-transfers.md) | Requests, vacation, opportunities, transfers |
| [10](10-picklist-and-realtime.md) | Picklist and real-time |
| [11](11-notifications-and-communications.md) | Notifications and communications |
| [12](12-integrations-and-ingestion-privacy.md) | Integrations and ingestion privacy |
| [13](13-reports-calendars-and-documents.md) | Reports, calendars, documents |
| [14](14-security-and-privacy.md) | Security and privacy |
| [15](15-audit-and-observability.md) | Audit and observability |
| [16](16-testing-and-environments.md) | Testing and environments |
| [17](17-deployment-and-operations.md) | Deployment and operations |
| [18](18-capability-traceability.md) | Capability traceability |
| [19](19-risks-and-decisions.md) | Risks and decisions |

Decision records: [decisions/](decisions/) · Diagrams: [diagrams/](diagrams/) · Sources: [references/official-technical-sources.md](references/official-technical-sources.md) · Repository-instruction drafts: [drafts/](drafts/)
