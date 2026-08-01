# EV-M0-SPC — OPUS-M0-003 solver boundary spike evidence
Date: 2026-08-01 · Task: OPUS-M0-003 (M0/SP-C, E0) · Env: local venv, CPython 3.9.6 + ortools 9.15.6755 (FAD-7; image authored not built; 3.12 re-run is a CI condition)
Artifacts: harness-output.txt (H-0..H-8) · harness-results.json · environment.txt · probe-assumptions-extended.txt · narrative: spikes/sp-c-solver/SPIKE-REPORT.md
Key results: OPTIMAL w/ 0 hard violations (independent re-validator); INFEASIBLE proven w/ control instance; SIGKILL clean in 8.8ms; **seed+worker-count NOT deterministic (5/5 distinct) — deterministic portfolio + deterministic time limits required (SPEC-04 amended)**; assumptions yield 3-literal minimal core; blanket reification rejected (90s UNKNOWN); signals prohibited for cancellation.
Reviews: Fable re-run (H-0/1/2/5/6 reproduced incl. nondeterminism). Verdict: TDG-11 solver runtime CONFIRMED; reproducibility clause corrected.
