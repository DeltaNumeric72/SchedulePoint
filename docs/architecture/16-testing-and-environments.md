# 16 — Testing and Environments

**Status: `PROPOSED`.** Translates the 39 sandbox tests and seven environments from [18](../../schedulepoint-research/reports/18-targeted-sandbox-test-plan.md) and [23](../../schedulepoint-research/reports/23-pre-architecture-evidence-plan.md) into the architecture.

> **REVISED 2026-08-01 (CAR-022, CAR-025).** Every SBX test now carries a **nine-field evidence contract** — owner, fixture provenance, deterministic setup, external dependency, fault controls, **objective oracle**, retained artifact, environment, and **earliest execution point** ([SPEC-16](specs/SPEC-16-sbx-evidence-contracts.md)). Subjective criteria are replaced by oracles; **tenant-isolation, publication, and picklist harnesses move to the schema/prototype stage**; and eight blocking evidence dependencies are named rather than mocked. Accessibility gains a component acceptance matrix ([SPEC-14](specs/SPEC-14-accessibility-acceptance-matrix.md)).

> **No test in this document has been executed.** Defining a test is not evidence.

---

## 1. Absolute constraints

1. **Synthetic data only.** No real patient data, no real staff data, no real customer organization name enters any environment — including screenshots and logs.
2. **No test runs against a live production organization of any source system.**
3. **No real person receives a test notification.** All destinations are controlled endpoints.
4. **Every test is reversible or its environment is disposable.**

---

## 2. Test levels

| Level | Scope | Runs in |
|---|---|---|
| **Unit** | Pure functions, calculators, validators | CI, every commit |
| **Domain** | Aggregate invariants and state machines, no I/O | CI, every commit |
| **Property-based** | Invariants over generated inputs — **overlap detection, fairness normalisation, escalation-window selection** | CI |
| **Solver** | Constraint translation, result interpretation, **reproducibility**, infeasibility explanation | CI (small) + PERF (full) |
| **Authorization** | **Capability-difference pairs; role × route matrix** | CI — **a capability without a pair fails the build** |
| **Tenant isolation** | Cross-org and cross-group denial for every resource type | CI + MULTI |
| **Database invariant** | Exclusion constraints, unique indexes, RLS default-deny | CI against a real PostgreSQL |
| **Integration** | Module boundaries, transactions, outbox | CI |
| **Contract** | Provider ports, connector canonical schema, real-time message contracts | CI |
| **Notification** | Delivery, retry, dedup, `no-destination`, opt-out | CI (fakes) + LIVE-SIM (controlled endpoints) |
| **Real-time concurrency** | Simultaneous selection, reconnection, stale state | CONC + LIVE-SIM |
| **Playwright (E2E)** | Critical journeys end to end | CI + staging |
| **Accessibility** | axe-core automated + manual screen-reader passes | CI + A11Y |
| **Visual regression** | Schedule grid, picklist, calendar surfaces | CI |
| **Performance** | Solver benchmarks, request budgets, grid at scale | PERF |
| **Security** | Authorization sweep, XSS, CSRF, header and cookie assertions | CI + pre-release pen test |
| **Recovery** | Point-in-time restore, migration rollback, audit integrity | DR |
| **Connector certification** | Import validation + **de-identification** | INTEG |

### 2.1 Tests that enforce architectural invariants

These fail the build rather than producing a report:

| Check | Enforces |
|---|---|
| Route-declaration completeness | I-02 — an undeclared route fails the build |
| **Capability-difference pair per capability** | **A-3 — a flag with no observable capability difference cannot ship** |
| Migration ⇄ RLS policy pairing | D-10 |
| Module import boundaries | [04](04-domain-boundaries.md) §5 |
| **No domain module imports the solver** | ADR-0006 replacement boundary |
| **No new outbound third-party host** | SP-HR-1 / T-23 |
| Request-per-interaction budget | SP-HR-2 |
| axe-core on every component and journey | SP-HR-3..6 |

---

## 3. Environments

| Env | Provides | Hosts |
|---|---|---|
| **Local** | Containerised PostgreSQL + object storage, seeded synthetic data | Unit, domain, integration |
| **CI** | Ephemeral, per-pipeline | All automated gates |
| **Shared development** | Long-lived integration target | Manual exploration |
| **MULTI** | ≥2 organizations, ≥2 groups each, **one user with different roles per membership** | SBX-001..005 |
| **CONC** | ≥3 concurrent authenticated sessions, orchestrated timing | SBX-013, 014b, 018, 022 |
| **LIVE-SIM** | Simulated live picklist: **controllable clock, injectable network faults, scriptable advancement** | SBX-020..027, 030a/b |
| **PERF** | Load harness, large synthetic tenant, instrumented telemetry | SBX-030, 031 |
| **A11Y** | Screen readers, forced-colors, 400% zoom, real devices | SBX-032, 033, 034 |
| **DR** | Restore and migration rehearsal | SBX-035 |
| **INTEG** | Mock surgical-booking endpoint with fault injection | SBX-028, 029 |
| **Staging** | Production-like, synthetic data | Pre-release verification |
| **Production** | — | **No test executes here** |

---

## 4. Controlled notification endpoints

**Mandatory before any notification test runs.** Catch-all test mailbox with plus-addressing · programmable virtual SMS numbers · a voice endpoint that answers, records, and discards · push tokens on a dedicated sandbox project.

**If a test cannot prove its destination is controlled, the test does not run.**

---

## 5. Synthetic fixtures

| Fixture | Contents |
|---|---|
| Schedule | Small / medium / large / multi-site / large-rule-set / multi-stage ([21](../../schedulepoint-research/reports/21-automated-scheduling-production-requirements.md) §8.2) |
| Requests and vacation | All types; both vacation modes; quota boundary and over-quota |
| **Qualifications** | Valid, expiring, expired, revoked — plus **a future assignment against a credential that expires before it** |
| Picklist | All three modes; exclusions; a proxy grant |
| Integration | Valid, malformed, partially-invalid, duplicate, conflicting payloads |
| **De-identification** | **Fabricated** patient-shaped fields in **expected and unexpected positions**, plus free text with fabricated identifiers |
| Report | Datasets with known-correct statistics for assertion |
| Calendar | Issued, rotated, revoked tokens |
| Documents | Multiple categories, visibility levels, a superseded version, a purged document |
| Accessibility | Every form in an invalid state; a live timed picklist turn |

**How fixtures avoid real data:** generated from seeded synthetic generators with deterministic fake names and addresses; **no production extract is ever used**; the de-identification fixtures deliberately contain *fabricated* identifier-shaped values so SBX-029 can prove they are rejected. A CI check scans fixtures for patterns resembling real identifiers.

---

## 6. Sandbox-test mapping

All 39 tests retain their IDs. Grouped by what they gate:

| Gate | Tests |
|---|---|
| **Architecture** | SBX-001, 002, 004, 011, 013, 014b, 022, 023, 028 |
| **Beta** | SBX-003, 005, 006, 010, 012, 013b, 014c, 026, 030, 030b, 031a, 031b, 031c, 032, 034 |
| **Production** | SBX-015, 016, 017, 018, 019, 020, 021, 024, 025, 027, 030a, 031, 033, 035 |
| **Connector release** | SBX-028, 029 |

---

## 7. Capability and gate mapping

Testing strategy per capability: [18-capability-traceability.md](18-capability-traceability.md). **Gates:** [24](../../schedulepoint-research/reports/24-production-completeness-gates.md). **None passed.**
