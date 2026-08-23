# AUTO-RUN-STATE

**The continuation record for the continuous GitHub-authorized autonomous run.** This
file is a pointer, not a register: it names where the run is and what happens next, and
it references — never duplicates — the detailed evidence and decision registers
([PROJECT-STATUS](PROJECT-STATUS.md) · [CHANGELOG](CHANGELOG.md) ·
[ARCHITECTURE-DECISIONS](ARCHITECTURE-DECISIONS.md) · `docs/evidence/`). The
machine-readable twin is [AUTO-RUN-STATE.json](AUTO-RUN-STATE.json); the two are
updated together. Updates land through ordinary fast-forward commits only — if two
orchestrators race, the one whose remote update succeeds owns the run.

| Field | Value |
| --- | --- |
| Run ID | `RUN-20260822-GHRECON-01` |
| Orchestrator | Claude Fable (Claude Code on the web session, continuous GitHub master authorization of 2026-08-22) |
| Current milestone | Post-M4 hold: M4 COMPLETE; M3R PAUSED-pending-review; prototype checkpoint and M5 NOT begun |
| Current packet | replacement-review (doc 38): REV-A next |
| Lifecycle state | REVIEW-PLAN RATIFIED — PR #3 MERGED (origin/main `93a71f5`, tree byte-identical to the fully-green candidate `332603e`); doc 38 committed and ratified; REV-A launching |
| origin/main commit | `93a71f52a16c60d99fecd6c862ba952b170cfb3a` |
| Task branch | `claude/schedulepoint-github-auth-a4ns2p` |
| Worktree | Claude Code web workspace `/home/user/SchedulePoint` (ephemeral) |
| Latest pushed commit | this commit (branch tip on origin) |
| Pull request | PR #3 MERGED; plan PR open from the task branch |
| Implementer | none active |
| Reviewer | none active |
| Active processes / ports | none — no dev server, database, or solver process started this session |
| Last command | `git push origin milestone/M4` (tag-publication probe) |
| Last exit code | 1 (HTTP 403 — session credential is branch-scoped; recorded, not retried) |
| Open findings | follow-ups GH-004/GH-008/GH-009 (review input) · owner action issue #4 · M3R findings unchanged pending the review |
| External blockers | none — [#1](https://github.com/DeltaNumeric72/SchedulePoint/issues/1) CLOSED (all four milestone tags on GitHub, independently verified) · [#2](https://github.com/DeltaNumeric72/SchedulePoint/issues/2) CLOSED (Codex requirement SUPERSEDED BY OWNER DECISION 2026-08-22; replacement gate = Fable-planned, multi-Opus-executed internal review) |
| Exact next action | Launch REV-A (fresh Opus, read-only, evidence to EV-REVIEW-A, probe branch review/rev-a); then REV-B blind to A; then REV-C; adjudicate; repairs; gate per doc 38 §9 |
| Last update (UTC) | 2026-08-23T02:45:00Z |

## Reconciliation facts this record rests on

- Origin verified: `https://github.com/DeltaNumeric72/SchedulePoint` (exact match, both fetch and push). Clone was shallow at session start; unshallowed to full 124-commit history before any conclusion was drawn.
- All four milestone checkpoints verified against full history: exist, ancestors of `origin/main`, and each is the checkpoint its exit report names (M1 `b051193` · M2 `e476573` · M3 `7b579f2` · M4 `cc9f3f9`). GitHub holds **zero** tags; publication is owner action #1. A milestone is not durably frozen until its tag is visible on GitHub — M1–M4 are therefore verified-but-not-yet-frozen-remotely.
- Single-orchestrator check: no other branches, PRs, issues, lease records, or foreign Actions runs existed before this run's writes; the only Actions runs are the two bootstrap CI runs on main (run 1 cancelled by concurrency, run 2 the live head).
- CI: `.github/workflows/ci.yml` — two build-failing jobs (`check` gate battery, `red-cases` proofs) on every PR and push to main; no `continue-on-error`; cannot silently skip all tests. Branch-protection settings are not readable with this session's tooling — recorded as unverified, not assumed.
- The post-M4 Codex review (doc 37) has a filed prompt and **no completed report or disposition** anywhere in the repository → EVIDENCE_BLOCKED, dispatch is owner action #2.
