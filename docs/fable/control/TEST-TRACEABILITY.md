# TEST-TRACEABILITY (live)

Strategy: [../15-testing-strategy.md](../15-testing-strategy.md). Baseline mapping: research report 22 (capability -> QA -> SBX) + SPEC harness IDs (T/P/V/R/M/N/F/X/U/AC/S-t series). This file accretes the evidence column as tests execute: capability -> harness/SBX run -> docs/evidence/ artifact.

Execution log (M0):
| Harness / gate | Task | Status | Evidence |
|---|---|---|---|
| SPEC-01 T-07..T-15 (+T-14b) + TDG-02/03 confirmation | OPUS-M0-001 | **PASSED 36/36** (re-run by orchestrator) | docs/evidence/EV-M0-SPA |
| CI gate battery + red-case proofs (SP-HR-1/2, axe, route-policy, boundaries) | OPUS-M0-002 | **PASSED 12/12 + 14/14 red (re-run by orchestrator)** | docs/evidence/EV-M0-SCAFFOLD |
| SP-5 solver boundary (determinism, cancel, kill, INFEASIBLE) + TDG-11(solver) | OPUS-M0-003 | **PASSED H-0..H-8 (re-run by orchestrator)** | docs/evidence/EV-M0-SPC |

All three M0 rows re-verified by independent rerun at the acceptance review 2026-08-02 ([../26-m0-acceptance-addendum.md](../26-m0-acceptance-addendum.md) §1): 36/36 · 12/12 + 14/14 · H-0..H-8 0 failed.

Execution log (M1 — authorized 2026-08-02):
| Harness / gate | Task | Status | Evidence |
|---|---|---|---|
| SPEC-01 §7.1 T-01/01b/02(404)/02b/04/05/05b/06b-d (+T-03 two of five surfaces) + §7.2 T-07..T-15+T-14b vs production unit-of-work | OPUS-M1-001 | **PASSED — 272/272 total, 12/12 gates, 14/14 red, cycle clean (re-run by orchestrator at 3 rounds)** | docs/evidence/EV-M1-TENANCY |
| SPEC-06 §8 cross-product + deny-path battery (incl. EV-M1-TENANCY residual gates 1/2/4) | OPUS-M1-002 | ISSUED 2026-08-02 — not yet run | (pending: docs/evidence/EV-M1-AUTHZ) |
| TDG-04 micro-spike + SPEC-11 X-01..X-03 subset + I-11 proof | OPUS-M1-003 | ISSUED 2026-08-02 — not yet run | (pending: docs/evidence/EV-M1-AUDIT) |
