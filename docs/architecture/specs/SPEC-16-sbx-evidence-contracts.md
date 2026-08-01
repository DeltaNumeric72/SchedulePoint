# SPEC-16 — SBX Evidence Contracts

**Status: `PROPOSED`.** Remediates **CAR-025** (Medium).
**Supersedes:** [16](../16-testing-and-environments.md) §§5–6.

> **What was wrong.** 39 test names existed with environments and gates, but several had **no reproducible fixture, no external dependency plan, no deterministic orchestration, no objective oracle, and no evidence owner**. Pass criteria such as "usable explanation" and "quality threshold" were subjective. Some tests that should run at the schema stage were scheduled behind late gates.

---

## 1. Contract fields

**Every SBX test declares all nine. A test missing any field is not runnable, and the validator says so.**

`owner` · `fixture provenance` · `deterministic setup` · `external dependency` · `fault controls` · **`objective oracle`** · `retained artifact` · `environment` · **`earliest execution point`**

---

## 2. Earliest execution point — the reordering

**The review's most actionable finding: some tests were scheduled far later than the moment they could first fail usefully.**

| Stage | Tests | Why here |
|---|---|---|
| **E0 · Schema / prototype** | **SBX-004** (+ [SPEC-01](SPEC-01-request-context-and-tenant-isolation.md) T-07..T-15), **SBX-018** (+ [SPEC-05](SPEC-05-schedule-version-identity-and-publication.md) V-01..V-16), **SBX-022** (+ [SPEC-02](SPEC-02-picklist-turn-transaction.md) P-01..P-15), SBX-013 | **These prove the database can express the invariants. Discovering at beta that exclusion scoping or turn CAS does not work is discovering it too late** |
| **E1 · Policy framework** | SBX-001, SBX-002, SBX-005 | The truth table is testable before any feature |
| **E2 · Domain features** | SBX-003, 006, 010–012, 014b, 014c, 015–017, 019, 020, 021, 023–027, 013b | Need the feature |
| **E3 · Providers selected** | SBX-030a, 030b, 031a, 031b, 031c | **Blocked on TDG-06, TDG-07, TDG-09, TDG-10** |
| **E4 · Platform provisioned** | SBX-030, 031, 035 | **Blocked on TDG-11 and OI-1/OI-2** |
| **E5 · Vendor specification** | SBX-028, 029 | **Blocked on external specifications not in hand** |
| **E6 · UI foundations** | SBX-032, 033, 034 | Need components; **manual evidence required** |

---

## 3. Objective oracles for previously subjective criteria

| Was | Now |
|---|---|
| "Usable explanation" | **`B-infeasible-*` fixtures are generated *from* a known cause.** The oracle is: does the explanation name that cause, and within the tier budget? States: `EXPLAINED_EXACT` / `_SUBSET` / `_MINIMAL` / `BUDGET_EXCEEDED` / `UNAVAILABLE` ([SPEC-04](SPEC-04-solver-runtime-and-rule-model.md) §5) |
| "Quality threshold" | **`hard_violations = 0` is absolute.** Every other metric is a **band calibrated from the benchmark corpus**, which does not exist yet. **Until it does, those bands are undefined and no threshold is claimed** ([SPEC-04](SPEC-04-solver-runtime-and-rule-model.md) §7) |
| "Zero patient content persists" | **Canary search across 16 enumerated surfaces.** One occurrence is a hard failure ([SPEC-03](SPEC-03-raw-ingress-trust-boundary.md) §7.2) |
| "Correct concurrency behaviour" | **Exactly one accepted outcome over ≥50 trials**, asserted per race class ([SPEC-02](SPEC-02-picklist-turn-transaction.md) §10) |
| "Accessible" | **The [SPEC-14](SPEC-14-accessibility-acceptance-matrix.md) matrix**, cell by cell, with retained manual sessions |

---

## 4. Deterministic orchestration

| Requirement | Design |
|---|---|
| **Multi-session picklist (LIVE-SIM)** | A harness driving **N authenticated WebSocket clients** from one process with a **controllable virtual clock**, scripted send ordering, injectable delay, and forced disconnection. **Wall-clock racing is not evidence** — it is unrepeatable |
| **Clock control** | The server's turn clock is injectable in non-production builds; the injection point is **compiled out of production images** and a test asserts that |
| **Race precision** | Clients block on a barrier, then release together |
| **Repetition** | ≥50 trials per race class, with a fixed seed sequence so a failure is reproducible |
| **Fault injection** | Connection reset, delay, reorder, duplicate, process kill, database failover — all scripted |

---

## 5. Fixture provenance

| Fixture | Provenance |
|---|---|
| Solver corpus (`B-*`) | **Generator + seed + manifest, checked in.** Never extracted data |
| **De-identification canaries** | **Wholly fabricated**, unique per field/position/encoding |
| Notification endpoints | Catch-all mailbox, programmable virtual numbers, recording voice endpoint, sandbox push project. **A test whose destination cannot be proven controlled does not run** |
| Connector payloads | **Fabricated to the vendor specification once obtained.** No real payload, ever |
| Accessibility fixtures | Every form in an invalid state; a live timed turn |
| Multi-tenant fixture | ≥2 organizations, ≥2 groups each, **one user with different roles per membership** |
| Identifier-shape scan | **CI scans fixtures for anything resembling a real identifier** |

---

## 6. Blocking evidence dependencies — named, not absorbed

| # | Dependency | Blocks | Owner |
|---|---|---|---|
| **EV-1** | Vendor payload specifications (ORSOS, Cerner/Surginet, Meditech) | SBX-028, SBX-029; **`G-CONN`** | Product owner + hospital IT |
| **EV-2** | **Restorable backup access** for canary scan surface S-10 | SBX-029, SBX-035; `G-CONN`, `G-PROD` | Platform (after TDG-11) |
| **EV-3** | **Error-reporting vendor API** for surface S-7 | SBX-029 | After TDG-12 |
| **EV-4** | Provider sandboxes with **fault injection** | SBX-030a, SBX-030b | After TDG-06 |
| **EV-5** | **RPO/RTO targets** | SBX-035 acceptance | Product owner (OI-1, OI-2) |
| **EV-6** | Provisioned platform with failover | SBX-030, SBX-031, SBX-035 | After TDG-11 |
| **EV-7** | Benchmark acceptance bands | SBX-031 acceptance | After the corpus runs; **PO-DEC-23** |
| **EV-8** | Assistive-technology lab (real devices) | SBX-032–034 | Product owner |

**Each keeps its gate explicitly blocked. None is worked around with a mock that would prove nothing.**

---

## 7. Meta-test

**A test of the test plan.** It provisions every fixture from a clean environment and produces each declared artifact **without hidden credentials or manual vendor assumptions**. A test whose fixture cannot be provisioned is reported as **`EVIDENCE_BLOCKED`** with its EV reference — **not** as a pass, and **not** silently skipped.

---

## 8. Traceability

**All 39 SBX IDs retain their identifiers. Test count is unchanged.**
**Capabilities:** all 58, through their evidence mappings.
**Gates:** `G-ARCH`, `G-BETA`, `G-CONN`, `G-PROD`. **None passed. No test has been executed.**
