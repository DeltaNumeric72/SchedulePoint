# EV-M4-003 — OPUS-M4-003 (build lifecycle and scheduler experience)

**Packet:** [doc 35 §6e](../../fable/35-m4-task-packets.md). **Branch:**
`opus/m4-003-build-lifecycle`, worktree `.worktrees/m4-003`, base `d120ae3`.

Everything below is machine capture. Where a command failed, the failure and its
cause are recorded rather than the re-run alone.

---

## 1. What shipped

| Layer | Content |
|---|---|
| **Migration `0018_build_lifecycle.sql`** | Six tenant tables — `build_configurations`, `build_runs`, `build_run_events`, `build_run_results`, `build_run_violations`, `build_run_candidate_assignments` — each with `ENABLE`+`FORCE` RLS and V-09's conjunctive group policy in the same file, composite tenant+group FKs per 0014's discipline, D-4a and D-4d partial unique indexes, a state-transition guard, a fencing guard, a no-delete guard, and append-only triggers on everything a result is made of |
| **`apps/api/src/builds/**`** | `states.ts` (the sixteen states, the legal edges, the outcome→state mapping), `errors.ts`, `readiness.ts` (SPEC-04 §5's T0, before a solve is spent), `service.ts` (configurations, runs, transitions, supersession, archiving), `claim.ts` (atomic claim, epoch fencing, heartbeat), `runner.ts` (submission, dispatch, one-transaction result persistence, cancellation), `reaper.ts`, `selection.ts`, `views.ts` |
| **`apps/api/src/http/routes/builds.route.ts`** | 15 routes, every one policy-declared, allow AND deny tested |
| **`packages/contracts/src/builds/**`** | The wire shapes, `.strict()` throughout, with the two refusal bodies that carry state |
| **`apps/web/src/builds/**`** | `BuildsLayout` (the state vocabulary, one table), `BuildsPage`, `BuildDetailPage`, `BuildComparisonPage`, `api.ts` |
| **FAD-33(6)** | The dead `setRuleState` export removed from `apps/web/src/api/rules.ts`. Repo sweep after removal: zero references to it; the live four-argument `setRuleState` in `apps/web/src/rules/api.ts` is a different function and is untouched |
| **R-8** | Executed. See §5 |

**Sweep floor raised 48 → 54.** Six new tenant tables, all
`organization-and-group`, all kept non-vacuous by
`apps/api/test/support/builds.ts::seedBuildLifecycleForSweep`, which drives one
whole build per swept group **through the production service**.

---

## 2. Five real defects found by the proofs, three of them by the database-layer arms

Each was found because an arm drove the DATABASE rather than the service, and
each would have shipped as a silent failure.

| # | Defect | How it would have presented | Fix |
|---|---|---|---|
| **D-1** | `app_build_run_transition_is_legal` was `REVOKE ALL … FROM PUBLIC` with no grant, and the trigger that calls it is **not** `SECURITY DEFINER` (deliberately — it must read `build_run_violations` under the invoker's RLS). Every transition would have failed with `permission denied for function` | The entire lifecycle would have been unusable from the application role — but only at run time, and the migration cycle passed clean because a cycle never performs a transition | `GRANT EXECUTE … TO app_runtime, app_worker, app_readonly_support, app_breakglass`, with the reasoning recorded in the migration |
| **D-2** | The reaper's predicate bound its instant as a bare parameter on the left of a subtraction from an `interval`, so PostgreSQL inferred the parameter's type as `interval`: `operator does not exist: timestamp with time zone < interval` | The reaper would have thrown on every invocation. A dead build would have stayed `running` for ever and D-4a would have refused every new build of that configuration | `${now}::timestamptz` |
| **D-3** | **The fencing record was written inside the transaction its own throw rolled back.** The mechanism documented as durable evidence produced exactly nothing | A fenced worker would have been indistinguishable from a worker that never ran — the precise absence the record exists to prevent | `recordSolveOutcome` sequences the refusal and the record in two transactions; `assertClaimIsCurrent` no longer records |

| **D-4** | `builds-http.test.ts`'s `build runs` block shared ONE configuration across its tests via a `beforeAll`. D-4a admits one in-flight build per (period, configuration), so the tests were order-dependent: whichever ran first took the slot | Green in declaration order, red under `--sequence.shuffle`. Found by `fixture-regression`'s shuffled sweep at **seed 424242** and **seed 20260803** — [`step-09c`](step-09c-fixture-regression-FAILED.txt) | A fresh configuration per test. The tolerated `expect([200, 409])` branch that would have hidden it is gone, and the D-4a conflict now has its own explicit arm asserting 409. Both exposing seeds re-run green: [`step-09a`](step-09a-exposing-seed-424242.txt), [`step-09b`](step-09b-exposing-seed-20260803.txt) |

| **D-5** | The FAD-44(2) audit-chain proof ordered `audit_events` by `sequence_number`. That column does not exist — 0003 names it `sequence` | The test errored rather than asserting. **The chain writes themselves were correct**; only the proof's own query was wrong, and the two other audit arms (cancellation, reap) passed throughout | `ORDER BY sequence`. Caught by the repair round's first targeted run — [`step-12`](step-12-fad44-targeted.txt) records it as a failure before the fix |

D-3 is the one worth reading twice. The arm that found it asked the DATABASE
whether the row existed after the call returned, instead of trusting the code
that had just run. D-4 is the one worth reading second: it was invisible to
every run of the suite in its own order, and only the shuffled sweep saw it.
D-5 is the least interesting and is recorded anyway, because a proof that
errored is not a proof that passed and the distinction is exactly what this
bundle is for.

---

## 3. Governing-text rulings applied, and the two departures from report 21's edge table

Both departures are the packet's own rulings (§6e: SPEC-04 supersedes doc 08
§§1–7 wherever they touch), and both are stated in the migration, in
`states.ts`, and in the transition-matrix proof.

| Edge | Disposition | Why |
|---|---|---|
| `infeasible → draft_configuration` | **Absent** | SPEC-04 §2: "a retry is a **new** `build_run` … retries are never in-place". An in-place edge would rewrite the record of a build that really did run and really was infeasible. The retry is a new row carrying `retry_of_build_run_id` |
| `queued → cancelled` | **Present — DISCLOSED as an extension** | Report 21 lists cancellation from `running` only. Without this edge, cancelling a build that has not yet been claimed can only be recorded as `failed` by the reaper — reporting a deliberate human decision as a system fault, which is the conflation SPEC-04 §2 and FAD-34 exist to prevent. The edge is guarded, recorded, and carries `termination_reason = 'user_cancelled'` |

`D-4a`'s "non-terminal" is spelled out as the five **in-flight** states
(`draft_configuration`, `validating`, `readiness_check`, `queued`, `running`)
rather than negated, in both the index and `states.ts`, so a future state cannot
silently join or leave the set. The reading is SPEC-04 §6's own: the index
"prevents duplicate runs of the same configuration", and a settled build is a
past answer rather than a duplicate run.

---

## 4. The sixteen states, mapped

| State | Schema | Service | UI |
|---|---|---|---|
| `draft_configuration` | `build_runs.state` default; row created by `createRun` | `createRun` (idempotent, D-17) | `BuildsPage` launch form (I-13: 0 requests to open); `BuildDetailPage` "Submit for validation" |
| `validating` | transition guard edge | `submitBuild` transaction 1 | state banner + itemised `validationFindings` |
| `readiness_check` | edge; `snapshot_id` bound here | `submitBuild` transaction 2, after assembly | itemised `readinessFindings` (T0 codes, the worker's own) |
| `queued` | edge; D-4a index covers it | `submitBuild` | "Run it now", "Cancel this build" |
| `running` | edge; `claim_epoch` advanced, `claimed_by`/`heartbeat_at` set | `claimQueuedBuild` | cancel confirmation panel (0 requests to open) |
| `completed` | edge; requires a result row | `classifyOutcome`: usable candidate, objective `null` or `0` | quality panel + "I have reviewed the findings" |
| `completed_with_unmet_preferences` | edge | `classifyOutcome`: usable candidate, objective `> 0` | objective-tier table |
| `infeasible` | edge | `classifyOutcome`: `INFEASIBLE` | **"a statement about the problem"** + T0/T1 explanation, degraded states named |
| `failed` | edge | `classifyOutcome`: timeout/kill/crash/refused-candidate | **"a statement about the system"** + the FAD-34 termination word |
| `cancelled` | edge | `requestCancellation` (immediate from `queued`; signalled from `running`) | "was cancelled by a scheduler" |
| `reviewed` | edge | `markReviewed` | "Approve" / "Run a further stage" |
| `progressively_extended` | edge | `markProgressivelyExtended` / `markStageComplete` | "The stage is complete" |
| `approved` | edge, **gated**: zero unresolved hard findings AND a usable result | `approveRun` (+ `supersedeSiblings`) | "Select this candidate" |
| `applied_to_draft_schedule` | edge; D-4d index; `applied_to_version_id` required | `applyCandidateToNewDraft` | confirmation panel; the new draft id is named |
| `superseded` | edge from the completed family | `supersedeSiblings` | "A later build for this period was approved" |
| `archived` | edge from every settled state | `archiveSettledRunsForClosedPeriod` (reads the period's own status) | — (no scheduler action; the period's closure drives it) |

---

## 5. R-8, executed

RK-RULING-04 rules that a solver-produced assignment has **no** pick position and
that a NULL one satisfies `PickPositionRestriction` vacuously. That is right for a
row the solver chose. It is **not** right for a row that mirrors a PINNED fixed
input: that assignment already has a pick position on the source version's
snapshot row, and flattening it to NULL at selection would drop a real attribute
of a real assignment.

So:

- `build_run_candidate_assignments` carries `mirrors_assignment_identity_id`,
  `mirrors_pinned` and `pick_position`, with a CHECK that only a mirroring row
  may carry a position;
- `persistOutcome` resolves the position from the SOURCE version's
  `assignment_snapshots` at result-recording time (the canonical snapshot does not
  carry `pick_position` — it is not a solver input);
- `applyCandidateToNewDraft` writes it through, and preserves `is_pinned` and the
  assignment IDENTITY for mirrored rows.

Proven by `lifecycle.test.ts` → *"creates a NEW draft, leaves the source
untouched, and carries R-8 pick positions"*: a pinned manual assignment with
`pickPosition: 7` is authored through `addManualAssignment`, and after selection
the new draft holds a row with `pick_position = 7`, `is_pinned = true`,
`origin = 'solver'`, while the source version's row count is byte-identical.

---

## 6. Test results

| # | Command | Result | Transcript |
|---|---|---|---|
| 2 | `gate:unit` (whole workspace, solver venv) | **157 files / 1957 tests passed**, `UNIT EXIT=0` | [`step-02`](step-02-unit-suite.txt) |
| 3 | `apps/api/test/builds/**` standalone | **6 files / 59 tests passed**, `BUILDS-SUITE EXIT=0` | [`step-03`](step-03-builds-suite.txt) |
| 4 | `gate:axe` — the whole `apps/web/e2e` battery | **402 passed, 0 failed** at both viewports | [`step-04`](step-04-axe-e2e.txt) |
| 6 | `corepack pnpm red-cases` | **51 case(s): 51 proven, 0 not proven**, `RED-CASES EXIT=0`. The three new arms read `pass / fail / PROVEN` | [`step-06`](step-06-red-cases.txt) |
| 7 | `corepack pnpm check` | **16 gate(s): 16 passed, 0 failed**, `CHECK EXIT=0` | [`step-07`](step-07-check.txt) |
| 8 | `corepack pnpm sbx` | `SBX EXIT=0`. SBX-004: **371 readings across 7 contexts, 0 wrong-tenant rows, 53 of 53 tables observed**; 0 vacuous assertions | [`step-08`](step-08-sbx.txt) |
| 9 | `corepack pnpm fixture-regression` — FIRST attempt | **FAILED**, and correctly: 2 of 13 fixed seeds red on the D-4 order dependence | [`step-09c`](step-09c-fixture-regression-FAILED.txt) |
| 10 | `corepack pnpm fixture-regression` — after the repair | **143 run(s): 143 passed, 0 failed**, rotating seed **789266**, `FIXTURE-REGRESSION EXIT=0`. "Order-independent under every seed tried. Every file also passes alone. The shared baseline was unmodified in every run." | [`step-10`](step-10-fixture-regression.txt) |
| 11 | `migrate:cycle:embedded` | **0001…0018 applied BY NAME**, `MIGRATION CYCLE CLEAN — up -> down -> up -> down -> up, 1211ms`, `MIGRATE-CYCLE EXIT=0`. Re-run AFTER the 0018 `GRANT EXECUTE` repair and the `cancel_requested` addition, so the transcript describes the committed migration | [`step-11`](step-11-migrate-cycle-embedded.txt) |

Every transcript carries an `EXIT=` marker inside its redirected block except
`step-02` and `step-04`, which were captured with the code printed to the
runner's terminal instead. Both say so at their own foot and both name the
in-block capture that governs them (`step-07`, where `unit PASS` and `axe PASS`
sit above `CHECK EXIT=0`). Nothing was re-run to hide a failure: the
fixture-regression that FAILED is retained beside the one that passed.

### The sweep floor, in the two counts that are easy to confuse

| Count | Before (M4-001) | After (M4-003) |
|---|---|---|
| `TENANT_TABLES` — the REGISTRY | 48 | **54** |
| SBX-004's sweep | 47 | **53** |

`sweep = registry − 1`, permanently (FAD-34(3)): `users` is global by PO-DEC-06
and reached THROUGH a membership, so "wrong tenant" is not a column comparison
for it and it gets a dedicated probe instead. Both numbers moved by exactly six,
which is the number of tables 0018 creates.

### 6a. The new red arms, both directions, standalone (FAD-33(1))

Verified **before** the battery, one at a time, by patching the migration by hand
and running `gate:unit:builds`. The migration is applied by `globalSetup`'s
up → down → up before every run, so there is no `dist/` in the path at all and
the decorative-arm failure mode FAD-33(1) names cannot arise.

| Arm | GREEN (clean tree) | RED (violation) | Transcript |
|---|---|---|---|
| control | **59 passed**, `BUILDS-SUITE EXIT=0` | — | [`step-05a`](step-05a-red-arms-green-control.txt) |
| `builds-fencing-trigger` | — | **1 failed / 58 passed**, exactly the DATABASE arm. `RED-ARM EXIT=1` | [`step-05b`](step-05b-red-arm-fencing.txt) |
| `builds-validation-gate` | — | **1 failed / 58 passed**, exactly the "can NEVER reach approved" arm. `RED-ARM EXIT=1` | [`step-05c`](step-05c-red-arm-validation-gate.txt) |
| `builds-transition-guard` | — | **6 failed / 53 passed**: the 256-pair agreement check, the self-edge check, the absorbing-`archived` check, the unknown-state check, the raw-SQL illegal-transition arm, and the migration-cycle mutation control. `RED-ARM EXIT=1` | [`step-05d`](step-05d-red-arm-transition-guard.txt) |

The narrowness matters: a patch that turned everything red would prove only that
the suite is coupled to the migration.

### 6b. Browser evidence — 41 screenshots, both viewports

`screenshots/` carries every state the matrix drives, captured by the real
browser against the real production bundle. Each has a `.desktop.png` and a
`.mobile.png` except `builds-320px`, which is the 320px reflow assertion and
belongs to the mobile project alone.

| Screenshot | What it shows |
|---|---|
| `builds-list` | the period's configurations and builds, with the scope note |
| `builds-empty` | the empty state, naming what to do next |
| `builds-denied` | **403** — "no permission", with no capability named (SPEC-06 P-3) |
| `builds-in-flight-conflict` | D-4a stated in the interface |
| `builds-320px` | no page-level horizontal scroll at 320px (AC-08) |
| `build-infeasible` | **"a statement about the problem"** + the exact T0 finding |
| `build-timeout` | **"reached its time limit"** — a deadline, never infeasible |
| `build-cancelled` | **"was cancelled by a scheduler"** |
| `build-refused-candidate` | the checker REFUSED it although the solver said OPTIMAL |
| `build-explanation-degraded` | `EXPLANATION_BUDGET_EXCEEDED`, rendered not hidden |
| `build-readiness-failed` | itemised readiness findings on the way back to configuration |
| `build-completed-unmet` | the quality panel and the "not established yet" caveat |
| `build-recovered` | the reap and the FENCED stale result, both on the timeline |
| `build-retries-exhausted` | exhausted retries with the LAST termination reason |
| `build-cancel-confirm` | the confirmation panel, and "when it actually stops" |
| `build-state-moved` | `409 BUILD_STATE_MOVED` with one reload control |
| `build-stale-source` | `409 STALE_BUILD_SOURCE` — "Nothing was applied" |
| `build-applied` | the NEW draft named; no publication claimed |
| `build-not-found` | **404** — "not found", distinct from the 403 above |
| `build-comparison` | D-4c differences, with the no-ranking caveat |
| `build-comparison-too-few` | fewer than two candidates refused with words |

### 6c. Request budgets — four new, with recordings at both viewports

`request-budget` gate: **42 budgeted interaction(s), 83 recording(s), PASS**.

| Interaction | Budget | Measured |
|---|---|---|
| `builds-open-new-configuration` | **0** (I-13) | 0, both viewports |
| `builds-open-launch-form` | **0** (I-13) | 0, both viewports |
| `builds-launch-accepted` | 2 | ≤2, both viewports (the write + one re-read) |
| `builds-open-cancel-confirm` | **0** | 0, both viewports |

The two zeroes are the ones that can never be raised without the invariant
changing first. `builds-open-launch-form` matters most: a control that started a
solve on click would spend a worker slot and a `build_runs` row before the
scheduler had said which candidate it is.

---

## 6d. The FAD-44 repair round

The four disclosures in §7 were adjudicated as **FAD-44** (on main, `c61507d`).
This branch is rebased onto it. Two grants were applied; two rulings changed
nothing but the words on the page.

### FAD-44(1) — one assignment write path

`AddAssignmentInput` gains one optional `origin?: 'manual' | 'solver'`,
defaulting to `'manual'`, and `selection.ts` was **refactored to call
`addManualAssignment`** instead of writing rows itself. `selection.ts` now
contains **zero** `insertInto` statements.

What the refactor bought, beyond removing a second spelling of the write path:
the interval guard, `assertAssignableMembership`'s R-B1/R-B2 checks,
`assertEditable`'s draft-only refusal, the shift lookup-or-create, and the
`schedule.assignment.added` audit event are now reached by the solver path too,
because there is only one path to reach. Each was previously either duplicated
in `selection.ts` or silently skipped.

The origin is written to the identity **and** the snapshot, so "was this
assignment ever solver-made?" is answerable without reading every snapshot of
it — which is what lets the next progressive stage tell a locked MANUAL
assignment from a locked prior SOLVER one (report 21 §5).

Pinned three ways:

| Pin | Where |
|---|---|
| a solver-applied assignment carries `origin = 'solver'` on the snapshot | `lifecycle.test.ts` → selection R-8 arm |
| a MIRRORED identity keeps `'manual'`; a solver-chosen identity is `'solver'` | same arm |
| the manual path still writes `'manual'` with no caller change | `authoring-http.test.ts` → *assignment origin (FAD-44(1))* |
| the `schedule.assignment.added` event fires once per written row, carrying `origin` | same arm — it did not exist at all before the refactor |

### FAD-44(2) — six additive audit names, for ratification

Added to `AUDIT_EVENT_NAMES`, additive only, nothing renamed or removed:

| Name | Emitted when |
|---|---|
| `build.run.created` | a build run is created, in `draft_configuration` |
| `build.run.submitted` | a scheduler submits it for validation |
| `build.run.state_changed` | every other lifecycle edge; payload carries from and to |
| `build.run.cancelled` | a scheduler cancels |
| `build.run.approved` | a scheduler approves — zero unresolved hard violations |
| `build.run.applied` | an approved candidate becomes a NEW draft version |

Plus one subject type: **`build_run`**. It is its own aggregate and is
deliberately not filed under a schedule version — a build that was cancelled, or
failed, or was superseded never produced a version to file it under.

Three design choices, each pinned:

- **`cancelled` and `approved` have their own names** although both are also
  state changes. They are the two moments a human takes responsibility, and
  "who approved the schedule that got published" must be a filter rather than a
  payload scan.
- **There is no `build.run.reaped`.** A heartbeat expiring is a fact about a
  WORKER; it lands on `build_run_events`, and the `running → failed` it causes is
  chained. `lifecycle.test.ts` asserts both halves.
- **`build.run.applied` is separate from `schedule.version.created`.** The
  draft's creation stays audited under the schedule aggregate; "which build
  produced this draft" is a question about the build.

`recordBuildEvent` now writes BOTH records — the timeline row and the chain
entry — so no writer can take one without the other, and `auditNameFor` decides
the mapping in one place.

### FAD-44(3) and (4) — no code change

The route docblock previously described the capability key as a disclosed gap.
It now states the ruling: `schedule.version.edit` is the decision of record
because building toward a draft **is** version-editing authority; a dedicated
`schedule.build.administer` key is a **recorded owner question** (scope is
owner-controlled, rule 11) and is not implemented. The credits non-carry stands
and §7d already points at M4-004.

### The repair round's own battery

| # | Command | Result | Transcript |
|---|---|---|---|
| 12 | builds + schedule suites (the changed write path, both sides) | **28 files / 314 tests passed**, `FAD44-TARGETED EXIT=0` | [`step-12`](step-12-fad44-targeted.txt) |
| 13 | `corepack pnpm check` | **16 gate(s): 16 passed, 0 failed**, `CHECK EXIT=0` | [`step-13`](step-13-check-fad44.txt) |
| 14 | `corepack pnpm sbx` | `SBX EXIT=0`; 371 readings, 0 wrong-tenant, **53 of 53** tables — floor UNCHANGED, correctly: the repair adds no table | [`step-14`](step-14-sbx-fad44.txt) |
| 15 | `corepack pnpm fixture-regression` | **143 run(s): 143 passed, 0 failed**, rotating seed **958069**, `FIXTURE-REGRESSION EXIT=0`. Run because the refactor moves the SOLVER path onto the schedule write path — the shuffled sweep had to see the new coupling, and it did | [`step-15`](step-15-fixture-regression-fad44.txt) |

**The migration is byte-unchanged** (`git diff apps/api/migrations/` is empty),
so no cycle was re-run and no schema escalation was needed. The three red arms
were nevertheless re-verified both directions, because the INDEX cites their
exact narrowness and the builds suite grew from 59 to 62 tests: control **62
passed**; fencing **1 of 62**; validation gate **1 of 62**; transition guard **6
of 62**. The full 51-case `red-cases` battery was **not** re-run, and the reason
is checkable rather than asserted: **no red-case arm anchors in any file this
repair changed** (verified by matching each changed path against every `file:`
anchor in `scripts/red-cases/run.mjs` — zero hits), and every arm that uses
`gate:unit` as its green leg has that leg proven green by step-13's `unit PASS`.

---

## 6e. The FAD-45 condition round (review: ACCEPT WITH CONDITIONS)

The independent review returned ACCEPT WITH CONDITIONS; **FAD-45** (on main,
`d6d6a61`) adjudicated it. This branch is rebased onto it.

### R-1 — the raw-NUL class, repaired and now GATED

`builds/readiness.ts` carried **four raw `U+0000` bytes** at offsets
**3039, 3646, 5080, 6540** — separators inside template literals. Respelled as
the four-character escape `\x00`, which is how
`apps/api/src/solver/candidate-validation.ts` already spells the same separator.
**After: zero raw NULs** (`offsets []`).

The respelling is **hash-neutral in the sense that matters** — the runtime string
is byte-identical, so nothing derived from it moves:

```
raw  : "a\u0000b"  sha256 59b271ae1bbcb1d31d41929817f4b16f
esc  : "a\u0000b"  sha256 59b271ae1bbcb1d31d41929817f4b16f
IDENTICAL: true
```

This was the **third** recurrence of the class in two milestones (M3-008/NR-18,
FAD-42's R-2, and this). FAD-45(1) therefore **mandated a gate**, and
`scripts/gates/raw-nul-scan.mjs` is it — wired into `check` as gate 17, red-cased,
scanning every tracked file with an allowlist of **extensions** (never paths) for
genuinely binary formats.

**The NR-18 doc instances are carried as the gate's known-violations baseline,
not repaired — and the choice was not free.** All three lie outside this packet's
allowed globs:

| File | Byte offset | Why not repaired here |
|---|---|---|
| `docs/fable/control/CHANGELOG.md` | 19704 | `docs/fable/**` is expressly PROHIBITED to this packet |
| `docs/fable/control/OPUS-AGENT-RUNBOOK.md` | 27417 | same |
| `docs/evidence/EV-M3-AUTHN/INDEX.md` | 1812 | another packet's evidence bundle; only `EV-M4-003/**` is this packet's |

The baseline is **pinned by path AND by count**, which is deliberately the
strictest form: a new NUL in a baselined file fails the build (the count is
pinned, so the path is not an exemption), and a baselined NUL that gets *fixed*
also fails, with a message saying to shrink the baseline. A baseline that only
checked existence would let the next NUL hide behind an old one — which is the
exact failure mode the gate exists to prevent.

### R-2 — the UI retry control

A packet-objective gap, and the review was right that it was missing. Added on
the build detail page, from **`failed`, `cancelled` and `infeasible`**, sending
`retryOfBuildRunId`.

`infeasible` is included deliberately: report 21 draws "relax constraints and
retry" from that state, and although the EDGE is not in-place (SPEC-04 §2), re-posing
the problem after changing the inputs is exactly what a scheduler does next.

The control is **disabled, not hidden**, when the chain is spent — hiding it
would leave a scheduler wondering whether retry is possible at all, where
disabling it beside "this build chain has used its retries" answers the question
they actually have.

### R-3 — falsifiability for the five unproven controls

| Control | Form | Result |
|---|---|---|
| **fencing STATE clause** (`IF v_state <> 'running'`) | full red-case arm `builds-fencing-state-clause` | GREEN 67 passed; RED **1 failed of 67** |
| append-only on the result tables | in-test, **as the SUPERUSER** — see §6f D-1, the first version was decorative and is repaired | GREEN 67 / RED 1 of 67 |
| `BUILD_CLAIM_EPOCH_REGRESSED` | in-test, with a forward-move GREEN control | R-3c |
| `BUILD_IDENTITY_FROZEN` | in-test, **as the superuser**, past the grants | R-3d |
| no-delete guard | in-test, as the superuser | R-3e |

The state clause is the reviewer's serious one and they were right about why: the
EPOCH clause catches a superseded *worker*, but the STATE clause is the **sole**
refusal for injecting a candidate, a violation or a result into a run that has
already SETTLED — a `failed` build acquiring a usable candidate, or an `approved`
one acquiring extra assignments after the gate that checked it. The epoch still
matches, because settling does not change it. The red arm neuters only that
clause and leaves the epoch clause standing, so it cannot pass on the other's
behalf.

R-3d and R-3e are driven **as the superuser** on purpose. `app_runtime` never
reaches those triggers — the column-level UPDATE grant and the absent DELETE
grant stop it first — so an arm run as the application role would prove the
grants and say nothing about the triggers, which is precisely the gap R-3 named.

### R-4 — disclosures the review asked to be explicit

- **D-4b (per-organization concurrency cap) is ABSENT.** SPEC-04 §6 defines it
  ("multiple configurations may run concurrently for one period, bounded by a
  per-organization concurrency cap") and M4-003 does not implement it. **Assigned
  to M4-005 (FAD-45(4))**, where the worker-queue binding lives — a cap is a
  property of the dispatch queue, and implementing it here without one would be a
  counter in a table that nothing enforces. Disclosed rather than silently absent.
- **`protected_assignment_identities` is WRITE-ONLY at M4-003.** The column is
  populated by `createRun` and read by nothing in this packet. **That is correct
  for M4-003 (FAD-45(4))**: its readers are **M4-004** (progressive optimization
  around pins) and **M4-005** (the concurrency/recovery matrix). Recording the
  protected set is what report 21 §5 requires — "recorded rather than inferred" —
  and the recording has to exist before the consumer does.
- **D-4a's reading is RATIFIED (FAD-45(4)):** "non-terminal" = the five IN-FLIGHT
  states (`draft_configuration`, `validating`, `readiness_check`, `queued`,
  `running`). Spelled out in the index and in `states.ts` rather than negated, so
  a future state cannot silently join or leave the set.
- **The D-1a overlap arm is NOT exercised, and saying so matters.** The reviewer
  observed that no test proves D-1a's exclusion constraint refuses an overlapping
  build-produced assignment. That is accurate: the fixture's shift types are
  **adjacent, not overlapping**, so the constraint is never reached by this
  suite. It is a real control (0009) with real coverage elsewhere in the manual
  path, but this packet does not add an arm for it — recorded as untested rather
  than implied.
- **The six `build.*` names and the `build_run` subject are RATIFIED**
  (FAD-45(5)), including the reaped-not-audited split: a worker fact belongs on
  the timeline, and the state change it causes is chained.

### The condition round's own battery

| # | Command | Result | Transcript |
|---|---|---|---|
| 16 | `gate:axe` — the retry surface added | **408 passed, 0 failed** at both viewports (was 402; +6 = 3 new arms x 2 projects) | [`step-16`](step-16-axe-fad45.txt) |
| 17 | the NUL gate, **both directions** | GREEN `NUL-GREEN EXIT=0`; RED — a raw NUL injected at offset 2837 is named with its path and offset, `NUL-RED EXIT=1` | [`17a`](step-17a-nul-gate-green.txt) / [`17b`](step-17b-nul-gate-red.txt) |
| 18 | the fencing STATE clause, **both directions** | GREEN **67 passed**; RED **1 failed of 67** — narrow, so it is not passing because the suite is coupled to the migration | [`18a`](step-18a-fencing-state-green.txt) / [`18b`](step-18b-fencing-state-red.txt) |
| 19 | `corepack pnpm check` | **17 gate(s): 17 passed, 0 failed**, `CHECK EXIT=0`. Gate count 16 → 17: `raw-nul PASS 268ms` | [`step-19`](step-19-check-fad45.txt) |
| 20 | `corepack pnpm red-cases` | **53 case(s): 53 proven, 0 not proven**, `RED-CASES EXIT=0`. Case count 51 → 53; both new arms read `pass / fail / PROVEN` | [`step-20`](step-20-red-cases-fad45.txt) |
| 21 | `corepack pnpm fixture-regression` | **143 run(s): 143 passed, 0 failed**, rotating seed **963772**, `FIXTURE-REGRESSION EXIT=0` | [`step-21`](step-21-fixture-regression-fad45.txt) |
| 22 | `corepack pnpm sbx` | `SBX EXIT=0`; 371 readings, 0 wrong-tenant, **53 of 53** tables; 6 of 6 scenarios, **0 vacuous**. The floor is UNCHANGED, correctly: this round adds a GATE, not a table | [`step-22`](step-22-sbx-fad45.txt) |

**The migration is byte-unchanged this round too** (`git diff apps/api/migrations/`
is empty), so no cycle was re-run and no schema escalation arose. The two red
arms that patch `0018` do so transiently and revert; the file is verified
unchanged after each.

---

## 6f. The delta-review micro-repair (verdict: ACCEPT with one repairable finding)

The original reviewer delta-reviewed the FAD-45 round and returned **ACCEPT with
one repairable finding and two low items**. All are repaired below.

### D-1 — the append-only arm was DECORATIVE, and its comment was false

The most important finding in either review, and it was against my own work.

`R-3b` drove its UPDATE and DELETE through `run(seeded.context, …)` — as
`app_runtime` — and asserted only `.rejects.toThrow()`. But `app_runtime` holds
`SELECT, INSERT` on those tables **and nothing else**, so every statement was
refused by the **GRANT** with `permission denied` and never reached the trigger.
The comment claimed the arm bound "the OWNER too". It did not.

**Reproduced before repairing**, exactly as the reviewer demonstrated: with all
four `*_append_only` triggers removed, the suite stayed **67/67 green**. That is
the FAD-33(1) failure mode in its purest form — a control observed only NOT
firing, under a comment asserting what it had never been asked to do.

Repaired to name the two controls separately, against the writer each actually
binds:

| Control | Writer | Refusal |
|---|---|---|
| the GRANT | `app_runtime` | `permission denied` |
| the TRIGGER | **superuser** | `APPEND_ONLY` |

Only the second half can go red when the triggers are removed, which is what
makes the arm evidence. It now covers `build_run_violations`, `build_run_events`
and `build_run_candidate_assignments`, so removing any ONE of the four triggers
is caught.

**A second defect surfaced while repairing the first, and the green control
caught it.** The `DELETE FROM build_run_candidate_assignments` initially
RESOLVED — the build had no candidate rows, and a `FOR EACH ROW` trigger does not
fire for a statement matching nothing. A DELETE over an empty table is a
resolving assertion. The arm now inserts a candidate row and **asserts both
target tables non-empty before attempting the guarded statements**, so it cannot
go vacuous again.

| Direction | Result | Transcript |
|---|---|---|
| GREEN (triggers present) | **67 passed**, `GREEN EXIT=0` | [`23a`](step-23a-appendonly-green.txt) |
| RED (all four removed) | **1 failed of 67**, `RED EXIT=1` | [`23b`](step-23b-appendonly-red.txt) |

### D-2 — the exhaustion reason now renders for every retryable state

The control appeared for `failed`, `cancelled` and `infeasible`; the "chain has
used its retries" reason rendered for `failed` alone. So an exhausted
`infeasible` build showed a disabled button and no explanation — which is
precisely what my own disabled-not-hidden rationale exists to prevent.

Both now read from ONE `RETRYABLE_STATES` set, so the control and its reason
cannot disagree about where a retry is possible. Two new e2e arms (AC-28) cover
`infeasible` and `cancelled` at both viewports.

### D-3 — the extension-rename bypass: no code change, recorded

The NUL gate's allowlist is keyed on file EXTENSION, so a text file renamed to
`.png` would be skipped. Magic-byte sniffing (checking that a `.png` really
begins `\x89PNG`) would close it. **Not implemented here** — it is a hardening
of a gate that did not exist an hour ago, and the bypass requires deliberately
misnaming a file. Recorded as an **M4-005 candidate** beside the gate's other
follow-ups.

### D-4 — the `builds-retry` budget was 3; it is 2

Authored as 3 on the ASSUMPTION that the period-list query would also re-read. It
does not: that query is not mounted on the detail route, so its invalidation
marks it stale without fetching. The recordings measure **2 at both viewports**
and the reviewer measured 2 independently. Corrected, with the note saying why —
a budget carrying headroom nobody measured is a budget that has stopped
detecting amplification.

### The micro-repair's proofs

| # | Command | Result | Transcript |
|---|---|---|---|
| 23 | the D-1 arm, both directions | GREEN **67 passed** / RED **1 of 67** | [`23a`](step-23a-appendonly-green.txt) / [`23b`](step-23b-appendonly-red.txt) |
| 24 | `gate:axe` | **412 passed, 0 failed** (was 408; +4 = 2 D-2 arms x 2 viewports) | [`step-24`](step-24-axe-delta.txt) |
| 25 | `gate:request-budget` | **43 interaction(s), 85 recording(s)**, `BUDGET EXIT=0`; `builds-retry` measured **2** at both viewports | [`step-25`](step-25-request-budget-delta.txt) |
| 26 | `corepack pnpm check` | **17 gate(s): 17 passed, 0 failed**, `CHECK EXIT=0` | [`step-26`](step-26-check-delta.txt) |

**Why `red-cases`, `fixture-regression`, `sbx` and the migration cycle were NOT
re-run** — checkable, not asserted:

- **the migration is byte-unchanged.** `git diff apps/api/migrations/` is empty;
  the D-1 red direction patches `0018` transiently and restores it, verified
  after each run. No schema change ⇒ no cycle, and the sbx floor cannot move
  because no table was added.
- **no red-case arm anchors in any file this repair changed.** The changed set is
  `lifecycle.test.ts`, `BuildDetailPage.tsx`, `builds.spec.ts`, `budgets.json`
  and the INDEX; every `file:` anchor in `run.mjs` was matched against it — zero
  hits. The two arms that patch `0018` are unaffected because `0018` is
  unchanged.
- **every arm whose green leg is `gate:unit`** has that leg proven by step-26's
  `unit PASS`.
- **`fixture-regression`'s question is order-independence**, and the diff adds no
  production write path — `BuildDetailPage.tsx` is client-side, the rest is a
  test file, a budget number and documentation. The one production-adjacent
  change (D-2's `RETRYABLE_STATES`) is pure rendering. The full sweep ran green
  on the same test file one round earlier at seed 963772.

---

## 7. The disclosures, as raised — all four now ruled by FAD-44

Recorded here **as they were raised**, so the review can see what was disclosed
and judge whether the disclosure was honest — not only what was decided. Every
one is now ruled; §6d records what was actually done. Nothing below has been
edited after the fact except the RULED markers.

### 7a. `origin = 'solver'` cannot be written through the schedule service — **RULED: FAD-44(1), granted and applied (§6d)**

`addManualAssignment` hardcodes `origin: 'manual'` on both the identity and the
snapshot and exposes no parameter. The database has admitted
`origin ∈ {manual, clone, solver, picklist}` since migration 0009; the service
has no way to write three of the four.

Using it would record **every solver-produced assignment as a manual one** —
the exact conflation non-bypass rule 7 exists to prevent, and it would destroy
the distinction report 21 §5 draws between "locked manual assignments" and
"locked prior solver assignments" for the next progressive stage.

`apps/api/src/schedule/**` is outside this packet's allowed files, so
`selection.ts` writes the rows itself. **The controls the manual path relies on
are the same ones, and they are in the database rather than in that function:**
`app_guard_assignment_snapshot_graph` (0014), D-1a's overlap exclusion, D-14's
one-snapshot-per-identity-per-version, and D-15a's frozen-version refusal. None
is added to, none is removed.

**Minimal grant requested:** one optional `origin?: AssignmentOrigin` on
`AddAssignmentInput`.

### 7b. There is no `build.*` audit event name, and none may be invented — **RULED: FAD-44(2), granted and applied (§6d)**

`packages/domain/src/audit/event-names.ts` is a CLOSED list and is outside this
packet's allowed files. Non-bypass rule 6 forbids writing outside the chain and
rule 13 forbids inventing a stable identifier, so no build transition can reach
`audit_events` today.

What is in place instead, and what is honestly missing:

- **In place.** Every transition, claim, fenced result and reap is a row in
  `build_run_events` — append-only (`app_guard_append_only`), tenant-scoped,
  actor-bearing, carrying from/to states and the claim epoch. The scheduler's
  timeline reads it.
- **In place.** The one effect that reaches the schedule aggregate — the draft a
  selection creates — **is** audited, as `schedule.version.created`, by
  `createDraftVersion`, exactly as a hand-authored draft is.
- **Missing.** Chain entries for the build transitions themselves.

`recordBuildEvent` in `service.ts` is the single seam: it is called by every
writer, after the mutation, exactly where a `recordAuditEvent` call belongs.

**Minimal grant requested:** six additive names —
`build.run.created`, `build.run.submitted`, `build.run.state_changed`,
`build.run.cancelled`, `build.run.approved`, `build.run.applied` — plus one
subject type, `build_run`. Nothing is renamed and nothing is removed.

### 7c. There is no schedule-generation capability key — **RULED: FAD-44(3), `schedule.version.edit` retained; dedicated key = owner question**

Doc 18's CAP-015 row reads "Building requires a schedule-generation capability".
`packages/domain/src/authz/catalogue.ts` has no such key and is outside the
allowed files. Every build route declares `schedule.version.edit`
(CAP-014/CAP-015 traceability) or `schedule.period.administer` (CAP-019).

This is **not a widening**: `schedule.version.edit` is the strictest existing key
whose meaning covers the surface (a build authors a draft schedule version), and
reusing it grants nothing to anybody who could not already author a draft by
hand. **Proposed:** `schedule.build.administer`, group-scoped,
`core_scheduling`.

### 7d. Credits are not carried into a build-produced draft — **RULED: FAD-44(4), non-carry stands; the ruling belongs to M4-004**

`cloneCredits` maps credits by the source version's snapshot rows. A
build-produced draft's snapshot set is GENERATED, not cloned, so a credit copied
across could point at an assignment the solver did not reproduce. Stated as an
M4-004 question rather than approximated. A credit that matters is re-expressed
on the draft, which is the path SPEC-05 already requires for a post-publication
correction.

---

## 8. Standing limitations

- **The audit-chain gap in §7b is CLOSED** by FAD-44(2), and the six names plus
  the `build_run` subject are **RATIFIED** by FAD-45(5). Nothing remains open.
- **D-4b (the per-organization concurrency cap) is NOT implemented** and is
  assigned to M4-005 with the worker-queue binding (FAD-45(4)). See §6e.
- **`protected_assignment_identities` is written and not yet read.** Correct for
  M4-003; its readers are M4-004 and M4-005 (FAD-45(4)).
- **D-1a's overlap exclusion is not exercised by this packet's suite.** The
  fixture's shift types are adjacent rather than overlapping, so the constraint
  is never reached here. Recorded as untested rather than implied.
- **Three pre-existing raw NULs remain** in files outside this packet's allowed
  globs, held at their pinned counts by the new gate (§6e R-1). They are carried,
  not excused: a new NUL in any of those three files still fails the build.
- **The NUL gate's allowlist is by EXTENSION**, so a text file deliberately
  renamed to `.png` would be skipped. Magic-byte sniffing would close it;
  recorded as an M4-005 candidate (§6f D-3), not implemented here.
- **The dispatch runs in the API process.** The SOLVE runs in its own Python
  subprocess with no database credential (SPEC-04 §1.1), which is the boundary
  that matters; which Node process spawns it is a deployment question (SPEC-10)
  and binding the runner to a scheduling-worker queue is M4-005's.
- **No benchmark band is asserted anywhere.** SPEC-04 §7: every band except
  `hard_violations = 0` is undefined until the corpus is run. The quality panel
  and the comparison both say so on screen and neither ranks.
- **The e2e suite intercepts the API**, as every other spec in that directory
  does. Server behaviour is proven separately, over HTTP and in raw SQL, in
  `apps/api/test/builds/**`.
- **No production-readiness claim**, and no compliance claim of any kind.
