# 26 — M0 Acceptance Addendum (independent verification of the exit report)

**Date:** 2026-08-02. **Purpose:** owner-directed final acceptance review of Milestone M0 — the claims in [25-m0-exit-report.md](25-m0-exit-report.md) verified against the repository, required acceptance checks **re-run** (not trusted from records), control documents audited, architecture consequences classified, and the M0 checkpoint frozen. **Verdict: the exit report's claims are VERIFIED. M0 exit criteria PASSED (with the two carried items already named in the exit report). M1 is recommended. M1 is NOT begun.**

One defect was found by this review and fixed before acceptance (§6): a false positive in the secret-scan gate's directory walk. No exit-report claim required correction.

---

## 1. What was independently re-run (2026-08-02, this machine)

| Check | Result today | Matches recorded claim? |
|---|---|---|
| Research validator (`schedulepoint-research/validate.sh`) | **PASS** | yes |
| Architecture validator (`docs/architecture/validate.py`) | **95/95** | yes |
| Plan validator (`docs/fable/validate.py`) | **29/29** before this addendum; **36/36** after (§7 — seven assertions added, none removed) | yes |
| CI gate battery (`corepack pnpm check`) | **12/12 PASS** (run twice: before and after the §6 fix) | yes |
| Red-case proofs (`corepack pnpm red-cases`) | **14/14 PROVEN** after the §6 fix (first run: 13/14 — the failure was the finding, see §6) | yes, after fix |
| SPEC-01 isolation harness (`spikes/sp-a-isolation`, fresh `npm ci`, embedded-postgres) | **36/36 PASS** | yes |
| Solver harness (`spikes/sp-c-solver`, fresh venv, pinned `ortools==9.15.6755`, full H-0..H-8) | **9 cases, 0 failed**; every load-bearing finding reproduced (below) | yes |

Not re-run (unchanged from the exit report's named gaps, all pre-existing CI conditions): solver harness under Python 3.12; container image builds (no Docker on this machine, FAD-7); external-pooler T-14 variant; any remote CI execution.

## 2. Per-task verification

### OPUS-M0-001 — tenant-isolation spike: **VERIFIED**
- Harness exists and passes **36/36 today** from a clean `npm ci` (T-07..T-15 + T-14b, A-01..A-08 role matrix, B-01..B-05 SP-2 constraints, X-01..X-11 sharp edges).
- Transaction-local context demonstrated (single pid + single xact per unit of work); **fail-closed outside the unit of work** re-proven (zero rows, writes rejected, for app and worker roles; FORCE RLS binds the owner).
- **Pool-reuse leak impossibility** re-proven, including the sharp edge that made FAD-9: a reused pooled backend reads `''` (not NULL) after commit/rollback; the naive `::uuid` cast raises 22P02; the normative `nullif` predicate returns zero rows. Reproduced verbatim in today's X-09 output.
- **Two-organization concurrency storm** re-run: 1,000 units of work, 252 injected faults, 6,256 server transactions, 13,408 tenant-table statements, 5,704 + 5,704 probe reads, 30 census partitions all legitimate, **0 wrong-tenant rows**. The exit report's headline figures match the committed evidence line-for-line ([EV-M0-SPA](../evidence/EV-M0-SPA/INDEX.md)).
- Kysely (TDG-02) and pooling (TDG-03 in-process) assumptions: **confirmed with conditions**, the conditions now normative in SPEC-01 §4 (FAD-9). Independent second review record present (APPROVE WITH FOLLOW-UPS; 3 blocking findings fixed and re-verified).

### OPUS-M0-002 — scaffold + CI gates: **VERIFIED**
- Scaffold exists; **12/12 gates green today**; **14/14 red-case proofs PROVEN today** (after §6).
- Lint, typecheck, unit (103/103), Playwright (6/6 incl. axe on two viewports), and production build all run inside `pnpm check` — re-run.
- **No production feature work**: the full source inventory is the health route (with explicit policy), the web shell, health contracts, the unit-of-work port, gate tooling, and tests. No domain logic, no product routes, no migrations. Confirmed by inspection.
- Root CLAUDE.md/AGENTS.md installed with the thirteen non-bypass rules (asserted by architecture-validator check 32, which passed).

### OPUS-M0-003 — solver boundary spike: **VERIFIED**
- The spike exists with a strict boundary (H-0 statically proves only `worker/cpsat_adapter.py` imports `ortools`; no DB/network client in the worker).
- **Determinism measured, and the plan-contradicting finding reproduces today**: fixed seed + 8 workers → 5 distinct schedules in 5 runs; `interleave_search=True` → 1 distinct in 5 (at 8 workers and at 1); wall-clock deadline → 5 distinct in 5; deterministic time limit → 1 in 5. FAD-10 stands on re-measured evidence.
- **Cancellation tested** (cooperative: solver returned 0.127 s after observing the request today) and **forced termination tested** (SIGKILL: died on signal 9, 0 survivors, 0 orphans, 0 temp files, clean re-solve after).
- **Reproduction information captured** (environment.txt, pinned requirements, full parameters in harness-results.json); **failure handling tested** (INFEASIBLE in ~1–2 ms with a one-rule control instance proving the cause; T1 assumption mechanism yields a minimal 3-literal core, while blanket reification reproduces its catastrophic cost — 0.0198 s INFEASIBLE → UNKNOWN at the timeout).
- Architecture assumptions confirmed/revised exactly as FAD-10 records.

## 3. Architecture-consequence classification (every M0-touched assumption)

| Assumption | Classification | Where recorded |
|---|---|---|
| Kysely + `pg` implement SPEC-01 isolation | **Confirmed with conditions** (nullif predicate, all-four read-back, SET-statement lint) | FAD-9; SPEC-01 §4 amendments |
| In-process `pg.Pool`, transaction affinity | **Confirmed** (statement pooling re-proven broken; **external pooler still provisional** — named CI condition) | FAD-9; SPIKE-REPORT §7 |
| PostgreSQL transaction handling (`set_config(...,true)`, read-back, fail-closed RLS) | **Confirmed** — plus two *revisions upward*: composite tenant FKs and tenant-qualified unique keys are now mandatory (FK/PK checks bypass RLS) | FAD-9; SPEC-01 §4 |
| Row-level security as the isolation mechanism | **Confirmed** (FORCE binds owner; five roles distinct) | EV-M0-SPA |
| Unit-of-work enforcement as the sole tenant-data path | **Confirmed** (harness + lint + red cases) | EV-M0-SPA; scaffold gates |
| CI design (12 build-failing gates, red-case-proven) | **Confirmed** — one robustness fix at acceptance (§6); remote CI execution **still provisional** (CI condition) | EV-M0-SCAFFOLD; §6 |
| Node→Python solver protocol (JSON over subprocess, one solve per process) | **Confirmed** (serialization 0.3 ms vs process overhead ~0.76 s — batching guidance recorded) | EV-M0-SPC; SPEC-04 |
| Solver determinism via seed + fixed worker count | **Rejected and REVISED** → deterministic portfolio (`interleave_search`) + `max_deterministic_time` + full-parameter pinning; migration recorded with dated SPEC amendment | **FAD-10**; SPEC-04, docs 02/12 |
| Cancellation via signals | **Rejected** (28 s latency + misreported outcome in recorded evidence) → watcher-thread `StopSearch`; layered deadline→cooperative→SIGKILL **confirmed** | FAD-10; EV-M0-SPC |
| Process supervision / failure recovery (kill, reap, restart) | **Confirmed** (SIGKILL clean, re-solve clean, INFEASIBLE control) | EV-M0-SPC |
| Reproduction metadata fields (report 21 §7) | **Confirmed with revision** (parameter set expanded per FAD-10) | SPEC-04 amendment |
| graphile-worker (TDG-04) | **Still provisional** — selected, unconfirmed; micro-spike opens OPUS-M1-003 | [27-m1-task-packets.md](27-m1-task-packets.md) |
| Solver runtime image (Python 3.12 container) | **Confirmed with conditions** (measured on 3.9; image build + 3.12 re-run are CI conditions for E0 closure) | FAD-10; FAD-7 |

Every revision above was already incorporated (SPEC amendments, FAD records, risk NR-12, roadmap E1/E2 notes, downstream packets) during M0 — this review found **no unincorporated consequence**.

## 4. Risks closed / opened; remaining provisional assumptions

- **Closed/reduced (unchanged from exit report, re-confirmed):** NR-9 largely retired (five of six M0-scoped TDGs confirmed); RISK-11 mitigation evidenced at mechanism level; RISK-29 boundary cost measured.
- **Opened during M0 (re-confirmed):** NR-12 (deterministic-portfolio cost at production scale — retired by E1 corpus measurement).
- **Opened and closed by this review:** the §6 secret-scan false positive (fixed same day; no register entry warranted — it never reached a release path and the red-case battery now re-proves the gate).
- **Remaining provisional:** TDG-04 (graphile-worker); external pooler; solver image build + Python 3.12 re-run; first remote CI run; EV-1 vendor specifics (G-CONN only). All are named CI conditions or M1 packet content — none is silent.

## 5. Control-document audit

Reviewed all 13 control documents against repository state on 2026-08-02. The M0-close reconciliation (`dc9fd63`) was verified accurate; this review changed only what this review itself caused.

| Document | Reviewed | Updated | Change summary / reason no change required | Final commit |
|---|---|---|---|---|
| PROJECT-STATUS.md | yes | **yes** | Points the "final M0 checkpoint" at this acceptance addendum's commit (was: the reconciliation commit) | this checkpoint |
| CHANGELOG.md | yes | **yes** | Entry for the acceptance review, the §6 gate fix, and docs 26/27 | this checkpoint |
| TEST-TRACEABILITY.md | yes | **yes** | One line: M0 rows re-verified by independent rerun 2026-08-02 (rows themselves already accurate) | this checkpoint |
| ARCHITECTURE-DECISIONS.md | yes | no | FAD-1..10 current; §6 is a gate-robustness fix, not an architecture decision | `f7764c4` |
| PRODUCT-DECISIONS.md | yes | no | No product decision changed in M0 or by this review | `2b64a7b` |
| RISK-REGISTER.md | yes | no | Reconciled at `dc9fd63`; verified accurate; §6 finding needs no register entry (fixed same day, gate re-proven) | `dc9fd63` |
| IMPLEMENTATION-ROADMAP.md | yes | no | Already shows M0 complete + carried items + M1 not authorized | `0e4b816` |
| EVIDENCE-INDEX.md | yes | no | Three EV-M0-* rows accurate; reruns confirmed the recorded grades ("re-run by orchestrator" now true twice over) | `dc9fd63` |
| ASSUMPTIONS.md | yes | no | FA-3 residuals as recorded; §3 classification introduces no new assumption | `dc9fd63` |
| OPUS-AGENT-RUNBOOK.md (task log) | yes | no | All three tasks ACCEPTED with review records; no new task executed | `f7764c4` |
| OPEN-QUESTIONS.md | yes | no | Q-6/7/8 unchanged by M0 | `2b64a7b` |
| ORCHESTRATION.md | yes | no | Model unchanged | `adcfdbb` |
| FEATURE-PARITY-MATRIX.md | yes | no | All 58 rows correctly `not-started` — M0 delivered spikes and scaffold, not capabilities | `adcfdbb` |

## 6. Correction made at acceptance (the one finding)

Re-running the red-case battery in a realistically dirty working copy (spike venv freshly recreated per the spike README) produced **secret-scan: GREEN=FAIL, NOT PROVEN** — the gate flagged `spikes/sp-c-solver/.venv/.../pandas/tests/io/test_sql.py` (a third-party test fixture inside the ortools dependency tree). Root cause: the shared directory-walk skip list covered `node_modules` but not Python virtualenvs, so any developer who follows the spike README gets a false-positive red gate on a clean tree. **Fix:** `.venv`/`venv` added to `ALWAYS_SKIP` in `scripts/gates/lib/gate.mjs` — aligned with the existing `node_modules` exclusion and with `.gitignore`. This narrows nothing on tracked source; the red-case battery re-run **after** the fix proves the gate still fails on every planted violation (**14/14 PROVEN**), and `pnpm check` remains 12/12. No test, validator, or acceptance criterion was weakened. No other correction to the exit report or surrounding documents was needed.

## 7. Validator delta

Plan validator extended (checks 5d/5e, +7 assertions, none removed): the finalized M1 packet document must keep exactly three packets, carry the required fields, and remain marked **NOT ISSUED** until the owner authorizes M1 — guarding against silent issuance or scope drift. Plan validator now **36/36**.

## 8. Verdict and conditions

- **Exit report verified; M0 exit criteria PASSED** (with the two carried items: TDG-04 → OPUS-M1-003 step 0; SP-E UX brief → first M1-entry deliverable).
- **M1 is recommended.** The three finalized packets, execution order, branch/worktree names, merge order, mandatory independent second reviews (all three packets are critical-class), the M1 entry gate, and the exact authorization prompt are in [27-m1-task-packets.md](27-m1-task-packets.md).
- **Conditions before M1:** none blocking. Standing named conditions (external re-review before beta; the four FAD-7 CI conditions) are unchanged and tracked.
- **M1 is NOT begun.** Packets are NOT issued.
