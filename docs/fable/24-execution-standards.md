# 24 — Execution Standards

**Outputs E (branch/worktree strategy), F (quality-gate strategy), and G (implementation authorization prompt).** Binding alongside [17-opus-agent-runbook.md](17-opus-agent-runbook.md); where they overlap, this document is the more specific and wins.

---

## E. Branch and worktree strategy

**Main branch policy.** `main` is always green and always releasable-as-documented: every commit on `main` passed the full CI gate battery and a Fable acceptance review. No direct commits — everything arrives by merge. Planning/docs commits by the orchestrator are the one exception (docs-only diffs, validators must pass).

**Milestone branches: none.** Milestones are tracked by tags, not long-lived branches — long-lived branches rot. When a milestone exits, `main` is tagged `milestone/M<x>`.

**Task branches/worktrees.** One per task packet: branch `opus/<task-id>` (e.g. `opus/m0-001-isolation-spike`), created from current `main`, worked in an isolated worktree. Sub-agents never share a worktree. Rebase on `main` before review if `main` moved.

**Naming.** Branches: `opus/<milestone>-<seq>-<slug>` · orchestrator docs: `fable/<slug>` (or direct docs-only commits) · spikes live under `spikes/` and are merged (they are evidence), never deleted.

**Commit requirements.** Reference the task ID and capability IDs in the message body; imperative subject; no WIP commits at merge time (squash if needed); every commit on `main` carries the Co-Authored-By trailer per repo convention; **no commit may weaken a validator, gate, or test in the same change that needs it to pass**.

**Review process.** Per runbook §6: Fable re-runs commands, reviews the diff against the packet, walks the checklist (§F below), and issues ACCEPT / REVISE / REJECT / INDEPENDENT-REVIEW. Critical-class tasks (turn transaction, unit-of-work, publication triggers, authorization evaluator, enclave) always get the independent Opus reviewer before merge.

**Merge requirements.** CI green · Fable acceptance recorded in [control/OPUS-AGENT-RUNBOOK.md](control/OPUS-AGENT-RUNBOOK.md) task log · evidence artifacts filed · parity-matrix/control docs updated in the same merge or an immediately following docs commit · fast-forward or squash-merge onto `main`.

**Failed experiments.** A spike that disproves its hypothesis is a **success**: its report and captured output merge under `spikes/`, the affected TDG row reopens, and the decision record is amended with the finding. Abandoned task branches are deleted after their worktree is removed; anything worth keeping is extracted into the report first. Never leave a dead branch as ambient state.

**Concurrent Opus agents.** Allowed when packets touch disjoint `Allowed files` globs (verified before issuance — overlapping globs = sequential). Each agent gets its own worktree and branch; merges are serialized by Fable in dependency order; the second merger rebases. Concurrent agents never share a database instance in local dev (compose project per worktree).

**Documentation updates.** Every accepted task updates: parity-matrix status, task log, PROJECT-STATUS, and (if anything material changed) CHANGELOG. Milestone exits additionally sweep all control docs and re-run all validators.

**Rollback.** `main` regression discovered post-merge → `git revert` the merge (never force-push), file the defect as a new packet with the revert commit referenced. Schema changes must have stated down-migrations or documented irreversibility *before* merge (checklist item), so a revert is always executable in dev; production rollback follows the expand/contract rules (SPEC-10) once production exists.

---

## F. Quality-gate strategy (per-task Fable acceptance gate)

Applied to **every** Opus task before ACCEPT. Items 1–13; a failure on any bolded item is an automatic REVISE/REJECT, no discretion.

1. **Re-run, don't trust** — execute the packet's commands from a clean state; claimed output must match actual output.
2. **Diff scope** — only `Allowed files` touched; no research-report edits; no scope creep past the packet.
3. **Traceability** — every acceptance criterion → a visible change + a test; every new mutation → audit event + deny-path test; capability IDs traceable.
4. **Tenant isolation** — no statement outside the unit-of-work; no session-scoped `SET`; new tenant tables carry RLS in the same migration; isolation regression suite green.
5. **Authorization** — every new route/socket command/job declares a policy; allow **and** deny tested; no client-only enforcement.
6. **Audit behaviour** — events carry actor, on-behalf-of, before/after, mechanism, correlation id; chain intact.
7. **Test evidence** — new tests genuinely fail without the change (spot-check by reverting); **no weakened/skipped/deleted assertions**; concurrency claims backed by the deterministic harness, not wall-clock luck.
8. **Browser evidence** — for UI slices: exercised at desktop + mobile viewports incl. loading/empty/error/permission-denied states; axe green; SPEC-14 matrix updated.
9. **Architecture compliance** — module boundaries respected (import check green); no W2-port cycles; no provider calls inside transactions; **no unexplained schema or architecture deviation** (an explained one needs my recorded approval before merge).
10. **Security** — no new outbound host; no secret/credential in the diff; no payload/delivery-material logging; dependency additions carry licence + maintenance note.
11. **Idempotency/one-action-one-request** — mutations carry command/idempotency keys per spec; request-budget metric unchanged or justified.
12. **Documentation** — packet's doc deliverables present; parity matrix + task log updated; migration rollback path stated.
13. **Known limitations** — recorded honestly; anything deferred has a follow-up packet or register entry.

**Independent-review triggers (mandatory second Opus reviewer):** picklist turn transaction and coordinator · unit-of-work/RLS layer · publication triggers/version cloning · authorization evaluator · ingress enclave · audit chain · any task whose diff touches ≥2 of those · any task where my review overturned a sub-agent claim of "passing".

**Milestone gate** (on top of per-task gates): roadmap §5 checklist + all named harnesses/SBX evidence filed + validators green + control-doc sweep + risk review.

---

## G. Implementation authorization prompt

Send exactly this (or equivalent words) when you want implementation to begin:

> **Begin implementation.** Proceed under the ratified plan (docs/fable, commit `<this commit>`): issue OPUS-M0-001/002/003 and orchestrate Milestone M0 onward per the roadmap, runbook, and execution standards. Reserved decisions still come to me; everything else is yours. Report at each milestone exit.

That single message is sufficient; no other approvals are outstanding. If you want a narrower start, say "Begin M0 spikes only" and I will hold the scaffold until the spike reports are in.
