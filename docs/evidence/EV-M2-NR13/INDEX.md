# EV-M2-NR13 — NR-13 fixture-isolation decision

**Task:** OPUS-M2-001, **phase A only** (the packet's "Required implementation — A").
**Branch:** `opus/m2-001-sbx-harness` · **worktree:** `.worktrees/m2-001` ·
**baseline commit:** `29d90b7`.

**State: measurements complete; the decision was ratified as FAD-15 and the refactor is
IMPLEMENTED, verified and merged into this branch.** Deliverable C (the MULTI factory) and
deliverable B (the SBX harness, `../EV-M2-SBX/`) are complete and have been through an
independent second review.

This bundle is therefore two things: the phase-A **measurements and proposal** that led to
FAD-15, kept as the reasoning of record, and the **post-refactor evidence** that the
decision was carried out. Where a phase-A document projects a number, the measured value
is in [`post-refactor-measurements.txt`](post-refactor-measurements.txt) and the projection
is left in place rather than rewritten — the point of recording a projection is to be able
to check it.

---

## Read in this order

| # | File | What it is |
|---|---|---|
| 1 | [`DECISION-PROPOSAL.md`](DECISION-PROPOSAL.md) | The proposed decision, the rejections and their grounds, the migration cost, and what ratification would decide |
| 2 | [`MEASUREMENTS.md`](MEASUREMENTS.md) | Every number, the strategy comparison table, and an explicit list of what was **not** measured |

## Raw captures

| File | Command | Headline |
|---|---|---|
| [`baseline-check.txt`](baseline-check.txt) | `corepack pnpm check` at `29d90b7` | **12 gates, 12 passed**; 36 files, 551 tests; 50.42 s |
| [`baseline-and-shuffle.txt`](baseline-and-shuffle.txt) | `vitest run`, `--sequence.shuffle.*` | workspace 34.2–35.1 s · api 14.4–14.7 s · intra-file shuffle RED on seed 20260803 |
| [`order-dependence.txt`](order-dependence.txt) | same, with execution order captured | the shuffle is real (**23 of 24** positions differ); 3 failures, **3 of 3** repeats; each diagnosed by reading it |
| [`coupled-test-population.txt`](coupled-test-population.txt) | ten `--sequence.shuffle.tests` seeds | **6 distinct coupled tests in 5 files**; 4 of 10 seeds found nothing |
| [`per-file-standalone-and-mutation.txt`](per-file-standalone-and-mutation.txt) | every api file alone, under the census config | **24 of 24 pass alone**; worst 5.33 s; **10 of 24** leave the fixture byte-identical, **11 of 24** modify seeded rows |
| [`rollback-feasibility.txt`](rollback-feasibility.txt) | `tsx test/nr13/rollback-feasibility.ts` | E1 **REFUSED** (`NESTED_TENANT_CHANGE`) · E2/E3 **INVISIBLE** · nesting costs 0.047 ms |
| [`rollback-disqualification-census.txt`](rollback-disqualification-census.txt) | static census over the 24 api files | **20 of 24** files use a second backend; at most **4** could ever use per-test rollback |
| [`cost-model.txt`](cost-model.txt) | `tsx test/nr13/cost-model.ts` | fixed cost ≈ 784 ms · one organization **2.7 ms** · DB clone 41.5 + 14.7 ms · **TRUNCATE refused (23001)** on three tables |
| [`owned-tenant-prototype.txt`](owned-tenant-prototype.txt) | `tsx test/nr13/owned-tenant-prototype.ts` | 24 owned tenants, **4.7 ms** median, **113.5 ms** total, **0 wrong-tenant rows** — with an honesty note that 3 of 12 tables were probed vacuously (closed by SBX-004, see `../EV-M2-SBX/INDEX.md`) |

## Post-refactor captures

| File | Command | Headline |
|---|---|---|
| [`post-refactor-measurements.txt`](post-refactor-measurements.txt) | repeated suite runs + the named-condition proofs | workspace ~36 s, `api` ~16 s; each named-condition proof standalone, in-package and in-battery |
| [`fixture-regression.txt`](fixture-regression.txt) | `corepack pnpm fixture-regression` | **38 runs, 38 passed** — 10 fixed seeds + 1 rotating with both shuffles, then every file alone |
| [`rollback-disqualification-census.txt`](rollback-disqualification-census.txt) | static census over the api test files | **20 of 24** files use a second backend; at most **4** could ever use per-test rollback |
| [`baseline-check.txt`](baseline-check.txt) | `corepack pnpm check` at the phase-A baseline `29d90b7` | 12/12, 36 files, 551 tests — the "before" |
| [`final-check.txt`](final-check.txt) · [`final-red-cases.txt`](final-red-cases.txt) | `pnpm check` · `pnpm red-cases` after the refactor | 12/12 · 14/14 |

## Instruments (measurement only — none is wired into `pnpm check`)

| File | Purpose |
|---|---|
| `apps/api/test/nr13/mutation-census.ts` | Wraps the real `globalSetup`; digests every row before and after a run and reports what changed |
| `apps/api/test/nr13/cost-model.ts` | Prices every per-unit cost a candidate strategy pays, against a real cluster |
| `apps/api/test/nr13/rollback-feasibility.ts` | The four experiments that decide S1 |
| `apps/api/test/nr13/owned-tenant-prototype.ts` | The recommended mechanism at the real file count, with a cross-tenant probe |
| `apps/api/vitest.nr13.config.ts` | The census config — identical to `apps/api/vitest.config.ts` except for `globalSetup` |

**Phase A itself modified no existing test, gate, fixture or production file** — it added
five instruments under `apps/api/test/nr13/`, one vitest config, and this bundle.

**The refactor that followed is a different and much larger diff:** the shared baseline
became read-only and enforced (`test/support/baseline-guard.ts`), eighteen files adopted
`ownedMulti`, `test/support/multi.ts` became the single fixture owner, the queue gained an
explicit precondition (`test/support/queue.ts`), and six coupled tests were rewritten to
own their subjects. No test was deleted, skipped or weakened at any point; the suite grew
from 551 to 583.

---

## The finding, in one line

NR-13 is real and measurable at `29d90b7`: **six tests across five files do not own their
state**, reproducibly. Per-test transactional rollback — the obvious fix — is **forbidden
by the tenancy architecture itself** (a nested unit of work may not re-tenant), applies to
at most 4 of 24 files, and would fail silently in the rest. The proposal is an immutable
shared baseline plus per-file owned tenants at a measured **4.7 ms** each, plus explicitly
declared preconditions for the queue and the other non-tenant shared state that four of
the six couplings actually live in.
