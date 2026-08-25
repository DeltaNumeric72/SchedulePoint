# EV-DOC38-GATE — doc 38 §7 validation battery evidence (updated per leg group)

**Scope.** Legs 1–4 of the required final validation battery defined by
[`docs/fable/38-post-m4-internal-review-plan.md`](../../fable/38-post-m4-internal-review-plan.md)
§7, as amended 2026-08-23 (FAD-53, repair packet R-3, finding REV-A-002 — the sixth
battery item split into a schema cycle and six named populated cycles, range extended to
0001–0020).

Group A covers the docs validators, the gate battery, SBX, and both migration-cycle
halves. It does **not** cover the remaining §7 items (red-case battery,
`fixture-regression`, real-stack e2e at both viewports, fresh-clone validation against
`origin/main`, GitHub CI on `main`).

| Field | Value |
| --- | --- |
| Repository | `/home/user/SchedulePoint` (main tree) |
| HEAD | `85efa2b2ffb8dc2b53c2a47d2a8ac7bbd73678af` |
| Tree at start | exactly clean (`git status --porcelain` empty), verified before any leg ran |
| Tree at end | clean except this untracked evidence directory |
| Execution | strictly serial, in leg order; no leg overlapped another |
| Window (UTC) | 2026-08-24T11:21:48Z → 2026-08-24T11:57:10Z |
| Modifications | none — every command run as shipped; no gate, config, script or test was edited |
| Retries | none — no leg was re-run (FAD-15 ruling 3) |

---

## Leg results

| Leg | Command | Start UTC | End UTC | Exit | Headline counts | Verdict | Transcript |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1a | `python3 docs/fable/validate.py` | 11:21:48 | 11:21:48 | 0 | **36 assertions, 36 passed, 0 failed** | PASS | [`leg1-validators.txt`](leg1-validators.txt) |
| 1b | `python3 docs/architecture/validate.py` | 11:21:48 | 11:21:48 | 0 | **95 assertions, 95 passed, 0 failed** | PASS | [`leg1-validators.txt`](leg1-validators.txt) |
| 1c | `bash schedulepoint-research/validate.sh` (from the repository root) | 11:21:48 | 11:21:48 | 0 | **PASS** — all required files and directories present and non-empty; `manifest.json` parses | PASS | [`leg1-validators.txt`](leg1-validators.txt) |
| 2 | `corepack pnpm check` | 11:21:58 | 11:54:36 | 0 | **17 gate(s): 17 passed, 0 failed**; unit 2199 passed / 14 skipped over 173 files; axe 430 passed / 16 skipped; request-budget 44 interactions, 87 recordings | PASS | [`leg2-check.txt`](leg2-check.txt) |
| 3 | `corepack pnpm sbx` | 11:55:29 | 11:55:50 | 0 | **required 9 · executed 9 · passed 9 · failed 0 · blocked 0 · vacuous 0 · probe-error 0 · not-runnable 0**; **371 readings** across 7 contexts; **0 wrong-tenant rows**; **53 of 53 tables** observed with visible rows; all 9 probes FALSIFIABLE; audit chain 0 problems / 0 checkpoint problems on all three chains | PASS | [`leg3-sbx.txt`](leg3-sbx.txt) |
| 4a | `corepack pnpm --filter @schedulepoint/api migrate:cycle:embedded` | 11:56:26 | 11:56:31 | 0 | **0001–0020 applied BY NAME on an empty database**; `MIGRATION CYCLE CLEAN — up -> down -> up -> down -> up, 2838ms` | PASS | [`leg4a-schema-cycle.txt`](leg4a-schema-cycle.txt) |
| 4b | `node scripts/gates/vitest-must-run.mjs` over the six named populated-cycle test files | 11:56:59 | 11:57:10 | 0 | **6 test files passed (6), 9 tests passed (9)** — migrations 0014, 0016, 0017, 0018, 0019, 0020 | PASS | [`leg4b-populated-cycles.txt`](leg4b-populated-cycles.txt) |
| 5 | red-case battery, 67 arms both directions — **adjudicated in §7's PRIMARY form: sharded CI + union guard** (FAD-54; two serial local attempts terminated by a session-environment cap with ZERO arm failures, 15 arms proven both directions) | 12:01:19 | 12:59:19 (CI run 32724748023) | all jobs success | CI runs 32716033514 (`85efa2b`) and 32724748023 (`007dfef`): 13 shards + `red-case shard completeness`, every job success, attempt 1 | PASS (FAD-54) | [`leg5-red-cases.txt`](leg5-red-cases.txt) · [`leg5-adjudication.txt`](leg5-adjudication.txt) |
| 6 | fixture-regression per-seed (13 fixed + rotating; nightly argv + `--no-cache` per R-9) — **STOPPED AT A DEFECT after 8 of 14 runs** (FAD-15 ruling 3): seeds 1/7/42/424242/20260803/31337/99991 PASS (141 files / 1460 tests each, 14 known env skips), seed **123456 FAIL** — `test/tenancy/unit-of-work.test.ts` T-15 storm timed out at 120 000 ms at position 111/142; cost linear in inherited partitions (R²=0.9892), 0 wrong-tenant rows everywhere; routed as **R-13**; the item re-runs in full on the repaired tip | 13:44:10 | 16:31:01 | mixed (7×0, 1×1) | see the RISK-REGISTER group-C entry | STOPPED — defect routed | `leg6-seed-*.txt` (8 files, uncut) |
| 6b | fixture-regression FULL RE-RUN on the repaired tip `149edee` (13 fixed seeds + rotating 467407, per-seed, nightly argv + `--no-cache`) — **14 of 14 GREEN**, every run exactly `141 passed / 1 skipped` files and `1461 passed / 14 skipped` tests (the sole skip the shipped `deterministic-cost` opt-in default); rotating seed found no new coupling; the T-15 NR-23 series recorded per run (calibrated 14.83–54.83 ms/pass, storm 21 250–132 961 ms, fraction ≤ 0.35, floor bound once); **seeds 740673 AND 123456 both exceeded the old fixed 120 000 ms deadline** — the pre-R-13 tip carried a second latent failure never before observed | 19:40:10 (24th) | 00:26:54 (25th) | 14 × 0 | 16 989 s measured wall across 14 runs; seed-1 attempt 1 killed by a container idle-pause (no verdict; moved aside, re-run clean) | PASS | `leg6b-seed-*.txt` + `leg6b-rotating-seed-467407.txt` (14 files, 7.68 MB) |
| 7 | real-stack critical-path e2e, both viewports (`gate:build` + playwright `e2e/real-stack.config.ts`, `SP_SOLVER_WORKER_COMMAND=solver/.venv/bin/python3` per the config docblock) — **2/2 PASS, full 14-step reach**, real CP-SAT logged, all 12 axe sites clean, request-budget ledger 9 lines per project (8/9 identical to the M4-005 reference; final step 2 vs 1 explained by the FAD-50 C-2 repair counting the refetch), must-run reporter genuine (executed=2). **Attempt 1 preserved**: run WITHOUT the env var per an erroneous orchestrator packet — the production path has no venv discovery (`SP_SOLVER_WORKER_COMMAND ?? 'python3'`), bare python3 lacks ortools, solve died post-auth, build FAILED, fail-closed held ("candidate REFUSED"); an invocation gap, not a tree defect, registered as a post-gate follow-up (silent FAILED vs a named refusal) | 00:30:36 | 00:37:02 | attempt 1: 1 · attempt 2: **0** | desktop 18.0s / mobile 13.7s, 48.4s total | PASS | `leg7-build.txt` · `leg7-real-stack.txt` · `leg7-attempt1-*.txt` |

**Group A verdict: 4 of 4 legs PASS. No failure, no defect, no deviation from the
shipped commands.**

---

## Leg 2 — gate detail

Every gate passed. Durations are **this machine's** and are recorded for interest only,
not as thresholds.

| Gate | Result | This machine |
| --- | --- | --- |
| lint | PASS | 19 682 ms |
| typecheck | PASS | 27 961 ms |
| unit | PASS | 1 265 255 ms |
| import-boundary | PASS | 2 468 ms |
| route-policy | PASS | 1 526 ms |
| migration-rls | PASS | 601 ms |
| invariant-ids | PASS | 646 ms |
| rule-node-mapping | PASS | 615 ms |
| rule-kind-registry | PASS | 738 ms |
| provider-boundary | PASS | 590 ms |
| solver-kind-parity | PASS | 580 ms |
| secret-scan | PASS | 1 906 ms |
| raw-nul | PASS | 832 ms |
| build | PASS | 3 587 ms |
| network-guard | PASS | 577 ms |
| axe | PASS | 628 901 ms |
| request-budget | PASS | 618 ms |

Wall clock for the leg: ~32.6 minutes on this machine.

### Solver tests executed, not skipped

The solver venv (`solver/.venv`, OR-Tools 9.15.6755) was present and the real CP-SAT
suites executed rather than skipping:

- `test/solver/e2-objective.test.ts` — **28 tests**, 719 233 ms
- `test/solver/corpus/corpus-agreement.test.ts` — **9 tests**, 110 361 ms
- `test/solver/real-solve-lifecycle.test.ts` — executed (S-05t deadline, S-06t
  mid-solve cancellation + uncancelled control, S-07t kill, S-08t bit-identical
  reproducibility)

---

## Leg 4b — the six populated cycles, by name

| Migration | Test file | Tests |
| --- | --- | --- |
| 0014 | `apps/api/test/schedule/migration-0014-populated-cycle.test.ts` | 1 passed |
| 0016 | `apps/api/test/solver/migration-0016-populated-cycle.test.ts` | 1 passed |
| 0017 | `apps/api/test/profiles/migration-0017-populated-cycle.test.ts` | 1 passed |
| 0018 | `apps/api/test/builds/migration-0018-populated-cycle.test.ts` | 2 passed |
| 0019 | `apps/api/test/builds/migration-0019-populated-cycle.test.ts` | 2 passed |
| 0020 | `apps/api/test/builds/migration-0020-populated-cycle.test.ts` | 2 passed |

Run through the shipped zero-match guard `scripts/gates/vitest-must-run.mjs` — the same
wrapper `gate:unit` uses — so an invocation that selected nothing would have failed
rather than exiting 0. It reported 9 executed tests, so the selection was real.

The api project is serial by construction (`fileParallelism: false`, `singleFork`), which
is what makes it safe for these files to roll migrations down and back up on the shared
cluster.

---

## Observations (facts for adjudication — none is a failure)

1. **`corepack pnpm sbx` matches every recorded figure exactly.** Required 9/9, 371
   readings, 0 wrong-tenant, 53/53 tables. **No drift** against the figures recorded in
   PROJECT-STATUS and EV-M4-005 §24.

2. **Unit-test count has grown since the M4 close battery**: 2199 passed here against
   **2153** recorded at M4 close. §7 pins no unit count, and the growth is consistent
   with the repair packets merged after that record. Recorded as a fact, not as drift
   against a §7 requirement.

3. **Migration range.** The M4 close record says "0001–0019 clean by name". This run
   observed **0001–0020**, which is what §7 demands as amended by FAD-53 (0020 added by
   repair packet R-5). The amended requirement is met.

4. **14 skipped unit tests, all in one file, opt-in by design.**
   `apps/api/test/solver/deterministic-cost.test.ts` is
   `describe.skipIf(!ENABLED)` behind `SP_MEASURE_DETERMINISTIC_COST=1` (its own docblock
   calls it a measurement nobody should record by default). It is a cost-measurement
   suite, not part of the §7 battery, and it was left at its shipped default. Not a
   suppressed solver test.

5. **16 skipped Playwright tests are per-viewport project guards.** They are
   `test.skip(info.project.name !== 'desktop' | 'mobile', …)` — a desktop-only assertion
   skipping in the mobile project and vice versa. Each such test does execute, in its own
   project. The axe gate reported 430 passed.

6. **SBX `EVIDENCE_BLOCKED` sub-scenarios are declared, milestone-scoped, and shipped
   behaviour** ("never a pass, never a silent skip") — surfaces that do not exist yet
   (impersonation, proxy, picklist, notification delivery, module-with-dependencies) plus
   two design-level exclusions the harness states in full. They do not reduce the 9/9
   scenario result and match the M4 baseline.

7. **`Can't determine timestamp for NNNN` chatter in leg 4a is pre-existing** migration-
   tool output for the repository's non-timestamp migration naming. The same chatter
   appears 260 times in `EV-M4-003/step-11-migrate-cycle-embedded.txt`. Not new, not a
   defect.

8. **No tree modification.** `pnpm check` and `pnpm sbx` both wrote under
   `.evidence-scratch/` and left tracked artifacts untouched, as their own output states.
   `git status --porcelain` after all four legs reports only this untracked evidence
   directory.

---

## Notes on this bundle

- Transcripts carry the `.txt` suffix, binding per doc 38 §3 as amended by R-9.
- Nothing here is committed; the orchestrator commits at adjudication.
- The transcripts reproduce shipped program output verbatim — including the repository's
  own packet-owner identifiers as the harnesses print them. Nothing was redacted, so the
  transcripts remain byte-faithful to what ran.
- No payload body, delivery material, or destination address appears in this bundle. The
  SBX notification arm records intent counts and controlled synthetic sinks only.
- Timing figures are this machine's and are not thresholds.

## Files

| File | Bytes | Contents |
| --- | --- | --- |
| `INDEX.md` | 9 388 | this index |
| `leg1-validators.txt` | 15 287 | all three validators, full output |
| `leg2-check.txt` | 437 607 | `corepack pnpm check`, full output including the 17-gate table |
| `leg3-sbx.txt` | 124 330 | `corepack pnpm sbx`, full scenario report |
| `leg4a-schema-cycle.txt` | 24 116 | the empty-database schema cycle, 0001–0020 |
| `leg4b-populated-cycles.txt` | 5 423 | the six named populated-cycle tests |
| `leg5-red-cases.txt` | 5 235 | the two terminated serial red-case attempts, kept unedited (15 arms proven both directions, zero failures) |
| `leg5-adjudication.txt` | — | the FAD-54 adjudication with full job-level CI citations for runs 32716033514 and 32724748023 |
| `leg6-seed-1.txt` … `leg6-seed-123456.txt` | 4.1 MB total (8 files) | the STOPPED attempt's per-seed runs (pre-R-13 tip); seed 123456 carries the T-15 storm timeout that routed R-13 |
| `leg6b-seed-*.txt` · `leg6b-rotating-seed-467407.txt` | 7.68 MB total (14 files) | the FULL re-run on the repaired tip: 13 fixed + rotating, all green, full uncut output with the R-13 calibration/ceiling/storm lines per run |
| `leg7-build.txt` · `leg7-real-stack.txt` | 1 016 · 8 686 | the passing real-stack e2e under the documented invocation: 14 steps, both viewports, 12 axe sites, budget ledgers |
| `leg7-attempt1-build.txt` · `leg7-attempt1-no-solver-env-real-stack.txt` | 1 016 · 10 056 | the invocation-gap attempt (no solver env): build FAILED fail-closed, candidate REFUSED — probative of the production-default residue, kept unedited |
