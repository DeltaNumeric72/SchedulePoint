# EV-M0-SPA — OPUS-M0-001 tenant-isolation spike evidence
Date: 2026-08-01 · Env: local (FAD-7: embedded-postgres 17.10 user-space) · Task: OPUS-M0-001 (M0/SP-A)
Artifacts: harness-output.txt (36/36, SPEC-01 T-07..15 + T-14b + A/B/X series, full verbatim capture) · migrate-cycle-output.txt (typecheck + up/down/up) · authoritative narrative: spikes/sp-a-isolation/SPIKE-REPORT.md
Verdicts: TDG-02 CONFIRM · TDG-03 CONFIRM (in-process pool; external pooler unproven — CI follow-up) · 3 conditions in SPIKE-REPORT §7
Reviews: Fable re-run + diff review; independent second review (Opus) APPROVE WITH FOLLOW-UPS — blocking findings fixed, re-verified.

**Qualification (added 2026-08-02, OPUS-M1-001 sharp edge 1):** `embedded-postgres` installs an exit hook that discards `process.exitCode`, so *for processes that import it* the property "the test command exits non-zero on failure" was not established when this spike ran. The per-test log (36/36, re-verified twice by orchestrator rerun, including at the M0 acceptance review) is unaffected — every individual assertion is captured verbatim — but exit-code-based automation over the spike's `npm test` should not be trusted without the child-process confinement OPUS-M1-001 introduced for production code.
