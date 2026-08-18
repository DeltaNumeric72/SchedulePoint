# EV-M4-004 — OPUS-M4-004 (E2 optimization, quality, and explanations)

**Packet:** [doc 35 §6f](../../fable/35-m4-task-packets.md). **Branch:**
`opus/m4-004-e2-optimization`, worktree `.worktrees/m4-004`, base `b671955`.

Everything below is machine capture. Where a command failed, the failure and its
cause are recorded rather than the re-run alone.

**No migration.** 0018's `build_run_results` already carried `quality_metrics`,
`objective_tiers`, `explanation_state`, `explanation`, `objective_value` and
`rejections`, and `build_runs` already carried the SPEC-04 §4 provenance columns.
Nothing here needed a schema change and nothing here made one — migrations
0001–0018 are byte-untouched and the cycle is re-proven below.

---

## 1. What shipped

| Layer | Content |
|---|---|
| **`packages/domain/src/rules/objective.ts`** *(new)* | `OBJECTIVE_SCALE = 10⁴` decided ONCE (doc 08 §3.4), one converter `scaleWeight` that ROUNDS, the `e2-default-v1` tier profile with its ranks and multipliers, the canonical rendering the worker reproduces byte for byte, and `resultsAreComparable` — the one place "same snapshot AND same weights" is decided |
| **`packages/domain/src/rules/quality.ts`** *(new)* | SPEC-04 §7's `fairness_dispersion`: the coefficient of variation of FTE-normalised credits, computed from the candidate PLUS the credit history the snapshot already carries, with the normalisation recorded and participants without an in-force FTE excluded and counted |
| **`packages/domain/src/rules/conflict-taxonomy.ts`** *(new)* | PO-DEC-13's four classes in the decision's own severity order, with `blocksApproval` and `banded` per class, and a mapping for every conflict the pipeline can produce |
| **`solver/schedulepoint_solver/model.py`** | The mirrored scale, profile and digest; `scale_weight`; and `fairness_coefficients`, which honours the `FairnessBalance` node's own `metric` and `normalisation` — both of which E1 ignored entirely |
| **`solver/schedulepoint_solver/cpsat_adapter.py`** | The tiered objective with per-rule scaled weights recorded; the **T2 deletion-minimisation loop** under a hard iteration cap and a share of the explanation budget; SPEC-04 §4 search statistics |
| **`apps/api/src/solver/objective-record.ts`** *(new)* | The platform's digest, the mismatch refusal, and the defensive readers for the profile, the statistics and the tier list |
| **`apps/api/src/solver/quality-metrics.ts`** *(new)* | SPEC-04 §7's metric set, measured — with `requestHonourRate` and `templateAdherenceRate` honestly `null` |
| **`apps/api/src/builds/conflicts.ts`** *(new)* | The taxonomy as a READ-derived, severity-ordered projection over rows 0018 already stores |
| **`apps/api/src/solver/canonical-input.ts`** | `protected_assignment_identities` gains its first reader — the identities become pins in the snapshot, so the protection travels through the ONE mechanism the model and the checker already share |
| **`apps/api/src/solver/candidate-validation.ts`** | A sixth rejection class: a PINNED fixed input the candidate did not reproduce |
| **`apps/api/src/builds/{runner,views,selection}.ts`** | The quality record and the SPEC-04 §4 provenance persisted; the comparability gate before the projection; the credits ruling stated where the non-carry happens |
| **`apps/web/src/builds/**`** | Four new vocabulary tables, the E2 quality panel, the conflict taxonomy grouped by severity, the five explanation states with the T2 record, the deterministic toggle with its measured cost, and both comparison refusals |
| **Contracts** | Additive throughout: `conflictClassSchema`, `buildConflictSchema`, `objectiveComponentSchema`, `explanationTier2Schema`, `comparabilitySchema`, and the widened quality/tier/explanation shapes |

**No new tenant table, so the SBX sweep floor is unchanged** — `sweep = registry − 1`
holds at 53 registry / 52 sweep, exactly as M4-003 left it.

---

## 2. Rulings applied, and the four this packet authors for FAD ratification

### The packet's own four rulings, executed

| Ruling | Where |
|---|---|
| **(1) A build-produced draft starts WITHOUT credits** | `apps/api/src/builds/selection.ts` header, and pinned BOTH ways by `e2-quality-and-credits.test.ts` — apply writes zero credit rows; the M3 credit surface then writes one on the resulting draft. FAD-32(6) continues to govern CLONES only |
| **(2) PO-DEC-13's default governs** | `packages/domain/src/rules/conflict-taxonomy.ts`. Four classes, the decision's own order, no fifth bucket. Nothing was re-derived: re-deriving a recorded default is how a default quietly becomes a preference |
| **(3) Deterministic mode is opt-in, pinning the FULL SPEC-04 §4 amended set, with its cost MEASURED** | The toggle sets `interleaveSearch`, `maxDeterministicTime` and `numSearchWorkers` together — never the computed mode. Cost table in [§5](#5-the-deterministic-mode-cost-measurement) |
| **(4) FAD-43(5) executed** | `chronological()` in `packages/domain/src/rules/hard-rule-check.ts` gains its load-bearing comment: the sort is the PREMISE of the model/checker equivalence argument, not a tidiness choice |

### Four rulings this packet AUTHORS (proposed for FAD ratification)

| # | Ruling | Why, and where it is pinned |
|---|---|---|
| **E2-R1** | **The E2 tier order is fairness (rank 1, ×100) > work-percentage (rank 2, ×10) > preference (rank 3, ×1).** RATIFIED by FAD-46 — and **corrected**: this row originally said "E1's ordering made explicit, not re-ranked", which is true of the ORDER and silent about the RATIOS, which changed | E1 used 30/20/10 for the same three classes; `e2-default-v1` uses 100/10/1. The order is preserved, the trade-off is not — ten preference violations outweighed three fairness violations under E1 and cannot under E2. That is a semantic change and is recorded as one ([§9.4](#94-f-07--e2-r1s-ratio-change-recorded-as-a-semantic-change)); the profile is versioned and digest-enforced, so results either side are refused as incomparable rather than silently ranked together. `e2-objective-and-quality.test.ts` pins that rank 1 carries the largest multiplier |
| **E2-R2** | **The objective is a WEIGHTED SUM and the product does not claim lexicographic tier priority** | CP-SAT minimises one expression. A lexicographic objective is a different construction (staged solves with each tier frozen), costs a solve per tier, and promising it while implementing a weighted sum would be exactly the confident-sounding claim SPEC-04 §5 refuses to make. Stated in `objective.ts` and on the detail screen |
| **E2-R3** | **Fairness semantics:** `weekend_load` is START-date attribution (Sat/Sun), `call_load` uses snapshot v2's `isOnCall` and REFUSES when the flag is absent, `CreditDistribution` normalises `per_fte`, `per_eligible_day` divides by in-scope eligible days floored at 1 | Every one is a parameter the E1 model ignored — a `FairnessBalance(credits, per_fte)` and a `FairnessBalance(assignments, none)` compiled to the identical term, which is the silent-skip shape SPEC-04 §3.3 forbids wearing a SOFT rule's clothes. `model.py`'s fairness section states each with its reason |
| **E2-R4** | **`fairness-outlier` conflicts name the measured EXTREMES and carry no threshold** | No band for `fairness_dispersion` exists until the M6 benchmark (SPEC-04 §7). The extremes are named because they are the extremes; the class is `blocksApproval: false`, `banded: false`, and the screen says "no threshold … not because anything is wrong" |

---

## 3. Real defects found, and one measurement that falsified its own assertion

| # | Defect | How it would have presented | Fix |
|---|---|---|---|
| **D-1** | **`int(float(weight))` truncated every fractional SOFT weight.** A rule authored at `0.5` contributed **nothing at all** to the objective | Indistinguishable from a correct schedule: the rule is in every listing, in the tier record, and absent from the arithmetic. This is precisely the "per-rule ad-hoc choice … silently corrupts every trade-off" doc 08 §3.4 warns about | One converter, `scaleWeight`, which rounds at the one global factor. Pinned: `scaleWeight(0.5) === 5000` and explicitly `not.toBe(0)` |
| **D-2** | **The E1 fairness term ignored BOTH parameters of its own AST node.** `FairnessBalance(metric, normalisation)` compiled to a raw assignment-count spread whatever it said | Two different authored intentions, one behaviour, and nothing anywhere saying which had been honoured | `model.fairness_coefficients` honours both, with each ruling stated (E2-R3) and testable without a solver |
| **D-3** | **`build_runs`' five SPEC-04 §4 provenance columns were never written by anything.** Migration 0018 declared `solver_version`, `solver_image_digest`, `compiler_version`, `platform_arch`, `reproducibility_mode`; every build carried five NULLs | The detail route read `reproducibility_mode` and rendered the absence as a blank. A reproducibility record that is never written is a promise the schema makes and the code does not keep | Written in `persistOutcome`, in the same transaction as the result. Pinned by `e2-quality-and-credits.test.ts` |
| **D-4** | **`hardViolations: 0` was a LITERAL** in the persisted quality metrics, written beside a verdict that already knew the real count | Right by accident — an unusable candidate never reached the same path — and completely unfalsifiable | The checker's count, which is the only thing entitled to state it (SPEC-04 §3.3) |
| **D-5** | **`protected_assignment_identities` had no reader.** A progressive build recorded what it intended to protect and then solved a problem in which those assignments were free to move | The worst possible shape: the record said the protection had happened | The identities become pins in the snapshot; the model hard-fixes them and the checker refuses a candidate that dropped one. Proven by a fixture where the optimizer *would* have moved it, with its unpinned control |
| **D-6** | Caught while writing the profile renderer: `"kinds"` was emitted before `"key"`, which reads correctly and **sorts wrongly** (`'e' < 'i'`) | The two runtimes would have digested different bytes and every solve would have been refused as a forged objective — the failure wearing the worst possible disguise | Key order fixed and pinned against the generic canonicaliser, so the hand-rolled renderer cannot drift from it |

**The measurement that falsified its own assertion.** `deterministic-cost.test.ts`
first asserted that both modes return the same STATUS. `B-fairness-shaped`
falsified it immediately: best-effort proves `OPTIMAL`, deterministic returns
`FEASIBLE`. Both are true, and the difference *is* the cost — the deterministic
budget stopped the search before optimality was proven. Asserting status equality
would have been asserting that a budget change cannot cost a proof. The assertion
now compares the outcome CLASS and both statuses are recorded per class, so the
fact is visible rather than smoothed away. The original failing run is recorded
in the transcript's history rather than only its replacement.

---

## 4. Test results

| # | Command | Result | Transcript |
|---|---|---|---|
| 1 | `corepack pnpm install --frozen-lockfile` | up to date · `INSTALL EXIT=0` | [`step-01`](step-01-install.txt) |
| 2 | `SP_EVIDENCE_REFRESH=1 corepack pnpm check` | **17/17 gates**, unit **2023 passed / 14 skipped** · `CHECK EXIT=0` | [`step-02`](step-02-check.txt) |
| 3 | `SP_EVIDENCE_REFRESH=1 corepack pnpm red-cases` | **INTERRUPTED — killed at arm 25 of 58.** 24 arms PROVEN (green pass + red fail), the 25th mid-arm. **No verdict was claimed for the 33 unrun arms.** Superseded by row 7, which ran the same battery to completion; this row and its transcript are retained as the record of the interruption, not replaced by it. See §4a, §7 and §8 | [`step-03`](step-03-red-cases-INTERRUPTED.txt) |
| 4 | `SP_MEASURE_DETERMINISTIC_COST=1 … deterministic-cost.test.ts` | 14/14 · `DETERMINISTIC-COST EXIT=0` | [`step-05`](step-05-deterministic-cost.txt) |
| 5 | `corepack pnpm --filter @schedulepoint/api migrate:cycle:embedded` | **0001–0018 clean**, up→down→up→down→up in 1182 ms · `MIGRATE-CYCLE EXIT=0` | [`step-06`](step-06-migrate-cycle.txt) |
| 6 | `corepack pnpm sbx` | **6/6 scenarios PASS, every probe FALSIFIABLE**; 371 readings across 7 contexts, **0 wrong-tenant rows, 53 of 53 tables observed with visible rows** — floor UNCHANGED from M4-003, as expected for a packet that adds no table · `SBX EXIT=0` | [`step-07`](step-07-sbx.txt) |
| 7 | `SP_SOLVER_WORKER_COMMAND=… corepack pnpm red-cases` | **58 case(s): 58 proven, 0 not proven** — the FULL battery, every arm green-pass + red-fail · `RED-CASES EXIT=0` | [`step-08`](step-08-red-cases.txt) |
| 8 | `SP_SOLVER_WORKER_COMMAND=… corepack pnpm fixture-regression` | **146 run(s): 146 passed, 0 failed** — 13 fixed seeds + rotating seed **86212** + the standalone sweep · `FIXTURE-REGRESSION EXIT=0` | [`step-09`](step-09-fixture-regression.txt) |

**The corpus re-run and the both-viewport e2e are inside step 2**, not separate
commands: `gate:unit` runs the whole vitest workspace (which is where
`corpus-agreement.test.ts`, `e2-objective.test.ts`, `e2-quality-and-credits.test.ts`
and the domain/web proofs live) and `gate:axe` runs Playwright over every spec at
both the `desktop` and `mobile` projects. The fourteen EV-M4-004 screenshots in
[`screenshots/`](screenshots/) were written by that run.

The 111-route SBX-001 sweep in step 6 includes all fifteen `builds` routes, every
one policy-declared — the E2 additions changed response SHAPES and added no
route.

The 14 skipped unit tests are `deterministic-cost.test.ts`, which is opt-in by
design: two solves per corpus class on a machine whose *timings are the point*
would spend minutes on every unrelated battery, and a timing measured under a
loaded suite is a timing nobody should record. It is evidence, not a gate, and
nothing in it can fail because a solve was slow — because nothing in it knows
what slow is.

### 4a. The five new red arms, both directions, standalone (FAD-33(1))

**These are the arms' own standalone verification, and they are complete.** Each
was driven by hand BEFORE the battery, exactly as the discipline requires: clean
tree green, violation applied, the named tests re-run, violation reverted, tree
confirmed clean by `git diff --stat`. That verification does not depend on the
interrupted full-battery run, and none of these five arms was reached by it.

| Arm | Violation | Green | Red |
|---|---|---|---|
| `solver-objective-scale-drift` | `OBJECTIVE_SCALE = 1000` in `model.py` only | 16 passed | **13 failed / 3 passed** |
| `solver-t2-false-minimality` | `_minimise` returns a completed pass it never ran | 25 passed | **2 failed** — "minimal claimed with no probe run: expected 0 to be greater than 0" |
| `solver-progressive-pin-unfixed` | the model stops fixing pinned inputs to 1 | 16 passed | **1 failed** — the assignment moved to the cheaper participant |
| `builds-comparability-unenforced` | `resultsAreComparable` always returns `true` | 30 passed | **4 failed** across BOTH packages (2 domain, 2 api) — the api half proves the `prepare` rebuild is load-bearing |
| `builds-optimality-wording` | `completed: 'Completed — optimal schedule found'` | 9 passed | **1 failed** — "optimality claimed in: Completed — optimal schedule found" |

The fourth arm carries `prepare`/`restore` `tsc -b packages/domain --force` for
the reason the `retired-verdict` arm records in full: an api-side test resolves
`@schedulepoint/domain` through `exports` → `dist/`, so without the rebuild it
observes the OLD build and the arm reads PROVEN while proving nothing. Its
violation is spelled compile-clean (the guard above it still reads the
parameter) so the rebuild succeeds — a violation that fails to compile makes the
arm read NOT PROVEN, which proves nothing either.

---

## 5. The deterministic-mode cost measurement

Per corpus class, deterministic wall clock over best-effort wall clock, on this
machine. **This is a MEASUREMENT and not a band.**

> **REPAIR F-11 (FAD-46).** This paragraph used to state the machine was at
> "`load average 3.4`". No transcript records that reading — it was not captured
> at the time and cannot be reconstructed after the fact. An unbacked number
> beside a timing table is exactly the kind of detail that makes a measurement
> look more controlled than it was, so it is removed rather than kept. The
> measurement's real limits are stated below and are unchanged.
No benchmark band exists until M6, no performance target is set by this run, and no surface
that displays it claims one.

| Class | Deterministic | Best-effort | Ratio | Det status | BE status |
|---|---:|---:|---:|---|---|
| `B-feasible-small` | 804 ms | 753 ms | 1.07× | OPTIMAL | OPTIMAL |
| `B-feasible-medium` | 781 ms | 810 ms | 0.96× | OPTIMAL | OPTIMAL |
| `B-feasible-large` | 896 ms | 880 ms | 1.02× | OPTIMAL | OPTIMAL |
| `B-multisite` | 773 ms | 786 ms | 0.98× | OPTIMAL | OPTIMAL |
| `B-ruleheavy` | 785 ms | 783 ms | 1.00× | OPTIMAL | OPTIMAL |
| `B-progressive-pinned` | 748 ms | 747 ms | 1.00× | OPTIMAL | OPTIMAL |
| `B-qualifications` | 749 ms | 747 ms | 1.00× | OPTIMAL | OPTIMAL |
| `B-fte` | 743 ms | 742 ms | 1.00× | OPTIMAL | OPTIMAL |
| `B-locum-shaped` | 723 ms | 723 ms | 1.00× | FAILED | FAILED |
| **`B-fairness-shaped`** | **10143 ms** | **1009 ms** | **10.05×** | **FEASIBLE** | **OPTIMAL** |
| `B-infeasible-contradictory-rules` | 753 ms | 749 ms | 1.01× | INFEASIBLE | INFEASIBLE |
| `B-infeasible-missing-qualification` | 746 ms | 744 ms | 1.00× | INFEASIBLE | INFEASIBLE |
| `B-infeasible-over-demand` | 744 ms | 742 ms | 1.00× | INFEASIBLE | INFEASIBLE |
| `B-infeasible-fixed-conflict` | 745 ms | 751 ms | 0.99× | INFEASIBLE | INFEASIBLE |

**How to read this honestly, and its limits stated with it:**

- **Every measurement includes worker process startup**, which the EV-M0-SPC
  spike measured at 200–630 ms for `import ortools` alone (and which this
  platform pays deliberately, with a sanitised `HOME`, for the boundary). The
  thirteen classes at ≈1.00× are therefore **startup-dominated**: their solves
  are milliseconds and the ratio is measuring process launch, not search. They
  are reported as measured rather than adjusted, because an adjusted number is a
  number somebody has to trust an adjustment for.
- **`B-fairness-shaped` is the only class with an objective large enough to
  search**, and it is the one that shows the real figure: **10.05×**, consistent
  with EV-M0-SPC H-7's ≈12× on a toy instance.
- **H-7's other half is NOT reproduced here**: the spike measured the
  deterministic portfolio *faster* on a hard instance, and this corpus has no
  instance hard enough to show it. That is a gap in the corpus, not a
  contradiction of the spike, and it is recorded as a gap.
- **One run per class, one machine, CPython 3.9.6 under the FAD-7 venv.** A
  benchmark would need ≥5 runs per class on a quiet machine at the pinned 3.12
  image; that remains the standing CI condition and this is not it.

---

## 6. Standing limitations

1. **No band is set by anything here.** SPEC-04 §7 leaves every band except
   `hard_violations = 0` undefined until the benchmark corpus is run, and
   no band exists until the M6 benchmark. The metrics, the fairness dispersion and the cost table
   are measurements; no surface renders a threshold, a rating, or a colour.
2. **Tier weights are a weighted sum, not a lexicographic priority** (E2-R2).
   The recorded weights say what was optimised; they do not promise that any
   amount of a lower tier is outranked by any amount of a higher one.
   **And the E2 ratios are a SEMANTIC CHANGE from E1** (F-07, ratified by
   FAD-46): E1 used 30/20/10, `e2-default-v1` uses 100/10/1. The tier ORDER is
   preserved; the trade-off is not. Ten preference violations outweighed three
   fairness violations under E1 and cannot under E2. See [§9.4](#94-f-07--e2-r1s-ratio-change-recorded-as-a-semantic-change).
3. **The objective profile is a code constant, not per-organization
   configuration.** Configurable weights would need a schema change, which this
   packet is explicitly not allowed to make; the profile is versioned by
   `profileId` and digested so a change is visible and comparability is enforced
   across it. Per-organization weights are a recorded owner question.
4. **`requestHonourRate` and `templateAdherenceRate` are `null`, permanently for
   M4.** Requests are M5; `TemplateAdherence` is fail-closed at M4 (FAD-27).
5. **T2 is a deletion pass, and local minimality is all it claims.** A locally
   minimal subset is not a minimum-cardinality one, and nothing says it is.
6. **The corpus has no instance hard enough to show the deterministic
   portfolio's *advantage*** — see §5.
7. ~~**The full red-case battery and `fixture-regression` were not completed in
   this session** — see §7. Nothing is claimed about them.~~ **CLOSED by §8:**
   both ran to completion (58/58 proven; 146/146 passed at rotating seed 86212).
   This limitation is struck rather than deleted, because the interruption it
   records is the reason the §8 run was hardened the way it was.
8. Everything M4-002 and M4-003 recorded still stands: CPython 3.9.6 locally with
   the 3.12/image re-run as the standing CI condition; `Dockerfile.solver`
   authored, not built; dispatch in-process; no production-readiness claim.

---

## 7. What was NOT run, and exactly where it stopped

Recorded plainly rather than left to be inferred from an absence.

> **Status: both items in this section have since been RUN to completion — see
> [§8](#8-completion--the-two-outstanding-batteries-run-to-the-end).** This section is
> kept exactly as written, because a record of an interruption that is edited away
> once it is resolved teaches nobody what to expect the next time, and the failure
> mode it documents (a kill skipping the runner's `finally`) is the reason §8's run
> was launched the way it was.

### `pnpm red-cases` — INTERRUPTED at arm 25 of 58

The run was started in the background and the **harness killed it**, at
`draft-invisibility`, after that arm had taken its GREEN reading. It did not
fail; it was terminated. Of the 24 arms that completed, **all 24 were PROVEN**
(GREEN pass followed by RED fail) and zero read NOT PROVEN. The partial
transcript is retained under its own name — [`step-03-red-cases-INTERRUPTED.txt`](step-03-red-cases-INTERRUPTED.txt) —
with a closing note stating the same thing, rather than being quietly replaced
by a re-run.

**The kill skipped the runner's `finally` block, so it left the tree dirty**, and
that is worth recording because it is the failure mode a future interrupted run
will also have:

| Left behind | Found by | Action |
|---|---|---|
| `apps/api/src/http/routes/schedule-views.route.ts` carrying `draft-invisibility`'s violation (the published-only predicate removed) | `git status` | reverted with `git checkout --` and the diff read first to confirm it was the arm's own patch |
| `packages/contracts/dist/src/__red_case__type.*` (4 compiled artifacts) | `find -name '__red_case__*'` | deleted; `tsc -b --force` re-run |
| 151 tracked screenshots + 7 SBX transcripts rewritten by the earlier `SP_EVIDENCE_REFRESH=1 check` | `git status` | **all reverted.** They belong to accepted M2/M3/M4-003 bundles; overwriting them with this packet's rendering would rewrite accepted evidence as a side effect. Only EV-M4-004's own fourteen captures are kept |

`git status` was confirmed clean — nothing but this bundle — before the commit
that carries this file.

### `pnpm fixture-regression` — NOT RUN

Not started. On this repository it runs the whole api suite thirteen times at
fixed seeds, once at a fresh rotating seed, and then every test file alone; at
the ~4-minute full-suite cost measured in step 2 that is hours, and the session
budget ended first. **Nothing is claimed about order-independence for the four
new test files.**

Two things reduce, but do not remove, the risk:

- `builds-e2-quality` uses `ownedMulti` with its own slug and its own fixture
  instance (FAD-15 layer 2), and takes a fresh fortnight-wide period per
  fixture — D-2 refuses overlapping periods, and a shared or merely adjacent
  window is the exact defect M4-003's D-4 found at seed 424242;
- the three solver/domain/web proof files are pure or worker-driven and write no
  tenant row at all.

Neither is a substitute for the sweep, and the sweep is the thing that has
actually caught this class twice in this repository.

### The continuation, precisely

1. `corepack pnpm red-cases` to completion — 58 arms, expected **58/58 proven**,
   with `SP_SOLVER_WORKER_COMMAND` set. Budget hours, not minutes; the arms whose
   commands are `gate:unit` cost ~8 minutes each.
2. `corepack pnpm fixture-regression` — fresh rotating seed; a rotating-seed
   failure is a **defect to fix and a seed to adopt**, never a flake to retry
   (FAD-15 ruling 3).
3. Re-run `pnpm check` afterwards if either of the above changes a file.

---

## 8. Completion — the two outstanding batteries, run to the end

The §7 continuation, executed in order, each one read and verified before the next
was launched (the runbook's never-chain rule). **Nothing in the implementation
changed**: both batteries passed as they stood, so no repair was forced and — per
item 3 above — **`pnpm check` was correctly NOT re-run**, because re-running it would
have proven nothing about a tree no commit had touched.

| # | Command | Result | Wall clock | Transcript |
|---|---|---|---|---|
| 08 | `SP_SOLVER_WORKER_COMMAND=… corepack pnpm red-cases` | **58 case(s): 58 proven, 0 not proven** · `RED-CASES EXIT=0` | 78 min (02:45:47Z → 04:04:23Z) | [`step-08`](step-08-red-cases.txt) |
| 09 | `SP_SOLVER_WORKER_COMMAND=… corepack pnpm fixture-regression` | **146 run(s): 146 passed, 0 failed** · `FIXTURE-REGRESSION EXIT=0` | 57 min (04:06:29Z → 05:03:26Z) | [`step-09`](step-09-fixture-regression.txt) |

`SP_EVIDENCE_REFRESH` was **not** set on either run. That is deliberate: the earlier
session's refresh run rewrote 151 tracked screenshots belonging to accepted M2/M3/M4-003
bundles and had to revert all of them. A plain run writes to scratch (NR-14), so the
accepted evidence could not be touched as a side effect of proving this packet.

### 8.1 The battery: 58/58, including the five new arms

Zero `NOT PROVEN`, zero `GATE FAILED`, zero `GATE STILL PASSED — decorative`, and zero
occurrences of vitest's `No test files found` — so **no arm needed a serial re-run**,
and none of the M4-001S transient signatures appeared. All 58 arms both started and
finished.

The five arms this packet added now carry battery proof on top of the standalone
both-directions verification already recorded in [§4a](#4a-the-five-new-red-arms-both-directions-standalone-fad-331):

| # | New arm | What a green reading would have hidden |
|---|---|---|
| 54 | `solver-objective-scale-drift` | the scaling factor drifting on one side of the language boundary |
| 55 | `solver-t2-false-minimality` | `EXPLAINED_MINIMAL` claimed by a loop that never ran a probe |
| 56 | `solver-progressive-pin-unfixed` | a protected assignment free to move while the record said it was pinned |
| 57 | `builds-comparability-unenforced` | two incomparable results rendered side by side as comparable |
| 58 | `builds-optimality-wording` | a merely-FEASIBLE result described as optimal |

**Pre-battery machine check (standing note 2, M4-001S).** The run was launched at
1-min load **5.82** after waiting ~14 minutes for it to fall from 12.6; it finished at
**5.62**. The load spike was ordinary interactive browser activity, explicitly not the
wedged-daemon/Spotlight-storm shape — `mediaanalysisd`, `photoanalysisd` and the `mds`
family were all at 0.0–0.2% throughout. `fixture-regression` was launched separately at
load **4.87**, after step 08's result had been read.

**How the interruption was prevented from recurring.** macOS has no `setsid(1)`, so both
batteries were launched through a double-fork + `os.setsid()` into a **new session and
process group**, with the transcript and its `EXIT=` marker written *inside* the
redirected block. That last detail is what makes a completed run distinguishable from a
killed one **by reading the transcript alone** — the property §7's capture had to assert
in prose because the file itself could not show it.

### 8.2 One real finding: the tree-clean check alone would not have caught this

After the battery, `git status` was clean apart from the new transcript — the runner's
`finally` correctly restored `schedule-views.route.ts`, which the killed run had left
patched. But **four compiled artifacts remained**:

```
packages/contracts/dist/src/__red_case__type.{js,d.ts,js.map,d.ts.map}
```

The `typecheck` arm injects `packages/contracts/src/__red_case__type.ts`; `revertViolation`
deletes that **source**, but `tsc` has by then emitted into `dist`, and `dist` is
gitignored. **So `git status` reads clean while stale compiled artifacts survive a
completed, successful run** — this is not an interruption artifact. It is why the packet
specifies `find … -name '__red_case__*'` as a check *separate from* tree-cleanliness, and
why "the tree is clean" is not a sufficient statement of post-battery hygiene.

Cleared and re-verified: the four files removed, `tsc -b --force` re-run (`EXIT=0`), and
`find packages apps -name '__red_case__*'` now returns **0** with no source survivors.
Runner hardening — emitting into a scratch `outDir`, or sweeping `dist` in `revertViolation` —
is a candidate for M4-005 beside the existing `No test files found` item (NR-16 / review R-2);
it is **not** done here, because the runner is outside this packet's included paths.

### 8.3 The order-independence question, answered

§7 stated plainly that **nothing was claimed** about order-independence for the four new
test files. It is now claimed, and here is the evidence for it:

- **Rotating seed: `86212`** — drawn fresh this run, under both `--sequence.shuffle.files`
  and `--sequence.shuffle.tests`, **passed**. The seed is recorded because a rotating-seed
  pass is only meaningful if the number it drew is on the record; had it failed it would
  have been a defect to fix and a seed to adopt into `FIXED_SEEDS` (FAD-15 ruling 3), never
  a retry.
- **13 fixed seeds** — all passed, each 1353 passed / 14 skipped.
- **The standalone sweep** — every api test file alone, including the three new ones:

| File | Standalone |
|---|---|
| `builds/e2-quality-and-credits.test.ts` | 7 passed |
| `solver/e2-objective.test.ts` | 16 passed |
| `solver/deterministic-cost.test.ts` | 14 skipped (opt-in by design, §4) |

- The gate's own closing statements: *"Order-independent under every seed tried"*,
  *"Every file also passes alone"*, *"The shared baseline was unmodified in every run"*.

§7's two mitigating arguments — `ownedMulti` with its own slug, and a fresh fortnight per
fixture from a monotonic counter — are now **confirmed** rather than merely argued. The
counter is what makes the isolation order-insensitive: shuffling changes which label draws
which window, never whether two windows overlap. That was the right design, and it is
worth saying that the sweep, not the design argument, is what establishes it.

### 8.4 Final state

| Check | Result |
|---|---|
| `git status` | clean — only this bundle's own files |
| `find packages apps -name '__red_case__*'` | **0** |
| Running test processes / cluster daemons | **0** — no orphaned embedded-postgres holder on this worktree's derived port |
| Migrations | 0001–0018 still byte-untouched; no schema change anywhere in this packet |

### 8.5 What is still not claimed

The completion of these two batteries changes nothing in [§6](#6-standing-limitations)
except item 7. In particular: no band is set by anything here, the tier weights remain a
weighted sum rather than a lexicographic priority, the deterministic-cost table remains a
one-run-per-class **measurement** on CPython 3.9.6 rather than a benchmark or
a product band, and T2 still claims only local minimality. A green battery proves the
gates bite; it does not upgrade a measurement into a threshold.

---

## 9. Repair round — FAD-46 (review verdict REVISE)

Base rebased onto `b84977f` (FAD-46). Reviewer probes: `review/m4-004` @ `91813df`.
The independent review found three blocking defects and ten conditions; what follows
is what each one was, what was done, and — for two of them — what was **not**.

### 9.1 Blocking

| # | The defect, stated plainly | Repair |
|---|---|---|
| **F-01** | The differences section was ungated by the comparability verdict. An empty projection — empty because **no comparison was performed** — fell through to "These candidates place everybody identically", printed directly beneath the notice saying they could not be compared. The reviewer's own retained screenshot showed both sentences at once and AC-35 walked past it | Gated. AC-35 asserts the identical-claim **ABSENT** at both viewports and on both refusal reasons. Absence is the assertion: asserting the replacement wording alone would pass with the contradiction still above it |
| **F-02** | `builds.route.ts` builds `quality` unconditionally and the page tabulated it **side by side under "cannot be compared"**. One column each is the arrangement that says *compare these* | The side-by-side table is gated on the same verdict. Per-candidate measurements still render, **separately**, each labelled with the objective it was measured under — a candidate's own measurement is not invalidated by an incomparable sibling. AC-23 gains the positive control, without which deleting the comparison outright would satisfy both refusal tests |
| **F-03** | `demand_satisfaction_rate` was `min(assignments.length, requiredSlots) / requiredSlots` — a **count**, never matched to cells. A candidate placing the right NUMBER of people on entirely the wrong dates scored `1`, and the `unmet-demand` conflict is raised by reading that same number, so the conflict that exists to catch it was suppressed by the same arithmetic | Measured per **date × shift-type cell** (RK-RULING-01), each cell capped at its own requirement, in the new `packages/domain/src/rules/demand-coverage.ts`. An over-staffed Monday can no longer pay for an unstaffed Tuesday |

**F-03's second half — the D-4 lesson.** Demand was enforced in exactly one place:
the model's `sum(cells) == required`. The guarantee rested on the solver continuing
to post a constraint **nobody else measured**. The independent checker now measures
it and is entitled to disagree, refusing both a shortfall and a cell nobody asked for
(the model constrains both, for the reason it states: a day left deliberately empty
must not be fillable). New red arm **`solver-demand-not-independently-checked`**
drops the constraint from the **MODEL ONLY** — nothing in the checker is touched —
and the checker catches it. Verified by hand in both directions before registration;
the red reading is `expected [ 'demand-not-met' ] to deeply equal []`. **The battery
is now 59 arms.**

**A finding about the probe, disclosed.** The reviewer's `probe-04` reads `cell.date`.
`SnapshotDemandCell` carries no `date` — the field is **`on`** (it is a weekday token
for a `weekday-default` and a date for a `period-requirement`). Under the old
count-based metric that read `undefined` and still scored `1`, which is why a probe
written specifically to catch this defect caught only half of it. The pins here use
`on` and say so. **The delta review should expect probe-04's case 1b to fail until the
probe reads `on`** — that failure would be the probe's, not the repair's.

### 9.2 Conditions

| # | Disposition |
|---|---|
| **F-04** | The disclosure quoted EV-M0-SPC H-7's **toy-instance** figures ("12× slower … faster on a hard one") to a scheduler deciding whether to enable the mode *on this system*. Replaced with this packet's own measurement: ≈1× on the startup-dominated classes, ≈10× on the one class large enough to search (where it returned FEASIBLE where best-effort proved OPTIMAL). H-7's faster half is **not reproduced by this corpus and is therefore not claimed**. AC-34 asserts 10× present and 12× **absent** |
| **F-05** | Closed by FAD-46's **second** option, because the positivity contract genuinely exists rather than being hoped for: `validate.ts` refuses a SOFT weight `<= 0`. The "arithmetically identical" claim is corrected — on negative half-values `Math.round(-0.5)` is `-0` while the worker's branch yields `-1` — the contract is cited, and the contract is now **pinned**. An unreachable divergence resting on a contract nobody asserts is one refactor from reachable |
| **F-06** (RULED) | PO-DEC-23 is **RESOLVED**. Fifteen surfaces said "pending"; they now say no band exists **until the M6 benchmark**, which is the operative fact that keeps every "no threshold" statement true. **One deliberate exception:** `deterministic-cost.test.ts` quotes the packet's own wording verbatim. A quotation is not this file's claim, and rewriting it would falsify a citation — it stands, with the resolution recorded beneath it |
| **F-07** (RULED) | Recorded as a **semantic change**, in §9.4 below and in the limitations — not as "preserved order" |
| **F-08** | `_minimise` was passed the clock from the top of `explain()`, so T0 and all of T1 were charged against T2's allowance while `tier2.budgetSeconds` recorded the full 60% share. A long T1 left T2 with a fraction of the budget the record claimed, and `EXPLANATION_BUDGET_EXCEEDED` then reads as a hard problem when the clock was already spent. T2 now times from **its own start**, which is what makes the recorded allowance true |
| **F-10** | The platform does not send `explanationBudgetSeconds`, so every explanation runs under the worker's 5.0 s default. **Documented at the site rather than plumbed**: the budget is a solver parameter and the configuration surface that would own it is outside this packet's included paths. The response reports the allowance actually used, so no reader is told a number the run did not honour |
| **F-11** | The `load average 3.4` claim beside the cost table is **removed**. No transcript records that reading and it cannot be reconstructed after the fact; an unbacked number makes a measurement look more controlled than it was |
| **F-12** | Recorded as an M4-005 UX item in §9.5. Not implemented here |
| **F-13** | "Explanation time" printed "no explanation was attempted" from a missing **latency** — a claim about whether the worker *ran* one, made from the absence of a measurement, and contradicting a populated T2 record rendered directly below it. It now reads "not recorded" |

### 9.3 F-09 — the phantom citation, and the three the sweep found beside it

`selection.ts` cited **`credits-into-build-draft.test.ts`**, a file that does not
exist. The real proof is `e2-quality-and-credits.test.ts`. Retargeted — **that one
citation only**; every FAD and doc citation in the file is untouched, because a
citation "fixed" by guessing would look authoritative while being wrong, and rule 13
exists precisely because a silently-changed reference still reads as correct.

Then the M4-001 **N-5 discipline**: rather than fix the one instance and declare the
class closed, every backtick-cited test filename in `apps/*/src`, `packages/*/src`,
`solver` and `scripts` was resolved against the filesystem. **Three more phantoms**,
one of them in a file this packet authored:

| Citing file | Phantom | Real proof | How the target was confirmed |
|---|---|---|---|
| `packages/domain/src/rules/objective.ts` | `objective-profile.test.ts` | `e2-objective-and-quality.test.ts` | carries the exact asserted equality the comment claims: `expect(rendered).toBe(canonicalStringify(E2_OBJECTIVE_PROFILE))` |
| `apps/api/src/builds/readiness.ts` | `readiness.test.ts` | `outcome-and-readiness.test.ts` | carries `describe('readinessFindings — T0, and the codes are the worker's own')` and the same `no_eligible_member` rationale, sentence for sentence |
| `apps/api/src/builds/errors.ts` | `fencing.test.ts` | `lifecycle.test.ts` | carries `describe('claim fencing')` **and** `describe('the database controls, driven directly')` — which is the claim verbatim |

Each target was confirmed by **reading the assertion the comment claims exists**, not
by name similarity. Name similarity is what produced `readiness.ts` → `readiness.test.ts`
in the first place. Every citing file is inside this packet's included paths.

**The sweep, restated at the scope it actually checked** (F-09 addendum, delta review).
The round-3 claim "20 cited test filenames, 0 missing" was true but read wider than it
was: it swept **bare basenames** only.

| Scope | Cited | Unresolvable |
|---|---|---|
| Bare basenames (`` `foo.test.ts` ``) — the form all four repaired phantoms took | 20 | **0** |
| Full-path citations (`` `apps/api/test/…/foo.test.ts` ``) — **not swept in round 3** | 74 | **9** |

The nine are listed below and are **deliberately NOT retargeted**: every one is a
pre-packet M1–M3 citation, outside this packet's authorship and outside its writable
glob. Repairing another packet's comments under this packet's finding number would put
changes in a diff nobody reviewed for them.

```
apps/api/test/architecture/evidence-target.test.ts
apps/api/test/authn/{clock-seam,cookie-posture,no-disclosure,password-hashing,totp}.test.ts
apps/api/test/solver/snapshot-contract.test.ts
packages/contracts/test/schedule/calendar-agreement.test.ts   (basename lives at apps/api/test/schedule/)
packages/domain/test/catalogue/display.test.ts
```

Recorded for **M4-005's hygiene sweep**. The correction matters more than the count: a
sweep reported at a wider scope than it ran is the same defect class as a citation that
points at nothing — a true statement that a reader will reasonably take further than it
goes. The check itself is still one line of shell; the class was invisible for four
packets because nobody ran it, not because it was hard.

### 9.3b NOT done — escalated rather than guessed

**Nothing remains outstanding.** F-09 was initially escalated rather than guessed:
FAD-46 recorded it as "fix the `selection.ts` citation" without naming which one, and
the file carries several plausible FAD and doc citations. The reviewer's original
finding text — which the adjudication had compressed — identified it as the phantom
TEST FILE, and it is repaired in §9.3 above. The escalation is recorded because
stopping was the right move: the FAD/doc citations were the tempting target and every
one of them would have been the wrong thing to change.

### 9.4 F-07 — E2-R1's ratio change, recorded as a semantic change

E1 used the multipliers **30 / 20 / 10** for fairness / work-percentage / preference.
`e2-default-v1` uses **100 / 10 / 1**. FAD-46 RATIFIES this as the E2 profile, and it
must be recorded for what it is: **the tier ORDER is preserved, the RATIOS are not.**

Under E1, ten preference violations outweighed three fairness violations (300 vs 90).
Under E2 they do not, and cannot: one fairness violation now outweighs any ten
preference violations. Describing that as "E1's ordering made explicit" — as §2 of this
bundle originally did — is true about the order and silent about the trade-off, which
is the half a scheduler would actually notice. The profile is versioned by `profileId`
and digest-enforced, so results either side of the change are refused as incomparable
rather than silently ranked together.

### 9.5 Recorded for M4-005

- **F-12:** `solverStatus` is not surfaced on the build **list** or the **comparison**,
  only on the detail screen. A merely-FEASIBLE candidate is therefore indistinguishable
  from a proven-OPTIMAL one at the point of choosing between them — no wording claims
  optimality (the status-conflation arm still holds), but the distinction is absent
  where it matters most. A UX item, not a correctness defect.
- The red-case runner leaves `packages/contracts/dist/src/__red_case__type.*` behind
  after a **successful** run (§8.2), invisible to `git status` because `dist` is
  gitignored.

### 9.5b The raw-NUL gate caught this round's own new file — a fourth recurrence

The first `pnpm check` of the repair round came back **16/17, `raw-nul` FAIL**:

```
packages/domain/src/rules/demand-coverage.ts: 2 raw U+0000 byte(s) at offset(s) 4290, 6406
```

`demand-coverage.ts` is the file this round created for F-03. Its cell key is
`` `${date}<NUL>${shiftTypeId}` `` — U+0000 is the right separator, because neither a
`YYYY-MM-DD` date nor a uuid can contain one, so no two distinct cells can collide
(`candidate-validation.ts` keys the same way for the same reason). It was written as a
**raw byte** instead of the `\x00` escape. The escape produces a byte-identical string,
so there was never a trade-off — just a wrong spelling that is invisible in every editor
and every diff.

This is the **fourth** occurrence of the class. FAD-45 mandated the gate as gate 17 on
the third, over the objection that a scan for one byte is a lot of machinery. It then
caught the fourth **the first time it ran against new code**, with the exact path, the
exact offsets, and the fix in the message — before a reviewer, and before the byte could
reach a corpus hash. Fixed by escaping both sites; the pinned baseline is back to its
three known violations at their pinned counts.

Recorded here rather than quietly repaired because a gate's value is only visible when
somebody writes down the thing it caught.

### 9.6 What this round did NOT change

No migration, no new table, no schema change of any kind — **so the SBX sweep and the
migration cycle are deliberately NOT re-run**, and nothing here claims a fresh reading
for either. The M6 band position is unchanged: PO-DEC-23 being resolved sets targets,
not bands, and no surface added here renders a threshold, a rating, or a colour.

---

## 10. Delta review round — ACCEPT WITH CONDITIONS

Reviewer probes `review/m4-004` @ `1d898d6` (probe-11 for F-14). The three round-1
blockers were verified repaired by the reviewer's own execution. One new MEDIUM had to
land before merge, plus two record corrections and a scope restatement.

### F-14 (BLOCKING) — a refusal that could not be reported

`demand-not-met` was added to `candidate-validation.ts` and to **nothing else**. Round
1's fifth reason, `protected-assignment-dropped`, had gone into **three** places — the
validator, `views.ts`'s `rejectionsOf` allowlist, and `buildRejectionSchema`. The sixth
went into one.

The allowlist **fails closed**: an unlisted reason is `continue`d away. That is right for
a forged row and catastrophic for a real one, because the candidate is *still refused* —
`rejections` arrives empty, the client renders nothing, and a scheduler is told a
candidate was rejected for no stated reason. Worse, the case it hides is the quiet one:
an over-staffed candidate scores `demandSatisfactionRate = 1` and raises **no**
`unmet-demand` conflict, so the rejection reason was the *only* thing that would have
said what was wrong.

Added to both remaining places. **Pinned as a four-link chain**, each link asserted
separately — a chain tested only end to end tells you it broke, not where:

| Link | Assertion |
|---|---|
| 1. validator | produces `demand-not-met` with a non-empty detail |
| 2. contract | `buildRejectionSchema` parses it (and parses it stated positively, so a rename cannot pass by making the loop empty) |
| 3. read path | `rejectionsOf` carries it — **and** still drops an invented reason, so the allowlist is not merely widened |
| 4. the class | **every** reason the validator can emit round-trips both the schema and the read path — the assertion that would have caught F-14 when the sixth reason was added, and that will catch the seventh |

`rejectionsOf` was exported to make link 3 falsifiable; the read path is exactly where a
reason goes missing, and an unexported function there is an untestable one.

**Both directions, by mutation:** reverting the read-path allowlist fails link 3 with
`expected [] to include 'demand-not-met'` — the F-14 symptom verbatim; reverting the
contract enum fails 12 of 26. The UI needed no change: `BuildDetailPage` renders
`rejection.reason` and `rejection.detail` directly, with no label table, so there is no
missing-key blank one layer further on. That was checked rather than assumed.

**One judgment recorded, not acted on:** `conflictClassOfRejection` maps any unrecognised
reason to `hard-breach`, so `demand-not-met` lands there rather than in PO-DEC-13's
`unmet-demand` class. `unmet-demand` is arguably the more precise class for a *shortfall*
— but the same reason string also carries the *overfill* case, which is not unmet demand
at all, and a rejected candidate never reaches the conflict surface as a usable one. Left
as `hard-breach` and flagged rather than silently re-mapped.

### F-15 — a true sentence in another document's mouth

The round-2 repair put "**PO-DEC-23 is RESOLVED**" *inside* a `>` blockquote attributed
to **SPEC-04 §7**, whose actual line reads "remain pending". The statement was true and
the attribution was false, which is the worse of the two failures: it is unfalsifiable by
anyone who trusts the citation, and it makes a spec appear to say something it does not.

The quotation is restored verbatim and the correction now sits **outside** it, attributed
to `docs/fable/21-decision-resolution.md`. SPEC-04 is outside this packet's writable
glob, so **the spec's own line stays stale** — recorded here rather than worked around.

### F-16 — three survivors against §9's own claim

`INDEX.md` lines 58, 153 and 199 still said "PO-DEC-23 pending" while §9 claimed the
class was closed. Fixed; **0 remain**. The one deliberate exception is unchanged and
restated: `deterministic-cost.test.ts` quotes doc 35 verbatim, and a quotation is not the
quoting file's claim.

### F-09 addendum

The sweep claim is restated at the scope it actually ran — see §9.3. Nine pre-packet
M1–M3 full-path phantoms exist and are recorded for M4-005 rather than retargeted.

### What was re-run for this round, and what was not

| Gate | Run? | Why |
|---|---|---|
| F-14 chain pin, standalone + both mutants | **yes** | it is the finding |
| `check` | **yes** | the diff touches a contract enum, a read path, a test and comments |
| `red-cases` — demand arm + anchor check | **yes, scoped** | see below |
| `fixture-regression` | **no** | a contract enum addition, an allowlist addition and comments cannot change test ordering, fixture isolation, or shared state. Nothing in the diff writes a tenant row |
| `sbx`, migration cycle | **no** | no migration, no table, no RLS change — the same reason as round 1, unchanged |

**The red-case anchor check.** The runner patches files by exact-string anchor and
*throws* if an anchor is missing, so a source edit can silently disarm an arm. Both files
this round touched were checked against every arm's anchors before scoping the run.
