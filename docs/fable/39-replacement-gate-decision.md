# 39 — Replacement-review gate decision (doc 38 §9)

**Decision: the replacement gate PASSES. All eleven §9 criteria hold with evidence.**
Recorded 2026-08-25 by the Fable orchestrator under the owner's continuous GitHub
master authorization (2026-08-22) and the delegated-authority mandate (2026-08-01);
each criterion below is closed by evidence, not by assertion. On this decision, per
the owner's supersession ruling and §C: **M3R closes by substitution**, and the run
proceeds automatically to the prototype-enablement checkpoint and M5.

**The owner-required record, verbatim:** Codex review: NOT PERFORMED · Codex-specific
requirement: SUPERSEDED BY OWNER DECISION · replacement gate: FABLE-PLANNED,
MULTI-OPUS-EXECUTED INTERNAL REVIEW. This was an internal review. It is not, and is
never to be described as, an external review. Nothing in this record is a compliance
or readiness claim ([14](../architecture/14-security-and-privacy.md) §11 stands).

---

## §1 The eleven criteria

| # | §9 criterion | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Plan committed with the §10 ratification | **HOLDS** | Doc 38 merged via PR #5; §3 and §7 subsequently amended in place with dated, non-relaxing notes (R-9; R-3; FAD-54's census amendment) |
| 2 | All three Opus reports complete per their completion criteria | **HOLDS, with a declared residue** | REV-A `review/rev-a@6cac92f` + the R-10 corrigendum at `13a086f`; REV-B (blind) `review/rev-b@e3220a5`; REV-C `review/rev-c@c52c2ab`. The residue, declared rather than papered: REV-A's bundle still lacks its per-scope-area coverage table — R-10 corrected its mis-citations and refused to manufacture the table on the reviewer's behalf; the two areas REV-C named as at risk are covered by executed evidence in REV-B's lane (route-policy 113/113; SBX role×route). |
| 3 | REV-C recommends ACCEPT | **HOLDS** | REV-C's filed verdict was REVISE. After all 28 findings were adjudicated and repaired (criterion 4), a **REV-C continuation surrogate** (doc 38 §4.5's second branch — a fresh reviewer given the filed report, the same recorded form as R-10) re-reviewed the disposition of every finding at `be7399b`, spot-checked nine across all severities, attacked five suspected weak points and could falsify none, and issued: **"REV-C FINAL RECOMMENDATION: ACCEPT"**, conditional on the two then-pending inputs (both since green — criteria 8 and 10) and on the record-completion conditions C2–C6, all discharged by this record's commit. Verbatim report: [`EV-DOC38-GATE/rev-c-final-recommendation.txt`](../evidence/EV-DOC38-GATE/rev-c-final-recommendation.txt). |
| 4 | Every valid finding resolved through §6 | **HOLDS** | FAD-53: all 28 consolidated findings ACCEPTED at filed severity — none rejected, downgraded, omitted, or combined away — and resolved through thirteen serial repair packets (R-1..R-13), each with a fresh Opus implementer, an independent fresh Opus reviewer, and delta verification (criterion 6). The surrogate's finding-by-finding disposition table confirms all 28. |
| 5 | No confirmed functional defect remains | **HOLDS** | The review found no functional product defect reachable through a shipped surface (~100 probes). The two functional test-suite defects the battery itself surfaced (R-12 periodic R-03; R-13 T-15 storm — including the second latent ordering, seed 740673, discovered by the full re-run) are repaired with structural no-regression proofs and re-proven by 14/14 fixture-regression on the repaired tip. NR-23 (run-wide position-correlated slowdown) is an open performance phenomenon with correctness intact (`WRONG-TENANT ROWS: 0` in every run), carried as a registered risk, not a defect. |
| 6 | Original reviewers delta-verified their findings' corrections | **HOLDS** | Per-packet delta records; where the original session could not be continued, §4.5's fallback was used and recorded each time (R-10's REV-A surrogate; the REV-C surrogate of criterion 3; R-4b delta by its finder; R-13's delta by both its reviewer and the group-C finder). |
| 7 | The complete §7 validation battery passes | **HOLDS** | [`EV-DOC38-GATE/INDEX.md`](../evidence/EV-DOC38-GATE/INDEX.md). Leg-to-commit map (the §4 freshness point, stated explicitly): legs 1–4 executed at `85efa2b`; leg 5 per FAD-54 in §7's own primary form — three complete sharded-CI executions with the union guard green (runs 32716033514 at `85efa2b`, 32724748023 at `007dfef`, and 32794506582 at `7be44db`, **whose tree is byte-identical to the final `be7399b` tree, `448ed695…`** — FAD-54's "green twice" sentence is hereby dated to its writing at `007dfef`, the `7be44db` run being the execution on the final tree); leg 6 (fixture-regression 14/14, 13 fixed + rotating 467407) and leg 7 (real-stack e2e 2/2, 14 steps, 12/12 axe) at `149edee`, whose delta to `be7399b` is docs/control only, with leg 6 re-executing the whole `api` suite on the final code fourteen times; leg 1 re-run on the tip by the surrogate (36/36 · 95/95 · PASS). Migrations and the six populated-cycle tests byte-unchanged from `85efa2b` to `be7399b` (input identity for legs 4a/4b). |
| 8 | GitHub CI passes on `main` | **HOLDS** | Run **32798497944** on the merge commit `be7399b`: **all 15 jobs success, attempt 1** (gate battery incl. sbx · 13 red-case shards · shard completeness; completed 2026-08-25T02:42:52Z) — the first fully green CI on `main` in the repository's history (all prior main-push runs were red with the pre-R-1 recorder-window class, or cancelled). REV-C's §8.2 no-single-run demand is met beyond it: five green branch runs post-R-1, attempt 1 where cited (`9385632`/32645176400 · `85efa2b`/32716033514 · `007dfef`/32724748023 · `c73f9ff`/32751982655 · `7be44db`/32794506582); the one non-green event in the window (`603be0c`, `MATRIX_RESULT: abandoned`) was a transient platform cancellation, recorded as such and cleared by the next push. |
| 9 | All required pull requests merged | **HOLDS** | PR #3, PR #5, PR #6 MERGED (PR #6 at `be7399b` with all 15 checks green). PR #7 is this record's own vehicle, not a gate input; the `review/rev-*` probe branches never merge by design (doc 38 §8). |
| 10 | Fresh-clone validation against `origin/main` | **HOLDS** | Pristine HTTPS clone of the remote at `be7399b` (tree verified `448ed695…`); `corepack pnpm install --frozen-lockfile` exit 0; validators 36/36 · 95/95 · research PASS; **`corepack pnpm check` 17/17, exit 0** (31m02s; unit 2 200 passed; axe 430; solver executing real CP-SAT). The sole workspace copy was `solver/.venv` (recorded; CI provisions its own the same way); embedded-postgres permission interventions observed-then-applied and restored-then-verified. Evidence: [`EV-DOC38-GATE/fc-install.txt`](../evidence/EV-DOC38-GATE/fc-install.txt) · [`fc-validators.txt`](../evidence/EV-DOC38-GATE/fc-validators.txt) · [`fc-check.txt`](../evidence/EV-DOC38-GATE/fc-check.txt). |
| 11 | Control and evidence documents accurately reflect the outcome | **HOLDS as of this commit** | The surrogate's C2–C6, discharged here: C2 — [`EVIDENCE-INDEX`](control/EVIDENCE-INDEX.md) rows added for EV-DOC38-GATE and EV-REVIEW-A/B/C; C3 — AUTO-RUN-STATE's `.md` lifecycle cell rewritten in sync with its `.json` twin; C4 — the leg-to-commit map and the FAD-54 dating are in criterion 7 above; C5 — the post-gate residues moved into the durable numbered register [`40-post-gate-follow-ups.md`](40-post-gate-follow-ups.md); C6 — [`PROJECT-STATUS`](control/PROJECT-STATUS.md) records the review and this outcome. |

## §2 What this decision does and does not do

- **M3R CLOSES by substitution** (the owner's §C; FAD-53's ruling that this three-packet
  review IS the fresh M1–M4 cross-boundary review). Its closure is recorded here and in
  the control documents; no frozen record is retro-edited.
- The run proceeds to the **prototype-enablement checkpoint** and then **M5**,
  automatically, under the continuous authorization. Owner-reserved actions remain
  owner-reserved; nothing here marks an ADR accepted or a product decision approved.
- The registered follow-ups ([40](40-post-gate-follow-ups.md)) ride into M5 planning;
  FU-01 (NR-22 retirement) is same-milestone by its own binding.
- Honesty notes carried forward, not smoothed: leg 5's serial-local attempts were
  environment-capped (FAD-54, zero arm failures); leg 7's attempt 1 was an orchestrator
  invocation error preserved as evidence (FU-04); leg 6b's seed-1 attempt 1 was a
  container-pause casualty with no verdict; the REV-A probe-suffix demonstration stays
  on its never-merged branch at 94/95 · 35/36.
