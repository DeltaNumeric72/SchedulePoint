# TEST-TRACEABILITY (live)

Strategy: [../15-testing-strategy.md](../15-testing-strategy.md). Baseline mapping: research report 22 (capability -> QA -> SBX) + SPEC harness IDs (T/P/V/R/M/N/F/X/U/AC/S-t series). This file accretes the evidence column as tests execute: capability -> harness/SBX run -> docs/evidence/ artifact.

Execution log (M0):
| Harness / gate | Task | Status | Evidence |
|---|---|---|---|
| SPEC-01 T-07..T-15 (+T-14b) + TDG-02/03 confirmation | OPUS-M0-001 | **PASSED 36/36** (re-run by orchestrator) | docs/evidence/EV-M0-SPA |
| CI gate battery + red-case proofs (SP-HR-1/2, axe, route-policy, boundaries) | OPUS-M0-002 | **PASSED 12/12 + 14/14 red (re-run by orchestrator)** | docs/evidence/EV-M0-SCAFFOLD |
| SP-5 solver boundary (determinism, cancel, kill, INFEASIBLE) + TDG-11(solver) | OPUS-M0-003 | **PASSED H-0..H-8 (re-run by orchestrator)** | docs/evidence/EV-M0-SPC |

All three M0 rows re-verified by independent rerun at the acceptance review 2026-08-02 ([../26-m0-acceptance-addendum.md](../26-m0-acceptance-addendum.md) §1): 36/36 · 12/12 + 14/14 · H-0..H-8 0 failed.

Execution log (M2 — authorized 2026-08-03; closed 2026-08-04):
| Harness / gate | Task | Status | Evidence |
|---|---|---|---|
| Catalogue battery: 9-table RLS sweeps + sweep-mutation red case (the reviewer's CAR-001-class mutation pinned) + monotonic pick positions + archive-not-delete + OCC version + I-13/axe/keyboard/320px UI evidence + 31-row field mapping | OPUS-M2-002 | **PASSED — re-run by orchestrator on the rebased branch (850 tests) and on main post-merge** | docs/evidence/EV-M2-CATALOGUE |
| Profiles battery: in-force boundary battery + loader/writer agreement (S-01 lesson as named test) + overlap rejection under concurrency + history immutability incl. owner + SENSITIVE-PII narrowing (mutation-tested) + round-trip incl. 422 retroactive refusal | OPUS-M2-003 | **PASSED — re-run by orchestrator (739 tests) and on main post-merge** | docs/evidence/EV-M2-PROFILES |
| Integration battery: shift_type_qualifications tenancy incl. cross-group FK proof + eligibility reads + sequence numeric-ordering regression (production verification.ts) + two-worktree simultaneous batteries (port derivation) + request-budget ledger green-before-red both directions | OPUS-M2-004 | **PASSED — re-run by orchestrator on the rebased branch (881 tests) and on main post-merge (63/63 gate)** | docs/evidence/EV-M2-INTEGRATION |

Execution log (M2-001 issuance rows):
| Harness / gate | Task | Status | Evidence |
|---|---|---|---|
| SBX-001 (role×route matrix, 104 cells, three outcome classes) / SBX-002 (12 of 15 SPEC-06 rows server-side in 15 cases + 39.3M-case domain companion) / SBX-004 (five-role sweep, 84 readings, 0 wrong-tenant rows, 12/12 tables non-vacuous, 24-attempt write arm w/ 4 reaching RLS, FAD-14 + breakglass exceptions pinned by exact pair) PASS all FALSIFIABLE · SBX-005 partial (executable sub-scenarios PASS; authn arms EVIDENCE_BLOCKED) · SBX-006 EVIDENCE_BLOCKED(authn) · MULTI double-provision determinism · fixture-regression 39/39 (FAD-15 gate) | OPUS-M2-001 | **PASSED as scoped — re-run by orchestrator on branch and on main post-merge (bc61ee7); G-ARCH NOT closed (needs SBX-011/013/014b/022/023/028)** | docs/evidence/EV-M2-SBX · EV-M2-NR13 |

Execution log (M1 — authorized 2026-08-02):
| Harness / gate | Task | Status | Evidence |
|---|---|---|---|
| SPEC-01 §7.1 T-01/01b/02(404)/02b/04/05/05b/06b-d (+T-03 two of five surfaces) + §7.2 T-07..T-15+T-14b vs production unit-of-work | OPUS-M1-001 | **PASSED — 272/272 total, 12/12 gates, 14/14 red, cycle clean (re-run by orchestrator at 3 rounds)** | docs/evidence/EV-M1-TENANCY |
| SPEC-06 §8 cross-product (39,285,000 cases, unsampled, 0 disagreements vs an independent oracle) + deny-path battery + residual gates 1/2/4/5 | OPUS-M1-002 | **PASSED** (re-run by orchestrator each round) | docs/evidence/EV-M1-AUTHZ |
| M1 kernel integrated: FAD-12 ordering end-to-end, worker on the real evaluator, audit emission, tenant-table registry over 0002+0003, C-2 standalone proof | OPUS-M1-004 | **PASSED — 551/551 tests, 12/12 gates, 14/14 red, cycle clean across 0001+0002+0003, chain 0/1/0, crash-restart 3/3 standalone** (all re-run serially by orchestrator) | docs/evidence/EV-M1-INTEGRATION |
| TDG-04 micro-spike (18/18, GO) + SPEC-11 X-01..X-03 + I-11 proof + outbox exactly-once + crash/restart chain | OPUS-M1-003 | **PASSED — 336/336 tests (64 audit), 12/12 gates, 14/14 red, cycle clean, chain verification 0/1/0 (re-run by orchestrator at every round)** | docs/evidence/EV-M1-AUDIT · spikes/sp-d-worker |
