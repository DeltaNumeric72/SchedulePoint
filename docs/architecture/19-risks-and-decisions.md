# 19 — Risks and Decisions

**Status: `PROPOSED`.**

---

## 1. Risk register

**Scoring:** likelihood and impact are `low` / `medium` / `high`. **These are judgements, not measurements.** Each risk names an owner-facing mitigation and, where one exists, the test that would retire it.

### 1.1 Technical risks

| ID | Risk | L | I | Mitigation | Retired by |
|---|---|---|---|---|---|
| **RISK-01** | **The solver does not meet quality or time targets on real-sized problems.** The source's algorithm is unknown; SchedulePoint's model is its own | med | **high** | `SolverPort` abstraction; solver-neutral model; **benchmark before committing** to a solver; hybrid fallback path documented | SBX-030, SBX-031 |
| **RISK-02** | **Infeasibility explanations are unusable in practice.** A scheduler told only "infeasible" cannot act | med | **high** | Constraint-relaxation search producing minimal cores, mapped to named rules ([08](08-automated-scheduling-engine.md) §7) | Scheduler usability review + SBX-031 |
| **RISK-03** | **RLS cost degrades query performance at scale** | med | med | RLS as *defence in depth*, not the primary control; application-level scoping first; **measure early**; per-tenant indexing | PERF benchmarks (A-6) |
| **RISK-04** | **Real-time coordinator becomes a scaling or reliability bottleneck** | med | **high** | Durable state in PostgreSQL, not in the process; page-scoped connections; reconnect with backoff and jitter; horizontal instances | SBX-023, SBX-030 |
| **RISK-05** | **The picklist concurrency design fails under real contention** | low | **high** | Database uniqueness constraint decides races — not application logic; **SBX-022 over ≥50 trials** | SBX-022 |
| **RISK-06** | **Modular monolith boundaries erode into a distributed-monolith-in-one-process** | med | med | Enforced import boundaries in CI; explicit prohibited-dependency table ([04](04-domain-boundaries.md) §5) | CI boundary check |
| **RISK-07** | **Notification volume or provider limits throttle escalation when it matters most** | med | med | Bounded retry with jitter; dead-lettering; rate-limit awareness; **`no-destination` as an explicit outcome** | SBX-030a |
| **RISK-08** | **PostgreSQL-backed queue outgrows its design point** | low | med | Deliberate, reversible choice ([02](02-technology-stack.md) §4.2); broker introduced when depth metrics justify it | Queue-depth telemetry |
| **RISK-09** | **Schedule versioning storage grows without bound** | low | low | Time partitioning; artifact expiry; **history itself is never deleted** | Volume monitoring |

### 1.2 Privacy and security risks

| ID | Risk | L | I | Mitigation | Retired by |
|---|---|---|---|---|---|
| **RISK-10** | **Patient-identifying data enters the system via a connector** | med | **high** | **Platform-enforced positive allowlist that no connector can bypass** (PO-DEC-08); quarantine holds field names and counts only | **SBX-029** |
| **RISK-11** | **Cross-tenant data exposure** | low | **high** | Four-layer authorization + RLS with `FORCE`; composite FKs; build fails on an undeclared route | SBX-001, SBX-002, SBX-004 |
| **RISK-12** | **A third-party identifier leak is reintroduced** — the failure the research observed directly | med | **high** | **CI guard failing the build on any new outbound host**; strict CSP | QA-SEC-001..003 |
| **RISK-13** | **Sensitive content reaches logs, errors, or traces** | med | **high** | Allowlist-based structured logging; scrubbing on by default; **payloads and message bodies never logged** | Log-review test |
| **RISK-14** | **A leaked calendar-feed or report URL exposes a schedule** | med | med | Hash-stored revocable tokens; short-lived signed URLs; **no PII in any URL** | SBX-031a, SBX-031c |
| **RISK-15** | **No incident-response plan exists** | **high** | **high** | **Named openly as a gap** ([14](14-security-and-privacy.md) §10). Requires legal and operational input not available to this task | A written plan — **not by any test** |

### 1.3 Product and evidence risks

| ID | Risk | L | I | Mitigation | Retired by |
|---|---|---|---|---|---|
| **RISK-16** | **The picklist design is wrong because its execution was never observed** | med | **high** | Designed from first principles with an explicit safety posture; **nine sandbox tests written specifically against it** | SBX-020..027, SBX-033 |
| **RISK-17** | **Named connectors cannot be built** — no vendor payload specification is in hand | **high** | med | **Canonical schema owned by the platform**, so no hospital's IT timeline gates our release; connector absence blocks that connector, not the product | Obtaining each specification |
| **RISK-18** | **Fairness normalisation does not match customer expectations.** The source's formula is UNRESOLVED | med | med | SchedulePoint defines and documents its own formula, visible to schedulers rather than hidden | Customer validation |
| **RISK-19** | **The 18 pending decisions are resolved differently from their working defaults**, invalidating design assumptions | med | med | Each default is documented with its blast radius (§2); **none is silently treated as approved** | Product-owner ratification |
| **RISK-20** | **Accessibility conformance is asserted rather than achieved** | med | **high** | axe-core as a **build gate**, not a report; manual screen-reader passes; **a timed picklist turn verified end-to-end** | SBX-032, SBX-033, SBX-034 |
| **RISK-21** | **Scope creep from 58 capabilities overwhelms delivery** | **high** | med | Milestone sequencing (foundation → alpha → beta → production); **gates, not deletions** — no capability is dropped to relieve pressure | Milestone review |
| **RISK-22** | **This architecture has had no independent review** | **high** | med | **Named as a gap.** An independent Codex architecture review is pending | That review |

### 1.4 Operational risks

| ID | Risk | L | I | Mitigation | Retired by |
|---|---|---|---|---|---|
| **RISK-23** | **Backups are never proven restorable** | med | **high** | Restore rehearsal is a production gate, not a task — **including audit-integrity verification** | **SBX-035** |
| **RISK-24** | **No runbooks exist for the failure modes this design creates** | **high** | med | Ten runbooks named in [17](17-deployment-and-operations.md) §8 so their absence is visible | Writing them |
| **RISK-25** | **Data-residency requirements block Canadian customers** | med | **high** | Named as an open operational question; **provider and region deliberately undecided** rather than wrongly decided | ADR-0015 resolution |
| **RISK-26** | **A migration causes an outage or data loss** | low | **high** | Expand → migrate → contract; no destructive change in the same release; backfills as jobs; **rollback path identified before deploy** | Migration rehearsal |

---

## 2. Decisions

### 2.1 Approved by the product owner

**Recorded 2026-07-31. These four are the basis on which architecture was unblocked.**

| ID | Decision | Applied in |
|---|---|---|
| **PO-DEC-00** | Product name = **SchedulePoint** | Corpus-wide |
| **PO-DEC-02** | **Authorization model:** organization entitlement → group/module availability → membership role → explicit action capability; deny-by-default; **no permission flag without a tested capability difference** | [05](05-tenancy-entitlements-authorization.md), ADR-0004 |
| **PO-DEC-18** | **Real-time model:** server-authoritative push for turn-critical picklist state; version tokens; reconnection and resync; visible staleness; explicit refresh fallback; page-scoped connections | [10](10-picklist-and-realtime.md), ADR-0008 |
| **PO-DEC-04** | **Entitlement architecture:** first-class org-level records separate from permissions; module dependencies; **disabling never deletes data**. *Technical architecture only — commercial packaging remains pending* | [05](05-tenancy-entitlements-authorization.md), ADR-0005 |
| **PO-DEC-08** | **Ingestion privacy ownership:** SchedulePoint owns and enforces the boundary via a platform-controlled positive allowlist | [12](12-integrations-and-ingestion-privacy.md), ADR-0011 |

### 2.2 The 18 pending decisions — **retained, not approved**

**Every row below remains `pending`.** The recommended working default may be used for technical planning. **None has been ratified, and this task has not approved any of them.**

| ID | Decision | Recommended working default | Blast radius if decided otherwise | Capabilities |
|---|---|---|---|---|
| **PO-DEC-01** | Site as a first-class entity | Defer; model as an attribute initially | Migration if wrong — **low** | CAP-004 |
| **PO-DEC-03** | Request model | One typed Request domain + linked vacation | Duplicated withdrawal logic — **low** | CAP-021, CAP-022 |
| **PO-DEC-05** | Rule authoring: self-service vs. vendor | Self-service + vendor-assisted onboarding | Services dependency — **medium** | CAP-016 |
| **PO-DEC-06** | One user across multiple organizations | **No**, for the first release | Isolation complexity — **medium**, and expensive to add late | CAP-001, CAP-005 |
| **PO-DEC-07** | Push as a channel | Include as first-class | Product narrower than advertised — **medium** | CAP-041 |
| **PO-DEC-09** | MFA / SSO | Close the gap; do not inherit the source baseline | Weaker auth posture — **medium** | CAP-008 |
| **PO-DEC-11** | Impersonation | Audited, banner, time-limited, no credential screens | Support burden — **low** | CAP-010 |
| **PO-DEC-12** | Qualification ownership | Administrator-granted, with evidence reference and expiry | **Patient-safety adjacent — high** | CAP-058 |
| **PO-DEC-13** | Conflict-severity taxonomy | Hard breach / unmet demand / eligibility failure / fairness outlier | Unreviewable solver output — **high** | CAP-059 |
| **PO-DEC-14** | Default vacation mode | Quota/grant; open mode configurable | Onboarding mismatch — **low** | CAP-022 |
| **PO-DEC-15** | Opportunity recipient filtering | All eligible group members, opt-out honoured | Fewer claimants — **low** | CAP-024 |
| **PO-DEC-16** | Staff-over-locum window | Configurable priority window, default 24h | Locums over- or under-used — **low** | CAP-025 |
| **PO-DEC-17** | Swap review policy | Counterpart acceptance always; scheduler review per-group | Scheduler workload — **low** | CAP-026 |
| **PO-DEC-19** | Proxy default scope | `act-on-behalf`, fully attributed | Proxy cannot act — **low** | CAP-034 |
| **PO-DEC-20** | Directory visibility policy | Person accounts with an active membership; functional accounts opt-in | **PII over-exposure — medium** | CAP-042 |
| **PO-DEC-21** | Group email ownership | Outbound-first on a vendor-managed domain | Rework if replies are needed — **low** | CAP-056 |
| **PO-DEC-22** | Document retention | Policy-driven per organization, default indefinite | Compliance mismatch — **medium** | CAP-048 |
| **PO-DEC-23** | Solver performance targets | The conservative targets in [report 21](../../schedulepoint-research/reports/21-automated-scheduling-production-requirements.md) §8.3 | **Unmet customer expectations — high** | CAP-015 |

**Count: 18.** This matches [report 24](../../schedulepoint-research/reports/24-production-completeness-gates.md) §3 exactly.

> **Register discrepancy, flagged not resolved:** **PO-DEC-10** (locum billing rule — "part-time locums free" reaching into the domain model) is defined in [report 17](../../schedulepoint-research/reports/17-public-source-gap-addendum.md) §11 but **does not appear in report 24's decision register**. It is neither approved nor listed among the 18. This architecture keeps billing derived from — never embedded in — scheduling data, which is the recommendation report 17 recorded. **The register gap is a product-owner matter and is not resolved here.**

### 2.3 Architecture decisions (ADRs)

**All fifteen are `PROPOSED`. None is accepted.**

| ADR | Subject | Primary capabilities |
|---|---|---|
| [ADR-0001](decisions/ADR-0001-application-topology.md) | Modular monolith with dedicated workers | All |
| [ADR-0002](decisions/ADR-0002-primary-technology-stack.md) | Primary technology stack | CAP-066, CAP-067, CAP-068 |
| [ADR-0003](decisions/ADR-0003-database-and-tenancy-strategy.md) | Shared database, shared schema, RLS | CAP-001, CAP-002, CAP-003 |
| [ADR-0004](decisions/ADR-0004-authorization-architecture.md) | Four-layer authorization | CAP-006 |
| [ADR-0005](decisions/ADR-0005-entitlement-architecture.md) | First-class entitlements | CAP-057 |
| [ADR-0006](decisions/ADR-0006-solver-architecture.md) | Solver-neutral engine behind `SolverPort` | CAP-015..CAP-017, CAP-059 |
| [ADR-0007](decisions/ADR-0007-schedule-versioning.md) | Immutable versioned publication | CAP-014, CAP-018..CAP-020 |
| [ADR-0008](decisions/ADR-0008-realtime-picklist-transport.md) | Server-authoritative real-time | CAP-031..CAP-033 |
| [ADR-0009](decisions/ADR-0009-job-and-event-reliability.md) | Transactional outbox and job reliability | CAP-040 |
| [ADR-0010](decisions/ADR-0010-notification-architecture.md) | Four-concept notification separation | CAP-040..CAP-043, CAP-056 |
| [ADR-0011](decisions/ADR-0011-ingestion-privacy-boundary.md) | Platform-enforced positive allowlist | CAP-062 |
| [ADR-0012](decisions/ADR-0012-connector-architecture.md) | Canonical schema + adapters | CAP-055, CAP-061, CAP-063..CAP-065 |
| [ADR-0013](decisions/ADR-0013-audit-architecture.md) | Append-only audit by construction | CAP-027, CAP-051 |
| [ADR-0014](decisions/ADR-0014-file-and-report-storage.md) | Object storage with signed URLs | CAP-046..CAP-048 |
| [ADR-0015](decisions/ADR-0015-deployment-topology.md) | Deployment topology — **deliberately open** | CAP-051 |

---

## 3. What must happen before architecture can be considered settled

| Item | Status |
|---|---|
| Independent architecture review (Codex) | **Pending** |
| The 18 pending product decisions ratified | **Pending** |
| PO-DEC-10 register discrepancy resolved | **Pending** |
| Solver benchmarked against synthetic datasets | **Not started** |
| SBX-001, 002, 004, 011, 013, 014b, 022, 023, 028 executed (`G-ARCH`) | **Not started** |
| RPO / RTO targets set | **Open** |
| Cloud provider, region, and data residency decided | **Open** |
| Incident-response plan written | **Open** |

**No gate is passed. The architecture is proposed, not approved.**
