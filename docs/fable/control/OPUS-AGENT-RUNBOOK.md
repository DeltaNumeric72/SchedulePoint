# OPUS-AGENT-RUNBOOK (pointer + task log)

Protocol: [../17-opus-agent-runbook.md](../17-opus-agent-runbook.md) + [../24-execution-standards.md](../24-execution-standards.md) §§E–F.

| Task | Slice | Status | Verdict |
|---|---|---|---|
| OPUS-M0-001 isolation spike | M0/SP-A | **ACCEPTED & MERGED 2026-08-01** (ea77ac5; evidence EV-M0-SPA). Session-limit interruption recovered: revision found complete-but-uncommitted, independently re-verified (36/36), committed. Second review: APPROVE WITH FOLLOW-UPS, blocking items fixed. Orchestrator applied one-line README count fix during recovery | **ACCEPTED** |
| OPUS-M0-002 scaffold + CI gates | M0/scaffold | **ACCEPTED & MERGED 2026-08-01** (12/12 gates + 14/14 red-cases re-run by orchestrator; evidence EV-M0-SCAFFOLD; 4 deviations accepted: bundle-text host allowlist w/ request-context voiding, hand-rolled secret scan, spike-local credential prefix, root nginx conf; orchestrator fixed one stale CLAUDE.md sentence, disclosed). Follow-ups recorded: prettier-as-gate decision deferred to M1; domain node-builtin rule stays strict until a recorded need | **ACCEPTED** |
| OPUS-M0-003 solver boundary spike | M0/SP-C | **ISSUED 2026-08-01** (worktree opus/m0-003) | in progress |
| (internal) architecture verification review | planning | commissioned 2026-08-01 | see [../22-readiness-assessment.md](../22-readiness-assessment.md) |
