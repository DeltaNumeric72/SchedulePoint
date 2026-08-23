# EV-REVIEW-A — REV-A evidence bundle (post-M4 internal review, packet REV-A)

**Reviewer:** REV-A, a fresh high-effort Opus agent, architecture-and-domain scope.
**Packet:** [doc 38](../../fable/38-post-m4-internal-review-plan.md) §§1–5, packet REV-A.
**Probe branch:** `review/rev-a` (never merged). **Base:** `f855340` (= `origin/main`
`93a71f5` + doc 38 + the AUTO-RUN-STATE sync commit).
**Review baseline (doc 38 §1):** M1–M4 claims judged at `milestone/M4`
= `cc9f3f92583565e540a4a3b682303675ba8b6a70`; the delta to `origin/main`
= `93a71f52a16c60d99fecd6c862ba952b170cfb3a` judged for non-alteration of frozen claims
plus its own correctness.

**This reviewer implements nothing and repairs nothing.** Every probe that modified a
tracked file was applied, measured, and restored; the applied diff is recorded inline in
the transcript for that probe. The final tree of `review/rev-a` differs from its base
only under `docs/evidence/EV-REVIEW-A/`.

**Machine of record for this review:** 4 vCPU, 15 GiB RAM, Linux 6.18.44, Node v22.22.2,
pnpm 11.18.0, CPython venv at `solver/.venv/bin/python`, load average 0.19 at start.
`SP_SOLVER_WORKER_COMMAND=/home/user/SchedulePoint/solver/.venv/bin/python` for every
solver-touching run. **Figures measured here are not directly comparable to EV-M4-005's
machine of record** for any wall-clock or deterministic-unit quantity (FAD-52(3):
deterministic units are same-machine-stable, not cross-machine-portable); count-valued
figures (gate counts, arm counts, run counts, reading counts, table counts) are.

---

## Contents

| § | Area | Transcript |
| --- | --- | --- |
| 1 | Baseline: `corepack pnpm check` | `transcripts/01-check.txt` |
| 2 | Capability traceability (58 rows, 18/3/37) | inline §2 |
| — | further sections appended as stages complete | |

---

## 2. Capability traceability — executed

Executed, not read: the 58 rows were extracted mechanically from all three documents and
diffed.

```
$ awk -F'|' '/^\| [0-9]{3} \|/ {n++; s=(NF==10)?$(NF-1):$NF; ...}' docs/fable/06-feature-parity-matrix.md
rows=58 verified=18 in-progress=3 implemented= not-started=37
in-progress: 018 020 057
verified:    001 002 003 004 005 006 008 009 011 012 013 014 015 016 017 019 058 059
```

- **Report 19 (scope authority) ID set vs doc 06 ID set: byte-identical, 58 = 58.**
  (`diff` of the two sorted `CAP-0NN` sets → no output.)
- **Doc 18 (architecture traceability) covers all 58** — `comm -23` of report 19's set
  against doc 18's set is empty.
- **Counts match doc 36 §7 and FEATURE-PARITY-MATRIX exactly**: 18 verified · 3
  in-progress · 37 not-started; the verified set is the M4-004-era 14 plus
  CAP-015/016/017/059, as claimed.
- **No capability dropped.** No ID in report 19 is absent from doc 06 or doc 18.

Name-level comparison of report 19's `#### CAP-0NN · <name>` headings against doc 06's
row names: 40 rows differ by abbreviation only (e.g. "Authentication and session
management" → "AuthN & sessions"); one row differs semantically and is filed as
**REV-A-006 (NOTE)** — CAP-061 "ORSOS connector" → "Connector certification pipeline".
The substance (external specification required before connector certification; blocks
connector release) is preserved in doc 06's row, and the rename is required by the
clean-room rule, but doc 06 carries no rename annotation.

Formatting note (not a finding, recorded for the next reader): four rows of doc 06's
table — 015, 017, 018, 059 — are missing their trailing `|`. Markdown renders them
correctly; a naive column-index parser mis-reads them (this reviewer's first tally read
15/2/37 before the missing pipe was accounted for).

---

*(Sections appended as stages complete. Findings register: `REPORT.md`.)*
