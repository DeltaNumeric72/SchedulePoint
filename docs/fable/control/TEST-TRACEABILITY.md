# TEST-TRACEABILITY (live)

Strategy: [../15-testing-strategy.md](../15-testing-strategy.md). Baseline mapping: research report 22 (capability -> QA -> SBX) + SPEC harness IDs (T/P/V/R/M/N/F/X/U/AC/S-t series). This file accretes the evidence column as tests execute: capability -> harness/SBX run -> docs/evidence/ artifact.

Execution log (M0):
| Harness / gate | Task | Status | Evidence |
|---|---|---|---|
| SPEC-01 T-07..T-15 (+T-14b) + TDG-02/03 confirmation | OPUS-M0-001 | **PASSED 36/36** (re-run by orchestrator) | docs/evidence/EV-M0-SPA |
| CI gate battery + red-case proofs (SP-HR-1/2, axe, route-policy, boundaries) | OPUS-M0-002 | **PASSED 12/12 + 14/14 red (re-run by orchestrator)** | docs/evidence/EV-M0-SCAFFOLD |
| SP-5 solver boundary (determinism, cancel, kill, INFEASIBLE) + TDG-11(solver) | OPUS-M0-003 | **PASSED H-0..H-8 (re-run by orchestrator)** | docs/evidence/EV-M0-SPC |

All three M0 rows re-verified by independent rerun at the acceptance review 2026-08-02 ([../26-m0-acceptance-addendum.md](../26-m0-acceptance-addendum.md) §1): 36/36 · 12/12 + 14/14 · H-0..H-8 0 failed.
