# 25 — Milestone M0 Exit Report

**Date:** 2026-08-01. **Authorization executed:** "Begin Milestone M0 only" against frozen plan `2b64a7b`. **Orchestrator:** Fable. **Status: M0 tasks 3/3 ACCEPTED. M1 NOT authorized — awaiting the owner.**

---

## 1. Task outcomes

| Task | Outcome | Merged as | Evidence |
|---|---|---|---|
| **OPUS-M0-001** tenant-isolation unit-of-work spike | **ACCEPTED.** 36/36 harness tests (SPEC-01 T-07..T-15 + added T-14b); migrations reversible; SP-2 constraint forms all expressible; zero cross-tenant rows in a 1,000-unit-of-work two-org storm probing all 8 tenant tables | `ea77ac5` | [EV-M0-SPA](../evidence/EV-M0-SPA/INDEX.md) |
| **OPUS-M0-002** scaffold + CI gate battery | **ACCEPTED.** 12/12 gates green, **14/14 red-case proofs** (every gate demonstrably fails on violation); 103 unit + 6 Playwright tests; fresh-clone reproduction; CLAUDE.md/AGENTS.md installed with the thirteen non-bypass rules | `2880bd2` | [EV-M0-SCAFFOLD](../evidence/EV-M0-SCAFFOLD/INDEX.md) |
| **OPUS-M0-003** solver boundary spike | **ACCEPTED, with a plan-contradicting finding handled per protocol** (§6). H-0..H-8 executed; INFEASIBLE proven with a one-rule control instance; SIGKILL clean in 8.8 ms; assumption-based minimal cores work | `8dad022` | [EV-M0-SPC](../evidence/EV-M0-SPC/INDEX.md) |

**Interruption recovery:** the prior session died (session limit) mid-001-revision. Recovery per the owner's protocol: read-only inspection found the revision complete-but-uncommitted; independently re-verified (not trusted from claims); committed `739ee0d`; nothing restarted, nothing lost.

## 2. Branches, worktrees, commits, agents

- **Commits on main (chronological):** `c102384` preflight (FAD-7/8) · `d561dff` validator fix · `ea77ac5` 001 accepted · `bdaea87` 001 records + SPEC-01 §4 amendment (FAD-9) · `2880bd2` 002 accepted · `fe24d3d` 002 records · `8dad022` 003 accepted + reproducibility amendments (FAD-10) · `f7764c4` 003 records · this report's commit (final).
- **Branches/worktrees:** `opus/m0-001-isolation-spike`, `opus/m0-002-scaffold`, `opus/m0-003-solver-spike` in `.worktrees/` — all squash-merged, then worktrees removed and branches deleted (content preserved on main).
- **Opus agents:** three implementers (one per packet; 001's also performed its own revision round) + one independent second reviewer (001, critical class). All quality gates in [24-execution-standards.md](24-execution-standards.md) §F applied to every task; every command re-run by the orchestrator before acceptance.

## 3. Tests and proof harnesses run

SPEC-01 §7.2 **T-07..T-15 + T-14b** (36 tests incl. role matrix A-01..A-08, SP-2 B-01..B-05, X-01..X-11) · CI battery **12 gates** + **14 red-case proofs** · 103 unit tests, 6 Playwright (desktop+mobile, axe) · solver **H-0..H-8** incl. 5-run determinism batteries across five configurations, kill/cancel/deadline, assumption-core probe. **Not yet run:** SPEC-01 §7.1 T-01..T-06 (context tuple — needs M1's middleware); SPEC-02/05/06/07/08/09 harnesses (their subjects don't exist yet); all 39 SBX tests; external-pooler variant of T-14; solver harness under Python 3.12; any remote CI execution.

## 4. Independent-review findings

001 (mandatory second review, unit-of-work/RLS class): **APPROVE WITH FOLLOW-UPS** — 12 findings, 3 merge-blocking (lint regex missing `SET LOCAL`; report figures not matching committed evidence; one unevidenced SQLSTATE claim); all fixed by the implementer and re-verified by the orchestrator; 6 further requested improvements also implemented (all-8-table storm coverage, ROLLBACK-leg measurement, partial-context-loss test, existence-oracle test, pinned error predicates, EX-2 comment honesty). 002/003: not in the mandatory-second-review class; orchestrator gate only.

## 5. Technology decisions confirmed / changed

| Gate | Verdict |
|---|---|
| **TDG-02** Kysely + pg | **CONFIRMED** (EV-M0-SPA) — with three adopted conditions now normative in SPEC-01 §4 (FAD-9) |
| **TDG-03** pooling | **CONFIRMED for in-process `pg.Pool`**; statement pooling re-proven broken; **external pooler explicitly unproven** — CI follow-up required before any external pooler is deployed |
| **TDG-01** Fastify · **TDG-14** React/Radix/Tailwind/TanStack + zod | **CONFIRMED by scaffold wiring** (route enumeration feeds the policy gate; axe green both viewports; typed contract path proven). Streaming not yet exercised — noted, not gating |
| **TDG-11** solver runtime (Python+CP-SAT worker) | **CONFIRMED**; container packaging + Python 3.12 re-run are CI conditions for E0 closure (no Docker on this machine, FAD-7) |
| **TDG-04** graphile-worker | **Selected, UNCONFIRMED** — not in the three authorized packets; its confirmation micro-spike is the first step of proposed OPUS-M1-003 (§9) |
| **Rejected/changed** | **The seed+worker-count reproducibility clause is withdrawn** (§6). No technology was rejected outright; signals-based solver cancellation is prohibited (measured 28 s latency + misreported outcome) |

## 6. The spike-contradiction (H-6) — protocol executed

**Assumption invalidated:** SPEC-04/doc-02 held that reproducible builds need solver version + seed + fixed worker count. **Measured:** 5 distinct schedules in 5 runs at fixed seed and 8 workers; wall-clock deadlines add machine-dependence. **Alternatives evaluated:** deterministic portfolio (`interleave_search`) + `max_deterministic_time` + full-parameter pinning (chosen — measured to give 1-in-5-distinct, i.e. reproduction; cost instance-dependent, ~12× slower on a toy, *faster* on the hard instance); single worker (rejected as default — no parallel speedup); abandoning byte-reproducibility (rejected — report 21 §7 keeps it absolute). **Documents updated:** SPEC-04 (dated amendment), doc 02 §4.1, plan doc 12; **ADR record:** FAD-10. **Downstream packets updated:** E1/E2 content in doc 12; M1 packets unaffected (no solver work in M1). **Validators re-run:** green. **Evidence preserved:** EV-M0-SPC. Related adopted findings: T1 explanations = separate budgeted failable assumption-solve (3-literal minimal core proven; blanket reification measured 18.6 ms → 90 s UNKNOWN); watcher-thread cancellation (17 ms) over callbacks (113 ms); serialization negligible (0.3 ms) vs process overhead (759 ms, mostly `import ortools`).

## 7. Tenant isolation / pooling / CI / solver results (headline numbers)

- **Isolation:** zero wrong-tenant rows anywhere across 1,000 units of work / 6,256 server transactions / 13,408 tenant-table operations / 252 injected faults; continuous 8-table probe inside and outside the wrapper (5,704 + 5,704 reads); final census 30 partitions, all legitimate. Fail-closed proven for app and worker roles; FORCE RLS binds even the table owner; read-back abort/poison/page proven for total and partial context loss.
- **Pooling/transaction context:** transaction affinity proven (single pid + single xact id per unit of work); statement-pooling counter-demonstration shows fail-closed-but-broken (0 rows); **discovered and fixed at spec level: reused pooled connections read `''` not `NULL`** — naive predicate raises 22P02; `nullif` spelling now normative (FAD-9). FK checks and PK/unique checks bypass RLS — composite tenant FKs and tenant-qualified unique keys now normative.
- **CI gates:** 12/12 green on main after all merges (re-run post-merge); every gate has a proven red case; SP-HR-1 network guard covers source and built bundle; request-budget gate enforces SP-HR-2 with over-budget and missing-recording both red-proven.
- **Solver:** OPTIMAL with independently re-validated zero hard violations; INFEASIBLE in 1.2 ms with a control instance proving cause; deadline overshoot 18 ms; cooperative cancel 17–113 ms; SIGKILL reaped 8.8 ms, zero orphans/temp files; determinism per §6.

## 8. Risks closed / new / assumptions remaining

**Closed or reduced:** NR-9 (technology-selection risk) largely retired — five of six M0-scoped gates confirmed; RISK-11 mitigation now has executed evidence at the mechanism level; RISK-29's boundary cost measured (cheap). **New:** NR-12 — deterministic-portfolio cost at production scale unknown (retired by E1 corpus measurement); the four FAD-7 container-packaging gaps (image build, 3.12 re-run, external pooler, remote CI) are named CI conditions. **Provisional assumptions remaining:** unchanged from [22](22-readiness-assessment.md) §4 minus the confirmed TDG rows; FA-3 now mostly discharged.

## 9. M0 exit criteria — verdict

Roadmap M0 exit: *"TDG-01/02/03/04/11/14 selections confirmed by spike evidence; CI green including SP-HR-1/2 guards; ADR for each confirmed gate."* **Result: PASSED WITH TWO CARRIED ITEMS.** Confirmed: TDG-01/02/03(scoped)/11(scoped)/14, CI green with guards, FAD-9/10 recorded. **Carried (were not in the three authorized packets):** (1) **TDG-04 confirmation** — micro-spike folded into proposed OPUS-M1-003; (2) **SP-E UX brief + design tokens** — orchestrator-authored planning work, first M1-entry deliverable. Neither blocks the M1 packets below; both are named so nothing silently disappears.

## 10. Recommendation and the first three M1 packets

**M1 is recommended.** The kernel milestone's substrate is proven: isolation mechanism (spike), delivery machine (scaffold+gates), and the runbook discipline all held under real use — including one interruption recovery, one adversarial second review, and one plan-contradicting measurement, each handled by the written process.

Proposed packets (full packets to be issued in runbook format on authorization; scopes are disjoint where parallel):

- **OPUS-M1-001 — Tenancy schema + SPEC-01 context middleware end-to-end.** Organizations/groups/users/memberships migrations (with RLS-in-same-migration, composite tenant FKs, tenant-qualified unique keys per FAD-9); the context-tuple middleware (declared org/group, verification, `409 CONTEXT_STALE`/`404` discipline incl. org-scoped variant); production unit-of-work module in `packages/domain` implementing the spike's normative pattern; **SPEC-01 §7.1 T-01..T-06 harness** + MULTI fixtures. Exit: T-01..T-15 all green against production code.
- **OPUS-M1-002 — Authorization evaluator + roles/grants (SPEC-06).** Role/capability-grant schema (effective-dated, non-overlapping exclusion constraint); the pure evaluator with the fourteen-step truth table incl. org-scope branch; generated cross-product tests; route-policy gate wired to real policies; entitlement records + module gating (CAP-057). Critical class → independent second review mandatory. Exit: SPEC-06 §8 cross-product green on HTTP surface; deny-path tests for every grant.
- **OPUS-M1-003 — Audit chain + outbox/job runner.** graphile-worker integration **starting with the TDG-04 confirmation micro-spike** (transactional `add_job` inside the domain transaction, durable lease behaviour, crash-mid-job recovery); `audit_events` with hash chain + signed checkpoints (A1, SPEC-11); every mutation from M1-001/002 emitting audit events; SPEC-11 X-01..X-03 subset. Exit: chain verified across a crash/restart; TDG-04 confirmed or reopened.

(M1-001 blocks 002/003 on schema; 002 and 003 can then run in parallel worktrees with disjoint globs.)

## 11. Validators at close

Research: PASS · Architecture: **95/95** · Plan: **29/29** · CI on main: **12/12** (post-merge re-run). Two stale phase-boundary checks were rescoped with dated rationale (arch 32: installed root instructions must be generated-with-rules, not absent; plan 7b: PROJECT-STATUS must name the milestone-authorization boundary).

---

**Stopping here per the authorization. M1 begins only on your explicit instruction** — e.g.: *"Begin Milestone M1. Issue OPUS-M1-001/002/003 per the exit report; same rules."*
