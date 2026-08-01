# 19 — Risks and Decisions

**Status: `PROPOSED`.**

> **REVISED 2026-08-01 (CAR-016 and the remediation as a whole).** **PO-DEC-10 is restored to the canonical register as `pending`** by product-owner decision, and this document **no longer assumes its recommendation**. Risks are re-scored where remediation changed them, and **RISK-27..RISK-30 are added** for risks the redesign itself introduces. Remediation status per finding: [remediation/codex-review-remediation.md](remediation/codex-review-remediation.md).

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
| **RISK-05** | **The picklist concurrency design fails under real contention** | low | **high** | **RE-SCOPED (CAR-003).** Three constraints now decide races — D-3a one result per turn, D-3b one claimant per item, D-3c one open turn — plus command idempotency, event sequencing, and coordinator fencing ([SPEC-02](specs/SPEC-02-picklist-turn-transaction.md)) | SBX-022 + P-01..P-15 |
| **RISK-06** | **Modular monolith boundaries erode into a distributed-monolith-in-one-process** | med | med | Enforced import boundaries in CI; explicit prohibited-dependency table ([04](04-domain-boundaries.md) §5) | CI boundary check |
| **RISK-07** | **Notification volume or provider limits throttle escalation when it matters most** | med | med | Bounded retry with jitter; dead-lettering; rate-limit awareness; **`no-destination` as an explicit outcome** | SBX-030a |
| **RISK-08** | **PostgreSQL-backed queue outgrows its design point** | low | med | Deliberate, reversible choice ([02](02-technology-stack.md) §4.2); broker introduced when depth metrics justify it | Queue-depth telemetry |
| **RISK-09** | **Schedule versioning storage grows without bound** | low | low | Time partitioning; artifact expiry; **history itself is never deleted** | Volume monitoring |

### 1.2 Privacy and security risks

| ID | Risk | L | I | Mitigation | Retired by |
|---|---|---|---|---|---|
| **RISK-10** | **Patient-identifying data enters the system via a connector, or via manual entry** | med | **high** | **REDESIGNED (CAR-004).** Raw-ingress enclave ahead of all observability and durable infrastructure; **constrained value schema with controlled vocabulary** — a key allowlist alone never validated content; **free text removed from protected work-item paths** ([SPEC-03](specs/SPEC-03-raw-ingress-trust-boundary.md)) | **SBX-029, redefined as a 16-surface canary sweep** |
| **RISK-11** | **Cross-tenant data exposure** | **med** *(raised — CAR-001/002 found two live paths)* | **high** | **REDESIGNED.** Request-scoped verified context with target-aggregate binding; **transaction-local** RLS with fail-closed behaviour outside the unit of work; normative truth table ([SPEC-01](specs/SPEC-01-request-context-and-tenant-isolation.md), [SPEC-06](specs/SPEC-06-authorization-truth-table.md)) | SBX-004 + T-01..T-15 |
| **RISK-12** | **A third-party identifier leak is reintroduced** — the failure the research observed directly | med | **high** | **CI guard failing the build on any new outbound host**; strict CSP | QA-SEC-001..003 |
| **RISK-13** | **Sensitive content reaches logs, errors, or traces** | med | **high** | Allowlist-based structured logging; scrubbing on by default; **payloads and message bodies never logged** | Log-review test |
| **RISK-14** | **A leaked calendar-feed or report URL exposes a schedule** | med | med | Hash-stored revocable tokens; short-lived signed URLs; **no PII in any URL** | SBX-031a, SBX-031c |
| **RISK-15** | **No incident-response plan exists** | **high** | **high** | **PARTIALLY ADDRESSED.** Structure, severity model, and **evidence preservation** are now specified ([SPEC-11](specs/SPEC-11-audit-assurance-and-security-boundaries.md) §8). **The playbooks, rotation, and breach-notification determination remain missing** | A written plan and a tabletop — **not by any test** |

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

### 1.4 Risks introduced by the remediation itself

**Stated openly, because a redesign that only lists the risks it removes is not a candid one.**

| ID | Risk | L | I | Mitigation | Retired by |
|---|---|---|---|---|---|
| **RISK-27** | **The managed database split-brains**, defeating coordinator fencing | low | **high** | Fencing is delegated to the managed provider's promotion logic; the application arbitrates through a row both coordinators read. **If the database itself forks, the guarantee fails** | Provider SLA review; failover drill |
| **RISK-28** | **Cloud-provider staff can reach audit storage** | low | **high** | A2 external write-once replication in a separate trust domain raises the bar. **A3 notarisation would be the only complete answer and is deliberately not claimed** | Owner decision on whether A3 is required |
| **RISK-29** | **A second language (Python) doubles part of the maintenance surface** | **high** | med | Separate image, SBOM, scan, and patch stream; the solver is confined behind a port. **Unavoidable: OR-Tools has no official Node.js binding (S-04)** | Accepted, not retired |
| **RISK-30** | **Removing free text from work items is operationally rejected by schedulers** | med | med | Controlled vocabulary with a fast administrative add path. **If it proves unworkable, the answer is a better vocabulary workflow — not restoring an unprovable privacy claim** | Customer validation |
| **RISK-31** | **The audit hash chain becomes a throughput bottleneck** on high-frequency picklist paths | med | med | Per-organization serialisation rather than global; measured before `G-BETA` | Chain-write benchmark |

### 1.5 Operational risks

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

> **AMENDED 2026-08-01 — all rows below are now RESOLVED under delegated authority.** The product owner granted the Fable orchestrator explicit authority to resolve all pending product decisions ("Expanded decision authority" mandate, 2026-08-01). Every decision below (plus PO-DEC-10 in §2.2a) was resolved — in each case to its recommended working default unless [docs/fable/21-decision-resolution.md](../fable/21-decision-resolution.md) states otherwise, which is the authoritative resolution record with per-decision rationale, reversibility, and follow-up verification. The table below is preserved unmodified as the historical register of the defaults and their blast radii.

**Historical text (Phase 14):** every row below remains `pending`. The recommended working default may be used for technical planning. None has been ratified, and the Phase-14 task did not approve any of them.

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

**Count: 18 in the table above, plus the restored `PO-DEC-10` in §2.2a = 19 pending decisions.** This matches [report 24](../../schedulepoint-research/reports/24-production-completeness-gates.md) §3 as amended on 2026-08-01. **No decision has been approved by this remediation.**

### 2.2a PO-DEC-10 — restored to the register as `pending` (CAR-016)

**Product-owner decision, 2026-08-01: restore `PO-DEC-10` to the canonical register with its original identifier and a status of `pending`.** [Report 24](../../schedulepoint-research/reports/24-production-completeness-gates.md) §3 now carries the row; **the historical ID is preserved and no ID has been renumbered or reused.**

| Field | Value |
|---|---|
| **ID** | `PO-DEC-10` — original identifier from [report 17](../../schedulepoint-research/reports/17-public-source-gap-addendum.md) §11 |
| **Subject** | Locum billing rule (public claim PUB-064: part-time locums free, full-time locums at the staff rate) |
| **Status** | **`pending`** |
| **Working default** | **Locum billing is *external commercial policy*.** SchedulePoint exposes a **versioned, read-only projection** of membership role and FTE and does nothing else with it |
| **Explicitly out of scope** | **No billing capability, no invoice calculation, no billing-eligibility gate.** Scheduling, opportunities, stipends, and entitlements **do not become an invoicing system** |
| **Not billing authority** | CAP-025 staff-over-locum priority is a **scheduling** rule. CAP-011 stipend amounts are **compensation configuration**. **Neither is a billing input, and neither may be treated as one** |
| **The projection boundary** | Read-only; effective-dated; versioned; consumed outside the product. A change of role or FTE is already audited, so a downstream commercial system can reconcile against a stable record |
| **If decided otherwise** | Making billing product scope requires a **new capability in [report 19](../../schedulepoint-research/reports/19-schedulepoint-production-capability-baseline.md)** — expanding the 58-capability baseline — with an owner, data model, effective-date rules, entitlement integration, audit, tests, and a production gate. **That is a baseline change, not an architecture change** |

**This document no longer adopts the report-17 recommendation as settled.** The working default is used for planning and is labelled pending, which is the distinction CAR-016 found missing.

**Pending count is now 19** — the 18 above plus the restored `PO-DEC-10`.

### 2.3 Architecture decisions (ADRs)

**All twenty-three are `PROPOSED`. None is accepted.** Eight were added by the remediation; fifteen were revised.

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
| [ADR-0015](decisions/ADR-0015-deployment-topology.md) | Deployment topology — **now decided; provider and residency remain owner input** | CAP-051 |
| **[ADR-0016](decisions/ADR-0016-request-aggregate-and-subtypes.md)** | Request aggregate and constrained subtypes *(provisional — PO-DEC-03 pending)* | CAP-021..CAP-023 |
| **[ADR-0017](decisions/ADR-0017-cross-module-unit-of-work.md)** | Cross-module unit of work; 25 → 19 modules | CAP-014, CAP-023, CAP-026, CAP-031, CAP-055 |
| **[ADR-0018](decisions/ADR-0018-report-snapshot-semantics.md)** | Report snapshot and artifact authorization | CAP-020, CAP-045..CAP-048 |
| **[ADR-0019](decisions/ADR-0019-audit-assurance-level.md)** | Audit assurance level A1 → A2; A3 not claimed | CAP-027, CAP-051 |
| **[ADR-0020](decisions/ADR-0020-solver-runtime-packaging.md)** | Python solver worker (S-04) | CAP-015..CAP-017, CAP-059 |
| **[ADR-0021](decisions/ADR-0021-raw-ingress-enclave.md)** | Raw-ingress enclave | CAP-055, CAP-062, CAP-068 |
| **[ADR-0022](decisions/ADR-0022-request-scoped-tenant-context.md)** | Request-scoped context; transaction-local RLS | CAP-001..CAP-003, CAP-006 |
| **[ADR-0023](decisions/ADR-0023-picklist-turn-transaction.md)** | Picklist turn transaction and coordinator fencing | CAP-030..CAP-034, CAP-060 |

---

## 3. What must happen before architecture can be considered settled

| Item | Status |
|---|---|
| Independent architecture review (Codex) | **Completed 2026-07-31 — verdict `REDESIGN REQUIRED`.** Remediated at Phase 14. **The verdict has not been upgraded** — its stated upgrade condition is a *new independent review*, which has not occurred *(clarified 2026-08-01, V-04)* |
| Independent verification of the remediation | **Internal adversarial verification completed 2026-08-01** ([docs/reviews/architecture/internal-verification-2026-08-01.md](../reviews/architecture/internal-verification-2026-08-01.md)), verdict `VERIFIED WITH CORRECTIONS NEEDED`; corrections applied and recorded in [remediation/internal-verification-corrections.md](remediation/internal-verification-corrections.md). **It is cited only for what it is: an internal verification, commissioned by the same orchestration that produced the remediation, which its own header states is not an independent review and not a substitute for one** |
| **External independent re-review** *(amended 2026-08-01, V-04)* | **REQUIRED and BLOCKING for controlled-beta entry (M10 exit).** The previous description of it as "an advisory gate before beta" is **withdrawn**: the Codex review's upgrade condition — that `REDESIGN REQUIRED` may be upgraded only after a new **independent** review finds no remaining severe isolation, privacy, concurrency, or irreversible-integrity path — is not the orchestrator's to waive, and the delegated decision authority does not extend to it. What the delegation changes is **sequencing only**: implementation may proceed toward beta entry on internal verification plus executable-harness evidence, at the owner's explicit direction. It does not change the gate |
| The **19** pending product decisions ratified | **Resolved 2026-08-01 under delegated authority** — see §2.2 amendment |
| PO-DEC-10 restored to the register as `pending` | **Done (2026-08-01)**; subsequently resolved to its working default under delegated authority |
| Solver benchmarked against synthetic datasets | **Not started** (M0 spike + M2 corpus + M4/M6 runs) |
| SBX-001, 002, 004, 011, 013, 014b, 022, 023, 028 executed (`G-ARCH`) | **Not started** (scheduled M0–M9) |
| RPO / RTO targets set | **Provisional defaults set 2026-08-01** (21-decision-resolution §5 OI-1/2) |
| Cloud provider, region, and data residency decided | **Provisional defaults set 2026-08-01** (21-decision-resolution §5 OI-3/4); binding procurement remains a reserved owner action |
| Incident-response plan written | **Open** (owned: roadmap M11) |

**No gate is passed. Evidence-based gates (spikes, harnesses, SBX) remain unpassed until their tests run.**

> **AMENDED 2026-08-01 (V-04)** — the closing line below was deleted in an earlier edit and replaced with a narrower statement about evidence-based gates only. It is **restored**, because it is the accurate summary of this section and its removal accompanied the same edit that downgraded the external re-review ([rationale](remediation/internal-verification-corrections.md) §0 V-04).

**No gate is passed. The architecture is proposed, not approved.**
