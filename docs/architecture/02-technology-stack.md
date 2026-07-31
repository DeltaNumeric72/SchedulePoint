# 02 — Technology Stack

**Status: `PROPOSED`.** Nothing here is installed, configured, or committed to. Every row is a recommendation with a stated confidence and a replacement boundary.

**Evidence discipline.** Only four claims in this document are **documented facts** verified against official primary sources ([references](references/official-technical-sources.md)): CP-SAT's solver class and status values, CP-SAT's optimization support, OR-Tools' Apache-2.0 licence, and PostgreSQL's row-level-security semantics. **Everything else is an architectural recommendation** whose maturity and licensing claims require verification before adoption. Rows requiring verification are marked **`VERIFY`**.

---

## 1. Recommended stack at a glance

| Area | Recommendation | Confidence |
|---|---|---|
| Runtime | Node.js (LTS) + TypeScript | High |
| Web framework | A mature TypeScript server framework with first-class middleware and streaming | Med `VERIFY` |
| UI | Server-rendered pages + progressive enhancement; a component-based client framework for interactive surfaces | Med |
| API style | HTTP/JSON, resource-oriented, versioned; typed contracts shared with the client | High |
| Database | **PostgreSQL** | **High** |
| Data access | A typed query builder or ORM with explicit SQL escape hatch | Med `VERIFY` |
| Migrations | Versioned, forward-only, reviewed SQL | High |
| AuthN | First-party email + password with MFA; OIDC-based SSO | High |
| AuthZ | Capability-based policy layer + PostgreSQL RLS | **High** |
| Jobs | Durable queue backed by PostgreSQL initially; broker when volume justifies | Med |
| Real-time | WebSocket with server-authoritative state | **High** |
| **Solver** | **OR-Tools CP-SAT**, behind a solver-neutral port | **High** |
| Object storage | S3-compatible | High |
| Observability | OpenTelemetry-based traces/metrics/logs | High |
| Testing | Unit + domain + Playwright + axe-core | High |
| CI/CD | Containerised build, automated gates | High |

Full per-choice detail follows. Every entry carries: responsibility · alternatives · reason · maturity · licensing · operational complexity · security · scaling · **replacement boundary** · confidence · ADR required.

---

## 2. Platform and application

### 2.1 Application runtime — Node.js LTS + TypeScript
**Responsibility:** all four process classes.
**Alternatives:** .NET, Go, Python, JVM.
**Reason:** one language across server, workers, and browser reduces context-switching for a small team, and a strong structural type system directly supports the domain invariants this product depends on. Python would ease solver integration but is weaker for the real-time and web tiers; Go is excellent for workers but adds a second language.
**Maturity/licensing:** `VERIFY` — confirm the LTS support window before committing.
**Operational complexity:** low. **Security:** dependency surface is the main risk — see [14](14-security-and-privacy.md) §9. **Scaling:** horizontal; CPU-bound solver work is deliberately *not* run here (§4.1).
**Replacement boundary:** the domain layer must contain no framework or runtime imports, so domain logic is portable.
**Confidence:** High. **ADR:** [ADR-0002](decisions/ADR-0002-primary-technology-stack.md).

### 2.2 Web framework — mature TypeScript server framework `VERIFY`
**Responsibility:** HTTP handling, routing, middleware, streaming.
**Reason:** the architecture needs middleware composition (tenant context, authorization, correlation id) and streaming (report downloads, calendar feeds). It does **not** need an opinionated full-stack framework — most of this product is domain logic, not page plumbing.
**Replacement boundary:** HTTP handlers are thin adapters; no domain rule lives in a route handler. Swapping frameworks should touch the adapter layer only.
**Confidence:** Med. **ADR:** ADR-0002.

### 2.3 UI framework and component system
**Responsibility:** operational screens — schedule grid, picklist, requests, admin.
**Reason:** most screens are data-dense and benefit from server rendering; a few (the live picklist, the schedule grid) are genuinely interactive and need a component model with real state.
**Accessibility is a hard constraint, not a preference.** The component system must make SP-HR-3..6 the default: visible focus, accessible names on icon controls, keyboard operation, programmatic status. A component library that fights these is disqualified regardless of other merits.
**Scaling:** the schedule grid must virtualise — ≥200 staff × 8 weeks is a stated benchmark.
**Replacement boundary:** design tokens and component contracts defined independently of the library.
**Confidence:** Med. **ADR:** ADR-0002.

### 2.4 Calendar and scheduling UI
**Responsibility:** month/week grids, staff × date matrices, date-range pickers.
**Reason:** the schedule grid is unusual enough (three view modes, per-cell provenance, credits distinct from assignments) that a generic calendar component is unlikely to fit. **Recommendation: build the grid on primitives rather than adopt a calendar library**, and provide a screen-reader-friendly tabular alternative — a visual grid alone cannot satisfy CAP-066.
**Confidence:** Med.

### 2.5 API style — versioned resource-oriented HTTP/JSON
**Reason:** the client is first-party, so a typed contract shared between server and client gives most of GraphQL's ergonomics without its authorization complexity. **GraphQL is specifically cautioned against here**: field-level authorization across 58 capabilities and four authorization layers is materially harder to make deny-by-default.
**Security:** every route declares an explicit policy; a route without one fails the build (I-02).
**Confidence:** High. **ADR:** ADR-0002.

### 2.6 Validation
**Responsibility:** parse and validate every inbound payload at the boundary; derive types from schemas.
**Reason:** the ingestion privacy boundary (I-07) requires a **positive allowlist** — a schema library that strips unknown keys by default is the natural enforcement point. See [12](12-integrations-and-ingestion-privacy.md) §4.
**Confidence:** High.

---

## 3. Data

### 3.1 Database — PostgreSQL
**Responsibility:** system of record for all domains.
**Alternatives:** MySQL (weaker RLS story), a document store (rejected — this domain is deeply relational and invariant-heavy), multiple per-service datastores (rejected with microservices).
**Reason:** relational integrity is load-bearing here. Assignments, credits, versions, and audit entries have genuine referential invariants. **Row-level security provides a second isolation layer** below the application (documented fact S-03). Transactional guarantees make the publication path a single transaction rather than a saga.
**Security — documented consequence of S-03:** RLS is defence in depth, **not** the primary control.
- With RLS enabled and no policy, the default is **deny** — a new tenant table nobody wrote a policy for fails closed.
- **Table owners bypass RLS unless `FORCE ROW LEVEL SECURITY` is set**, and **superusers and `BYPASSRLS` roles always bypass it.** Therefore the application runtime role **must not** be a superuser, must not hold `BYPASSRLS`, and must not own the tenant tables. Migrations run as a separate role.
- `TRUNCATE` and `REFERENCES` are **not** subject to RLS, so destructive operations are controlled by grants.
**Scaling:** read replicas for reporting; partitioning for audit and notification-attempt tables when volume justifies.
**Replacement boundary:** none — PostgreSQL is a deliberate, deep commitment. Replacing it would be a re-architecture, and this is stated plainly rather than pretending otherwise.
**Confidence:** **High.** **ADR:** [ADR-0003](decisions/ADR-0003-database-and-tenancy-strategy.md).

### 3.2 Data access `VERIFY`
**Responsibility:** typed queries, transaction management, connection pooling.
**Reason:** the workload mixes simple CRUD with genuinely complex analytical queries (fairness statistics, schedule grids). An ORM that makes the hard queries unreadable is a poor fit; **a typed query builder with an explicit SQL escape hatch is preferred over a heavyweight ORM.**
**Security:** the tenant-context session variable that RLS policies read must be set on **every** connection checkout — this is the single most important integration point between the pool and the isolation model (see [05](05-tenancy-entitlements-authorization.md) §4.3).
**Replacement boundary:** repository interfaces defined in the domain layer; query implementation is swappable.
**Confidence:** Med. **ADR:** ADR-0003.

### 3.3 Migrations
Versioned, forward-only, reviewed as code, run by a role **separate** from the application runtime role. Every migration adding a tenant-scoped table must add its RLS policy **in the same migration** — a CI check enforces this pairing. **Confidence:** High.

### 3.4 Caching
**Responsibility:** hot reference data (shift catalogues, rule sets), rendered fragments.
**Security:** **every cache key is prefixed with the organization and, where applicable, group id.** Cross-tenant cache leakage is an explicitly modelled threat ([14](14-security-and-privacy.md) T-04).
**Recommendation:** defer a distributed cache until measured need; start with request-scoped memoisation. **Premature caching is a leading cause of cross-tenant leakage** — this is a deliberate sequencing choice.
**Confidence:** Med.

---

## 4. Workloads

### 4.1 Optimization solver — OR-Tools CP-SAT, behind a solver-neutral port

**The most consequential technology decision in this proposal.**

**Documented facts (S-01, S-02):** CP-SAT is a constraint-programming solver designed for integer programming problems. It supports **optimization objectives**, not merely satisfiability. Constraints are expressed over integers; non-integer values must be scaled. Status values are `OPTIMAL`, `FEASIBLE`, `INFEASIBLE`, `MODEL_INVALID`, `UNKNOWN`. Licensed **Apache-2.0**.

**Comparison against the required capability** (report 21):

| Approach | Hard constraints | Soft preferences | Explainability | Performance | Verdict |
|---|---|---|---|---|---|
| **Constraint programming (CP-SAT)** | Native and expressive — spacing, sequencing, and pattern rules map directly | Weighted objective terms | **`INFEASIBLE` is a first-class documented status**; per-constraint attribution is designable | Strong on scheduling-shaped problems | **RECOMMENDED** |
| **Mixed-integer programming** | Expressible, but sequencing and pattern rules become awkward linearisations | Native objectives | Duals/IIS give useful diagnostics | Strong, but modelling cost is higher here | Viable alternative |
| **Heuristic / metaheuristic** | **Cannot guarantee** hard-constraint satisfaction | Natural fit | **Weak — cannot prove infeasibility**, only fail to find | Fast, scales well | **Rejected as primary** |
| **Hybrid (CP + heuristic warm start)** | Inherits CP guarantees | Good | Inherits CP | Potentially best at scale | **Recommended evolution** |

**Reason for CP-SAT.** Two production requirements decide this. First, **zero unauthorized hard-constraint violations** is an absolute gate — a heuristic cannot provide that guarantee, only its absence of evidence. Second, **infeasibility must be explained**, and CP-SAT's documented `INFEASIBLE` status gives a principled foundation that a metaheuristic's "did not find one" does not. Fairness and preference satisfaction map naturally onto weighted objective terms.

**Reproducibility** is an absolute criterion in report 21 §7. Achieving it requires pinning the solver version, fixing the random seed, and **fixing worker count where parallelism affects determinism** — the CP-SAT overview did not document parallelism behaviour, so this must be **established by benchmark (SBX-031), not assumed.**

**Integer-only modelling is a real design constraint.** Weights, percentages, and fairness metrics must be scaled to integers with an explicitly documented precision. This is a modelling decision to make once, deliberately, not per-rule.

**Replacement boundary — mandatory.** The domain expresses a **solver-neutral model** (`ScheduleProblem` → `ScheduleSolution`). The CP-SAT translation lives entirely in an adapter. **No domain code imports the solver.** This is what makes a future MIP or hybrid approach a change of adapter rather than a rewrite — and it is a hard architectural requirement, not a nicety. See [08](08-automated-scheduling-engine.md) §3.

**Operational complexity:** native binaries; CPU- and memory-hungry; runs only on scheduling workers, never in a web process. **Confidence:** **High.** **ADR:** [ADR-0006](decisions/ADR-0006-solver-architecture.md).

### 4.2 Job queue and background workers
**Responsibility:** durable, retryable, observable async work.
**Recommendation: start with a PostgreSQL-backed durable queue.** It gives transactional enqueue — a job and the domain change that caused it commit together, which is exactly what the transactional outbox needs (I-11). Introducing a broker means a second consistency problem on day one.
**Alternatives:** Redis-backed queues (fast, but enqueue is not transactional with the database write), managed cloud queues (adds a vendor boundary early).
**Scaling:** move to a dedicated broker when queue depth or throughput justifies it; the port stays the same.
**Replacement boundary:** a `JobQueue` port; handlers are plain functions.
**Confidence:** Med. **ADR:** [ADR-0009](decisions/ADR-0009-job-and-event-reliability.md).

### 4.3 Real-time transport — WebSocket, server-authoritative
**Responsibility:** turn-critical picklist state (PO-DEC-18).
**Reason:** bidirectional, low-latency, and mature. Server-sent events were considered but are unidirectional and awkward for the command path.
**Security:** the connection carries **server-resolved** tenant and membership context; subscriptions are authorized per topic. Real-time subscription leakage is an explicitly modelled threat (T-08).
**Scaling:** page-scoped connections only — **never opened globally on every page**, which is both a stated requirement and an observed anti-pattern.
**Replacement boundary:** message contracts defined independently of transport.
**Confidence:** **High.** **ADR:** [ADR-0008](decisions/ADR-0008-realtime-picklist-transport.md).

---

## 5. Communications, storage, integrations

| Area | Recommendation | Notes | Confidence |
|---|---|---|---|
| **Email** | Transactional provider behind an `EmailPort` | Deliverability and bounce handling matter more than API elegance | Med `VERIFY` |
| **SMS** | Programmable messaging provider behind an `SmsPort` | Jurisdictional rules vary — a compliance question, not just technical | Med `VERIFY` |
| **Voice** | Programmable voice behind a `VoicePort` | Load-bearing for picking; treat as first-class, not an afterthought | Med `VERIFY` |
| **Push** | Web Push + platform push behind a `PushPort` | Requires explicit consent and invalid-token cleanup (CAP-041) | Med `VERIFY` |
| **File storage** | S3-compatible object storage | Per-tenant key prefixes; short-lived signed URLs; **no public buckets** | High |
| **Report generation** | Async worker producing stored artifacts | Never generated inline in a request | High |
| **Calendar feeds** | Server-rendered iCalendar; hash-stored revocable tokens | **No PII in the URL** (CAP-047) | High |

**All five provider ports share one rule:** the domain emits a notification *intent*; providers are adapters. A provider swap must not touch domain code. See [11](11-notifications-and-communications.md).

---

## 6. Observability, testing, delivery

| Area | Recommendation | Notes | Confidence |
|---|---|---|---|
| **Instrumentation** | OpenTelemetry (traces, metrics, logs) | Vendor-neutral; avoids early lock-in | High |
| **Structured logging** | JSON with correlation id, org id, group id, actor | **Never** log payload bodies from ingestion (I-07) | High |
| **Metrics** | Requests-per-interaction, solver duration/quality, delivery outcomes, queue depth | Requests-per-interaction directly enforces SP-HR-2 | High |
| **Tracing** | Distributed traces across web → queue → worker | Tenant context propagates with the trace | High |
| **Error monitoring** | Aggregation with **scrubbing enabled by default** | Error payloads are a real leakage path | High |
| **Testing** | Unit, domain, property-based, integration, contract, Playwright | See [16](16-testing-and-environments.md) | High |
| **Accessibility testing** | axe-core in CI + manual screen-reader passes | Automation catches perhaps half; manual passes are required | High |
| **Local dev** | Containerised Postgres + object storage; seeded synthetic data | **Synthetic only, always** | High |
| **Containerisation** | OCI images, one image, multiple entry points | Same artifact for web/worker/solver/realtime | High |
| **CI** | Lint, typecheck, unit, domain, **policy tests**, migration+RLS pairing check, a11y, request-budget | Gates that can fail the build | High |
| **Deployment** | Rolling deploys; migrations gated and reversible | See [17](17-deployment-and-operations.md) | Med |
| **Secrets** | Managed secret store; **never** in env files in the repo | Connector credentials referenced, never stored on the connector record | High |
| **Backup/recovery** | Automated backups + point-in-time recovery; **restore rehearsal** | Untested backups are not backups | High |

---

## 7. Authentication and authorization

| Area | Recommendation | Notes | Confidence |
|---|---|---|---|
| **AuthN** | First-party email + password, strong hashing | Email is the identity (matches the domain) | High |
| **MFA** | TOTP at minimum; required for elevated roles | The source offers none — **this is a deliberate gap-closing decision** (PO-DEC-09 pending) | High |
| **SSO** | OIDC, per-organization | Enterprise healthcare expects it; design for it now, ship when a customer needs it | Med |
| **Sessions** | Server-side sessions; `HttpOnly`+`Secure`+`SameSite`; bounded idle and absolute lifetimes | Persistent option scoped to personal devices | High |
| **Authorization** | Capability policies + PostgreSQL RLS | Two layers, deliberately | **High** |
| **Impersonation** | Audited, banner-visible, time-limited, barred from credential screens | CAP-010 | High |

**ADR:** [ADR-0004](decisions/ADR-0004-authorization-architecture.md).

---

## 8. What requires verification before adoption

Everything marked `VERIFY` above, plus:

1. **CP-SAT parallelism and determinism** — the official overview did not document it; **reproducibility is an absolute requirement**, so this must be benchmarked (SBX-031) before the solver design is finalised.
2. **Notification provider terms** — deliverability, retention, jurisdictional restrictions for SMS and voice.
3. **LTS support windows** for the runtime and framework.
4. **Licence review** of every dependency before first release.

**None of these blocks architecture.** Each blocks a specific later decision, and each is recorded in the risk register with an owner.
