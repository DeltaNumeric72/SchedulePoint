# EV-REVIEW-B — REV-B: implementation and evidence review (post-M4 internal review, doc 38 §3)

**Reviewer:** REV-B — a fresh high-effort Opus agent, launched from packet text alone.
**Packet:** [docs/fable/38-post-m4-internal-review-plan.md](../../fable/38-post-m4-internal-review-plan.md) §§1–5.
**Independence:** BLIND to REV-A. At no point before filing did this reviewer fetch,
check out, read, grep, or otherwise consult branch `review/rev-a`, the directory
`docs/evidence/EV-REVIEW-A`, or any description of REV-A's findings. One consequence is
recorded honestly in §D: an untracked `.evidence-scratch/` directory and untracked
`scripts/gates/request-budget/recordings/` produced by an earlier process in this
container were **deliberately not read**, because they could carry another reviewer's
output.

**Review branch:** `review/rev-b` (never merged). **Evidence:** this directory only.
**Rule:** this reviewer implements nothing. Code-modifying probes are applied, measured
and restored byte-identically, with the applied diff recorded here.

**Machine:** 4 vCPU, 15 GiB, Linux 6.18.44. Measured slower than the M4 reference
machine (see §C figures). `SP_SOLVER_WORKER_COMMAND=/home/user/SchedulePoint/solver/.venv/bin/python`
(CPython 3.9.6 venv, OR-Tools 9.15.6755).

**Baseline (doc 38 §1):** M1–M4 claims judged at `milestone/M4` =
`cc9f3f92583565e540a4a3b682303675ba8b6a70`; the delta to `origin/main` =
`93a71f52a16c60d99fecd6c862ba952b170cfb3a` judged for non-alteration of frozen claims
plus its own correctness. Execution in this bundle is on `review/rev-b` @ `f855340`,
whose tree differs from `origin/main` only by doc 38 and the AUTO-RUN-STATE sync
(verified: `git diff --stat origin/main..review/rev-b` = 3 files, all under `docs/`).

---

*(This file is written incrementally as stages complete. The findings register,
coverage table, could-not-falsify list and battery-figure table are at the end.)*
