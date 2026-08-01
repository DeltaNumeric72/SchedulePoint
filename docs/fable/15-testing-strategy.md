# 15 — Testing Strategy

**Principle: every architectural invariant has a failing-test path, every milestone exits on evidence, and a claim without a named artifact is not evidence.** Sources ratified: doc 16, SPEC-16 (evidence contracts), report 18 (39 SBX tests), report 11 (175 QA cases). This document defines the layers, the harnesses, the environments, and the CI gates the roadmap holds milestones to.

---

## 1. Test layers

| Layer | What it proves | Tooling / notes |
|---|---|---|
| Unit + domain | Pure domain logic; rule compiler; evaluator; state machines' guards | Fast, no I/O; property-based where inputs are combinatorial (rule ASTs, date/DST boundaries) |
| **Invariant harnesses** | The load-bearing properties, at the schema stage, before features | **SPEC-01 T-01..15** (context + isolation under pool abuse) · **SPEC-02 P-01..15** (turn atomicity, ≥50-trial races) · **SPEC-05 V-01..16** (publication immutability, version cloning) · SPEC-06 generated cross-product on six surfaces · SPEC-08 R-01..14 · SPEC-13 M-01..12 · SPEC-07 N-01..15 · SPEC-09 F-01..14 · SPEC-11 X-01..18 · SPEC-12 U-01..07 |
| Integration | Module ports, outbox, jobs, migrations (expand/contract), RLS pairing | Containerised PG + object store; synthetic data only, always |
| Contract | API typed contracts; provider ports against fault-injected fakes; solver RPC | Provider sandboxes real only where EV-4 lands |
| Browser (Playwright) | Vertical-slice user outcomes incl. loading/empty/error/permission-denied states | One flow per slice minimum; desktop + mobile viewports |
| Accessibility | SP-HR-3..6 | axe-core as a **build gate** + SPEC-14 component×property matrix; manual AT evidence retained for every claimed combination (8 combos; EV-8) |
| Concurrency | Races that unit tests cannot express | **Deterministic orchestration**: N clients, one process, virtual clock, barrier release (clock injection compiled out of production); wall-clock racing is not accepted as proof |
| Performance | SP-HR-2 budgets; solver corpus; grid virtualization (≥200×8wk); publication latency; chain-write throughput (RISK-31) | PERF env; bands defined from measured runs, then frozen |
| Security | CI guards + X-tests + pen test (M12) | See [14](14-security-and-privacy-plan.md) §5 |
| DR | Restore rehearsal + audit-integrity verification | SBX-035, provisioned platform (EV-5/6) |

## 2. The 39 SBX tests

Report 18 is ratified as the sandbox suite; SPEC-16's nine-field evidence contract applies to each execution (objective, environment, fixtures, exact sequence, expected evidence, success criteria, cleanup, gate, artifact). Subjective criteria stay replaced by oracles (known-by-construction `B-infeasible-*` fixtures; `hard_violations = 0`; 16-surface canary sweep; exactly-one-accepted-outcome over ≥50 trials). The **meta-test** provisions every fixture from clean state and reports `EVIDENCE_BLOCKED` rather than skipping — a blocked test is visible, never silently green. G-ARCH set (SBX-001, 002, 004, 011, 013, 014b, 022, 023, 028) is scheduled earliest compatible with its subject's existence; the prose count error in report 18 ("36") awaits your CAR-026 authorization.

## 3. Environments

| Env | Purpose | Exists by |
|---|---|---|
| Local | Containerised PG + object store, seeded synthetic data | M0 |
| CI | Full gate battery per commit | M0 |
| MULTI | ≥2 orgs, shared user with divergent roles — isolation/IDOR | M1 |
| CONC | Deterministic concurrency harness | M1 (isolation) / M9 (picklist scale-up) |
| LIVE-SIM | Simulated live picklist: virtual clock, scripted advancement, fault injection | M9 |
| PERF | Load/scale with telemetry | M6 |
| A11Y | AT lab: screen readers, forced-colors, zoom, devices | EV-8; first needed M6 |
| INTEG | Connector sandbox against canonical-schema fixtures | M11 |
| DR | Restore/failover rehearsal | M12 (needs EV-5/6) |
| **Never** | **No test ever runs against iSchedule.md or any production environment**; concurrency/security classes never against production even ours | standing |

## 4. CI gates (all build-failing, from M0)

lint · typecheck · unit/domain · migration+RLS-pairing check · route-without-policy check · **network-assertion guard (SP-HR-1)** · requests-per-interaction budget (SP-HR-2) · axe-core · invariant-ID uniqueness · import-boundary check (module layering) · W2-port cycle check · provider-call-inside-transaction lint · pending-decision guard (no non-default branch of a pending PO-DEC acquires tables/APIs) · docs validators (research + architecture, extended as [control/](control/) docs land) · production build.

## 5. Traceability and honesty rules

- **TEST-TRACEABILITY** ([control/TEST-TRACEABILITY.md](control/TEST-TRACEABILITY.md)) maps capability → QA cases → SBX tests → harness IDs → milestone → evidence artifact; updated at every milestone review; a capability with an empty evidence column cannot be `verified` in [06](06-feature-parity-matrix.md).
- Evidence artifacts live under `docs/evidence/` with stable IDs, dates, environment, and command records ([02](02-evidence-index.md) §3).
- **No weakened tests:** a sub-agent may not loosen an assertion, widen a tolerance, or skip a case to make a build green; any such change is an escalation ([17](17-opus-agent-runbook.md) §7).
- Flaky concurrency tests are defects in the deterministic harness, not candidates for retry-until-green.
- Coverage is proportional to risk, not uniform: turn transaction, isolation, publication, and vacation-commit paths get exhaustive treatment; CRUD admin screens get the standard slice battery.
