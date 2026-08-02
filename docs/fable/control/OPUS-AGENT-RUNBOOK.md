# OPUS-AGENT-RUNBOOK (pointer + task log)

Protocol: [../17-opus-agent-runbook.md](../17-opus-agent-runbook.md) + [../24-execution-standards.md](../24-execution-standards.md) §§E–F.

| Task | Slice | Status | Verdict |
|---|---|---|---|
| OPUS-M0-001 isolation spike | M0/SP-A | **ACCEPTED & MERGED 2026-08-01** (ea77ac5; evidence EV-M0-SPA). Session-limit interruption recovered: revision found complete-but-uncommitted, independently re-verified (36/36), committed. Second review: APPROVE WITH FOLLOW-UPS, blocking items fixed. Orchestrator applied one-line README count fix during recovery | **ACCEPTED** |
| OPUS-M0-002 scaffold + CI gates | M0/scaffold | **ACCEPTED & MERGED 2026-08-01** (12/12 gates + 14/14 red-cases re-run by orchestrator; evidence EV-M0-SCAFFOLD; 4 deviations accepted: bundle-text host allowlist w/ request-context voiding, hand-rolled secret scan, spike-local credential prefix, root nginx conf; orchestrator fixed one stale CLAUDE.md sentence, disclosed). Follow-ups recorded: prettier-as-gate decision deferred to M1; domain node-builtin rule stays strict until a recorded need | **ACCEPTED** |
| OPUS-M0-003 solver boundary spike | M0/SP-C | **ACCEPTED & MERGED 2026-08-01** (8dad022; evidence EV-M0-SPC; H-6 finding invalidated the seed+worker-count reproducibility clause — spike-contradiction protocol executed: SPEC-04/doc-02/doc-12 amended, FAD-10) | **ACCEPTED** |
| (internal) architecture verification review | planning | commissioned 2026-08-01 | see [../22-readiness-assessment.md](../22-readiness-assessment.md) |
| OPUS-M1-001 tenancy schema + SPEC-01 context middleware | M1/tenancy kernel | **ISSUED 2026-08-02** (M1 authorized against checkpoint b49d3dd; packet [../27-m1-task-packets.md](../27-m1-task-packets.md); worktree `.worktrees/opus-m1-001`, branch `opus/m1-001-tenancy-context`; independent second review mandatory) | pending |
| OPUS-M1-002 authorization evaluator (SPEC-06) | M1/authz kernel | NOT ISSUED — blocked on M1-001 acceptance | pending |
| OPUS-M1-003 audit chain + outbox (TDG-04 micro-spike first) | M1/audit+async kernel | NOT ISSUED — blocked on M1-001 acceptance; may run parallel with M1-002 (disjoint globs) | pending |
