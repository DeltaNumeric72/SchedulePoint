# EV-REVIEW-C — REV-C: cross-check and consolidation (post-M4 internal review, doc 38 §3)

**Reviewer:** REV-C — a fresh high-effort Opus agent, cross-check-and-consolidation scope.
**Packet:** [docs/fable/38-post-m4-internal-review-plan.md](../../fable/38-post-m4-internal-review-plan.md)
§§1–5, packet REV-C. **Not blind:** REV-C's charter is to read both prior reports in full,
and it did.

**Branch:** `review/rev-c` (never merged), based on `64ddfd1` = `origin/main`.
**Evidence:** this directory only. **This reviewer implements nothing, adjudicates nothing,
and does not decide the gate.** It recommends.

**Inputs read in full before any execution:**

| Input | Ref |
| --- | --- |
| REV-A report + evidence | branch `review/rev-a` @ `6cac92f` — `REPORT.md`, `INDEX.md` (16 §§), 13 transcripts, 7 probe sources |
| REV-B report + evidence | branch `review/rev-b` @ `e3220a5` — `INDEX.md` (§§A–H), 21 transcripts, 3 probes |

**Machine:** 4 vCPU / 15 GiB, Linux 6.18.44, Node v22.22.2, pnpm 11.18.0.
`SP_SOLVER_WORKER_COMMAND=/home/user/SchedulePoint/solver/.venv/bin/python`. This is the same
machine class both prior reviewers measured (2.7–3.9× the M4 reference); REV-C's own composed
run independently reproduced the FAD-52 cross-machine figure `83.130356` deterministic units,
which pins this machine to the same class as FAD-52's.

**Probe-source convention:** REV-B-005 established that `.ts`/`.sh` under `docs/` turns the
architecture and fable validators red. REV-C's probe sources therefore carry `.txt` suffixes,
and REV-C re-verified the validators green from a fresh clone with this bundle absent
(t05) and green on this branch with it present (t14).

---

## Contents

| § | Transcript | What |
| --- | --- | --- |
| t01 | `transcripts/t01-m3r-findings-enumeration.txt` | The M3R registered findings (doc 38 §2.7) — enumeration attempt |
| t02 | `transcripts/t02-capability-figure-recheck.txt` | REV-A's capability figure, re-derived with REV-C's own parser |
| t03 | `transcripts/t03-revb-figure-match.txt` | REV-B's migration-cycle row + inventory sweeps |
| t04 | `transcripts/t04-ci-on-main-third-occurrence.txt` | CI on `main`, read directly — a third failing push run |
| t05 | `transcripts/t05-fresh-clone-validation.txt` | Fresh-clone validation against `origin/main` (doc 38 §7) |
| t06 | `transcripts/t06-mutation-spot-checks.txt` | One mutation probe re-run from each reviewer + probe-quality verdicts |
| t07 | `transcripts/t07-repro-truth-table-recheck.txt` | REV-A-005/006/007 by re-running REV-A's committed probe |
| t08 | `transcripts/t08-doc-reliance.txt` | Doc-reliance detection across both bundles |
| t09 | `transcripts/t09-a-vs-b-comparison.txt` | A vs B: overlap, the one contradiction, cross-misses |
| t10 | `transcripts/t10-revb001-product-innocence.txt` | REV-B-001's product-innocence half + class width |
| t11 | `transcripts/t11-nr15-composed-run-1.txt` | REV-B-002 recheck, composed run #1 |
| t12 | `transcripts/t12-nr15-composed-run-2.txt` | REV-B-002 recheck, composed run #2 |
| t13 | `transcripts/t13-reva-003-004-rerun.txt` | REV-A-003 and REV-A-004, re-run from REV-A's committed probe sources |
| t14 | `transcripts/t14-recorder-window-instrumented.txt` | REV-C's own probe: the recorder-window ordering hazard, measured |
| — | `probe-sources/` | Every REV-C probe source, `.txt`-suffixed |

*(This file is written incrementally; sections land as their evidence does.)*
