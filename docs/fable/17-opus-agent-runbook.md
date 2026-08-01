# 17 — Opus Agent Runbook

**The Fable→Opus execution protocol.** Fable (this orchestrator) owns product, architecture, planning, delegation, review, and acceptance. Claude Opus sub-agents implement. This runbook is binding for every implementation task; it absorbs and supersedes `docs/architecture/drafts/` for delegation purposes (the installed CLAUDE.md/AGENTS.md are generated from it at M0).

---

## 1. Division of authority

**Opus sub-agents do:** production code, migrations, UI, APIs, scheduling-engine code, picklist code, tests, debugging, refactoring, performance fixes, build/deploy config, spikes, code-level security/accessibility fixes.

**Opus sub-agents never independently change:** product scope · architecture · domain terminology · state machines · business rules · milestone order · acceptance criteria. A sub-agent may **recommend** such a change; it takes effect only when I approve it and record it in [control/ARCHITECTURE-DECISIONS.md](control/ARCHITECTURE-DECISIONS.md) or [control/PRODUCT-DECISIONS.md](control/PRODUCT-DECISIONS.md). An unapproved deviation found in a diff is a rejection, however good the code.

**Thirteen non-bypass rules (from the linted drafts, binding):** never bypass the unit-of-work; never use session-scoped `SET` for tenant context; never disable/bypass RLS; never skip entitlement or capability checks; never mutate a published version; never write audit rows outside the chain; never treat manual scheduling as the production mechanism; never add free text to protected ingestion paths; never log delivery material or payload bodies; never weaken/skip accessibility or architecture tests; never expand capability scope; never implement a pending decision's non-default branch; never remove or renumber a stable ID.

## 2. Task packet (required for every delegation)

```markdown
# TASK: OPUS-<milestone>-<seq> — <name>
Milestone / Slice:      M<x> / <slice name>            (roadmap §3)
Objective:              <one sentence>
User outcome:           <observable behaviour when done>
Read first:             <exact docs/SPEC sections; capability IDs>
Allowed paths:          <globs the diff may touch>
Prohibited paths:       <globs it must not touch; research reports are ALWAYS prohibited>
Required behaviour:     <business rules, state transitions with guards, validation>
Authorization:          <layers/capabilities involved; deny cases to test>
Data:                   <tables/constraints; migration expand/contract notes; rollback path>
UI:                     <screens/states incl. loading/empty/error/permission-denied; a11y notes>
Audit:                  <events + payload fields>
Idempotency/concurrency:<command-id / constraint expectations>
Tests required:         <named harness IDs, QA case IDs, Playwright flows, deny-path tests>
Commands to run:        <lint/typecheck/test/build/harness commands>
Acceptance criteria:    <checkable list>
Deliverables:           <diff, migration, tests, doc updates, evidence artifacts>
Escalate if:            <conditions — see §7>
```

## 3. Sizing and model rules

One packet = one vertical slice or one coherent sub-slice; never bundle unrelated slices. Concurrency-critical, schema-critical, and security-critical packets (turn transaction, unit-of-work, publication triggers, evaluator) run on **Opus with high effort** and get an **independent Opus reviewer** (§6). Routine slices may use a single implementer. Spikes get throwaway branches and a written report; spike code never ships silently into production paths.

## 4. Required return report

Implementation summary · files changed · **architecture deviations (or "none")** · tests created · commands run **with actual output** · test results · browser verification (what was exercised, at which viewports) · security considerations · accessibility considerations · known limitations · unresolved questions · suggested follow-ups. A return without command output is treated as unverified.

## 5. Worktree and commit discipline

Each task runs in an isolated worktree/branch named `opus/<task-id>`. No direct commits to main; merge happens only after §6 acceptance. Commit messages reference the task ID and capability IDs.

## 6. Fable review protocol (every task, no exceptions)

1. **Re-run, don't trust:** execute the packet's commands myself (or via a verification agent); diff the claimed vs. actual outputs.
2. **Diff review** against allowed paths, the thirteen rules, and the packet's requirements; comment density/idiom match.
3. **Traceability:** every acceptance criterion maps to a visible change + a test; every new mutation has an audit event + a deny-path test.
4. **Checklist:** no weakened/skipped/deleted tests · no tenant check bypass · no client-only authorization · no unexplained schema change · no new outbound host · no new dependency without license note · migration has rollback path · request budget unchanged or justified.
5. **Browser check** for UI slices (desktop + mobile), including the error/empty/denied states.
6. **Verdict:** ACCEPT (merge + update [06](06-feature-parity-matrix.md)/control docs) · REVISE (same agent, itemised) · REJECT (re-plan) · **INDEPENDENT REVIEW** (fresh Opus reviewer with the packet + diff, for the critical classes in §3 — reviewer reports findings, implementer fixes, I re-review).

## 7. Escalation triggers (sub-agent must stop and report)

The packet's requirements conflict with a SPEC/invariant · a needed schema change isn't in the packet · a test can only pass by weakening it · an invariant blocks the natural implementation · a pending decision's default is insufficient · any security/privacy doubt · the task needs data or credentials it doesn't have · estimated diff exceeds the packet's scope. **Escalation is success behaviour** — a sub-agent is never penalised for stopping; it is rejected for improvising.

## 8. Failure and retry policy

REVISE at most twice with the same agent; then either re-plan the packet (my fault) or reassign fresh (context contamination). Debugging tasks get their own packets with reproduction steps as acceptance criteria. Never fabricate a pending result; never accept "it should work now" without re-run evidence.

## 9. The first packets

**The first three packets (OPUS-M0-001/002/003) are finalized in [23-opus-task-packets.md](23-opus-task-packets.md)** and approved for issuance ([21-decision-resolution.md](21-decision-resolution.md) FD-4); issuance awaits the owner's implementation-authorization prompt ([24-execution-standards.md](24-execution-standards.md) §G). Branch/worktree, merge, and per-task quality-gate specifics: [24-execution-standards.md](24-execution-standards.md) §§E–F, which are binding alongside this runbook.
