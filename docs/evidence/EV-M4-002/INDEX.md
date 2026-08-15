# EV-M4-002 — OPUS-M4-002 (rule semantics and E1 feasibility)

**Status: ESCALATED BEFORE IMPLEMENTATION. No product code was written.** The packet
([doc 35 §6d](../../fable/35-m4-task-packets.md)) names the condition that fired, verbatim:

> **Escalate if** … a needed input is unreachable from the canonical snapshot without
> touching a prohibited module

Three of the kinds the eleven RK-RULINGs make M4-evaluable — and one scope filter that
applies to **every** kind — require inputs the M4-001 canonical snapshot does not carry.
Adding them means editing `packages/domain/src/ports/solver-snapshot.ts`, which is outside
this packet's Allowed files (M4-001 held that glob; M4-002 does not), and moving the
canonical input hash that M4-001's shipped determinism proofs are anchored to.

The escalation is raised **before** any code was written deliberately: the ruling changes
the snapshot document shape, and the snapshot shape determines the canonical input hash,
which determines every corpus fixture hash, the committed manifest, and M4-001's
`canonical-input.test.ts` / `snapshot-contract.test.ts` anchors. Work done ahead of the
ruling would be re-done, not extended.

---

## 1. The gap, stated exactly

`SolverInputSnapshotDocument` (`packages/domain/src/ports/solver-snapshot.ts:259–285`) has
twenty fields. Reproduced in [`probe-01-snapshot-gap.txt`](probe-01-snapshot-gap.txt)
§PROBE A. The wire mirror `solverInputSnapshotSchema`
(`packages/contracts/src/solver/snapshot.ts`) is `.strict()` on every object, so nothing can
be carried that the type does not declare.

| Needed by | Input required | Present in the snapshot? |
|---|---|---|
| **RK-RULING-02** — `MemberOfStaffGroup(staffGroup = staff_groups.id)` | `staff_groups`, `staff_group_members` | **No.** Zero occurrences of `staffGroup`/`StaffGroup` on any solver surface (PROBE B) |
| **RK-RULING-02** — `RuleScope.staffGroups` (applies to **every** kind) | `staff_group_members` | **No.** Same |
| **RK-RULING-03** — `ValidGroupRestriction(validGroup = valid_groups.id)` | `valid_groups`, `valid_group_shift_types` | **No.** Zero occurrences of `validGroup`/`ValidGroup` (PROBE B) |
| `RequiresQualification(qualification = qualifications.key)` — already EVALUATED at M3, must become a **CP-SAT constraint** at M4 | a qualification **key → id** resolution | **No.** `holdings[].qualificationId` and `shiftTypes.requiredQualificationIds` are uuids; the only place a `qualifications.key` appears is `constituents[kind='qualification'].key`, which carries no id (PROBE B/C) |

The tables the rulings name all **do** exist — `staff_groups`, `staff_group_members`,
`valid_groups`, `valid_group_shift_types` (migration 0005) and
`assignment_snapshots.pick_position` (PROBE D). **The rulings are sound; the pipe is
missing.** This is not a ruling contradicting evidence — it is an assembly that predates the
rulings and was never asked to carry these inputs.

### Why the obvious workarounds are not available

- **Carry them in the snapshot.** Requires new fields on `SolverInputSnapshotDocument` —
  `packages/domain/src/ports/**` is not in this packet's Allowed files, and the packet's
  Frozen/prohibited row reads "PROHIBITED: everything else". It also moves the canonical
  input hash.
- **Let the validator read them from the database.** Possible in-glob
  (`apps/api/src/solver/**` already reads inside a unit of work), and it would let the
  *independent TS checker* evaluate them — **but the Python worker still cannot**, because
  the worker receives only the snapshot and holds no credential (SPEC-04 §1.1, S-15t). The
  result would be HARD rules the solver cannot model and the validator always rejects:
  every fixture carrying one becomes permanently infeasible-by-rejection. That fails the
  packet's own requirement that HARD rules become *actual CP-SAT constraints*, and it fails
  "the corpus's every feasible fixture solves with 0 hard violations".
- **Smuggle them beside the snapshot in `request.control`.** Contradicts the packet's
  tenant-isolation row: "every new input reaches the worker THROUGH the canonical snapshot
  only".

### Blast radius if left unresolved

`RuleScope.staffGroups` is a filter on **any** rule, and the shipped checker refuses any
rule carrying a non-empty `scope.staffGroups` as `not-evaluable`
(`hard-rule-check.ts` `scopeUnresolvable`). So the gap is not confined to two node kinds: it
also blocks the packet's **`B-ruleheavy`** corpus class ("every M4-evaluable kind ≥ once")
and any staff-group-scoped rule of any kind.

---

## 2. What the orchestrator is being asked to rule

Neither branch is the implementer's to take: (A) crosses a prohibited glob and moves a
shipped hash; (B) narrows the packet's stated scope. Both are recorded rather than one
being chosen.

| Option | What it means | Cost |
|---|---|---|
| **A — extend the snapshot (recommended)** | Grant `packages/domain/src/ports/solver-snapshot.ts` **additively** for: `staffGroups: [{staffGroupId, memberMembershipIds[]}]`, `validGroups: [{validGroupId, allowedPickPositions[], shiftTypeIds[]}]`, and `qualifications: [{qualificationId, key, status}]`; matching additive contract schemas (already in-glob) and assembly in `canonical-input.ts` (already in-glob); two new `SnapshotConstituent` kinds (`staffGroup`, `validGroup`) so the new inputs are revision-cited like every other constituent | The canonical input hash moves. M4-001's hash-determinism and snapshot-contract proofs must be **re-anchored** (they assert determinism and shape, not a literal hash — re-anchoring is expected to be mechanical, but it is a change to an accepted packet's proofs and needs to be sanctioned, not assumed). `SOLVER_SNAPSHOT_SCHEMA_VERSION` bumps 1 → 2 and the worker's supported window with it. **No migration** — every table already exists |
| **B — fail these closed** | `MemberOfStaffGroup`, `ValidGroupRestriction`, and any rule with a non-empty `scope.staffGroups` FAIL CLOSED with a named owner (M4-003 or M4-005), alongside the four already-named later-milestone kinds. `RequiresQualification` still needs a resolution for the *model* side — under B it too would fail closed, which removes the qualification dimension from E1 entirely and makes `B-infeasible-missing-qualification` unbuildable as an E1 class | The packet's "the checker extended … to ALL M4-evaluable HARD kinds under the rulings" becomes 19-of-22, and three of SPEC-04 §8's corpus classes lose their intended cause. Recorded as a scope reduction under non-bypass rule 11 |

A third, narrower variant of A exists if the orchestrator wants the smallest possible
crossing: grant **only** `qualifications: [{qualificationId, key, status}]` (which unblocks
`RequiresQualification`, the highest-value kind and the one already shipped as EVALUATED),
and take option B for the staff-group/valid-group pair.

---

## 3. What was verified before stopping

Both probes were run and their transcripts retained. Neither is a blocker; both are recorded
because the packet requires them stated.

### OR-Tools is obtainable and CP-SAT works — [`probe-02-ortools-and-t1.txt`](probe-02-ortools-and-t1.txt)

The host interpreter is **CPython 3.9.6** and has no `ortools`
(`ModuleNotFoundError: No module named 'ortools'`). A venv was created **outside the
worktree** at `<SP_SOLVER_VENV>` and OR-Tools installed at the FAD-10 pin:

```
$ <SP_SOLVER_VENV>/bin/python --version
Python 3.9.6
$ … metadata.version('ortools')
9.15.6755
```

`ortools==9.15.6755` publishes a `cp39-cp39-macosx_11_0_arm64` wheel, so the FAD-7 local
substitution can carry a real solve. `SP_SOLVER_WORKER_COMMAND` (`apps/api/src/solver/config.ts`)
already exists to point the spawn at that interpreter — **no config change is needed.** The
**3.12 / image rerun remains the standing CI condition** (FAD-7/FAD-10, EV-M4-BOUNDARY),
unchanged.

### CP-SAT assumption support behaves as SPEC-04 §5 assumes — T1 is implementable

```
status INFEASIBLE
core [3, 4, 5]
indices of a [3, 4, 5]
```

Assumptions solve and `SufficientAssumptionsForInfeasibility()` returns a **sufficient but
not minimal** subset (all three literals, where two suffice). That is precisely SPEC-04 §5's
T1 guarantee — "**An infeasible subset, not necessarily minimal**" → `EXPLAINED_SUBSET`.
**T1 does not need to be faked or degraded**, and the packet's escalation clause "CP-SAT
assumption support (T1) fails to work as SPEC-04 §5 assumes" has **not** fired. T2
minimisation stays M4-004's, as the packet already excludes.

---

## 4. Design work completed and carried forward (not implemented)

Recorded so the ruling can be made against a concrete plan and so no analysis is repeated.

### 4.1 The proposed M4-evaluable partition — 22 evaluated / 8 not

Derived from the eleven rulings plus the registry's already-pinned `solver-and-validator`
owner, whose documented meaning is "M4-002 compiles it as a constraint AND an independent
validator re-checks it — never one without the other" (`registry.ts`).

**Evaluated (22)** — `RequiredCount` · `MinCoverage` · `MaxCoverage` (RK-01) ·
`RequiresQualification` · `MemberOfStaffGroup` (RK-02) · `ValidGroupRestriction` (RK-03) ·
`PickPositionRestriction` (RK-04) · `MaxAssignmentsInWindow` · `WeekdayFteLimit` (RK-05) ·
`MaxConsecutive` · `MinimumRestBetween` · `CallSpacing` · `NoAdjacent` (RK-07) ·
`ForbiddenSequence` (RK-08) · `PatternRule` · `AlternatingWeek` · `LinkedShifts` ·
`ImpliesAssignment` · `MutuallyExclusive` (RK-09) · `AvoidDate` (RK-11) ·
`FixedAssignment` (RK-10) · `ProtectedRange`.

**Not evaluated (8)** — four SOFT-natural objective kinds whose HARD authoring has no
defined breach (`WorkPercentageTarget` per RK-06, `ShiftPreference`, `FairnessBalance`,
`CreditDistribution`), and the four the packet names FAIL CLOSED with owners
(`TemplateAdherence` → templates-slice, `RequestHonoured` → M5-requests,
`StaffOverLocumPriority` and `LocumRestriction` → locum-slice).

`PatternRule`, `AlternatingWeek` and `ProtectedRange` are proposed for the evaluated set
**not** by overturning their M3 `constrains-the-search-not-the-content` reason but by
executing the `solver-and-validator` owner the registry already assigns them: as a *content
implication* over a candidate ("trigger assigned ⇒ segments assigned to the same membership
at the stated offsets"), which is exactly what the CP-SAT constraint would enforce and
therefore exactly what SPEC-04 §3.3's independent re-validation requires. **This is a
clarification of an existing owner, not a new RK ruling**, and it is flagged here rather
than taken silently.

### 4.2 The seam that keeps the two implementations independent

The independence the packet demands is structural and survives the ruling either way:

- **checker** — TypeScript, in `packages/domain/src/rules/`, pure, over *finished content*
  (a candidate's assignment rows plus supplied facts). No solver concept appears in it.
- **model** — Python, in `solver/schedulepoint_solver/`, over the *request*, expressed as
  CP-SAT boolean variables and constraints.
- The **only** shared artefacts are the AST types and the rulings themselves. No evaluation
  code, no helper, and no data structure crosses.

`CheckedVersion` would gain **one** optional field (a `candidateFacts` bundle) so that the
shipped publication caller — `apps/api/src/schedule/hard-rule-revalidation.ts`, a
**prohibited** module — compiles unchanged and its FAD-27 fail-closed behaviour is
preserved byte for byte: a caller that supplies no candidate facts still gets
`not-evaluable` for the kinds that need them, and still blocks.

### 4.3 Existing pins that the rulings will move (disclosed, not weakened)

Four tests pin the *current* `not-evaluable` answers and will need rewriting to the ruled
semantics, both directions, when the packet resumes. Rewriting a pin to a ratified ruling is
not weakening it, but it is a change to shipped tests and is named here in advance:

- `packages/domain/test/rules/hard-rule-check.test.ts:165` (`needs_acls`), `:455`
  (`avoid_staff_group` — the `scope.staffGroups` refusal), `:475` (`RequiredCount`)
- `apps/api/test/schedule/step-06-hard-rules.test.ts:309`

---

## 5. Battery

**Not run.** No product code was written, so there is nothing to validate and a green
battery would attest to nothing. The tree carries this evidence bundle and no source change.

## 6. Files in this bundle

| File | What it is |
|---|---|
| `INDEX.md` | This document — the escalation and the carried-forward design |
| `probe-01-snapshot-gap.txt` | The snapshot document surface, the absence greps, and the schema tables that DO exist |
| `probe-02-ortools-and-t1.txt` | OR-Tools availability under FAD-7, and the CP-SAT assumption/T1 probe |

---

# PART 2 — after FAD-38 (the ruling), 2026-08-14

**Status: PARTIALLY IMPLEMENTED. Three of the packet's five scope clauses are
landed; two are not started. The full acceptance battery was NOT run.** Part 1
above is retained unchanged as the escalation record, per the ruling.

Branch rebased onto `dd371ae` — clean, no conflicts, no content change
(`git merge-base --is-ancestor main HEAD` → true).

## 7. What landed

| Commit | Scope clause | State |
|---|---|---|
| `3bfb177` | snapshot v2 (FAD-38(1)–(3)) | **complete** |
| `cb3d76f` | §6d(3) the independent checker, 6 → 22 kinds | **complete** |
| `8cb4b33` | §6d(1)+(2) the CP-SAT model builder + compilation | **complete** |
| — | §6d(4) `apps/api/src/solver` compile-to-request + candidate validation | **NOT STARTED** |
| — | §6d(5) the E1 corpus | **NOT STARTED** |

## 8. Commands run, with real exit codes

| Step | Transcript | Result |
|---|---|---|
| `gate:typecheck` | [`step-01-typecheck.txt`](step-01-typecheck.txt) | `EXIT=0` |
| domain + worker-invariants | [`step-02-domain-and-worker-invariants.txt`](step-02-domain-and-worker-invariants.txt) | `EXIT=1` — 392/393, the ADR-0006 pin (see §9) |
| worker-invariants, re-anchored | [`step-03-worker-invariants.txt`](step-03-worker-invariants.txt) | `EXIT=0`, 9/9 |
| domain suite | [`step-04-domain-suite.txt`](step-04-domain-suite.txt) | `EXIT=0`, 384/384 |
| worker under the FAD-7 venv | [`step-05-worker-venv.txt`](step-05-worker-venv.txt) | `EXIT=0` — CPython 3.9.6, ortools 9.15.6755, 22 HARD kinds mapped, 3 objective tiers, 4 fail-closed owners |

**`corepack pnpm check`, `red-cases`, `fixture-regression`, `sbx` and the
`0001–0017` migration cycle were NOT run.** No claim is made about them. Saying
so is the honest position; a battery run against half a packet would attest to
nothing anyway.

## 9. The FIFTH pin rewrite — disclosed, not among the four FAD-38(7) named

`apps/api/test/solver/worker-invariants.test.ts:112` asserted **zero** `ortools`
importers ("the allowance is unspent"). The packet's own scope spends it — "the
deliberate first spend of the ADR-0006 one-module allowance" — so the assertion
had to move. It moved to the class the test is *named* for and has always
claimed: **at most one adapter module**.

```
-    expect(importers.map(([name]) => name)).toEqual([]);
+    expect(importers.map(([name]) => name)).toEqual(['cpsat_adapter.py']);
```

Pinned to the **filename**, not to a count: a count of one would still pass if a
second module started importing `ortools` and the adapter stopped. This is a
strengthening, and it is disclosed here because it was not among the four the
ruling named.

## 10. Re-anchoring disclosure (FAD-38(3)), per file

Exactly **one** v1 consumer failed to compile against v2, and it is a test
fixture:

| File | Change | Assertion lost? |
|---|---|---|
| `apps/api/test/solver/synthetic-problem.ts` | `staffGroups: []`, `validGroups: []`, `qualifications: []` added to the returned document | **None.** No boundary proof reads these fields; empty is the correct value for a fixture whose group genuinely has no such vocabulary |
| `apps/api/test/schedule/step-06-hard-rules.test.ts` | comment corrected; an assertion **ADDED** (`explanation` contains `candidateFacts`) | **None — one gained.** FAD-27 preservation is now observable rather than incidental |
| `packages/domain/test/rules/hard-rule-check.test.ts` | three pins rewritten (FAD-38(7)) | **None.** The `staffGroups` pin went from one blanket arm to three (no vocabulary / unknown id / resolves-and-narrows); `RequiredCount` gained the deciding arm the old pin could not express; the partition numbers moved 6+24 → 22+8 with both still pinned |
| `packages/domain/test/rules/registry-and-bounds.test.ts` | counts, class table, owner set (FAD-38(7)) | **None — one gained.** A new arm asserts all eleven ruling ids are still cited and every one carries a resolution (the rule-13 arm) |

`canonical-input.test.ts` and `snapshot-contract.test.ts` compiled and were not
touched. **They were not re-run** (they need the embedded cluster).

### 10a. The rest of the changed-file disclosure (FAD-42 R-3/R-4)

The table above answered "which v1 consumer failed to compile against v2". That
is a narrower question than "what did this packet change in files it did not
create", and the review was right that the difference was not disclosed. The
remainder, in full:

| File | Change | Assertion lost? |
|---|---|---|
| `packages/domain/test/rules/hard-rule-check.test.ts` | one `toContain` matcher changed subject: `'grouping-unit-not-pinned'` → `'candidateFacts'` | **None, and the description needs to be exact.** This is NOT a widened tolerance — it is a *different* substring, because the REASON the kind is undecidable changed. The grouping unit is pinned now (RK-RULING-01), so what a publication caller lacks is the build horizon, and the explanation says so. The assertion class is unchanged (an undecidable kind BLOCKS with a stated reason rather than passing), and the opposite direction — the same kind DECIDED when the facts are supplied — is now pinned immediately below it, which the original could not express at all because the kind was undecidable for every caller. The new substring is shorter and therefore admits more strings; that much of the review's reading is right, and it is the reason this row exists |
| `apps/api/test/solver/synthetic-problem.ts` | `isOnCall: false` added to every synthetic shift type (FAD-39) | **None.** The field is new in v2 and `false` is what a non-call shift is; no boundary proof reads it. It is listed here because it is a second, separate edit to a file the table above already names for a different reason |
| `apps/api/test/support/solver.ts` | the worker interpreter resolution flipped to prefer the repository-relative venv, with `SP_SOLVER_WORKER_COMMAND` still winning | **None.** Discovery order only. Disclosed because it changes which interpreter every solver proof in the suite runs against, which is exactly the kind of change that should never be silent |
| `apps/api/test/audit/outbox-dispatch.test.ts` | an `afterAll` that finalizes the file's queued jobs and asserts zero remain (FAD-40) | **None — one gained.** §20 |
| `apps/api/test/audit/periodic.test.ts` | an `afterAll` that unlocks and executes the `audit.*` jobs the file creates and asserts zero remain (FAD-41) | **None — one gained.** §25 |

Neither audit file's existing assertions were touched; both are additions in a
hook that runs after every test in the file.

## 11. What is NOT done, stated plainly

- `apps/api/src/solver/` compile-to-request and candidate validation — the
  seam is designed (`CandidateFacts`) and the checker is ready to consume, but
  nothing wires the snapshot into it and nothing rejects a bad worker result yet.
- The E1 corpus (all §6d classes, seeds, manifest, asserted hashes), including
  the race-produced retired-holding fixture.
- The new red-case arms: model-constraint-dropped, checker-disabled,
  fail-closed-kind-skipped.
- Both-direction pins for the sixteen newly-evaluable kinds beyond the four
  rewritten ones.
- Solver-vs-checker agreement assertions; S-05t/S-06t/S-07t re-anchored against
  the REAL solve; S-08t determinism on B-small.
- The full acceptance battery.

---

# PART 3 — the continuation, 2026-08-14

Parts 1 and 2 are retained unchanged. This part records what the **continuation
agent** did: it fixed the two blockers Part 2's step-08 diagnosed, completed the
remaining §6d scope, and ran the full acceptance battery.

## 12. Local development: the worker interpreter

**Nothing user-specific is committed anywhere.** `apps/api/test/support/solver.ts`
resolves the worker interpreter in four documented rungs — an explicit
`SP_SOLVER_WORKER_COMMAND`, a `SP_SOLVER_VENV` root, repository-relative
discovery, then the generic `python3`. `worker-interpreter.test.ts` pins the
order, including an arm asserting no discovered path is anchored to `$HOME`.

For a local checkout, either export the interpreter:

```bash
export SP_SOLVER_VENV="$HOME/.venvs/sp-solver"     # or
export SP_SOLVER_WORKER_COMMAND="$HOME/.venvs/sp-solver/bin/python"
```

…or make the repository-relative discovery path resolve, which is what this
worktree does so that a plain `corepack pnpm check` works with no environment at
all. `solver/.venv/` is gitignored:

```bash
mkdir -p solver/.venv/bin
ln -s "$HOME/.venvs/sp-solver/bin/python" solver/.venv/bin/python
cp "$HOME/.venvs/sp-solver/pyvenv.cfg"    solver/.venv/pyvenv.cfg
ln -s "$HOME/.venvs/sp-solver/lib"        solver/.venv/lib
```

`pyvenv.cfg` and `lib` are needed as well as the interpreter: CPython locates a
venv from the directory the executable lives in, so a bare symlinked `python`
resolves to the system installation and OR-Tools is absent again.

**The 3.12/image rerun remains the standing CI condition.** Everything here ran
on CPython 3.9.6 with ortools 9.15.6755 under the FAD-7 substitution.

## 13. The two step-08 blockers, root-caused

### 13a. The interpreter (cause 1) — the harness, not the environment

`apps/api/test/support/solver.ts:84` read `options.command ?? 'python3'` and
wrote it in a `beforeEach`. That is not a default, it is an **override**, and it
silently beat the operator's own `SP_SOLVER_WORKER_COMMAND` — the variable was
set and then unset, one hook later. Step-07's "the variable is not reaching the
spawned child" was the right observation and the wrong inference: it reached the
process fine and was overwritten inside it.

`rpc-auth.test.ts` additionally spawned `python3` directly in four places; that
was the whole of its seven failures, and it needed no re-anchoring.

The parent's `crashed` attribution was correct throughout and is unchanged. A
child that dies on `from ortools.sat.python import cp_model` **has** crashed.

**Verified non-vacuously**: `runtime.py` reads OR-Tools from package METADATA and
records `stub-only` when it is absent, so `worker-round-trip` now asserts
`solverVersion` contains `ortools-`. Under the old wiring that string was
unreachable. Observed: `stub-1+ortools-9.15.6755`.

### 13b. The FEASIBLE re-anchoring (cause 2)

The stub could never prove optimality; the real CP-SAT model can and does. Four
assertion sites meant *solved* and said `FEASIBLE`. They now assert membership in
`SOLVED_STATUSES = ['FEASIBLE','OPTIMAL']`.

`FEASIBLE` and `OPTIMAL` remain **distinct** (SPEC-04 §2/§7). Nothing that means
a specific status moved: `response-refusals` still refuses `['OPTIMAL','deadline']`
and its nine siblings by exact status, `worker-invariants` still asserts the stub
never claims `OPTIMAL`, and `worker-lifecycle`'s two `FEASIBLE` assertions are
untouched because they run the **stub** behaviours, which genuinely cannot prove
optimality.

## 14. Re-anchoring table — the DELTA this round added

Part 2 §9/§10 recorded five. This round adds six, each disclosed here.

| # | File / anchor | Change | Why it had to move | Assertion lost? |
|---|---|---|---|---|
| 6 | `worker-round-trip.test.ts:86` | `toBe('FEASIBLE')` → `SOLVED_STATUSES` contains | the stub could not prove optimality; the real model does | **None.** The subject is "a believable candidate comes back" |
| 7 | `worker-round-trip.test.ts:205` (×6 non-ASCII) | same | same | **None.** The subject is "the round trip completed" |
| 8 | `response-refusals.test.ts:279` | same | same | **None.** The subject is "the HONEST worker is believed" |
| 9 | `provider-boundary-solver.test.ts:196` | same | same | **None.** The subject is "the two-phase orchestration runs" |
| 10 | `rpc-auth.test.ts` ×4 | `spawnSync('python3', …)` → `spawnSync(WORKER_INTERPRETER, …)` | the arms spawned an interpreter with no OR-Tools | **None.** Pure wiring |
| 11 | `scripts/red-cases/run.mjs` — `rule-kind-registry` anchor | `\| One owner ruling away… \| 11 \|` → `\| Unique node kinds \| 30 \|` | **see below** | **None.** Still one hand-edited number in the committed artifact |

### 14a. The registry red arm was BROKEN, not failing — and only `red-cases` could see it

The `rule-kind-registry` arm tampers with a row of the **generated** registry.
Part 2's commit `cb3d76f` regenerated that artifact (the eleven RK-RULINGs
answered every open ruling), so the row the arm anchored to changed label and
value — `| One owner ruling away, nothing else needed | 11 |` became
`| Still ONE OPEN owner ruling away, nothing else needed | 0 |`.

The runner then threw `anchor not found`, which is a **broken** case rather than
a failing one, and a broken case proves nothing at all. It went unnoticed because
`pnpm check` and `pnpm red-cases` are different batteries: the registry *gate*
stayed green throughout — the committed and generated artifacts agreed — and only
the arm that tampers with the artifact could see the row had moved. Part 2 ran
`check` and did not run `red-cases`.

Re-anchored to `| Unique node kinds | 30 |`, the most **durable** count in the
artifact: it counts the closed AST node set, so no ruling, no owner reassignment
and no milestone *sequencing* moves it. **It is not immovable, and the earlier
wording here — "no ruling, no owner assignment and no milestone can move" — was
too strong (FAD-42 R-5).** Adding a rule-node kind changes it, and that is a
thing a later milestone may legitimately do; `RULE_NODE_KINDS` is closed today,
not closed forever. The claim is that this anchor survives the changes this
packet's class of work makes, not that it survives everything. If a future packet
adds a node kind, this arm needs re-anchoring again — and the lesson of §14a is
precisely that a broken arm is silent, so the re-anchoring must be deliberate
rather than discovered.

Verified both directions: tampered → gate `EXIT=1`; restored → gate `EXIT=0`.

## 15. Additions this round

### 15a. Code

| File | What |
|---|---|
| `apps/api/src/solver/candidate-validation.ts` | **new rejection class `ineligible-assignment`** — see §16 |
| `apps/api/src/solver/solver-client.ts` | `SolveOutcomeDetail`: explanation (T0 + T1 + the four closed SPEC-04 §5 states), objective tiers, objective value, refusal **code**. API-local and additive; `packages/domain/src/ports/solver-port.ts` is NOT in this packet's glob and did not move |
| `apps/api/src/solver/build-input.ts` | `createDispatchAndValidateBuild` (the whole pipeline), `validateBuildOutcome` (pure, so a probe can substitute a hand-built wrong output), `isUsableBuild` (the single predicate) |
| `solver/schedulepoint_solver/cpsat_adapter.py` | a FEASIBLE result that ran out of clock now reports `deadline`, not `completed` — see §17 |

### 15b. Tests

| File | Cases |
|---|---|
| `apps/api/test/solver/worker-interpreter.test.ts` | 8 — the resolution order, pure over injected sources |
| `apps/api/test/solver/corpus/**` | the E1 corpus: generators, manifest, agreement (16 cases across two files) |
| `apps/api/test/solver/incorrect-worker-output.test.ts` | 8 — hand-built wrong outputs, refused |
| `apps/api/test/solver/model-independence.test.ts` | 1 — the red arm's subject |
| `apps/api/test/solver/real-solve-lifecycle.test.ts` | 7 — S-05t/06t/07t/08t/09t against the real solve |
| `apps/api/test/profiles/granted-while-retiring-inertness.test.ts` | case **(e)** added; nothing above it touched |

### 15c. Red-case arms (three new, `scripts/red-cases/**` ADDITIONS)

`solver-model-constraint-dropped` · `solver-checker-disabled` ·
`solver-fail-closed-kind-skipped`. Each verified in **both directions
standalone** before the battery — [`step-11-red-arms.txt`](step-11-red-arms.txt).

## 16. The finding: the validator did not check ELIGIBILITY

The race-produced corpus fixture found it, and it is real.

`validateCandidate` **accepted** a candidate staffing the raced membership on the
raced shift type. The four existing rejection classes have nothing to say about
it — the row references nothing unknown, is not duplicated, and the snapshot
carries no HARD rule about the qualification — and the holding itself is carried,
in window and `valid`. Only the frozen verdict withholds eligibility (FAD-35).

The solver model cannot produce such a row: it builds no variable for an
ineligible pair. **That is precisely why the independent checker had to learn to
refuse it** — the whole point of an independent checker is that it does not
assume the model did its job, and a translation defect, a hand-built response and
a compromised worker all produce the same row.

`ineligible-assignment` reads the verdict from the snapshot and never recomputes
it (S-01; `packages/domain/src/eligibility/**` stays FROZEN and untouched). An
**absent** verdict is not eligibility: the check is a positive membership test, so
an assembly that dropped a verdict fails closed.

Mutation control: the un-raced CONTROL pair in the same captured snapshot is
accepted.

## 17. Two predictions I recorded wrong, and one honesty fix

Recorded rather than quietly fitted, because a prediction that had to move is the
thing worth writing down.

1. **`B-locum-shaped` was predicted `MODEL_INVALID`.** The worker answers
   `FAILED`/`rejected` — the FAD-34 word for *declined the request*, and correct:
   `MODEL_INVALID` means CP-SAT found a model ill-formed, and a refusal never
   built one. The expectation moved; the corpus now also asserts the refusal
   **code**, so the fail-closed claim does not rest on the status alone.
2. **`B-infeasible-contradictory-rules` demanded only `AUX`.** CP-SAT returned
   the *smaller* sufficient subset `['__demand__','ci-implies']` — correctly:
   with no `EVE` demand the coverage equality already zeroed `EVE`, so
   `ci-implies` alone contradicted it and `ci-mutex` was never needed. The fixture
   was contradictory, but not for its class's reason. `EVE` is now demanded too,
   so neither rule alone suffices and the subset must name both. It does.
3. **A FEASIBLE result that ran out of clock reported `completed`.** Both pairs
   are honest under SPEC-04 §2, but they are different operational facts — "the
   best it could do in the time" is a reason to raise a budget and "it finished"
   is not. `cpsat_adapter` now reports `deadline`, using the **same** wall-clock
   predicate the `UNKNOWN` branch already used so the two cannot drift. `OPTIMAL`
   is never attributed to a deadline: a proof of optimality is a completion
   whenever the clock happens to expire.

A fourth, in my own test rather than in the product: `incorrect-worker-output`'s
breach cases asserted only that **some** breach was found, and a probe showed
every one of them passing for the wrong reason (a one-row candidate under-fills
coverage everywhere, so `rh-min` breached 28 times and drowned the breach each
case was about). Each case now names the rule that must catch it. Without that
repair, red arm `solver-checker-disabled` would have reported PROVEN with its
api-side half blind — the exact shape the `retired-verdict` arm was repaired for
at the 000C integration.

## 18. Battery

Run serially, `uptime` checked before each, from this worktree with the
repository-relative venv discovery in place (no environment variables set).

| Step | Command | Transcript | Result |
|---|---|---|---|
| 12 | `corepack pnpm check` | [`step-12-check.txt`](step-12-check.txt) | **15 gate(s): 15 passed, 0 failed** · unit 1893/1893, 149 files. **The `EXIT=` marker is ABSENT** — the parent shell was terminated at a session pause after the run had written. The runner's own complete summary IS present and is its verdict, not an inference; a failed gate would show `FAIL` in the table and be counted. The exit code is not claimed here and is left to the orchestrator's acceptance rerun |
| 13 | `corepack pnpm red-cases` | [`step-13-red-cases.txt`](step-13-red-cases.txt) | **47 case(s): 47 proven, 0 not proven** · `RED-CASES EXIT=0`. Includes the three new solver arms, all `pass / fail / PROVEN`, and the re-anchored `rule-kind-registry` arm |

## 19. The C-2 fixture-regression failure — OPEN, and handed over

`corepack pnpm fixture-regression` FAILED (step-14, retained): 135 runs, 134
passed, one failed under **fixed seed 123456** —
`test/audit/crash-restart.test.ts`, both C-2 arms. FAD-15 ruling 3 governs: a
defect to fix, never a flake to retry. **It is not fixed, and it is not mine to
close on the evidence I have.**

### 19a. The mechanism, captured (step-17)

```
Error: the queue still holds 1 job(s) after 45000 ms;
       block B cannot establish its precondition
    at drainQueue (apps/api/test/audit/crash-restart.test.ts:279)
```

One job in `graphile_worker._private_jobs` will not drain in 45 s. C-2's
precondition is correct, is declared, and is established the production way — it
is the only thing in the file that could have caught this, and it did.

The durations corroborate: failing runs 149.0 / 149.03 / 148.59 s against 104.35 s
for the passing one — a ~45 s delta, exactly one `drainQueue` budget.

### 19b. Reproduction matrix

| Conditions | Result |
|---|---|
| `crash-restart.test.ts` standalone ×10 | **10/10 PASS**, `EXIT=0` each (step-15) |
| full suite, seed 123456, on this branch | **3 of 4 FAIL** (gate run, attempt 2, attempt 3; step-16's attempt passed) |
| full suite, seed 123456, at base `470b0f2` ×3 | **0 of 3** showed the C-2 failure (17 pre-existing solver failures, as expected at that checkpoint) |

The base control neither convicts nor acquits: for an intermittent, three green
C-2 outcomes are not proof of absence, and the file set differs (my test files do
not exist at base, so the shuffle order differs).

### 19c. The bounding census — zero enqueue paths in this packet

| Surface | Result |
|---|---|
| 11 new/changed test + support files, grepped for `graphile`, `_private_jobs`, `outbox`, `queue_pools`, `OutboxRunner`, `OutboxSink`, `publishOutboxEvent`, `recordAuditEvent`, `addJob` | **0 hits in every file** |
| every ADDED line in `git diff 470b0f2..HEAD -- apps/api/test/` against the same pattern | **0** |
| `apps/api/src/solver/**` for any publish/enqueue path | **NONE** — the solver path never publishes and never records audit |
| non-vacuity control: the same pattern over `crash-restart.test.ts` / `outbox-dispatch.test.ts` | **27 / 100 hits** |

The only enqueue path in api src is `queue-schema.ts`'s `add_job` wrapper, and
the only task name is `outbox.dispatch` — so the orphan is not a wrong-task-name
job the drainer cannot see. It is an `outbox.dispatch` job that will not complete
inside 45 s, which points at retry backoff on a dispatch that keeps failing.

**A named suspect, NOT a conclusion:** `outbox-dispatch.test.ts`'s I-11 arm
deliberately fails a sink and leaves `outbox_events.state='failed'` with the
job it published still queued. That is a pre-existing producer and a pre-existing
consumer. What this packet plausibly changed is **timing** — the solver proofs
add ~40 s of suite runtime (real-solve-lifecycle 24 s, corpus-agreement 14 s),
which moves which backoff window `crash-restart` lands in. That is a hypothesis
with a motive, not a measurement.

### 19d. What I tried to capture, and why it failed

The decisive datum is the orphan job's `task_identifier`. I instrumented
`apps/api/test/support/setup-env.ts` (my own glob, temporary, never committed) to
dump `_private_jobs` after every file. **It backfired and produced nothing**: an
`adminClient()` connect/end in every file's `afterAll` destabilised the harness —
64 of 121 files failed, 572 tests skipped, the standing contention signature —
and no `QUEUE-LEFTOVER` line was ever printed. The instrumentation is **reverted**;
the tree is clean. A capture that needs a connection per file needs a different
mechanism (a single pooled client, or `globalSetup` teardown), and that is the
first thing the continuation should build.

### 19e. Status

**OPEN.** Not fixed, not ruled a flake, not attributed. The producer is unnamed
because the one experiment that would name it has not succeeded yet. The
remaining battery (`fixture-regression` re-run, `sbx`, `migrate:cycle`
0001–0017, the corpus per-class summary transcript) is **NOT RUN** and no claim
is made about it.

---

# PART 4 — after FAD-40 (the C-2 grant), 2026-08-15

Rebased onto `main` (docs-only commits since the branch base; clean, thirteen
commits replayed). Every api-suite run below used the venv worker interpreter via
`SP_SOLVER_WORKER_COMMAND`; the path is an environment variable at the call site
and appears in no committed file.

## 20. The FAD-40 fix — what it is, and what it does

**Granted file, and the only file changed:**
[`apps/api/test/audit/outbox-dispatch.test.ts`](../../../apps/api/test/audit/outbox-dispatch.test.ts).
`crash-restart.test.ts` was not opened for editing. Nothing outside the grant was
touched.

### 20a. What the file was leaving behind — measured, not assumed

Before writing anything I dumped `graphile_worker._private_jobs` from the file's
own `afterAll` (temporary, replaced by the fix; the run is scratch and is not
retained as a step):

```
jobs left = 20
every row: task `outbox.dispatch`, attempts 0, max_attempts 25,
           run_at = created_at, locked_at null, last_error null, is_available true
```

Eleven rows are the owned fixture's seeded outbox events; nine are the tests'.
Every `mutateAndPublish` enqueues a real job in the caller's transaction — that is
the atomicity property the first test measures — but the dispatch tests then call
`dispatchOutboxEvent` **directly**, so no worker ever takes those jobs and no job
is ever finalized.

### 20b. The fix

A single `afterAll` that finalizes the file's queue and asserts the result:

| Element | Choice | Why |
|---|---|---|
| Mechanism | `drainQueue` from [`test/support/queue.ts`](../../../apps/api/test/support/queue.ts) — `startOutboxRunner` + the real `DatabaseOutboxSink` | The **production** path. `global-setup.ts` already does exactly this for the baseline fixture and states the rule: *"no file inherits a backlog it did not create"* |
| Not a `DELETE` | Rejected | A test that empties a queue with a statement the system cannot issue leaves the database in a state the system cannot reach — `support/queue.ts`'s own docblock. A raw superuser `DELETE` was available and was **not** used; no harness-cleanup justification was needed |
| The I-11 job | Finalized by the same drain, against a working sink | This is FAD-40's "the production drain with the sink swapped to a succeeding one". It is also what production does: a failed delivery is retried and eventually succeeds |
| Assertion | `expect(await queuedJobs(), …).toBe(0)` in `afterAll` | `afterAll` rather than a final `it`, because `--sequence.shuffle.tests` means no test is reliably last. FAD-15 own-your-state, made visible |
| Diagnostic | On failure the hook dumps every surviving row with its **task identifier**, `attempts`, `run_at`, `locked_by` and `last_error` before rethrowing | §19d's lesson: the datum that was missing last round is the task identifier |

**I-11 is not weakened.** Every assertion in that arm — the domain row, the audit
row, the two-event chain, `state='failed'`, `attempts=1`,
`last_error_code='sink_unavailable'`, `dispatched_at is null` — runs inside the
test against `AlwaysFailingSink` and is unchanged, character for character. The
hook runs afterwards and only finishes the delivery the queue would have finished
anyway. A comment in the arm says so and points at the hook.

### 20c. That it works

| Condition | Result |
|---|---|
| `outbox-dispatch.test.ts` standalone | `EXIT=0`, 12/12, `finalized 20 queued job(s) … the queue this file hands on is EMPTY` ([step-21](step-21-standalone-c2-files.txt)) |
| `crash-restart.test.ts` standalone | `EXIT=0`, 4/4 ([step-21](step-21-standalone-c2-files.txt)) |
| Full suite, seed 123456, position 34 | `finalized 414 / 396 / 424 queued job(s); the queue this file hands on is EMPTY` — three separate runs ([step-19](step-19-fad40-seed-123456-proof.txt), [step-20](step-20-c2-real-cause-audit-checkpoint.txt) §B) |

## 21. The withdrawn NR — this was a real pre-existing coupling, it is now NAMED

§19e handed C-2 over **OPEN, not fixed, not ruled a flake, not attributed**. That
posture was right, and the thing it declined to call a flake is real. It is now
attributed — to a *different* producer than FAD-40 records.

**The fix cures what it was granted to cure and does NOT cure C-2.** Stated
plainly rather than left to be discovered at acceptance:

| Seed-123456 runs | Before the fix | After the fix |
|---|---|---|
| C-2 arms failing | 3 of 5 | **4 of 7** |
| outbox-dispatch's leftovers | 20 rows | **0 rows** |

Removing ~400 jobs from the backlog moved the failure rate not at all — the
signature of an orthogonal change.

### 21a. The job that starves the drain, captured

§19d predicted the continuation's first job: *"a capture that needs a connection
per file needs a different mechanism"*. Built, and it worked. The harness cluster
is a real PostgreSQL on `127.0.0.1`, so a **superuser poller outside the Vitest
process** sampled `_private_jobs` every 1.2 s for a whole run. No file was
instrumented; nothing was committed; the harness was not perturbed.

During crash-restart's 45-second precondition drain the queue holds exactly one
job, and it is:

```
id 1352 · identifier audit.checkpoint · attempts 1 · max_attempts 25
run_at 10:45:45.091 (in the PAST) · locked true, by pool-ff544f08fcafabf3ec
is_available false · last_error null
```

Every clause of FAD-40's recorded mechanism is contradicted by that row:

| FAD-40 says | Measured |
|---|---|
| the job is `outbox-dispatch`'s I-11 `AlwaysFailingSink` job | it is `audit.checkpoint`, from `periodic.test.ts` |
| graphile-worker rescheduled it with exponential backoff | `attempts=1`, `last_error` null — **it never failed**; `run_at` is in the past |
| the drain worker cannot take a future-`run_at` job | `run_at` is not in the future; the drainer cannot take it for two other reasons (§21b) |

### 21b. Why the drain can never take it — two independent reasons

1. **The task is not registered.** `crash-restart.test.ts`'s drainer is started
   without a signer, and `startOutboxRunner` registers `periodicTasks = {}` in
   that case — so its task list is `outbox.dispatch` and nothing else.
   graphile-worker claims only jobs whose identifier is in the task list. An
   `audit.checkpoint` job is invisible to it forever: no timeout, no error, no
   retry, just a count that never reaches zero.
2. **It is locked by a dead pool**, and the drainer passes
   `staleAfterMs: 3_600_000` *precisely so that it will not reclaim anybody's
   lease*. Even a drainer that knew the task could not have it for an hour.

### 21c. Where the job comes from — `apps/api/test/audit/periodic.test.ts`

The poll shows both `audit.checkpoint` rows and the order they appear in:

```
10:45:42  job 1351  attempts 0, available   ← the no-signer test's deliberate job
10:45:45  job 1352  attempts 1, LOCKED      ← R-03's job, claimed by R-03's runner
10:45:55  job 1351 gone (the no-signer test's `finally` DELETE);
          job 1352 still locked — and still locked 45 s later
```

Two conditions have to line up, and both are order- or race-dependent — which is
exactly the observed 3-to-4-in-7 intermittency:

- **(i)** `--sequence.shuffle.tests` puts `a runner without a signer registers NO
  periodic task` FIRST, so its `delete … where identifier like 'audit.%'` runs
  **before** R-03 enqueues 1352 and cleans up nothing of R-03's;
- **(ii)** R-03's `finally { await runner.stop() }` races its own in-flight job:
  the checkpoint row commits inside the task, the poll that gates the test sees
  it, and the runner is stopped before graphile-worker writes the job's
  completion — leaving `attempts=1` locked by a pool that then disappears.

Either alone is survivable. Together they hand a permanently undrainable job to
whatever file next tries to empty the queue.

### 21d. ESCALATION — the cure is outside the grant

None of the three places that could fix this is inside FAD-40's one-file grant:

| Candidate site | Status |
|---|---|
| `apps/api/test/audit/periodic.test.ts` — the cleanup that does not always run, and the stop/complete race | **not granted** |
| `apps/api/test/audit/crash-restart.test.ts` — the drainer's task-list blind spot and `staleAfterMs` | **PROHIBITED by this packet** |
| `apps/api/test/support/queue.ts` — the shared drain helper both files use | **not granted** |

So the packet's "green TWICE at the exposing seed" **cannot be met from inside the
grant**, and no attempt was made to meet it by any other means. The granted change
is retained on its own merits: it is FAD-40's first exit condition, it is proven,
and it removes ~400 jobs of inherited backlog. It is simply not the cure.

A note on shape, for whoever writes the next grant: the honest fix is probably at
the shared resource rather than in either file — the same conclusion
`global-setup.ts` already reached ("the fix belongs at the shared resource, not in
every test that meets it"). A drain that cannot see `audit.*` jobs is a drain that
cannot establish the precondition it exists to establish, and it fails silently by
counting rather than loudly by naming.

**Nothing in `pnpm check` is exposed to this**: `gate:unit` is a plain
`vitest run` with no shuffle. The exposure is `fixture-regression`, whose fixed
seed set contains 123456 by design.

## 22. Battery — the tail §19e left NOT RUN

Serial, `uptime` checked before each (the harness derives ONE PostgreSQL port per
worktree, so two suites in one worktree destroy each other — nothing was run
concurrently). Every `EXIT=` marker is inside the redirected block.

| # | Command | Transcript | Result |
|---|---|---|---|
| 22 | `corepack pnpm fixture-regression` | [`step-22`](step-22-fixture-regression.txt) | **135 run(s): 135 passed, 0 failed** · `FIXTURE-REGRESSION EXIT=0`. 13 fixed seeds + rotating seed 103876 + the 121-file standalone sweep. **Read the seed-123456 line with the caveat appended to the transcript** — see §22a |
| 23 | `corepack pnpm sbx` | [`step-23`](step-23-sbx.txt) | **17/17**, `SBX EXIT=0` · scenarios required 6 · executed 6 · passed 6 · failed 0 · blocked 0 · vacuous 0. **`readings: 329 (role, context, table) readings across 7 contexts; 0 wrong-tenant rows; 47 of 47 tables observed with visible rows`** — the floor is unchanged and snapshot v2 added no table, as predicted |
| 24 | `corepack pnpm --filter @schedulepoint/api migrate:cycle:embedded` | [`step-24`](step-24-migrate-cycle-embedded.txt) | **MIGRATION CYCLE CLEAN — up → down → up → down → up, 1128 ms**, 0001…0017 all seventeen · `MIGRATE-CYCLE-EMBEDDED EXIT=0` |
| 25 | `vitest run --project api test/solver/corpus/` | [`step-25`](step-25-corpus-per-class-summary.txt) | **16/16**, `CORPUS EXIT=0` · the per-class table, all fifteen §6d classes. Every fixture hash is byte-identical to step-10's — the canonical input is deterministic across runs and across the rebase |
| 26 | `corepack pnpm check` | [`step-26`](step-26-check.txt) | **15 gate(s): 15 passed, 0 failed** · `CHECK EXIT=0`. unit PASS 154696 ms, axe PASS 192135 ms. This closes §18's step-12 gap: that transcript's `EXIT=` marker was absent and the exit code was explicitly not claimed. **It is claimed now, on the tree that contains the FAD-40 fix** |
| 27 | `corepack pnpm red-cases` | [`step-27`](step-27-red-cases.txt) | **47 case(s): 47 proven, 0 not proven** · `RED-CASES EXIT=0`. Every arm `GREEN pass / RED fail`. See §22c(1) for the killed first attempt and the restore |

### 22a. The corpus per-class summary (step 25)

| Class | Fixture | Hash | Outcome | Independent checker | Cause match |
|---|---|---|---|---|---|
| feasible-small | B-feasible-small | `fe6cbb2d8440` | OPTIMAL/completed | 0 hard violations | — |
| feasible-medium | B-feasible-medium | `791c4710f309` | OPTIMAL/completed | 0 | — |
| feasible-large | B-feasible-large | `dfd8574fa1d7` | OPTIMAL/completed | 0 | — |
| multisite | B-multisite | `300d6427ecef` | OPTIMAL/completed | 0 | — |
| rule-heavy | B-ruleheavy | `89ff810ff670` | OPTIMAL/completed | 0 (22 HARD kinds, 30 assignments) | — |
| progressive-pinned | B-progressive-pinned | `32cd27e3a4e3` | OPTIMAL/completed | 0 | — |
| qualifications | B-qualifications | `ec332922122d` | OPTIMAL/completed | 0 | — |
| fte | B-fte | `4a457dbfea06` | OPTIMAL/completed | 0 | — |
| locum-shaped | B-locum-shaped | `c37f6f7338c8` | **FAILED/rejected** | n/a | — (the refusal arm) |
| fairness-shaped | B-fairness-shaped | `492e4d98422a` | OPTIMAL/completed | 0 | — |
| infeasible-contradictory-rules | B-infeasible-contradictory-rules | `ed2de3578cf9` | INFEASIBLE/completed | n/a | `EXPLAINED_SUBSET` T1[`__demand__`, ci-implies, ci-mutex] |
| infeasible-missing-qualification | B-infeasible-missing-qualification | `42e2de116235` | INFEASIBLE/completed | n/a | `EXPLAINED_EXACT` T0[no_eligible_member ×3] |
| infeasible-over-demand | B-infeasible-over-demand | `f5a210d51e0a` | INFEASIBLE/completed | n/a | `EXPLAINED_EXACT` T0[eligible_capacity_below_demand ×3, day_demand_exceeds_participants ×3] T1[`__demand__`] |
| infeasible-fixed-conflict | B-infeasible-fixed-conflict | `fc22e3adc59b` | INFEASIBLE/completed | n/a | `EXPLAINED_EXACT` T0[conflicting_fixed_assignments] T1[`__demand__`] |
| race-retired-holding | B-race-retired-holding | `6b4ececa0726` | INFEASIBLE/completed | n/a | `EXPLAINED_EXACT` T0[no_eligible_member] |

Objective tiers recorded for `fairness-shaped`: `10:preference(42) 20:work-percentage(6) 30:fairness(2)` — SOFT never became HARD.

### 22b. The seed-123456 line in step 22 is a coin flip, not a cure

The gate reports `PASS  seed 123456  104.5s`. It does not mean C-2 is fixed, and
this bundle does not let that reading stand unqualified:

- with the FAD-40 fix in place, **seven independent runs at seed 123456 gave 4
  failures and 3 passes** (§21, step-20 §B);
- a failing run takes ~149 s against ~105 s for a passing one — one 45 s
  `drainQueue` budget, and the duration is the tell;
- the cause is measured, named and **outside the grant** (§21c/§21d).

A gate that passes because a coin landed green is reported as exactly that.

### 22c. Two disclosures about how the battery ran

1. **`red-cases` was SIGKILLed by my own 10-minute command timeout** partway
   through the `provider-boundary-runtime-mutation` arm. A red case injects its
   violation into the tree and reverts it afterwards, so the kill left the
   injected line in `apps/api/src/db/provider-boundary.ts`. The *next* attempt
   refused to run against it and said so precisely — `GREEN (clean tree): GATE
   FAILED`, then `anchor not found` — which is the harness detecting that its own
   precondition was false rather than measuring a lie. The file was restored with
   `git checkout --` after verifying the diff was exactly the injected line and
   nothing else, and the retained run starts from a clean tree. No production
   source is modified by this packet.
2. **A comment-only edit landed mid-gate.** The `outbox-dispatch.test.ts`
   docblock originally said the leftover jobs were what failed C-2 at seed
   123456; §21 disproved that, so the claim was corrected while
   `fixture-regression` was between seeds. The change is inside a `/** … */`
   block — zero behavioural difference — but seed 1 of step 22 ran against the
   pre-correction text and is recorded here rather than left to be noticed.

## 23. Transcript hygiene — every step accounted for

Steps 01–27 plus two probes are present in this bundle. `EXIT=` markers, and the
reason where one is absent:

| Transcript | Marker | If absent, why |
|---|---|---|
| `probe-01-snapshot-gap.txt`, `probe-02-ortools-and-t1.txt` | none | Escalation probes, not gate runs — narrative with quoted output |
| `step-01` … `step-07` | `EXIT=0/1` each | — |
| `step-08-diagnosis.txt` | none | A written diagnosis of step-07's failures, not a command run |
| `step-09`, `step-10`, `step-11`, `step-13`, `step-14`, `step-16` | present | — |
| `step-12-check.txt` | **absent** | Recorded and explained in §18: the parent shell was terminated at a session pause after the run had written. **Superseded by step 26**, which carries `CHECK EXIT=0` on a tree that contains this round's change |
| `step-15-c2-repeats.txt` | per-run `EXIT=` | — |
| `step-17-c2-failure-capture.txt` | inside the captured vitest block | A failure capture; the exit is the captured run's own |
| `step-18-orchestrator-seeded-repro.txt` | `EXIT=1` | The orchestrator's own seeded reproduction, untracked until now and **committed with this round** so the chain is complete |
| `step-19` … `step-27` | present | This round |

Nothing was written to `docs/evidence/` by a gate: `pnpm check`, `pnpm sbx` and
`pnpm red-cases` all ran in scratch mode (`.evidence-scratch/`, gitignored), so
the tracked bundles of earlier packets are untouched.

## 24. Status at hand-off

| Item | State |
|---|---|
| FAD-40 granted fix | **DONE**, proven standalone and in-suite; `outbox-dispatch.test.ts` leaves zero queued jobs and asserts it |
| FAD-40's recorded *mechanism* | **DISPROVEN**, with the measurement that disproves it (§21, step-20) |
| C-2 starvation | **NOT FIXED — ESCALATED.** Cause measured and named: an `audit.checkpoint` job from `periodic.test.ts`, locked by a dead pool, invisible to a signer-less drainer. Cure needs a grant on `periodic.test.ts` and/or the shared drain |
| "Green twice at the exposing seed" | **NOT MET, and not claimable.** 4-of-7 failures at seed 123456 with the fix in place |
| Battery tail (§19e's NOT RUN list) | **DONE** — steps 22–27, all green, real exit codes |
| Prohibited files | **UNTOUCHED.** `crash-restart.test.ts` was read, never edited. No production source is modified by this packet |

---

# PART 5 — after FAD-41 (the second grant), 2026-08-15

Rebased onto `6dd8d14` (FAD-41, docs-only; fourteen commits replayed clean).

FAD-41 withdrew FAD-40's causal claim on the capture in §21 and granted
`apps/api/test/audit/periodic.test.ts`. The §20 fix stands on its own merit and
is unchanged.

## 25. The FAD-41 fix — the orphaned `audit.checkpoint` job

**Granted file, and the only file changed this round:**
[`apps/api/test/audit/periodic.test.ts`](../../../apps/api/test/audit/periodic.test.ts).
The `support/queue.ts` fallback the grant allowed was **not needed and not
used** — see §25b. `crash-restart.test.ts` remains PROHIBITED, was read only,
and its 45-second precondition is untouched and unweakened.

### 25a. What the file was leaving, and why nothing downstream could clear it

`periodic.test.ts` creates `audit.checkpoint` jobs deliberately — that is R-03's
whole point, proving the task is *registered* rather than merely written. Two
independent conditions made one of them permanent:

- **the cleanup lived in one test's `finally`.** `a runner without a signer
  registers NO periodic task` ended with `delete … where identifier like
  'audit.%'`. Under `--sequence.shuffle.tests` that test can run FIRST, in which
  case its delete happens *before* R-03 enqueues its job and cleans up nothing of
  R-03's. A cleanup that only runs when the shuffle is kind is not a cleanup;
- **R-03's `runner.stop()` can race its own in-flight job**, leaving the row
  `attempts=1`, `last_error` null, locked by a pool that then disappears.

And nothing downstream can clear such a row, for two further independent reasons
(§21b): `crash-restart`'s drainer is signer-less so `audit.checkpoint` is not in
its task list at all, and it sets `staleAfterMs` to an hour so it will not reclaim
the lease either. Count never reaches zero, no error is ever raised, 45 s elapse.

### 25b. The fix, and why each half is the production-visible path

A single `afterAll`, which runs however the tests are ordered:

| Step | Mechanism | Why this one |
|---|---|---|
| 1. Unlock the orphan | `graphile_worker.force_unlock_workers` | graphile-worker's **own** recovery function — the exact call `src/db/queue-pools.ts`'s `reclaimStalePools` makes (the M1-004 C-2 pattern). Never a hand-rolled `UPDATE` against the library's tables |
| 2. Execute the jobs | `startOutboxRunner` **with the signer**, sweep thresholds left at their DEFAULTS (100 entries / 24 h) | The production runner, with the tasks actually registered. Defaults are what production runs, so the finalization checkpoints only what is genuinely due and stays a no-op for every other file's tenant |
| 3. Assert | `expect((await auditJobs()).length).toBe(0)` | Own-your-state, made visible. On failure the hook dumps the surviving rows with identifier, attempts and `locked_by` before rethrowing |

**Why `reclaimStalePools` could not be called instead — a real gap, not a test
inconvenience.** It considers only pools `where released_at is null`, and a runner
stopped through `stop()` releases its registry row. **A pool that releases cleanly
while still holding a locked job leaves an orphan no production sweep will ever
reclaim.** That is exactly what the §21 capture shows. The observation is recorded
here rather than acted on: closing it is a change to `src/db/queue-pools.ts`, which
is production source and outside every grant this packet holds.

Nothing was deleted, nothing was relaxed. The existing `finally` delete in the
no-signer test is left exactly as it was — it is now a redundant fast path with a
backstop behind it, and removing it would have been churn in a test whose
assertions are not mine to disturb.

### 25c. Proof — the defect appears and is cured, in the act

The two seeded runs are not lucky greens. **In both, the orphan was present** and
the hook reports catching it:

```
· finalize: released 1 stale lease(s) with graphile-worker's own
  force_unlock_workers (the reclaimStalePools call)
· finalize: 1 periodic job(s) executed through a signer-bearing runner;
  zero audit.* rows remain in the queue
```

| Condition | Result |
|---|---|
| seed 123456, run 1 | **121 files / 1255 tests passed**, `RUN-1 EXIT=0`, 105.27 s — orphan released + executed ([step-28](step-28-fad41-seed-123456-proof.txt)) |
| seed 123456, run 2 | **121 files / 1255 tests passed**, `RUN-2 EXIT=0`, 105.87 s — orphan released + executed ([step-28](step-28-fad41-seed-123456-proof.txt)) |
| `outbox-dispatch.test.ts` standalone | 12/12, `EXIT=0` ([step-29](step-29-standalone-three-files.txt)) |
| `periodic.test.ts` standalone | 6/6, `EXIT=0` ([step-29](step-29-standalone-three-files.txt)) |
| `crash-restart.test.ts` standalone | 4/4, `EXIT=0` — unedited ([step-29](step-29-standalone-three-files.txt)) |

The **duration** is the independent corroboration §22b asked for: a failing run
took ~149 s, one 45 s `drainQueue` budget more than a passing one. Both runs here
are ~105 s, and both did the recovery work — the budget is not being spent
because there is nothing left to wait for.

### 25d. Seed-123456 statistics across the whole investigation

| Tree | Failing / runs at seed 123456 |
|---|---|
| Before any fix | 3 / 5 |
| After the FAD-40 fix (outbox-dispatch only) | 4 / 7 |
| **After the FAD-41 fix (periodic)** | **0 / 2, with the orphan observed and cured in both** |

Two runs cannot prove absence, and this bundle does not claim they do. What
raises them above a coin flip is that the failure *precondition* — the locked
orphan — was present in both and is reported by the hook that removed it. The
gate in step 30 runs seed 123456 a third time inside its fixed set.

## 26. Battery, round two

| # | Command | Transcript | Result |
|---|---|---|---|
| 28 | seed 123456 ×2 | [`step-28`](step-28-fad41-seed-123456-proof.txt) | `RUN-1 EXIT=0` · `RUN-2 EXIT=0` — 1255/1255 both, 105.27 s / 105.87 s, **orphan released and executed in both** |
| 29 | the three C-2 files standalone | [`step-29`](step-29-standalone-three-files.txt) | outbox-dispatch 12/12 · periodic 6/6 · crash-restart 4/4, all `EXIT=0` |
| 30 | `corepack pnpm fixture-regression` | [`step-30`](step-30-fixture-regression-after.txt) | **135 run(s): 135 passed, 0 failed** · `FIXTURE-REGRESSION EXIT=0`. All 13 fixed seeds (123456 among them, 104.8 s), rotating seed **373753**, and the 121-file standalone sweep |
| 31 | `corepack pnpm check` | [`step-31`](step-31-check-after.txt) | **15 gate(s): 15 passed, 0 failed** · `CHECK EXIT=0`. unit PASS 153322 ms — the unit gate saw the changed test file |

### 26a. What was deliberately NOT re-run, and why

`sbx` (step 23), `migrate:cycle:embedded` (step 24) and the corpus per-class
summary (step 25) are **not re-run**, and their step 22–27 results stand.

The FAD-41 change is confined to one **test** file's `afterAll`. It adds no
migration and cannot reach the migration cycle; it adds no table and cannot move
`sbx`'s 47-of-47 readings floor; it touches no solver, fixture or canonical-input
code and cannot change a corpus hash. `red-cases` is likewise not re-run: no gate
and no red-case arm reads `apps/api/test/audit/periodic.test.ts`, and step 27's
47/47 was proven on a tree whose only difference is this hook. Stated rather than
re-run, so the omission is a claim on the record and not a gap.

`pnpm check` **was** re-run, because its unit gate executes the changed file.

---

# PART 6 — the repair round, after FAD-42, 2026-08-15

Rebased onto `004a607` (FAD-42, docs-only; fifteen commits replayed clean). The
independent review returned **REVISE**; this part answers its findings and
nothing else. Probes live on `review/m4-002` under `.review-m4-002/` and are not
merged.

## 27. The repair, finding by finding

### 27a. R-1 (BLOCKING) — `MinimumRestBetween` never reached past the next day

**The defect.** `cpsat_adapter._hard` paired each date with
`window_dates[index : index + 2]` — this date and the next. Every rest pair
further apart was never posted. The checker compares chronologically ADJACENT
assignments at *any* distance, so the two implementations disagreed for every
`minHours` a gap day could span.

Fail-closed held — §3.3's redundancy did its job and the reviewer proved it in
production form — but a **legal** 48-hour rest rule could never produce a usable
build, and the engine reported *worker output rejected* where the honest answer
was INFEASIBLE. Those read very differently to an operator.

**The fix.** The pairing now walks forward until the day distance exceeds a
bound, and `_rest_hours` (unchanged, exact) decides every pair:

```python
max_day_span = int(min_hours // 24) + 2
for later in window_dates[index:]:
    if M.day_number(later) - M.day_number(date) > max_day_span:
        break
```

Two things are worth stating rather than assuming.

**The bound is an over-estimate, deliberately.** A shift ends at most 48 h after
the start of its own date (23:59 plus `crossesMidnight`) and the later shift can
start at 00:00 of its date, so a day difference of `D` guarantees at least
`D * 24 - 48` hours apart; a breach needs `D * 24 - 48 < min_hours`, i.e.
`D < min_hours / 24 + 2`. The bound only decides how much work to do — never what
is true, because the arithmetic still runs on every pair inside it.

**Posting every short pair is EQUIVALENT to the checker's adjacent-only rule, not
merely stricter.** If some pair `(a, c)` is too close then `a`'s immediate
successor `b` has `start(b) <= start(c)`, so the adjacent pair `(a, b)` is at
least as close and breaches too. `chronological()` sorts by `startsAtMs`, which
is what makes that argument hold. The two formulations accept exactly the same
schedules — so this is a repair, not a tightening that could reject a legal
schedule.

**The sibling window kinds were re-checked and are complete**, as the reviewer
found: `MaxConsecutive` walks every run, `MaxAssignmentsInWindow` walks every
block of `windowDays`, and `CallSpacing` walks `window_dates[index + 1 :]` with a
`break` on `minDaysBetweenCalls` plus a separate same-date pair. None of them was
touched.

**The both-direction pin** — [`rest-across-gap-day.test.ts`](../../../apps/api/test/solver/rest-across-gap-day.test.ts),
the reviewer's P8 shape. Demand on dates 1 and 3, none on date 2, one
participant: the only demand-satisfying schedule is 40.00 hours of rest.

| `minHours` | Model | Checker | Agree? |
|---|---|---|---|
| 30 | `OPTIMAL`, 2 rows | 0 breaches, usable | ✅ |
| 41 | **`INFEASIBLE`**, no candidate | the only possible schedule breaches, rule NAMED | ✅ |

The 41 arm asserts both halves because "the model says INFEASIBLE" alone would
not show it is refusing for the right reason. The checker's message is exact:
`40.00 hours of rest before the assignment on 2027-03-03, and this rule requires 41`.

**The pin is proven to catch the defect**, not merely to pass: with the old
pairing restored, the 41 arm FAILS (`expected [ { …(4) }, { …(4) } ] to be null`)
and the 30 control still PASSES — so it is specific to the defect rather than a
blanket failure.

**The corpus fixture.** `B-ruleheavy`'s `rh-rest` was `minHours: 8` — inside one
day, which is precisely why the corpus never asked the model for a pair beyond
the next date and a one-day window looked correct for the whole milestone. It is
now **30**, scoped to `['CAL', 'DAY']`.

**The scope is not decoration, and getting it wrong broke something.** Two
constraints had to hold at once, and the first attempt honoured only one of them.

*`AUX` must stay OUT.* Unscoped at 30 the rule genuinely contradicts `rh-pattern`
— Saturday `DAY` ends 16:00, its Sunday `AUX` segment starts 10:00, an 18-hour
gap — and the corpus run said so precisely:
`EXPLAINED_SUBSET T1[__demand__, rh-pattern, rh-rest]`. That is the engine working
correctly; it is just not what the `rule-heavy` class is for.

*`CAL` must stay IN.* The first attempt scoped to `['DAY']` alone. The corpus went
green and `pnpm check`'s unit gate did not:
`incorrect-worker-output.test.ts` case 5 hands the checker a `DAY` ending 16:00
and a `CAL` starting 18:00 on one date and requires `rh-rest` to be the rule that
names it —
`expected [ 'rh-fixed', 'rh-min', …(26) ] to include 'rh-rest'`. Narrowing the
scope had silently removed that pair from the rule and taken an existing proof
with it. **This is recorded rather than quietly fixed because it is the same
class of defect as R-1 itself** — a rule that stops covering a pair, with nothing
failing at the point of the change — and it was the full battery, not the
targeted run, that caught it.

Scoped to `['CAL', 'DAY']` both hold: the DAY-to-DAY pairs two dates apart
exercise the widened window, the same-date DAY/CAL pair keeps case 5 alive, and
the fixture stays `solved` — `OPTIMAL/completed`, 0 hard violations.

**An honest limitation, stated rather than left to be found.** This fixture is
**coverage, not a regression pin.** Re-run against the defective pairing it still
PASSES (`EXIT=0`), because CP-SAT has six participants and one `DAY` per day and
simply spreads them out — nothing forces it to use the illegal pairing. Only a
fixture whose *only* demand-satisfying schedule breaches can force the defect,
and such a fixture is INFEASIBLE by construction — which no `solved` class can
be. The deterministic proof is the dedicated pin above; the corpus change is what
makes the pipeline exercise `minHours > 24` at all.

A new corpus **class** was considered and rejected: `CORPUS_CLASSES` is "the §6d
class list, verbatim, as a closed set" and the manifest test asserts every class
appears exactly once, so a sixteenth entry is a change to doc 35 §6d — outside
this repair's scope.

### 27b. R-2 — nine raw NUL bytes, repaired hash-neutrally

Nine raw `U+0000` bytes in three committed files, each replaced by the four-character
escape `\x00`. The best evidence that this mattered: `generators.ts` line 71 is a
comment reading *"The `\x00` separator is spelled as an escape deliberately"* — and
it was not. The escape was in the prose and the raw byte was in the code.

| File | Raw NULs | First offset | git verdict |
|---|---|---|---|
| `apps/api/test/solver/corpus/generators.ts` | 3 | 3262 | inside the 8000-byte window → git treated it as **BINARY** |
| `packages/domain/src/rules/hard-rule-check.ts` | 4 | 42168 | outside the window → still text-diffed |
| `apps/api/src/solver/candidate-validation.ts` | 2 | 11321 | outside the window → still text-diffed |

Raw NUL bytes remaining after the repair: **0**.

**Hash neutrality, proven by the corpus itself.** Every fixture identifier flows
through `corpusId`, whose separator was one of the repaired NULs — so if the
spelling had changed the digest, *every* hash would have moved. Regenerating the
E1 manifest:

| | |
|---|---|
| E1 fixtures compared | 15 |
| hash **UNCHANGED** | **14** |
| hash moved | 1 — `B-ruleheavy`, the fixture deliberately changed in 27a |

`B-ruleheavy`: `89ff810ff67002c557993406af78dee422bf37989c167c03ecf13327335515ab`
→ `66f5e0ca57e22e08c729e12f529d9a10c6241b05217cbeafe306b853f47bf635`.
The M3 rule-model corpus at `solver/corpus/manifest.json` is untouched (6 of 6
hashes unchanged).

One note on the git verdict: `git diff` still calls the generator pair binary
while the OLD side (in `HEAD`) contains NULs. From this commit forward it
text-diffs.

**Three MORE raw NULs exist outside this packet, found while verifying the
repair.** A tree-wide scan of every tracked `.ts`/`.mjs`/`.py`/`.json`/`.md` file
turns up three documents this packet never touched:

| File | Raw NULs | First offset |
|---|---|---|
| `docs/evidence/EV-M3-AUTHN/INDEX.md` | 1 | 1812 — **inside the window; git calls this file BINARY** |
| `docs/fable/control/CHANGELOG.md` | 1 | 17383 |
| `docs/fable/control/OPUS-AGENT-RUNBOOK.md` | 1 | 26516 |

They are **not repaired here**: FAD-42 bounds this round to the nine bytes the
review found, and one of the three is a control document. They are reported so
the next hygiene pass starts from a measured list rather than a search. The first
one matters most — an evidence INDEX that git will not text-diff is an evidence
INDEX whose changes nobody can review.

**The M3-008 NUL lesson now has its THIRD occurrence** — `deriveTestPgPort`,
then the M3-008 case the generator's own comment cites, and now this. Three
times is not a coincidence, it is a pattern: a raw NUL is load-bearing, invisible
to a reader, invisible to grep, and it silently disables `git diff` for the file
that carries it. A lint rule would be the fix; that is a gate addition and
belongs to whoever owns the next hygiene pass, not to this bounded repair.

### 27c. R-6 (RULED, FAD-42(3)) — empty scope satisfies vacuously; unknown blocks

The behaviour already matched the ruling on both sides — `model.py` raises
`rule_identifier_unresolved` for an unknown id and its `scoped()` predicate
admits nobody for a known-but-empty group; `hard-rule-check.ts` refuses the
unknown id in `scopeUnresolvable` and filters to an empty set otherwise. **What
was missing were the pins**, and a behaviour nothing pins is a behaviour that can
drift without anyone noticing.

[`empty-staff-group-scope.test.ts`](../../../apps/api/test/solver/empty-staff-group-scope.test.ts)
pins all four cells:

| | Model | Checker |
|---|---|---|
| **known-empty** | `OPTIMAL`, both dates staffed — the rule bound nobody | 0 breaches, 0 not-evaluable, usable |
| **unknown id** | `FAILED`, no candidate | not-evaluable, names the id and RK-RULING-02 |

The fixture cannot pass by accident: the HARD rule is `AvoidDate` on the FIRST of
two demanded dates, so if it applied to the single participant the problem would
be infeasible. "A full two-row schedule came back" is therefore only possible if
the rule really did bind nobody — a silent skip and a vacuous pass are
distinguishable here, which on most fixtures they are not.

### 27d. R-7 — the static parity gate

[`scripts/gates/solver-kind-parity-check.mjs`](../../../scripts/gates/solver-kind-parity-check.mjs),
an ADDITION; no existing gate modified. It parses `HARD_KINDS` out of `model.py`
and `EVALUATED_HARD_RULE_KINDS` out of `hard-rule-check.ts` as **text** — no
interpreter, no venv, no build — which is the only way §6d's "compile-time/CI
error, not a runtime surprise" clause holds on a machine that cannot run the
solver.

Comments are blanked before matching, so the TypeScript list's `// RK-RULING-09`
annotations cannot be read as declarations. A missing or empty block is itself a
violation, so the gate cannot pass vacuously by finding two empty sets.

Both directions are reported, and the asymmetry is the point: a kind in Python
but not TypeScript means the checker's silence stops meaning agreement; a kind in
TypeScript but not Python is **the kind-level form of R-1 itself**.

- wired into `pnpm check` as `solver-kind-parity`, beside the other rule-model
  closure gates and before the slow browser gates;
- red case `solver-kind-parity` added to `scripts/red-cases/run.mjs`, removing
  `MinimumRestBetween` from the Python tuple — the very kind R-1 was about —
  anchored on its two neighbours so a reordering breaks the anchor loudly instead
  of silently patching a different kind.

Green: `PASS … 22 HARD kind(s) … 22 in …`. Red: `FAIL … 1 violation(s)` naming
`MinimumRestBetween` and the R-1 shape.

### 27e. R-9 — the dead branch

`stub_solver.py`'s `if behaviour == BEHAVIOUR_CANDIDATE: pass` removed.
`BEHAVIOUR_CANDIDATE` is the fall-through and the greedy candidate at the end of
the function IS its implementation. The note the empty branch carried (this
module is unreachable through `__main__` since M4-002 and is kept runnable in
isolation for the older boundary proofs) is retained as a comment — a reader
should not have to work out whether a `pass` is a deliberate no-op or an
unfinished thought.

### 27f. R-11 — the venv path

Scrubbed from **prose** to `<SP_SOLVER_VENV>`: two occurrences in this INDEX, now
zero. The path never appeared in code.

**The `.txt` transcripts keep it, deliberately.** They are verbatim machine
capture, and a transcript that has been edited after the fact is no longer a
transcript — which is a worse property to lose than a local directory name is to
disclose. The `$HOME/…`-relative forms in the setup instructions are left as they
are: they are portable and name nobody.

### 27g. R-8 and R-10 — recorded, not actioned (FAD-42(5))

- **R-8** — the pin-handling behaviour the review flagged is RK-RULING-04
  consistent. Recorded here for M4-003, which owns pin handling.
- **R-10** — the raw `DELETE` in `periodic.test.ts`'s no-signer test is
  pre-existing and outside every grant this packet holds. It is now a redundant
  fast path with the FAD-41 `afterAll` behind it. It joins the §25b
  `reclaimStalePools` gap — *a pool that releases cleanly while still holding a
  locked job leaves an orphan no production sweep will ever reclaim* — as a
  future hygiene item.

## 28. Repair-round acceptance

Serial, `uptime` checked before each, `EXIT=` markers inside every redirected
block.

| # | What | Transcript | Result |
|---|---|---|---|
| 32 | the new/changed proofs, GREEN | [`step-32`](step-32-repair-proofs-green.txt) | **5 files / 23 tests passed** · `REPAIR-PROOFS-GREEN EXIT=0` — the R-1 pin, the four R-6 pins, the corpus (16), and `model-independence` |
| 33 | the same proofs, RED | [`step-33`](step-33-repair-proofs-red.txt) | R-1 defect restored → the 41 arm FAILS, the 30 control still passes, `R1-RED EXIT=1` · parity violation applied → `FAIL … 1 violation(s)`, `R7-RED EXIT=1` · both reverted, `R7-GREEN-AFTER-RESTORE EXIT=0` |
| 34 | R-2 hash neutrality | [`step-34`](step-34-nul-hash-neutrality.txt) | **0 raw NULs remain** · E1 corpus **14 of 15 hashes UNCHANGED**, the 1 that moved is `B-ruleheavy` by design · M3 corpus 6 of 6 unchanged · `HASH-COMPARISON EXIT=0` |
| 35 | `corepack pnpm check` | [`step-35`](step-35-check-repair.txt) | **16 gate(s): 16 passed, 0 failed** · `CHECK EXIT=0`. The gate count moved 15 → 16: `solver-kind-parity PASS 196ms` |
| 36 | `corepack pnpm red-cases` | [`step-36`](step-36-red-cases-repair.txt) | **48 case(s): 48 proven, 0 not proven** · `RED-CASES EXIT=0`. Count moved 47 → 48; `solver-kind-parity` at position 12 reads `GREEN (clean tree): gate passed` / `RED (violation in tree): gate failed as required`. Run after `check` so `dist/` existed for the network-guard arm |
| 37 | `corepack pnpm fixture-regression` | [`step-37`](step-37-fixture-regression-repair.txt) | **137 run(s): 137 passed, 0 failed** · `FIXTURE-REGRESSION EXIT=0`. 13 fixed seeds (123456 among them, 108.3 s), **fresh rotating seed 955799**, and the 121-file standalone sweep. Test count moved 1255 → 1261: the six new pins |

### 28a. What was NOT re-run, and why that is safe to say

`sbx` and `migrate:cycle:embedded` are **not** re-run; their step 23/24 results
stand.

This round's diff is: one Python constraint loop, one Python dead branch, three
files' NUL spelling, two new test files, two test-support generator functions,
one corpus rule predicate, one gate script, one gate registration, one red-case
arm, and evidence prose. **It contains no migration, no table, no column and no
RLS policy**, so the migration cycle cannot see it; and it adds no tenant table,
so `sbx`'s 47-of-47 readings floor cannot move. The `unit` gate inside step 35
executed every changed test file, and step 34 re-derived every corpus hash.

### 28b. The one thing that went wrong in this round, kept in the record

The first `check` of the repair FAILED its unit gate — recorded in §27a rather
than quietly corrected. Scoping `rh-rest` to `['DAY']` alone silently removed the
same-date DAY/CAL pair from the rule and broke `incorrect-worker-output` case 5.

It is worth its own note because it is **the same class of defect as R-1**: a rule
that quietly stops covering a pair, with nothing failing at the point of the
change. The targeted corpus run went green; only the full battery caught it. That
is the argument for running the whole thing rather than the part that seems
relevant — made once more, at my own expense.
